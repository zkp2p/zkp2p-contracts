import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  EscrowV2,
  OrchestratorRegistry,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  StaticOracleAdapterMock,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("EscrowV2", () => {
  let owner: any;
  let depositor: any;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let staticOracleAdapter: StaticOracleAdapterMock;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;

  beforeEach(async () => {
    [owner, depositor] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    verifier = await deployer.deployPaymentVerifierMock();
    staticOracleAdapter = (await (
      await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
    ).deploy()) as StaticOracleAdapterMock;

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

    await paymentVerifierRegistry
      .connect(owner.wallet)
      .addPaymentMethod(paymentMethod, verifier.address, [Currency.USD]);

    escrow = await deployer.deployEscrowV2(
      owner.address,
      ONE,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      ZERO,
      BigNumber.from(20),
      BigNumber.from(60 * 60)
    );

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(100_000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(500),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails,
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  });

  async function setOracleRate(rate: BigNumber, spreadBps: number, maxStaleness: number, updatedAt: number) {
    const adapterConfig = ethers.utils.defaultAbiCoder.encode(
      ["bool", "uint256", "uint256"],
      [true, rate, updatedAt]
    );

    await escrow.connect(depositor.wallet).setOracleRateConfig(
      ZERO,
      paymentMethod,
      Currency.USD,
      {
        adapter: staticOracleAdapter.address,
        adapterConfig,
        spreadBps,
        maxStaleness,
      }
    );
  }

  describe("#getDepositCurrencyMinRate", () => {
    it("returns fixed rate when only fixed source is configured", async () => {
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("returns spread rate when fixed floor is zero and oracle source is configured", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      await setOracleRate(ether(1.2), 100, 3600, currentTimestamp);
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ZERO);

      const expectedSpread = ether(1.2).mul(10_100).add(9_999).div(10_000);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(expectedSpread);
    });

    it("returns max(fixed, spread) when both sources are configured", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      await setOracleRate(ether(1.1), 0, 3600, currentTimestamp);
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ether(1.2));

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.2));
    });

    it("returns a below-market oracle floor for negative spreads", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      await setOracleRate(ether(1.1), -300, 3600, currentTimestamp);
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ZERO);

      const expectedSpread = ether(1.1).mul(9_700).add(9_999).div(10_000);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(expectedSpread);
    });

    it("returns zero when oracle configured but stale (halt behavior)", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      await setOracleRate(ether(1.3), 0, 5, currentTimestamp - 100);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("returns fixed floor when no oracle configured and fixed floor is nonzero", async () => {
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ether(1.15));

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.15));
    });

    it("returns zero when currency is deactivated", async () => {
      await escrow.connect(depositor.wallet).deactivateCurrency(ZERO, paymentMethod, Currency.USD);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });
  });

  describe("#deactivateCurrency", () => {
    it("clears fixed and oracle config", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      await setOracleRate(ether(1.2), 0, 3600, currentTimestamp);

      await expect(escrow.connect(depositor.wallet).deactivateCurrency(ZERO, paymentMethod, Currency.USD))
        .to.emit(escrow, "DepositMinConversionRateUpdated")
        .withArgs(ZERO, paymentMethod, Currency.USD, ZERO)
        .and.to.emit(escrow, "DepositOracleRateConfigRemoved")
        .withArgs(ZERO, paymentMethod, Currency.USD);

      const oracleConfig = await escrow.getDepositOracleRateConfig(ZERO, paymentMethod, Currency.USD);
      expect(oracleConfig.adapter).to.eq(ADDRESS_ZERO);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("allows explicit re-enable by setting fixed floor", async () => {
      await escrow.connect(depositor.wallet).deactivateCurrency(ZERO, paymentMethod, Currency.USD);
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ether(1.15));

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.15));
    });

    it("allows explicit re-enable by setting oracle config", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      await escrow.connect(depositor.wallet).deactivateCurrency(ZERO, paymentMethod, Currency.USD);
      await setOracleRate(ether(1.3), 100, 3600, currentTimestamp);

      const expectedSpread = ether(1.3).mul(10_100).add(9_999).div(10_000);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(expectedSpread);
    });
  });

  describe("currency lifecycle edge cases", () => {
    it("keeps currency active when fixed floor is set to zero but oracle config remains", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      await setOracleRate(ether(1.1), 100, 3600, currentTimestamp);

      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ZERO);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(
        ether(1.1).mul(10_100).add(9_999).div(10_000)
      );
    });

    it("keeps currency active when oracle config is removed but fixed floor remains", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      await setOracleRate(ether(1.3), 0, 3600, currentTimestamp);
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ether(1.25));

      await escrow.connect(depositor.wallet).removeOracleRateConfig(ZERO, paymentMethod, Currency.USD);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.25));
    });
  });
});
