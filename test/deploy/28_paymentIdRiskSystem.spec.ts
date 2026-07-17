import "module-alias/register";

import { expect } from "chai";
import { deployments, ethers } from "hardhat";

import {
  assertFreshNonLocalPaymentIdRiskDeployment,
  PAYMENT_ID_RISK_DEPLOYMENT_NAMES,
  requireHistoricalPostIntentHookExecutor,
} from "../../deploy/28_deploy_payment_id_risk_system";
import {
  MULTI_SIG,
  RISK_CALLBACK_GAS_LIMIT,
} from "../../deployments/parameters";
import { stakeRiskPlatformPolicyForNetwork } from "../../deploy/26_deploy_stake_risk_system";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

describe("Payment-ID-aware parallel risk system deployment", () => {
  const network = deployments.getNetworkName();
  const policy = stakeRiskPlatformPolicyForNetwork(network);

  function deployedAddress(name: string): string {
    return require(`../../deployments/${network}/${name}.json`).address;
  }

  async function contracts() {
    return {
      legacyRegistry: await ethers.getContractAt(
        "PaymentVerifierRegistry",
        deployedAddress("PaymentVerifierRegistry"),
      ),
      newRegistry: await ethers.getContractAt(
        "PaymentVerifierRegistry",
        deployedAddress("PaymentVerifierRegistryV3"),
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
      nullifierRegistry: await ethers.getContractAt(
        "NullifierRegistry",
        deployedAddress("NullifierRegistry"),
      ),
      orchestratorRegistry: await ethers.getContractAt(
        "OrchestratorRegistry",
        deployedAddress("OrchestratorRegistry"),
      ),
    };
  }

  it("deploys every versioned coordinate without replacing the legacy lane", async () => {
    for (const name of PAYMENT_ID_RISK_DEPLOYMENT_NAMES) {
      expect(deployedAddress(name)).to.properAddress;
    }
    expect(deployedAddress("PaymentVerifierRegistryV3"))
      .not.to.eq(deployedAddress("PaymentVerifierRegistry"));
    expect(deployedAddress("UnifiedPaymentVerifierV3"))
      .not.to.eq(deployedAddress("UnifiedPaymentVerifierV2"));
  });

  it("mirrors exact live payment methods and currencies into the new registry", async () => {
    const { legacyRegistry, newRegistry, legacyVerifier, newVerifier } = await contracts();
    const legacyMethods: string[] = await legacyRegistry.getPaymentMethods();
    const newMethods: string[] = await newRegistry.getPaymentMethods();
    const verifierMethods: string[] = await newVerifier.getPaymentMethods();
    expect(newMethods.map((value) => value.toLowerCase())).to.have.members(
      legacyMethods.map((value) => value.toLowerCase()),
    );
    expect(verifierMethods.map((value) => value.toLowerCase())).to.have.members(
      legacyMethods.map((value) => value.toLowerCase()),
    );
    for (const method of legacyMethods) {
      expect(await legacyRegistry.getVerifier(method)).to.eq(legacyVerifier.address);
      expect(await newRegistry.getVerifier(method)).to.eq(newVerifier.address);
      expect((await newRegistry.getCurrencies(method)).map((value: string) => value.toLowerCase()))
        .to.have.members((await legacyRegistry.getCurrencies(method)).map((value: string) => value.toLowerCase()));
    }
  });

  it("shares replay protection while keeping independent registry routing", async () => {
    const {
      legacyVerifier,
      newVerifier,
      orchestrator,
      nullifierRegistry,
      orchestratorRegistry,
    } = await contracts();
    expect(await nullifierRegistry.isWriter(legacyVerifier.address)).to.eq(true);
    expect(await nullifierRegistry.isWriter(newVerifier.address)).to.eq(true);
    expect(await newVerifier.nullifierRegistry()).to.eq(nullifierRegistry.address);
    expect(await newVerifier.orchestratorRegistry()).to.eq(orchestratorRegistry.address);
    expect(await orchestratorRegistry.isOrchestrator(orchestrator.address)).to.eq(true);
    expect(await orchestrator.paymentVerifierRegistry()).to.eq(deployedAddress("PaymentVerifierRegistryV3"));
  });

  it("wires and owns the versioned risk components", async () => {
    const [deployer] = await ethers.getSigners();
    const { newRegistry, newVerifier, orchestrator, vault, manager, deferredHook, chargebackVerifier } =
      await contracts();
    const expectedOwner = MULTI_SIG[network] || deployer.address;
    for (const owned of [newRegistry, newVerifier, orchestrator, vault, manager, chargebackVerifier]) {
      expect(await owned.owner()).to.eq(expectedOwner);
    }
    expect(await orchestrator.riskCallbackGasLimit()).to.eq(RISK_CALLBACK_GAS_LIMIT);
    expect(await orchestrator.allowMultipleIntents()).to.eq(true);
    expect(await vault.controller()).to.eq(manager.address);
    expect(await manager.orchestrator()).to.eq(orchestrator.address);
    expect(await manager.stakeVault()).to.eq(vault.address);
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
    expect(config.griefing.baseUnbondedAmount).to.eq(policy.nonChargebackable.griefing.baseUnbondedAmount);
  });

  it("rejects any existing versioned coordinate before a nonlocal deployment", async () => {
    await expect(assertFreshNonLocalPaymentIdRiskDeployment("base_staging", async (name) => (
      name === "UnifiedPaymentVerifierV3" ? { address: ethers.constants.AddressZero } : null
    ))).to.be.rejectedWith("use a new governance-reviewed version");
  });

  it("fails descriptively when the historical settlement executor prerequisite is absent", async () => {
    await expect(requireHistoricalPostIntentHookExecutor("base", async () => null))
      .to.be.rejectedWith("base requires the historical PostIntentHookExecutor deployment");
  });
});
