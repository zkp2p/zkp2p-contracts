import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike, Contract } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  EscrowV2,
  OrchestratorMock,
  OrchestratorRegistry,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("EscrowV2", () => {
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
  let secondaryOrchestratorMock: OrchestratorMock;
  let revertingPruneOrchestrator: Contract;

  let venmoPaymentMethod: BytesLike;
  let paypalPaymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let depositId: BigNumber;
  let intentCounter: number;

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

  async function clearIntentOrchestrator(intentHash: BytesLike) {
    const mappingSlot = 16;
    const storageSlot = ethers.utils.solidityKeccak256(
      ["bytes32", "uint256"],
      [intentHash, mappingSlot]
    );
    await ethers.provider.send("hardhat_setStorageAt", [
      escrow.address,
      storageSlot,
      ethers.constants.HashZero,
    ]);
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

    venmoPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    paypalPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

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
    secondaryOrchestratorMock = await deployer.deployOrchestratorMock(escrow.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(secondaryOrchestratorMock.address);

    const revertingFactory = await ethers.getContractFactory("RevertingPruneOrchestratorMock", owner.wallet);
    revertingPruneOrchestrator = await revertingFactory.deploy(escrow.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(revertingPruneOrchestrator.address);

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
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
      delegate: delegate.address,
      intentGuardian: intentGuardian.address,
      retainOnEmpty: false,
    });

    depositId = ZERO;
  });

  describe("#createDeposit", () => {
    let subjectRangeMin: BigNumber;
    let subjectRangeMax: BigNumber;
    let subjectAmount: BigNumber;

    async function subject() {
      return escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: subjectAmount,
        intentAmountRange: { min: subjectRangeMin, max: subjectRangeMax },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [
          {
            intentGatingService: ADDRESS_ZERO,
            payeeDetails,
            data: "0x",
          },
        ],
        currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
        delegate: delegate.address,
        intentGuardian: intentGuardian.address,
        retainOnEmpty: false,
      });
    }

    beforeEach(async () => {
      subjectRangeMin = usdc(10);
      subjectRangeMax = usdc(100);
      subjectAmount = usdc(50);
    });

    it("reverts when min is greater than max", async () => {
      subjectRangeMin = usdc(100);
      subjectRangeMax = usdc(10);
      await expect(subject()).to.be.revertedWithCustomError(escrow, "InvalidRange");
    });

    it("reverts when amount is below min", async () => {
      subjectRangeMin = usdc(20);
      subjectRangeMax = usdc(100);
      subjectAmount = usdc(10);
      await expect(subject()).to.be.revertedWithCustomError(escrow, "AmountBelowMin");
    });
  });

  describe("#addFunds", () => {
    let subjectCaller: any;
    let subjectDepositId: BigNumber;
    let subjectAmount: BigNumber;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).addFunds(subjectDepositId, subjectAmount);
    }

    beforeEach(async () => {
      subjectCaller = other;
      subjectDepositId = depositId;
      subjectAmount = usdc(25);
    });

    it("adds funds and emits event", async () => {
      const beforeDeposit = await escrow.getDeposit(depositId);
      await expect(subject())
        .to.emit(escrow, "DepositFundsAdded")
        .withArgs(depositId, other.address, subjectAmount);
      const afterDeposit = await escrow.getDeposit(depositId);
      expect(afterDeposit.remainingDeposits.sub(beforeDeposit.remainingDeposits)).to.eq(subjectAmount);
    });

    describe("when deposit does not exist", () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotFound");
      });
    });

    describe("when amount is zero", () => {
      beforeEach(async () => {
        subjectAmount = ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
      });
    });
  });

  describe("#removeFunds", () => {
    let subjectCaller: any;
    let subjectAmount: BigNumber;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).removeFunds(depositId, subjectAmount);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectAmount = usdc(40);
    });

    it("removes funds and emits event", async () => {
      const beforeDeposit = await escrow.getDeposit(depositId);
      await expect(subject())
        .to.emit(escrow, "DepositWithdrawn")
        .withArgs(depositId, depositor.address, subjectAmount);
      const afterDeposit = await escrow.getDeposit(depositId);
      expect(beforeDeposit.remainingDeposits.sub(afterDeposit.remainingDeposits)).to.eq(subjectAmount);
    });

    it("reclaims expired intent liquidity and attempts orchestrator prune", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));
      await increaseTime(3601);
      subjectAmount = usdc(490);

      await subject();

      const pruned = await orchestratorMock.getLastPrunedIntents();
      expect(pruned[0]).to.eq(intentHash);
    });

    it("auto-disables accepting intents when remaining falls below min", async () => {
      subjectAmount = usdc(495);
      await expect(subject()).to.emit(escrow, "DepositAcceptingIntentsUpdated").withArgs(depositId, false);
      const deposit = await escrow.getDeposit(depositId);
      expect(deposit.acceptingIntents).to.eq(false);
    });

    it("reverts when requested removal exceeds available liquidity", async () => {
      await createIntentWith(orchestratorMock, usdc(20));
      subjectAmount = usdc(490);

      await expect(subject()).to.be.revertedWithCustomError(escrow, "InsufficientDepositLiquidity");
    });

    describe("when caller is not depositor", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });
  });

  describe("#withdrawDeposit", () => {
    let subjectCaller: any;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).withdrawDeposit(depositId);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
    });

    it("withdraws, prunes expired intents, and closes the deposit", async () => {
      await createIntentWith(orchestratorMock, usdc(20));
      await increaseTime(3601);

      await expect(subject()).to.emit(escrow, "DepositClosed").withArgs(depositId, depositor.address);

      const deposit = await escrow.getDeposit(depositId);
      expect(deposit.depositor).to.eq(ADDRESS_ZERO);
      expect(await escrow.getDepositPaymentMethods(depositId)).to.deep.eq([]);
    });
  });

  describe("#setDelegate", () => {
    let subjectCaller: any;
    let subjectDelegateAddress: string;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).setDelegate(depositId, subjectDelegateAddress);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectDelegateAddress = other.address;
    });

    it("sets delegate and emits event", async () => {
      await expect(subject())
        .to.emit(escrow, "DepositDelegateSet")
        .withArgs(depositId, depositor.address, other.address);

      const deposit = await escrow.getDeposit(depositId);
      expect(deposit.delegate).to.eq(other.address);
    });

    describe("when caller is not depositor", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });
  });

  describe("#removeDelegate", () => {
    let subjectCaller: any;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).removeDelegate(depositId);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
    });

    it("removes delegate and emits event", async () => {
      await expect(subject()).to.emit(escrow, "DepositDelegateRemoved").withArgs(depositId, depositor.address);
      const deposit = await escrow.getDeposit(depositId);
      expect(deposit.delegate).to.eq(ADDRESS_ZERO);
    });

    describe("when no delegate is set", () => {
      beforeEach(async () => {
        await escrow.connect(depositor.wallet).removeDelegate(depositId);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.reverted;
      });
    });
  });

  describe("#setIntentRange", () => {
    let subjectCaller: any;
    let subjectRange: any;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).setIntentRange(depositId, subjectRange);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectRange = { min: usdc(20), max: usdc(300) };
    });

    it("updates range and emits event", async () => {
      await expect(subject()).to.emit(escrow, "DepositIntentAmountRangeUpdated");
      const deposit = await escrow.getDeposit(depositId);
      expect(deposit.intentAmountRange.min).to.eq(subjectRange.min);
      expect(deposit.intentAmountRange.max).to.eq(subjectRange.max);
    });

    describe("when min is zero", () => {
      beforeEach(async () => {
        subjectRange = { min: ZERO, max: usdc(100) };
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroMinValue");
      });
    });

    describe("when min is greater than max", () => {
      beforeEach(async () => {
        subjectRange = { min: usdc(100), max: usdc(50) };
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "InvalidRange");
      });
    });
  });

  describe("#setCurrencyMinRate", () => {
    it("reverts when currency is not listed", async () => {
      const unsupported = ethers.utils.formatBytes32String("JPY");
      await expect(
        escrow.connect(depositor.wallet).setCurrencyMinRate(depositId, venmoPaymentMethod, unsupported, ether(1))
      ).to.be.revertedWithCustomError(escrow, "CurrencyNotSupported");
    });
  });

  describe("#addPaymentMethods", () => {
    let subjectCaller: any;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).addPaymentMethods(
        depositId,
        [paypalPaymentMethod],
        [{ intentGatingService: ADDRESS_ZERO, payeeDetails, data: "0x" }],
        [[{ code: Currency.EUR, minConversionRate: ether(0.9) }]]
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
    });

    it("adds payment method to existing deposit", async () => {
      await expect(subject()).to.emit(escrow, "DepositPaymentMethodAdded").withArgs(
        depositId,
        paypalPaymentMethod,
        payeeDetails,
        ADDRESS_ZERO
      );
      expect(await escrow.getDepositPaymentMethodListed(depositId, paypalPaymentMethod)).to.eq(true);
    });

    it("reverts when payment method is not whitelisted", async () => {
      const unknownPaymentMethod = ethers.utils.formatBytes32String("unknown");
      await expect(
        escrow.connect(depositor.wallet).addPaymentMethods(
          depositId,
          [unknownPaymentMethod],
          [{ intentGatingService: ADDRESS_ZERO, payeeDetails, data: "0x" }],
          [[{ code: Currency.USD, minConversionRate: ether(1) }]]
        )
      ).to.be.revertedWithCustomError(escrow, "PaymentMethodNotWhitelisted");
    });
  });

  describe("#setPaymentMethodActive", () => {
    it("toggles payment method active state", async () => {
      await expect(
        escrow.connect(depositor.wallet).setPaymentMethodActive(depositId, venmoPaymentMethod, false)
      ).to.emit(escrow, "DepositPaymentMethodActiveUpdated").withArgs(depositId, venmoPaymentMethod, false);
    });

    it("reverts when payment method is already in the requested state", async () => {
      await expect(
        escrow.connect(depositor.wallet).setPaymentMethodActive(depositId, venmoPaymentMethod, true)
      ).to.be.revertedWithCustomError(escrow, "DepositAlreadyInState");
    });
  });

  describe("#addCurrencies", () => {
    it("adds additional currencies on active payment method", async () => {
      await expect(
        escrow.connect(depositor.wallet).addCurrencies(
          depositId,
          venmoPaymentMethod,
          [{ code: Currency.EUR, minConversionRate: ether(0.9) }]
        )
      ).to.emit(escrow, "DepositCurrencyAdded").withArgs(depositId, venmoPaymentMethod, Currency.EUR, ether(0.9));
    });

    it("reverts for unsupported currency", async () => {
      const unsupported = ethers.utils.formatBytes32String("JPY");
      await expect(
        escrow.connect(depositor.wallet).addCurrencies(
          depositId,
          venmoPaymentMethod,
          [{ code: unsupported, minConversionRate: ether(1) }]
        )
      ).to.be.revertedWithCustomError(escrow, "CurrencyNotSupported");
    });

    it("reverts when currency already exists", async () => {
      await expect(
        escrow.connect(depositor.wallet).addCurrencies(
          depositId,
          venmoPaymentMethod,
          [{ code: Currency.USD, minConversionRate: ether(1) }]
        )
      ).to.be.revertedWithCustomError(escrow, "CurrencyAlreadyExists");
    });
  });

  describe("#setAcceptingIntents", () => {
    it("sets accepting intents flag", async () => {
      await expect(
        escrow.connect(depositor.wallet).setAcceptingIntents(depositId, false)
      ).to.emit(escrow, "DepositAcceptingIntentsUpdated").withArgs(depositId, false);
    });

    it("reverts when enabling while liquidity is below minimum", async () => {
      await escrow.connect(depositor.wallet).setAcceptingIntents(depositId, false);
      await escrow.connect(depositor.wallet).removeFunds(depositId, usdc(495));
      await expect(
        escrow.connect(depositor.wallet).setAcceptingIntents(depositId, true)
      ).to.be.revertedWithCustomError(escrow, "InsufficientDepositLiquidity");
    });
  });

  describe("#setRetainOnEmpty", () => {
    it("sets retainOnEmpty", async () => {
      await expect(
        escrow.connect(depositor.wallet).setRetainOnEmpty(depositId, true)
      ).to.emit(escrow, "DepositRetainOnEmptyUpdated").withArgs(depositId, true);
    });
  });

  describe("#pruneExpiredIntents", () => {
    it("prunes expired intents and unlocks liquidity", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));
      await increaseTime(3601);

      await expect(escrow.connect(other.wallet).pruneExpiredIntents(depositId))
        .to.emit(escrow, "FundsUnlocked")
        .withArgs(depositId, intentHash, usdc(20));
    });

    it("swallows orchestrator prune reverts", async () => {
      const intentHash = await createIntentWith(revertingPruneOrchestrator, usdc(20));
      await increaseTime(3601);

      await expect(escrow.connect(other.wallet).pruneExpiredIntents(depositId)).to.not.be.reverted;
      const prunedIntent = await escrow.getDepositIntent(depositId, intentHash);
      expect(prunedIntent.intentHash).to.eq(ethers.constants.HashZero);
    });

    it("skips orchestrator call when intentOrchestrator is cleared", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));
      await increaseTime(3601);
      await clearIntentOrchestrator(intentHash);

      await expect(escrow.connect(other.wallet).pruneExpiredIntents(depositId)).to.not.be.reverted;
    });
  });

  describe("#lockFunds", () => {
    it("reclaims expired intents and prunes on orchestrator during a new lock", async () => {
      const firstIntentHash = await createIntentWith(orchestratorMock, usdc(20));
      await increaseTime(3601);
      await createIntentWith(orchestratorMock, usdc(20));
      await createIntentWith(orchestratorMock, usdc(20));

      const secondIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent-second"));
      await orchestratorMock.connect(owner.wallet).lockFunds(depositId, secondIntentHash, usdc(20));

      const pruned = await orchestratorMock.getLastPrunedIntents();
      expect(pruned[0]).to.eq(firstIntentHash);
    });

    it("reverts when caller is not whitelisted orchestrator", async () => {
      const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("unauthorized-intent"));
      await expect(
        escrow.connect(other.wallet).lockFunds(depositId, intentHash, usdc(20))
      ).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
    });

    it("reverts on duplicate intent hash", async () => {
      const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("duplicate-intent"));
      await orchestratorMock.connect(owner.wallet).lockFunds(depositId, intentHash, usdc(20));

      await expect(
        orchestratorMock.connect(owner.wallet).lockFunds(depositId, intentHash, usdc(20))
      ).to.be.revertedWithCustomError(escrow, "IntentAlreadyExists");
    });

    it("reverts when liquidity is insufficient after reclaim", async () => {
      await escrow.connect(depositor.wallet).removeFunds(depositId, usdc(400));
      const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("insufficient-intent"));

      await expect(
        orchestratorMock.connect(owner.wallet).lockFunds(depositId, intentHash, usdc(150))
      ).to.be.revertedWithCustomError(escrow, "InsufficientDepositLiquidity");
    });

    it("reverts when max intents is exceeded with no prunable intent", async () => {
      await createIntentWith(orchestratorMock, usdc(20));
      await createIntentWith(orchestratorMock, usdc(20));
      await createIntentWith(orchestratorMock, usdc(20));

      const fourthIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent-fourth"));
      await expect(
        orchestratorMock.connect(owner.wallet).lockFunds(depositId, fourthIntentHash, usdc(20))
      ).to.be.revertedWithCustomError(escrow, "MaxIntentsExceeded");
    });
  });

  describe("#unlockFunds", () => {
    it("unlocks existing intent", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));
      await expect(orchestratorMock.connect(owner.wallet).unlockFunds(depositId, intentHash))
        .to.emit(escrow, "FundsUnlocked")
        .withArgs(depositId, intentHash, usdc(20));
    });

    it("reverts when a different allowlisted orchestrator attempts to unlock", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));

      await expect(secondaryOrchestratorMock.connect(owner.wallet).unlockFunds(depositId, intentHash))
        .to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
    });
  });

  describe("#unlockAndTransferFunds", () => {
    it("unlocks and transfers full amount", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));
      await expect(orchestratorMock.connect(owner.wallet).unlockAndTransferFunds(depositId, intentHash, usdc(20), other.address))
        .to.emit(escrow, "FundsUnlockedAndTransferred")
        .withArgs(depositId, intentHash, usdc(20), usdc(20), other.address);
    });

    it("returns unused amount to liquidity on partial transfer", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));
      const beforeDeposit = await escrow.getDeposit(depositId);

      await orchestratorMock.connect(owner.wallet).unlockAndTransferFunds(depositId, intentHash, usdc(10), other.address);

      const afterDeposit = await escrow.getDeposit(depositId);
      expect(afterDeposit.remainingDeposits.sub(beforeDeposit.remainingDeposits)).to.eq(usdc(10));
    });

    it("collects dust when a partial transfer closes deposit near zero", async () => {
      await escrow.connect(owner.wallet).setDustThreshold(usdc(1));

      await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(10),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [
          {
            intentGatingService: ADDRESS_ZERO,
            payeeDetails,
            data: "0x",
          },
        ],
        currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
        delegate: delegate.address,
        intentGuardian: intentGuardian.address,
        retainOnEmpty: false,
      });

      const secondDepositId = ONE;
      intentCounter += 1;
      const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`dust-intent-${intentCounter}`));
      await orchestratorMock.connect(owner.wallet).lockFunds(secondDepositId, intentHash, usdc(10));

      await expect(
        orchestratorMock.connect(owner.wallet).unlockAndTransferFunds(secondDepositId, intentHash, usdc(9), other.address)
      ).to.emit(escrow, "DustCollected").withArgs(secondDepositId, usdc(1), dustRecipient.address);
    });

    it("reverts when a different allowlisted orchestrator attempts to unlock and transfer", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));

      await expect(
        secondaryOrchestratorMock
          .connect(owner.wallet)
          .unlockAndTransferFunds(depositId, intentHash, usdc(20), other.address)
      )
        .to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
    });
  });

  describe("#extendIntentExpiry", () => {
    it("extends expiry when called by intent guardian", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));
      const beforeIntent = await escrow.getDepositIntent(depositId, intentHash);
      await expect(
        escrow.connect(intentGuardian.wallet).extendIntentExpiry(depositId, intentHash, 120)
      ).to.emit(escrow, "IntentExpiryExtended");
      const afterIntent = await escrow.getDepositIntent(depositId, intentHash);
      expect(afterIntent.expiryTime.sub(beforeIntent.expiryTime)).to.eq(120);
    });

    it("reverts when extension exceeds maximum horizon", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));
      await expect(
        escrow.connect(intentGuardian.wallet).extendIntentExpiry(depositId, intentHash, 86400 * 6)
      ).to.be.revertedWithCustomError(escrow, "AmountAboveMax");
    });
  });

  describe("governance setters and pause", () => {
    it("updates all owner-controlled config fields", async () => {
      const newOrchestratorRegistry = await deployer.deployOrchestratorRegistry();
      const newPaymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();

      await expect(
        escrow.connect(owner.wallet).setOrchestratorRegistry(newOrchestratorRegistry.address)
      ).to.emit(escrow, "OrchestratorRegistryUpdated").withArgs(newOrchestratorRegistry.address);
      await expect(
        escrow.connect(owner.wallet).setPaymentVerifierRegistry(newPaymentVerifierRegistry.address)
      ).to.emit(escrow, "PaymentVerifierRegistryUpdated").withArgs(newPaymentVerifierRegistry.address);
      await expect(escrow.connect(owner.wallet).setDustRecipient(other.address))
        .to.emit(escrow, "DustRecipientUpdated")
        .withArgs(other.address);
      await expect(escrow.connect(owner.wallet).setDustThreshold(usdc(1)))
        .to.emit(escrow, "DustThresholdUpdated")
        .withArgs(usdc(1));
      await expect(escrow.connect(owner.wallet).setMaxIntentsPerDeposit(10))
        .to.emit(escrow, "MaxIntentsPerDepositUpdated")
        .withArgs(10);
      await expect(escrow.connect(owner.wallet).setIntentExpirationPeriod(7200))
        .to.emit(escrow, "IntentExpirationPeriodUpdated")
        .withArgs(7200);

      await escrow.connect(owner.wallet).pauseEscrow();
      expect(await escrow.paused()).to.eq(true);
      await escrow.connect(owner.wallet).unpauseEscrow();
      expect(await escrow.paused()).to.eq(false);
    });
  });

  describe("view getters", () => {
    it("returns stored values from all getter helpers", async () => {
      const intentHash = await createIntentWith(orchestratorMock, usdc(20));

      const intentHashes = await escrow.getDepositIntentHashes(depositId);
      expect(intentHashes[0]).to.eq(intentHash);

      const intent = await escrow.getDepositIntent(depositId, intentHash);
      expect(intent.intentHash).to.eq(intentHash);

      expect(await escrow.getDepositPaymentMethods(depositId)).to.deep.eq([venmoPaymentMethod]);
      expect(await escrow.getDepositCurrencies(depositId, venmoPaymentMethod)).to.deep.eq([Currency.USD]);
      expect(await escrow.getDepositCurrencyListed(depositId, venmoPaymentMethod, Currency.USD)).to.eq(true);
      expect(await escrow.getDepositPaymentMethodListed(depositId, venmoPaymentMethod)).to.eq(true);
      expect((await escrow.getDepositPaymentMethodData(depositId, venmoPaymentMethod)).payeeDetails).to.eq(payeeDetails);
      expect(await escrow.getDepositPaymentMethodActive(depositId, venmoPaymentMethod)).to.eq(true);
      expect(await escrow.getDepositGatingService(depositId, venmoPaymentMethod)).to.eq(ADDRESS_ZERO);

      const accountDeposits = await escrow.getAccountDeposits(depositor.address);
      expect(accountDeposits).to.deep.eq([depositId]);

      await increaseTime(3601);
      const expired = await escrow.getExpiredIntents(depositId);
      expect(expired.expiredIntents[0]).to.eq(intentHash);
      expect(expired.reclaimableAmount).to.eq(usdc(20));
    });
  });
});
