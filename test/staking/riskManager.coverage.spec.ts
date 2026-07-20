import { expect } from "chai";
import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const usdc = (amount: string | number) => ethers.utils.parseUnits(String(amount), 6);
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_INTENT_PERIOD = 6 * HOUR;
const EXTENSION_FEE_BPS = 2_000;
const MAX_INTENT_LIFETIME = 5 * DAY;
const PAYPAL = ethers.utils.id("coverage-paypal");
const ZELLE = ethers.utils.id("coverage-zelle");
const OTHER_METHOD = ethers.utils.id("coverage-other");
const ZERO = ethers.constants.AddressZero;

function chargebackConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chargeback: {
      chargebackable: true,
      deferredPayoutEnabled: true,
      reserveBps: 10_000,
      riskWindow: DAY,
      ...((overrides.chargeback as Record<string, unknown>) ?? {}),
    },
    extension: {
      feeBps: EXTENSION_FEE_BPS,
      maxIntentLifetime: MAX_INTENT_LIFETIME,
      ...((overrides.extension as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "chargeback" && key !== "extension")),
  };
}

function nonChargebackConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chargeback: {
      chargebackable: false,
      deferredPayoutEnabled: false,
      reserveBps: 0,
      riskWindow: 0,
      ...((overrides.chargeback as Record<string, unknown>) ?? {}),
    },
    extension: {
      feeBps: EXTENSION_FEE_BPS,
      maxIntentLifetime: MAX_INTENT_LIFETIME,
      ...((overrides.extension as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "chargeback" && key !== "extension")),
  };
}

describe("RiskManager -- exhaustive policy and recovery coverage", () => {
  async function deployHarnessFixture() {
    const [owner, taker, maker, beneficiary, other] = await ethers.getSigners();
    const orchestrator = await (await ethers.getContractFactory("RiskManagerOrchestratorHarness")).deploy();
    const vault = await (await ethers.getContractFactory("RiskManagerVaultHarness")).deploy();
    const escrow = await (await ethers.getContractFactory("RiskManagerEscrowHarness"))
      .deploy(MAX_INTENT_PERIOD, maker.address);
    const verifier = await (await ethers.getContractFactory("AttestationVerifierMock")).deploy();
    const manager = await (await ethers.getContractFactory("RiskManager")).deploy(
      owner.address,
      orchestrator.address,
      vault.address,
      verifier.address,
    );

    await manager.setDeferredPayoutHook(orchestrator.address);
    await manager.setPlatformRiskConfig(PAYPAL, chargebackConfig());
    await manager.setPlatformRiskConfig(ZELLE, nonChargebackConfig());
    await vault.setTakerState(taker.address, taker.address, usdc(100_000), usdc(100_000), false);

    return { owner, taker, maker, beneficiary, other, orchestrator, vault, escrow, verifier, manager };
  }

  async function setRiskIntent(
    fixture: Awaited<ReturnType<typeof deployHarnessFixture>>,
    intentHash: string,
    options: {
      amount?: BigNumber;
      paymentMethod?: string;
      postIntentHook?: string;
      createdAt?: number;
      owner?: string;
      recipient?: string;
    } = {},
  ) {
    await fixture.orchestrator.setRiskIntent(intentHash, {
      owner: options.owner ?? fixture.taker.address,
      to: options.recipient ?? fixture.beneficiary.address,
      escrow: fixture.escrow.address,
      depositId: 0,
      amount: options.amount ?? usdc(100),
      paymentMethod: options.paymentMethod ?? PAYPAL,
      postIntentHook: options.postIntentHook ?? ZERO,
      createdAt: options.createdAt ?? await time.latest(),
    });
  }

  async function createPosition(
    fixture: Awaited<ReturnType<typeof deployHarnessFixture>>,
    intentHash: string,
    options: Parameters<typeof setRiskIntent>[2] = {},
  ) {
    await setRiskIntent(fixture, intentHash, options);
    await fixture.orchestrator.createPosition(fixture.manager.address, intentHash);
  }

  async function createDeferredPosition(
    fixture: Awaited<ReturnType<typeof deployHarnessFixture>>,
    intentHash: string,
    amount = usdc(100),
  ) {
    await fixture.vault.setTakerState(fixture.taker.address, fixture.taker.address, usdc(1), usdc(1), false);
    await createPosition(fixture, intentHash, {
      amount,
      paymentMethod: PAYPAL,
      postIntentHook: fixture.orchestrator.address,
    });
  }

  async function validAttestation(
    fixture: Awaited<ReturnType<typeof deployHarnessFixture>>,
    intentHash: string,
    overrides: Record<string, unknown> = {},
  ) {
    const now = await time.latest();
    const { chainId } = await ethers.provider.getNetwork();
    return {
      chainId,
      riskManager: fixture.manager.address,
      orchestrator: fixture.orchestrator.address,
      intentHash,
      paymentMethod: PAYPAL,
      chargebackAmount: usdc(10),
      evidenceId: ethers.utils.id(`evidence-${intentHash}`),
      nonce: 1,
      validAfter: now - 1,
      validUntil: now + DAY,
      ...overrides,
    };
  }

  describe("constructor and governance", () => {
    it("rejects a zero owner", async () => {
      const { orchestrator, vault, verifier } = await loadFixture(deployHarnessFixture);
      await expect((await ethers.getContractFactory("RiskManager")).deploy(
        ZERO, orchestrator.address, vault.address, verifier.address,
      )).to.be.revertedWithCustomError(await ethers.getContractFactory("RiskManager"), "ZeroAddress");
    });

    it("rejects a zero orchestrator", async () => {
      const { owner, vault, verifier } = await loadFixture(deployHarnessFixture);
      await expect((await ethers.getContractFactory("RiskManager")).deploy(
        owner.address, ZERO, vault.address, verifier.address,
      )).to.be.reverted;
    });

    it("rejects a zero vault", async () => {
      const { owner, orchestrator, verifier } = await loadFixture(deployHarnessFixture);
      await expect((await ethers.getContractFactory("RiskManager")).deploy(
        owner.address, orchestrator.address, ZERO, verifier.address,
      )).to.be.reverted;
    });

    it("rejects a zero attestation verifier", async () => {
      const { owner, orchestrator, vault } = await loadFixture(deployHarnessFixture);
      await expect((await ethers.getContractFactory("RiskManager")).deploy(
        owner.address, orchestrator.address, vault.address, ZERO,
      )).to.be.reverted;
    });

    it("rejects an EOA attestation verifier", async () => {
      const { owner, other, orchestrator, vault } = await loadFixture(deployHarnessFixture);
      await expect((await ethers.getContractFactory("RiskManager")).deploy(
        owner.address, orchestrator.address, vault.address, other.address,
      )).to.be.reverted;
    });

    it("updates the attestation verifier", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      const replacement = await (await ethers.getContractFactory("AttestationVerifierMock")).deploy();
      await expect(manager.setAttestationVerifier(replacement.address))
        .to.emit(manager, "AttestationVerifierUpdated");
      expect(await manager.attestationVerifier()).to.eq(replacement.address);
    });

    it("rejects a zero attestation verifier update", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.setAttestationVerifier(ZERO)).to.be.revertedWithCustomError(manager, "ZeroAddress");
    });

    it("rejects an EOA attestation verifier update", async () => {
      const { manager, other } = await loadFixture(deployHarnessFixture);
      await expect(manager.setAttestationVerifier(other.address)).to.be.revertedWithCustomError(manager, "ZeroAddress");
    });

    it("clears the deferred payout hook", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await manager.setDeferredPayoutHook(ZERO);
      expect(await manager.deferredPayoutHook()).to.eq(ZERO);
    });

    it("rejects an EOA deferred payout hook", async () => {
      const { manager, other } = await loadFixture(deployHarnessFixture);
      await expect(manager.setDeferredPayoutHook(other.address)).to.be.revertedWithCustomError(manager, "ZeroAddress");
    });

    it("pauses and unpauses admission", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.setAdmissionPaused(true)).to.emit(manager, "AdmissionPausedUpdated").withArgs(true);
      await manager.setAdmissionPaused(false);
      expect(await manager.admissionPaused()).to.eq(false);
    });

    it("forwards vault controller acceptance", async () => {
      const { manager, vault } = await loadFixture(deployHarnessFixture);
      await manager.acceptVaultController();
      expect(await vault.acceptControllerCalls()).to.eq(1);
    });

    it("rejects governance calls from a non-owner", async () => {
      const { manager, other } = await loadFixture(deployHarnessFixture);
      await expect(manager.connect(other).setAdmissionPaused(true)).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("rejects platform configuration from a non-owner", async () => {
      const { manager, other } = await loadFixture(deployHarnessFixture);
      await expect(manager.connect(other).setPlatformRiskConfig(OTHER_METHOD, nonChargebackConfig()))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("rejects an attestation verifier update from a non-owner", async () => {
      const { manager, other, verifier } = await loadFixture(deployHarnessFixture);
      await expect(manager.connect(other).setAttestationVerifier(verifier.address))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("rejects a deferred payout hook update from a non-owner", async () => {
      const { manager, other, orchestrator } = await loadFixture(deployHarnessFixture);
      await expect(manager.connect(other).setDeferredPayoutHook(orchestrator.address))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("rejects vault controller acceptance from a non-owner", async () => {
      const { manager, other } = await loadFixture(deployHarnessFixture);
      await expect(manager.connect(other).acceptVaultController())
        .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("returns the complete shared taker portfolio state", async () => {
      const { manager, vault, taker } = await loadFixture(deployHarnessFixture);
      await vault.setTakerState(taker.address, taker.address, 100, 60, true);
      const state = await manager.getTakerState(taker.address);
      expect(state.stakeOwner).to.eq(taker.address);
      expect(state.totalStake).to.eq(100);
      expect(state.reserved).to.eq(0);
      expect(state.free).to.eq(60);
      expect(state.exiting).to.eq(true);
    });
  });

  describe("platform configuration validation", () => {
    it("rejects the zero payment method", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.setPlatformRiskConfig(ethers.constants.HashZero, nonChargebackConfig()))
        .to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("rejects a partially configured extension policy", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({
        extension: { feeBps: EXTENSION_FEE_BPS, maxIntentLifetime: 0 },
      }))).to.be.revertedWithCustomError(manager, "InvalidIntentExtensionConfig");
    });

    it("rejects a chargebackable platform with a zero reserve", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({
        chargeback: { reserveBps: 0 },
      }))).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("rejects a chargebackable platform with a zero risk window", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({
        chargeback: { riskWindow: 0 },
      }))).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("accepts the maximum supported chargeback risk window", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      const maxRiskWindow = await manager.MAX_RISK_WINDOW();
      await expect(manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({
        chargeback: { riskWindow: maxRiskWindow },
      }))).to.emit(manager, "PlatformRiskConfigUpdated");
    });

    it("rejects a chargeback risk window above the supported maximum", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      const maxRiskWindow = await manager.MAX_RISK_WINDOW();
      await expect(manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({
        chargeback: { riskWindow: maxRiskWindow.add(1) },
      }))).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("rejects a non-chargebackable platform with a reserve", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.setPlatformRiskConfig(OTHER_METHOD, nonChargebackConfig({
        chargeback: { reserveBps: 1 },
      }))).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("rejects deferred payout on a non-chargebackable platform", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.setPlatformRiskConfig(OTHER_METHOD, nonChargebackConfig({
        chargeback: { deferredPayoutEnabled: true },
      }))).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("stores a disabled platform for future admission policy", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await manager.setPlatformRiskConfig(OTHER_METHOD, nonChargebackConfig({ enabled: false }));
      expect((await manager.getPlatformRiskConfig(OTHER_METHOD)).enabled).to.eq(false);
    });
  });

  describe("public formula and hashing helpers", () => {
    it("returns zero extension fee for a zero rate", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      expect(await manager.calculateIntentExtensionFee(100, 0, HOUR)).to.eq(0);
    });

    it("returns zero extension fee for zero time", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      expect(await manager.calculateIntentExtensionFee(100, EXTENSION_FEE_BPS, 0)).to.eq(0);
    });

    it("rounds a nonzero extension fee upward", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      expect(await manager.calculateIntentExtensionFee(1, 1, 1)).to.eq(1);
    });

    it("returns zero chargeback reserve for a zero ratio", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      expect(await manager.calculateChargebackReserve(100, 0)).to.eq(0);
    });

    it("hashes a scoped EIP-712 chargeback attestation", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const attestation = await validAttestation(fixture, ethers.utils.id("hash-only"));
      expect(await fixture.manager.hashChargebackAttestation(attestation)).not.to.eq(ethers.constants.HashZero);
    });
  });

  describe("admission errors and zero-reservation modes", () => {
    it("rejects direct lifecycle calls outside the orchestrator", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.onIntentCreated(ethers.utils.id("unauthorized-create")))
        .to.be.revertedWithCustomError(manager, "UnauthorizedOrchestrator");
    });

    it("rejects direct cancellation callbacks outside the orchestrator", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.onIntentCancelled(ethers.utils.id("unauthorized-cancel")))
        .to.be.revertedWithCustomError(manager, "UnauthorizedOrchestrator");
    });

    it("rejects direct fulfillment callbacks outside the orchestrator", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.onIntentFulfilled(ethers.utils.id("unauthorized-fulfill"), 1))
        .to.be.revertedWithCustomError(manager, "UnauthorizedOrchestrator");
    });

    it("rejects direct release callbacks outside the orchestrator", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.onIntentReleased(ethers.utils.id("unauthorized-release"), 1))
        .to.be.revertedWithCustomError(manager, "UnauthorizedOrchestrator");
    });

    it("rejects admission while paused", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("paused");
      await setRiskIntent(fixture, intentHash);
      await fixture.manager.setAdmissionPaused(true);
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "AdmissionPaused");
    });

    it("rejects duplicate position admission", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("duplicate");
      await createPosition(fixture, intentHash);
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "PositionAlreadyExists");
    });

    it("rejects a missing orchestrator intent", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("missing-intent");
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "IntentStateMismatch");
    });

    it("rejects an orchestrator intent with a zero creation timestamp", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("zero-created-at");
      await setRiskIntent(fixture, intentHash, { createdAt: 0 });
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "IntentStateMismatch");
    });

    it("rejects a disabled platform", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("disabled-platform");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, nonChargebackConfig({ enabled: false }));
      await setRiskIntent(fixture, intentHash, { paymentMethod: OTHER_METHOD });
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "PlatformDisabled");
    });

    it("rejects an Escrow period that exceeds uint64", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("period-overflow");
      await fixture.escrow.setIntentExpirationPeriod(ethers.constants.MaxUint256);
      await setRiskIntent(fixture, intentHash);
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "TimestampOverflow");
    });

    it("rejects an Escrow deposit whose token differs from the vault token", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("mismatched-intent-token");
      await fixture.escrow.setToken(fixture.other.address);
      await setRiskIntent(fixture, intentHash);
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "IntentTokenMismatch");
    });

    it("rejects a zero Escrow intent period", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("zero-period");
      await fixture.escrow.setIntentExpirationPeriod(0);
      await setRiskIntent(fixture, intentHash);
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "InvalidIntentExtensionConfig");
    });

    it("rejects an extension lifetime equal to the Escrow period", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("extension-equals-period");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, nonChargebackConfig({
        extension: { feeBps: EXTENSION_FEE_BPS, maxIntentLifetime: MAX_INTENT_PERIOD },
      }));
      await setRiskIntent(fixture, intentHash, { paymentMethod: OTHER_METHOD });
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "InvalidIntentExtensionConfig");
    });

    it("rejects an extension lifetime shorter than the Escrow period", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("extension-too-short");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, nonChargebackConfig({
        extension: { feeBps: EXTENSION_FEE_BPS, maxIntentLifetime: MAX_INTENT_PERIOD - 1 },
      }));
      await setRiskIntent(fixture, intentHash, { paymentMethod: OTHER_METHOD });
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "InvalidIntentExtensionConfig");
    });

    it("rejects insufficient collateral when deferred payout is disabled", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("insufficient-no-deferred");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({
        chargeback: { deferredPayoutEnabled: false },
      }));
      await fixture.vault.setTakerState(
        fixture.taker.address,
        fixture.taker.address,
        usdc(1),
        usdc(1),
        false,
      );
      await setRiskIntent(fixture, intentHash, { paymentMethod: OTHER_METHOD });
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "InsufficientCollateral");
    });

    it("requires the canonical hook for deferred payout admission", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-hook-required");
      await fixture.vault.setTakerState(
        fixture.taker.address,
        fixture.taker.address,
        usdc(1),
        usdc(1),
        false,
      );
      await setRiskIntent(fixture, intentHash);
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "DeferredPayoutHookRequired");
    });

    it("requires a configured canonical hook for deferred payout admission", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-hook-unconfigured");
      await fixture.manager.setDeferredPayoutHook(ZERO);
      await fixture.vault.setTakerState(
        fixture.taker.address,
        fixture.taker.address,
        usdc(1),
        usdc(1),
        false,
      );
      await setRiskIntent(fixture, intentHash);
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "DeferredPayoutHookRequired");
    });

    it("rejects a bonded position for an exiting stake owner", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("exiting-stake-owner");
      await fixture.vault.setTakerState(fixture.taker.address, fixture.taker.address, usdc(100), usdc(100), true);
      await setRiskIntent(fixture, intentHash);
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "StakeOwnerExiting");
    });

    it("rejects the deferred hook for a fully stake-backed position", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-hook-with-stake");
      await setRiskIntent(fixture, intentHash, { postIntentHook: fixture.orchestrator.address });
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "DeferredPayoutHookNotAllowed");
    });

    it("rejects the deferred hook for an unbonded position", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-hook-with-free");
      await setRiskIntent(fixture, intentHash, {
        amount: usdc(20), paymentMethod: ZELLE, postIntentHook: fixture.orchestrator.address,
      });
      await expect(fixture.orchestrator.createPosition(fixture.manager.address, intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "DeferredPayoutHookNotAllowed");
    });

    it("admits a zero-reservation non-chargebackable position", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("zero-stake-reservation");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, nonChargebackConfig());
      await fixture.vault.setTakerState(fixture.taker.address, fixture.taker.address, 0, 0, true);
      await createPosition(fixture, intentHash, { paymentMethod: OTHER_METHOD });
      expect((await fixture.manager.getRiskPosition(intentHash)).initialReservation).to.eq(0);
    });

    it("admits a deferred position without a cancellation bond", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("zero-cancellation-bond-deferred");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig());
      await fixture.vault.setTakerState(fixture.taker.address, fixture.taker.address, 0, 0, false);
      await createPosition(fixture, intentHash, {
        paymentMethod: OTHER_METHOD, postIntentHook: fixture.orchestrator.address,
      });
      const position = await fixture.manager.getRiskPosition(intentHash);
      expect(position.mode).to.eq(3);
      expect(position.initialReservation).to.eq(0);
    });

    it("settles a deferred position without releasing pending stake", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("zero-cancellation-bond-deferred-settlement");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig());
      await fixture.vault.setTakerState(fixture.taker.address, fixture.taker.address, 0, 0, false);
      await createPosition(fixture, intentHash, {
        paymentMethod: OTHER_METHOD, postIntentHook: fixture.orchestrator.address,
      });
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      expect((await fixture.manager.getRiskPosition(intentHash)).status).to.eq(3);
    });
  });

  describe("terminal callbacks and reconciliation", () => {
    it("rejects cancelling an unknown position", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      await expect(fixture.orchestrator.cancelPosition(fixture.manager.address, ethers.utils.id("unknown-cancel")))
        .to.be.revertedWithCustomError(fixture.manager, "PositionNotPending");
    });

    it("rejects fulfilling with a zero released amount", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("zero-release");
      await createPosition(fixture, intentHash);
      await expect(fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, 0))
        .to.be.revertedWithCustomError(fixture.manager, "ZeroAmount");
    });

    it("rejects settling an already-cancelled position", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("settle-after-cancel");
      await createPosition(fixture, intentHash);
      await fixture.orchestrator.cancelPosition(fixture.manager.address, intentHash);
      await expect(fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(10)))
        .to.be.revertedWithCustomError(fixture.manager, "PositionNotPending");
    });

    it("settles through the release callback", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("release-callback");
      await createPosition(fixture, intentHash);
      await fixture.orchestrator.releasePosition(fixture.manager.address, intentHash, usdc(50));
      expect((await fixture.manager.getRiskPosition(intentHash)).releasedAmount).to.eq(usdc(50));
    });

    it("settles an unbonded non-chargebackable position without a vault release", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("free-settlement");
      await createPosition(fixture, intentHash, { amount: usdc(20), paymentMethod: ZELLE });
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(20));
      expect((await fixture.manager.getRiskPosition(intentHash)).status).to.eq(4);
    });

    it("releases deferred authorization on cancellation", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-cancellation");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.cancelPosition(fixture.manager.address, intentHash);
      expect((await fixture.vault.deferredPayouts(intentHash)).authorized).to.eq(false);
    });

    it("rejects cancellation reconciliation without a durable record", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      await expect(fixture.manager.reconcileCancellation(ethers.utils.id("missing-cancellation")))
        .to.be.revertedWithCustomError(fixture.manager, "CancellationNotRecorded");
    });

    it("reconciles one recorded cancellation", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("single-cancellation");
      await createPosition(fixture, intentHash);
      const createdAt = (await fixture.manager.getRiskPosition(intentHash)).createdAt.toNumber();
      await fixture.orchestrator.setIntentCancellation(intentHash, createdAt + MINUTE);
      await fixture.manager.reconcileCancellation(intentHash);
      expect((await fixture.manager.getRiskPosition(intentHash)).status).to.eq(2);
    });

    it("reconciles an unbonded cancellation without a penalty", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("free-cancel-reconciliation");
      await createPosition(fixture, intentHash, { amount: usdc(20), paymentMethod: ZELLE });
      const position = await fixture.manager.getRiskPosition(intentHash);
      await fixture.orchestrator.setIntentCancellation(
        intentHash,
        position.createdAt.toNumber() + MINUTE,
      );
      await fixture.manager.reconcileCancellation(intentHash);
      const cancelled = await fixture.manager.getRiskPosition(intentHash);
      expect(cancelled.status).to.eq(2);
      expect(cancelled.slashedAmount).to.eq(0);
      expect(await fixture.vault.claimableCompensation(fixture.maker.address)).to.eq(0);
    });

    it("rejects an empty cancellation reconciliation batch", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.reconcileCancellations([])).to.be.revertedWithCustomError(manager, "EmptyBatch");
    });

    it("reconciles a batch of recorded cancellations", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const first = ethers.utils.id("batch-cancel-one");
      const second = ethers.utils.id("batch-cancel-two");
      await createPosition(fixture, first);
      await createPosition(fixture, second);
      const createdAt = (await fixture.manager.getRiskPosition(first)).createdAt.toNumber();
      await fixture.orchestrator.setIntentCancellation(first, createdAt + MINUTE);
      await fixture.orchestrator.setIntentCancellation(second, createdAt + MINUTE);
      await fixture.manager.reconcileCancellations([first, second]);
      expect((await fixture.manager.getRiskPosition(second)).status).to.eq(2);
    });

    it("rejects settlement reconciliation without a released amount", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("missing-settlement-amount");
      await fixture.orchestrator.setIntentSettlement(intentHash, 0, await time.latest());
      await expect(fixture.manager.reconcileSettlement(intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "SettlementNotRecorded");
    });

    it("rejects settlement reconciliation without a settlement timestamp", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("missing-settlement-time");
      await fixture.orchestrator.setIntentSettlement(intentHash, 1, 0);
      await expect(fixture.manager.reconcileSettlement(intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "SettlementNotRecorded");
    });

    it("reconciles one recorded settlement", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("single-settlement");
      await createPosition(fixture, intentHash);
      await fixture.orchestrator.setIntentSettlement(intentHash, usdc(50), await time.latest());
      await fixture.manager.reconcileSettlement(intentHash);
      expect((await fixture.manager.getRiskPosition(intentHash)).releasedAmount).to.eq(usdc(50));
    });

    it("rejects an empty settlement reconciliation batch", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.reconcileSettlements([])).to.be.revertedWithCustomError(manager, "EmptyBatch");
    });

    it("reconciles a batch of recorded settlements", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const first = ethers.utils.id("batch-settle-one");
      const second = ethers.utils.id("batch-settle-two");
      await createPosition(fixture, first);
      await createPosition(fixture, second);
      const now = await time.latest();
      await fixture.orchestrator.setIntentSettlement(first, usdc(40), now);
      await fixture.orchestrator.setIntentSettlement(second, usdc(50), now);
      await fixture.manager.reconcileSettlements([first, second]);
      expect((await fixture.manager.getRiskPosition(second)).status).to.eq(3);
    });

    it("rejects a coverage deadline that overflows uint64", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("coverage-overflow");
      await createPosition(fixture, intentHash);
      await fixture.orchestrator.setIntentSettlement(intentHash, usdc(50), BigNumber.from(2).pow(64).sub(1));
      await expect(fixture.manager.reconcileSettlement(intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "TimestampOverflow");
    });
  });

  describe("deferred payout registration", () => {
    it("rejects a zero deferred payout", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, ethers.utils.id("zero-deferred"), fixture.beneficiary.address, 0,
      )).to.be.revertedWithCustomError(fixture.manager, "ZeroAmount");
    });

    it("rejects an unauthorized deferred payout hook", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("unauthorized-deferred");
      await createDeferredPosition(fixture, intentHash);
      await expect(fixture.manager.connect(fixture.other).registerDeferredPayout(
        intentHash, fixture.beneficiary.address, usdc(10),
      )).to.be.revertedWithCustomError(fixture.manager, "UnauthorizedDeferredPayoutHook");
    });

    it("requires a failed-settlement record before synchronizing a pending payout", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-no-settlement");
      await createDeferredPosition(fixture, intentHash);
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(10),
      )).to.be.revertedWithCustomError(fixture.manager, "SettlementNotRecorded");
    });

    it("rejects a failed-settlement record without its original timestamp", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-settlement-without-time");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.setIntentSettlement(intentHash, usdc(50), 0);
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(10),
      )).to.be.revertedWithCustomError(fixture.manager, "SettlementNotRecorded");
    });

    it("synchronizes a failed settlement before registering proceeds", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-sync");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.setIntentSettlement(intentHash, usdc(50), await time.latest());
      await fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(50),
      );
      expect((await fixture.manager.getRiskPosition(intentHash)).deferredPayoutAmount).to.eq(usdc(50));
    });

    it("rejects registration after a deferred position is cancelled", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-cancelled-register");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.cancelPosition(fixture.manager.address, intentHash);
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(10),
      )).to.be.revertedWithCustomError(fixture.manager, "PositionNotSettled");
    });

    it("rejects a beneficiary that differs from the snapshotted recipient", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-wrong-beneficiary");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.other.address, usdc(50),
      )).to.be.revertedWithCustomError(fixture.manager, "IntentStateMismatch");
    });

    it("rejects deferred proceeds above the released amount", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-too-large");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(51),
      )).to.be.revertedWithCustomError(fixture.manager, "DeferredPayoutExceedsReleasedAmount");
    });

    it("rejects registering deferred proceeds twice", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-twice");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      await fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(50),
      );
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(50),
      )).to.be.revertedWithCustomError(fixture.manager, "DeferredPayoutAlreadyRegistered");
    });

    it("rejects deferred proceeds below the configured coverage", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-less-than-coverage");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(20),
      )).to.be.revertedWithCustomError(fixture.manager, "InsufficientDeferredPayoutCoverage");
    });

    it("caps coverage at the configured ratio when proceeds are larger", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("deferred-more-than-coverage");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({
        chargeback: { reserveBps: 5_000 },
      }));
      await fixture.vault.setTakerState(
        fixture.taker.address,
        fixture.taker.address,
        usdc(1),
        usdc(1),
        false,
      );
      await createPosition(fixture, intentHash, {
        paymentMethod: OTHER_METHOD, postIntentHook: fixture.orchestrator.address,
      });
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      await fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(50),
      );
      expect((await fixture.manager.getRiskPosition(intentHash)).reservedAmount).to.eq(usdc(25));
    });

    it("settles at the maximum supported chargeback risk window", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("maximum-risk-window-settlement");
      const maxRiskWindow = await fixture.manager.MAX_RISK_WINDOW();
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({
        chargeback: { riskWindow: maxRiskWindow, deferredPayoutEnabled: false },
      }));
      await createPosition(fixture, intentHash, { paymentMethod: OTHER_METHOD });
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      const position = await fixture.manager.getRiskPosition(intentHash);
      expect(position.coverageDeadline.sub(position.settledAt)).to.eq(maxRiskWindow);
    });
  });

  describe("maturity", () => {
    it("rejects release for a position that is not settled", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("maturity-not-settled");
      await createPosition(fixture, intentHash);
      await expect(fixture.manager.releaseMaturedPosition(intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "SettlementNotRecorded");
    });

    it("rejects release before the coverage deadline", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("maturity-too-soon");
      await createPosition(fixture, intentHash);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      await expect(fixture.manager.releaseMaturedPosition(intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "PositionNotMature");
    });

    it("rejects maturity release after a position is cancelled", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("maturity-cancelled");
      await createPosition(fixture, intentHash);
      await fixture.orchestrator.cancelPosition(fixture.manager.address, intentHash);
      await expect(fixture.manager.releaseMaturedPosition(intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "PositionNotSettled");
    });

    it("synchronizes and releases a matured recorded settlement", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("maturity-sync");
      await fixture.manager.setPlatformRiskConfig(OTHER_METHOD, chargebackConfig({ chargeback: { riskWindow: 1 } }));
      await createPosition(fixture, intentHash, { paymentMethod: OTHER_METHOD });
      await fixture.orchestrator.setIntentSettlement(intentHash, usdc(50), (await time.latest()) - 2);
      await fixture.manager.releaseMaturedPosition(intentHash);
      expect((await fixture.manager.getRiskPosition(intentHash)).status).to.eq(4);
    });

    it("rejects an empty maturity batch", async () => {
      const { manager } = await loadFixture(deployHarnessFixture);
      await expect(manager.releaseMaturedPositions([])).to.be.revertedWithCustomError(manager, "EmptyBatch");
    });

    it("releases a batch of matured positions", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const first = ethers.utils.id("maturity-batch-one");
      const second = ethers.utils.id("maturity-batch-two");
      await createPosition(fixture, first);
      await createPosition(fixture, second);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, first, usdc(50));
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, second, usdc(50));
      const deadline = (await fixture.manager.getRiskPosition(second)).coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      await fixture.manager.releaseMaturedPositions([first, second]);
      expect((await fixture.manager.getRiskPosition(second)).status).to.eq(4);
    });

    it("marks matured deferred coverage released without touching stake", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("maturity-deferred");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      await fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address, intentHash, fixture.beneficiary.address, usdc(50),
      );
      const deadline = (await fixture.manager.getRiskPosition(intentHash)).coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      await fixture.manager.releaseMaturedPosition(intentHash);
      expect((await fixture.manager.getRiskPosition(intentHash)).status).to.eq(4);
    });
  });

  describe("chargeback evidence validation", () => {
    async function settledFixture() {
      const fixture = await deployHarnessFixture();
      const intentHash = ethers.utils.id("settled-claim-position");
      await createPosition(fixture, intentHash);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      return { ...fixture, intentHash };
    }

    it("synchronizes a pending position from a settlement record before a claim", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("claim-sync");
      await createPosition(fixture, intentHash);
      await fixture.orchestrator.setIntentSettlement(intentHash, usdc(50), await time.latest());
      await fixture.manager.submitChargeback(await validAttestation(fixture, intentHash), [], "0x");
      expect((await fixture.manager.getRiskPosition(intentHash)).slashedAmount).to.eq(usdc(10));
    });

    it("rejects a claim against a released non-chargebackable position", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("claim-free-position");
      await createPosition(fixture, intentHash, { amount: usdc(20), paymentMethod: ZELLE });
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(20));
      await expect(fixture.manager.submitChargeback(await validAttestation(fixture, intentHash), [], "0x"))
        .to.be.revertedWithCustomError(fixture.manager, "PositionNotSettled");
    });

    it("rejects a claim scoped to another chain", async () => {
      const fixture = await loadFixture(settledFixture);
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash, { chainId: 1 }), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "InvalidAttestation");
    });

    it("rejects a claim scoped to another risk manager", async () => {
      const fixture = await loadFixture(settledFixture);
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash, { riskManager: fixture.other.address }), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "InvalidAttestation");
    });

    it("rejects a claim scoped to another orchestrator", async () => {
      const fixture = await loadFixture(settledFixture);
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash, { orchestrator: fixture.other.address }), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "InvalidAttestation");
    });

    it("rejects a claim for another payment method", async () => {
      const fixture = await loadFixture(settledFixture);
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash, { paymentMethod: OTHER_METHOD }), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "InvalidAttestation");
    });

    it("rejects a zero chargeback amount", async () => {
      const fixture = await loadFixture(settledFixture);
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash, { chargebackAmount: 0 }), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "InvalidAttestation");
    });

    it("rejects an empty evidence identifier", async () => {
      const fixture = await loadFixture(settledFixture);
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash, { evidenceId: ethers.constants.HashZero }), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "InvalidAttestation");
    });

    it("rejects an attestation before validAfter", async () => {
      const fixture = await loadFixture(settledFixture);
      const now = await time.latest();
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash, { validAfter: now + DAY, validUntil: now + 2 * DAY }), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "AttestationNotYetValid");
    });

    it("rejects an expired attestation", async () => {
      const fixture = await loadFixture(settledFixture);
      const now = await time.latest();
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash, { validAfter: now - DAY, validUntil: now - 1 }), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "AttestationExpired");
    });

    it("rejects an attestation that fails verification", async () => {
      const fixture = await loadFixture(settledFixture);
      await fixture.verifier.setResult(false);
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, fixture.intentHash), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "AttestationVerificationFailed");
    });

    it("rejects a claim before deferred proceeds establish coverage", async () => {
      const fixture = await loadFixture(deployHarnessFixture);
      const intentHash = ethers.utils.id("claim-zero-deferred-coverage");
      await createDeferredPosition(fixture, intentHash);
      await fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, usdc(50));
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, intentHash), [], "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "ZeroAmount");
    });
  });

  describe("reentrancy guards", () => {
    async function deployGuardFixture() {
      const fixture = await deployHarnessFixture();
      const manager = await (await ethers.getContractFactory("RiskManagerStateHarness")).deploy(
        fixture.owner.address,
        fixture.orchestrator.address,
        fixture.vault.address,
        fixture.verifier.address,
      );
      return { ...fixture, manager };
    }

    async function expectGuardRevert(fixture: Awaited<ReturnType<typeof deployGuardFixture>>, data: string) {
      await expect(fixture.manager.callWhileEntered(fixture.manager.address, data))
        .to.be.revertedWith("ReentrancyGuard: reentrant call");
    }

    it("blocks reentrant intent admission", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      const intentHash = ethers.utils.id("guard-admission");
      const data = fixture.orchestrator.interface.encodeFunctionData("createPosition", [
        fixture.manager.address,
        intentHash,
      ]);
      await expect(fixture.manager.callWhileEntered(fixture.orchestrator.address, data))
        .to.be.revertedWith("ReentrancyGuard: reentrant call");
    });

    it("blocks a reentrant cancellation callback", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      const data = fixture.orchestrator.interface.encodeFunctionData("cancelPosition", [
        fixture.manager.address,
        ethers.utils.id("guard-cancellation"),
      ]);
      await expect(fixture.manager.callWhileEntered(fixture.orchestrator.address, data))
        .to.be.revertedWith("ReentrancyGuard: reentrant call");
    });

    it("blocks a reentrant fulfillment callback", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      const data = fixture.orchestrator.interface.encodeFunctionData("fulfillPosition", [
        fixture.manager.address,
        ethers.utils.id("guard-fulfillment"),
        1,
      ]);
      await expect(fixture.manager.callWhileEntered(fixture.orchestrator.address, data))
        .to.be.revertedWith("ReentrancyGuard: reentrant call");
    });

    it("blocks a reentrant maker-release callback", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      const data = fixture.orchestrator.interface.encodeFunctionData("releasePosition", [
        fixture.manager.address,
        ethers.utils.id("guard-release"),
        1,
      ]);
      await expect(fixture.manager.callWhileEntered(fixture.orchestrator.address, data))
        .to.be.revertedWith("ReentrancyGuard: reentrant call");
    });

    it("blocks reentrant cancellation reconciliation", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      await expectGuardRevert(
        fixture,
        fixture.manager.interface.encodeFunctionData("reconcileCancellation", [ethers.constants.HashZero]),
      );
    });

    it("blocks reentrant cancellation batch reconciliation", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      await expectGuardRevert(
        fixture,
        fixture.manager.interface.encodeFunctionData("reconcileCancellations", [[ethers.constants.HashZero]]),
      );
    });

    it("blocks reentrant settlement reconciliation", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      await expectGuardRevert(
        fixture,
        fixture.manager.interface.encodeFunctionData("reconcileSettlement", [ethers.constants.HashZero]),
      );
    });

    it("blocks reentrant settlement batch reconciliation", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      await expectGuardRevert(
        fixture,
        fixture.manager.interface.encodeFunctionData("reconcileSettlements", [[ethers.constants.HashZero]]),
      );
    });

    it("blocks reentrant deferred payout registration", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      await expectGuardRevert(
        fixture,
        fixture.manager.interface.encodeFunctionData("registerDeferredPayout", [
          ethers.constants.HashZero,
          fixture.beneficiary.address,
          1,
        ]),
      );
    });

    it("blocks reentrant maturity release", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      await expectGuardRevert(
        fixture,
        fixture.manager.interface.encodeFunctionData("releaseMaturedPosition", [ethers.constants.HashZero]),
      );
    });

    it("blocks reentrant maturity batch release", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      await expectGuardRevert(
        fixture,
        fixture.manager.interface.encodeFunctionData("releaseMaturedPositions", [[ethers.constants.HashZero]]),
      );
    });

    it("blocks reentrant chargeback submission", async () => {
      const fixture = await loadFixture(deployGuardFixture);
      const attestation = await validAttestation(fixture, ethers.constants.HashZero);
      await expectGuardRevert(
        fixture,
        fixture.manager.interface.encodeFunctionData("submitChargeback", [attestation, [], "0x"]),
      );
    });
  });

  describe("defensive state-invariant guards", () => {
    async function deployStateHarnessFixture() {
      const fixture = await deployHarnessFixture();
      const manager = await (await ethers.getContractFactory("RiskManagerStateHarness")).deploy(
        fixture.owner.address,
        fixture.orchestrator.address,
        fixture.vault.address,
        fixture.verifier.address,
      );
      return { ...fixture, manager };
    }

    it("rejects deferred registration for an impossible non-deferred position", async () => {
      const fixture = await loadFixture(deployStateHarnessFixture);
      const intentHash = ethers.utils.id("forced-register-mode");
      await fixture.manager.forcePosition(intentHash, 2, 3, fixture.orchestrator.address, PAYPAL, 10_000, 1);
      await expect(fixture.orchestrator.registerDeferredPayout(
        fixture.manager.address,
        intentHash,
        fixture.beneficiary.address,
        1,
      )).to.be.revertedWithCustomError(fixture.manager, "PositionModeMismatch");
    });

    it("rejects settlement for an impossible chargebackable unbonded position", async () => {
      const fixture = await loadFixture(deployStateHarnessFixture);
      const intentHash = ethers.utils.id("forced-settlement-mode");
      await fixture.manager.forcePosition(intentHash, 1, 1, ZERO, PAYPAL, 1, 0);
      await expect(fixture.orchestrator.fulfillPosition(fixture.manager.address, intentHash, 1))
        .to.be.revertedWithCustomError(fixture.manager, "PositionModeMismatch");
    });

    it("rejects chargeback evidence for an impossible settled unbonded position", async () => {
      const fixture = await loadFixture(deployStateHarnessFixture);
      const intentHash = ethers.utils.id("forced-claim-mode");
      await fixture.manager.forcePosition(
        intentHash,
        1,
        3,
        ZERO,
        PAYPAL,
        10_000,
        (await time.latest()) + DAY,
      );
      await expect(fixture.manager.submitChargeback(
        await validAttestation(fixture, intentHash),
        [],
        "0x",
      )).to.be.revertedWithCustomError(fixture.manager, "PositionModeMismatch");
    });

    it("rejects maturity for an impossible settled position with no deadline", async () => {
      const fixture = await loadFixture(deployStateHarnessFixture);
      const intentHash = ethers.utils.id("forced-zero-deadline");
      await fixture.manager.forcePosition(intentHash, 2, 3, ZERO, PAYPAL, 10_000, 0);
      await expect(fixture.manager.releaseMaturedPosition(intentHash))
        .to.be.revertedWithCustomError(fixture.manager, "PositionNotMature");
    });
  });
});
