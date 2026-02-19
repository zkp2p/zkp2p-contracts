import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import { createSignalIntentParams } from "@utils/test/helpers";
import {
  EscrowRegistry,
  EscrowV2,
  OrchestratorMock,
  OrchestratorRegistry,
  OrchestratorV2,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  PostIntentHookMock,
  PreIntentHookMock,
  RelayerRegistry,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("OrchestratorV2", () => {
  let owner: any;
  let depositor: any;
  let delegate: any;
  let taker: any;
  let other: any;
  let referrer: any;
  let protocolFeeRecipient: any;
  let gatingService: any;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestrator: OrchestratorV2;
  let escrowRegistry: EscrowRegistry;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let relayerRegistry: RelayerRegistry;
  let verifier: PaymentVerifierMock;
  let preIntentHookMock: PreIntentHookMock;
  let whitelistHookMock: PreIntentHookMock;
  let postIntentHookMock: PostIntentHookMock;
  let orchestratorMock: OrchestratorMock;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let depositId: BigNumber;

  async function createDeposit(intentGatingService: string = ADDRESS_ZERO): Promise<BigNumber> {
    const id = await escrow.depositCounter();
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(500),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [
        {
          intentGatingService,
          payeeDetails,
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
      delegate: delegate.address,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
    return id;
  }

  async function signalIntent(args?: {
    subjectCaller?: any;
    subjectDepositId?: BigNumber;
    subjectAmount?: BigNumber;
    subjectTo?: string;
    subjectConversionRate?: BigNumber;
    subjectReferrer?: string;
    subjectReferrerFee?: BigNumber;
    subjectGatingService?: any | null;
    subjectSignatureExpiration?: BigNumber;
    subjectPostIntentHook?: string;
    subjectData?: string;
  }) {
    const subjectCaller = args?.subjectCaller ?? taker;
    const subjectDepositId = args?.subjectDepositId ?? depositId;
    const subjectAmount = args?.subjectAmount ?? usdc(50);
    const subjectTo = args?.subjectTo ?? taker.address;
    const subjectConversionRate = args?.subjectConversionRate ?? ether(1);
    const subjectReferrer = args?.subjectReferrer ?? ADDRESS_ZERO;
    const subjectReferrerFee = args?.subjectReferrerFee ?? ZERO;
    const subjectGatingService = args?.subjectGatingService ?? null;
    const subjectSignatureExpiration = args?.subjectSignatureExpiration;
    const subjectPostIntentHook = args?.subjectPostIntentHook ?? ADDRESS_ZERO;
    const subjectData = args?.subjectData ?? "0x";

    const params = await createSignalIntentParams(
      orchestrator.address,
      escrow.address,
      subjectDepositId,
      subjectAmount,
      subjectTo,
      paymentMethod,
      Currency.USD,
      subjectConversionRate,
      subjectReferrer,
      subjectReferrerFee,
      subjectGatingService,
      "1",
      subjectPostIntentHook,
      subjectData,
      subjectSignatureExpiration,
      "0x"
    );

    const tx = await orchestrator.connect(subjectCaller.wallet).signalIntent(params);
    const receipt = await tx.wait();
    const event = receipt.events?.find((item: any) => item.event === "IntentSignaled");
    return event?.args?.intentHash;
  }

  async function fulfillIntent(intentHash: BytesLike, conversionRate: BigNumber = ether(1), releaseAmount: BigNumber = usdc(50)) {
    const fiatAmount = releaseAmount.mul(conversionRate).div(ether(1));
    const timestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
    const paymentProof = ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
      [fiatAmount, timestamp, payeeDetails, Currency.USD, intentHash]
    );

    return orchestrator.connect(owner.wallet).fulfillIntent({
      paymentProof,
      intentHash,
      verificationData: "0x",
      postIntentHookData: "0x",
    });
  }

  beforeEach(async () => {
    [owner, depositor, delegate, taker, other, referrer, protocolFeeRecipient, gatingService] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();
    escrowRegistry = await deployer.deployEscrowRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();

    verifier = await deployer.deployPaymentVerifierMock();
    preIntentHookMock = await deployer.deployPreIntentHookMock();
    whitelistHookMock = await deployer.deployPreIntentHookMock();

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

    orchestrator = await deployer.deployOrchestratorV2(
      owner.address,
      ONE,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      ZERO,
      protocolFeeRecipient.address
    );

    postIntentHookMock = await deployer.deployPostIntentHookMock(usdcToken.address, orchestrator.address);
    orchestratorMock = await deployer.deployOrchestratorMock(escrow.address);

    await escrowRegistry.connect(owner.wallet).addEscrow(escrow.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(orchestrator.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(orchestratorMock.address);

    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(100_000));
    depositId = await createDeposit();
  });

  describe("#cancelIntent", () => {
    let intentHash: BytesLike;

    beforeEach(async () => {
      intentHash = await signalIntent();
    });

    it("cancels intent and unlocks escrow funds", async () => {
      await expect(orchestrator.connect(taker.wallet).cancelIntent(intentHash)).to.emit(orchestrator, "IntentPruned");
      const intent = await orchestrator.getIntent(intentHash);
      expect(intent.owner).to.eq(ADDRESS_ZERO);
    });

    it("reverts when intent does not exist", async () => {
      await expect(
        orchestrator.connect(taker.wallet).cancelIntent(ethers.utils.formatBytes32String("missing"))
      ).to.be.revertedWithCustomError(orchestrator, "IntentNotFound");
    });

    it("reverts when caller is not intent owner", async () => {
      await expect(
        orchestrator.connect(other.wallet).cancelIntent(intentHash)
      ).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCaller");
    });
  });

  describe("hook setters and execution", () => {
    it("sets pre-intent hook", async () => {
      await expect(
        orchestrator.connect(depositor.wallet).setDepositPreIntentHook(escrow.address, depositId, preIntentHookMock.address)
      ).to.emit(orchestrator, "DepositPreIntentHookSet");
    });

    it("sets whitelist hook", async () => {
      await expect(
        orchestrator.connect(depositor.wallet).setDepositWhitelistHook(escrow.address, depositId, whitelistHookMock.address)
      ).to.emit(orchestrator, "DepositWhitelistHookSet");
    });

    it("reverts hook setter when caller is unauthorized", async () => {
      await expect(
        orchestrator.connect(other.wallet).setDepositPreIntentHook(escrow.address, depositId, preIntentHookMock.address)
      ).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCallerOrDelegate");
    });

    it("reverts hook setter when escrow is zero", async () => {
      await expect(
        orchestrator.connect(depositor.wallet).setDepositPreIntentHook(ADDRESS_ZERO, depositId, preIntentHookMock.address)
      ).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
    });

    it("reverts hook setter when hook is an EOA", async () => {
      await expect(
        orchestrator.connect(depositor.wallet).setDepositPreIntentHook(escrow.address, depositId, other.address)
      ).to.be.revertedWithCustomError(orchestrator, "InvalidPreIntentHook");
    });

    it("executes both pre and whitelist hooks during signalIntent", async () => {
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(escrow.address, depositId, preIntentHookMock.address);
      await orchestrator.connect(depositor.wallet).setDepositWhitelistHook(escrow.address, depositId, whitelistHookMock.address);

      await signalIntent();

      expect(await preIntentHookMock.callCount()).to.eq(1);
      expect(await whitelistHookMock.callCount()).to.eq(1);
    });

    it("exposes configured hooks via getters", async () => {
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(escrow.address, depositId, preIntentHookMock.address);
      await orchestrator.connect(depositor.wallet).setDepositWhitelistHook(escrow.address, depositId, whitelistHookMock.address);

      expect(await orchestrator.getDepositPreIntentHook(escrow.address, depositId)).to.eq(preIntentHookMock.address);
      expect(await orchestrator.getDepositWhitelistHook(escrow.address, depositId)).to.eq(whitelistHookMock.address);
    });
  });

  describe("#releaseFundsToPayer", () => {
    it("releases funds from depositor to taker", async () => {
      const intentHash = await signalIntent();
      await expect(
        orchestrator.connect(depositor.wallet).releaseFundsToPayer(intentHash)
      ).to.emit(orchestrator, "IntentFulfilled");
    });

    it("applies protocol and referrer fees on manual release", async () => {
      await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.01));
      const intentHash = await signalIntent({
        subjectReferrer: referrer.address,
        subjectReferrerFee: ether(0.005),
      });

      const protocolBefore = await usdcToken.balanceOf(protocolFeeRecipient.address);
      const referrerBefore = await usdcToken.balanceOf(referrer.address);

      await orchestrator.connect(depositor.wallet).releaseFundsToPayer(intentHash);

      const protocolAfter = await usdcToken.balanceOf(protocolFeeRecipient.address);
      const referrerAfter = await usdcToken.balanceOf(referrer.address);
      expect(protocolAfter).to.be.gt(protocolBefore);
      expect(referrerAfter).to.be.gt(referrerBefore);
    });
  });

  describe("#fulfillIntent", () => {
    it("reverts when verifier release amount is below min-at-signal", async () => {
      const intentHash = await signalIntent();
      const timestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
      const paymentProof = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
        [usdc(5), timestamp, payeeDetails, Currency.USD, intentHash]
      );

      await expect(
        orchestrator.connect(owner.wallet).fulfillIntent({
          paymentProof,
          intentHash,
          verificationData: "0x",
          postIntentHookData: "0x",
        })
      ).to.be.revertedWithCustomError(orchestrator, "AmountBelowMin");
    });
  });

  describe("pruning paths", () => {
    it("prunes intents when called by escrow", async () => {
      const intentHash = await signalIntent();
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      await escrow.connect(other.wallet).pruneExpiredIntents(depositId);

      const prunedIntent = await orchestrator.getIntent(intentHash);
      expect(prunedIntent.owner).to.eq(ADDRESS_ZERO);
    });

    it("cleans up orphaned intents", async () => {
      const intentHash = await signalIntent();

      await orchestratorMock.connect(owner.wallet).unlockFunds(depositId, intentHash);
      await orchestrator.connect(other.wallet).cleanupOrphanedIntents([intentHash]);

      const prunedIntent = await orchestrator.getIntent(intentHash);
      expect(prunedIntent.owner).to.eq(ADDRESS_ZERO);
    });
  });

  describe("governance and views", () => {
    it("updates registry and fee configuration", async () => {
      const newEscrowRegistry = await deployer.deployEscrowRegistry();
      const newRelayerRegistry = await deployer.deployRelayerRegistry();

      await expect(orchestrator.connect(owner.wallet).setEscrowRegistry(newEscrowRegistry.address))
        .to.emit(orchestrator, "EscrowRegistryUpdated")
        .withArgs(newEscrowRegistry.address);
      await expect(orchestrator.connect(owner.wallet).setProtocolFee(ether(0.01)))
        .to.emit(orchestrator, "ProtocolFeeUpdated")
        .withArgs(ether(0.01));
      await expect(orchestrator.connect(owner.wallet).setProtocolFeeRecipient(other.address))
        .to.emit(orchestrator, "ProtocolFeeRecipientUpdated")
        .withArgs(other.address);
      await expect(orchestrator.connect(owner.wallet).setAllowMultipleIntents(true))
        .to.emit(orchestrator, "AllowMultipleIntentsUpdated")
        .withArgs(true);
      await expect(orchestrator.connect(owner.wallet).setRelayerRegistry(newRelayerRegistry.address))
        .to.emit(orchestrator, "RelayerRegistryUpdated")
        .withArgs(newRelayerRegistry.address);

      await orchestrator.connect(owner.wallet).pauseOrchestrator();
      expect(await orchestrator.paused()).to.eq(true);
      await orchestrator.connect(owner.wallet).unpauseOrchestrator();
      expect(await orchestrator.paused()).to.eq(false);
    });

    it("returns account intents and min-at-signal snapshot", async () => {
      const intentHash = await signalIntent();
      const accountIntents = await orchestrator.getAccountIntents(taker.address);
      expect(accountIntents[0]).to.eq(intentHash);
      expect(await orchestrator.getIntentMinAtSignal(intentHash)).to.eq(usdc(10));
    });
  });

  describe("signal validations and post-intent hook path", () => {
    it("reverts when account already has an active intent", async () => {
      await signalIntent({ subjectCaller: taker });

      await expect(
        signalIntent({ subjectCaller: taker })
      ).to.be.revertedWithCustomError(orchestrator, "AccountHasActiveIntent");
    });

    it("reverts when escrow is not whitelisted", async () => {
      await escrowRegistry.connect(owner.wallet).removeEscrow(escrow.address);

      await expect(
        signalIntent()
      ).to.be.revertedWithCustomError(orchestrator, "EscrowNotWhitelisted");
    });

    it("reverts when post-intent hook is an EOA", async () => {
      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        depositId,
        usdc(50),
        taker.address,
        paymentMethod,
        Currency.USD,
        ether(1),
        ADDRESS_ZERO,
        ZERO,
        null,
        "1",
        other.address,
        "0x",
        undefined,
        "0x"
      );

      await expect(
        orchestrator.connect(taker.wallet).signalIntent(params)
      ).to.be.revertedWithCustomError(orchestrator, "InvalidPostIntentHook");
    });

    it("executes post-intent hook flow on fulfill", async () => {
      const target = other.address;
      const intentHash = await signalIntent({
        subjectPostIntentHook: postIntentHookMock.address,
        subjectData: ethers.utils.defaultAbiCoder.encode(["address"], [target]),
      });

      const targetBefore = await usdcToken.balanceOf(target);
      await fulfillIntent(intentHash);
      const targetAfter = await usdcToken.balanceOf(target);

      expect(targetAfter).to.be.gt(targetBefore);
    });
  });

  describe("gating signature validation", () => {
    let gatedDepositId: BigNumber;

    beforeEach(async () => {
      gatedDepositId = await createDeposit(gatingService.address);
    });

    it("accepts valid gating service signature", async () => {
      await expect(
        signalIntent({ subjectDepositId: gatedDepositId, subjectGatingService: gatingService })
      ).to.not.be.reverted;
    });

    it("reverts when signature is expired", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const expired = BigNumber.from(currentTimestamp - 1);

      await expect(
        signalIntent({
          subjectDepositId: gatedDepositId,
          subjectGatingService: gatingService,
          subjectSignatureExpiration: expired,
        })
      ).to.be.revertedWithCustomError(orchestrator, "SignatureExpired");
    });

    it("reverts when signature signer is invalid", async () => {
      await expect(
        signalIntent({ subjectDepositId: gatedDepositId, subjectGatingService: owner })
      ).to.be.revertedWithCustomError(orchestrator, "InvalidSignature");
    });
  });
});
