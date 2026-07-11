import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import { createSignalIntentParams } from "@utils/test/helpers";
import {
  EscrowRegistry,
  EscrowV2,
  OrchestratorRegistry,
  OrchestratorV2,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RateManagerMock,
  RelayerRegistry,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("OrchestratorV2", () => {
  let owner: any;
  let depositor: any;
  let taker: any;
  let managerFeeRecipient: any;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestrator: OrchestratorV2;
  let escrowRegistry: EscrowRegistry;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let relayerRegistry: RelayerRegistry;
  let verifier: PaymentVerifierMock;
  let rateManagerMock: RateManagerMock;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let rateManagerId: BytesLike;

  beforeEach(async () => {
    [owner, depositor, taker, managerFeeRecipient] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();
    escrowRegistry = await deployer.deployEscrowRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();

    verifier = await deployer.deployPaymentVerifierMock();
    rateManagerMock = await deployer.deployRateManagerMock();

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
    rateManagerId = ethers.utils.formatBytes32String("manager-v1");

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
      owner.address
    );

    await escrowRegistry.connect(owner.wallet).addEscrow(escrow.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(orchestrator.address);

    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

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

    await rateManagerMock.connect(owner.wallet).setManager(rateManagerId, true);
    await rateManagerMock.connect(owner.wallet).setFee(rateManagerId, managerFeeRecipient.address, ether(0.01));
    await rateManagerMock
      .connect(owner.wallet)
      .setRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, ether(1.2));

    await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);
  });

  describe("#signalIntent", () => {
    let subjectCaller: any;
    let subjectConversionRate: BigNumber;

    async function subject() {
      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        taker.address,
        paymentMethod,
        Currency.USD,
        subjectConversionRate,
        ADDRESS_ZERO,
        ZERO,
        null,
        "1",
        ADDRESS_ZERO,
        "0x",
        undefined,
        "0x"
      );
      return orchestrator.connect(subjectCaller.wallet).signalIntent(params);
    }

    beforeEach(async () => {
      subjectCaller = taker;
      subjectConversionRate = ether(1.2);
    });

    it("uses EscrowV2 delegated effective rate and snapshots manager fee", async () => {
      const tx = await subject();
      const receipt = await tx.wait();
      const feeEvent = receipt.events?.find((event: any) => event.event === "IntentManagerFeeSnapshotted");

      expect(feeEvent?.args?.feeRecipient).to.eq(managerFeeRecipient.address);
      expect(feeEvent?.args?.fee).to.eq(ether(0.01));
    });

    it("snapshots the onchain risk module and discounted protocol fee", async () => {
      const riskManagerMock = await (
        await ethers.getContractFactory("ProtocolRiskManagerMock", owner.wallet)
      ).deploy();
      await riskManagerMock.setFeeDiscountBps(5_000);
      await orchestrator.connect(owner.wallet).setProtocolFee(ether(0.01));
      await orchestrator.connect(owner.wallet).setRiskManager(riskManagerMock.address);

      const tx = await subject();
      const receipt = await tx.wait();
      const signalEvent = receipt.events?.find((event: any) => event.event === "IntentSignaled");
      const intentHash = signalEvent?.args?.intentHash;

      expect(await orchestrator.getIntentRiskManager(intentHash)).to.eq(riskManagerMock.address);
      expect(await orchestrator.getIntentProtocolFee(intentHash)).to.eq(ether(0.005));
      const context = await riskManagerMock.getSignalContext(intentHash);
      expect(context.taker).to.eq(taker.address);
      expect(context.maker).to.eq(depositor.address);
      expect(context.amount).to.eq(usdc(50));

      await orchestrator.connect(depositor.wallet).releaseFundsToPayer(intentHash);
      expect(await riskManagerMock.fulfilledAmounts(intentHash)).to.eq(usdc(50));
      expect(await riskManagerMock.paymentProofVerified(intentHash)).to.eq(false);
    });

    it("opens taking, rejects dead maker gates, and removes active intents in O(1)", async () => {
      const riskManagerMock = await (
        await ethers.getContractFactory("ProtocolRiskManagerMock", owner.wallet)
      ).deploy();
      await orchestrator.connect(owner.wallet).setRiskManager(riskManagerMock.address);

      await expect(
        orchestrator
          .connect(depositor.wallet)
          .setDepositPreIntentHook(escrow.address, ZERO, rateManagerMock.address),
      ).to.be.revertedWithCustomError(orchestrator, "LegacyEligibilityHookDisabled");

      const hashes: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const receipt = await (await subject()).wait();
        hashes.push(receipt.events?.find((event: any) => event.event === "IntentSignaled")?.args?.intentHash);
      }
      await orchestrator.connect(taker.wallet).cancelIntent(hashes[1]);

      const active = await orchestrator.getAccountIntents(taker.address);
      expect(active.length).to.eq(2);
      expect(active).to.include(hashes[0]);
      expect(active).to.include(hashes[2]);
    });

    it("prunes and unlocks when an abandonment callback fails", async () => {
      const riskManagerMock = await (
        await ethers.getContractFactory("ProtocolRiskManagerMock", owner.wallet)
      ).deploy();
      await orchestrator.connect(owner.wallet).setRiskManager(riskManagerMock.address);
      const receipt = await (await subject()).wait();
      const intentHash = receipt.events?.find((event: any) => event.event === "IntentSignaled")?.args?.intentHash;
      await riskManagerMock.setRevertOnAbandon(true);

      await expect(orchestrator.connect(taker.wallet).cancelIntent(intentHash))
        .to.emit(orchestrator, "IntentRiskCallbackFailed")
        .and.to.emit(orchestrator, "IntentPruned");
      expect(await orchestrator.hasActiveIntent(intentHash)).to.equal(false);
    });

    describe("when conversion rate is below delegated manager rate", () => {
      beforeEach(async () => {
        subjectConversionRate = ether(1.1);
      });

      it("reverts with RateBelowMinimum", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "RateBelowMinimum");
      });
    });

    describe("when delegated manager fee exceeds orchestrator max", () => {
      beforeEach(async () => {
        await rateManagerMock.connect(owner.wallet).setFee(rateManagerId, managerFeeRecipient.address, ether(0.06));
      });

      it("reverts with FeeExceedsMaximum", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "FeeExceedsMaximum");
      });
    });
  });

  describe("#fulfillIntent", () => {
    let intentHash: BytesLike;

    beforeEach(async () => {
      const signalParams = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        taker.address,
        paymentMethod,
        Currency.USD,
        ether(1.2),
        ADDRESS_ZERO,
        ZERO,
        null,
        "1",
        ADDRESS_ZERO,
        "0x",
        undefined,
        "0x"
      );

      const tx = await orchestrator.connect(taker.wallet).signalIntent(signalParams);
      const receipt = await tx.wait();
      const signaledEvent = receipt.events?.find((event: any) => event.event === "IntentSignaled");
      intentHash = signaledEvent?.args?.intentHash;
    });

    it("deducts manager fee and transfers net amount", async () => {
      const releaseAmount = usdc(50);
      const fiatAmount = releaseAmount.mul(ether(1.2)).div(ether(1));
      const timestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
      const paymentProof = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
        [fiatAmount, timestamp, payeeDetails, Currency.USD, intentHash]
      );

      const managerFeeBefore = await usdcToken.balanceOf(managerFeeRecipient.address);
      const takerBefore = await usdcToken.balanceOf(taker.address);

      await orchestrator.connect(owner.wallet).fulfillIntent({
        paymentProof,
        intentHash,
        verificationData: "0x",
        postIntentHookData: "0x",
      });

      const expectedManagerFee = releaseAmount.mul(ether(0.01)).div(ether(1));
      const expectedTakerNet = releaseAmount.sub(expectedManagerFee);

      const managerFeeAfter = await usdcToken.balanceOf(managerFeeRecipient.address);
      const takerAfter = await usdcToken.balanceOf(taker.address);

      expect(managerFeeAfter.sub(managerFeeBefore)).to.eq(expectedManagerFee);
      expect(takerAfter.sub(takerBefore)).to.eq(expectedTakerNet);
    });
  });
});
