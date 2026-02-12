import "module-alias/register";

import { ethers, network } from "hardhat";
import { BytesLike, Signer } from "ethers";

import {
  Address,
} from "@utils/types";
import { Account } from "@utils/test/types";
import {
  Escrow,
  ProtocolViewer,
  IEscrow,
  USDCMock,
  PaymentVerifierMock,
  PostIntentHookMock,
  PaymentVerifierRegistry,
  Orchestrator,
  RelayerRegistry,
  OrchestratorMock,
  ReentrantOrchestratorMock,
  EscrowRegistry
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";

import {
  getWaffleExpect,
  getAccounts
} from "@utils/test/index";
import { Blockchain, ether, usdc } from "@utils/common";
import { BigNumber } from "ethers";
import { ZERO, ZERO_BYTES32, ADDRESS_ZERO, ONE, ONE_HOUR_IN_SECONDS } from "@utils/constants";
import { calculateIntentHash } from "@utils/protocolUtils";
import { ONE_DAY_IN_SECONDS } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { generateGatingServiceSignature, createSignalIntentParams } from "@utils/test/helpers";

const expect = getWaffleExpect();

const blockchain = new Blockchain(ethers.provider);

describe("Escrow", () => {
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
  let witness: Account;
  let intentGuardian: Account;
  let chainId: BigNumber = ONE;
  let currentIntentCounter: number = 0;
  let venmoPaymentMethodHash: string;
  let paypalPaymentMethodHash: string;

  let ramp: Escrow;
  let protocolViewer: ProtocolViewer;
  let usdcToken: USDCMock;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let escrowRegistry: EscrowRegistry;
  let orchestrator: Orchestrator;
  let relayerRegistry: RelayerRegistry;
  let postIntentHookMock: PostIntentHookMock;
  let orchestratorMock: OrchestratorMock;
  let reentrantOrchestratorMock: ReentrantOrchestratorMock;
  let dustRecipient: Account;

  let verifier: PaymentVerifierMock;
  let otherVerifier: PaymentVerifierMock;
  let deployer: DeployHelper;

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
      dustRecipient,
      intentGuardian
    ] = await getAccounts();

    // Initialize payment method hashes
    venmoPaymentMethodHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    paypalPaymentMethodHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));

    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    escrowRegistry = await deployer.deployEscrowRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();

    await usdcToken.transfer(offRamper.address, usdc(10000));

    ramp = await deployer.deployEscrow(
      owner.address,
      chainId,
      paymentVerifierRegistry.address,
      dustRecipient.address,
      ZERO,
      BigNumber.from(3),
      ONE_DAY_IN_SECONDS  // intentExpirationPeriod
    );

    await escrowRegistry.addEscrow(ramp.address);

    orchestrator = await deployer.deployOrchestrator(
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      ZERO,
      feeRecipient.address
    );

    await ramp.connect(owner.wallet).setOrchestrator(orchestrator.address);

    protocolViewer = await deployer.deployProtocolViewer(ramp.address, orchestrator.address);

    const nullifierRegistry = await deployer.deployNullifierRegistry();

    verifier = await deployer.deployPaymentVerifierMock();
    otherVerifier = await deployer.deployPaymentVerifierMock();

    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, ramp.address);
    await otherVerifier.connect(owner.wallet).setVerificationContext(orchestrator.address, ramp.address);

    // Register payment methods with their verifiers and supported currencies
    await paymentVerifierRegistry.addPaymentMethod(
      venmoPaymentMethodHash,
      verifier.address,
      [Currency.USD, Currency.EUR]
    );
    await paymentVerifierRegistry.addPaymentMethod(
      paypalPaymentMethodHash,
      otherVerifier.address,
      [Currency.USD, Currency.EUR]  // Added EUR support for PayPal to match test requirements
    );

    postIntentHookMock = await deployer.deployPostIntentHookMock(usdcToken.address, ramp.address);

    // Deploy orchestrator mocks for testing orchestrator-only functions
    orchestratorMock = await deployer.deployOrchestratorMock(ramp.address);
    reentrantOrchestratorMock = await deployer.deployReentrantOrchestratorMock(ramp.address);
  });

  describe("#constructor", async () => {
    it("should set the correct state variables", async () => {
      const ownerAddress: Address = await ramp.owner();
      const chainId: BigNumber = await ramp.chainId();
      const paymentVerifierRegistryAddress: Address = await ramp.paymentVerifierRegistry();
      const maxIntentsPerDeposit: BigNumber = await ramp.maxIntentsPerDeposit();
      const dustThreshold: BigNumber = await ramp.dustThreshold();
      const dustRecipientAddress: Address = await ramp.dustRecipient();
      const intentExpirationPeriod: BigNumber = await ramp.intentExpirationPeriod();

      expect(ownerAddress).to.eq(owner.address);
      expect(chainId).to.eq(chainId);
      expect(paymentVerifierRegistryAddress).to.eq(paymentVerifierRegistry.address);
      expect(maxIntentsPerDeposit).to.eq(BigNumber.from(3));
      expect(dustRecipientAddress).to.eq(dustRecipient.address);
      expect(dustThreshold).to.eq(ZERO);
      expect(intentExpirationPeriod).to.eq(ONE_DAY_IN_SECONDS);
    });
  });

  describe("#createDeposit", async () => {
    let subjectToken: Address;
    let subjectAmount: BigNumber;
    let subjectIntentAmountRange: IEscrow.RangeStruct;
    let subjectPaymentMethods: string[];
    let subjectPaymentMethodData: IEscrow.DepositPaymentMethodDataStruct[];
    let subjectCurrencies: IEscrow.CurrencyStruct[][];
    let subjectDelegate: Address;
    let subjectIntentGuardian: Address;
    let subjectReferrer: Address;
    let subjectReferrerFee: BigNumber;
    let subjectRetainOnEmpty: boolean;

    beforeEach(async () => {
      subjectToken = usdcToken.address;
      subjectAmount = usdc(100);
      subjectIntentAmountRange = { min: usdc(10), max: usdc(200) }; // Example range
      subjectPaymentMethods = [venmoPaymentMethodHash];
      subjectPaymentMethodData = [
        {
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("PaymentService1payeeDetails")),
          data: "0x"
        }
      ];
      subjectCurrencies = [
        [
          { code: Currency.USD, minConversionRate: ether(1.01) },
          { code: Currency.EUR, minConversionRate: ether(0.95) }
        ]
      ];
      subjectDelegate = offRamperDelegate.address;
      subjectIntentGuardian = ADDRESS_ZERO;
      subjectReferrer = ADDRESS_ZERO;
      subjectReferrerFee = ZERO;
      subjectRetainOnEmpty = true;
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
    });

    async function subject(): Promise<any> {
      return ramp.connect(offRamper.wallet).createDeposit({
        token: subjectToken,
        amount: subjectAmount,
        intentAmountRange: subjectIntentAmountRange,
        paymentMethods: subjectPaymentMethods,
        paymentMethodData: subjectPaymentMethodData,
        currencies: subjectCurrencies,
        delegate: subjectDelegate,
        intentGuardian: subjectIntentGuardian,
        retainOnEmpty: subjectRetainOnEmpty,
      });
    }

    it("should transfer the tokens to the Ramp contract", async () => {
      await subject();

      const rampBalance = await usdcToken.balanceOf(ramp.address);
      const offRamperBalance = await usdcToken.balanceOf(offRamper.address);
      expect(rampBalance).to.eq(subjectAmount);
      expect(offRamperBalance).to.eq(usdc(9900));
    });

    it("should correctly update the deposits mapping", async () => {
      await subject();

      const depositView = await protocolViewer.getDeposit(0);

      expect(depositView.deposit.depositor).to.eq(offRamper.address);
      expect(depositView.deposit.token).to.eq(subjectToken);
      expect(depositView.deposit.intentAmountRange.min).to.eq(subjectIntentAmountRange.min);
      expect(depositView.deposit.intentAmountRange.max).to.eq(subjectIntentAmountRange.max);
      expect(depositView.deposit.acceptingIntents).to.be.true;
      expect(depositView.deposit.delegate).to.eq(subjectDelegate);

      expect(depositView.paymentMethods.length).to.eq(1);
      expect(depositView.paymentMethods[0].paymentMethod).to.eq(subjectPaymentMethods[0]);
      expect(depositView.paymentMethods[0].verificationData.intentGatingService).to.eq(subjectPaymentMethodData[0].intentGatingService);
      expect(depositView.paymentMethods[0].verificationData.payeeDetails).to.eq(subjectPaymentMethodData[0].payeeDetails);
      expect(depositView.paymentMethods[0].verificationData.data).to.eq(subjectPaymentMethodData[0].data);
      expect(depositView.paymentMethods[0].currencies.length).to.eq(2);
      expect(depositView.paymentMethods[0].currencies[0].code).to.eq(subjectCurrencies[0][0].code);
      expect(depositView.paymentMethods[0].currencies[0].minConversionRate).to.eq(subjectCurrencies[0][0].minConversionRate);
      expect(depositView.paymentMethods[0].currencies[1].code).to.eq(subjectCurrencies[0][1].code);
      expect(depositView.paymentMethods[0].currencies[1].minConversionRate).to.eq(subjectCurrencies[0][1].minConversionRate);
      expect(depositView.deposit.intentGuardian).to.eq(subjectIntentGuardian);
      // fees removed: no makerProtocolFee on deposit
    });

    it("should add the deposit to the accountDeposits mapping", async () => {
      await subject();

      const accountDeposits = await ramp.getAccountDeposits(offRamper.address);
      expect(accountDeposits.length).to.eq(1);
      expect(accountDeposits[0]).to.eq(0);
    });

    it("should increment the deposit counter", async () => {
      const preDepositCounter = await ramp.depositCounter();

      await subject();

      const postDepositCounter = await ramp.depositCounter();
      expect(postDepositCounter).to.eq(preDepositCounter.add(1));
    });

    it("should correctly update the depositPaymentMethodData mapping", async () => {
      await subject();

      const paymentMethodData = await ramp.getDepositPaymentMethodData(0, subjectPaymentMethods[0]);

      expect(paymentMethodData.intentGatingService).to.eq(subjectPaymentMethodData[0].intentGatingService);
      expect(paymentMethodData.payeeDetails).to.eq(subjectPaymentMethodData[0].payeeDetails);
      expect(paymentMethodData.data).to.eq(subjectPaymentMethodData[0].data);
    });

    it("should correctly update the depositPaymentMethodActive mapping", async () => {
      await subject();

      const isPaymentMethodActive = await ramp.getDepositPaymentMethodActive(0, subjectPaymentMethods[0]);
      expect(isPaymentMethodActive).to.be.true;
    });

    it("should correctly update the depositPaymentMethodListed mapping", async () => {
      await subject();

      const isPaymentMethodListed = await ramp.getDepositPaymentMethodListed(0, subjectPaymentMethods[0]);
      expect(isPaymentMethodListed).to.be.true;
    });

    it("should correctly update the depositRetainOnEmpty mapping", async () => {
      await subject();

      const deposit = await ramp.getDeposit(0);
      expect(deposit.retainOnEmpty).to.eq(subjectRetainOnEmpty);
    });

    it("should correctly update the depositCurrencyMinRate mapping", async () => {
      await subject();

      const currencyMinRate = await ramp.getDepositCurrencyMinRate(0, subjectPaymentMethods[0], subjectCurrencies[0][0].code);
      expect(currencyMinRate).to.eq(subjectCurrencies[0][0].minConversionRate);

      const currencyMinRate2 = await ramp.getDepositCurrencyMinRate(0, subjectPaymentMethods[0], subjectCurrencies[0][1].code);
      expect(currencyMinRate2).to.eq(subjectCurrencies[0][1].minConversionRate);
    });

    it("should correctly update the depositCurrencyListed mapping", async () => {
      await subject();

      const isCurrencyListed = await ramp.getDepositCurrencyListed(0, subjectPaymentMethods[0], subjectCurrencies[0][0].code);
      expect(isCurrencyListed).to.be.true;
    });

    it("should emit a DepositReceived event", async () => {
      await expect(subject()).to.emit(ramp, "DepositReceived").withArgs(
        ZERO, // depositId starts at 0
        offRamper.address,
        subjectToken,
        subjectAmount,
        subjectIntentAmountRange,
        subjectDelegate,
        subjectIntentGuardian
      );
    });

    it("should emit a DepositPaymentMethodAdded event", async () => {
      await expect(subject()).to.emit(ramp, "DepositPaymentMethodAdded").withArgs(
        ZERO, // depositId starts at 0
        subjectPaymentMethods[0],
        subjectPaymentMethodData[0].payeeDetails,
        subjectPaymentMethodData[0].intentGatingService
      );
    });

    it("should emit a DepositCurrencyAdded event", async () => {
      const tx = await subject();
      const receipt = await tx.wait();

      const events = receipt.events.filter((e: any) => e.event === "DepositCurrencyAdded");
      expect(events).to.have.length(2);

      // First event
      expect(events[0].args.depositId).to.equal(0);
      expect(events[0].args.paymentMethod).to.equal(subjectPaymentMethods[0]);
      expect(events[0].args.currency).to.equal(subjectCurrencies[0][0].code);
      expect(events[0].args.minConversionRate).to.equal(subjectCurrencies[0][0].minConversionRate);

      // Second event  
      expect(events[1].args.depositId).to.equal(0);
      expect(events[1].args.paymentMethod).to.equal(subjectPaymentMethods[0]);
      expect(events[1].args.currency).to.equal(subjectCurrencies[0][1].code);
      expect(events[1].args.minConversionRate).to.equal(subjectCurrencies[0][1].minConversionRate);
    });

    describe("when there are multiple payment methods", async () => {
      beforeEach(async () => {
        subjectPaymentMethods = [venmoPaymentMethodHash, paypalPaymentMethodHash];
        subjectPaymentMethodData = [
          {
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.formatBytes32String("test"),
            data: "0x"
          },
          {
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.formatBytes32String("test2"),
            data: "0x"
          }
        ];
        subjectCurrencies = [
          [
            { code: Currency.USD, minConversionRate: ether(1.01) },
            { code: Currency.EUR, minConversionRate: ether(0.92) }
          ],
          [
            { code: Currency.USD, minConversionRate: ether(1.02) }
          ]
        ];
      });

      it("should correctly update mappings for all payment methods", async () => {
        await subject();

        // Check first payment method
        const paymentMethodData1 = await ramp.getDepositPaymentMethodData(0, subjectPaymentMethods[0]);
        expect(paymentMethodData1.intentGatingService).to.eq(subjectPaymentMethodData[0].intentGatingService);
        expect(paymentMethodData1.payeeDetails).to.eq(subjectPaymentMethodData[0].payeeDetails);
        expect(paymentMethodData1.data).to.eq(subjectPaymentMethodData[0].data);

        const currencyRate1_1 = await ramp.getDepositCurrencyMinRate(0, subjectPaymentMethods[0], subjectCurrencies[0][0].code);
        expect(currencyRate1_1).to.eq(subjectCurrencies[0][0].minConversionRate);
        const currencyRate1_2 = await ramp.getDepositCurrencyMinRate(0, subjectPaymentMethods[0], subjectCurrencies[0][1].code);
        expect(currencyRate1_2).to.eq(subjectCurrencies[0][1].minConversionRate);

        // Check second payment method
        const paymentMethodData2 = await ramp.getDepositPaymentMethodData(0, subjectPaymentMethods[1]);
        expect(paymentMethodData2.intentGatingService).to.eq(subjectPaymentMethodData[1].intentGatingService);
        expect(paymentMethodData2.payeeDetails).to.eq(subjectPaymentMethodData[1].payeeDetails);
        expect(paymentMethodData2.data).to.eq(subjectPaymentMethodData[1].data);

        const currencyRate2_1 = await ramp.getDepositCurrencyMinRate(0, subjectPaymentMethods[1], subjectCurrencies[1][0].code);
        expect(currencyRate2_1).to.eq(subjectCurrencies[1][0].minConversionRate);
      });

      it("should correctly update the depositPaymentMethodActive mapping", async () => {
        await subject();

        const isPaymentMethodActive1 = await ramp.getDepositPaymentMethodActive(0, subjectPaymentMethods[0]);
        expect(isPaymentMethodActive1).to.be.true;

        const isPaymentMethodActive2 = await ramp.getDepositPaymentMethodActive(0, subjectPaymentMethods[1]);
        expect(isPaymentMethodActive2).to.be.true;
      });
    });

    describe("when the intent amount range min is zero", async () => {
      beforeEach(async () => {
        subjectIntentAmountRange.min = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroMinValue");
      });
    });

    describe("when the min intent amount is greater than max intent amount", async () => {
      beforeEach(async () => {
        subjectIntentAmountRange.min = usdc(2);
        subjectIntentAmountRange.max = usdc(1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "InvalidRange");
      });
    });

    describe("when the amount is less than min intent amount", async () => {
      beforeEach(async () => {
        subjectIntentAmountRange.min = usdc(2);
        subjectAmount = usdc(1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "AmountBelowMin");
      });
    });

    describe("when the length of the payment methods array is not equal to the length of the paymentMethodData array", async () => {
      beforeEach(async () => {
        subjectPaymentMethods = [venmoPaymentMethodHash, paypalPaymentMethodHash];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ArrayLengthMismatch");
      });
    });

    describe("when the length of the payment methods array is not equal to the length of the currencies array", async () => {
      beforeEach(async () => {
        subjectPaymentMethods = [venmoPaymentMethodHash, paypalPaymentMethodHash];
        subjectPaymentMethodData = [
          {
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.formatBytes32String("test"),
            data: "0x"
          },
          {
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.formatBytes32String("test"),
            data: "0x"
          }
        ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ArrayLengthMismatch");
      });
    });

    describe("when the accepted currencies is not supported by the payment method", async () => {
      beforeEach(async () => {
        subjectCurrencies[0][0].code = Currency.AED;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "CurrencyNotSupported");
      });
    });

    describe("when the minConversionRate is zero", async () => {
      beforeEach(async () => {
        subjectCurrencies[0][0].minConversionRate = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroConversionRate");
      });
    });

    describe("when the payment method is zero bytes32", async () => {
      beforeEach(async () => {
        subjectPaymentMethods = [ZERO_BYTES32];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroAddress");
      });
    });

    describe("when the payment method is not whitelisted", async () => {
      beforeEach(async () => {
        const unknownPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("unknown"));
        subjectPaymentMethods = [unknownPaymentMethod];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "PaymentMethodNotWhitelisted");
      });
    });

    describe("when payee details hash is empty", async () => {
      beforeEach(async () => {
        subjectPaymentMethodData[0].payeeDetails = ZERO_BYTES32;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "EmptyPayeeDetails");
      });
    });

    describe("when there are duplicate payment methods", async () => {
      beforeEach(async () => {
        subjectPaymentMethods = [venmoPaymentMethodHash, venmoPaymentMethodHash];
        subjectPaymentMethodData = [
          {
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.formatBytes32String("test"),
            data: "0x"
          },
          {
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.formatBytes32String("test"),
            data: "0x"
          }
        ];
        subjectCurrencies = [
          [{ code: Currency.USD, minConversionRate: ether(1.01) }],
          [{ code: Currency.EUR, minConversionRate: ether(0.95) }]
        ]
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "PaymentMethodAlreadyExists");
      });
    });

    describe("when there are duplicate currencies for a payment method", async () => {
      beforeEach(async () => {
        subjectPaymentMethods = [venmoPaymentMethodHash];
        subjectPaymentMethodData = [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.formatBytes32String("test"),
          data: "0x"
        }];
        subjectCurrencies = [
          [
            { code: Currency.USD, minConversionRate: ether(1.01) },
            { code: Currency.USD, minConversionRate: ether(1.02) }
          ]
        ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "CurrencyAlreadyExists");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#addFunds", async () => {
    let subjectDepositId: BigNumber;
    let subjectAmount: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit to test adding funds
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: ether(1.08) }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      subjectDepositId = ZERO;
      subjectAmount = usdc(50);
      subjectCaller = offRamper;

      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).addFunds(subjectDepositId, subjectAmount);
    }

    it("should transfer the tokens to the Ramp contract", async () => {
      const rampPreBalance = await usdcToken.balanceOf(ramp.address);
      const offRamperPreBalance = await usdcToken.balanceOf(offRamper.address);

      await subject();

      const rampPostBalance = await usdcToken.balanceOf(ramp.address);
      const offRamperPostBalance = await usdcToken.balanceOf(offRamper.address);

      expect(rampPostBalance).to.eq(rampPreBalance.add(subjectAmount));
      expect(offRamperPostBalance).to.eq(offRamperPreBalance.sub(subjectAmount));
    });

    it("should update the deposit amount correctly", async () => {
      const preDeposit = await ramp.getDeposit(subjectDepositId);

      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.add(subjectAmount));
    });

    it("should emit a DepositFundsAdded event", async () => {
      await expect(subject()).to.emit(ramp, "DepositFundsAdded");
    });

    describe("when the deposit is not accepting intents", async () => {
      beforeEach(async () => {
        // Manually set deposit to not accept intents
        await ramp.connect(offRamper.wallet).setAcceptingIntents(subjectDepositId, false);
      });

      it("should still allow adding funds", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.acceptingIntents).to.be.false;

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.add(subjectAmount));
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        await usdcToken.connect(offRamper.wallet).transfer(maliciousOnRamper.address, usdc(100));
        await usdcToken.connect(maliciousOnRamper.wallet).approve(ramp.address, usdc(100));

        subjectCaller = maliciousOnRamper;
      });

      it("should add the funds", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.add(subjectAmount));
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositNotFound");
      });
    });

    describe("when the amount is zero", async () => {
      beforeEach(async () => {
        subjectAmount = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroValue");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#removeFunds", async () => {
    let subjectDepositId: BigNumber;
    let subjectAmount: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit to test removing funds
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: ether(1.08) }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      subjectDepositId = ZERO;
      subjectAmount = usdc(30);
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).removeFunds(subjectDepositId, subjectAmount);
    }

    it("should transfer the tokens from the Ramp contract to the depositor", async () => {
      const rampPreBalance = await usdcToken.balanceOf(ramp.address);
      const offRamperPreBalance = await usdcToken.balanceOf(offRamper.address);

      await subject();

      const rampPostBalance = await usdcToken.balanceOf(ramp.address);
      const offRamperPostBalance = await usdcToken.balanceOf(offRamper.address);

      expect(rampPostBalance).to.eq(rampPreBalance.sub(subjectAmount));
      expect(offRamperPostBalance).to.eq(offRamperPreBalance.add(subjectAmount));
    });

    it("should update the deposit amount correctly", async () => {
      const preDeposit = await ramp.getDeposit(subjectDepositId);

      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.sub(subjectAmount));
    });

    it("should emit a DepositWithdrawn event", async () => {
      await expect(subject()).to.emit(ramp, "DepositWithdrawn").withArgs(
        subjectDepositId,
        offRamper.address,
        subjectAmount,
      );
    });

    it("should still be accepting intents", async () => {
      const preDeposit = await ramp.getDeposit(subjectDepositId);
      expect(preDeposit.acceptingIntents).to.be.true;

      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.acceptingIntents).to.be.true;
    });

    describe("when the deposit is not accepting intents", async () => {
      beforeEach(async () => {
        // Manually set deposit to not accept intents
        await ramp.connect(offRamper.wallet).setAcceptingIntents(subjectDepositId, false);

        subjectAmount = usdc(20);
      });

      it("should still allow removing funds", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.acceptingIntents).to.be.false;

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.remainingDeposits).to.eq(preDeposit.remainingDeposits.sub(subjectAmount));
      });
    });

    describe("when removing funds causes remainingDeposits to go below min intent amount", async () => {
      beforeEach(async () => {
        // Remove funds to leave only 5 USDC (below min of 10)
        subjectAmount = usdc(95);
      });

      it("should auto-disable accepting intents", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.acceptingIntents).to.be.true;

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.remainingDeposits).to.eq(usdc(5)); // Below min of 10
        expect(postDeposit.acceptingIntents).to.be.false;
      });

      it("should emit DepositAcceptingIntentsUpdated event", async () => {
        await expect(subject()).to.emit(ramp, "DepositAcceptingIntentsUpdated").withArgs(
          subjectDepositId,
          false
        );
      });

      it("should emit DepositWithdrawn event", async () => {
        await expect(subject()).to.emit(ramp, "DepositWithdrawn").withArgs(
          subjectDepositId,
          offRamper.address,
          subjectAmount
        );
      });
    });

    describe("when removing all remaining funds", async () => {
      beforeEach(async () => {
        subjectAmount = usdc(100);
      });

      it("should NOT close the deposit", async () => {
        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.depositor).to.eq(offRamper.address);
      });
    });

    describe("when there are expired intents", async () => {

      let intentHash: string;

      beforeEach(async () => {
        // Signal an intent
        const intentAmount = usdc(50);
        const conversionRate = ether(1.1);

        const signalIntentParams = await createSignalIntentParams(
          orchestrator.address,
          ramp.address,
          subjectDepositId,
          intentAmount,
          onRamper.address,
          venmoPaymentMethodHash,
          Currency.USD,
          conversionRate,
          ADDRESS_ZERO,
          ZERO,
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(signalIntentParams);
        const currentTimestamp = await blockchain.getCurrentTimestamp();
        intentHash = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter
        );
        currentIntentCounter++;  // Increment after signalIntent

        // Fast forward time to expire the intent
        await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());

        // Try to remove more than remaining deposits but less than remaining + expired intent
        subjectAmount = usdc(70);
      });

      it("should prune expired intents and allow removal", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.remainingDeposits).to.eq(usdc(50)); // 100 - 50 (intent)

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        // Should have pruned the intent and removed the requested amount
        expect(postDeposit.remainingDeposits).to.eq(usdc(30)); // 100 - 70
        expect(postDeposit.outstandingIntentAmount).to.eq(ZERO); // Intent was pruned
      });

      it("should emit DepositWithdrawn event", async () => {
        await expect(subject()).to.emit(ramp, "DepositWithdrawn").withArgs(
          subjectDepositId,
          offRamper.address,
          subjectAmount,
        );
      });

      it("should still be accepting intents", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.acceptingIntents).to.be.true;

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.acceptingIntents).to.be.true;
      });
    });

    describe("when the requested amount exceeds available liquidity", async () => {
      beforeEach(async () => {
        // Signal an intent that won't expire
        const intentAmount = usdc(60);
        const conversionRate = ether(1.1);
        const signalIntentParams = await createSignalIntentParams(
          orchestrator.address,
          ramp.address,
          subjectDepositId,
          intentAmount,
          onRamper.address,
          venmoPaymentMethodHash,
          Currency.USD,
          conversionRate,
          ADDRESS_ZERO,
          ZERO,
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(signalIntentParams);

        // Try to remove more than available (40 remaining, trying to remove 50)
        subjectAmount = usdc(50);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "InsufficientDepositLiquidity");
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });
    });

    describe("when the amount is zero", async () => {
      beforeEach(async () => {
        subjectAmount = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroValue");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#withdrawDeposit", async () => {
    let subjectDepositId: BigNumber;
    let subjectCaller: Account;

    let depositConversionRate: BigNumber;

    beforeEach(async () => {
      // Create deposit to test withdrawal
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      depositConversionRate = ether(1.08);
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: depositConversionRate }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      subjectDepositId = ZERO;
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).withdrawDeposit(subjectDepositId);
    }

    it("should transfer the correct amount of usdc to the caller", async () => {
      const offRamperPreBalance = await usdcToken.balanceOf(offRamper.address);
      const rampPreBalance = await usdcToken.balanceOf(ramp.address);

      await subject();

      const offRamperPostBalance = await usdcToken.balanceOf(offRamper.address);
      const rampPostBalance = await usdcToken.balanceOf(ramp.address);

      expect(offRamperPostBalance).to.eq(offRamperPreBalance.add(usdc(100)));
      expect(rampPostBalance).to.eq(rampPreBalance.sub(usdc(100)));
    });

    it("should delete the deposit", async () => {
      const preDeposit = await ramp.getDeposit(subjectDepositId);
      expect(preDeposit.depositor).to.not.eq(ADDRESS_ZERO);

      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.depositor).to.eq(ADDRESS_ZERO);
    });

    it("should remove the deposit from the user deposits mapping", async () => {
      const preUserDeposits = await protocolViewer.getAccountDeposits(offRamper.address);
      expect(preUserDeposits.some(deposit => deposit.depositId.eq(subjectDepositId))).to.be.true;

      await subject();

      const postUserDeposits = await ramp.getAccountDeposits(offRamper.address);
      expect(postUserDeposits.some(depositId => depositId.eq(subjectDepositId))).to.be.false;
    });

    it("should remove the deposit verifier data", async () => {
      const prePaymentMethodData = await ramp.getDepositPaymentMethodData(subjectDepositId, venmoPaymentMethodHash);
      expect(prePaymentMethodData.intentGatingService).to.not.eq(ADDRESS_ZERO);

      await subject();

      const postPaymentMethodData = await ramp.getDepositPaymentMethodData(subjectDepositId, venmoPaymentMethodHash);
      expect(postPaymentMethodData.intentGatingService).to.eq(ADDRESS_ZERO);
    });

    it("should correctly update the depositPaymentMethodActive mapping", async () => {
      await subject();

      const isPaymentMethodActive = await ramp.getDepositPaymentMethodActive(subjectDepositId, venmoPaymentMethodHash);
      expect(isPaymentMethodActive).to.be.false;
    });

    it("should correctly update the depositPaymentMethodListed mapping", async () => {
      await subject();

      const isPaymentMethodListed = await ramp.getDepositPaymentMethodListed(subjectDepositId, venmoPaymentMethodHash);
      expect(isPaymentMethodListed).to.be.false;
    });

    it("should delete the deposit payment methods array", async () => {
      const prePaymentMethods = await ramp.getDepositPaymentMethods(subjectDepositId);
      expect(prePaymentMethods.length).to.eq(1);
      expect(prePaymentMethods[0]).to.eq(venmoPaymentMethodHash);

      await subject();

      const postPaymentMethods = await ramp.getDepositPaymentMethods(subjectDepositId);
      expect(postPaymentMethods.length).to.eq(0);
    });

    it("should delete the deposit currencies array", async () => {
      const preCurrencies = await ramp.getDepositCurrencies(subjectDepositId, venmoPaymentMethodHash);
      expect(preCurrencies.length).to.eq(1);
      expect(preCurrencies[0]).to.eq(Currency.USD);

      await subject();

      const postCurrencies = await ramp.getDepositCurrencies(subjectDepositId, venmoPaymentMethodHash);
      expect(postCurrencies.length).to.eq(0);
    });

    it("should delete deposit currency min conversion data", async () => {
      const preCurrencyMinRate = await ramp.getDepositCurrencyMinRate(subjectDepositId, venmoPaymentMethodHash, Currency.USD);
      expect(preCurrencyMinRate).to.not.eq(ZERO);

      await subject();

      const postCurrencyMinRate = await ramp.getDepositCurrencyMinRate(subjectDepositId, venmoPaymentMethodHash, Currency.USD);
      expect(postCurrencyMinRate).to.eq(ZERO);
    });

    it("should correctly update the depositCurrencyListed mapping", async () => {
      await subject();

      const isCurrencyListed = await ramp.getDepositCurrencyListed(subjectDepositId, venmoPaymentMethodHash, Currency.USD);
      expect(isCurrencyListed).to.be.false;
    });

    it("should emit a DepositWithdrawn event", async () => {
      const tx = await subject();

      expect(tx).to.emit(ramp, "DepositWithdrawn").withArgs(
        subjectDepositId,
        offRamper.address,
        usdc(100),
      );
    });

    it("should set the deposit accepting intents to false", async () => {
      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.acceptingIntents).to.be.false;
    });

    it("should emit DepositClosed event", async () => {
      const tx = await subject();

      expect(tx).to.emit(ramp, "DepositClosed").withArgs(subjectDepositId, offRamper.address);
    });

    describe("when there is an outstanding intent", async () => {
      let intentHash: string;

      beforeEach(async () => {
        const gatingServiceSignature = await generateGatingServiceSignature(
          gatingService,
          orchestrator.address,
          ramp.address,
          subjectDepositId,
          usdc(50),
          receiver.address,
          venmoPaymentMethodHash,
          Currency.USD,
          depositConversionRate,
          chainId.toString()
        );

        const params = await createSignalIntentParams(
          orchestrator.address,
          ramp.address,
          subjectDepositId,
          usdc(50),
          receiver.address,
          venmoPaymentMethodHash,
          Currency.USD,
          depositConversionRate,
          ADDRESS_ZERO,
          ZERO,
          null,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );
        params.gatingServiceSignature = gatingServiceSignature;
        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        // Calculate the intent hash
        const currentTimestamp = await blockchain.getCurrentTimestamp();
        intentHash = calculateIntentHash(
          orchestrator.address,
          currentIntentCounter
        );
        currentIntentCounter++;  // Increment after signalIntent
      });

      it("should transfer the correct amount of usdc to the caller", async () => {
        const offRamperPreBalance = await usdcToken.balanceOf(offRamper.address);
        const rampPreBalance = await usdcToken.balanceOf(ramp.address);

        await subject();

        const offRamperPostBalance = await usdcToken.balanceOf(offRamper.address);
        const rampPostBalance = await usdcToken.balanceOf(ramp.address);

        expect(offRamperPostBalance).to.eq(offRamperPreBalance.add(usdc(50)));
        expect(rampPostBalance).to.eq(rampPreBalance.sub(usdc(50)));
      });

      it("should zero out remainingDeposits", async () => {
        await subject();

        const deposit = await ramp.getDeposit(subjectDepositId);

        expect(deposit.depositor).to.not.eq(ADDRESS_ZERO);
        expect(deposit.remainingDeposits).to.eq(ZERO);
        expect(deposit.outstandingIntentAmount).to.eq(usdc(50));
      });

      it("should set the deposit to not accepting intents", async () => {
        await subject();

        const deposit = await ramp.getDeposit(subjectDepositId);
        expect(deposit.acceptingIntents).to.be.false;
      });

      it("should emit DepositWithdrawn event", async () => {
        const tx = await subject();

        expect(tx).to.emit(ramp, "DepositWithdrawn").withArgs(
          subjectDepositId,
          offRamper.address,
          usdc(50)
        );
      });

      it("should set the deposit accepting intents to false", async () => {
        await subject();

        const deposit = await ramp.getDeposit(subjectDepositId);
        expect(deposit.acceptingIntents).to.be.false;
      });

      describe("but the intent is expired", async () => {
        beforeEach(async () => {
          await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());
        });

        it("should transfer the correct amount of usdc to the caller", async () => {
          const offRamperPreBalance = await usdcToken.balanceOf(offRamper.address);
          const rampPreBalance = await usdcToken.balanceOf(ramp.address);

          await subject();

          const offRamperPostBalance = await usdcToken.balanceOf(offRamper.address);
          const rampPostBalance = await usdcToken.balanceOf(ramp.address);

          expect(offRamperPostBalance).to.eq(offRamperPreBalance.add(usdc(100)));
          expect(rampPostBalance).to.eq(rampPreBalance.sub(usdc(100)));
        });

        it("should delete the deposit", async () => {
          await subject();

          const deposit = await ramp.getDeposit(subjectDepositId);
          expect(deposit.depositor).to.eq(ADDRESS_ZERO);
        });

        it("should delete the intent", async () => {
          const preIntent = await ramp.getDepositIntent(subjectDepositId, intentHash);
          expect(preIntent.amount).to.eq(usdc(50));

          await subject();

          const postIntent = await ramp.getDepositIntent(subjectDepositId, intentHash);

          expect(postIntent.amount).to.eq(ZERO);
        });

        it("should emit DepositWithdrawn event", async () => {
          const tx = await subject();

          expect(tx).to.emit(ramp, "DepositWithdrawn").withArgs(
            subjectDepositId,
            offRamper.address,
            usdc(100)
          );
        });

        it("should set the deposit accepting intents to false", async () => {
          await subject();

          const deposit = await ramp.getDeposit(subjectDepositId);
          expect(deposit.acceptingIntents).to.be.false;
        });

        it("should emit DepositClosed event", async () => {
          const tx = await subject();

          expect(tx).to.emit(ramp, "DepositClosed").withArgs(subjectDepositId, offRamper.address);
        });
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });

      describe("when the caller is delegate", async () => {
        beforeEach(async () => {
          subjectCaller = offRamperDelegate;
        });

        it("should still revert", async () => {
          await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
        });
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should NOT revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });
  });

  // DELEGATE FUNCTIONS

  describe("#updateDepositMinConversionRate", async () => {
    let subjectDepositId: BigNumber;
    let subjectPaymentMethod: BytesLike;
    let subjectFiatCurrency: string;
    let subjectNewMinConversionRate: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
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

      subjectDepositId = ZERO;
      subjectPaymentMethod = venmoPaymentMethodHash;
      subjectFiatCurrency = Currency.USD;
      subjectNewMinConversionRate = ether(1.05);
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setCurrencyMinRate(
        subjectDepositId,
        subjectPaymentMethod,
        subjectFiatCurrency,
        subjectNewMinConversionRate
      );
    }

    it("should update the min conversion rate", async () => {
      await subject();

      const newRate = await ramp.getDepositCurrencyMinRate(
        subjectDepositId,
        subjectPaymentMethod,
        subjectFiatCurrency
      );
      expect(newRate).to.eq(subjectNewMinConversionRate);
    });

    it("should emit a DepositMinConversionRateUpdated event", async () => {
      const tx = await subject();

      expect(tx).to.emit(ramp, "DepositMinConversionRateUpdated").withArgs(
        subjectDepositId,
        subjectPaymentMethod,
        subjectFiatCurrency,
        subjectNewMinConversionRate
      );
    });

    describe("when the caller is delegate", async () => {
      beforeEach(async () => {
        subjectCaller = offRamperDelegate;
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });


    describe("when the currency or verifier is not supported", async () => {
      beforeEach(async () => {
        subjectFiatCurrency = Currency.EUR;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "CurrencyNotSupported");
      });
    });

    describe("when the new min conversion rate is zero", async () => {
      beforeEach(async () => {
        subjectNewMinConversionRate = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroConversionRate");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#updateDepositIntentAmountRange", async () => {
    let subjectDepositId: BigNumber;
    let subjectIntentAmountRange: IEscrow.RangeStruct;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(100) },
        paymentMethods: [venmoPaymentMethodHash],
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

      subjectDepositId = ZERO;
      subjectIntentAmountRange = { min: usdc(5), max: usdc(100) };
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setIntentRange(
        subjectDepositId,
        subjectIntentAmountRange
      );
    }

    it("should update the intent amount range", async () => {
      await subject();

      const deposit = await ramp.getDeposit(subjectDepositId);
      expect(deposit.intentAmountRange.min).to.eq(subjectIntentAmountRange.min);
      expect(deposit.intentAmountRange.max).to.eq(subjectIntentAmountRange.max);
    });

    it("should emit a DepositIntentAmountRangeUpdated event", async () => {
      await expect(subject()).to.emit(ramp, "DepositIntentAmountRangeUpdated").withArgs(
        subjectDepositId,
        subjectIntentAmountRange
      );
    });

    describe("when the intent min is increased", async () => {
      beforeEach(async () => {
        subjectIntentAmountRange = { min: usdc(20), max: usdc(100) };
      });

      it("should update the intent amount range", async () => {
        await subject();

        const deposit = await ramp.getDeposit(subjectDepositId);
        expect(deposit.intentAmountRange.min).to.eq(subjectIntentAmountRange.min);
        expect(deposit.intentAmountRange.max).to.eq(subjectIntentAmountRange.max);
      });

      describe("when remaining deposits is less than the new min", async () => {
        beforeEach(async () => {
          // 100 - 85 = 15, which is less than the new min of 20
          await ramp.connect(offRamper.wallet).removeFunds(subjectDepositId, usdc(85));
        });

        it("should set acceptingIntents to false", async () => {
          await subject();

          const deposit = await ramp.getDeposit(subjectDepositId);
          expect(deposit.acceptingIntents).to.be.false;
        });

        it("should emit DepositAcceptingIntentsUpdated event", async () => {
          const tx = await subject();

          await expect(tx).to.emit(ramp, "DepositAcceptingIntentsUpdated").withArgs(
            subjectDepositId,
            false
          );
        });

        describe("when the min is decreased again", async () => {
          beforeEach(async () => {
            await subject();    // First set to false

            subjectIntentAmountRange = { min: usdc(5), max: usdc(250) };
          });

          it("should keep acceptingIntents to false", async () => {
            await subject();

            const deposit = await ramp.getDeposit(subjectDepositId);
            expect(deposit.acceptingIntents).to.be.false;
          });
        });
      });
    });

    describe("when the caller is delegate", async () => {
      beforeEach(async () => {
        subjectCaller = offRamperDelegate;
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the min amount is zero", async () => {
      beforeEach(async () => {
        subjectIntentAmountRange.min = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroMinValue");
      });
    });

    describe("when the min amount is greater than max amount", async () => {
      beforeEach(async () => {
        subjectIntentAmountRange = { min: usdc(200), max: usdc(100) };
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "InvalidRange");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#addPaymentMethodsToDeposit", async () => {
    let subjectDepositId: BigNumber;
    let subjectPaymentMethods: string[];
    let subjectPaymentMethodData: IEscrow.DepositPaymentMethodDataStruct[];
    let subjectCurrencies: IEscrow.CurrencyStruct[][];
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit first with only one verifier
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
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

      // Already registered paypalPaymentMethodHash in beforeEach

      subjectDepositId = ZERO;
      subjectPaymentMethods = [paypalPaymentMethodHash];
      subjectPaymentMethodData = [{
        intentGatingService: gatingService.address,
        payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("otherPayeeDetails")),
        data: "0x"
      }];
      subjectCurrencies = [
        [
          { code: Currency.USD, minConversionRate: ether(1.02) },
          { code: Currency.EUR, minConversionRate: ether(0.95) }
        ]
      ];
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).addPaymentMethods(
        subjectDepositId,
        subjectPaymentMethods,
        subjectPaymentMethodData,
        subjectCurrencies
      );
    }

    it("should add the payment method to the deposit", async () => {
      await subject();

      const paymentMethods = await ramp.getDepositPaymentMethods(subjectDepositId);
      expect(paymentMethods).to.include(paypalPaymentMethodHash);

      const paymentMethodData = await ramp.getDepositPaymentMethodData(subjectDepositId, paypalPaymentMethodHash);
      expect(paymentMethodData.intentGatingService).to.eq(subjectPaymentMethodData[0].intentGatingService);
      expect(paymentMethodData.payeeDetails).to.eq(subjectPaymentMethodData[0].payeeDetails);
      expect(paymentMethodData.data).to.eq(subjectPaymentMethodData[0].data);
    });

    it("should correctly update the depositPaymentMethodActive mapping", async () => {
      await subject();

      const isPaymentMethodActive = await ramp.getDepositPaymentMethodActive(subjectDepositId, paypalPaymentMethodHash);
      expect(isPaymentMethodActive).to.be.true;
    });

    it("should correctly update the depositPaymentMethodListed mapping", async () => {
      await subject();

      const isPaymentMethodListed = await ramp.getDepositPaymentMethodListed(subjectDepositId, paypalPaymentMethodHash);
      expect(isPaymentMethodListed).to.be.true;
    });

    it("should add the currencies to the payment method", async () => {
      await subject();

      const currencies = await ramp.getDepositCurrencies(subjectDepositId, paypalPaymentMethodHash);
      expect(currencies).to.have.length(2);
      expect(currencies).to.include(Currency.USD);
      expect(currencies).to.include(Currency.EUR);

      const usdRate = await ramp.getDepositCurrencyMinRate(subjectDepositId, paypalPaymentMethodHash, Currency.USD);
      expect(usdRate).to.eq(subjectCurrencies[0][0].minConversionRate);

      const eurRate = await ramp.getDepositCurrencyMinRate(subjectDepositId, paypalPaymentMethodHash, Currency.EUR);
      expect(eurRate).to.eq(subjectCurrencies[0][1].minConversionRate);
    });

    it("should emit DepositVerifierAdded and DepositCurrencyAdded events", async () => {
      const tx = await subject();

      await expect(tx).to.emit(ramp, "DepositPaymentMethodAdded").withArgs(
        subjectDepositId,
        paypalPaymentMethodHash,
        subjectPaymentMethodData[0].payeeDetails,
        subjectPaymentMethodData[0].intentGatingService
      );

      const receipt = await tx.wait();
      const currencyEvents = receipt.events.filter((e: any) => e.event === "DepositCurrencyAdded");
      expect(currencyEvents).to.have.length(2);
    });

    describe("when the caller is delegate", async () => {
      beforeEach(async () => {
        subjectCaller = offRamperDelegate;
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the payment method is not whitelisted", async () => {
      beforeEach(async () => {
        const unknownPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("unknown"));
        subjectPaymentMethods = [unknownPaymentMethod];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "PaymentMethodNotWhitelisted");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when the payment method is already listed", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert with PaymentMethodAlreadyListed", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "PaymentMethodAlreadyExists");
      });
    });
  });

  describe("#setDepositPaymentMethodActive", async () => {
    let subjectDepositId: BigNumber;
    let subjectPaymentMethod: string;
    let subjectCaller: Account;
    let subjectIsActive: boolean;

    beforeEach(async () => {
      // Create deposit with multiple payment methods
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));

      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash, paypalPaymentMethodHash],
        paymentMethodData: [
          {
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
            data: "0x"
          },
          {
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("otherPayeeDetails")),
            data: "0x"
          }
        ],
        currencies: [
          [{ code: Currency.USD, minConversionRate: ether(1.01) }],
          [{ code: Currency.USD, minConversionRate: ether(1.02) }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      subjectDepositId = ZERO;
      subjectPaymentMethod = paypalPaymentMethodHash;
      subjectCaller = offRamper;
      subjectIsActive = false;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setPaymentMethodActive(
        subjectDepositId,
        subjectPaymentMethod,
        subjectIsActive
      );
    }

    describe("when the payment method is already listed and setting active to false", async () => {
      beforeEach(async () => {
        subjectIsActive = false;
      });

      it("should deactivate (not remove) the payment method for the deposit", async () => {
        await subject();

        const paymentMethods = await ramp.getDepositPaymentMethods(subjectDepositId);
        expect(paymentMethods).to.include(subjectPaymentMethod); // still listed

        const isActive = await ramp.getDepositPaymentMethodActive(subjectDepositId, subjectPaymentMethod);
        expect(isActive).to.eq(false);
      });

      it("should NOT delete the payment method data", async () => {
        await subject();

        const paymentMethodData = await ramp.getDepositPaymentMethodData(subjectDepositId, subjectPaymentMethod);
        expect(paymentMethodData.intentGatingService).to.eq(gatingService.address);
        expect(paymentMethodData.payeeDetails).to.eq(ethers.utils.keccak256(ethers.utils.toUtf8Bytes("otherPayeeDetails")));
        expect(paymentMethodData.data).to.eq("0x");
      });

      it("should set the depositPaymentMethodActive mapping to false", async () => {
        await subject();

        const isPaymentMethodActive = await ramp.getDepositPaymentMethodActive(subjectDepositId, subjectPaymentMethod);
        expect(isPaymentMethodActive).to.be.false;
      });

      it("should NOT remove currencies or data for the payment method", async () => {
        await subject();

        const currencies = await ramp.getDepositCurrencies(subjectDepositId, subjectPaymentMethod);
        expect(currencies.length).to.be.greaterThan(0); // still listed

        const minConversionRate = await ramp.getDepositCurrencyMinRate(subjectDepositId, subjectPaymentMethod, Currency.USD);
        expect(minConversionRate).to.not.eq(ZERO); // unchanged

        const data = await ramp.getDepositPaymentMethodData(subjectDepositId, subjectPaymentMethod);
        expect(data.intentGatingService).to.eq(gatingService.address);
      });

      it("should emit a DepositPaymentMethodActiveUpdated(false) event", async () => {
        await expect(subject()).to.emit(ramp, "DepositPaymentMethodActiveUpdated").withArgs(
          subjectDepositId,
          subjectPaymentMethod,
          false
        );
      });

      describe("when the payment method is already inactive", async () => {
        beforeEach(async () => {
          subjectIsActive = false;
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositAlreadyInState");
        });
      });
    });

    describe("when the payment method is inactive and setting active to true", async () => {
      beforeEach(async () => {
        // First set to false
        await ramp.connect(offRamper.wallet).setPaymentMethodActive(
          subjectDepositId,
          subjectPaymentMethod,
          false
        );

        subjectIsActive = true;
      });

      it("should activate the payment method for the deposit", async () => {
        await subject();

        const isActive = await ramp.getDepositPaymentMethodActive(subjectDepositId, subjectPaymentMethod);
        expect(isActive).to.be.true;
      });

      it("should emit a DepositPaymentMethodActiveUpdated(true) event", async () => {
        await expect(subject()).to.emit(ramp, "DepositPaymentMethodActiveUpdated").withArgs(
          subjectDepositId,
          subjectPaymentMethod,
          true
        );
      });
    });

    describe("when the caller is delegate", async () => {
      beforeEach(async () => {
        subjectCaller = offRamperDelegate;
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the payment method is not listed for the deposit", async () => {
      beforeEach(async () => {
        const unknownPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("unknown"));
        subjectPaymentMethod = unknownPaymentMethod;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "PaymentMethodNotListed");
      });
    });

    describe("when the payment method is already inactive", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositAlreadyInState");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#addCurrenciesToDepositPaymentMethod", async () => {
    let subjectDepositId: BigNumber;
    let subjectPaymentMethod: string;
    let subjectCurrencies: IEscrow.CurrencyStruct[];
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
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

      subjectDepositId = ZERO;
      subjectPaymentMethod = venmoPaymentMethodHash;
      subjectCurrencies = [
        { code: Currency.EUR, minConversionRate: ether(0.95) }
      ];
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).addCurrencies(
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencies
      );
    }

    it("should add the currencies to the payment method", async () => {
      await subject();

      const currencies = await ramp.getDepositCurrencies(subjectDepositId, subjectPaymentMethod);
      expect(currencies).to.include(Currency.EUR);

      const minConversionRate = await ramp.getDepositCurrencyMinRate(subjectDepositId, subjectPaymentMethod, Currency.EUR);
      expect(minConversionRate).to.eq(subjectCurrencies[0].minConversionRate);
    });

    it("should emit a DepositCurrencyAdded event", async () => {
      await expect(subject()).to.emit(ramp, "DepositCurrencyAdded").withArgs(
        subjectDepositId,
        subjectPaymentMethod,
        Currency.EUR,
        subjectCurrencies[0].minConversionRate
      );
    });

    describe("when the caller is delegate", async () => {
      beforeEach(async () => {
        subjectCaller = offRamperDelegate;
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the payment method is not found or inactive for the deposit", async () => {
      beforeEach(async () => {
        subjectPaymentMethod = paypalPaymentMethodHash;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "PaymentMethodNotActive");
      });
    });

    describe("when the currency is not supported by the payment method", async () => {
      beforeEach(async () => {
        subjectCurrencies = [
          { code: Currency.AED, minConversionRate: ether(3.67) }
        ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "CurrencyNotSupported");
      });
    });

    describe("when the minConversionRate is zero", async () => {
      beforeEach(async () => {
        subjectCurrencies[0].minConversionRate = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroConversionRate");
      });
    });

    describe("when the currency already exists", async () => {
      beforeEach(async () => {
        subjectCurrencies = [
          { code: Currency.USD, minConversionRate: ether(1.05) }
        ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "CurrencyAlreadyExists");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#deactivateCurrencyFromDepositPaymentMethod", async () => {
    let subjectDepositId: BigNumber;
    let subjectPaymentMethod: string;
    let subjectIsActive: boolean;
    let subjectCurrencyCode: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit with multiple currencies
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [
            { code: Currency.USD, minConversionRate: ether(1.01) },
            { code: Currency.EUR, minConversionRate: ether(0.95) }
          ]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      subjectDepositId = ZERO;
      subjectPaymentMethod = venmoPaymentMethodHash;
      subjectCurrencyCode = Currency.EUR;
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).deactivateCurrency(
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencyCode
      );
    }

    it("should deactivate (not remove) the currency for the payment method", async () => {
      await subject();

      const currencies = await ramp.getDepositCurrencies(subjectDepositId, subjectPaymentMethod);
      expect(currencies).to.include(subjectCurrencyCode); // still listed

      const minConversionRate = await ramp.getDepositCurrencyMinRate(subjectDepositId, subjectPaymentMethod, subjectCurrencyCode);
      expect(minConversionRate).to.eq(ZERO); // deactivated
    });

    it("should emit a DepositMinConversionRateUpdated(..., 0) event", async () => {
      await expect(subject()).to.emit(ramp, "DepositMinConversionRateUpdated").withArgs(
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencyCode,
        ZERO
      );
    });

    describe("when the caller is delegate", async () => {
      beforeEach(async () => {
        subjectCaller = offRamperDelegate;
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });


    describe("when the payment method is not active for the deposit", async () => {
      beforeEach(async () => {
        subjectPaymentMethod = paypalPaymentMethodHash;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "PaymentMethodNotActive");
      });
    });

    describe("when the currency is not found for the payment method", async () => {
      beforeEach(async () => {
        subjectCurrencyCode = Currency.AED;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "CurrencyNotFound");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#setDepositDelegate", async () => {
    let subjectDepositId: BigNumber;
    let subjectDelegate: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: ether(1.01) }]
        ],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      subjectDepositId = ZERO;
      subjectDelegate = offRamperDelegate.address;
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setDelegate(
        subjectDepositId,
        subjectDelegate
      );
    }

    it("should set the delegate for the deposit", async () => {
      await subject();

      const deposit = await ramp.getDeposit(subjectDepositId);
      expect(deposit.delegate).to.eq(subjectDelegate);
    });

    it("should emit a DepositDelegateSet event", async () => {
      await expect(subject()).to.emit(ramp, "DepositDelegateSet").withArgs(
        subjectDepositId,
        subjectCaller.address,
        subjectDelegate
      );
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });

      describe("when the caller is delegate", async () => {
        beforeEach(async () => {
          subjectCaller = offRamperDelegate;
        });

        it("should still revert", async () => {
          await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
        });
      });
    });

    describe("when the delegate is zero address", async () => {
      beforeEach(async () => {
        subjectDelegate = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroAddress");
      });
    });

    describe("when updating an existing delegate", async () => {
      beforeEach(async () => {
        // First set a delegate
        await ramp.connect(offRamper.wallet).setDelegate(subjectDepositId, offRamperDelegate.address);
        // Then change to a different delegate
        subjectDelegate = receiver.address;
      });

      it("should update the delegate", async () => {
        await subject();

        const deposit = await ramp.getDeposit(subjectDepositId);
        expect(deposit.delegate).to.eq(subjectDelegate);
      });

      it("should emit a DepositDelegateSet event", async () => {
        await expect(subject()).to.emit(ramp, "DepositDelegateSet").withArgs(
          subjectDepositId,
          subjectCaller.address,
          subjectDelegate
        );
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#removeDepositDelegate", async () => {
    let subjectDepositId: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit with delegate
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
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

      subjectDepositId = ZERO;
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).removeDelegate(subjectDepositId);
    }

    it("should remove the delegate from the deposit", async () => {
      await subject();

      const deposit = await ramp.getDeposit(subjectDepositId);
      expect(deposit.delegate).to.eq(ethers.constants.AddressZero);
    });

    it("should emit a DepositDelegateRemoved event", async () => {
      await expect(subject()).to.emit(ramp, "DepositDelegateRemoved").withArgs(
        subjectDepositId,
        subjectCaller.address
      );
    });

    describe("when the caller is not the depositor", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });

      describe("when the caller is delegate", async () => {
        beforeEach(async () => {
          subjectCaller = offRamperDelegate;
        });

        it("should still revert", async () => {
          await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
        });
      });
    });

    describe("when no delegate is set", async () => {
      beforeEach(async () => {
        // First remove the delegate, then try to remove again
        await ramp.connect(offRamper.wallet).removeDelegate(subjectDepositId);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DelegateNotFound");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#setDepositAcceptingIntents", async () => {
    let subjectDepositId: BigNumber;
    let subjectAcceptingIntents: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
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

      subjectDepositId = ZERO;
      subjectAcceptingIntents = false; // Default to setting to false
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setAcceptingIntents(
        subjectDepositId,
        subjectAcceptingIntents
      );
    }

    it("should update the accepting intents state", async () => {
      const preDeposit = await ramp.getDeposit(subjectDepositId);
      expect(preDeposit.acceptingIntents).to.be.true;

      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.acceptingIntents).to.eq(subjectAcceptingIntents);
    });

    it("should emit a DepositAcceptingIntentsUpdated event", async () => {
      await expect(subject()).to.emit(ramp, "DepositAcceptingIntentsUpdated").withArgs(
        subjectDepositId,
        subjectAcceptingIntents
      );
    });

    describe("when setting accepting intents to true", async () => {
      beforeEach(async () => {
        // First set to false
        await ramp.connect(offRamper.wallet).setAcceptingIntents(subjectDepositId, false);
        // Then set back to true
        subjectAcceptingIntents = true;
      });

      it("should update the accepting intents state to true", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.acceptingIntents).to.be.false;

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.acceptingIntents).to.be.true;
      });

      it("should emit a DepositAcceptingIntentsUpdated event", async () => {
        await expect(subject()).to.emit(ramp, "DepositAcceptingIntentsUpdated").withArgs(
          subjectDepositId,
          true
        );
      });
    });

    describe("when the caller is delegate", async () => {
      beforeEach(async () => {
        subjectCaller = offRamperDelegate;
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });

      it("should update the accepting intents state", async () => {
        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.acceptingIntents).to.eq(subjectAcceptingIntents);
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the caller is not the depositor or delegate", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the deposit is already in the requested state", async () => {
      beforeEach(async () => {
        subjectAcceptingIntents = true; // Deposit is already accepting intents by default
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositAlreadyInState");
      });
    });

    describe("when the deposit has no remaining liquidity", async () => {
      beforeEach(async () => {
        // Lock some funds first
        await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent"));
        const currentTimestamp = await blockchain.getCurrentTimestamp();
        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          intentHash,
          usdc(10)  // 10 locked, 90 remaining
        );

        // Remove all remaining deposits from deposit, 90 removed, 10 locked, 0 remaining to be taken
        await ramp.connect(offRamper.wallet).removeFunds(subjectDepositId, usdc(90));

        // Set accepting intents to true
        subjectAcceptingIntents = true; // Trying to restart accepting intents
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "InsufficientDepositLiquidity");
      });
    });

    describe("when the deposit has remaining liquidity below the minimum intent amount", async () => {
      beforeEach(async () => {
        // Lock some funds first
        await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent"));
        const currentTimestamp = await blockchain.getCurrentTimestamp();
        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          intentHash,
          usdc(10)  // 10 locked, 90 remaining
        );

        // Remove all remaining deposits from deposit, 81 removed, 10 locked, 9 remaining to be taken
        await ramp.connect(offRamper.wallet).removeFunds(subjectDepositId, usdc(81));

        // Set accepting intents to true
        subjectAcceptingIntents = true; // Trying to restart accepting intents
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "InsufficientDepositLiquidity");
      });
    });

    describe("when the deposit has outstanding intents but still has remaining deposits", async () => {
      beforeEach(async () => {
        // Lock some funds first
        await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);
        const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent"));
        const currentTimestamp = await blockchain.getCurrentTimestamp();

        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          intentHash,
          usdc(40)
        );
      });

      it("should not revert and update state", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.remainingDeposits).to.eq(usdc(60)); // 100 - 40
        expect(preDeposit.outstandingIntentAmount).to.eq(usdc(40));

        await expect(subject()).to.not.be.reverted;

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.acceptingIntents).to.eq(subjectAcceptingIntents);
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#pruneExpiredIntentsAndReclaimLiquidity", async () => {
    let subjectCaller: Account;
    let subjectDepositId: BigNumber;

    let depositConversionRate: BigNumber;
    let intentHash: string;
    let intentHash2: string;

    beforeEach(async () => {
      // Create deposit first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      depositConversionRate = ether(1.08);
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: depositConversionRate }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      const currentTimestamp = await blockchain.getCurrentTimestamp();
      intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent"));

      await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);

      await orchestratorMock.connect(owner.wallet).lockFunds(
        ZERO,
        intentHash,
        usdc(40)
      );

      subjectCaller = onRamper;
      subjectDepositId = ZERO;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).pruneExpiredIntents(subjectDepositId);
    }

    describe("when timestamp is before intent expiry", async () => {
      it("should not update deposit state", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.remainingDeposits).to.eq(usdc(60));
        expect(preDeposit.outstandingIntentAmount).to.eq(usdc(40));

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.remainingDeposits).to.eq(usdc(60));
        expect(postDeposit.outstandingIntentAmount).to.eq(usdc(40));
      });
    });

    describe("when timestamp is after intent expiry", async () => {
      beforeEach(async () => {
        await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());
      });

      it("should update deposit state", async () => {
        await subject();

        const depositIntents = await ramp.getDepositIntentHashes(subjectDepositId);
        expect(depositIntents.length).to.eq(0);
      });

      it("should update deposit amounts", async () => {
        const preDeposit = await ramp.getDeposit(subjectDepositId);
        expect(preDeposit.remainingDeposits).to.eq(usdc(60));
        expect(preDeposit.outstandingIntentAmount).to.eq(usdc(40));

        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.remainingDeposits).to.eq(usdc(100));
        expect(postDeposit.outstandingIntentAmount).to.eq(ZERO);
      });

      it.skip("should have called the orchestrator to prune intents", async () => {
        const tx = await subject();
        await expect(tx).to.emit(orchestratorMock, "IntentsPruned");

        const events = await orchestratorMock.queryFilter(
          orchestratorMock.filters.IntentsPruned(),
          tx.blockNumber,
          tx.blockNumber
        );
        const pruned = events.at(-1)!.args![0] as string;
        expect(pruned).to.eq(intentHash);
      });
    });

    describe("when there are multiple intents; few are expired", async () => {
      beforeEach(async () => {
        await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());
        intentHash2 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent2"));
        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          intentHash2,
          usdc(50)
        );
      });

      it("should prune only expired intents", async () => {
        await subject();

        const depositIntents = await ramp.getDepositIntentHashes(subjectDepositId);
        expect(depositIntents.length).to.eq(1);
        expect(depositIntents).to.not.include(intentHash);
        expect(depositIntents).to.include(intentHash2);
      });
    });
  });

  describe("#setDepositRetainOnEmpty", async () => {
    let subjectDepositId: BigNumber;
    let subjectRetainOnEmpty: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
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

      subjectDepositId = ZERO;
      subjectRetainOnEmpty = true;
      subjectCaller = offRamper;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setRetainOnEmpty(
        subjectDepositId,
        subjectRetainOnEmpty
      );
    }

    it("should set retainOnEmpty for the deposit", async () => {
      await subject();

      const deposit = await ramp.getDeposit(subjectDepositId);
      expect(deposit.retainOnEmpty).to.eq(true);
    });

    it("should emit a DepositRetainOnEmptyUpdated event", async () => {
      await expect(subject()).to.emit(ramp, "DepositRetainOnEmptyUpdated").withArgs(
        subjectDepositId,
        subjectRetainOnEmpty
      );
    });

    describe("when the caller is delegate", async () => {
      beforeEach(async () => {
        subjectCaller = offRamperDelegate;
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });

      it("should update the flag", async () => {
        await subject();
        const deposit = await ramp.getDeposit(subjectDepositId);
        expect(deposit.retainOnEmpty).to.eq(true);
      });
    });

    describe("when the caller is not owner or delegate", async () => {
      beforeEach(async () => {
        subjectCaller = maliciousOnRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when setting to the same value", async () => {
      beforeEach(async () => {
        // First set to true
        await ramp.connect(offRamper.wallet).setRetainOnEmpty(subjectDepositId, true);
        subjectRetainOnEmpty = true; // Trying to set same value again
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositAlreadyInState");
      });
    });

    describe("when the escrow is paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });


  // ORCHESTRATOR-ONLY FUNCTIONS

  describe("#lockFunds", async () => {
    let subjectDepositId: BigNumber;
    let subjectIntentHash: string;
    let subjectAmount: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create deposit first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(60) },
        paymentMethods: [venmoPaymentMethodHash],
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

      const currentTimestamp = await blockchain.getCurrentTimestamp();
      subjectDepositId = ZERO;
      subjectIntentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );
      currentIntentCounter++;  // Increment for consistency

      subjectAmount = usdc(30);
      subjectCaller = owner;

      // Set the orchestrator mock as the orchestrator
      await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);
    });

    async function subject(): Promise<any> {
      return orchestratorMock.connect(subjectCaller.wallet).lockFunds(
        subjectDepositId,
        subjectIntentHash,
        subjectAmount
      );
    }

    it("should update the deposit state correctly", async () => {
      const preDeposit = await ramp.getDeposit(subjectDepositId);
      expect(preDeposit.remainingDeposits).to.eq(usdc(100));
      expect(preDeposit.outstandingIntentAmount).to.eq(ZERO);

      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.remainingDeposits).to.eq(usdc(70)); // 100 - 30
      expect(postDeposit.outstandingIntentAmount).to.eq(usdc(30));
    });

    it("should create the intent correctly", async () => {
      const currentTimestamp = await blockchain.getCurrentTimestamp();
      await subject();

      const intent = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
      expect(intent.intentHash).to.eq(subjectIntentHash);
      expect(intent.amount).to.eq(subjectAmount);
      expect(intent.expiryTime).to.be.closeTo(currentTimestamp.add(ONE_DAY_IN_SECONDS), 1);
    });

    it("should add intent hash to deposit intent hashes", async () => {
      await subject();

      const intentHashes = await ramp.getDepositIntentHashes(subjectDepositId);
      expect(intentHashes).to.include(subjectIntentHash);
    });

    it("should emit the correct event", async () => {
      const tx = await subject();

      const currentTimestamp = await blockchain.getCurrentTimestamp();
      await expect(tx).to.emit(ramp, "FundsLocked").withArgs(
        subjectDepositId,
        subjectIntentHash,
        subjectAmount,
        currentTimestamp.add(ONE_DAY_IN_SECONDS)
      );
    });

    describe("when caller is not orchestrator", async () => {
      beforeEach(async () => {
        // remove the orchestrator mock
        await ramp.connect(owner.wallet).setOrchestrator(offRamper.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });
    });

    describe("when deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositNotFound");
      });
    });

    describe("when the lock amount decreases the remaining deposits below the min", async () => {
      beforeEach(async () => {
        await ramp.connect(offRamper.wallet).setIntentRange(
          subjectDepositId,
          { min: usdc(10), max: usdc(100) } // raise the max above 60 temporarily
        );

        subjectAmount = usdc(95); // 100 - 5 = 5 is less than the min of 10
      });

      it("should NOT set the deposit accepting intents to false", async () => {
        await subject();

        const deposit = await ramp.getDeposit(subjectDepositId);
        expect(deposit.acceptingIntents).to.be.true;
      });
    });

    describe("when deposit is not accepting intents", async () => {
      beforeEach(async () => {
        // Lock some funds on the deposit
        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          subjectIntentHash,
          usdc(30)
        );

        // withdraw deposit
        await ramp.connect(offRamper.wallet).withdrawDeposit(subjectDepositId);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositNotAcceptingIntents");
      });
    });

    describe("when amount is less than min intent amount", async () => {
      beforeEach(async () => {
        subjectAmount = usdc(5); // min is 10
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "AmountBelowMin");
      });
    });

    describe("when amount is greater than max intent amount", async () => {
      beforeEach(async () => {
        subjectAmount = usdc(70); // max is 60
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "AmountAboveMax");
      });
    });

    describe("when there are expired intents and not enough liquidity", async () => {
      beforeEach(async () => {
        // First lock 50 USDC
        const firstIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent1"));
        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          firstIntentHash,
          usdc(50)
        );

        // Time travel to expire the first intent
        await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());

        // Try to lock another 60 USDC (only 50 remaining, but expired intent can be pruned)
        subjectAmount = usdc(60);
      });

      it("should prune expired intents and lock funds", async () => {
        await subject();

        const deposit = await ramp.getDeposit(subjectDepositId);
        expect(deposit.remainingDeposits).to.eq(usdc(40)); // 100 - 60 (new intent)
        expect(deposit.outstandingIntentAmount).to.eq(usdc(60)); // Only new intent
      });

      describe("when the orchestrator tries to reenter", async () => {
        beforeEach(async () => {
          console.log(orchestratorMock.address);
          console.log(reentrantOrchestratorMock.address);
          await ramp.connect(owner.wallet).setOrchestrator(reentrantOrchestratorMock.address);
          await reentrantOrchestratorMock.setFunctionToReenter(1);    // lock funds
        });

        it("emits a failed reentry signal when reentering lockFunds", async () => {
          const tx = await reentrantOrchestratorMock.connect(subjectCaller.wallet).lockFunds(
            subjectDepositId,
            subjectIntentHash,
            subjectAmount
          );

          await expect(tx)
            .to.emit(reentrantOrchestratorMock, "ReentryAttempted")
            .withArgs(1, false, "ReentrancyGuard: reentrant call");

          const attempts = await reentrantOrchestratorMock.lockReentries();
          expect(attempts).to.eq(1);
        });
      });
    });

    describe("when intent hash already exists", async () => {
      beforeEach(async () => {
        // First lock funds with the subject intent hash
        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          subjectIntentHash,
          subjectAmount
        );
      });

      it("should revert with IntentAlreadyExists", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "IntentAlreadyExists");
      });
    });

    describe("when there is not enough liquidity even after pruning", async () => {
      beforeEach(async () => {
        // Lock all available funds
        const firstIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent1"));
        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          firstIntentHash,
          usdc(50)
        );

        // Pass a day and time to expire the intent
        await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());

        const secondIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent2"));
        await orchestratorMock.connect(owner.wallet).lockFunds(
          subjectDepositId,
          secondIntentHash,
          usdc(45)
        );

        // Try to lock more than the remaining 55
        subjectAmount = usdc(56);  // 56 is more than the remaining 55, even after we reclaim the previous 50
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "InsufficientDepositLiquidity");
      });
    });

    describe("when we have reached max number of intents per deposit", async function () {
      const MAX_INTENTS_PER_DEPOSIT = 3; // Matches the contract constant
      let intentHashes: string[] = [];
      let depositId: BigNumber;

      async function signalIntent(): Promise<any> {
        const params = await createSignalIntentParams(
          orchestrator.address,
          ramp.address,
          depositId,
          usdc(1),
          onRamper.address,
          venmoPaymentMethodHash,
          Currency.USD,
          ether(1),
          ADDRESS_ZERO,
          ZERO,
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        const tx = await orchestrator.connect(onRamper.wallet).signalIntent(params);
        currentIntentCounter++;
        return tx;
      }

      beforeEach(async () => {
        // Set max intents per deposit to 3
        await ramp.connect(owner.wallet).setMaxIntentsPerDeposit(MAX_INTENTS_PER_DEPOSIT);

        // Reset intentHashes array for each test
        intentHashes = [];

        // First time setup - create deposit and 99 intents
        await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(1000));

        const payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails"));
        const depositData = ethers.utils.defaultAbiCoder.encode(
          ["address"],
          [witness.address]
        );

        await ramp.connect(offRamper.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(1000),
          intentAmountRange: { min: usdc(1), max: usdc(100) },
          paymentMethods: [venmoPaymentMethodHash],
          paymentMethodData: [{
            intentGatingService: gatingService.address,
            payeeDetails: payeeDetails,
            data: depositData
          }],
          currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
          delegate: ADDRESS_ZERO,
          intentGuardian: ADDRESS_ZERO,
          retainOnEmpty: false
        });

        const depositCounter = await ramp.depositCounter();
        depositId = depositCounter.sub(1);

        // Enable multiple intents so we can create many
        await orchestrator.connect(owner.wallet).setAllowMultipleIntents(true);
        await ramp.connect(owner.wallet).setOrchestrator(orchestrator.address);

        // Signal MAX_INTENTS_PER_DEPOSIT - 1 intents using batching
        for (let i = 0; i < MAX_INTENTS_PER_DEPOSIT - 1; i++) {
          await signalIntent();
          const intentHash = calculateIntentHash(
            orchestrator.address,
            currentIntentCounter
          );
          intentHashes.push(intentHash);
          currentIntentCounter++;
        }
      });

      it("should allow creating MAX_INTENTS_PER_DEPOSIT intents", async () => {
        await expect(signalIntent()).to.not.be.reverted;

        const depositIntents = await ramp.getDepositIntentHashes(depositId);
        expect(depositIntents.length).to.eq(MAX_INTENTS_PER_DEPOSIT);
      });

      it("should revert when trying to create more than MAX_INTENTS_PER_DEPOSIT intents", async () => {
        await signalIntent();

        const depositIntents = await ramp.getDepositIntentHashes(depositId);
        expect(depositIntents.length).to.eq(MAX_INTENTS_PER_DEPOSIT);

        await expect(signalIntent()).to.be.revertedWithCustomError(ramp, "MaxIntentsExceeded");
      });

      it("should allow new intents after cancelling old ones", async () => {
        await signalIntent();

        await expect(signalIntent()).to.be.revertedWithCustomError(ramp, "MaxIntentsExceeded");

        await orchestrator.connect(onRamper.wallet).cancelIntent(intentHashes[0]);
        await expect(signalIntent()).to.not.be.reverted;

        const depositIntents = await ramp.getDepositIntentHashes(depositId);
        expect(depositIntents.length).to.eq(MAX_INTENTS_PER_DEPOSIT);
      });

      it("should allow new intents after expired intents are pruned automatically", async () => {
        await signalIntent();

        await expect(signalIntent()).to.be.revertedWithCustomError(ramp, "MaxIntentsExceeded");

        await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());

        await expect(signalIntent()).to.not.be.reverted;

        const depositIntents = await ramp.getDepositIntentHashes(depositId);
        expect(depositIntents.length).to.eq(1);
      });
    });
  });

  describe("#unlockFunds", async () => {
    let subjectDepositId: BigNumber;
    let subjectIntentHash: string;
    let subjectCaller: Account;

    let intentAmount: BigNumber;
    let intentExpiryTime: BigNumber;

    beforeEach(async () => {
      // Create deposit
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(50) },
        paymentMethods: [venmoPaymentMethodHash],
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

      // Lock funds first
      const currentTimestamp = await blockchain.getCurrentTimestamp();
      subjectDepositId = ZERO;
      subjectIntentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );
      currentIntentCounter++;  // Increment for consistency
      intentAmount = usdc(30);
      intentExpiryTime = currentTimestamp.add(ONE_DAY_IN_SECONDS);

      // Set the orchestrator mock as the orchestrator
      await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);

      await orchestratorMock.connect(owner.wallet).lockFunds(
        subjectDepositId,
        subjectIntentHash,
        intentAmount
      );

      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestratorMock.connect(subjectCaller.wallet).unlockFunds(
        subjectDepositId,
        subjectIntentHash
      );
    }

    it("should update the deposit state correctly", async () => {
      const preDeposit = await ramp.getDeposit(subjectDepositId);
      expect(preDeposit.remainingDeposits).to.eq(usdc(70));
      expect(preDeposit.outstandingIntentAmount).to.eq(usdc(30));

      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.remainingDeposits).to.eq(usdc(100)); // Funds returned
      expect(postDeposit.outstandingIntentAmount).to.eq(ZERO);
    });

    it("should delete the intent", async () => {
      const preIntent = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
      expect(preIntent.intentHash).to.eq(subjectIntentHash);

      await subject();

      const postIntent = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
      expect(postIntent.intentHash).to.eq(ZERO_BYTES32);
    });

    it("should remove intent hash from deposit intent hashes", async () => {
      const preIntentHashes = await ramp.getDepositIntentHashes(subjectDepositId);
      expect(preIntentHashes).to.include(subjectIntentHash);

      await subject();

      const postIntentHashes = await ramp.getDepositIntentHashes(subjectDepositId);
      expect(postIntentHashes).to.not.include(subjectIntentHash);
    });

    it("should emit the correct event", async () => {
      await expect(subject()).to.emit(ramp, "FundsUnlocked").withArgs(
        subjectDepositId,
        subjectIntentHash,
        intentAmount
      );
    });

    describe("when caller is not orchestrator", async () => {
      beforeEach(async () => {
        // remove the orchestrator mock
        await ramp.connect(owner.wallet).setOrchestrator(offRamper.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });
    });

    describe("when deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositNotFound");
      });
    });

    describe("when intent does not exist", async () => {
      beforeEach(async () => {
        subjectIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("nonexistent"));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "IntentNotFound");
      });
    });
  });

  describe("#unlockAndTransferFunds", async () => {
    let subjectDepositId: BigNumber;
    let subjectIntentHash: string;
    let subjectTransferAmount: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;

    let intentAmount: BigNumber;
    let intentExpiryTime: BigNumber;

    beforeEach(async () => {
      // Create deposit
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(50) },
        paymentMethods: [venmoPaymentMethodHash],
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

      // Lock funds first
      const currentTimestamp = await blockchain.getCurrentTimestamp();
      subjectDepositId = ZERO;
      subjectIntentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );
      currentIntentCounter++;  // Increment after signalIntent
      intentAmount = usdc(30);
      intentExpiryTime = currentTimestamp.add(ONE_DAY_IN_SECONDS);

      // Set the orchestrator mock as the orchestrator
      await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);

      await orchestratorMock.connect(owner.wallet).lockFunds(
        subjectDepositId,
        subjectIntentHash,
        intentAmount
      );

      subjectTransferAmount = intentAmount; // Full amount by default
      subjectTo = orchestrator.address; // Transfer to the real orchestrator address
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestratorMock.connect(subjectCaller.wallet).unlockAndTransferFunds(
        subjectDepositId,
        subjectIntentHash,
        subjectTransferAmount,
        subjectTo
      );
    }

    it("should transfer the correct amount of tokens", async () => {
      const preToBalance = await usdcToken.balanceOf(subjectTo);
      const preRampBalance = await usdcToken.balanceOf(ramp.address);

      await subject();

      const postToBalance = await usdcToken.balanceOf(subjectTo);
      const postRampBalance = await usdcToken.balanceOf(ramp.address);

      expect(postToBalance).to.eq(preToBalance.add(subjectTransferAmount));
      expect(postRampBalance).to.eq(preRampBalance.sub(subjectTransferAmount));
    });

    it("should update the deposit state correctly for full transfer", async () => {
      await subject();

      const postDeposit = await ramp.getDeposit(subjectDepositId);
      expect(postDeposit.remainingDeposits).to.eq(usdc(70)); // 100 - 30
      expect(postDeposit.outstandingIntentAmount).to.eq(ZERO);
    });

    it("should delete the intent", async () => {
      await subject();

      const postIntent = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
      expect(postIntent.intentHash).to.eq(ZERO_BYTES32);
    });

    it("should emit the correct event", async () => {
      await expect(subject()).to.emit(ramp, "FundsUnlockedAndTransferred").withArgs(
        subjectDepositId,
        subjectIntentHash,
        intentAmount,
        subjectTransferAmount,
        subjectTo
      );
    });

    it("should remove intent hash from deposit intent hashes", async () => {
      await subject();

      const postIntentHashes = await ramp.getDepositIntentHashes(subjectDepositId);
      expect(postIntentHashes).to.not.include(subjectIntentHash);
    });

    describe("when transferring partial amount", async () => {
      beforeEach(async () => {
        subjectTransferAmount = usdc(20); // Less than intent amount of 30
      });

      it("should transfer the partial amount", async () => {
        const preToBalance = await usdcToken.balanceOf(subjectTo);
        await subject();
        const postToBalance = await usdcToken.balanceOf(subjectTo);

        expect(postToBalance).to.eq(preToBalance.add(usdc(20)));
      });

      it("should return unused funds to remaining deposits and zero out outstanding intent amount", async () => {
        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        // 70 (remaining before) + 10 (unused from intent: 30 - 20)
        expect(postDeposit.remainingDeposits).to.eq(usdc(80));
        expect(postDeposit.outstandingIntentAmount).to.eq(ZERO);
      });
    });

    describe("when transfer amount is zero", async () => {
      beforeEach(async () => {
        subjectTransferAmount = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroValue");
      });
    });

    describe("when transferring would close the deposit", async () => {
      beforeEach(async () => {
        // Withdraw most funds first
        await ramp.connect(offRamper.wallet).removeFunds(subjectDepositId, usdc(70));
        // Now deposit only has the 30 USDC locked in the intent
      });

      it("should close the deposit after transfer", async () => {
        await subject();

        const postDeposit = await ramp.getDeposit(subjectDepositId);
        expect(postDeposit.depositor).to.eq(ADDRESS_ZERO);
      });

      it("should emit DepositClosed event", async () => {
        await expect(subject()).to.emit(ramp, "DepositClosed").withArgs(
          subjectDepositId,
          offRamper.address
        );
      });

      describe("when retainOnEmpty is true", async () => {
        beforeEach(async () => {
          await ramp.connect(offRamper.wallet).setRetainOnEmpty(subjectDepositId, true);
        });

        it("should not delete the deposit config", async () => {
          await subject();

          const postDeposit = await ramp.getDeposit(subjectDepositId);
          expect(postDeposit.depositor).to.not.eq(ADDRESS_ZERO);
        });

        it("should set/keep the acceptIntents to false", async () => {
          await subject();

          const postDeposit = await ramp.getDeposit(subjectDepositId);
          expect(postDeposit.acceptingIntents).to.eq(false);
        });

        it("should not emit DepositClosed event", async () => {
          await expect(subject()).to.not.emit(ramp, "DepositClosed");
        });
      });
    });

    describe("when remainder is dust and gets collected", async () => {
      let tinyDepositId: BigNumber;
      let tinyIntentHash: string;

      beforeEach(async () => {
        // Create a tiny deposit of 1 USDC
        await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10));
        await ramp.connect(offRamper.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(1),
          intentAmountRange: { min: usdc(1), max: usdc(1) },
          paymentMethods: [venmoPaymentMethodHash],
          paymentMethodData: [{
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
            data: "0x"
          }],
          currencies: [
            [{ code: Currency.USD, minConversionRate: ether(1) }]
          ],
          delegate: ADDRESS_ZERO,
          intentGuardian: ADDRESS_ZERO,
          retainOnEmpty: false,
        });

        tinyDepositId = BigNumber.from(1); // next deposit
        tinyIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("tiny-intent"));

        // Route orchestrator to the mock
        await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);

        // Lock the full 1 USDC for this tiny deposit
        await orchestratorMock.connect(owner.wallet).lockFunds(
          tinyDepositId,
          tinyIntentHash,
          usdc(1)
        );

        // Set dust threshold to 1 USDC and dust recipient
        await ramp.connect(owner.wallet).setDustThreshold(usdc(1));
        await ramp.connect(owner.wallet).setDustRecipient(feeRecipient.address);
      });

      it("should emit DustCollected and transfer dust to dustRecipient", async () => {
        const preDustRecipient = await usdcToken.balanceOf(feeRecipient.address);

        // Transfer all but 1 unit (1 micro USDC) so remainder = 1 unit <= dustThreshold
        const tx = await orchestratorMock.connect(owner.wallet).unlockAndTransferFunds(
          tinyDepositId,
          tinyIntentHash,
          usdc(1).sub(1),
          owner.address
        );

        await expect(tx).to.emit(ramp, "DustCollected").withArgs(
          tinyDepositId,
          BigNumber.from(1),
          feeRecipient.address
        );

        // Deposit should be closed
        const post = await ramp.getDeposit(tinyDepositId);
        expect(post.depositor).to.eq(ADDRESS_ZERO);

        // Dust recipient should have received the 1 unit
        const postDustRecipient = await usdcToken.balanceOf(feeRecipient.address);
        expect(postDustRecipient.sub(preDustRecipient)).to.eq(1);
      });
    });

    describe("when transfer amount exceeds intent amount", async () => {
      beforeEach(async () => {
        subjectTransferAmount = usdc(40); // Intent amount is only 30
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "AmountExceedsAvailable");
      });
    });

    describe("when caller is not orchestrator", async () => {
      beforeEach(async () => {
        // remove the orchestrator mock
        await ramp.connect(owner.wallet).setOrchestrator(offRamper.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "UnauthorizedCaller");
      });
    });

    describe("when deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositNotFound");
      });
    });

    describe("when intent does not exist", async () => {
      beforeEach(async () => {
        subjectIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("nonexistent"));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "IntentNotFound");
      });
    });
  });

  describe("#extendIntentExpiry", async () => {
    let subjectDepositId: BigNumber;
    let subjectIntentHash: string;
    let subjectAdditionalTime: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Create a deposit with an intent guardian
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));

      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(100) },
        paymentMethods: [venmoPaymentMethodHash],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: ether(1) }]
        ],
        delegate: ADDRESS_ZERO,  // delegate
        intentGuardian: intentGuardian.address,  // intentGuardia
        retainOnEmpty: false,
      });

      subjectDepositId = ZERO;

      // Signal an intent
      const params = await createSignalIntentParams(
        orchestrator.address,
        ramp.address,
        subjectDepositId,
        usdc(50),
        onRamper.address,
        venmoPaymentMethodHash,
        Currency.USD,
        ether(1),
        ADDRESS_ZERO,
        ZERO,
        gatingService,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x"
      );

      await orchestrator.connect(onRamper.wallet).signalIntent(params);

      subjectIntentHash = calculateIntentHash(
        orchestrator.address,
        currentIntentCounter
      );
      currentIntentCounter++;

      subjectAdditionalTime = BigNumber.from(3600); // 1 hour
      subjectCaller = intentGuardian;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).extendIntentExpiry(
        subjectDepositId,
        subjectIntentHash,
        subjectAdditionalTime
      );
    }

    it("should extend the intent expiry time", async () => {
      const intentBefore = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
      const oldExpiryTime = intentBefore.expiryTime;

      await subject();

      const intentAfter = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
      const newExpiryTime = intentAfter.expiryTime;

      expect(newExpiryTime).to.eq(oldExpiryTime.add(subjectAdditionalTime));
    });

    it("should emit IntentExpiryExtended event", async () => {
      const intentBefore = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
      const oldExpiryTime = intentBefore.expiryTime;
      const newExpiryTime = oldExpiryTime.add(subjectAdditionalTime);

      await expect(subject()).to.emit(ramp, "IntentExpiryExtended").withArgs(
        subjectDepositId,
        subjectIntentHash,
        newExpiryTime
      );
    });

    describe("when called by non-intent guardian", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCaller");
      });
    });

    describe("when intent does not exist", async () => {
      beforeEach(async () => {
        subjectIntentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("nonexistent"));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "IntentNotFound");
      });
    });

    describe("when deposit has no intent guardian", async () => {
      beforeEach(async () => {
        // Cancel the intent
        await orchestrator.connect(onRamper.wallet).cancelIntent(subjectIntentHash);

        // Create a deposit without intent guardian
        await ramp.connect(offRamper.wallet).createDeposit({
          token: usdcToken.address,
          amount: usdc(100),
          intentAmountRange: { min: usdc(10), max: usdc(100) },
          paymentMethods: [venmoPaymentMethodHash],
          paymentMethodData: [{
            intentGatingService: gatingService.address,
            payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails2")),
            data: "0x"
          }],
          currencies: [
            [{ code: Currency.USD, minConversionRate: ether(1) }]
          ],
          delegate: ADDRESS_ZERO,  // delegate
          intentGuardian: ADDRESS_ZERO,   // no intentGuardian
          retainOnEmpty: false,
        });

        const newDepositId = ONE;

        // Signal an intent for the new deposit
        const params = await createSignalIntentParams(
          orchestrator.address,
          ramp.address,
          newDepositId,
          usdc(50),
          onRamper.address,
          venmoPaymentMethodHash,
          Currency.USD,
          ether(1),
          ADDRESS_ZERO,
          ZERO,
          gatingService,
          chainId.toString(),
          ADDRESS_ZERO,
          "0x"
        );

        await orchestrator.connect(onRamper.wallet).signalIntent(params);

        const intentCounter = await orchestrator.intentCounter();

        subjectDepositId = ONE;
        subjectIntentHash = calculateIntentHash(
          orchestrator.address,
          intentCounter.sub(1)
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCaller");
      });
    });

    describe("when extending by more than the max total intent expiration period", async () => {
      beforeEach(async () => {
        subjectAdditionalTime = BigNumber.from(86400 * 6); // 6 days
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "AmountAboveMax");
      });
    });

    describe("when extending multiple times", async () => {
      it("should allow multiple extensions", async () => {
        const initialIntent = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
        const initialExpiry = initialIntent.expiryTime;

        // First extension
        await ramp.connect(subjectCaller.wallet).extendIntentExpiry(
          subjectDepositId,
          subjectIntentHash,
          ONE_DAY_IN_SECONDS
        );

        const afterFirst = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
        expect(afterFirst.expiryTime).to.eq(initialExpiry.add(ONE_DAY_IN_SECONDS));

        // Second extension
        await ramp.connect(subjectCaller.wallet).extendIntentExpiry(
          subjectDepositId,
          subjectIntentHash,
          ONE_DAY_IN_SECONDS
        );

        const afterSecond = await ramp.getDepositIntent(subjectDepositId, subjectIntentHash);
        expect(afterSecond.expiryTime).to.eq(initialExpiry.add(ONE_DAY_IN_SECONDS.mul(2)));

        // Third extension goes over the max total intent expiration period
        await expect(ramp.connect(subjectCaller.wallet).extendIntentExpiry(
          subjectDepositId,
          subjectIntentHash,
          ONE_DAY_IN_SECONDS.mul(2).add(1)
        )).to.be.revertedWithCustomError(ramp, "AmountAboveMax");
      });
    });

    describe("when the deposit does not exist", async () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "DepositNotFound");
      });
    });

    describe("when additional time is zero", async () => {
      beforeEach(async () => {
        subjectAdditionalTime = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroValue");
      });
    });
  });


  // GOVERNANCE FUNCTIONS

  describe("#setOrchestrator", async () => {
    let subjectOrchestrator: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const newOrchestrator = await deployer.deployOrchestrator(
        owner.address,
        chainId,
        ramp.address,
        paymentVerifierRegistry.address,
        relayerRegistry.address,
        ZERO,
        feeRecipient.address
      );

      subjectOrchestrator = newOrchestrator.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setOrchestrator(subjectOrchestrator);
    }

    it("should set the correct payment verifier registry", async () => {
      const preOrchestrator = await ramp.orchestrator();
      expect(preOrchestrator).to.not.eq(subjectOrchestrator);

      await subject();

      const postOrchestrator = await ramp.orchestrator();
      expect(postOrchestrator).to.eq(subjectOrchestrator);
    });

    it("should emit a OrchestratorUpdated event", async () => {
      await expect(subject()).to.emit(ramp, "OrchestratorUpdated").withArgs(subjectOrchestrator);
    });

    describe("when the orchestrator is zero address", async () => {
      beforeEach(async () => {
        subjectOrchestrator = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroAddress");
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

  describe("#setPaymentVerifierRegistry", async () => {
    let subjectPaymentVerifierRegistry: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const newRegistry = await deployer.deployPaymentVerifierRegistry();
      subjectPaymentVerifierRegistry = newRegistry.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setPaymentVerifierRegistry(subjectPaymentVerifierRegistry);
    }

    it("should set the correct payment verifier registry", async () => {
      const preRegistry = await ramp.paymentVerifierRegistry();
      expect(preRegistry).to.not.eq(subjectPaymentVerifierRegistry);

      await subject();

      const postRegistry = await ramp.paymentVerifierRegistry();
      expect(postRegistry).to.eq(subjectPaymentVerifierRegistry);
    });

    it("should emit a PaymentVerifierRegistryUpdated event", async () => {
      await expect(subject()).to.emit(ramp, "PaymentVerifierRegistryUpdated").withArgs(subjectPaymentVerifierRegistry);
    });

    describe("when the registry is zero address", async () => {
      beforeEach(async () => {
        subjectPaymentVerifierRegistry = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroAddress");
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

  describe("#pauseEscrow", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).pauseEscrow();
    }

    it("should pause the escrow", async () => {
      await subject();

      const isPaused = await ramp.paused();
      expect(isPaused).to.be.true;
    });

    it("should emit a Paused event", async () => {
      await expect(subject()).to.emit(ramp, "Paused").withArgs(owner.address);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the escrow is already paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).pauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  describe("#unpauseEscrow", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await ramp.connect(owner.wallet).pauseEscrow();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).unpauseEscrow();
    }

    it("should unpause the escrow", async () => {
      await subject();

      const isPaused = await ramp.paused();
      expect(isPaused).to.be.false;
    });

    it("should emit an Unpaused event", async () => {
      await expect(subject()).to.emit(ramp, "Unpaused").withArgs(owner.address);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = onRamper;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the escrow is not paused", async () => {
      beforeEach(async () => {
        await ramp.connect(owner.wallet).unpauseEscrow();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: not paused");
      });
    });
  });

  describe("#setDustRecipient", async () => {
    let subjectDustRecipient: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectDustRecipient = receiver.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setDustRecipient(subjectDustRecipient);
    }

    it("should set the correct maker fee recipient", async () => {
      await subject();

      const postRecipient = await ramp.dustRecipient();
      expect(postRecipient).to.eq(subjectDustRecipient);
    });

    it("should emit a DustRecipientUpdated event", async () => {
      await expect(subject()).to.emit(ramp, "DustRecipientUpdated").withArgs(subjectDustRecipient);
    });

    describe("when updating existing recipient", async () => {
      beforeEach(async () => {
        // First set an initial recipient
        await ramp.connect(owner.wallet).setDustRecipient(feeRecipient.address);
        // Then update to new recipient
        subjectDustRecipient = receiver.address;
      });

      it("should update to new recipient", async () => {
        const preRecipient = await ramp.dustRecipient();
        expect(preRecipient).to.eq(feeRecipient.address);

        await subject();

        const postRecipient = await ramp.dustRecipient();
        expect(postRecipient).to.eq(subjectDustRecipient);
      });
    });

    describe("when the recipient is zero address", async () => {
      beforeEach(async () => {
        subjectDustRecipient = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroAddress");
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

  describe("#setDustThreshold", async () => {
    let subjectDustThreshold: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectDustThreshold = usdc(1); // 1 USDC
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setDustThreshold(subjectDustThreshold);
    }

    it("should set the correct dust threshold", async () => {
      const preThreshold = await ramp.dustThreshold();
      expect(preThreshold).to.eq(ZERO);

      await subject();

      const postThreshold = await ramp.dustThreshold();
      expect(postThreshold).to.eq(subjectDustThreshold);
    });

    it("should emit a DustThresholdUpdated event", async () => {
      await expect(subject()).to.emit(ramp, "DustThresholdUpdated").withArgs(subjectDustThreshold);
    });

    describe("when setting threshold to zero", async () => {
      beforeEach(async () => {
        // First set a non-zero threshold
        await ramp.connect(owner.wallet).setDustThreshold(usdc(1));
        // Then set to zero
        subjectDustThreshold = ZERO;
      });

      it("should allow setting threshold to zero", async () => {
        await subject();

        const postThreshold = await ramp.dustThreshold();
        expect(postThreshold).to.eq(ZERO);
      });
    });

    describe("when setting a large threshold", async () => {
      beforeEach(async () => {
        subjectDustThreshold = usdc(100); // 100 USDC
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "AmountAboveMax");
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

  describe("#setIntentExpirationPeriod", async () => {
    let subjectIntentExpirationPeriod: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectIntentExpirationPeriod = ONE_DAY_IN_SECONDS.mul(2);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setIntentExpirationPeriod(subjectIntentExpirationPeriod);
    }

    it("should set the correct expiration time period", async () => {
      const preOnRampAmount = await ramp.intentExpirationPeriod();

      expect(preOnRampAmount).to.eq(ONE_DAY_IN_SECONDS);

      await subject();

      const postOnRampAmount = await ramp.intentExpirationPeriod();

      expect(postOnRampAmount).to.eq(subjectIntentExpirationPeriod);
    });

    it("should emit a IntentExpirationPeriodUpdated event", async () => {
      const tx = await subject();

      expect(tx).to.emit(ramp, "IntentExpirationPeriodUpdated").withArgs(subjectIntentExpirationPeriod);
    });

    describe("when the intent expiration period is 0", async () => {
      beforeEach(async () => {
        subjectIntentExpirationPeriod = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroValue");
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

  describe("#setMaxIntentsPerDeposit", async () => {
    let subjectCaller: Account;
    let subjectMaxIntentsPerDeposit: BigNumber;

    beforeEach(async () => {
      subjectCaller = owner;
      subjectMaxIntentsPerDeposit = BigNumber.from(5);
    });

    async function subject(): Promise<any> {
      return ramp.connect(subjectCaller.wallet).setMaxIntentsPerDeposit(subjectMaxIntentsPerDeposit);
    }

    it("should update the max intents per deposit", async () => {
      await subject();

      const postMaxIntents = await ramp.maxIntentsPerDeposit();
      expect(postMaxIntents).to.eq(subjectMaxIntentsPerDeposit);
    });

    it("should emit a MaxIntentsPerDepositUpdated event", async () => {
      await expect(subject()).to.emit(ramp, "MaxIntentsPerDepositUpdated").withArgs(subjectMaxIntentsPerDeposit);
    });

    describe("when setting max intents to zero", async () => {
      beforeEach(async () => {
        subjectMaxIntentsPerDeposit = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(ramp, "ZeroValue");
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

  // GETTER FUNCTIONS

  describe("#getExpiredIntents", async () => {
    let subjectCaller: Account;
    let subjectDepositId: BigNumber;

    let depositConversionRate: BigNumber;
    let intentHash: string;

    beforeEach(async () => {
      // Create deposit and signal intent first
      await usdcToken.connect(offRamper.wallet).approve(ramp.address, usdc(10000));
      depositConversionRate = ether(1.08);
      await ramp.connect(offRamper.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethodHash],
        paymentMethodData: [{
          intentGatingService: gatingService.address,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x"
        }],
        currencies: [
          [{ code: Currency.USD, minConversionRate: depositConversionRate }]
        ],
        delegate: offRamperDelegate.address,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false
      });

      const currentTimestamp = await blockchain.getCurrentTimestamp();
      intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent"));

      await ramp.connect(owner.wallet).setOrchestrator(orchestratorMock.address);

      await orchestratorMock.connect(owner.wallet).lockFunds(
        ZERO,
        intentHash,
        usdc(50)
      );

      subjectCaller = onRamper;
      subjectDepositId = ZERO;
    });

    async function subject(): Promise<{ expiredIntents: string[], reclaimableAmount: BigNumber }> {
      return ramp.connect(subjectCaller.wallet).getExpiredIntents(subjectDepositId);
    }

    describe("when timestamp is before intent expiry", async () => {
      it("should return empty array", async () => {
        const { expiredIntents, reclaimableAmount } = await subject();
        expect(expiredIntents.length).to.eq(0);
        expect(reclaimableAmount).to.eq(ZERO);
      });
    });

    describe("when timestamp is after intent expiry", async () => {
      it("should return prunable intents", async () => {
        await blockchain.increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1).toNumber());

        const { expiredIntents, reclaimableAmount } = await subject();

        expect(expiredIntents).to.include(intentHash);
        expect(expiredIntents.length).to.eq(1);
        expect(reclaimableAmount).to.eq(usdc(50));
      });
    });

    describe("when there are no intents", async () => {
      beforeEach(async () => {
        await orchestratorMock.connect(owner.wallet).unlockFunds(
          subjectDepositId,
          intentHash,
        );
      });

      it("should return empty array", async () => {
        const { expiredIntents, reclaimableAmount } = await subject();
        expect(expiredIntents.length).to.eq(0);
        expect(reclaimableAmount).to.eq(ZERO);
      });
    });
  });
});
