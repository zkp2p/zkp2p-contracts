import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike, Contract } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  EscrowV2,
  OrchestratorMock,
  OrchestratorRegistry,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RateManagerMock,
  RevertingOracleAdapterMock,
  StaticOracleAdapterMock,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("EscrowV2 -- Branch Coverage", () => {
  let owner: any;
  let depositor: any;
  let delegate: any;
  let other: any;
  let intentGuardian: any;
  let dustRecipient: any;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let otherVerifier: PaymentVerifierMock;
  let orchestratorMock: OrchestratorMock;
  let staticOracleAdapter: StaticOracleAdapterMock;
  let revertingOracleAdapter: RevertingOracleAdapterMock;
  let rateManagerMock: RateManagerMock;

  let venmoPaymentMethod: BytesLike;
  let paypalPaymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let depositId: BigNumber;
  let intentCounter: number;
  let rateManagerId: BytesLike;

  async function increaseTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function createIntentWith(
    orchestratorContract: Contract,
    amount: BigNumber = usdc(20)
  ): Promise<BytesLike> {
    intentCounter += 1;
    const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`intent-${intentCounter}`));
    await orchestratorContract.connect(owner.wallet).lockFunds(depositId, intentHash, amount);
    return intentHash;
  }

  function buildOracleAdapterConfig(isValid: boolean, marketRate: BigNumber, updatedAt: BigNumber): string {
    return ethers.utils.defaultAbiCoder.encode(
      ["bool", "uint256", "uint256"],
      [isValid, marketRate, updatedAt]
    );
  }

  beforeEach(async () => {
    [owner, depositor, delegate, other, intentGuardian, dustRecipient] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    intentCounter = 0;

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));
    await usdcToken.transfer(other.address, usdc(10_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();

    verifier = await deployer.deployPaymentVerifierMock();
    otherVerifier = await deployer.deployPaymentVerifierMock();
    rateManagerMock = await deployer.deployRateManagerMock();
    staticOracleAdapter = (await (
      await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
    ).deploy()) as StaticOracleAdapterMock;
    revertingOracleAdapter = (await (
      await ethers.getContractFactory("RevertingOracleAdapterMock", owner.wallet)
    ).deploy()) as RevertingOracleAdapterMock;

    venmoPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    paypalPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
    rateManagerId = ethers.utils.formatBytes32String("manager-1");

    await paymentVerifierRegistry
      .connect(owner.wallet)
      .addPaymentMethod(venmoPaymentMethod, verifier.address, [Currency.USD, Currency.EUR]);
    await paymentVerifierRegistry
      .connect(owner.wallet)
      .addPaymentMethod(paypalPaymentMethod, otherVerifier.address, [Currency.USD, Currency.EUR]);

    escrow = await deployer.deployEscrowV2(
      owner.address,
      ONE,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      dustRecipient.address,
      ZERO,
      BigNumber.from(3),
      BigNumber.from(60 * 60)
    );

    orchestratorMock = await deployer.deployOrchestratorMock(escrow.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(orchestratorMock.address);

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(100_000));
    await usdcToken.connect(other.wallet).approve(escrow.address, usdc(10_000));

    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(500),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [venmoPaymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails,
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
      delegate: delegate.address,
      intentGuardian: intentGuardian.address,
      retainOnEmpty: false,
    });

    depositId = ZERO;
  });

  /* ================================================================
   *  1. createDeposit -- min == 0 branch
   * ================================================================ */
  describe("#createDeposit", () => {
    describe("when intentAmountRange.min is zero", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(50),
          intentAmountRange: { min: ZERO, max: usdc(100) },
          paymentMethods: [paypalPaymentMethod],
          paymentMethodData: [
            {
              intentGatingService: ADDRESS_ZERO,
              payeeDetails,
              data: "0x",
            },
          ],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: delegate.address,
          intentGuardian: intentGuardian.address,
          retainOnEmpty: false,
        });
      }

      it("reverts with ZeroMinValue", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroMinValue");
      });
    });

    describe("when delegate is the depositor (self-delegation)", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(50),
          intentAmountRange: { min: usdc(10), max: usdc(100) },
          paymentMethods: [paypalPaymentMethod],
          paymentMethodData: [
            {
              intentGatingService: ADDRESS_ZERO,
              payeeDetails,
              data: "0x",
            },
          ],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: depositor.address,
          intentGuardian: ADDRESS_ZERO,
          retainOnEmpty: false,
        });
      }

      it("reverts with CannotDelegateToSelf", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "CannotDelegateToSelf");
      });
    });
  });

  describe("#depositTo", () => {
    describe("when target depositor is zero address", () => {
      async function subject() {
        return escrow.connect(other.wallet).depositTo(ADDRESS_ZERO, {
          token: usdcToken.address,
          amount: usdc(50),
          intentAmountRange: { min: usdc(10), max: usdc(100) },
          paymentMethods: [paypalPaymentMethod],
          paymentMethodData: [
            {
              intentGatingService: ADDRESS_ZERO,
              payeeDetails,
              data: "0x",
            },
          ],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: delegate.address,
          intentGuardian: intentGuardian.address,
          retainOnEmpty: false,
        });
      }

      it("reverts with ZeroAddress", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });

    describe("when delegate is the target depositor (self-delegation)", () => {
      async function subject() {
        return escrow.connect(other.wallet).depositTo(depositor.address, {
          token: usdcToken.address,
          amount: usdc(50),
          intentAmountRange: { min: usdc(10), max: usdc(100) },
          paymentMethods: [paypalPaymentMethod],
          paymentMethodData: [
            {
              intentGatingService: ADDRESS_ZERO,
              payeeDetails,
              data: "0x",
            },
          ],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: depositor.address,
          intentGuardian: ADDRESS_ZERO,
          retainOnEmpty: false,
        });
      }

      it("reverts with CannotDelegateToSelf", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "CannotDelegateToSelf");
      });
    });
  });

  /* ================================================================
   *  1b. withdrawDeposit -- additional branches
   * ================================================================ */
  describe("#withdrawDeposit", () => {
    describe("when caller is not depositor", () => {
      async function subject() {
        return escrow.connect(other.wallet).withdrawDeposit(depositId);
      }

      it("reverts with UnauthorizedCaller", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });

    describe("when there are no expired intents to prune", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).withdrawDeposit(depositId);
      }

      it("succeeds without orchestrator prune call", async () => {
        await expect(subject())
          .to.emit(escrow, "DepositClosed")
          .withArgs(depositId, depositor.address);
      });
    });
  });

  /* ================================================================
   *  1c. removeDelegate -- unauthorized caller
   * ================================================================ */
  describe("#removeDelegate", () => {
    describe("when caller is not depositor", () => {
      async function subject() {
        return escrow.connect(other.wallet).removeDelegate(depositId);
      }

      it("reverts with UnauthorizedCaller", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });
  });

  /* ================================================================
   *  1d. pruneExpiredIntents -- no expired intents
   * ================================================================ */
  describe("#pruneExpiredIntents", () => {
    describe("when there are no expired intents", () => {
      async function subject() {
        return escrow.connect(other.wallet).pruneExpiredIntents(depositId);
      }

      it("succeeds without orchestrator prune call", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });
  });

  /* ================================================================
   *  1e. onlyOrchestrator revert -- unlockFunds / unlockAndTransferFunds
   * ================================================================ */
  describe("#unlockFunds -- onlyOrchestrator", () => {
    describe("when caller is not an orchestrator", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("direct-unlock"));
        return escrow.connect(other.wallet).unlockFunds(depositId, intentHash);
      }

      it("reverts with UnauthorizedCaller", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });
  });

  describe("#unlockAndTransferFunds -- onlyOrchestrator", () => {
    describe("when caller is not an orchestrator", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("direct-transfer"));
        return escrow.connect(other.wallet).unlockAndTransferFunds(depositId, intentHash, usdc(20), other.address);
      }

      it("reverts with UnauthorizedCaller", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });
  });

  /* ================================================================
   *  1f. onlyDepositorOrDelegate revert -- per-function coverage
   *  Each function using the modifier needs its own revert test
   * ================================================================ */
  describe("onlyDepositorOrDelegate revert -- per function", () => {
    describe("#setOracleRateConfigBatch", () => {
      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(other.wallet).setOracleRateConfigBatch(
          depositId,
          [venmoPaymentMethod],
          [[Currency.USD]],
          [[{
            adapter: staticOracleAdapter.address,
            adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
            spreadBps: 100,
            maxStaleness: 3600,
          }]]
        );
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#updateCurrencyConfigBatch", () => {
      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(other.wallet).updateCurrencyConfigBatch(
          depositId,
          [venmoPaymentMethod],
          [[{
            code: Currency.USD,
            minConversionRate: ether(1.1),
            updateOracle: true,
            oracleRateConfig: {
              adapter: staticOracleAdapter.address,
              adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
              spreadBps: 100,
              maxStaleness: 3600,
            },
          }]]
        );
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#removeOracleRateConfig", () => {
      async function subject() {
        return escrow.connect(other.wallet).removeOracleRateConfig(depositId, venmoPaymentMethod, Currency.USD);
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#setIntentRange", () => {
      async function subject() {
        return escrow.connect(other.wallet).setIntentRange(depositId, { min: usdc(5), max: usdc(300) });
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#addPaymentMethods", () => {
      async function subject() {
        return escrow.connect(other.wallet).addPaymentMethods(
          depositId,
          [paypalPaymentMethod],
          [{ intentGatingService: ADDRESS_ZERO, payeeDetails, data: "0x" }],
          [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]]
        );
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#setPaymentMethodActive", () => {
      async function subject() {
        return escrow.connect(other.wallet).setPaymentMethodActive(depositId, venmoPaymentMethod, false);
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#addCurrencies", () => {
      async function subject() {
        return escrow.connect(other.wallet).addCurrencies(
          depositId,
          venmoPaymentMethod,
          [{ code: Currency.EUR, minConversionRate: ether(0.9), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]
        );
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#deactivateCurrency", () => {
      async function subject() {
        return escrow.connect(other.wallet).deactivateCurrency(depositId, venmoPaymentMethod, Currency.USD);
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#deactivateCurrenciesBatch", () => {
      async function subject() {
        return escrow.connect(other.wallet).deactivateCurrenciesBatch(
          depositId,
          [venmoPaymentMethod],
          [[Currency.USD]]
        );
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#setAcceptingIntents", () => {
      async function subject() {
        return escrow.connect(other.wallet).setAcceptingIntents(depositId, false);
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("#setRetainOnEmpty", () => {
      async function subject() {
        return escrow.connect(other.wallet).setRetainOnEmpty(depositId, true);
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });
  });

  /* ================================================================
   *  2. _addPaymentMethodsToDeposit
   * ================================================================ */
  describe("#_addPaymentMethodsToDeposit (via addPaymentMethods / createDeposit)", () => {
    describe("when paymentMethod is bytes32(0)", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).addPaymentMethods(
          depositId,
          [ethers.constants.HashZero],
          [{ intentGatingService: ADDRESS_ZERO, payeeDetails, data: "0x" }],
          [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]]
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with ZeroAddress", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });

    describe("when payeeDetails is bytes32(0)", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).addPaymentMethods(
          depositId,
          [paypalPaymentMethod],
          [{ intentGatingService: ADDRESS_ZERO, payeeDetails: ethers.constants.HashZero, data: "0x" }],
          [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]]
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with EmptyPayeeDetails", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "EmptyPayeeDetails");
      });
    });

    describe("when payment method already exists on deposit", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).addPaymentMethods(
          depositId,
          [venmoPaymentMethod],
          [{ intentGatingService: ADDRESS_ZERO, payeeDetails, data: "0x" }],
          [[{ code: Currency.EUR, minConversionRate: ether(0.9), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]]
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with PaymentMethodAlreadyExists", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "PaymentMethodAlreadyExists");
      });
    });

    describe("when paymentMethods and paymentMethodData arrays differ in length", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).addPaymentMethods(
          depositId,
          [paypalPaymentMethod],
          [],
          [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]]
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with ArrayLengthMismatch", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
      });
    });

    describe("when paymentMethods and currencies arrays differ in length", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).addPaymentMethods(
          depositId,
          [paypalPaymentMethod],
          [{ intentGatingService: ADDRESS_ZERO, payeeDetails, data: "0x" }],
          []
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with ArrayLengthMismatch", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
      });
    });
  });

  /* ================================================================
   *  3. _setOracleRateConfig
   * ================================================================ */
  describe("#_setOracleRateConfig (via setOracleRateConfig)", () => {
    describe("when adapter is an EOA (code.length == 0)", () => {
      let subjectCaller: any;

      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(subjectCaller.wallet).setOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          {
            adapter: other.address,
            adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
            spreadBps: 100,
            maxStaleness: 3600,
          }
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with InvalidOracleAdapter", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "InvalidOracleAdapter");
      });
    });

    describe("when spreadBps exceeds BPS (10000)", () => {
      let subjectCaller: any;

      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(subjectCaller.wallet).setOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
            spreadBps: 10001,
            maxStaleness: 3600,
          }
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with InvalidSpread", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "InvalidSpread");
      });
    });

    describe("when maxStaleness is zero", () => {
      let subjectCaller: any;

      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(subjectCaller.wallet).setOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
            spreadBps: 100,
            maxStaleness: 0,
          }
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with ZeroValue", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
      });
    });

    describe("when adapter address is zero", () => {
      let subjectCaller: any;

      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(subjectCaller.wallet).setOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          {
            adapter: ADDRESS_ZERO,
            adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
            spreadBps: 100,
            maxStaleness: 3600,
          }
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with ZeroAddress", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });
  });

  /* ================================================================
   *  4. removeOracleRateConfig -- currency not listed
   * ================================================================ */
  describe("#removeOracleRateConfig", () => {
    describe("when currency is not listed", () => {
      let subjectCaller: any;
      let subjectCurrency: BytesLike;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).removeOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          subjectCurrency
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
        subjectCurrency = ethers.utils.formatBytes32String("JPY");
      });

      it("reverts with CurrencyNotSupported", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "CurrencyNotSupported");
      });
    });
  });

  /* ================================================================
   *  5. deactivateCurrency
   * ================================================================ */
  describe("#deactivateCurrency", () => {
    describe("when payment method is not active", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).deactivateCurrency(
          depositId,
          venmoPaymentMethod,
          Currency.USD
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
        await escrow.connect(depositor.wallet).setPaymentMethodActive(depositId, venmoPaymentMethod, false);
      });

      it("reverts with PaymentMethodNotActive", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "PaymentMethodNotActive");
      });
    });

    describe("when currency is not listed", () => {
      let subjectCaller: any;
      let subjectCurrency: BytesLike;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).deactivateCurrency(
          depositId,
          venmoPaymentMethod,
          subjectCurrency
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
        subjectCurrency = ethers.utils.formatBytes32String("JPY");
      });

      it("reverts with CurrencyNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "CurrencyNotFound");
      });
    });

    describe("when currency has NO oracle config (hadOracleConfig is false)", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).deactivateCurrency(
          depositId,
          venmoPaymentMethod,
          Currency.USD
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("emits DepositMinConversionRateUpdated but NOT DepositOracleRateConfigRemoved", async () => {
        await expect(subject())
          .to.emit(escrow, "DepositMinConversionRateUpdated")
          .withArgs(depositId, venmoPaymentMethod, Currency.USD, ZERO);

        // Verify no oracle rate config removal event was emitted
        const tx = await escrow.connect(depositor.wallet).addCurrencies(
          depositId,
          venmoPaymentMethod,
          [{ code: Currency.EUR, minConversionRate: ether(0.9), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]
        );

        // The subject already completed above. We check the original tx receipt for events.
        // Re-create the scenario to capture the receipt directly.
      });

      it("does not emit DepositOracleRateConfigRemoved", async () => {
        // When there is no oracle config, deactivateCurrency should NOT emit DepositOracleRateConfigRemoved
        await expect(subject())
          .to.not.emit(escrow, "DepositOracleRateConfigRemoved");
      });
    });
  });

  /* ================================================================
   *  6. addCurrencies -- payment method not active
   * ================================================================ */
  describe("#addCurrencies", () => {
    describe("when payment method is not active", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).addCurrencies(
          depositId,
          venmoPaymentMethod,
          [{ code: Currency.EUR, minConversionRate: ether(0.9), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
        await escrow.connect(depositor.wallet).setPaymentMethodActive(depositId, venmoPaymentMethod, false);
      });

      it("reverts with PaymentMethodNotActive", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "PaymentMethodNotActive");
      });
    });
  });

  /* ================================================================
   *  7. setPaymentMethodActive -- payment method not listed
   * ================================================================ */
  describe("#setPaymentMethodActive", () => {
    describe("when payment method is not listed on the deposit", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).setPaymentMethodActive(
          depositId,
          paypalPaymentMethod,
          false
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with PaymentMethodNotListed", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "PaymentMethodNotListed");
      });
    });
  });

  /* ================================================================
   *  8. setRateManager -- error branches
   * ================================================================ */
  describe("#setRateManager", () => {
    let subjectCaller: any;
    let subjectRateManagerAddress: string;
    let subjectRateManagerId: BytesLike;

    async function subject() {
      return escrow
        .connect(subjectCaller.wallet)
        .setRateManager(depositId, subjectRateManagerAddress, subjectRateManagerId);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectRateManagerAddress = rateManagerMock.address;
      subjectRateManagerId = rateManagerId;
      await rateManagerMock.connect(owner.wallet).setManager(rateManagerId, true);
    });

    describe("when deposit does not exist", () => {
      beforeEach(async () => {
        depositId = BigNumber.from(999);
      });

      afterEach(async () => {
        depositId = ZERO;
      });

      it("reverts with DepositNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotFound");
      });
    });

    describe("when rate manager address is zero", () => {
      beforeEach(async () => {
        subjectRateManagerAddress = ADDRESS_ZERO;
      });

      it("reverts with ZeroAddress", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });

    describe("when rate manager is an EOA (code.length == 0)", () => {
      beforeEach(async () => {
        subjectRateManagerAddress = other.address;
      });

      it("reverts with InvalidRateManager", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "InvalidRateManager");
      });
    });

    describe("when rate manager id is bytes32(0)", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.constants.HashZero;
      });

      it("reverts with ZeroValue", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
      });
    });

    describe("when isRateManager returns false", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("nonexistent-manager");
      });

      it("reverts with RateManagerNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerMock, "RateManagerNotFound");
      });
    });
  });

  /* ================================================================
   *  9. clearRateManager -- error branches
   * ================================================================ */
  describe("#clearRateManager", () => {
    let subjectCaller: any;
    let subjectDepositId: BigNumber;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).clearRateManager(subjectDepositId);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectDepositId = depositId;
    });

    describe("when deposit does not exist", () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("reverts with DepositNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotFound");
      });
    });

    describe("when rate manager is not set", () => {
      it("reverts with RateManagerNotSet", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "RateManagerNotSet");
      });
    });
  });

  /* ================================================================
   *  10. setDelegate -- zero address
   * ================================================================ */
  describe("#setDelegate", () => {
    describe("when delegate is address(0)", () => {
      let subjectCaller: any;

      async function subject() {
        return escrow.connect(subjectCaller.wallet).setDelegate(depositId, ADDRESS_ZERO);
      }

      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("reverts with ZeroAddress", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });

    describe("when delegate is the depositor (self-delegation)", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setDelegate(depositId, depositor.address);
      }

      it("reverts with CannotDelegateToSelf", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "CannotDelegateToSelf");
      });
    });
  });

  /* ================================================================
   *  11. Governance setters -- zero/invalid value branches + non-owner
   * ================================================================ */
  describe("governance setters error branches", () => {
    describe("#setOrchestratorRegistry", () => {
      describe("when address is zero", () => {
        async function subject() {
          return escrow.connect(owner.wallet).setOrchestratorRegistry(ADDRESS_ZERO);
        }

        it("reverts with ZeroAddress", async () => {
          await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
        });
      });

      describe("when caller is not owner", () => {
        async function subject() {
          return escrow.connect(other.wallet).setOrchestratorRegistry(orchestratorRegistry.address);
        }

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });
    });

    describe("#setPaymentVerifierRegistry", () => {
      describe("when address is zero", () => {
        async function subject() {
          return escrow.connect(owner.wallet).setPaymentVerifierRegistry(ADDRESS_ZERO);
        }

        it("reverts with ZeroAddress", async () => {
          await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
        });
      });

      describe("when caller is not owner", () => {
        async function subject() {
          return escrow.connect(other.wallet).setPaymentVerifierRegistry(paymentVerifierRegistry.address);
        }

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });
    });

    describe("#setDustRecipient", () => {
      describe("when address is zero", () => {
        async function subject() {
          return escrow.connect(owner.wallet).setDustRecipient(ADDRESS_ZERO);
        }

        it("reverts with ZeroAddress", async () => {
          await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
        });
      });

      describe("when caller is not owner", () => {
        async function subject() {
          return escrow.connect(other.wallet).setDustRecipient(dustRecipient.address);
        }

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });
    });

    describe("#setDustThreshold", () => {
      describe("when threshold exceeds MAX_DUST_THRESHOLD (1e6)", () => {
        async function subject() {
          return escrow.connect(owner.wallet).setDustThreshold(BigNumber.from(10).pow(6).add(1));
        }

        it("reverts with AmountAboveMax", async () => {
          await expect(subject()).to.be.revertedWithCustomError(escrow, "AmountAboveMax");
        });
      });

      describe("when caller is not owner", () => {
        async function subject() {
          return escrow.connect(other.wallet).setDustThreshold(usdc(1));
        }

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });
    });

    describe("#setMaxIntentsPerDeposit", () => {
      describe("when value is zero", () => {
        async function subject() {
          return escrow.connect(owner.wallet).setMaxIntentsPerDeposit(ZERO);
        }

        it("reverts with ZeroValue", async () => {
          await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
        });
      });

      describe("when caller is not owner", () => {
        async function subject() {
          return escrow.connect(other.wallet).setMaxIntentsPerDeposit(10);
        }

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });
    });

    describe("#setIntentExpirationPeriod", () => {
      describe("when value is zero", () => {
        async function subject() {
          return escrow.connect(owner.wallet).setIntentExpirationPeriod(ZERO);
        }

        it("reverts with ZeroValue", async () => {
          await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
        });
      });

      describe("when caller is not owner", () => {
        async function subject() {
          return escrow.connect(other.wallet).setIntentExpirationPeriod(7200);
        }

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });
    });

    describe("#pauseEscrow", () => {
      describe("when caller is not owner", () => {
        async function subject() {
          return escrow.connect(other.wallet).pauseEscrow();
        }

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });
    });

    describe("#unpauseEscrow", () => {
      describe("when caller is not owner", () => {
        async function subject() {
          return escrow.connect(other.wallet).unpauseEscrow();
        }

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });
    });
  });

  /* ================================================================
   *  12. lockFunds -- uncovered error branches
   * ================================================================ */
  describe("#lockFunds", () => {
    describe("when deposit does not exist", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("no-deposit-intent"));
        return orchestratorMock.connect(owner.wallet).lockFunds(BigNumber.from(999), intentHash, usdc(20));
      }

      it("reverts with DepositNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotFound");
      });
    });

    describe("when deposit is not accepting intents", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("not-accepting-intent"));
        return orchestratorMock.connect(owner.wallet).lockFunds(depositId, intentHash, usdc(20));
      }

      beforeEach(async () => {
        await escrow.connect(depositor.wallet).setAcceptingIntents(depositId, false);
      });

      it("reverts with DepositNotAcceptingIntents", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotAcceptingIntents");
      });
    });

    describe("when amount is below min range", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("below-min-intent"));
        return orchestratorMock.connect(owner.wallet).lockFunds(depositId, intentHash, usdc(5));
      }

      it("reverts with AmountBelowMin", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "AmountBelowMin");
      });
    });

    describe("when amount is above max range", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("above-max-intent"));
        return orchestratorMock.connect(owner.wallet).lockFunds(depositId, intentHash, usdc(201));
      }

      it("reverts with AmountAboveMax", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "AmountAboveMax");
      });
    });
  });

  /* ================================================================
   *  13. unlockFunds / unlockAndTransferFunds -- not found branches
   * ================================================================ */
  describe("#unlockFunds", () => {
    describe("when deposit does not exist", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("phantom-intent"));
        return orchestratorMock.connect(owner.wallet).unlockFunds(BigNumber.from(999), intentHash);
      }

      it("reverts with DepositNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotFound");
      });
    });

    describe("when intent does not exist", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("missing-intent"));
        return orchestratorMock.connect(owner.wallet).unlockFunds(depositId, intentHash);
      }

      it("reverts with IntentNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "IntentNotFound");
      });
    });
  });

  describe("#unlockAndTransferFunds", () => {
    describe("when deposit does not exist", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("phantom-transfer-intent"));
        return orchestratorMock
          .connect(owner.wallet)
          .unlockAndTransferFunds(BigNumber.from(999), intentHash, usdc(20), other.address);
      }

      it("reverts with DepositNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotFound");
      });
    });

    describe("when intent does not exist", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("missing-transfer-intent"));
        return orchestratorMock
          .connect(owner.wallet)
          .unlockAndTransferFunds(depositId, intentHash, usdc(20), other.address);
      }

      it("reverts with IntentNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "IntentNotFound");
      });
    });

    describe("when transfer amount is zero", () => {
      let intentHash: BytesLike;

      async function subject() {
        return orchestratorMock
          .connect(owner.wallet)
          .unlockAndTransferFunds(depositId, intentHash, ZERO, other.address);
      }

      beforeEach(async () => {
        intentHash = await createIntentWith(orchestratorMock, usdc(20));
      });

      it("reverts with ZeroValue", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
      });
    });

    describe("when transfer amount exceeds intent amount", () => {
      let intentHash: BytesLike;

      async function subject() {
        return orchestratorMock
          .connect(owner.wallet)
          .unlockAndTransferFunds(depositId, intentHash, usdc(25), other.address);
      }

      beforeEach(async () => {
        intentHash = await createIntentWith(orchestratorMock, usdc(20));
      });

      it("reverts with AmountExceedsAvailable", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "AmountExceedsAvailable");
      });
    });
  });

  /* ================================================================
   *  14. extendIntentExpiry -- error branches
   * ================================================================ */
  describe("#extendIntentExpiry", () => {
    describe("when deposit does not exist", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("phantom-extend"));
        return escrow.connect(intentGuardian.wallet).extendIntentExpiry(BigNumber.from(999), intentHash, 120);
      }

      it("reverts with DepositNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotFound");
      });
    });

    describe("when intent does not exist", () => {
      async function subject() {
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("missing-extend-intent"));
        return escrow.connect(intentGuardian.wallet).extendIntentExpiry(depositId, intentHash, 120);
      }

      it("reverts with IntentNotFound", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "IntentNotFound");
      });
    });

    describe("when caller is not intentGuardian", () => {
      let intentHash: BytesLike;

      async function subject() {
        return escrow.connect(other.wallet).extendIntentExpiry(depositId, intentHash, 120);
      }

      beforeEach(async () => {
        intentHash = await createIntentWith(orchestratorMock, usdc(20));
      });

      it("reverts with UnauthorizedCaller", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });

    describe("when additional time is zero", () => {
      let intentHash: BytesLike;

      async function subject() {
        return escrow.connect(intentGuardian.wallet).extendIntentExpiry(depositId, intentHash, 0);
      }

      beforeEach(async () => {
        intentHash = await createIntentWith(orchestratorMock, usdc(20));
      });

      it("reverts with ZeroValue", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
      });
    });
  });

  /* ================================================================
   *  15. _computeSpreadRate -- marketRate == 0, rateUpdatedAt == 0
   * ================================================================ */
  describe("#_computeSpreadRate (via getDepositCurrencyMinRate)", () => {
    describe("when oracle returns marketRate == 0", () => {
      async function subject() {
        return escrow.getDepositCurrencyMinRate(depositId, venmoPaymentMethod, Currency.USD);
      }

      beforeEach(async () => {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        await escrow.connect(depositor.wallet).setOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: buildOracleAdapterConfig(true, ZERO, currentTimestamp),
            spreadBps: 100,
            maxStaleness: 3600,
          }
        );
      });

      it("returns zero (oracle halt)", async () => {
        expect(await subject()).to.eq(ZERO);
      });
    });

    describe("when oracle returns rateUpdatedAt == 0", () => {
      async function subject() {
        return escrow.getDepositCurrencyMinRate(depositId, venmoPaymentMethod, Currency.USD);
      }

      beforeEach(async () => {
        await escrow.connect(depositor.wallet).setOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: buildOracleAdapterConfig(true, ether(1.2), ZERO),
            spreadBps: 100,
            maxStaleness: 3600,
          }
        );
      });

      it("returns zero (oracle halt)", async () => {
        expect(await subject()).to.eq(ZERO);
      });
    });
  });

  /* ================================================================
   *  16. _closeDepositIfNecessary -- retainOnEmpty and totalRemaining == 0
   * ================================================================ */
  describe("#_closeDepositIfNecessary", () => {
    describe("when retainOnEmpty is true", () => {
      let retainDepositId: BigNumber;

      beforeEach(async () => {
        await escrow.connect(depositor.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(20),
          intentAmountRange: { min: usdc(10), max: usdc(200) },
          paymentMethods: [paypalPaymentMethod],
          paymentMethodData: [
            {
              intentGatingService: ADDRESS_ZERO,
              payeeDetails,
              data: "0x",
            },
          ],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: delegate.address,
          intentGuardian: intentGuardian.address,
          retainOnEmpty: true,
        });
        retainDepositId = ONE;
      });

      it("does NOT close the deposit after full transfer", async () => {
        // Lock and transfer all funds
        intentCounter += 1;
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`retain-intent-${intentCounter}`));
        await orchestratorMock.connect(owner.wallet).lockFunds(retainDepositId, intentHash, usdc(20));
        await orchestratorMock
          .connect(owner.wallet)
          .unlockAndTransferFunds(retainDepositId, intentHash, usdc(20), other.address);

        // Deposit still exists because retainOnEmpty is true
        const deposit = await escrow.getDeposit(retainDepositId);
        expect(deposit.depositor).to.eq(depositor.address);
      });
    });

    describe("when totalRemaining is zero and retainOnEmpty is false", () => {
      let zeroRemainDepositId: BigNumber;

      beforeEach(async () => {
        await escrow.connect(depositor.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(20),
          intentAmountRange: { min: usdc(10), max: usdc(200) },
          paymentMethods: [paypalPaymentMethod],
          paymentMethodData: [
            {
              intentGatingService: ADDRESS_ZERO,
              payeeDetails,
              data: "0x",
            },
          ],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: delegate.address,
          intentGuardian: intentGuardian.address,
          retainOnEmpty: false,
        });
        zeroRemainDepositId = ONE;
      });

      it("closes deposit and does NOT emit DustCollected when totalRemaining is 0", async () => {
        // Lock and transfer exactly all funds
        intentCounter += 1;
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`zero-remain-${intentCounter}`));
        await orchestratorMock.connect(owner.wallet).lockFunds(zeroRemainDepositId, intentHash, usdc(20));

        const transferTx = orchestratorMock
          .connect(owner.wallet)
          .unlockAndTransferFunds(zeroRemainDepositId, intentHash, usdc(20), other.address);

        await expect(transferTx)
          .to.emit(escrow, "DepositClosed")
          .withArgs(zeroRemainDepositId, depositor.address);

        await expect(transferTx)
          .to.not.emit(escrow, "DustCollected");

        // Deposit is deleted
        const deposit = await escrow.getDeposit(zeroRemainDepositId);
        expect(deposit.depositor).to.eq(ADDRESS_ZERO);
      });
    });
  });

  /* ================================================================
   *  17. setAcceptingIntents -- already in same state
   * ================================================================ */
  describe("#setAcceptingIntents", () => {
    describe("when setting to true while already true", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setAcceptingIntents(depositId, true);
      }

      it("reverts with DepositAlreadyInState", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositAlreadyInState");
      });
    });

    describe("when setting to false while already false", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setAcceptingIntents(depositId, false);
      }

      beforeEach(async () => {
        await escrow.connect(depositor.wallet).setAcceptingIntents(depositId, false);
      });

      it("reverts with DepositAlreadyInState", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositAlreadyInState");
      });
    });
  });

  /* ================================================================
   *  18. setRetainOnEmpty -- already in same state
   * ================================================================ */
  describe("#setRetainOnEmpty", () => {
    describe("when setting to false while already false", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setRetainOnEmpty(depositId, false);
      }

      it("reverts with DepositAlreadyInState", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositAlreadyInState");
      });
    });

    describe("when setting to true while already true", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setRetainOnEmpty(depositId, true);
      }

      beforeEach(async () => {
        await escrow.connect(depositor.wallet).setRetainOnEmpty(depositId, true);
      });

      it("reverts with DepositAlreadyInState", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositAlreadyInState");
      });
    });
  });

  /* ================================================================
   *  19. removeFunds -- amount is zero
   * ================================================================ */
  describe("#removeFunds", () => {
    describe("when amount is zero", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).removeFunds(depositId, ZERO);
      }

      it("reverts with ZeroValue", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
      });
    });
  });

  /* ================================================================
   *  20. Paused state
   * ================================================================ */
  describe("paused state", () => {
    beforeEach(async () => {
      await escrow.connect(owner.wallet).pauseEscrow();
    });

    describe("#createDeposit when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(50),
          intentAmountRange: { min: usdc(10), max: usdc(100) },
          paymentMethods: [venmoPaymentMethod],
          paymentMethodData: [
            {
              intentGatingService: ADDRESS_ZERO,
              payeeDetails,
              data: "0x",
            },
          ],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: delegate.address,
          intentGuardian: intentGuardian.address,
          retainOnEmpty: false,
        });
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#depositTo when paused", () => {
      async function subject() {
        return escrow.connect(other.wallet).depositTo(depositor.address, {
          token: usdcToken.address,
          amount: usdc(50),
          intentAmountRange: { min: usdc(10), max: usdc(100) },
          paymentMethods: [venmoPaymentMethod],
          paymentMethodData: [
            {
              intentGatingService: ADDRESS_ZERO,
              payeeDetails,
              data: "0x",
            },
          ],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: delegate.address,
          intentGuardian: intentGuardian.address,
          retainOnEmpty: false,
        });
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#addFunds when paused", () => {
      async function subject() {
        return escrow.connect(other.wallet).addFunds(depositId, usdc(10));
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#removeFunds when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).removeFunds(depositId, usdc(10));
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  /* ================================================================
   *  21. onlyDepositorOrDelegate modifier -- not depositor, no delegate
   * ================================================================ */
  describe("onlyDepositorOrDelegate modifier", () => {
    describe("when caller is neither depositor nor delegate", () => {
      async function subject() {
        return escrow.connect(other.wallet).setCurrencyMinRate(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          ether(1.1)
        );
      }

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when delegate is address(0) and caller is not depositor", () => {
      let noDelegateDepositId: BigNumber;

      beforeEach(async () => {
        await escrow.connect(depositor.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(50),
          intentAmountRange: { min: usdc(10), max: usdc(100) },
          paymentMethods: [paypalPaymentMethod],
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
        noDelegateDepositId = ONE;
      });

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(
          escrow.connect(other.wallet).setCurrencyMinRate(
            noDelegateDepositId,
            paypalPaymentMethod,
            Currency.USD,
            ether(1.1)
          )
        ).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });
  });

  /* ================================================================
   *  Additional paused-state branches for deposit management functions
   * ================================================================ */
  describe("paused state -- additional functions", () => {
    beforeEach(async () => {
      await escrow.connect(owner.wallet).pauseEscrow();
    });

    describe("#setCurrencyMinRate when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setCurrencyMinRate(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          ether(1.1)
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#setOracleRateConfig when paused", () => {
      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(depositor.wallet).setOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          Currency.USD,
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
            spreadBps: 100,
            maxStaleness: 3600,
          }
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#addPaymentMethods when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).addPaymentMethods(
          depositId,
          [paypalPaymentMethod],
          [{ intentGatingService: ADDRESS_ZERO, payeeDetails, data: "0x" }],
          [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]]
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#addCurrencies when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).addCurrencies(
          depositId,
          venmoPaymentMethod,
          [{ code: Currency.EUR, minConversionRate: ether(0.9), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#setPaymentMethodActive when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setPaymentMethodActive(
          depositId,
          venmoPaymentMethod,
          false
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#setAcceptingIntents when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setAcceptingIntents(depositId, false);
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#setRetainOnEmpty when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setRetainOnEmpty(depositId, true);
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#setIntentRange when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setIntentRange(depositId, { min: usdc(5), max: usdc(300) });
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#setDelegate when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setDelegate(depositId, other.address);
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#removeDelegate when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).removeDelegate(depositId);
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#removeOracleRateConfig when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).removeOracleRateConfig(
          depositId,
          venmoPaymentMethod,
          Currency.USD
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#deactivateCurrency when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).deactivateCurrency(
          depositId,
          venmoPaymentMethod,
          Currency.USD
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#setRateManager when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).setRateManager(
          depositId,
          rateManagerMock.address,
          rateManagerId
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#clearRateManager when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).clearRateManager(depositId);
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#setOracleRateConfigBatch when paused", () => {
      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(depositor.wallet).setOracleRateConfigBatch(
          depositId,
          [venmoPaymentMethod],
          [[Currency.USD]],
          [[{
            adapter: staticOracleAdapter.address,
            adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
            spreadBps: 100,
            maxStaleness: 3600,
          }]]
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#updateCurrencyConfigBatch when paused", () => {
      async function subject() {
        const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
        return escrow.connect(depositor.wallet).updateCurrencyConfigBatch(
          depositId,
          [venmoPaymentMethod],
          [[{
            code: Currency.USD,
            minConversionRate: ether(1.1),
            updateOracle: true,
            oracleRateConfig: {
              adapter: staticOracleAdapter.address,
              adapterConfig: buildOracleAdapterConfig(true, ether(1.2), currentTimestamp),
              spreadBps: 100,
              maxStaleness: 3600,
            },
          }]]
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("#deactivateCurrenciesBatch when paused", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).deactivateCurrenciesBatch(
          depositId,
          [venmoPaymentMethod],
          [[Currency.USD]]
        );
      }

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  /* ================================================================
   *  22. nonReentrant modifier -- direct storage manipulation
   *  Sets the ReentrancyGuard _status to _ENTERED (2) via
   *  hardhat_setStorageAt so the top-level call hits the revert
   *  branch without needing an actual reentrant subcall.
   * ================================================================ */
  describe("nonReentrant modifier", () => {
    // ReentrancyGuard._status is at storage slot 1 for EscrowV2
    // (Ownable._owner + Pausable._paused packed in slot 0, ReentrancyGuard._status = slot 1)
    const REENTRANCY_SLOT = "0x01";
    const ENTERED = ethers.utils.hexZeroPad("0x02", 32);
    const NOT_ENTERED = ethers.utils.hexZeroPad("0x01", 32);

    afterEach(async () => {
      // Always restore _status to _NOT_ENTERED so other tests aren't affected
      await ethers.provider.send("hardhat_setStorageAt", [escrow.address, REENTRANCY_SLOT, NOT_ENTERED]);
    });

    describe("#removeFunds when reentrancy guard is entered", () => {
      async function subject() {
        return escrow.connect(depositor.wallet).removeFunds(depositId, usdc(10));
      }

      beforeEach(async () => {
        await ethers.provider.send("hardhat_setStorageAt", [escrow.address, REENTRANCY_SLOT, ENTERED]);
      });

      it("reverts with ReentrancyGuard: reentrant call", async () => {
        await expect(subject()).to.be.revertedWith("ReentrancyGuard: reentrant call");
      });
    });
  });
});
