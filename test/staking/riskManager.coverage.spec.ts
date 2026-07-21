import { expect } from "chai";
import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const usdc = (amount: string | number) => ethers.utils.parseUnits(String(amount), 6);
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const PERIOD = HOUR;
const PAYPAL = ethers.utils.id("coverage-paypal");
const ZELLE = ethers.utils.id("coverage-zelle");
const ZERO = ethers.constants.AddressZero;

function chargebackConfig(deferredPayoutEnabled = false) {
  return {
    enabled: true,
    chargeback: {
      chargebackable: true,
      deferredPayoutEnabled,
      reserveBps: 10_000,
      riskWindow: DAY,
    },
    intentExtension: { extensionPenaltyBpsPerHour: 10 },
  };
}

function nonChargebackConfig() {
  return {
    enabled: true,
    chargeback: { chargebackable: false, deferredPayoutEnabled: false, reserveBps: 0, riskWindow: 0 },
    intentExtension: { extensionPenaltyBpsPerHour: 10 },
  };
}

describe("RiskManager -- hard-cut branch coverage", () => {
  async function deployFixture() {
    const [owner, taker, maker, beneficiary, other] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("USDCMock"))
      .deploy(usdc(1_000_000), "USD Coin", "USDC");
    const orchestrator = await (await ethers.getContractFactory("RiskManagerOrchestratorHarness")).deploy();
    const vault = await (await ethers.getContractFactory("RiskManagerVaultHarness")).deploy();
    const escrow = await (await ethers.getContractFactory("RiskManagerEscrowHarness"))
      .deploy(PERIOD, maker.address);
    const verifier = await (await ethers.getContractFactory("AttestationVerifierMock")).deploy();
    const legacyRegistry = await (await ethers.getContractFactory("NullifierRegistry")).deploy();
    const nullifierRegistry = await (await ethers.getContractFactory("NullifierRegistryV2"))
      .deploy(legacyRegistry.address);
    const manager = await (await ethers.getContractFactory("RiskManager")).deploy(
      owner.address,
      orchestrator.address,
      vault.address,
      verifier.address,
      nullifierRegistry.address,
    );

    await vault.setStakeToken(token.address);
    await escrow.setToken(token.address);
    await escrow.setIntentGuardian(manager.address);
    await manager.setPlatformRiskConfig(PAYPAL, chargebackConfig());
    await manager.setPlatformRiskConfig(ZELLE, nonChargebackConfig());
    await vault.setTakerState(taker.address, taker.address, usdc(100_000), usdc(100_000), false);
    await token.transfer(orchestrator.address, usdc(10_000));

    return {
      owner, taker, maker, beneficiary, other, token, orchestrator, vault, escrow, verifier,
      legacyRegistry, nullifierRegistry, manager,
    };
  }

  async function setRiskIntent(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    intentHash: string,
    options: {
      amount?: BigNumber;
      paymentMethod?: string;
      createdAt?: number;
      owner?: string;
      recipient?: string;
    } = {},
  ) {
    const createdAt = options.createdAt ?? await time.latest();
    await fixture.orchestrator.setRiskIntent(intentHash, {
      owner: options.owner ?? fixture.taker.address,
      to: options.recipient ?? fixture.beneficiary.address,
      escrow: fixture.escrow.address,
      depositId: 0,
      amount: options.amount ?? usdc(100),
      paymentMethod: options.paymentMethod ?? PAYPAL,
      createdAt,
    });
    await fixture.escrow.setIntent(intentHash, createdAt);
  }

  async function createPosition(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    intentHash: string,
    options: Parameters<typeof setRiskIntent>[2] = {},
  ) {
    await setRiskIntent(fixture, intentHash, options);
    await fixture.orchestrator.createPosition(fixture.manager.address, intentHash);
  }

  function settlementContext(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    intentHash: string,
    overrides: Record<string, unknown> = {},
  ) {
    const context: any = {
      intentHash,
      token: fixture.token.address,
      recipient: fixture.beneficiary.address,
      grossAmount: usdc(100),
      executableAmount: usdc(98),
      isManualRelease: false,
      ...overrides,
    };
    const grossAmount = BigNumber.from(context.grossAmount);
    const executableAmount = BigNumber.from(context.executableAmount);
    context.feeAllocations = overrides.feeAllocations ?? (
      executableAmount.gt(0) && grossAmount.gt(executableAmount)
        ? [{ feeType: 0, recipient: fixture.beneficiary.address, amount: grossAmount.sub(executableAmount) }]
        : []
    );
    return context;
  }

  describe("constructor and governance", () => {
    it("rejects zero and EOA contract dependencies", async () => {
      const f = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("RiskManager");
      await expect(factory.deploy(ZERO, f.orchestrator.address, f.vault.address, f.verifier.address, f.nullifierRegistry.address))
        .to.be.revertedWithCustomError(f.manager, "ZeroAddress");
      await expect(factory.deploy(f.owner.address, f.other.address, f.vault.address, f.verifier.address, f.nullifierRegistry.address))
        .to.be.revertedWithCustomError(f.manager, "ZeroAddress");
      await expect(factory.deploy(f.owner.address, f.orchestrator.address, f.other.address, f.verifier.address, f.nullifierRegistry.address))
        .to.be.revertedWithCustomError(f.manager, "ZeroAddress");
    });

    it("updates verifier, admission pause, and vault controller forwarding", async () => {
      const f = await loadFixture(deployFixture);
      const nextVerifier = await (await ethers.getContractFactory("AttestationVerifierMock")).deploy();
      await expect(f.manager.setAttestationVerifier(nextVerifier.address))
        .to.emit(f.manager, "AttestationVerifierUpdated").withArgs(f.verifier.address, nextVerifier.address);
      await expect(f.manager.setAdmissionPaused(true)).to.emit(f.manager, "AdmissionPausedUpdated").withArgs(true);
      await f.manager.acceptVaultController();
      expect(await f.vault.acceptControllerCalls()).to.eq(1);
    });

    it("rejects non-owner governance and invalid verifier updates", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.manager.connect(f.other).setAdmissionPaused(true)).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(f.manager.setAttestationVerifier(ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
      await expect(f.manager.setAttestationVerifier(f.other.address)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
    });
  });

  describe("configuration and formulas", () => {
    it("accepts deferred chargeback policy and rejects invalid combinations", async () => {
      const f = await loadFixture(deployFixture);
      await f.manager.setPlatformRiskConfig(PAYPAL, chargebackConfig(true));
      expect((await f.manager.getPlatformRiskConfig(PAYPAL)).chargeback.deferredPayoutEnabled).to.eq(true);

      await expect(f.manager.setPlatformRiskConfig(ethers.constants.HashZero, nonChargebackConfig()))
        .to.be.revertedWithCustomError(f.manager, "InvalidPlatformConfig");
      await expect(f.manager.setPlatformRiskConfig(PAYPAL, {
        ...chargebackConfig(),
        chargeback: { ...chargebackConfig().chargeback, reserveBps: 9_999 },
      })).to.be.revertedWithCustomError(f.manager, "InvalidPlatformConfig");
      await expect(f.manager.setPlatformRiskConfig(ZELLE, {
        ...nonChargebackConfig(),
        chargeback: { chargebackable: false, deferredPayoutEnabled: true, reserveBps: 0, riskWindow: 0 },
      })).to.be.revertedWithCustomError(f.manager, "InvalidPlatformConfig");
    });

    it("covers zero and upward-rounded formula branches", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.manager.calculateChargebackReserve(101, 5_000)).to.eq(51);
      expect(await f.manager.calculateIntentExtensionCost(100, PERIOD, 0)).to.eq(0);
      const penalty = await f.manager.calculateIntentExtensionPenalty(100, 10, 10, PERIOD, 10);
      expect(penalty.penalty).to.eq(0);
    });
  });

  describe("admission and cancellation recovery", () => {
    it("rejects direct lifecycle calls, paused admission, and missing intents", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.manager.onIntentCreated(ethers.utils.id("direct")))
        .to.be.revertedWithCustomError(f.manager, "UnauthorizedOrchestrator");
      await expect(f.manager.onIntentCancelled(ethers.utils.id("direct-cancel")))
        .to.be.revertedWithCustomError(f.manager, "UnauthorizedOrchestrator");
      await f.manager.setAdmissionPaused(true);
      const paused = ethers.utils.id("paused");
      await setRiskIntent(f, paused);
      await expect(f.orchestrator.createPosition(f.manager.address, paused)).to.be.revertedWithCustomError(f.manager, "AdmissionPaused");
      await f.manager.setAdmissionPaused(false);
      await expect(f.orchestrator.createPosition(f.manager.address, ethers.utils.id("missing")))
        .to.be.revertedWithCustomError(f.manager, "IntentStateMismatch");
    });

    it("creates unbonded, stake-backed, and deferred modes without post-hook coupling", async () => {
      const f = await loadFixture(deployFixture);
      const unbonded = ethers.utils.id("unbonded");
      await createPosition(f, unbonded, { amount: usdc(20), paymentMethod: ZELLE });
      expect((await f.manager.getRiskPosition(unbonded)).mode).to.eq(1);

      const stakeBacked = ethers.utils.id("stake-backed");
      await createPosition(f, stakeBacked, { amount: usdc(100), paymentMethod: PAYPAL });
      expect((await f.manager.getRiskPosition(stakeBacked)).mode).to.eq(2);

      await f.manager.setPlatformRiskConfig(PAYPAL, chargebackConfig(true));
      await f.vault.setTakerState(f.taker.address, f.taker.address, usdc(1), usdc(1), false);
      const deferred = ethers.utils.id("deferred");
      await createPosition(f, deferred, { recipient: f.taker.address });
      expect((await f.manager.getRiskPosition(deferred)).mode).to.eq(3);
      expect((await f.vault.deferredStakes(deferred)).authorized).to.eq(true);
    });

    it("rejects duplicate admission, token mismatch, insufficient collateral, and exiting stake", async () => {
      const f = await loadFixture(deployFixture);
      const duplicate = ethers.utils.id("duplicate");
      await createPosition(f, duplicate);
      await expect(f.orchestrator.createPosition(f.manager.address, duplicate))
        .to.be.revertedWithCustomError(f.manager, "PositionAlreadyExists");

      const otherToken = await (await ethers.getContractFactory("USDCMock")).deploy(1, "Other", "OTHER");
      await f.escrow.setToken(otherToken.address);
      const mismatch = ethers.utils.id("mismatch");
      await setRiskIntent(f, mismatch);
      await expect(f.orchestrator.createPosition(f.manager.address, mismatch))
        .to.be.revertedWithCustomError(f.manager, "IntentTokenMismatch");
      await f.escrow.setToken(f.token.address);

      await f.vault.setTakerState(f.taker.address, f.taker.address, 0, 0, false);
      const insufficient = ethers.utils.id("insufficient");
      await setRiskIntent(f, insufficient);
      await expect(f.orchestrator.createPosition(f.manager.address, insufficient))
        .to.be.revertedWithCustomError(f.manager, "InsufficientCollateral");

      await f.vault.setTakerState(f.taker.address, f.taker.address, usdc(100), usdc(100), true);
      const exiting = ethers.utils.id("exiting");
      await setRiskIntent(f, exiting);
      await expect(f.orchestrator.createPosition(f.manager.address, exiting))
        .to.be.revertedWithCustomError(f.manager, "StakeOwnerExiting");
    });

    it("requires RiskManager to be the deposit's intent guardian", async () => {
      const f = await loadFixture(deployFixture);
      await f.escrow.setIntentGuardian(f.other.address);
      const intentHash = ethers.utils.id("wrong-intent-guardian");
      await setRiskIntent(f, intentHash);

      await expect(f.orchestrator.createPosition(f.manager.address, intentHash))
        .to.be.revertedWithCustomError(f.manager, "InvalidIntentGuardian");
    });

    it("rejects an Escrow intent timestamp that no longer matches the admission snapshot", async () => {
      const f = await loadFixture(deployFixture);
      const intentHash = ethers.utils.id("mutated-escrow-timestamp");
      const createdAt = await time.latest();
      await createPosition(f, intentHash, { createdAt, paymentMethod: ZELLE });
      await f.escrow.setIntentState(intentHash, createdAt + 1, createdAt + PERIOD);

      await expect(f.manager.connect(f.taker).extendIntent(intentHash, HOUR))
        .to.be.revertedWithCustomError(f.manager, "IntentStateMismatch");
    });

    it("records and reconciles cancellation with the original timestamp", async () => {
      const f = await loadFixture(deployFixture);
      const intentHash = ethers.utils.id("reconcile-cancel");
      await createPosition(f, intentHash);
      const cancelledAt = await time.latest();
      await f.orchestrator.setIntentCancellation(intentHash, cancelledAt);
      await f.manager.reconcileCancellation(intentHash);
      expect((await f.manager.getRiskPosition(intentHash)).cancelledAt).to.eq(cancelledAt);
      expect(await f.orchestrator.getIntentCancellation(intentHash)).to.eq(0);
      await expect(f.manager.reconcileCancellations([])).to.be.revertedWithCustomError(f.manager, "EmptyBatch");
      await expect(f.manager.reconcileCancellation(ethers.utils.id("unknown")))
        .to.be.revertedWithCustomError(f.manager, "CancellationNotRecorded");
    });
  });

  describe("atomic settlement", () => {
    it("rejects direct calls and invalid token, amounts, and recipient", async () => {
      const f = await loadFixture(deployFixture);
      const intentHash = ethers.utils.id("invalid-settlement");
      await createPosition(f, intentHash);
      await expect(f.manager.settleIntent(settlementContext(f, intentHash)))
        .to.be.revertedWithCustomError(f.manager, "UnauthorizedOrchestrator");

      const otherToken = await (await ethers.getContractFactory("USDCMock")).deploy(1, "Other", "OTHER");
      await expect(f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash, { token: otherToken.address })))
        .to.be.revertedWithCustomError(f.manager, "IntentTokenMismatch");
      await expect(f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash, { executableAmount: 0 })))
        .to.be.revertedWithCustomError(f.manager, "InvalidSettlementAmounts");
      await expect(f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash, {
        feeAllocations: [],
      }))).to.be.revertedWithCustomError(f.manager, "InvalidFeeAllocations");
      await expect(f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash, {
        feeAllocations: [{ feeType: 0, recipient: ZERO, amount: usdc(2) }],
      }))).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
      await expect(f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash, {
        feeAllocations: Array.from({ length: 8 }, () => ({
          feeType: 0, recipient: f.beneficiary.address, amount: 0,
        })),
      }))).to.be.revertedWithCustomError(f.manager, "InvalidFeeAllocationCount");
      await expect(f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash, { recipient: f.other.address })))
        .to.be.revertedWithCustomError(f.manager, "IntentStateMismatch");
    });

    it("uses gross coverage for stake-backed settlement while consuming zero funds", async () => {
      const f = await loadFixture(deployFixture);
      const intentHash = ethers.utils.id("stake-settlement");
      await createPosition(f, intentHash);
      const before = await f.token.balanceOf(f.orchestrator.address);
      await f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash));
      const position = await f.manager.getRiskPosition(intentHash);
      expect(position.grossReleasedAmount).to.eq(usdc(100));
      expect(position.executableAmount).to.eq(usdc(98));
      expect(position.reservedAmount).to.eq(usdc(100));
      expect(await f.token.balanceOf(f.orchestrator.address)).to.eq(before);
    });

    it("pulls and accounts for gross deferred stake and contingent fees", async () => {
      const f = await loadFixture(deployFixture);
      await f.manager.setPlatformRiskConfig(PAYPAL, chargebackConfig(true));
      await f.vault.setTakerState(f.taker.address, f.taker.address, usdc(1), usdc(1), false);
      const intentHash = ethers.utils.id("deferred-settlement");
      await createPosition(f, intentHash, { recipient: f.taker.address });
      const vaultBefore = await f.token.balanceOf(f.vault.address);

      await f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash, {
        recipient: f.taker.address,
        isManualRelease: true,
      }));

      const position = await f.manager.getRiskPosition(intentHash);
      const deferredStake = await f.vault.deferredStakes(intentHash);
      expect(position.grossReleasedAmount).to.eq(usdc(100));
      expect(position.executableAmount).to.eq(usdc(98));
      expect(position.isManualRelease).to.eq(true);
      expect(deferredStake.grossAmount).to.eq(usdc(100));
      expect(deferredStake.feeAmount).to.eq(usdc(2));
      expect(await f.token.balanceOf(f.vault.address)).to.eq(vaultBefore.add(usdc(100)));
      expect(await f.token.allowance(f.orchestrator.address, f.manager.address)).to.eq(0);
    });

    it("snapshots the payout recipient as deferred stake owner", async () => {
      const f = await loadFixture(deployFixture);
      await f.manager.setPlatformRiskConfig(PAYPAL, chargebackConfig(true));
      await f.vault.setTakerState(f.taker.address, f.taker.address, usdc(1), usdc(1), false);
      const intentHash = ethers.utils.id("deferred-third-party-recipient");
      await setRiskIntent(f, intentHash, { recipient: f.other.address });

      await f.orchestrator.createPosition(f.manager.address, intentHash);

      const position = await f.manager.getRiskPosition(intentHash);
      const deferredStake = await f.vault.deferredStakes(intentHash);
      expect(position.taker).to.eq(f.taker.address);
      expect(position.stakeOwner).to.eq(f.other.address);
      expect(position.payoutRecipient).to.eq(f.other.address);
      expect(deferredStake.staker).to.eq(f.other.address);
    });

    it("rejects deferred authorization for an exiting payout recipient", async () => {
      const f = await loadFixture(deployFixture);
      await f.manager.setPlatformRiskConfig(PAYPAL, chargebackConfig(true));
      await f.vault.setTakerState(f.taker.address, f.taker.address, usdc(1), usdc(1), false);
      await f.vault.setTakerState(f.other.address, f.other.address, 0, 0, true);
      const intentHash = ethers.utils.id("deferred-exiting-recipient");
      await setRiskIntent(f, intentHash, { recipient: f.other.address });

      await expect(f.orchestrator.createPosition(f.manager.address, intentHash))
        .to.be.revertedWithCustomError(f.manager, "StakeOwnerExiting")
        .withArgs(f.taker.address, f.other.address);
    });

    it("releases non-chargebackable reservations and rejects repeated settlement", async () => {
      const f = await loadFixture(deployFixture);
      const intentHash = ethers.utils.id("ordinary-settlement");
      await createPosition(f, intentHash, { amount: usdc(100), paymentMethod: ZELLE });
      await f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash, {
        grossAmount: usdc(100), executableAmount: usdc(100),
      }));
      expect((await f.manager.getRiskPosition(intentHash)).status).to.eq(4);
      await expect(f.orchestrator.settlePosition(f.manager.address, settlementContext(f, intentHash)))
        .to.be.revertedWithCustomError(f.manager, "PositionNotPending");
    });

    it("matures stake and deferred coverage at the half-open deadline", async () => {
      const f = await loadFixture(deployFixture);
      const stakeIntent = ethers.utils.id("mature-stake");
      await createPosition(f, stakeIntent);
      await f.orchestrator.settlePosition(f.manager.address, settlementContext(f, stakeIntent));
      const deadline = (await f.manager.getRiskPosition(stakeIntent)).coverageDeadline.toNumber();
      await expect(f.manager.releaseMaturedPosition(stakeIntent))
        .to.be.revertedWithCustomError(f.manager, "PositionNotMature");
      await time.increaseTo(deadline);
      await f.manager.releaseMaturedPosition(stakeIntent);
      expect((await f.manager.getRiskPosition(stakeIntent)).status).to.eq(4);
      await expect(f.manager.releaseMaturedPositions([])).to.be.revertedWithCustomError(f.manager, "EmptyBatch");
    });
  });
});
