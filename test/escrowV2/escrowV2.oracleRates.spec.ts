import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  EscrowV2,
  OrchestratorRegistry,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RevertingOracleAdapterMock,
  StaticOracleAdapterMock,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("EscrowV2", () => {
  let owner: any;
  let depositor: any;
  let delegate: any;
  let other: any;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let staticOracleAdapter: StaticOracleAdapterMock;
  let revertingOracleAdapter: RevertingOracleAdapterMock;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;

  beforeEach(async () => {
    [owner, depositor, delegate, other] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    verifier = await deployer.deployPaymentVerifierMock();
    staticOracleAdapter = (await (
      await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
    ).deploy()) as StaticOracleAdapterMock;
    revertingOracleAdapter = (await (
      await ethers.getContractFactory("RevertingOracleAdapterMock", owner.wallet)
    ).deploy()) as RevertingOracleAdapterMock;

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

    await paymentVerifierRegistry
      .connect(owner.wallet)
      .addPaymentMethod(paymentMethod, verifier.address, [Currency.USD, Currency.EUR]);

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
      currencies: [
        [
          { code: Currency.USD, minConversionRate: ether(1) },
          { code: Currency.EUR, minConversionRate: ether(1) },
        ],
      ],
      delegate: delegate.address,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  });

  describe("#setOracleRateConfig", () => {
    let subjectCaller: any;
    let subjectCurrencyCode: BytesLike;
    let subjectSpreadBps: number;
    let subjectMaxStaleness: number;
    let subjectRate: BigNumber;
    let subjectUpdatedAt: BigNumber;

    async function subject() {
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, subjectRate, subjectUpdatedAt]
      );

      return escrow.connect(subjectCaller.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        subjectCurrencyCode,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig,
          spreadBps: subjectSpreadBps,
          maxStaleness: subjectMaxStaleness,
        }
      );
    }

    beforeEach(async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      subjectCaller = depositor;
      subjectCurrencyCode = Currency.USD;
      subjectSpreadBps = 50;
      subjectMaxStaleness = 3600;
      subjectRate = ether(1);
      subjectUpdatedAt = BigNumber.from(currentTimestamp);
    });

    it("sets oracle config and computes spread floor", async () => {
      await expect(subject()).to.emit(escrow, "DepositOracleRateConfigSet");

      const expectedSpread = ether(1).mul(10_000 + subjectSpreadBps).add(9_999).div(10_000);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(expectedSpread);
    });

    it("returns max(fixed, spread)", async () => {
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ether(1.02));
      await subject();

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.02));
    });

    it("falls back to fixed floor when oracle is stale", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      subjectUpdatedAt = BigNumber.from(currentTimestamp - 10_000);
      subjectMaxStaleness = 10;

      await subject();

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("falls back to fixed floor when oracle quote is invalid", async () => {
      subjectRate = ZERO;
      await subject();

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("falls back to fixed floor when oracle timestamp is in the future", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      subjectUpdatedAt = BigNumber.from(currentTimestamp + 300);
      await subject();

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("falls back to fixed floor when oracle adapter reverts", async () => {
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), subjectUpdatedAt]
      );

      await escrow.connect(subjectCaller.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        subjectCurrencyCode,
        {
          adapter: revertingOracleAdapter.address,
          adapterConfig,
          spreadBps: subjectSpreadBps,
          maxStaleness: subjectMaxStaleness,
        }
      );

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("allows delegate to set config", async () => {
      subjectCaller = delegate;

      await expect(subject()).to.emit(escrow, "DepositOracleRateConfigSet");
    });

    describe("when caller is not depositor or delegate", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });
  });

  describe("#removeOracleRateConfig", () => {
    let subjectCaller: any;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).removeOracleRateConfig(ZERO, paymentMethod, Currency.USD);
    }

    beforeEach(async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      subjectCaller = depositor;

      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.2), BigNumber.from(currentTimestamp)]
      );

      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig,
          spreadBps: 0,
          maxStaleness: 3600,
        }
      );
    });

    it("removes config and falls back to fixed rate", async () => {
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.2));

      await expect(subject())
        .to.emit(escrow, "DepositOracleRateConfigRemoved")
        .withArgs(ZERO, paymentMethod, Currency.USD);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("reverts when tuple is not listed", async () => {
      const unsupported = ethers.utils.formatBytes32String("JPY");
      await expect(
        escrow.connect(subjectCaller.wallet).removeOracleRateConfig(ZERO, paymentMethod, unsupported)
      ).to.be.revertedWithCustomError(escrow, "CurrencyNotSupported");
    });
  });

  describe("#setOracleRateConfigBatch", () => {
    let subjectCaller: any;

    async function subject() {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );
      const eurAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.2), currentTimestamp]
      );

      return escrow.connect(subjectCaller.wallet).setOracleRateConfigBatch(
        ZERO,
        [paymentMethod],
        [[Currency.USD, Currency.EUR]],
        [[
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: usdAdapterConfig,
            spreadBps: 100,
            maxStaleness: 3600,
          },
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: eurAdapterConfig,
            spreadBps: 50,
            maxStaleness: 3600,
          },
        ]]
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
    });

    it("sets multiple configs in one call", async () => {
      await subject();

      const usdExpected = ether(1).mul(10_100).add(9_999).div(10_000);
      const eurExpected = ether(1.2).mul(10_050).add(9_999).div(10_000);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(usdExpected);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.EUR)).to.eq(eurExpected);
    });

    it("reverts when paymentMethods and currencyCodes length mismatch", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );

      await expect(
        escrow.connect(subjectCaller.wallet).setOracleRateConfigBatch(
          ZERO,
          [paymentMethod],
          [],
          [[{
            adapter: staticOracleAdapter.address,
            adapterConfig: usdAdapterConfig,
            spreadBps: 100,
            maxStaleness: 3600,
          }]]
        )
      ).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
    });

    it("reverts when paymentMethods and configs length mismatch", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );

      await expect(
        escrow.connect(subjectCaller.wallet).setOracleRateConfigBatch(
          ZERO,
          [paymentMethod],
          [[Currency.USD]],
          []
        )
      ).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
    });

    it("reverts when nested currencyCodes and configs length mismatch", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );

      await expect(
        escrow.connect(subjectCaller.wallet).setOracleRateConfigBatch(
          ZERO,
          [paymentMethod],
          [[Currency.USD, Currency.EUR]],
          [[{
            adapter: staticOracleAdapter.address,
            adapterConfig: usdAdapterConfig,
            spreadBps: 100,
            maxStaleness: 3600,
          }]]
        )
      ).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
    });
  });

  describe("#setOracleRateConfig unsupported tuple", () => {
    it("reverts when currency is not listed for the payment method", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const unsupported = ethers.utils.formatBytes32String("JPY");
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );

      await expect(
        escrow.connect(depositor.wallet).setOracleRateConfig(
          ZERO,
          paymentMethod,
          unsupported,
          {
            adapter: staticOracleAdapter.address,
            adapterConfig,
            spreadBps: 50,
            maxStaleness: 3600,
          }
        )
      ).to.be.revertedWithCustomError(escrow, "CurrencyNotSupported");
    });
  });
});
