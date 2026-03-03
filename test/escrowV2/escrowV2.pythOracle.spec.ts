import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import { Blockchain } from "@utils/common";
import {
  EscrowV2,
  OrchestratorRegistry,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  PythMock,
  PythOracleAdapter,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("EscrowV2 - PythOracleAdapter Integration", () => {
  let owner: any;
  let depositor: any;
  let delegate: any;

  let deployer: DeployHelper;
  let blockchain: Blockchain;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let pythMock: PythMock;
  let pythAdapter: PythOracleAdapter;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;

  const FEED_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD/INR"));

  function encodePythRawConfig(feedId: string, invert: boolean): string {
    return ethers.utils.defaultAbiCoder.encode(["bytes32", "bool"], [feedId, invert]);
  }

  beforeEach(async () => {
    [owner, depositor, delegate] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    blockchain = new Blockchain(ethers.provider);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    verifier = await deployer.deployPaymentVerifierMock();

    pythMock = (await (
      await ethers.getContractFactory("PythMock", owner.wallet)
    ).deploy()) as PythMock;

    pythAdapter = (await (
      await ethers.getContractFactory("PythOracleAdapter", owner.wallet)
    ).deploy(pythMock.address)) as PythOracleAdapter;

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

    // Set Pyth price: USD/INR = 83.475 (expo=-5)
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await pythMock.setPrice(FEED_ID, 8347500, 100, -5, now);

    // Create a deposit with USDC
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
          { code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG },
        ],
      ],
      delegate: delegate.address,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  });

  describe("Pyth oracle integration with setOracleRateConfig", () => {
    it("sets Pyth oracle config and returns correct spread rate", async () => {
      const normalizedConfig = await pythAdapter.validateConfig(encodePythRawConfig(FEED_ID, false));

      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: pythAdapter.address,
          adapterConfig: encodePythRawConfig(FEED_ID, false),
          spreadBps: 50,
          maxStaleness: 3600,
        }
      );

      // Oracle rate = 83.475e18, spread = 50bps
      // expectedSpread = 83.475e18 * 10050 / 10000 (rounded up)
      const oracleRate = BigNumber.from(8347500).mul(BigNumber.from(10).pow(18)).div(BigNumber.from(10).pow(5));
      const expectedSpread = oracleRate.mul(10_050).add(9_999).div(10_000);

      const effectiveRate = await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD);
      expect(effectiveRate).to.eq(expectedSpread);
    });

    it("returns max(fixedRate, pythSpreadRate)", async () => {
      // Set a high fixed rate
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ether(100));

      // Set Pyth oracle with lower effective rate (~83.475 * 1.005 = ~83.89)
      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: pythAdapter.address,
          adapterConfig: encodePythRawConfig(FEED_ID, false),
          spreadBps: 50,
          maxStaleness: 3600,
        }
      );

      // Fixed rate (100) > oracle spread rate (~83.89), so fixed wins
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(100));
    });

    it("falls back to fixed rate when Pyth price is stale", async () => {
      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: pythAdapter.address,
          adapterConfig: encodePythRawConfig(FEED_ID, false),
          spreadBps: 50,
          maxStaleness: 3600,
        }
      );

      // Advance time past maxStaleness (3600s)
      await blockchain.increaseTimeAsync(7200);

      // Stale price → oracle returns 0 → falls back to fixed rate
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("updates effective rate when mock price changes", async () => {
      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: pythAdapter.address,
          adapterConfig: encodePythRawConfig(FEED_ID, false),
          spreadBps: 0,
          maxStaleness: 3600,
        }
      );

      // Original rate
      const originalRate = BigNumber.from(8347500).mul(BigNumber.from(10).pow(18)).div(BigNumber.from(10).pow(5));
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(originalRate);

      // Update mock price: USD/INR = 84.000 with a fresh publishTime
      const currentTimestamp = (await blockchain.getCurrentTimestamp()).toNumber();
      await pythMock.setPrice(FEED_ID, 8400000, 100, -5, currentTimestamp);

      const newRate = BigNumber.from(8400000).mul(BigNumber.from(10).pow(18)).div(BigNumber.from(10).pow(5));
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(newRate);
    });
  });

  describe("Pyth oracle with createDeposit inline config", () => {
    it("sets oracle config during createDeposit", async () => {
      const tx = await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(200),
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
            {
              code: Currency.USD,
              minConversionRate: ether(1),
              oracleRateConfig: {
                adapter: pythAdapter.address,
                adapterConfig: encodePythRawConfig(FEED_ID, false),
                spreadBps: 100,
                maxStaleness: 3600,
              },
            },
          ],
        ],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });

      await expect(tx).to.emit(escrow, "DepositOracleRateConfigSet");

      const depositId = ONE;
      const config = await escrow.getDepositOracleRateConfig(depositId, paymentMethod, Currency.USD);
      expect(config.adapter).to.eq(pythAdapter.address);
      expect(config.spreadBps).to.eq(100);
      expect(config.maxStaleness).to.eq(3600);
    });
  });
});
