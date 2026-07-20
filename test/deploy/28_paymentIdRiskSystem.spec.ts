import "module-alias/register";

import { expect } from "chai";
import hre, { deployments, ethers } from "hardhat";

import deployPaymentIdRiskSystem, {
  assertCanonicalHardCutAuthorizations,
  assertResumableNonLocalPaymentIdRiskDeployment,
  BASE_STAGING_FINAL_CANONICAL_ALIASES,
  paymentIdRiskPlatformPolicyForNetwork,
  PAYMENT_ID_RISK_DEPLOYMENT_NAMES,
  requireHistoricalPostIntentHookExecutor,
  saveCanonicalBaseStagingAliases,
} from "../../deploy/28_deploy_payment_id_risk_system";
import {
  MULTI_SIG,
  RISK_CALLBACK_GAS_LIMIT,
} from "../../deployments/parameters";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

describe("Payment-ID-bound final risk system deployment", () => {
  const network = deployments.getNetworkName();
  const policy = paymentIdRiskPlatformPolicyForNetwork(network);

  function deployedAddress(name: string): string {
    return require(`../../deployments/${network}/${name}.json`).address;
  }

  async function contracts() {
    return {
      legacyRegistry: await ethers.getContractAt(
        "PaymentVerifierRegistry",
        deployedAddress("PaymentVerifierRegistry"),
      ),
      legacyVerifier: await ethers.getContractAt(
        "UnifiedPaymentVerifier",
        deployedAddress("UnifiedPaymentVerifierV2"),
      ),
      newVerifier: await ethers.getContractAt(
        "UnifiedPaymentVerifierV3",
        deployedAddress("UnifiedPaymentVerifierV3"),
      ),
      orchestrator: await ethers.getContractAt(
        "OrchestratorV3",
        deployedAddress("OrchestratorV3PaymentId"),
      ),
      vault: await ethers.getContractAt("StakeVault", deployedAddress("StakeVaultPaymentId")),
      manager: await ethers.getContractAt("RiskManager", deployedAddress("RiskManagerPaymentId")),
      deferredHook: await ethers.getContractAt(
        "DeferredPayoutHook",
        deployedAddress("DeferredPayoutHookPaymentId"),
      ),
      chargebackVerifier: await ethers.getContractAt(
        "MultiAttestationVerifier",
        deployedAddress("ChargebackAttestationVerifierPaymentId"),
      ),
      legacyNullifierRegistry: await ethers.getContractAt(
        "NullifierRegistry",
        deployedAddress("NullifierRegistry"),
      ),
      nullifierRegistryV2: await ethers.getContractAt(
        "NullifierRegistryV2",
        deployedAddress("NullifierRegistryV2"),
      ),
      orchestratorRegistry: await ethers.getContractAt(
        "OrchestratorRegistry",
        deployedAddress("OrchestratorRegistry"),
      ),
    };
  }

  it("deploys every versioned coordinate while preserving the legacy nullifier predecessor", async () => {
    for (const name of PAYMENT_ID_RISK_DEPLOYMENT_NAMES) {
      expect(deployedAddress(name)).to.properAddress;
    }
    expect(deployedAddress("NullifierRegistryV2"))
      .not.to.eq(deployedAddress("NullifierRegistry"));
    expect(deployedAddress("UnifiedPaymentVerifierV3"))
      .not.to.eq(deployedAddress("UnifiedPaymentVerifierV2"));
  });

  it("hard-cuts exact live payment methods and currencies to UPV3 in the shared registry", async () => {
    const { legacyRegistry, newVerifier } = await contracts();
    const legacyMethods: string[] = await legacyRegistry.getPaymentMethods();
    const verifierMethods: string[] = await newVerifier.getPaymentMethods();
    expect(verifierMethods.map((value) => value.toLowerCase())).to.have.members(
      legacyMethods.map((value) => value.toLowerCase()),
    );
    for (const method of legacyMethods) {
      expect(await legacyRegistry.getVerifier(method)).to.eq(newVerifier.address);
      const currencies = (await legacyRegistry.getCurrencies(method))
        .map((value: string) => value.toLowerCase());
      expect(currencies).not.to.be.empty;
      expect(new Set(currencies).size).to.eq(currencies.length);
    }
  });

  it("binds new payments to intents and permanently retires the legacy writer", async () => {
    const {
      legacyVerifier,
      newVerifier,
      orchestrator,
      legacyNullifierRegistry,
      nullifierRegistryV2,
      orchestratorRegistry,
    } = await contracts();
    expect(await legacyNullifierRegistry.isWriter(legacyVerifier.address)).to.eq(false);
    expect(await nullifierRegistryV2.isWriter(newVerifier.address)).to.eq(true);
    expect(await newVerifier.nullifierRegistry()).to.eq(nullifierRegistryV2.address);
    expect(await nullifierRegistryV2.legacyNullifierRegistry()).to.eq(legacyNullifierRegistry.address);
    expect(await newVerifier.orchestratorRegistry()).to.eq(orchestratorRegistry.address);
    expect(await orchestratorRegistry.isOrchestrator(orchestrator.address)).to.eq(true);
    expect(await orchestrator.paymentVerifierRegistry()).to.eq(deployedAddress("PaymentVerifierRegistry"));
    const escrowV2 = await ethers.getContractAt("EscrowV2", deployedAddress("EscrowV2"));
    expect(await escrowV2.orchestratorRegistry()).to.eq(orchestratorRegistry.address);
  });

  it("wires and owns the versioned risk components", async () => {
    const [deployer] = await ethers.getSigners();
    const { newVerifier, orchestrator, vault, manager, deferredHook, chargebackVerifier, nullifierRegistryV2 } =
      await contracts();
    const expectedOwner = MULTI_SIG[network] || deployer.address;
    for (const owned of [nullifierRegistryV2, newVerifier, orchestrator, vault, manager, chargebackVerifier]) {
      expect(await owned.owner()).to.eq(expectedOwner);
    }
    expect(await orchestrator.riskCallbackGasLimit()).to.eq(RISK_CALLBACK_GAS_LIMIT);
    expect(await orchestrator.allowMultipleIntents()).to.eq(true);
    expect(await vault.controller()).to.eq(manager.address);
    expect(await manager.orchestrator()).to.eq(orchestrator.address);
    expect(await manager.stakeVault()).to.eq(vault.address);
    expect(await manager.nullifierRegistry()).to.eq(nullifierRegistryV2.address);
    expect(await manager.deferredPayoutHook()).to.eq(deferredHook.address);
    expect(await deferredHook.riskManager()).to.eq(manager.address);
  });

  it("uses a dedicated 2-of-3 chargeback witness set disjoint from live payment witnesses", async () => {
    const { legacyVerifier, chargebackVerifier } = await contracts();
    const paymentVerifier = await ethers.getContractAt(
      "MultiAttestationVerifier",
      await legacyVerifier.attestationVerifier(),
    );
    const paymentWitnesses = new Set(
      (await paymentVerifier.witnesses()).map((value: string) => value.toLowerCase()),
    );
    const chargebackWitnesses: string[] = await chargebackVerifier.witnesses();
    expect(chargebackWitnesses).to.have.length(3);
    expect(await chargebackVerifier.requiredSignatures()).to.eq(2);
    expect(chargebackWitnesses.some((value) => paymentWitnesses.has(value.toLowerCase()))).to.eq(false);
  });

  for (const [label, method] of [["PayPal", PAYPAL], ["Venmo", VENMO]] as const) {
    it(`configures ${label} as full-reserve chargebackable`, async () => {
      const { manager } = await contracts();
      const config = await manager.getPlatformRiskConfig(method);
      expect(config.enabled).to.eq(true);
      expect(config.chargeback.chargebackable).to.eq(true);
      expect(config.chargeback.deferredPayoutEnabled).to.eq(true);
      expect(config.chargeback.reserveBps).to.eq(policy.reversible.chargeback.reserveBps);
      expect(config.chargeback.riskWindow).to.eq(policy.reversible.chargeback.riskWindow);
    });
  }

  it("keeps Zelle non-chargebackable", async () => {
    const { manager } = await contracts();
    const config = await manager.getPlatformRiskConfig(ZELLE);
    expect(config.enabled).to.eq(true);
    expect(config.chargeback.chargebackable).to.eq(false);
    expect(config.chargeback.reserveBps).to.eq(0);
  });

  it("allows a fresh nonlocal deployment and exact complete reruns", async () => {
    await expect(assertResumableNonLocalPaymentIdRiskDeployment(
      "base_staging",
      async () => "missing",
    )).not.to.be.rejected;
    await expect(assertResumableNonLocalPaymentIdRiskDeployment(
      "base_staging",
      async () => "matching",
    )).not.to.be.rejected;
  });

  it("resumes an exact deployment prefix but rejects drift and impossible ordering", async () => {
    await expect(assertResumableNonLocalPaymentIdRiskDeployment(
      "base_staging",
      async (name) => PAYMENT_ID_RISK_DEPLOYMENT_NAMES.indexOf(name) < 5 ? "matching" : "missing",
    )).not.to.be.rejected;
    await expect(assertResumableNonLocalPaymentIdRiskDeployment(
      "base_staging",
      async (name) => {
        if (name === "NullifierRegistryV2") return "matching";
        return name === "UnifiedPaymentVerifierV3" ? "different" : "missing";
      },
    )).to.be.rejectedWith("differs from the reviewed bytecode, libraries, or arguments");
    await expect(assertResumableNonLocalPaymentIdRiskDeployment(
      "base_staging",
      async (name) => name === "NullifierRegistryV2" ? "missing" : "matching",
    )).to.be.rejectedWith("impossible non-prefix");
  });

  it("fails descriptively when the historical settlement executor prerequisite is absent", async () => {
    await expect(requireHistoricalPostIntentHookExecutor("base", async () => null))
      .to.be.rejectedWith("base requires the historical PostIntentHookExecutor deployment");
  });

  it("hard-cuts Base staging canonical aliases while archiving the pre-final affine records", async () => {
    const records = new Map<string, any>();
    const saveCounts = new Map<string, number>();
    for (const [canonicalName, finalName] of BASE_STAGING_FINAL_CANONICAL_ALIASES) {
      records.set(canonicalName, { address: ethers.Wallet.createRandom().address });
      records.set(finalName, { address: ethers.Wallet.createRandom().address });
    }

    await saveCanonicalBaseStagingAliases(
      "base_staging",
      async (name) => records.get(name),
      async (name) => records.get(name) ?? null,
      async (name, deployment) => {
        records.set(name, deployment);
        saveCounts.set(name, (saveCounts.get(name) ?? 0) + 1);
      },
    );

    for (const [canonicalName, finalName, archiveName] of BASE_STAGING_FINAL_CANONICAL_ALIASES) {
      expect(records.get(canonicalName).address).to.eq(records.get(finalName).address);
      expect(records.get(archiveName).address).not.to.eq(records.get(finalName).address);
      expect(saveCounts.get(archiveName)).to.eq(1);
    }

    await saveCanonicalBaseStagingAliases(
      "base_staging",
      async (name) => records.get(name),
      async (name) => records.get(name) ?? null,
      async (name, deployment) => {
        records.set(name, deployment);
        saveCounts.set(name, (saveCounts.get(name) ?? 0) + 1);
      },
    );
    for (const [, , archiveName] of BASE_STAGING_FINAL_CANONICAL_ALIASES) {
      expect(saveCounts.get(archiveName)).to.eq(1);
    }

    const [canonicalName] = BASE_STAGING_FINAL_CANONICAL_ALIASES[
      BASE_STAGING_FINAL_CANONICAL_ALIASES.length - 1
    ];
    records.set(canonicalName, { address: ethers.Wallet.createRandom().address });
    const writesBeforeConflict = Array.from(saveCounts.values()).reduce((total, count) => total + count, 0);
    await expect(saveCanonicalBaseStagingAliases(
      "base_staging",
      async (name) => records.get(name),
      async (name) => records.get(name) ?? null,
      async (name, deployment) => {
        records.set(name, deployment);
        saveCounts.set(name, (saveCounts.get(name) ?? 0) + 1);
      },
    )).to.be.rejectedWith("already preserves a different historical deployment");
    expect(Array.from(saveCounts.values()).reduce((total, count) => total + count, 0))
      .to.eq(writesBeforeConflict);
  });

  it("fails closed when Safe-owned registry authorizations are only queued", () => {
    expect(() => assertCanonicalHardCutAuthorizations({
      orchestratorRegistered: false,
      newVerifierWriter: true,
      legacyVerifierRevoked: true,
      paymentMethodsRouted: true,
      nullifierPredecessorMatches: true,
      managerNullifierRegistryMatches: true,
      orchestratorVerifierRegistryMatches: true,
      orchestratorEscrowRegistryMatches: true,
      escrowAuthorized: true,
      escrowOrchestratorRegistryMatches: true,
    })).to.throw("registry admission must be executed");
    expect(() => assertCanonicalHardCutAuthorizations({
      orchestratorRegistered: true,
      newVerifierWriter: false,
      legacyVerifierRevoked: true,
      paymentMethodsRouted: true,
      nullifierPredecessorMatches: true,
      managerNullifierRegistryMatches: true,
      orchestratorVerifierRegistryMatches: true,
      orchestratorEscrowRegistryMatches: true,
      escrowAuthorized: true,
      escrowOrchestratorRegistryMatches: true,
    })).to.throw("write permission must be executed");
    expect(() => assertCanonicalHardCutAuthorizations({
      orchestratorRegistered: true,
      newVerifierWriter: true,
      legacyVerifierRevoked: true,
      paymentMethodsRouted: true,
      nullifierPredecessorMatches: true,
      managerNullifierRegistryMatches: true,
      orchestratorVerifierRegistryMatches: true,
      orchestratorEscrowRegistryMatches: true,
      escrowAuthorized: true,
      escrowOrchestratorRegistryMatches: false,
    })).to.throw("EscrowV2 orchestrator registry mismatch");
  });

  it("reruns locally without changing versioned addresses or wiring", async function () {
    this.timeout(180_000);
    const before = PAYMENT_ID_RISK_DEPLOYMENT_NAMES.map(deployedAddress);
    const { vault, manager } = await contracts();
    await deployPaymentIdRiskSystem(hre);
    expect(PAYMENT_ID_RISK_DEPLOYMENT_NAMES.map(deployedAddress)).to.deep.eq(before);
    expect(await vault.controller()).to.eq(manager.address);
  });
});
