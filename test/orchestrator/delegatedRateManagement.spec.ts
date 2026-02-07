import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import { Account } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { Blockchain, ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  Escrow,
  Orchestrator,
  PaymentVerifierRegistry,
  PostIntentHookRegistry,
  RelayerRegistry,
  EscrowRegistry,
  USDCMock,
  PaymentVerifierMock,
  DepositRateManagerRegistryV1,
  DepositRateManagerController,
} from "@utils/contracts";

const expect = getWaffleExpect();
const blockchain = new Blockchain(ethers.provider);

describe("DelegatedRateManagement (MVP)", () => {
  let owner: Account;
  let depositor: Account;
  let taker: Account;
  let manager: Account;
  let managerFeeRecipient: Account;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: Escrow;
  let orchestrator: Orchestrator;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let escrowRegistry: EscrowRegistry;
  let postIntentHookRegistry: PostIntentHookRegistry;
  let relayerRegistry: RelayerRegistry;
  let verifier: PaymentVerifierMock;

  let rateManagerRegistry: DepositRateManagerRegistryV1;
  let rateManagerController: DepositRateManagerController;

  let chainId: BigNumber = ONE;
  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let rateManagerNonce: number;

  beforeEach(async () => {
    [owner, depositor, taker, manager, managerFeeRecipient] = await getAccounts();
    rateManagerNonce = 0;

    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(10000));

    escrowRegistry = await deployer.deployEscrowRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    postIntentHookRegistry = await deployer.deployPostIntentHookRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();

    escrow = await deployer.deployEscrow(
      owner.address,
      chainId,
      paymentVerifierRegistry.address,
      ADDRESS_ZERO,
      ZERO,
      BigNumber.from(10),
      BigNumber.from(60 * 60) // intentExpirationPeriod
    );
    await escrowRegistry.addEscrow(escrow.address);

    orchestrator = await deployer.deployOrchestrator(
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      postIntentHookRegistry.address,
      relayerRegistry.address,
      ZERO,
      owner.address
    );
    await escrow.connect(owner.wallet).setOrchestrator(orchestrator.address);

    // Payment verifier + payment method
    verifier = await deployer.deployPaymentVerifierMock();
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(paymentMethod, verifier.address, [Currency.USD]);

    // Deploy + wire the rate manager registry
    const registryFactory = await ethers.getContractFactory("DepositRateManagerRegistryV1", owner.wallet);
    rateManagerRegistry = await registryFactory.deploy();
    rateManagerController = await deployer.deployDepositRateManagerController();
    await orchestrator.connect(owner.wallet).setDepositRateManagerController(rateManagerController.address);

    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails"));
  });

  async function createDeposit(minRate: BigNumber): Promise<void> {
    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails,
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: minRate }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  }

  // Local helper to create a manager and return id without double-wait patterns
  async function createRateManagerAndGetId(params?: {
    fee?: BigNumber;
    maxFee?: BigNumber;
    name?: string;
    uri?: string;
    hook?: string;
  }): Promise<string> {
    const tx = await rateManagerRegistry.createRateManager({
      manager: manager.address,
      feeRecipient: managerFeeRecipient.address,
      maxFee: params?.maxFee ?? ether(0.05),
      fee: params?.fee ?? ether(0.01),
      depositHook: params?.hook ?? ADDRESS_ZERO,
      name: params?.name ?? "USDCTOAIAT",
      uri: params?.uri ?? "ipfs://example",
    });
    const rcpt = await tx.wait();
    const ev = rcpt.events?.find((e: any) => e.event === "RateManagerCreated");
    return ev?.args?.rateManagerId;
  }

  // Subject-pattern for signalIntent
  let subjectConversionRate: BigNumber;
  async function subjectSignal(): Promise<string> {
    const tx = await orchestrator.connect(taker.wallet).signalIntent({
      escrow: escrow.address,
      depositId: ZERO,
      amount: usdc(50),
      to: taker.address,
      paymentMethod,
      fiatCurrency: Currency.USD,
      conversionRate: subjectConversionRate,
      referrer: ADDRESS_ZERO,
      referrerFee: ZERO,
      gatingServiceSignature: "0x",
      signatureExpiration: ZERO,
      postIntentHook: ADDRESS_ZERO,
      data: "0x",
    });
    const rcpt = await tx.wait();
    const ev = rcpt.events?.find((e: any) => e.event === "IntentSignaled");
    return ev?.args?.intentHash;
  }

  describe("#setDepositRateManagerController", () => {
    let subjectDepositRateManagerController: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      const newController = await deployer.deployDepositRateManagerController();
      subjectDepositRateManagerController = newController.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).setDepositRateManagerController(subjectDepositRateManagerController);
    }

    it("should set the correct controller", async () => {
      const preController = await orchestrator.depositRateManagerController();
      expect(preController).to.not.eq(subjectDepositRateManagerController);

      await subject();

      const postController = await orchestrator.depositRateManagerController();
      expect(postController).to.eq(subjectDepositRateManagerController);
    });

    it("should emit a DepositRateManagerControllerUpdated event", async () => {
      await expect(subject()).to.emit(orchestrator, "DepositRateManagerControllerUpdated").withArgs(subjectDepositRateManagerController);
    });

    describe("when the controller is zero address", () => {
      beforeEach(async () => {
        subjectDepositRateManagerController = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      });
    });

    describe("when the caller is not the owner", () => {
      beforeEach(async () => {
        subjectCaller = depositor;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#signalIntent", () => {
    let subjectOrchestrator: Orchestrator;
    let subjectConversionRate: BigNumber;

    async function subject(): Promise<any> {
      return subjectOrchestrator.connect(taker.wallet).signalIntent({
        escrow: escrow.address,
        depositId: ZERO,
        amount: usdc(50),
        to: taker.address,
        paymentMethod,
        fiatCurrency: Currency.USD,
        conversionRate: subjectConversionRate,
        referrer: ADDRESS_ZERO,
        referrerFee: ZERO,
        gatingServiceSignature: "0x",
        signatureExpiration: ZERO,
        postIntentHook: ADDRESS_ZERO,
        data: "0x",
      });
    }

    beforeEach(async () => {
      await createDeposit(ether(1.0));
      subjectConversionRate = ether(1.0);

      subjectOrchestrator = await deployer.deployOrchestrator(
        depositor.address,
        chainId,
        escrowRegistry.address,
        paymentVerifierRegistry.address,
        postIntentHookRegistry.address,
        relayerRegistry.address,
        ZERO,
        owner.address
      );
    });

    describe("when the controller is not set", () => {
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(subjectOrchestrator, "DepositRateManagerControllerNotSet");
      });
    });
  });

  describe("effective min rate", () => {
    describe("when manager min > depositor floor", () => {
      let rateManagerId: string;
      beforeEach(async () => {
        await createDeposit(ether(1.0));
        rateManagerId = await createRateManagerAndGetId({ fee: ZERO });
        await rateManagerRegistry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(1.05));
        await rateManagerController.connect(depositor.wallet).setDepositRateManager(escrow.address, ZERO, rateManagerRegistry.address, rateManagerId);
      });

      describe("when below manager min", () => {
        beforeEach(async () => { subjectConversionRate = ether(1.04); });
        it("should revert", async () => {
          await expect(subjectSignal()).to.be.revertedWithCustomError(orchestrator, "RateBelowMinimum");
        });
      });

      describe("when at manager min", () => {
        beforeEach(async () => { subjectConversionRate = ether(1.05); });
        it("should allow signal", async () => {
          await expect(subjectSignal()).to.not.be.reverted;
        });
      });
    });

    describe("when manager min < depositor floor", () => {
      let rateManagerId: string;
      beforeEach(async () => {
        await createDeposit(ether(1.05));
        rateManagerId = await createRateManagerAndGetId({ fee: ZERO });
        await rateManagerRegistry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(1.02));
        await rateManagerController.connect(depositor.wallet).setDepositRateManager(escrow.address, ZERO, rateManagerRegistry.address, rateManagerId);
      });
      describe("when below floor", () => {
        beforeEach(async () => { subjectConversionRate = ether(1.03); });
        it("should revert", async () => {
          await expect(subjectSignal()).to.be.revertedWithCustomError(orchestrator, "RateBelowMinimum");
        });
      });
      describe("when at floor", () => {
        beforeEach(async () => { subjectConversionRate = ether(1.05); });
        it("should allow signal", async () => {
          await expect(subjectSignal()).to.not.be.reverted;
        });
      });
    });

    describe("when manager disables pair (rate=0)", () => {
      let rateManagerId: string;
      beforeEach(async () => {
        await createDeposit(ether(1.0));
        rateManagerId = await createRateManagerAndGetId({ fee: ZERO });
        await rateManagerRegistry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ZERO);
        await rateManagerController.connect(depositor.wallet).setDepositRateManager(escrow.address, ZERO, rateManagerRegistry.address, rateManagerId);
        subjectConversionRate = ether(1.0);
      });
      it("should revert with CurrencyNotSupported", async () => {
        await expect(subjectSignal()).to.be.revertedWithCustomError(orchestrator, "CurrencyNotSupported");
      });
    });
  });

  describe("manager fee", () => {
    let rateManagerId: string;
    let signalReceipt: any;
    let signaledIntentHash: string;

    async function subjectSignalTx() {
      const tx = await orchestrator.connect(taker.wallet).signalIntent({
        escrow: escrow.address,
        depositId: ZERO,
        amount: usdc(50),
        to: taker.address,
        paymentMethod,
        fiatCurrency: Currency.USD,
        conversionRate: subjectConversionRate,
        referrer: ADDRESS_ZERO,
        referrerFee: ZERO,
        gatingServiceSignature: "0x",
        signatureExpiration: ZERO,
        postIntentHook: ADDRESS_ZERO,
        data: "0x",
      });
      signalReceipt = await tx.wait();
      signaledIntentHash = signalReceipt.events?.find((e: any) => e.event === "IntentSignaled")?.args?.intentHash;
    }

    beforeEach(async () => {
      await createDeposit(ether(1.0));
      rateManagerId = await createRateManagerAndGetId({ fee: ether(0.01) }); // 1%
      await rateManagerRegistry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(1.0));
      await rateManagerController.connect(depositor.wallet).setDepositRateManager(escrow.address, ZERO, rateManagerRegistry.address, rateManagerId);
      await verifier.setShouldVerifyPayment(true);
      subjectConversionRate = ether(1.0);
    });

    it("emits fee event last and snapshots fee at signal", async () => {
      await subjectSignalTx();
      const idxIntent = signalReceipt.events.findIndex((e: any) => e.event === "IntentSignaled");
      const idxFee = signalReceipt.events.findIndex((e: any) => e.event === "IntentManagerFeeUpdated");
      expect(idxFee).to.be.greaterThan(idxIntent);

      // Change manager fee after signal; fulfill should still use 1% snapshot
      const stored = await rateManagerController.getDepositRateManager(escrow.address, 0);
      await rateManagerRegistry.connect(manager.wallet).setFee(stored.rateManagerId, ether(0.02));

      const ts = await blockchain.getCurrentTimestamp();
      const proof = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
        [usdc(50), ts, payeeDetails, Currency.USD, signaledIntentHash]
      );
      const beforeMgr = await usdcToken.balanceOf(managerFeeRecipient.address);
      await orchestrator.connect(taker.wallet).fulfillIntent({ paymentProof: proof, intentHash: signaledIntentHash, verificationData: "0x", postIntentHookData: "0x" });
      const afterMgr = await usdcToken.balanceOf(managerFeeRecipient.address);
      const expectedManagerFee = usdc(50).mul(ether(0.01)).div(ether(1));
      expect(afterMgr.sub(beforeMgr)).to.eq(expectedManagerFee);
    });

    it("transfers manager fee on fulfillment", async () => {
      await subjectSignalTx();
      const beforeTaker = await usdcToken.balanceOf(taker.address);
      const beforeManager = await usdcToken.balanceOf(managerFeeRecipient.address);

      const ts = await blockchain.getCurrentTimestamp();
      const proof = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
        [usdc(50), ts, payeeDetails, Currency.USD, signaledIntentHash]
      );

      await orchestrator.connect(taker.wallet).fulfillIntent({
        paymentProof: proof,
        intentHash: signaledIntentHash,
        verificationData: "0x",
        postIntentHookData: "0x",
      });

      const afterTaker = await usdcToken.balanceOf(taker.address);
      const afterManager = await usdcToken.balanceOf(managerFeeRecipient.address);

      const releaseAmount = usdc(50);
      const expectedManagerFee = releaseAmount.mul(ether(0.01)).div(ether(1));
      expect(afterManager.sub(beforeManager)).to.eq(expectedManagerFee);
      expect(afterTaker.sub(beforeTaker)).to.eq(releaseAmount.sub(expectedManagerFee));
    });
  });

  describe("manager fee cap (signalIntent)", () => {
    async function deployBypassRegistryMock(params: { fee: BigNumber; recipient: string; minRate?: BigNumber; id?: string }) {
      const Factory = await ethers.getContractFactory("DepositRateManagerRegistryBypassMock", owner.wallet);
      const mockId = params.id ?? ethers.utils.keccak256(ethers.utils.toUtf8Bytes("mock-id"));
      const min = params.minRate ?? ether(1.0);
      const mock = await Factory.deploy(mockId, params.recipient, params.fee, min);
      return { mock, mockId };
    }

    let subjectConversionRate: BigNumber;
    async function subjectSignal() {
      const tx = await orchestrator.connect(taker.wallet).signalIntent({
        escrow: escrow.address,
        depositId: ZERO,
        amount: usdc(50),
        to: taker.address,
        paymentMethod,
        fiatCurrency: Currency.USD,
        conversionRate: subjectConversionRate,
        referrer: ADDRESS_ZERO,
        referrerFee: ZERO,
        gatingServiceSignature: "0x",
        signatureExpiration: ZERO,
        postIntentHook: ADDRESS_ZERO,
        data: "0x",
      });
      const rcpt = await tx.wait();
      const ev = rcpt.events?.find((e: any) => e.event === "IntentSignaled");
      return ev?.args?.intentHash as string;
    }

    beforeEach(async () => {
      await createDeposit(ether(1.0));
      subjectConversionRate = ether(1.0);
    });

    it("reverts when manager fee > MAX_MANAGER_FEE at signal", async () => {
      const { mock, mockId } = await deployBypassRegistryMock({
        fee: ether(0.20), // 20% > 5% cap
        recipient: managerFeeRecipient.address,
      });
      await rateManagerController.connect(depositor.wallet).setDepositRateManager(escrow.address, ZERO, mock.address, mockId);
      await expect(subjectSignal()).to.be.revertedWithCustomError(orchestrator, "FeeExceedsMaximum");
    });

    it("allows signal when manager fee == MAX_MANAGER_FEE", async () => {
      const { mock, mockId } = await deployBypassRegistryMock({
        fee: ether(0.05), // equal to the 5% cap
        recipient: managerFeeRecipient.address,
      });
      await rateManagerController.connect(depositor.wallet).setDepositRateManager(escrow.address, ZERO, mock.address, mockId);
      await expect(subjectSignal()).to.not.be.reverted;
    });
  });

});
