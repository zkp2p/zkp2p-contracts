import "module-alias/register";

import { ethers } from "hardhat";
import { BytesLike, Signer } from "ethers";

import {
  Address,
} from "@utils/types";
import { Account } from "@utils/test/types";
import {
  Escrow,
  Orchestrator,
  IOrchestrator,
  USDCMock,
  PaymentVerifierMock,
  PostIntentHookMock,
  ReentrantPostIntentHook,
  PostIntentHookRegistry,
  PaymentVerifierRegistry,
  RelayerRegistry,
  NullifierRegistry,
  ProtocolViewer,
  EscrowRegistry,
  PartialPullPostIntentHookMock,
  PushPostIntentHookMock
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";

import {
  getWaffleExpect,
  getAccounts
} from "@utils/test/index";
import { Blockchain, ether, usdc } from "@utils/common";
import { BigNumber } from "ethers";
import { ZERO, ZERO_BYTES32, ADDRESS_ZERO, ONE, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "@utils/constants";
import { calculateIntentHash } from "@utils/protocolUtils";
import { Currency } from "@utils/protocolUtils";
import { generateGatingServiceSignature, createSignalIntentParams } from "@utils/test/helpers";

const expect = getWaffleExpect();

const blockchain = new Blockchain(ethers.provider);


describe("Orchestrator", () => {
  let owner: Account;
  let offRamper: Account;
  let offRamperDelegate: Account;
  let offRamperNewAcct: Account;
  let onRamper: Account;
  let onRamperOtherAddress: Account;
  let onRamperTwo: Account;
  let receiver: Account;
  let maliciousOnRamper: Account;
  let feeRecipient: Account;
  let gatingService: Account;
  let relayerAccount: Account;
  let witness: Account;
  let protocolFeeRecipient: Account;
  let chainId: BigNumber = ONE;
  let currentIntentCounter: number = 0;

  let escrow: Escrow;
  let orchestrator: Orchestrator;
  let protocolViewer: ProtocolViewer;
  let usdcToken: USDCMock;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let postIntentHookRegistry: PostIntentHookRegistry;
  let relayerRegistry: RelayerRegistry;
  let nullifierRegistry: NullifierRegistry;
  let escrowRegistry: EscrowRegistry;

  let verifier: PaymentVerifierMock;
  let otherVerifier: PaymentVerifierMock;
  let postIntentHookMock: PostIntentHookMock;
  let partialPostIntentHook: PartialPullPostIntentHookMock;
  let pushPostIntentHook: PushPostIntentHookMock;
  let deployer: DeployHelper;
  let venmoPaymentMethod: BytesLike;

  beforeEach(async () => {
    currentIntentCounter = 0;  // Reset intent counter for each test
    [
      owner,
      offRamper,
      offRamperDelegate,
      onRamper,
      onRamperOtherAddress,
      onRamperTwo,
      receiver,
      maliciousOnRamper,
      offRamperNewAcct,
      feeRecipient,
      gatingService,
      witness,
      relayerAccount,
      protocolFeeRecipient
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");

    escrowRegistry = await deployer.deployEscrowRegistry();

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();

    postIntentHookRegistry = await deployer.deployPostIntentHookRegistry();

    relayerRegistry = await deployer.deployRelayerRegistry();

    nullifierRegistry = await deployer.deployNullifierRegistry();

    await usdcToken.transfer(offRamper.address, usdc(10000));

    escrow = await deployer.deployEscrow(
      owner.address,
      chainId,
      paymentVerifierRegistry.address,
      ADDRESS_ZERO,
      ZERO,
      BigNumber.from(10),
      ONE_DAY_IN_SECONDS  // intentExpirationPeriod
    );

    await escrowRegistry.addEscrow(escrow.address);

    orchestrator = await deployer.deployOrchestrator(
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      postIntentHookRegistry.address,
      relayerRegistry.address,           // relayer registry
      ZERO,                              // protocol fee (0%)
      feeRecipient.address               // protocol fee recipient
    );

    protocolViewer = await deployer.deployProtocolViewer(escrow.address, orchestrator.address);

    // Set orchestrator in escrow
    await escrow.connect(owner.wallet).setOrchestrator(orchestrator.address);

    verifier = await deployer.deployPaymentVerifierMock();
    otherVerifier = await deployer.deployPaymentVerifierMock();

    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);
    await otherVerifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    postIntentHookMock = await deployer.deployPostIntentHookMock(usdcToken.address, orchestrator.address);
    await postIntentHookRegistry.addPostIntentHook(postIntentHookMock.address);

    partialPostIntentHook = await deployer.deployPartialPullPostIntentHookMock(usdcToken.address, orchestrator.address);
    await postIntentHookRegistry.addPostIntentHook(partialPostIntentHook.address);

    pushPostIntentHook = await deployer.deployPushPostIntentHookMock(usdcToken.address, orchestrator.address);
    await postIntentHookRegistry.addPostIntentHook(pushPostIntentHook.address);


    venmoPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(
      venmoPaymentMethod,
      verifier.address,
      [Currency.USD]
    );
  });

  describe("#constructor", async () => {
    it("should set the correct state variables", async () => {
      const actualChainId = await orchestrator.chainId();
      const actualEscrowRegistry = await orchestrator.escrowRegistry();
      const actualPaymentVerifierRegistry = await orchestrator.paymentVerifierRegistry();
      const actualPostIntentHookRegistry = await orchestrator.postIntentHookRegistry();
      const actualRelayerRegistry = await orchestrator.relayerRegistry();
      const actualProtocolFee = await orchestrator.protocolFee();
      const actualProtocolFeeRecipient = await orchestrator.protocolFeeRecipient();

      expect(actualChainId).to.eq(chainId);
      expect(actualEscrowRegistry).to.eq(escrowRegistry.address);
      expect(actualPaymentVerifierRegistry).to.eq(paymentVerifierRegistry.address);
      expect(actualPostIntentHookRegistry).to.eq(postIntentHookRegistry.address);
      expect(actualRelayerRegistry).to.eq(relayerRegistry.address);
      expect(actualProtocolFee).to.eq(ZERO);
      expect(actualProtocolFeeRecipient).to.eq(feeRecipient.address);
    });
  });

  describe("#signalIntent", async () => {
    let subjectEscrow: Address;
    let subjectDepositId: BigNumber;
    let subjectAmount: BigNumber;
    let subjectTo: Address;
    let subjectPaymentMethod: BytesLike;
    let subjectFiatCurrency: string;
    let subjectConversionRate: BigNumber;
    let subjectReferrer: Address;
    let subjectReferrerFee: BigNumber;
    let subjectGatingServiceSignature: string;
    let subjectPostIntentHook: Address;
    let subjectSignatureExpiration: BigNumber;
    let subjectIntentData: string;
    let subjectCaller: Account;

    let depositConversionRate: BigNumber;
    let depositPayeeDetails: BytesLike;

    beforeEach(async () => {
      // Create a deposit first
      await usdcToken.connect(offRamper.wallet).approve(escrow.address, usdc(10000));
      depositConversionRate = ether(1.01);
      depositPayeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails"));

      await escrow.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: depositPayeeDetails,
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: depositConversionRate }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,  // intentGuardian
        retainOnEmpty: false
      });

      const currentTimestamp = await blockchain.getCurrentTimestamp();

      subjectEscrow = escrow.address;
      subjectDepositId = ZERO;
      subjectAmount = usdc(50);
      subjectTo = receiver.address;
      subjectPaymentMethod = venmoPaymentMethod;
      subjectFiatCurrency = Currency.USD;
      subjectConversionRate = ether(1.02);   // Slightly higher than depositConversionRate
      subjectReferrer = ADDRESS_ZERO;       // No referrer by default
      subjectReferrerFee = ZERO;             // No referrer fee by default
      subjectSignatureExpiration = currentTimestamp.add(ONE_DAY_IN_SECONDS).add(10);
      subjectGatingServiceSignature = await generateGatingServiceSignature(
        gatingService,
        orchestrator.address,
        escrow.address,
        subjectDepositId,
        subjectAmount,
        subjectTo,
        subjectPaymentMethod,
        subjectFiatCurrency,
        subjectConversionRate,
        chainId.toString(),
        subjectSignatureExpiration
      );

      subjectPostIntentHook = ADDRESS_ZERO;
      subjectIntentData = "0x";

      subjectCaller = onRamper;
    });

    async function subject(): Promise<any> {
      const params = await createSignalIntentParams(
        orchestrator.address,
        subjectEscrow,
        subjectDepositId,
        subjectAmount,
        subjectTo,
        subjectPaymentMethod,
        subjectFiatCurrency,
        subjectConversionRate,
        subjectReferrer,
        subjectReferrerFee,
        null, // gating service
        chainId.toString(),
        subjectPostIntentHook,
        subjectIntentData,
        subjectSignatureExpiration
      );
      params.gatingServiceSignature = subjectGatingServiceSignature;

      return orchestrator.connect(subjectCaller.wallet).signalIntent(params);
    }

    it("should create the correct entry in the intents mapping", async () => {
      const currentTimestamp = await blockchain.getCurrentTimestamp();
      const intentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );

      await subject();

      const intent = await orchestrator.getIntent(intentHash);

      expect(intent.owner).to.eq(onRamper.address);
      expect(intent.to).to.eq(subjectTo);
      expect(intent.depositId).to.eq(subjectDepositId);
      expect(intent.amount).to.eq(subjectAmount);
      expect(intent.paymentMethod).to.eq(subjectPaymentMethod);
      expect(intent.fiatCurrency).to.eq(subjectFiatCurrency);
      expect(intent.conversionRate).to.eq(subjectConversionRate);
      expect(intent.payeeId).to.eq(depositPayeeDetails);
      expect(intent.referrer).to.eq(subjectReferrer);
      expect(intent.referrerFee).to.eq(subjectReferrerFee);
      expect(intent.postIntentHook).to.eq(subjectPostIntentHook);
      expect(intent.data).to.eq(subjectIntentData);
    });

    it("should lock funds in the escrow contract", async () => {
      const currentTimestamp = await blockchain.getCurrentTimestamp();
      const intentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );

      const preDeposit = await escrow.getDeposit(subjectDepositId);

      await subject();

      const postDeposit = await escrow.getDeposit(subjectDepositId);
      const postIntents = await escrow.getDepositIntentHashes(subjectDepositId);

      expect(postDeposit.outstandingIntentAmount).to.eq(preDeposit.outstandingIntentAmount.add(subjectAmount));
      expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.sub(subjectAmount));
      expect(postIntents).to.include(intentHash);
    });

    it("should add the intent hash to the account's intents", async () => {
      const tx = await subject();
      const receipt = await tx.wait();

      // Get the block timestamp from the transaction receipt
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const intentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );

      const accountIntents = await orchestrator.getAccountIntents(onRamper.address);
      expect(accountIntents).to.include(intentHash);
    });

    it("should snapshot the min-at-signal", async () => {
      const currentTimestamp = await blockchain.getCurrentTimestamp();
      const intentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );

      const deposit = await escrow.getDeposit(subjectDepositId);
      const expectedMinAtSignal = deposit.intentAmountRange.min;

      await subject();

      const minAtSignal = await orchestrator.getIntentMinAtSignal(intentHash);
      expect(minAtSignal).to.eq(expectedMinAtSignal);
    });

    it("should emit an IntentSignaled event", async () => {
      const tx = await subject();
      const receipt = await tx.wait();

      // Get the block timestamp from the transaction receipt
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const intentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );

      expect(tx).to.emit(orchestrator, "IntentSignaled").withArgs(
        intentHash,
        escrow.address,
        subjectDepositId,
        subjectPaymentMethod,
        onRamper.address,
        subjectTo,
        subjectAmount,
        subjectFiatCurrency,
        subjectConversionRate,
        block.timestamp
      );
    });

    describe.skip("when there aren't enough deposits to cover requested amount but there are prunable intents", async () => {
      let timeJump: number;
      let oldIntentHash: string;

      before(async () => {
        timeJump = ONE_DAY_IN_SECONDS.add(1).toNumber();
      });

      beforeEach(async () => {
        await subject();
        currentIntentCounter++;  // Increment counter after signalIntent

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        oldIntentHash = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter - 1  // Use the counter value when the intent was created
        );

        await blockchain.increaseTimeAsync(timeJump);

        subjectAmount = usdc(60);
        subjectCaller = onRamperTwo;
        subjectSignatureExpiration = currentTimestamp.add(ONE_DAY_IN_SECONDS).add(10);
        subjectGatingServiceSignature = await generateGatingServiceSignature(
          gatingService,
          orchestrator.address,
          escrow.address,
          subjectDepositId,
          subjectAmount,
          subjectTo,
          subjectPaymentMethod,
          subjectFiatCurrency,
          subjectConversionRate,
          chainId.toString(),
          subjectSignatureExpiration
        );
      });

      it("should prune the old intent and update the deposit mapping correctly", async () => {
        const preDeposit = await protocolViewer.getDeposit(subjectDepositId);

        await subject();

        const newIntentHash = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter  // Current counter value for the new intent
        );
        currentIntentCounter++;  // Increment after creating new intent

        const postDeposit = await protocolViewer.getDeposit(subjectDepositId);

        expect(postDeposit.deposit.outstandingIntentAmount).to.eq(subjectAmount);
        expect(postDeposit.deposit.remainingDeposits).to.eq(preDeposit.deposit.remainingDeposits.sub(usdc(10))); // 10 usdc difference between old and new intent
        expect(postDeposit.intentHashes).to.include(newIntentHash);
        expect(postDeposit.intentHashes).to.not.include(oldIntentHash);
      });

      it("should delete the original intent from the intents mapping", async () => {
        await subject();

        const intent = await orchestrator.getIntent(oldIntentHash);

        expect(intent.owner).to.eq(ADDRESS_ZERO);
        expect(intent.depositId).to.eq(ZERO);
      });

      it("should emit an IntentPruned event", async () => {
        await expect(subject()).to.emit(orchestrator, "IntentPruned").withArgs(
          oldIntentHash
        );
      });

      describe("when the reclaimable amount can't cover the new intent", async () => {
        before(async () => {
          timeJump = ONE_DAY_IN_SECONDS.div(2).toNumber();
        });

        after(async () => {
          timeJump = ONE_DAY_IN_SECONDS.add(1).toNumber();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.reverted;
        });
      });
    });

    describe("when the account has an unfulfilled intent", async () => {
      beforeEach(async () => {
        await subject();
        currentIntentCounter++;  // Increment after signalIntent
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "AccountHasActiveIntent");
      });

      describe("when the intent is cancelled", async () => {
        beforeEach(async () => {
          const currentTimestamp = await blockchain.getCurrentTimestamp();
          const oldIntentHash = calculateIntentHash(
            orchestrator.address,
            currentIntentCounter - 1  // Use the counter value when the intent was created
          );
          await orchestrator.connect(onRamper.wallet).cancelIntent(oldIntentHash);
        });

        it("should not revert", async () => {
          expect(await subject()).to.not.be.reverted;
        });
      });

      describe("when multiple intents are allowed", async () => {
        beforeEach(async () => {
          await orchestrator.connect(owner.wallet).setAllowMultipleIntents(true);
        });

        it("should not revert", async () => {
          expect(await subject()).to.not.be.reverted;
        });
      });

      describe("when caller is relayer", async () => {
        beforeEach(async () => {
          await relayerRegistry.connect(owner.wallet).addRelayer(relayerAccount.address);

          subjectCaller = relayerAccount;
        });

        it("should not revert", async () => {
          expect(await subject()).to.not.be.reverted;
        });
      });
    });

    describe("when post intent hook is set", async () => {
      beforeEach(async () => {
        subjectPostIntentHook = postIntentHookMock.address;
        subjectIntentData = "0x1234"
      });

      it("should set the post intent hook and intent data", async () => {
        await subject();

        const intent = await orchestrator.getIntent(calculateIntentHash(
          orchestrator.address,
          currentIntentCounter  // Current counter for this intent
        ));
        currentIntentCounter++;  // Increment after creating intent
        expect(intent.postIntentHook).to.eq(postIntentHookMock.address);
        expect(intent.data).to.eq(subjectIntentData);
      });

      describe("when the post intent hook is not whitelisted", async () => {
        beforeEach(async () => {
          await postIntentHookRegistry.removePostIntentHook(postIntentHookMock.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWithCustomError(orchestrator, "PostIntentHookNotWhitelisted");
        });
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = ONE; // Non-existent deposit
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "PaymentMethodNotSupported");
      });
    });

    describe("when the payment method is not supported on the deposit", async () => {
      beforeEach(async () => {
        const paypalPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
        await paymentVerifierRegistry.connect(owner.wallet).addPaymentMethod(
          paypalPaymentMethod,
          verifier.address,
          [Currency.USD]
        );
        subjectPaymentMethod = paypalPaymentMethod;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "PaymentMethodNotSupported");
      });
    });

    describe("when the payment method is removed from registry after deposit creation", async () => {
      beforeEach(async () => {
        // Payment method is valid for the deposit but will be removed from registry
        await paymentVerifierRegistry.connect(owner.wallet).removePaymentMethod(venmoPaymentMethod);
      });

      it("should revert on signalIntent", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "PaymentMethodDoesNotExist");
      });
    });

    describe("when the fiat currency is not supported by the verifier", async () => {
      beforeEach(async () => {
        subjectFiatCurrency = Currency.EUR;    // supported by verifier but not supported by deposit
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "CurrencyNotSupported");
      });
    });

    describe("when the conversion rate is less than the min conversion rate", async () => {
      beforeEach(async () => {
        subjectConversionRate = ether(0.99); // Less than min conversion rate
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "RateBelowMinimum");
      });

      describe("when the conversion rate is equal to the min conversion rate", async () => {
        beforeEach(async () => {
          subjectConversionRate = ether(1.01); // Equal to min conversion rate
          const currentTimestamp = await blockchain.getCurrentTimestamp();
          subjectSignatureExpiration = currentTimestamp.add(ONE_DAY_IN_SECONDS).add(10);

          subjectGatingServiceSignature = await generateGatingServiceSignature(
            gatingService,
            orchestrator.address,
            escrow.address,
            subjectDepositId,
            subjectAmount,
            subjectTo,
            subjectPaymentMethod,
            subjectFiatCurrency,
            subjectConversionRate,
            chainId.toString(),
            subjectSignatureExpiration
          );
        });

        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });
    });

    describe("when the escrow is not whitelisted", async () => {
      beforeEach(async () => {
        await escrowRegistry.connect(owner.wallet).removeEscrow(escrow.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "EscrowNotWhitelisted");
      });

      describe("when the escrow registry is accepting all escrows", async () => {
        beforeEach(async () => {
          await escrowRegistry.connect(owner.wallet).setAcceptAllEscrows(true);
        });

        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });
    });

    describe("when the deposit is not accepting intents", async () => {
      beforeEach(async () => {
        // Create and signal an intent first to lock some liquidity
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          subjectDepositId,
          usdc(50),
          receiver.address,
          venmoPaymentMethod,
          Currency.USD,
          subjectConversionRate,
          ADDRESS_ZERO,    // referrer
          ZERO,            // referrerFee
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );
        await orchestrator.connect(onRamperOtherAddress.wallet).signalIntent(params);

        await escrow.connect(offRamper.wallet).withdrawDeposit(subjectDepositId);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "DepositNotAcceptingIntents");
      });
    });

    describe("when the amount is less than the minimum intent amount", async () => {
      beforeEach(async () => {
        subjectAmount = usdc(5); // Less than minimum intent amount
      });

      it("should revert", async () => {
        await expect(subject()).to.be.reverted;
      });
    });

    describe("when the amount is more than the maximum intent amount", async () => {
      beforeEach(async () => {
        subjectAmount = usdc(250); // More than maximum intent amount
      });

      it("should revert", async () => {
        await expect(subject()).to.be.reverted;
      });
    });

    describe("when the to address is zero", async () => {
      beforeEach(async () => {
        subjectTo = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      });
    });

    describe("when the gating service signature is invalid", async () => {
      beforeEach(async () => {
        subjectGatingServiceSignature = "0x"; // Invalid signature
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "InvalidSignature");
      });

      describe("when the deposit doesn't has intent gating service", async () => {
        beforeEach(async () => {
          await escrow.connect(offRamper.wallet).createDeposit({
            token: usdcToken.address,
            amount: usdc(100),
            intentAmountRange: { min: usdc(10), max: usdc(200) },
            paymentMethods: [venmoPaymentMethod],
            paymentMethodData: [{
              intentGatingService: ADDRESS_ZERO,
              payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
              data: "0x"
            }],
            currencies: [
              [{ code: Currency.USD, minConversionRate: depositConversionRate }]
            ],
            delegate: offRamperDelegate.address,
            intentGuardian: ADDRESS_ZERO,  // intentGuardian
            retainOnEmpty: false
          });

          subjectDepositId = ONE;
        });

        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });
    });

    describe("when the gating service signature is expired", async () => {
      beforeEach(async () => {
        subjectSignatureExpiration = ONE_DAY_IN_SECONDS.sub(1);

        await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "SignatureExpired");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await orchestrator.connect(owner.wallet).pauseOrchestrator();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when referrer fee exceeds maximum", async () => {
      beforeEach(async () => {
        subjectReferrer = receiver.address;
        subjectReferrerFee = ether(0.06); // 6% exceeds 5% max
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "FeeExceedsMaximum");
      });
    });

    describe("when referrer is not set but fee is set", async () => {
      beforeEach(async () => {
        subjectReferrer = ADDRESS_ZERO;
        subjectReferrerFee = ether(0.01); // 1% fee without referrer
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "InvalidReferrerFeeConfiguration");
      });
    });

    describe("when referrer is set with valid fee", async () => {
      beforeEach(async () => {
        subjectReferrer = receiver.address;
        subjectReferrerFee = ether(0.02); // 2% fee
      });

      it("should create intent with referrer and fee", async () => {
        await subject();

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        const intentHash = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter
        );
        currentIntentCounter++;  // Increment after creating intent

        const intent = await orchestrator.getIntent(intentHash);
        expect(intent.referrer).to.eq(subjectReferrer);
        expect(intent.referrerFee).to.eq(subjectReferrerFee);
      });
    });
  });

  describe("#cancelIntent", async () => {
    let subjectIntentHash: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create a deposit first
      await usdcToken.connect(offRamper.wallet).approve(escrow.address, usdc(10000));
      const depositConversionRate = ether(1.01);

      await escrow.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: depositConversionRate }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,  // intentGuardian
        retainOnEmpty: false
      });

      // Signal an intent
      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        onRamper.address,
        venmoPaymentMethod,
        Currency.USD,
        depositConversionRate,
        ADDRESS_ZERO,
        ZERO,
        gatingService,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x"
      );

      await orchestrator.connect(onRamper.wallet).signalIntent(params);

      const currentTimestamp = await blockchain.getCurrentTimestamp();
      subjectIntentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );
      currentIntentCounter++;  // Increment after signalIntent
      subjectCaller = onRamper;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).cancelIntent(subjectIntentHash);
    }

    it("should cancel the intent and unlock funds in escrow", async () => {
      const preDeposit = await escrow.getDeposit(ZERO);

      await subject();

      const postDeposit = await escrow.getDeposit(ZERO);
      expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.add(usdc(50)));
      expect(postDeposit.outstandingIntentAmount).to.eq(ZERO);
    });

    it("should remove the intent from the intents mapping", async () => {
      await subject();

      const intent = await orchestrator.getIntent(subjectIntentHash);
      expect(intent.owner).to.eq(ADDRESS_ZERO);
    });

    it("should remove the intent from the intentMinAtSignal mapping", async () => {
      await subject();

      const minAtSignal = await orchestrator.getIntentMinAtSignal(subjectIntentHash);
      expect(minAtSignal).to.eq(ZERO);
    });

    it("should remove the intent from the accountIntents mapping", async () => {
      await subject();

      const accountIntents = await orchestrator.getAccountIntents(onRamper.address);
      expect(accountIntents).to.not.include(subjectIntentHash);
    });

    describe("when the intent does not exist", async () => {
      beforeEach(async () => {
        subjectIntentHash = ethers.utils.formatBytes32String("nonexistent");
      });

      it("should revert with IntentDoesNotExist", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "IntentNotFound");
      });
    });

    describe("when the caller is not the intent owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamperTwo;
      });

      it("should revert with SenderMustBeIntentOwner", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCaller");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await orchestrator.connect(owner.wallet).pauseOrchestrator();
      });

      it("should NOT revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });
  });

  describe("#fulfillIntent", async () => {
    let subjectProof: string;
    let subjectIntentHash: string;
    let subjectPostIntentDataData: string;
    let subjectCaller: Account;

    let intentAmount: BigNumber;
    let releaseAmount: BigNumber;
    let intentHash: string;
    let payeeDetails: BytesLike;
    let depositConversionRate: BigNumber;

    beforeEach(async () => {
      // Create a deposit first
      await usdcToken.connect(offRamper.wallet).approve(escrow.address, usdc(10000));
      depositConversionRate = ether(1.08);

      payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails"));
      const depositData = ethers.utils.defaultAbiCoder.encode(
        ["address"],
        [witness.address]
      );

      await escrow.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: payeeDetails,
          data: depositData
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: depositConversionRate }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      // Signal an intent
      intentAmount = usdc(50);
      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        intentAmount,
        onRamper.address,
        venmoPaymentMethod,
        Currency.USD,
        depositConversionRate,
        ADDRESS_ZERO,    // referrer
        ZERO,            // referrerFee
        gatingService,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x"
      );

      await orchestrator.connect(onRamper.wallet).signalIntent(params);

      const currentTimestamp = await blockchain.getCurrentTimestamp();
      intentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );
      currentIntentCounter++;  // Increment after signalIntent

      await verifier.setShouldVerifyPayment(true);

      subjectProof = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
        [usdc(50), currentTimestamp, payeeDetails, Currency.USD, intentHash]
      );
      subjectIntentHash = intentHash;
      subjectPostIntentDataData = "0x";
      subjectCaller = onRamper;
    });

    const buildVerificationDataForIntent = async (hash: string): Promise<string> => {
      const intent = await orchestrator.getIntent(hash);
      if (intent.owner === ADDRESS_ZERO) {
        return "0x";
      }
      const methodData = await escrow.getDepositPaymentMethodData(intent.depositId, intent.paymentMethod);
      return ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "uint256", "bytes32"],
        [intent.amount, intent.conversionRate, intent.timestamp, methodData.payeeDetails]
      );
    };

    async function subject(): Promise<any> {
      const verificationData = await buildVerificationDataForIntent(subjectIntentHash);
      return orchestrator.connect(subjectCaller.wallet).fulfillIntent({
        paymentProof: subjectProof,
        intentHash: subjectIntentHash,
        verificationData,
        postIntentHookData: subjectPostIntentDataData
      });
    }

    it("should transfer the correct amount to the on-ramper", async () => {
      const initialBalance = await usdcToken.balanceOf(onRamper.address);

      await subject();

      const finalBalance = await usdcToken.balanceOf(onRamper.address);
      const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
      expect(finalBalance.sub(initialBalance)).to.eq(releaseAmount);
    });

    it("should prune the intent", async () => {
      await subject();

      const intent = await orchestrator.getIntent(subjectIntentHash);

      expect(intent.owner).to.eq(ADDRESS_ZERO); // Intent should be deleted
    });

    describe("when verifier releaseAmount is below min-at-lock", async () => {
      beforeEach(async () => {
        // Craft a proof with a small offchain payment (5 USDC) so that
        // releaseAmount (amount / conversionRate) < deposit.min (10 USDC)
        const currentTimestamp = await blockchain.getCurrentTimestamp();
        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(5), currentTimestamp, payeeDetails, Currency.USD, intentHash]
        );
      });

      it("should revert with AmountBelowMin", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "AmountBelowMin");
      });
    });

    it("should update the deposit balances correctly", async () => {
      const preDeposit = await escrow.getDeposit(ZERO);

      await subject();

      const postDeposit = await escrow.getDeposit(ZERO);
      const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
      expect(postDeposit.outstandingIntentAmount).to.eq(preDeposit.outstandingIntentAmount.sub(usdc(50))); // 50 USDC is the intent amount
      // Not released amount is added to remaining deposits
      expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.add(usdc(50).sub(releaseAmount)));
    });

    it("should emit an IntentFulfilled event", async () => {
      const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
      await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
        intentHash,
        onRamper.address,
        releaseAmount,
        false
      );
    });

    describe("when the conversion rate is updated by depositor", async () => {
      beforeEach(async () => {
        // Incresases min rate from 1.08 to 1.09
        await escrow.connect(offRamper.wallet).setCurrencyMinRate(
          ZERO, venmoPaymentMethod, Currency.USD, ether(1.09)
        );
      });

      it("should still transfer the correct amount to the on-ramper", async () => {
        const initialBalance = await usdcToken.balanceOf(onRamper.address);

        await subject();

        const finalBalance = await usdcToken.balanceOf(onRamper.address);
        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        expect(finalBalance.sub(initialBalance)).to.eq(releaseAmount);
      });

      it("should update the deposit balances correctly", async () => {
        const preDeposit = await escrow.getDeposit(ZERO);

        await subject();

        const postDeposit = await escrow.getDeposit(ZERO);
        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        expect(postDeposit.outstandingIntentAmount).to.eq(preDeposit.outstandingIntentAmount.sub(usdc(50))); // 50 USDC is the intent amount
        // Not released amount is added to remaining deposits
        expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.add(usdc(50).sub(releaseAmount)));
      });
    });

    describe("when the fulfill intent zeroes out the deposit", async () => {
      beforeEach(async () => {
        const currentTimestamp1 = await blockchain.getCurrentTimestamp();
        const proof1 = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(60), currentTimestamp1, payeeDetails, Currency.USD, intentHash]
        );

        // Release 60 / 1.08 = 55.56 USDC > 50 USDC intent amount; so release full $50 to the payer
        const verificationData = await buildVerificationDataForIntent(intentHash);
        await orchestrator.connect(onRamper.wallet).fulfillIntent({
          paymentProof: proof1,
          intentHash: intentHash,
          verificationData,
          postIntentHookData: "0x"
        });

        // // Wait for 1 day
        // await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(10).toNumber());

        // Signal a new intent for $50
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO,
          intentAmount,
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,    // referrer
          ZERO,            // referrerFee
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        const currentTimestamp2 = await blockchain.getCurrentTimestamp();
        subjectIntentHash = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter
        );
        currentIntentCounter++;  // Increment after signalIntent
        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(60), currentTimestamp2, payeeDetails, Currency.USD, subjectIntentHash]
        );
      });

      it("should delete the deposit", async () => {
        await subject();

        const deposit = await escrow.getDeposit(ZERO);
        expect(deposit.depositor).to.eq(ADDRESS_ZERO);
      });

      it("should delete the deposit payment method data", async () => {
        await subject();

        const paymentMethodData = await escrow.getDepositPaymentMethodData(ZERO, venmoPaymentMethod);
        expect(paymentMethodData.intentGatingService).to.eq(ADDRESS_ZERO);
      });

      it("should delete deposit currency conversion data", async () => {
        await subject();

        const currencyConversionData = await escrow.getDepositCurrencyMinRate(ZERO, venmoPaymentMethod, Currency.USD);
        expect(currencyConversionData).to.eq(ZERO);
      });

      it("should emit a DepositClosed event", async () => {
        await expect(subject()).to.emit(escrow, "DepositClosed").withArgs(
          ZERO,
          offRamper.address
        );
      });
    });

    describe("when the manager fee is set for the deposit delegate", async () => {
      const managerFeePct = ether(0.03); // 3% manager fee

      beforeEach(async () => {
        // Cancel the existing intent first
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Delegate configures their fee and recipient (distinct from delegate)
        await orchestrator.connect(offRamperDelegate.wallet).setManagerFeeConfig(protocolFeeRecipient.address, managerFeePct);

        // Signal a new intent that will snapshot the manager fee terms
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO,
          intentAmount,
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,    // referrer
          ZERO,            // referrerFee
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        intentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;  // Increment after signalIntent

        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(50), currentTimestamp, payeeDetails, Currency.USD, intentHash]
        );
        subjectIntentHash = intentHash;
      });

      it("should transfer the correct amounts including manager fee", async () => {
        const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const initialManagerRecipientBalance = await usdcToken.balanceOf(protocolFeeRecipient.address);

        await subject();

        const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const finalManagerRecipientBalance = await usdcToken.balanceOf(protocolFeeRecipient.address);

        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        const fee = releaseAmount.mul(managerFeePct).div(ether(1)); // pct of release amount

        expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(releaseAmount.sub(fee));
        expect(finalManagerRecipientBalance.sub(initialManagerRecipientBalance)).to.eq(fee);
      });
    });

    describe("when the deposit is not delegated", async () => {
      const managerFeePct = ether(0.03); // 3% manager fee

      beforeEach(async () => {
        // Cancel the existing intent first
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Delegate configures their fee (should not apply to non-delegated deposits)
        await orchestrator.connect(offRamperDelegate.wallet).setManagerFeeConfig(protocolFeeRecipient.address, managerFeePct);

        // Create a new deposit WITHOUT a delegate
        await escrow.connect(offRamper.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(100),
          intentAmountRange: { min: usdc(10), max: usdc(200) },
          paymentMethods: [venmoPaymentMethod],
          paymentMethodData: [{
            intentGatingService: gatingService.address,
            payeeDetails: payeeDetails,
            data: ethers.utils.defaultAbiCoder.encode(["address"], [witness.address])
          }],
          currencies: [
            [{ code: Currency.USD, minConversionRate: depositConversionRate }]
          ],
          delegate: ADDRESS_ZERO,
          intentGuardian: ADDRESS_ZERO,
          retainOnEmpty: false
        });

        // Signal intent against the non-delegated deposit (depositId = 1)
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ONE, // depositId
          intentAmount,
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,    // referrer
          ZERO,            // referrerFee
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        intentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;  // Increment after signalIntent

        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(50), currentTimestamp, payeeDetails, Currency.USD, intentHash]
        );
        subjectIntentHash = intentHash;
      });

      it("should not charge a manager fee", async () => {
        const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const initialManagerRecipientBalance = await usdcToken.balanceOf(protocolFeeRecipient.address);

        await subject();

        const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const finalManagerRecipientBalance = await usdcToken.balanceOf(protocolFeeRecipient.address);

        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));

        expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(releaseAmount);
        expect(finalManagerRecipientBalance.sub(initialManagerRecipientBalance)).to.eq(ZERO);
      });
    });

    describe("when the protocol fee is set", async () => {
      beforeEach(async () => {
        await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.02)); // 2% fee
      });

      it("should transfer the correct amounts including fee", async () => {
        const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const initialFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);

        await subject();

        const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const finalFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);

        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        const fee = releaseAmount.mul(ether(0.02)).div(ether(1)); // 2% of release amount

        expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(releaseAmount.sub(fee));
        expect(finalFeeRecipientBalance.sub(initialFeeRecipientBalance)).to.eq(fee);
      });

      it("should emit an IntentFulfilled event with fee details", async () => {
        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        const fee = releaseAmount.mul(ether(0.02)).div(ether(1)); // 2% of release amount

        await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
          intentHash,
          onRamper.address,
          releaseAmount.sub(fee),
          false
        );
      });
    });

    describe("when referrer and referrer fee are set", async () => {
      beforeEach(async () => {
        // Cancel the existing intent first
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Create a new intent with referrer
        const gatingServiceSignature = await generateGatingServiceSignature(
          gatingService,
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          chainId.toString()
        );

        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO, // depositId
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          receiver.address,    // referrer
          ether(0.01),         // referrerFee - 1%
          null,                // passing null since we already have the signature
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );
        params.gatingServiceSignature = gatingServiceSignature;
        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        intentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;  // Increment after signalIntent

        // Update the subject variables
        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(50), currentTimestamp, payeeDetails, Currency.USD, intentHash]
        );
        subjectIntentHash = intentHash;
      });

      it("should transfer the correct amounts including referrer fee", async () => {
        const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const initialReferrerBalance = await usdcToken.balanceOf(receiver.address);

        await subject();

        const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const finalReferrerBalance = await usdcToken.balanceOf(receiver.address);

        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        const referrerFee = releaseAmount.mul(ether(0.01)).div(ether(1)); // 1% of release amount

        expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(releaseAmount.sub(referrerFee));
        expect(finalReferrerBalance.sub(initialReferrerBalance)).to.eq(referrerFee);
      });

      it("should emit an IntentFulfilled event with referrer fee details", async () => {
        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        const referrerFee = releaseAmount.mul(ether(0.01)).div(ether(1)); // 1% of release amount

        await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
          intentHash,
          onRamper.address,
          releaseAmount.sub(referrerFee),        // Amount transferred to the on-ramper
          false
        );
      });

      describe("when protocol fee is also set", async () => {
        beforeEach(async () => {
          await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.02)); // 2% fee
        });

        it("should transfer the correct amounts including both protocol and referrer fees", async () => {
          const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
          const initialFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);
          const initialReferrerBalance = await usdcToken.balanceOf(receiver.address);

          await subject();

          const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
          const finalFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);
          const finalReferrerBalance = await usdcToken.balanceOf(receiver.address);

          const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
          const protocolFee = releaseAmount.mul(ether(0.02)).div(ether(1)); // 2% of release amount
          const referrerFee = releaseAmount.mul(ether(0.01)).div(ether(1)); // 1% of release amount
          const totalFees = protocolFee.add(referrerFee);

          expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(releaseAmount.sub(totalFees));
          expect(finalFeeRecipientBalance.sub(initialFeeRecipientBalance)).to.eq(protocolFee);
          expect(finalReferrerBalance.sub(initialReferrerBalance)).to.eq(referrerFee);
        });

        it("should emit an IntentFulfilled event with correct fee details", async () => {
          const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
          const protocolFee = releaseAmount.mul(ether(0.02)).div(ether(1)); // 2% of release amount
          const referrerFee = releaseAmount.mul(ether(0.01)).div(ether(1)); // 1% of release amount
          const totalFees = protocolFee.add(referrerFee);

          await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
            intentHash,
            onRamper.address,
            releaseAmount.sub(totalFees),
            false
          );
        });
      });
    });

    describe("when the intent does not exist", async () => {
      beforeEach(async () => {
        subjectIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("invalid"));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "IntentNotFound");
      });
    });

    describe("when the intent hash is invalid", async () => {
      beforeEach(async () => {
        const currentTimestamp = await blockchain.getCurrentTimestamp();

        subjectIntentHash = intentHash;
        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(50), currentTimestamp, payeeDetails, Currency.USD, ZERO_BYTES32]
        );

        await verifier.setShouldVerifyPayment(false);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "HashMismatch");
      });
    });

    describe("when the payment method is removed post signalIntent", async () => {
      beforeEach(async () => {
        await paymentVerifierRegistry.connect(owner.wallet).removePaymentMethod(venmoPaymentMethod);
      });

      it("should revert on fulfillIntent", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "PaymentMethodDoesNotExist");
      });
    });

    describe("when the payment verification fails", async () => {
      beforeEach(async () => {
        await verifier.setShouldReturnFalse(true);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "PaymentVerificationFailed");
      });
    });

    describe("when the orchestrator is paused", async () => {
      beforeEach(async () => {
        await orchestrator.connect(owner.wallet).pauseOrchestrator();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });

      describe("when the orchestrator is unpaused", async () => {
        beforeEach(async () => {
          await orchestrator.connect(owner.wallet).unpauseOrchestrator();
        });

        it("should revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });
    });

    describe("when a postIntentHook is used", async () => {
      let hookTargetAddress: Address;
      let subjectHookAddress: Address;

      const signalIntentWithHook = async (hookAddress: Address, hookTargetRecipientAddress: Address) => {
        const signalIntentDataForHook = ethers.utils.defaultAbiCoder.encode(["address"], [hookTargetRecipientAddress]);

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        const signatureExpiration = currentTimestamp.add(ONE_DAY_IN_SECONDS).add(10);

        // Create a new intent with post intent hook action
        const gatingServiceSignatureForHook = await generateGatingServiceSignature(
          gatingService,
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          chainId.toString(),
          signatureExpiration
        );

        // First cancel the existing intent
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Signal an intent that uses the postIntentHookMock
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,
          ZERO,
          null, // passing null since we already have the signature
          chainId.toString(),
          hookAddress,    // use the hook address passed in
          signalIntentDataForHook,
          signatureExpiration
        );
        // Override the signature since we generated it manually
        params.gatingServiceSignature = gatingServiceSignatureForHook;
        await orchestrator.connect(onRamper.wallet).signalIntent(params);
        const intentTimestamp = await blockchain.getCurrentTimestamp();
        intentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;

        return { intentHash, currentIntentCounter, intentTimestamp };
      }

      beforeEach(async () => {
        hookTargetAddress = receiver.address;
        const { intentHash, currentIntentCounter, intentTimestamp } = await signalIntentWithHook(
          postIntentHookMock.address,
          hookTargetAddress
        );

        // Set the verifier to verify payment
        await verifier.setShouldVerifyPayment(true);

        // Prepare the proof and processor for the onRamp function
        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(50), intentTimestamp, payeeDetails, Currency.USD, intentHash]
        );
        subjectIntentHash = intentHash;
        subjectCaller = onRamper;
        subjectPostIntentDataData = "0x"; // Still keep it empty
        subjectHookAddress = postIntentHookMock.address;
      });

      it("should transfer funds to the hook's target address, not the intent.to address", async () => {
        const initialTargetAddressBalance = await usdcToken.balanceOf(hookTargetAddress);
        const initialIntentToBalance = await usdcToken.balanceOf(onRamper.address);
        const initialEscrowBalance = await usdcToken.balanceOf(escrow.address);

        await subject();

        const finalTargetAddressBalance = await usdcToken.balanceOf(hookTargetAddress);
        const finalIntentToBalance = await usdcToken.balanceOf(onRamper.address);
        const finalEscrowBalance = await usdcToken.balanceOf(escrow.address);

        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        expect(finalTargetAddressBalance.sub(initialTargetAddressBalance)).to.eq(releaseAmount);
        expect(finalIntentToBalance.sub(initialIntentToBalance)).to.eq(ZERO); // onRamper should not receive funds directly
        expect(initialEscrowBalance.sub(finalEscrowBalance)).to.eq(releaseAmount); // Escrow pays out the 50 USDC
      });

      it("should emit IntentFulfilled event with original intent.to address but funds routed by hook", async () => {
        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
          subjectIntentHash,    // Hash of the intent fulfilled
          postIntentHookMock.address,     // Post intent hook address
          releaseAmount,             // Amount transferred (after 0 fees in this case)
          false
        );
      });

      it("should reset token approval to zero after hook execution", async () => {
        const initialAllowance = await usdcToken.allowance(orchestrator.address, postIntentHookMock.address);
        expect(initialAllowance).to.eq(ZERO);

        // Execute fulfillIntent which will approve and then reset
        await subject();

        const finalAllowance = await usdcToken.allowance(orchestrator.address, postIntentHookMock.address);
        expect(finalAllowance).to.eq(ZERO);
      });

      describe("when protocol fee is set with a hook", async () => {
        beforeEach(async () => {
          await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.02)); // 2% fee
        });

        it("should transfer (intent amount - fee) to hook's target and fee to recipient", async () => {
          const initialHookTargetBalance = await usdcToken.balanceOf(hookTargetAddress);
          const initialFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);
          const initialEscrowBalance = await usdcToken.balanceOf(escrow.address);

          await subject();

          const finalHookTargetBalance = await usdcToken.balanceOf(hookTargetAddress);
          const finalFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);
          const finalEscrowBalance = await usdcToken.balanceOf(escrow.address);

          const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
          const fee = releaseAmount.mul(ether(0.02)).div(ether(1)); // 2% of release amount
          expect(finalHookTargetBalance.sub(initialHookTargetBalance)).to.eq(releaseAmount.sub(fee)); // 49 USDC
          expect(finalFeeRecipientBalance.sub(initialFeeRecipientBalance)).to.eq(fee); // 1 USDC
          expect(initialEscrowBalance.sub(finalEscrowBalance)).to.eq(releaseAmount); // Escrow still pays out total of 50
        });

        it("should emit IntentFulfilled with correct fee details when hook is used", async () => {
          const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
          const fee = releaseAmount.mul(ether(0.02)).div(ether(1)); // 2% of release amount
          await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
            subjectIntentHash,
            postIntentHookMock.address,     // Post intent hook address
            releaseAmount.sub(fee),    // Amount transferred to hook's destination
            false
          );
        });
      });

      describe("when a partial-pull postIntentHook is used", async () => {
        beforeEach(async () => {
          hookTargetAddress = receiver.address;
          const { intentHash, currentIntentCounter, intentTimestamp } = await signalIntentWithHook(
            partialPostIntentHook.address,  // Use the partial-pull hook
            hookTargetAddress
          );

          // Set the verifier to verify payment
          await verifier.setShouldVerifyPayment(true);

          // Prepare the proof and processor for the onRamp function
          subjectProof = ethers.utils.defaultAbiCoder.encode(
            ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
            [usdc(50), intentTimestamp, payeeDetails, Currency.USD, intentHash]
          );
          subjectIntentHash = intentHash;
          subjectCaller = onRamper;
          subjectPostIntentDataData = "0x"; // Still keep it empty
          subjectHookAddress = partialPostIntentHook.address;
        });

        it("should revert if the hook fails to pull the full net amount", async () => {
          await expect(subject()).to.be.revertedWith("PostIntentHook: must pull exact netAmount");
        });
      });

      describe("when a push-to-orchestrator postIntentHook is used", async () => {
        beforeEach(async () => {
          hookTargetAddress = receiver.address;
          const { intentHash, currentIntentCounter, intentTimestamp } = await signalIntentWithHook(
            pushPostIntentHook.address,  // Use the push-to-orchestrator hook
            hookTargetAddress
          );

          // Set the verifier to verify payment
          await verifier.setShouldVerifyPayment(true);

          // Send some USDC to the hook
          await usdcToken.transfer(pushPostIntentHook.address, usdc(10));

          // Prepare the proof and processor for the onRamp function
          subjectProof = ethers.utils.defaultAbiCoder.encode(
            ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
            [usdc(50), intentTimestamp, payeeDetails, Currency.USD, intentHash]
          );
          subjectIntentHash = intentHash;
          subjectCaller = onRamper;
          subjectPostIntentDataData = "0x"; // Still keep it empty
          subjectHookAddress = pushPostIntentHook.address;
        });

        it("should revert if the hook fails to pull the full net amount", async () => {
          await expect(subject()).to.be.revertedWith("PostIntentHook: unexpected balance increase");
        });
      });
    });

    describe("when a partial payment is made", async () => {
      beforeEach(async () => {
        // Payment is only 40 USDC instead of the expected 50 USDC
        const currentTimestamp = await blockchain.getCurrentTimestamp();
        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "string", "bytes32", "bytes32"],
          [usdc(40), currentTimestamp, payeeDetails, Currency.USD, intentHash]
        );

        // Update the mock verifier to not check the payment amount (allow partial payments)
        await verifier.setShouldVerifyPayment(false);
      });

      it("should transfer the partial amount to the on-ramper", async () => {
        const initialBalance = await usdcToken.balanceOf(onRamper.address);

        await subject();

        const finalBalance = await usdcToken.balanceOf(onRamper.address);
        // With conversion rate of 1.08, and payment of 40 USDC:
        // Release amount = 40 / 1.08 = 37.03 USDC
        const expectedAmount = usdc(40).mul(ether(1)).div(depositConversionRate);
        expect(finalBalance.sub(initialBalance)).to.eq(expectedAmount);
      });

      it("should return unused funds to the deposit", async () => {
        const preDeposit = await escrow.getDeposit(ZERO);

        await subject();

        const postDeposit = await escrow.getDeposit(ZERO);
        // Intent was for 50 USDC, but only 37.03 USDC released
        const releasedAmount = usdc(40).mul(ether(1)).div(depositConversionRate);
        const returnedAmount = usdc(50).sub(releasedAmount);

        expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.add(returnedAmount));
        expect(postDeposit.outstandingIntentAmount).to.eq(preDeposit.outstandingIntentAmount.sub(usdc(50)));
      });

      it("should emit an IntentFulfilled event with the partial amount", async () => {
        const releasedAmount = usdc(40).mul(ether(1)).div(depositConversionRate);

        await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
          intentHash,
          onRamper.address,
          releasedAmount,
          false
        );
      });

      describe("when protocol fee is set", async () => {
        beforeEach(async () => {
          await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.02)); // 2% fee
        });

        it("should calculate fees based on the partial release amount", async () => {
          const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
          const initialFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);

          await subject();

          const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
          const finalFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);

          const releasedAmount = usdc(40).mul(ether(1)).div(depositConversionRate);
          const fee = releasedAmount.mul(ether(0.02)).div(ether(1)); // 2% of released amount

          expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(releasedAmount.sub(fee));
          expect(finalFeeRecipientBalance.sub(initialFeeRecipientBalance)).to.eq(fee);
        });
      });
    });

    describe("when a malicious hook attempts reentrancy", async () => {
      let reentrantHook: ReentrantPostIntentHook;
      let maliciousIntentHash: string;

      beforeEach(async () => {
        // Deploy the malicious reentrancy hook
        reentrantHook = await deployer.deployReentrantPostIntentHook(
          usdcToken.address,
          orchestrator.address
        );

        // Whitelist the malicious hook (simulating it passed review)
        await postIntentHookRegistry.addPostIntentHook(reentrantHook.address);

        // Cancel existing intent and create new one with malicious hook
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Create intent with the malicious hook
        const currentTimestamp = await blockchain.getCurrentTimestamp();
        const signatureExpiration = currentTimestamp.add(ONE_DAY_IN_SECONDS).add(10);
        const gatingServiceSignature = await generateGatingServiceSignature(
          gatingService,
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          chainId.toString(),
          signatureExpiration
        );

        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,
          ZERO,
          null,
          chainId.toString(),
          reentrantHook.address,  // Use malicious hook
          "0x",
          signatureExpiration
        );
        params.gatingServiceSignature = gatingServiceSignature;

        await orchestrator.connect(onRamper.wallet).signalIntent(params);
        maliciousIntentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;

        // Prepare fulfill params for the reentrancy attempt
        const currentTimestamp2 = await blockchain.getCurrentTimestamp();
        const fulfillProof = ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
          [usdc(50), currentTimestamp2, payeeDetails, Currency.USD, maliciousIntentHash]
        );

        // Store params in the malicious hook for reentrancy attempt
        await reentrantHook.setFulfillParams(
          fulfillProof,
          maliciousIntentHash,
          "0x",
          "0x"
        );

        // Update subject parameters for this test
        subjectProof = fulfillProof;
        subjectIntentHash = maliciousIntentHash;
      });

      it("should block reentrancy attempt and emit failed attempt event", async () => {
        // The transaction succeeds but the reentrancy attempt fails
        const tx = await subject();

        // Check that the reentrancy attempt was blocked (emitted false)
        await expect(tx)
          .to.emit(reentrantHook, "ReentrancyAttempted")
          .withArgs(false);

        // Verify the main intent was still fulfilled successfully
        const intent = await orchestrator.getIntent(maliciousIntentHash);
        expect(intent.owner).to.equal(ADDRESS_ZERO); // Intent was pruned

        // Verify hook was called and attempted reentrancy
        const attempts = await reentrantHook.getReentrancyAttempts();
        expect(attempts).to.equal(ONE);
      });

      it("should complete the original fulfillment despite blocked reentrancy", async () => {
        const initialBalance = await usdcToken.balanceOf(onRamper.address);

        // Execute the transaction
        const tx = await subject();

        // Verify the reentrancy was attempted but failed
        await expect(tx)
          .to.emit(reentrantHook, "ReentrancyAttempted")
          .withArgs(false);

        // Verify the original intent was fulfilled successfully
        const finalBalance = await usdcToken.balanceOf(onRamper.address);
        const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
        expect(finalBalance.sub(initialBalance)).to.eq(releaseAmount);

        // Verify intent was pruned (successful completion)
        const intent = await orchestrator.getIntent(maliciousIntentHash);
        expect(intent.owner).to.equal(ADDRESS_ZERO);

        // Verify deposit state was updated correctly
        const deposit = await escrow.getDeposit(ZERO);
        expect(deposit.outstandingIntentAmount).to.equal(ZERO);
      });

      describe("when reentrancy protection is disabled in hook", async () => {
        beforeEach(async () => {
          // Disable reentrancy attempt in hook to test normal execution
          await reentrantHook.setAttemptReentry(false);
        });

        it("should execute normally without reentrancy attempt", async () => {
          const initialBalance = await usdcToken.balanceOf(onRamper.address);

          await subject();

          const finalBalance = await usdcToken.balanceOf(onRamper.address);
          const releaseAmount = usdc(50).mul(ether(1)).div(ether(1.08));
          expect(finalBalance.sub(initialBalance)).to.eq(releaseAmount);

          // Verify intent was pruned
          const intent = await orchestrator.getIntent(maliciousIntentHash);
          expect(intent.owner).to.equal(ADDRESS_ZERO);

          // Verify hook was called
          const attempts = await reentrantHook.getReentrancyAttempts();
          expect(attempts).to.equal(ONE);
        });
      });
    });

    describe("when the contract is paused", async () => {
      beforeEach(async () => {
        await orchestrator.connect(owner.wallet).pauseOrchestrator();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });

      describe("when the contract is unpaused", async () => {
        beforeEach(async () => {
          await orchestrator.connect(owner.wallet).unpauseOrchestrator();
        });
      });
    });
  });

  describe("#releaseFundsToPayer", async () => {
    let subjectIntentHash: string;
    let subjectCaller: Account;

    let intentAmount: BigNumber;
    let payeeDetails: BytesLike;
    let intentHash: string;
    let depositConversionRate: BigNumber;

    beforeEach(async () => {
      // Create a deposit first
      await usdcToken.connect(offRamper.wallet).approve(escrow.address, usdc(10000));
      depositConversionRate = ether(1.08);

      payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("12345678@revolut.me"));
      await escrow.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [{
          payeeDetails: payeeDetails,
          intentGatingService: gatingService.address,
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: depositConversionRate }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      intentAmount = usdc(50);

      // Signal an intent
      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        intentAmount,
        onRamper.address,
        venmoPaymentMethod,
        Currency.USD,
        depositConversionRate,
        ADDRESS_ZERO,
        ZERO,
        gatingService,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x"
      );

      await orchestrator.connect(onRamper.wallet).signalIntent(params);

      const currentTimestamp = await blockchain.getCurrentTimestamp();
      intentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );
      currentIntentCounter++;  // Increment after signalIntent

      subjectIntentHash = intentHash;
      subjectCaller = offRamper; // Depositor
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).releaseFundsToPayer(
        subjectIntentHash
      );
    }

    it("should transfer the full intent amount to the payer", async () => {
      const preBalance = await usdcToken.balanceOf(onRamper.address);

      await subject();

      const postBalance = await usdcToken.balanceOf(onRamper.address);
      expect(postBalance.sub(preBalance)).to.eq(intentAmount);
    });

    it("should delete the intent from the intents and account intents mapping", async () => {
      await subject();

      const intent = await orchestrator.getIntent(subjectIntentHash);
      expect(intent.owner).to.eq(ADDRESS_ZERO);

      const accountIntents = await orchestrator.getAccountIntents(onRamper.address);
      expect(accountIntents.length).to.eq(0);
    });

    it("should correctly update state on the escrow", async () => {
      const preDeposit = await escrow.getDeposit(ZERO);
      const preRemainingDeposits = preDeposit.remainingDeposits;
      const preOutstandingIntentAmount = preDeposit.outstandingIntentAmount;

      await subject();

      const postDeposit = await escrow.getDeposit(ZERO);
      // When releaseFundsToPayer is called, funds are transferred out of escrow
      // so remainingDeposits stays the same and outstandingIntentAmount is reduced
      const expectedPostRemainingDeposits = preRemainingDeposits;
      const expectedPostOutstandingIntentAmount = preOutstandingIntentAmount.sub(intentAmount);

      expect(postDeposit.remainingDeposits).to.eq(expectedPostRemainingDeposits);
      expect(postDeposit.outstandingIntentAmount).to.eq(expectedPostOutstandingIntentAmount);
    });

    it("should emit an IntentFulfilled event", async () => {
      await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
        subjectIntentHash,
        onRamper.address,
        intentAmount,
        true  // manual release
      );
    });

    describe("when the manager fee is set for the deposit delegate", async () => {
      const managerFeePct = ether(0.03); // 3% manager fee

      beforeEach(async () => {
        // Cancel the existing intent first
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Delegate configures their fee and recipient (distinct from delegate)
        await orchestrator.connect(offRamperDelegate.wallet).setManagerFeeConfig(protocolFeeRecipient.address, managerFeePct);

        // Signal a new intent that will snapshot the manager fee terms
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO,
          intentAmount,
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,    // referrer
          ZERO,            // referrerFee
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        intentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;  // Increment after signalIntent

        subjectIntentHash = intentHash;
      });

      it("should transfer the correct amounts including manager fee", async () => {
        const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const initialManagerRecipientBalance = await usdcToken.balanceOf(protocolFeeRecipient.address);

        await subject();

        const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const finalManagerRecipientBalance = await usdcToken.balanceOf(protocolFeeRecipient.address);

        const fee = intentAmount.mul(managerFeePct).div(ether(1)); // pct of release amount

        expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(intentAmount.sub(fee));
        expect(finalManagerRecipientBalance.sub(initialManagerRecipientBalance)).to.eq(fee);
      });
    });

    describe("when the deposit is not delegated", async () => {
      const managerFeePct = ether(0.03); // 3% manager fee

      beforeEach(async () => {
        // Cancel the existing intent first
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Delegate configures their fee (should not apply to non-delegated deposits)
        await orchestrator.connect(offRamperDelegate.wallet).setManagerFeeConfig(protocolFeeRecipient.address, managerFeePct);

        // Create a new deposit WITHOUT a delegate
        await escrow.connect(offRamper.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(100),
          intentAmountRange: { min: usdc(10), max: usdc(200) },
          paymentMethods: [venmoPaymentMethod],
          paymentMethodData: [{
            payeeDetails: payeeDetails,
            intentGatingService: gatingService.address,
            data: "0x"
          }],
          currencies: [
            [{ code: Currency.USD, minConversionRate: depositConversionRate }]
          ],
          delegate: ADDRESS_ZERO,
          intentGuardian: ADDRESS_ZERO,
          retainOnEmpty: false
        });

        // Signal intent against the non-delegated deposit (depositId = 1)
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ONE, // depositId
          intentAmount,
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,    // referrer
          ZERO,            // referrerFee
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        intentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;  // Increment after signalIntent

        subjectIntentHash = intentHash;
      });

      it("should not charge a manager fee", async () => {
        const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const initialManagerRecipientBalance = await usdcToken.balanceOf(protocolFeeRecipient.address);

        await subject();

        const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const finalManagerRecipientBalance = await usdcToken.balanceOf(protocolFeeRecipient.address);

        expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(intentAmount);
        expect(finalManagerRecipientBalance.sub(initialManagerRecipientBalance)).to.eq(ZERO);
      });
    });

    describe("when the fulfill intent zeroes out the deposit", async () => {
      beforeEach(async () => {
        await subject(); // release the full $50 to the payer

        // Signal a new intent for $50
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO,
          intentAmount,
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,    // referrer
          ZERO,            // referrerFee
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        const intentHash2 = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter
        );
        currentIntentCounter++;  // Increment after signalIntent

        subjectIntentHash = intentHash2;
      });

      it("should delete the deposit", async () => {
        await subject();

        const deposit = await escrow.getDeposit(ZERO);
        expect(deposit.depositor).to.eq(ADDRESS_ZERO);
      });

      it("should delete the deposit payment method data", async () => {
        await subject();

        const paymentMethodData = await escrow.getDepositPaymentMethodData(ZERO, venmoPaymentMethod);
        expect(paymentMethodData.intentGatingService).to.eq(ADDRESS_ZERO);
      });

      it("should delete deposit currency conversion data", async () => {
        await subject();

        const currencyConversionData = await escrow.getDepositCurrencyMinRate(ZERO, venmoPaymentMethod, Currency.USD);
        expect(currencyConversionData).to.eq(ZERO);
      });

      it("should emit a DepositClosed event", async () => {
        await expect(subject()).to.emit(escrow, "DepositClosed").withArgs(
          ZERO,
          offRamper.address
        );
      });
    });

    describe("when the protocol fee is set", async () => {
      beforeEach(async () => {
        await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.02)); // 2% fee
      });

      it("should transfer the correct amounts including fee", async () => {
        const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const initialFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);

        await subject();

        const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const finalFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);

        const fee = intentAmount.mul(ether(0.02)).div(ether(1)); // 2% of intent amount

        expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(intentAmount.sub(fee));
        expect(finalFeeRecipientBalance.sub(initialFeeRecipientBalance)).to.eq(fee);
      });

      it("should emit an IntentFulfilled event with fee details", async () => {
        const fee = intentAmount.mul(ether(0.02)).div(ether(1)); // 2% of intent amount

        await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
          intentHash,
          onRamper.address,
          intentAmount.sub(fee),
          true  // manual release
        );
      });
    });

    describe("when referrer and referrer fee are set", async () => {
      beforeEach(async () => {
        // Cancel the existing intent first
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Create a new intent with referrer
        const gatingServiceSignature = await generateGatingServiceSignature(
          gatingService,
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          chainId.toString()
        );

        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO, // depositId
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          receiver.address,    // referrer
          ether(0.01),         // referrerFee - 1%
          null,                // passing null since we already have the signature
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );
        params.gatingServiceSignature = gatingServiceSignature;
        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        intentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;  // Increment after signalIntent

        // Update the subject variables
        subjectIntentHash = intentHash;
      });

      it("should transfer the correct amounts including referrer fee", async () => {
        const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const initialReferrerBalance = await usdcToken.balanceOf(receiver.address);

        await subject();

        const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
        const finalReferrerBalance = await usdcToken.balanceOf(receiver.address);

        const referrerFee = intentAmount.mul(ether(0.01)).div(ether(1)); // 1% of intent amount

        expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(intentAmount.sub(referrerFee));
        expect(finalReferrerBalance.sub(initialReferrerBalance)).to.eq(referrerFee);
      });

      it("should emit an IntentFulfilled event with referrer fee details", async () => {
        const referrerFee = intentAmount.mul(ether(0.01)).div(ether(1)); // 1% of intent amount

        await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
          intentHash,
          onRamper.address,
          intentAmount.sub(referrerFee),        // Amount transferred to the on-ramper
          true  // manual release
        );
      });

      describe("when protocol fee is also set", async () => {
        beforeEach(async () => {
          await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.02)); // 2% fee
        });

        it("should transfer the correct amounts including both protocol and referrer fees", async () => {
          const initialOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
          const initialFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);
          const initialReferrerBalance = await usdcToken.balanceOf(receiver.address);

          await subject();

          const finalOnRamperBalance = await usdcToken.balanceOf(onRamper.address);
          const finalFeeRecipientBalance = await usdcToken.balanceOf(feeRecipient.address);
          const finalReferrerBalance = await usdcToken.balanceOf(receiver.address);

          const protocolFee = intentAmount.mul(ether(0.02)).div(ether(1)); // 2% of intent amount
          const referrerFee = intentAmount.mul(ether(0.01)).div(ether(1)); // 1% of intent amount
          const totalFees = protocolFee.add(referrerFee);

          expect(finalOnRamperBalance.sub(initialOnRamperBalance)).to.eq(intentAmount.sub(totalFees));
          expect(finalFeeRecipientBalance.sub(initialFeeRecipientBalance)).to.eq(protocolFee);
          expect(finalReferrerBalance.sub(initialReferrerBalance)).to.eq(referrerFee);
        });

        it("should emit an IntentFulfilled event with correct fee details", async () => {
          const protocolFee = intentAmount.mul(ether(0.02)).div(ether(1)); // 2% of intent amount
          const referrerFee = intentAmount.mul(ether(0.01)).div(ether(1)); // 1% of intent amount
          const totalFees = protocolFee.add(referrerFee);

          await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
            intentHash,
            onRamper.address,
            intentAmount.sub(totalFees),
            true  // manual release
          );
        });
      });
    });

    describe("when the intent does not exist", async () => {
      beforeEach(async () => {
        subjectIntentHash = ZERO_BYTES32;
      });

      it("should revert with IntentDoesNotExist", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "IntentNotFound");
      });
    });

    describe("when a postIntentHook is used", async () => {
      let hookTargetAddress: Address;

      beforeEach(async () => {
        hookTargetAddress = receiver.address;
        const signalIntentDataForHook = ethers.utils.defaultAbiCoder.encode(["address"], [hookTargetAddress]);

        // Create a new intent with post intent hook action
        // Get expiration timestamp for signature
        const currentBlock = await ethers.provider.getBlock("latest");
        const signatureExpiration = BigNumber.from(currentBlock.timestamp + 86400); // 1 day from now

        const gatingServiceSignatureForHook = await generateGatingServiceSignature(
          gatingService,
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          chainId.toString(),
          signatureExpiration
        );

        // First cancel the existing intent
        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHash);

        // Signal an intent that uses the postIntentHookMock
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,
          ZERO,
          null, // passing null since we already have the signature
          chainId.toString(),
          postIntentHookMock.address,
          signalIntentDataForHook,
          signatureExpiration
        );
        // Override the signature since we generated it manually
        params.gatingServiceSignature = gatingServiceSignatureForHook;
        await orchestrator.connect(onRamper.wallet).signalIntent(params);
        const currentTimestamp = await blockchain.getCurrentTimestamp();
        intentHash = calculateIntentHash(orchestrator.address, currentIntentCounter);
        currentIntentCounter++;  // Increment after signalIntent

        subjectIntentHash = intentHash;
      });

      it("should STILL transfer funds to the intent.to address", async () => {
        const preBalance = await usdcToken.balanceOf(onRamper.address);

        await subject();

        const postBalance = await usdcToken.balanceOf(onRamper.address);
        expect(postBalance.sub(preBalance)).to.eq(intentAmount);
      });

      describe("when protocol fee is set with a hook", async () => {
        beforeEach(async () => {
          await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.02)); // 2% fee
        });

        it("should transfer (intent amount - fee) to the intent.to address", async () => {
          const initialIntentToBalance = await usdcToken.balanceOf(onRamper.address);

          await subject();

          const finalIntentToBalance = await usdcToken.balanceOf(onRamper.address);

          const fee = intentAmount.mul(ether(0.02)).div(ether(1)); // 2% of intent amount
          expect(finalIntentToBalance.sub(initialIntentToBalance)).to.eq(intentAmount.sub(fee)); // 49 USDC
        });

        it("should emit IntentFulfilled with correct fee details when hook is used", async () => {
          const fee = intentAmount.mul(ether(0.02)).div(ether(1)); // 2% of intent amount
          await expect(subject()).to.emit(orchestrator, "IntentFulfilled").withArgs(
            subjectIntentHash,
            onRamper.address,     // Original intent.to
            intentAmount.sub(fee),    // Amount transferred to hook's destination
            true  // manual release
          );
        });
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = onRamperTwo;
      });

      it("should revert with CallerMustBeDepositor", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCaller");
      });
    });
  });

  // Escrow Functions

  describe("#pruneIntents", async () => {
    let subjectIntents: string[];
    let subjectCaller: Address;

    let depositId: BigNumber;
    let intentHashes: string[];
    let intentAmounts: BigNumber[];

    beforeEach(async () => {
      // Create a deposit
      await usdcToken.connect(offRamper.wallet).approve(escrow.address, usdc(10000));
      await escrow.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(300),
        intentAmountRange: { min: usdc(10), max: usdc(100) },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: ether(1.01) }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      // Enable multiple intents
      await orchestrator.connect(owner.wallet).setAllowMultipleIntents(true);

      depositId = ZERO;
      intentHashes = [];
      intentAmounts = [usdc(50), usdc(60), usdc(70)];

      // Signal multiple intents
      for (let i = 0; i < 3; i++) {
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          depositId,
          intentAmounts[i],
          onRamper.address,
          venmoPaymentMethod,
          Currency.USD,
          ether(1.02),
          ADDRESS_ZERO,
          ZERO,
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        const intentHash = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter
        );
        currentIntentCounter++;  // Increment after signalIntent
        intentHashes.push(intentHash);

        // Increase time by 1 second
        await blockchain.increaseTimeAsync(1);
      }

      subjectIntents = intentHashes;
      subjectCaller = escrow.address;
    });

    async function subject(): Promise<any> {
      // Impersonate the escrow so msg.sender == escrow.address
      await ethers.provider.send("hardhat_impersonateAccount", [subjectCaller]);
      // Fund the escrow address for gas
      await ethers.provider.send("hardhat_setBalance", [
        subjectCaller,
        "0x21e19e0c9bab2400000" // 1000 ETH
      ]);
      const escrowSigner = await ethers.getSigner(subjectCaller);
      const tx = await orchestrator.connect(escrowSigner).pruneIntents(subjectIntents);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [subjectCaller]);
      return tx;
    }

    it("should delete the intents from the intents mapping", async () => {
      // Verify intents exist before pruning
      for (const intentHash of intentHashes) {
        const intent = await orchestrator.getIntent(intentHash);
        expect(intent.owner).to.eq(onRamper.address);
      }

      await subject();

      // Verify intents are deleted after pruning
      for (const intentHash of intentHashes) {
        const intent = await orchestrator.getIntent(intentHash);
        expect(intent.owner).to.eq(ADDRESS_ZERO);
      }
    });

    it("should remove intents from the accountIntents mapping", async () => {
      const preAccountIntents = await orchestrator.getAccountIntents(onRamper.address);
      expect(preAccountIntents.length).to.eq(3);
      for (const intentHash of intentHashes) {
        expect(preAccountIntents).to.include(intentHash);
      }

      await subject();

      const postAccountIntents = await orchestrator.getAccountIntents(onRamper.address);
      expect(postAccountIntents.length).to.eq(0);
    });

    it("should emit IntentPruned events for each intent", async () => {
      const tx = await subject();

      for (let i = 0; i < intentHashes.length; i++) {
        await expect(tx).to.emit(orchestrator, "IntentPruned").withArgs(
          intentHashes[i]
        );
      }
    });

    describe("when some intents have zero bytes32 value", async () => {
      beforeEach(async () => {
        subjectIntents = [intentHashes[0], ZERO_BYTES32, intentHashes[2]];
      });

      it("should only prune non-zero intents", async () => {
        await subject();

        // First intent should be pruned
        const intent0 = await orchestrator.getIntent(intentHashes[0]);
        expect(intent0.owner).to.eq(ADDRESS_ZERO);

        // Second intent should still exist
        const intent1 = await orchestrator.getIntent(intentHashes[1]);
        expect(intent1.owner).to.eq(onRamper.address);

        // Third intent should be pruned
        const intent2 = await orchestrator.getIntent(intentHashes[2]);
        expect(intent2.owner).to.eq(ADDRESS_ZERO);
      });
    });

    describe("when intents don't exist", async () => {
      beforeEach(async () => {
        // Create some non-existent intent hashes
        subjectIntents = [
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes("nonexistent1")),
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes("nonexistent2"))
        ];
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });

      it("should not emit IntentPruned events", async () => {
        const tx = await subject();

        // Since intents don't exist (timestamp == 0), no events should be emitted
        await expect(tx).to.not.emit(orchestrator, "IntentPruned");
      });
    });

    describe("when caller is not the escrow", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper.address;
      });

      it("should skip pruning and not revert or emit events", async () => {
        const tx = await subject();

        // Should not emit IntentPruned events
        await expect(tx).to.not.emit(orchestrator, "IntentPruned");

        // Intents should remain
        for (const intentHash of intentHashes) {
          const intent = await orchestrator.getIntent(intentHash);
          expect(intent.owner).to.eq(onRamper.address);
        }
      });
    });

    describe("when pruning intents from multiple accounts", async () => {
      let onRamperTwoIntentHash: string;

      beforeEach(async () => {
        // Signal an intent from a different account
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          depositId,
          usdc(40),
          onRamperTwo.address,
          venmoPaymentMethod,
          Currency.USD,
          ether(1.02),
          ADDRESS_ZERO,
          ZERO,
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamperTwo.wallet).signalIntent(params);

        const currentTimestamp = await blockchain.getCurrentTimestamp();
        onRamperTwoIntentHash = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter
        );
        currentIntentCounter++;  // Increment after signalIntent

        // Add this intent to the list to be pruned
        subjectIntents = [intentHashes[0], onRamperTwoIntentHash];
      });

      it("should correctly update accountIntents for both accounts", async () => {
        // Check pre-state
        const preOnRamperIntents = await orchestrator.getAccountIntents(onRamper.address);
        const preOnRamperTwoIntents = await orchestrator.getAccountIntents(onRamperTwo.address);
        expect(preOnRamperIntents.length).to.eq(3);
        expect(preOnRamperTwoIntents.length).to.eq(1);

        await subject();

        // Check post-state
        const postOnRamperIntents = await orchestrator.getAccountIntents(onRamper.address);
        const postOnRamperTwoIntents = await orchestrator.getAccountIntents(onRamperTwo.address);

        // onRamper should have 2 intents left (3 - 1 pruned)
        expect(postOnRamperIntents.length).to.eq(2);
        expect(postOnRamperIntents).to.not.include(intentHashes[0]);
        expect(postOnRamperIntents).to.include(intentHashes[1]);
        expect(postOnRamperIntents).to.include(intentHashes[2]);

        // onRamperTwo should have 0 intents left
        expect(postOnRamperTwoIntents.length).to.eq(0);
      });
    });

    describe("when array is empty", async () => {
      beforeEach(async () => {
        subjectIntents = [];
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });

      it("should not emit any events", async () => {
        const tx = await subject();
        await expect(tx).to.not.emit(orchestrator, "IntentPruned");
      });
    });
  });

  // Governance Functions

  describe("#setEscrowRegistry", async () => {
    let subjectEscrow: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectEscrow = onRamper.address; // Mock new escrow address
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).setEscrowRegistry(subjectEscrow);
    }

    it("should set the escrow address", async () => {
      await subject();

      const escrowAddress = await orchestrator.escrowRegistry();
      expect(escrowAddress).to.eq(subjectEscrow);
    });

    it("should emit EscrowUpdated event", async () => {
      await expect(subject()).to.emit(orchestrator, "EscrowRegistryUpdated").withArgs(subjectEscrow);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when escrow is zero address", async () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });

      it("should revert with EscrowCannotBeZeroAddress", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      });
    });
  });

  describe("#setProtocolFee", async () => {
    let subjectProtocolFee: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectProtocolFee = ether(0.02);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).setProtocolFee(subjectProtocolFee);
    }

    it("should set the protocol fee", async () => {
      await subject();

      const protocolFee = await orchestrator.protocolFee();
      expect(protocolFee).to.eq(subjectProtocolFee);
    });

    it("should emit ProtocolFeeUpdated event", async () => {
      await expect(subject()).to.emit(orchestrator, "ProtocolFeeUpdated").withArgs(subjectProtocolFee);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when protocol fee exceeds maximum", async () => {
      beforeEach(async () => {
        subjectProtocolFee = ether(0.1); // 10% > 5% max
      });

      it("should revert with ProtocolFeeExceedsMaximum", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "FeeExceedsMaximum");
      });
    });
  });

  describe("#setProtocolFeeRecipient", async () => {
    let subjectProtocolFeeRecipient: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectProtocolFeeRecipient = owner.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).setProtocolFeeRecipient(subjectProtocolFeeRecipient);
    }

    it("should set the correct protocol fee recipient", async () => {
      const preProtocolFeeRecipient = await orchestrator.protocolFeeRecipient();

      expect(preProtocolFeeRecipient).to.eq(feeRecipient.address);

      await subject();

      const postProtocolFeeRecipient = await orchestrator.protocolFeeRecipient();

      expect(postProtocolFeeRecipient).to.eq(subjectProtocolFeeRecipient);
    });

    it("should emit a ProtocolFeeRecipientUpdated event", async () => {
      const tx = await subject();

      expect(tx).to.emit(orchestrator, "ProtocolFeeRecipientUpdated").withArgs(subjectProtocolFeeRecipient);
    });

    describe("when the passed fee recipient is the zero address", async () => {
      beforeEach(async () => {
        subjectProtocolFeeRecipient = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#setPostIntentHookRegistry", async () => {
    let subjectPostIntentHookRegistry: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const newRegistry = await deployer.deployPostIntentHookRegistry();
      subjectPostIntentHookRegistry = newRegistry.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).setPostIntentHookRegistry(subjectPostIntentHookRegistry);
    }

    it("should set the correct post intent hook registry", async () => {
      const preRegistry = await orchestrator.postIntentHookRegistry();
      expect(preRegistry).to.not.eq(subjectPostIntentHookRegistry);

      await subject();

      const postRegistry = await orchestrator.postIntentHookRegistry();
      expect(postRegistry).to.eq(subjectPostIntentHookRegistry);
    });

    it("should emit a PostIntentHookRegistryUpdated event", async () => {
      await expect(subject()).to.emit(orchestrator, "PostIntentHookRegistryUpdated").withArgs(subjectPostIntentHookRegistry);
    });

    describe("when the registry is zero address", async () => {
      beforeEach(async () => {
        subjectPostIntentHookRegistry = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#setRelayerRegistry", async () => {
    let subjectRelayerRegistry: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const newRegistry = await deployer.deployRelayerRegistry();

      subjectRelayerRegistry = newRegistry.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).setRelayerRegistry(subjectRelayerRegistry);
    }

    it("should set the correct relayer registry", async () => {
      const preRegistry = await orchestrator.relayerRegistry();
      expect(preRegistry).to.not.eq(subjectRelayerRegistry);

      await subject();

      const postRegistry = await orchestrator.relayerRegistry();
      expect(postRegistry).to.eq(subjectRelayerRegistry);
    });

    it("should emit a RelayerRegistryUpdated event", async () => {
      await expect(subject()).to.emit(orchestrator, "RelayerRegistryUpdated").withArgs(subjectRelayerRegistry);
    });

    describe("when the registry is zero address", async () => {
      beforeEach(async () => {
        subjectRelayerRegistry = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#setAllowMultipleIntents", async () => {
    let subjectAllowMultiple: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAllowMultiple = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await orchestrator.connect(subjectCaller.wallet).setAllowMultipleIntents(subjectAllowMultiple);
    }

    it("should correctly set allowMultipleIntents", async () => {
      await subject();

      const allowMultiple = await orchestrator.allowMultipleIntents();
      expect(allowMultiple).to.eq(subjectAllowMultiple);
    });

    it("should emit the correct AllowMultipleIntentsUpdated event", async () => {
      await expect(subject()).to.emit(orchestrator, "AllowMultipleIntentsUpdated").withArgs(
        subjectAllowMultiple
      );
    });

    describe("when setting to false", async () => {
      beforeEach(async () => {
        await orchestrator.setAllowMultipleIntents(true);
        subjectAllowMultiple = false;
      });

      it("should correctly set allowMultipleIntents to false", async () => {
        await subject();

        const allowMultiple = await orchestrator.allowMultipleIntents();
        expect(allowMultiple).to.be.false;
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#pauseOrchestrator", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).pauseOrchestrator();
    }

    it("should pause the orchestrator", async () => {
      await subject();

      const isPaused = await orchestrator.paused();
      expect(isPaused).to.eq(true);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#unpauseOrchestrator", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await orchestrator.connect(owner.wallet).pauseOrchestrator();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).unpauseOrchestrator();
    }

    it("should unpause the orchestrator", async () => {
      await subject();

      const isPaused = await orchestrator.paused();
      expect(isPaused).to.eq(false);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  // Getter Functions

  describe("#getAccountIntents", async () => {
    beforeEach(async () => {
      // Enable multiple intents for testing
      await orchestrator.connect(owner.wallet).setAllowMultipleIntents(true);

      // Create a deposit
      await usdcToken.connect(offRamper.wallet).approve(escrow.address, usdc(10000));
      await escrow.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(1000),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: ether(1.01) }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });
    });

    it("should return empty array for account with no intents", async () => {
      const intents = await orchestrator.getAccountIntents(onRamper.address);
      expect(intents.length).to.eq(0);
    });

    it("should return all intents for an account", async () => {
      // Signal two intents
      const params1 = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        receiver.address,
        venmoPaymentMethod,
        Currency.USD,
        ether(1.02),
        ADDRESS_ZERO,
        ZERO,
        gatingService,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x"
      );
      await orchestrator.connect(onRamper.wallet).signalIntent(params1);

      // Add a small delay to prevent gas estimation issues
      await new Promise(resolve => setTimeout(resolve, 100));

      const params2 = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(75),
        receiver.address,
        venmoPaymentMethod,
        Currency.USD,
        ether(1.02),
        ADDRESS_ZERO,
        ZERO,
        gatingService,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x"
      );
      await orchestrator.connect(onRamper.wallet).signalIntent(params2);

      const intents = await orchestrator.getAccountIntents(onRamper.address);
      expect(intents.length).to.eq(2);
    });
  });
});
