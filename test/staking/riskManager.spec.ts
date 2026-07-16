import "module-alias/register";

import { expect } from "chai";
import { BigNumber, Contract, ContractReceipt } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { buildUnifiedPaymentProof } from "@utils/unifiedVerifierUtils";

const usdc = (amount: string | number) => ethers.utils.parseUnits(String(amount), 6);
const precise = (amount: string | number) => ethers.utils.parseEther(String(amount));
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_INTENT_PERIOD = 6 * HOUR;
const GRIEFING_CLIFF = 15 * MINUTE;
const GRIEFING_SLOPE = 10;
const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));
const USD = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
const PAYEE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("maker-payee"));
const ZERO = ethers.constants.AddressZero;

describe("RiskManager and OrchestratorV3", () => {
  async function deployFixture() {
    const [owner, maker, makerDelegate, taker, secondTaker, recipient, other, witness] =
      await ethers.getSigners();
    const network = await ethers.provider.getNetwork();

    const token = await (await ethers.getContractFactory("USDCMock"))
      .deploy(usdc(1_000_000), "USD Coin", "USDC");
    const paymentVerifierRegistry = await (await ethers.getContractFactory("PaymentVerifierRegistry")).deploy();
    const escrowRegistry = await (await ethers.getContractFactory("EscrowRegistry")).deploy();
    const relayerRegistry = await (await ethers.getContractFactory("RelayerRegistry")).deploy();
    const orchestratorRegistry = await (await ethers.getContractFactory("OrchestratorRegistry")).deploy();
    const verifier = await (await ethers.getContractFactory("PaymentVerifierV3Mock")).deploy();
    const attestationVerifier = await (await ethers.getContractFactory("AttestationVerifierMock")).deploy();

    await paymentVerifierRegistry.addPaymentMethod(PAYPAL, verifier.address, [USD]);
    await paymentVerifierRegistry.addPaymentMethod(ZELLE, verifier.address, [USD]);

    const escrow = await (await ethers.getContractFactory("EscrowV2")).deploy(
      owner.address,
      network.chainId,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      0,
      100,
      MAX_INTENT_PERIOD,
    );
    const boundedCall = await (await ethers.getContractFactory("BoundedCall")).deploy();
    const postIntentHookExecutor = await (await ethers.getContractFactory("PostIntentHookExecutor")).deploy();
    const orchestratorV3Validation = await (await ethers.getContractFactory("OrchestratorV3Validation")).deploy();
    const orchestratorV3FeeLib = await (await ethers.getContractFactory("OrchestratorV3FeeLib")).deploy();
    const riskCallbackRecorder = await (await ethers.getContractFactory("RiskCallbackRecorder")).deploy();
    const orchestratorV3RiskLib = await (await ethers.getContractFactory("OrchestratorV3RiskLib", {
      libraries: {
        BoundedCall: boundedCall.address,
        RiskCallbackRecorder: riskCallbackRecorder.address,
      },
    })).deploy();
    const orchestrator = await (await ethers.getContractFactory("OrchestratorV3", {
      libraries: {
        BoundedCall: boundedCall.address,
        PostIntentHookExecutor: postIntentHookExecutor.address,
        OrchestratorV3Validation: orchestratorV3Validation.address,
        OrchestratorV3FeeLib: orchestratorV3FeeLib.address,
        OrchestratorV3RiskLib: orchestratorV3RiskLib.address,
      },
    })).deploy(
      owner.address,
      network.chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      0,
      owner.address,
      2_000_000,
    );
    const vault = await (await ethers.getContractFactory("StakeVault")).deploy(
      owner.address,
      token.address,
      ZERO,
      30 * DAY,
      DAY,
    );
    const manager = await (await ethers.getContractFactory("RiskManager")).deploy(
      owner.address,
      orchestrator.address,
      vault.address,
      attestationVerifier.address,
    );
    const deferredHook = await (await ethers.getContractFactory("DeferredPayoutHook")).deploy(
      token.address,
      vault.address,
      manager.address,
      orchestratorRegistry.address,
    );

    await manager.setDeferredPayoutHook(deferredHook.address);
    await vault.proposeController(manager.address);
    await time.increase(DAY);
    await manager.acceptVaultController();

    await escrowRegistry.addEscrow(escrow.address);
    await orchestratorRegistry.addOrchestrator(orchestrator.address);
    await orchestrator.setAllowMultipleIntents(true);
    await manager.setPlatformRiskConfig(ZELLE, {
      enabled: true,
      chargeback: {
        chargebackable: false,
        deferredPayoutEnabled: false,
        reserveBps: 0,
        riskWindow: 0,
      },
      griefing: {
        griefingCliff: GRIEFING_CLIFF,
        griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
        freeTakeCount: 2,
        freeTakeAmount: usdc(20),
      },
    });
    await manager.setPlatformRiskConfig(PAYPAL, {
      enabled: true,
      chargeback: {
        chargebackable: true,
        deferredPayoutEnabled: true,
        reserveBps: 10_000,
        riskWindow: 30 * DAY,
      },
      griefing: {
        griefingCliff: GRIEFING_CLIFF,
        griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
        freeTakeCount: 0,
        freeTakeAmount: 0,
      },
    });

    await token.transfer(maker.address, usdc(100_000));
    await token.transfer(taker.address, usdc(20_000));
    await token.transfer(secondTaker.address, usdc(20_000));
    await token.connect(maker).approve(escrow.address, ethers.constants.MaxUint256);
    await token.connect(taker).approve(vault.address, ethers.constants.MaxUint256);
    await token.connect(secondTaker).approve(vault.address, ethers.constants.MaxUint256);

    await escrow.connect(maker).createDeposit({
      token: token.address,
      amount: usdc(50_000),
      intentAmountRange: { min: usdc(1), max: usdc(10_000) },
      paymentMethods: [PAYPAL, ZELLE],
      paymentMethodData: [
        { intentGatingService: ZERO, payeeDetails: PAYEE, data: "0x" },
        { intentGatingService: ZERO, payeeDetails: PAYEE, data: "0x" },
      ],
      currencies: [
        [{ code: USD, minConversionRate: precise(1), oracleRateConfig: {
          adapter: ZERO, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0,
        } }],
        [{ code: USD, minConversionRate: precise(1), oracleRateConfig: {
          adapter: ZERO, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0,
        } }],
      ],
      delegate: makerDelegate.address,
      intentGuardian: makerDelegate.address,
      retainOnEmpty: true,
    });
    await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, manager.address);

    return {
      owner,
      maker,
      makerDelegate,
      taker,
      secondTaker,
      recipient,
      other,
      witness,
      network,
      token,
      escrow,
      orchestrator,
      vault,
      manager,
      deferredHook,
      orchestratorRegistry,
      paymentVerifierRegistry,
      verifier,
      boundedCall,
      attestationVerifier,
    };
  }

  function signalParams(
    escrow: Contract,
    recipient: string,
    amount: BigNumber,
    paymentMethod: string,
    settlementHook = ZERO,
    referralFees: Array<{ recipient: string; fee: BigNumber }> = [],
  ) {
    return {
      escrow: escrow.address,
      depositId: 0,
      amount,
      to: recipient,
      paymentMethod,
      fiatCurrency: USD,
      conversionRate: precise(1),
      referralFees,
      gatingServiceSignature: "0x",
      signatureExpiration: 0,
      settlementHook,
      preIntentHookData: "0x",
      data: "0x",
    };
  }

  function intentHashFrom(receipt: ContractReceipt): string {
    const event = receipt.events?.find((candidate) => candidate.event === "IntentSignaled");
    if (!event?.args?.intentHash) throw new Error("IntentSignaled event missing");
    return event.args.intentHash;
  }

  async function signalIntent(
    orchestrator: Contract,
    escrow: Contract,
    taker: any,
    amount: BigNumber,
    paymentMethod: string,
    settlementHook = ZERO,
    recipient = taker.address,
  ): Promise<string> {
    const tx = await orchestrator.connect(taker).signalIntent(
      signalParams(escrow, recipient, amount, paymentMethod, settlementHook),
    );
    return intentHashFrom(await tx.wait());
  }

  async function fulfillIntent(orchestrator: Contract, intentHash: string, releaseAmount: BigNumber) {
    const proof = ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
      [releaseAmount, await time.latest(), PAYEE, USD, intentHash],
    );
    return orchestrator.fulfillIntent({
      paymentProof: proof,
      intentHash,
      verificationData: "0x",
      settlementHookData: "0x",
    });
  }

  async function chargebackAttestation(
    intentHash: string,
    disputeId = ethers.utils.id(`dispute-${intentHash}`),
    originalPaymentId = ethers.utils.keccak256(
      ethers.utils.solidityPack(["string", "bytes32"], ["payment", intentHash]),
    ),
  ) {
    return {
      intentHash,
      originalPaymentId,
      disputeId,
      signatures: [],
    };
  }

  describe("configuration and exact formulas", () => {
    it("rejects a deferred hook with a zero dependency", async () => {
      const { vault, manager, deferredHook, orchestratorRegistry } = await loadFixture(deployFixture);
      await expect((await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        ZERO,
        vault.address,
        manager.address,
        orchestratorRegistry.address,
      )).to.be.revertedWithCustomError(deferredHook, "ZeroAddress");
    });

    it("rejects a deferred hook payout token without deployed code", async () => {
      const { other, vault, manager, deferredHook, orchestratorRegistry } = await loadFixture(deployFixture);
      await expect((await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        other.address,
        vault.address,
        manager.address,
        orchestratorRegistry.address,
      )).to.be.revertedWithCustomError(deferredHook, "InvalidContract");
    });

    it("rejects a deferred hook stake vault without deployed code", async () => {
      const { other, token, manager, deferredHook, orchestratorRegistry } = await loadFixture(deployFixture);
      await expect((await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        token.address,
        other.address,
        manager.address,
        orchestratorRegistry.address,
      )).to.be.revertedWithCustomError(deferredHook, "InvalidContract");
    });

    it("rejects a deferred hook risk manager without deployed code", async () => {
      const { other, token, vault, deferredHook, orchestratorRegistry } = await loadFixture(deployFixture);
      await expect((await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        token.address,
        vault.address,
        other.address,
        orchestratorRegistry.address,
      )).to.be.revertedWithCustomError(deferredHook, "InvalidContract");
    });

    it("rejects a deferred hook orchestrator registry without deployed code", async () => {
      const { other, token, vault, manager, deferredHook } = await loadFixture(deployFixture);
      await expect((await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        token.address,
        vault.address,
        manager.address,
        other.address,
      )).to.be.revertedWithCustomError(deferredHook, "InvalidContract");
    });

    it("rejects a deferred hook wired to another manager vault", async () => {
      const { owner, token, manager, deferredHook, orchestratorRegistry, vault } = await loadFixture(deployFixture);
      const otherVault = await (await ethers.getContractFactory("StakeVault")).deploy(
        owner.address,
        token.address,
        ZERO,
        30 * DAY,
        DAY,
      );
      await expect((await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        token.address,
        otherVault.address,
        manager.address,
        orchestratorRegistry.address,
      )).to.be.revertedWithCustomError(deferredHook, "RiskManagerStakeVaultMismatch");
    });

    it("rejects a deferred hook token that differs from the vault token", async () => {
      const { vault, manager, deferredHook, orchestratorRegistry } = await loadFixture(deployFixture);
      const otherToken = await (await ethers.getContractFactory("USDCMock"))
        .deploy(usdc(1), "Other Token", "OTHER");
      await expect((await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        otherToken.address,
        vault.address,
        manager.address,
        orchestratorRegistry.address,
      )).to.be.revertedWithCustomError(deferredHook, "InvalidPayoutToken");
    });

    it("rejects a chargeback reserve above 100 percent", async () => {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_001, riskWindow: DAY },
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, freeTakeCount: 0, freeTakeAmount: 0 },
      })).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("accepts deferred payout for a chargebackable platform", async () => {
      const { manager } = await loadFixture(deployFixture);
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: true, reserveBps: 10_000, riskWindow: DAY },
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, freeTakeCount: 0, freeTakeAmount: 0 },
      });
      expect((await manager.getPlatformRiskConfig(PAYPAL)).chargeback.deferredPayoutEnabled).to.eq(true);
    });

    it("rejects free takes on a chargebackable platform", async () => {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_000, riskWindow: DAY },
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, freeTakeCount: 1, freeTakeAmount: 1 },
      })).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("rejects a free-take count without a free-take amount", async () => {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.setPlatformRiskConfig(ZELLE, {
        enabled: true,
        chargeback: { chargebackable: false, deferredPayoutEnabled: false, reserveBps: 0, riskWindow: 0 },
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, freeTakeCount: 1, freeTakeAmount: 0 },
      })).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("calculates the illustrative 5.75 USDC maximum griefing bond", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateMaxGriefingBond(usdc(1_000), MAX_INTENT_PERIOD, {
        griefingCliff: GRIEFING_CLIFF,
        griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
        freeTakeCount: 0,
        freeTakeAmount: 0,
      })).to.eq(usdc("5.75"));
    });

    it("rounds a chargeback reserve upward", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateChargebackReserve(101, 5_000)).to.eq(51);
    });

    it("uses the maximum rather than the sum of both reservations", async () => {
      const { manager } = await loadFixture(deployFixture);
      const config = await manager.getPlatformRiskConfig(PAYPAL);
      const result = await manager.calculateRequiredReservation(usdc(1_000), MAX_INTENT_PERIOD, config);
      expect(result.maxGriefingBond).to.eq(usdc("5.75"));
      expect(result.chargebackReserve).to.eq(usdc(1_000));
      expect(result.requiredReservation).to.eq(usdc(1_000));
    });

    it("rejects a risk-hook update for an escrow address without deployed code", async () => {
      const { maker, other, orchestrator } = await loadFixture(deployFixture);
      await expect(orchestrator.connect(maker).setDepositRiskHook(other.address, 0, ZERO))
        .to.be.revertedWithCustomError(orchestrator, "InvalidContract");
    });

    it("rejects a risk-hook address without deployed code", async () => {
      const { maker, other, escrow, orchestrator } = await loadFixture(deployFixture);
      await expect(orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, other.address))
        .to.be.revertedWithCustomError(orchestrator, "InvalidRiskHook");
    });

    it("rejects a risk-hook update from someone other than the depositor or delegate", async () => {
      const { other, escrow, orchestrator } = await loadFixture(deployFixture);
      await expect(orchestrator.connect(other).setDepositRiskHook(escrow.address, 0, ZERO))
        .to.be.revertedWithCustomError(orchestrator, "UnauthorizedCallerOrDelegate");
    });

    it("rejects deferred-hook execution from an unregistered caller", async () => {
      const { other, token, escrow, deferredHook } = await loadFixture(deployFixture);
      const hookContext = {
        intentHash: ethers.utils.id("unauthorized-deferred-hook"),
        token: token.address,
        executableAmount: 1,
        intent: {
          owner: other.address,
          to: other.address,
          escrow: escrow.address,
          depositId: 0,
          amount: 1,
          timestamp: await time.latest(),
          paymentMethod: PAYPAL,
          fiatCurrency: USD,
          conversionRate: precise(1),
          payeeId: PAYEE,
          signalHookData: "0x",
        },
      };
      await expect(deferredHook.connect(other).execute(hookContext, "0x"))
        .to.be.revertedWithCustomError(deferredHook, "UnauthorizedOrchestrator");
    });
  });

  describe("free takes", () => {
    it("admits an eligible whole intent without stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.mode).to.eq(1);
      expect(position.consumedFreeTake).to.eq(true);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect(await manager.freeTakesUsed(taker.address, ZELLE)).to.eq(1);
    });

    it("does not restore a free take after cancellation", async () => {
      const { taker, escrow, orchestrator, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await manager.freeTakesUsed(taker.address, ZELLE)).to.eq(1);
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(2);
    });

    it("cancels a free intent after the griefing cliff without charging stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await time.increase(GRIEFING_CLIFF + 1);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(2);
      expect(position.slashedAmount).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("expires a free intent after the griefing cliff without charging stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await time.increase(MAX_INTENT_PERIOD + 1);
      await escrow.pruneExpiredIntents(0);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(2);
      expect(position.slashedAmount).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("does not apply a partial free tranche to a larger intent", async () => {
      const { taker, escrow, orchestrator, manager } = await loadFixture(deployFixture);
      await expect(signalIntent(orchestrator, escrow, taker, usdc(21), ZELLE))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
      expect(await manager.freeTakesUsed(taker.address, ZELLE)).to.eq(0);
    });

    it("shares lifetime allowances across relayers using one stake owner", async () => {
      const { owner: safe, taker, secondTaker, escrow, orchestrator, vault, manager } =
        await loadFixture(deployFixture);
      await vault.connect(safe).setTakerAuthorization(taker.address, true);
      await vault.connect(safe).setTakerAuthorization(secondTaker.address, true);
      await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await signalIntent(orchestrator, escrow, secondTaker, usdc(20), ZELLE);
      expect(await manager.freeTakesUsed(safe.address, ZELLE)).to.eq(2);
      await expect(signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });
  });

  describe("admission and portfolio reservations", () => {
    it("uses a delegated Safe as the shared stake owner", async () => {
      const { owner: safe, taker, escrow, orchestrator, token, vault, manager } = await loadFixture(deployFixture);
      await token.connect(safe).approve(vault.address, ethers.constants.MaxUint256);
      await vault.connect(safe).depositStakeFor(taker.address, usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.stakeOwner).to.eq(safe.address);
      expect(await vault.reservedStake(safe.address)).to.eq(usdc(500));
      expect(await vault.stakeBalance(taker.address)).to.eq(0);
    });

    it("admits multiple intents based only on shared free stake", async () => {
      const { taker, escrow, orchestrator, vault } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_500));
      await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(1_500));
    });

    it("rejects only when the shared portfolio reservation exceeds free stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(999));
      await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await expect(signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("snapshots platform policy before governance changes", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_000, riskWindow: DAY },
        griefing: {
          griefingCliff: GRIEFING_CLIFF,
          griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
          freeTakeCount: 0,
          freeTakeAmount: 0,
        },
      });
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_000, riskWindow: 30 * DAY },
        griefing: {
          griefingCliff: 30 * MINUTE,
          griefingPenaltyBpsPerHour: 20,
          freeTakeCount: 0,
          freeTakeAmount: 0,
        },
      });
      const position = await manager.getRiskPosition(intentHash);
      expect(position.chargebackReserveBps).to.eq(10_000);
      expect(position.riskWindow).to.eq(DAY);
      expect(position.griefingCliff).to.eq(GRIEFING_CLIFF);
    });
  });

  describe("cancellation penalties", () => {
    it("releases the complete reservation when cancelled at the cliff", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), PAYPAL);
      const createdAt = (await manager.getRiskPosition(intentHash)).createdAt.toNumber();
      await time.increaseTo(createdAt + GRIEFING_CLIFF);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect(await vault.claimableCompensation((await manager.getRiskPosition(intentHash)).lp)).to.eq(0);
    });

    it("charges the time-linear penalty after the cliff and releases the remainder", async () => {
      const { maker, taker, escrow, orchestrator, token, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), PAYPAL);
      const createdAt = (await manager.getRiskPosition(intentHash)).createdAt.toNumber();
      await time.increaseTo(createdAt + 2 * HOUR);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc("1.75"));
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc("998.25"));
      expect((await manager.getRiskPosition(intentHash)).slashedAmount).to.eq(usdc("1.75"));
    });

    it("caps a guardian-extended intent penalty at the snapshotted maximum period", async () => {
      const { maker, makerDelegate, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      await escrow.connect(makerDelegate).extendIntentExpiry(0, intentHash, DAY);
      const createdAt = (await manager.getRiskPosition(intentHash)).createdAt.toNumber();
      await time.increaseTo(createdAt + DAY);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc("5.75"));
    });

    it("records the original cancellation time when a terminal callback fails", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const mock = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, mock.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(10), ZELLE);
      await mock.setRevertOnTerminal(true);
      const before = await time.latest();
      await orchestrator.connect(taker).cancelIntent(intentHash);
      const cancelledAt = await orchestrator.getIntentCancellation(intentHash);
      expect(cancelledAt).to.be.gte(before);
      expect(cancelledAt).to.eq(await time.latest());
    });

    it("records released amount and time when a settlement callback fails", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const mock = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, mock.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(10), ZELLE);
      await mock.setRevertOnTerminal(true);
      const before = await time.latest();
      await fulfillIntent(orchestrator, intentHash, usdc(10));

      const settlement = await orchestrator.getIntentSettlement(intentHash);
      expect(settlement.releasedAmount).to.eq(usdc(10));
      expect(settlement.settledAt).to.be.gte(before);
      expect(settlement.settledAt).to.eq(await time.latest());
    });
  });

  describe("settlement and chargeback coverage", () => {
    it("releases a non-chargebackable griefing bond on fulfillment", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      await fulfillIntent(orchestrator, intentHash, usdc(1_000));
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(4);
    });

    it("resizes stake coverage from intent amount to exact released amount", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(600));
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(3);
      expect(position.reservedAmount).to.eq(usdc(600));
      expect(position.paymentId).to.eq(ethers.utils.keccak256(
        ethers.utils.solidityPack(["string", "bytes32"], ["payment", intentHash]),
      ));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(600));
    });

    it("uses the verifier selected at fulfillment and stores its authenticated payment ID", async () => {
      const {
        taker,
        escrow,
        orchestrator,
        vault,
        manager,
        paymentVerifierRegistry,
      } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);

      const replacement = await (await ethers.getContractFactory("PaymentVerifierV3Mock")).deploy();
      const replacementPaymentId = ethers.utils.id("replacement-verifier-payment");
      await replacement.setPaymentId(replacementPaymentId);
      await paymentVerifierRegistry.removePaymentMethod(PAYPAL);
      await paymentVerifierRegistry.addPaymentMethod(PAYPAL, replacement.address, [USD]);

      await fulfillIntent(orchestrator, intentHash, usdc(500));
      expect((await manager.getRiskPosition(intentHash)).paymentId).to.eq(replacementPaymentId);
    });

    it("propagates a real UnifiedPaymentVerifierV3 result through OrchestratorV3", async () => {
      const {
        owner,
        witness,
        taker,
        escrow,
        orchestrator,
        vault,
        manager,
        orchestratorRegistry,
        paymentVerifierRegistry,
      } = await loadFixture(deployFixture);
      const nullifierRegistry = await (await ethers.getContractFactory("NullifierRegistry")).deploy();
      const paymentAttestationVerifier = await (
        await ethers.getContractFactory("SimpleAttestationVerifier")
      ).deploy(witness.address);
      const unifiedVerifier = await (
        await ethers.getContractFactory("UnifiedPaymentVerifierV3")
      ).deploy(orchestratorRegistry.address, nullifierRegistry.address, paymentAttestationVerifier.address);
      await nullifierRegistry.addWritePermission(unifiedVerifier.address);
      await unifiedVerifier.addPaymentMethod(PAYPAL);
      await paymentVerifierRegistry.removePaymentMethod(PAYPAL);
      await paymentVerifierRegistry.addPaymentMethod(PAYPAL, unifiedVerifier.address, [USD]);

      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const intent = await orchestrator.getIntent(intentHash);
      const paymentId = ethers.utils.id("real-unified-verifier-payment");
      const proof = await buildUnifiedPaymentProof({
        verifier: unifiedVerifier.address,
        witness: { address: witness.address, wallet: witness } as any,
        chainId: (await ethers.provider.getNetwork()).chainId,
        paymentPaymentMethod: PAYPAL,
        paymentPayeeId: PAYEE,
        paymentAmount: usdc(500),
        paymentCurrency: USD,
        paymentTimestamp: BigNumber.from(intent.timestamp).mul(1000),
        paymentPaymentId: paymentId,
        attestationIntentHash: intentHash,
        attestationReleaseAmount: usdc(500),
        snapshotIntentHash: intentHash,
        snapshotIntentAmount: intent.amount,
        snapshotIntentPaymentMethod: PAYPAL,
        snapshotIntentFiatCurrency: USD,
        snapshotIntentPayeeDetails: PAYEE,
        snapshotIntentConversionRate: intent.conversionRate,
        snapshotIntentSignalTimestamp: intent.timestamp,
        snapshotIntentTimestampBuffer: BigNumber.from(0),
        intentDepositId: intent.depositId,
        intentEscrow: escrow.address,
        intentTo: taker.address,
      });

      await orchestrator.connect(owner).fulfillIntent({
        paymentProof: proof.paymentProof,
        intentHash,
        verificationData: "0x",
        settlementHookData: "0x",
      });
      expect((await manager.getRiskPosition(intentHash)).paymentId).to.eq(paymentId);
    });

    it("rejects a zero verifier payment ID before resolving the intent", async () => {
      const { taker, escrow, orchestrator, vault, manager, verifier } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await verifier.setPaymentId(ethers.constants.HashZero);

      await expect(fulfillIntent(orchestrator, intentHash, usdc(500))).to.be.reverted;
      expect((await orchestrator.getIntent(intentHash)).owner).to.eq(taker.address);
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(1);
    });

    it("records the authenticated payment ID when a terminal risk callback fails open", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const mock = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, mock.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(10), ZELLE);
      await mock.setRevertOnTerminal(true);

      await fulfillIntent(orchestrator, intentHash, usdc(10));
      const settlement = await orchestrator.getIntentSettlement(intentHash);
      expect(settlement.releasedAmount).to.eq(usdc(10));
      expect(settlement.paymentId).to.eq(ethers.utils.keccak256(
        ethers.utils.solidityPack(["string", "bytes32"], ["payment", intentHash]),
      ));
    });

    it("makes a maker manual release immediately non-chargebackable and releases its reservation", async () => {
      const { maker, taker, escrow, orchestrator, token, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const balanceBefore = await token.balanceOf(taker.address);
      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(4);
      expect(position.paymentId).to.eq(ethers.constants.HashZero);
      expect(position.coverageDeadline).to.eq(0);
      expect(position.reservedAmount).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect(await token.balanceOf(taker.address)).to.eq(balanceBefore.add(usdc(500)));
    });

    it("authenticates the payment-style typed data and compensates the exact gross release", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const claim = await chargebackAttestation(intentHash);
      const { chainId } = await ethers.provider.getNetwork();
      expect(await manager.hashChargebackAttestation(claim)).to.eq(ethers.utils._TypedDataEncoder.hash(
        { name: "ZKP2P RiskManager", version: "1", chainId, verifyingContract: manager.address },
        { ChargebackAttestation: [
          { name: "intentHash", type: "bytes32" },
          { name: "originalPaymentId", type: "bytes32" },
          { name: "disputeId", type: "bytes32" },
        ] },
        {
          intentHash: claim.intentHash,
          originalPaymentId: claim.originalPaymentId,
          disputeId: claim.disputeId,
        },
      ));
      await manager.submitChargeback(claim);
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(500));
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(5);
    });

    it("rejects reused dispute evidence across positions", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const firstHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const secondHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, firstHash, usdc(500));
      await fulfillIntent(orchestrator, secondHash, usdc(500));
      const disputeId = ethers.utils.id("shared-dispute");
      await manager.submitChargeback(await chargebackAttestation(firstHash, disputeId));
      await expect(manager.submitChargeback(
        await chargebackAttestation(secondHash, disputeId),
      )).to.be.revertedWithCustomError(manager, "ChargebackEvidenceUsed");
    });

    it("rejects manual release and mismatched original payment evidence", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const manualHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await orchestrator.connect(maker).releaseFundsToPayer(manualHash);
      await expect(manager.submitChargeback(
        await chargebackAttestation(manualHash),
      )).to.be.revertedWithCustomError(manager, "PositionNotSettled");

      const verifiedHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, verifiedHash, usdc(500));
      await expect(manager.submitChargeback(await chargebackAttestation(
        verifiedHash,
        undefined,
        ethers.utils.id("wrong-payment-id"),
      ))).to.be.revertedWithCustomError(manager, "InvalidAttestation");
    });

    it("releases remaining coverage at maturity", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const deadline = (await manager.getRiskPosition(intentHash)).coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      await manager.releaseMaturedPosition(intentHash);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(4);
    });

    it("rejects chargeback compensation at the exact coverage deadline", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const deadline = (await manager.getRiskPosition(intentHash)).coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      const claim = await chargebackAttestation(intentHash);
      await expect(manager.submitChargeback(claim))
        .to.be.revertedWithCustomError(manager, "ChargebackWindowClosed");
    });
  });

  describe("deferred payout exception", () => {
    it("reserves only the maximum griefing bond when stake cannot cover chargebacks", async () => {
      const { taker, escrow, orchestrator, vault, manager, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );
      const position = await manager.getRiskPosition(intentHash);
      expect(position.mode).to.eq(3);
      expect(position.initialReservation).to.eq(usdc("4.025"));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc("4.025"));
    });

    it("holds settled proceeds as chargeback coverage and releases griefing stake", async () => {
      const { taker, escrow, orchestrator, vault, manager, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );
      await fulfillIntent(orchestrator, intentHash, usdc(700));
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(700));
      expect((await manager.getRiskPosition(intentHash)).reservedAmount).to.eq(usdc(700));
    });

    it("rejects at admission when a self-referral would reduce deferred proceeds below coverage", async () => {
      const { taker, escrow, orchestrator, vault, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      await expect(orchestrator.connect(taker).signalIntent(signalParams(
          escrow,
          taker.address,
          usdc(700),
          PAYPAL,
          deferredHook.address,
          [{ recipient: taker.address, fee: precise("0.5") }],
        )))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect(await orchestrator.getAccountIntentCount(taker.address)).to.eq(0);
    });

    it("rejects any nonzero fee when deferred coverage reserves 100 percent", async () => {
      const { owner, taker, escrow, orchestrator, vault, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      await orchestrator.connect(owner).setProtocolFee(1);

      await expect(signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      )).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");

      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("uses the zero fee snapshot when governance raises the protocol fee after admission", async () => {
      const { owner, taker, escrow, orchestrator, vault, deferredHook, token } =
        await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));

      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );
      expect(await orchestrator.getIntentTotalFeeRate(intentHash)).to.eq(0);

      const releaseAmount = usdc("1.000001");
      const protocolBalanceBefore = await token.balanceOf(owner.address);
      await orchestrator.connect(owner).setProtocolFee(precise("0.05"));
      await fulfillIntent(orchestrator, intentHash, releaseAmount);

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(releaseAmount);
      expect((await token.balanceOf(owner.address)).sub(protocolBalanceBefore)).to.eq(0);
      expect(await orchestrator.getIntentTotalFeeRate(intentHash)).to.eq(0);
    });

    it("rejects aggregate protocol, manager, and referral fees at full reserve", async () => {
      const {
        owner,
        maker,
        taker,
        recipient,
        other,
        escrow,
        orchestrator,
        vault,
        deferredHook,
      } = await loadFixture(deployFixture);
      const feeRate = precise("0.01");
      const rateManagerId = ethers.utils.id("v3-fee-manager");
      const rateManager = await (await ethers.getContractFactory("RateManagerMock")).deploy();
      await rateManager.setManager(rateManagerId, true);
      await rateManager.setFee(rateManagerId, recipient.address, feeRate);
      await rateManager.setRate(rateManagerId, escrow.address, 0, PAYPAL, USD, precise(1));
      await escrow.connect(maker).setRateManager(0, rateManager.address, rateManagerId);
      await orchestrator.connect(owner).setProtocolFee(feeRate);
      await vault.connect(taker).depositStake(usdc(10));

      await expect(orchestrator.connect(taker).signalIntent(signalParams(
        escrow,
        taker.address,
        usdc(700),
        PAYPAL,
        deferredHook.address,
        [{ recipient: other.address, fee: feeRate }],
      ))).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("distributes snapshotted protocol, manager, and referral fees for stake-backed settlement", async () => {
      const {
        owner,
        maker,
        taker,
        recipient,
        other,
        escrow,
        orchestrator,
        token,
        vault,
      } = await loadFixture(deployFixture);
      const feeRate = precise("0.01");
      const releaseAmount = usdc(700);
      const expectedFee = usdc(7);
      const rateManagerId = ethers.utils.id("v3-fee-distribution-manager");
      const rateManager = await (await ethers.getContractFactory("RateManagerMock")).deploy();
      await rateManager.setManager(rateManagerId, true);
      await rateManager.setFee(rateManagerId, recipient.address, feeRate);
      await rateManager.setRate(rateManagerId, escrow.address, 0, PAYPAL, USD, precise(1));
      await escrow.connect(maker).setRateManager(0, rateManager.address, rateManagerId);
      await orchestrator.connect(owner).setProtocolFee(feeRate);
      await vault.connect(taker).depositStake(releaseAmount);

      const protocolBalanceBefore = await token.balanceOf(owner.address);
      const managerBalanceBefore = await token.balanceOf(recipient.address);
      const referralBalanceBefore = await token.balanceOf(other.address);
      const takerBalanceBefore = await token.balanceOf(taker.address);
      const intentHash = intentHashFrom(await (
        await orchestrator.connect(taker).signalIntent(signalParams(
          escrow,
          taker.address,
          releaseAmount,
          PAYPAL,
          ZERO,
          [{ recipient: other.address, fee: feeRate }],
        ))
      ).wait());

      await fulfillIntent(orchestrator, intentHash, releaseAmount);

      expect((await token.balanceOf(owner.address)).sub(protocolBalanceBefore)).to.eq(expectedFee);
      expect((await token.balanceOf(recipient.address)).sub(managerBalanceBefore)).to.eq(expectedFee);
      expect((await token.balanceOf(other.address)).sub(referralBalanceBefore)).to.eq(expectedFee);
      expect((await token.balanceOf(taker.address)).sub(takerBalanceBefore)).to.eq(
        releaseAmount.sub(expectedFee.mul(3)),
      );
    });

    it("requires the canonical deferred hook for the exception", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      await expect(signalIntent(orchestrator, escrow, taker, usdc(700), PAYPAL))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("rejects the deferred hook when stake already covers the full reservation", async () => {
      const { taker, escrow, orchestrator, vault, manager, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(700));
      await expect(signalIntent(orchestrator, escrow, taker, usdc(700), PAYPAL, deferredHook.address))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("slashes deferred proceeds without reducing membership stake", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager, deferredHook } =
        await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );
      await fulfillIntent(orchestrator, intentHash, usdc(700));
      await manager.submitChargeback(await chargebackAttestation(intentHash));
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(10));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(700));
      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(0);
    });
  });
});
