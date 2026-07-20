import "module-alias/register";

import { expect } from "chai";
import { deployments, ethers } from "hardhat";

import {
  riskSettlementPlatformPolicyForNetwork,
  riskWitnessConfigForNetwork,
} from "../../deploy/28_deploy_risk_settlement_system";
import {
  MULTI_SIG,
  RISK_CALLBACK_GAS_LIMIT,
  STAKE_VAULT_BASE_EXIT_DELAY,
} from "../../deployments/parameters";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

describe("Risk-manager-owned settlement deployment", () => {
  const network = deployments.getNetworkName();
  const platformPolicy = riskSettlementPlatformPolicyForNetwork(network);

  function deployedAddress(contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  async function contracts() {
    const [deployer] = await ethers.getSigners();
    return {
      deployer,
      orchestrator: await ethers.getContractAt("OrchestratorV3", deployedAddress("OrchestratorV3")),
      vault: await ethers.getContractAt("StakeVault", deployedAddress("StakeVault")),
      manager: await ethers.getContractAt("RiskManager", deployedAddress("RiskManager")),
      nullifierV2: await ethers.getContractAt("NullifierRegistryV2", deployedAddress("NullifierRegistryV2")),
      legacyNullifier: await ethers.getContractAt("NullifierRegistry", deployedAddress("NullifierRegistry")),
      paymentRegistry: await ethers.getContractAt(
        "PaymentVerifierRegistry",
        deployedAddress("PaymentVerifierRegistry"),
      ),
      paymentVerifierV3: await ethers.getContractAt(
        "UnifiedPaymentVerifierV3",
        deployedAddress("UnifiedPaymentVerifierV3"),
      ),
      riskAttestationVerifier: await ethers.getContractAt(
        "MultiAttestationVerifier",
        deployedAddress("RiskAttestationVerifier"),
      ),
      paymentAttestationVerifier: await ethers.getContractAt(
        "MultiAttestationVerifier",
        deployedAddress("MultiAttestationVerifier"),
      ),
      orchestratorRegistry: await ethers.getContractAt(
        "OrchestratorRegistry",
        deployedAddress("OrchestratorRegistry"),
      ),
    };
  }

  it("deploys the complete linked settlement boundary without an active deferred hook", async () => {
    expect(deployedAddress("BoundedCall")).to.properAddress;
    expect(deployedAddress("PostIntentHookExecutor")).to.properAddress;
    expect(deployedAddress("RiskSettlementExecutor")).to.properAddress;
    expect(deployedAddress("FeeSettlementLib")).to.properAddress;
    expect(deployedAddress("OrchestratorV3")).to.properAddress;
    expect(deployedAddress("StakeVault")).to.properAddress;
    expect(deployedAddress("RiskManager")).to.properAddress;

    const { manager } = await contracts();
    const functions = manager.interface.functions as Record<string, unknown>;
    expect(functions["deferredPayoutHook()"]).to.eq(undefined);
    expect(functions["setDeferredPayoutHook(address)"]).to.eq(undefined);
  });

  it("wires the fresh canonical vault and immutable manager dependencies", async () => {
    const { orchestrator, vault, manager, nullifierV2 } = await contracts();
    expect(await vault.controller()).to.eq(manager.address);
    expect(await manager.orchestrator()).to.eq(orchestrator.address);
    expect(await manager.stakeVault()).to.eq(vault.address);
    expect(await manager.nullifierRegistry()).to.eq(nullifierV2.address);
  });

  it("transfers every owned component to the configured multisig", async () => {
    const {
      deployer,
      orchestrator,
      vault,
      manager,
      nullifierV2,
      paymentVerifierV3,
      riskAttestationVerifier,
    } = await contracts();
    const expectedOwner = MULTI_SIG[network] || deployer.address;
    expect(await orchestrator.owner()).to.eq(expectedOwner);
    expect(await vault.owner()).to.eq(expectedOwner);
    expect(await manager.owner()).to.eq(expectedOwner);
    expect(await nullifierV2.owner()).to.eq(expectedOwner);
    expect(await paymentVerifierV3.owner()).to.eq(expectedOwner);
    expect(await riskAttestationVerifier.owner()).to.eq(expectedOwner);
  });

  it("uses a governance-ratified witness domain independent from payment attestations", async () => {
    const { manager, riskAttestationVerifier, paymentAttestationVerifier } = await contracts();
    const expected = riskWitnessConfigForNetwork(network);
    const riskWitnesses = (await riskAttestationVerifier.witnesses()).map((w) => w.toLowerCase());
    const paymentWitnesses = (await paymentAttestationVerifier.witnesses()).map((w) => w.toLowerCase());

    expect(await manager.attestationVerifier()).to.eq(riskAttestationVerifier.address);
    expect(riskWitnesses).to.have.members(expected.witnesses.map((w) => w.toLowerCase()));
    expect(await riskAttestationVerifier.requiredSignatures()).to.eq(expected.threshold);
    expect(riskWitnesses.some((witness) => paymentWitnesses.includes(witness))).to.eq(false);
  });

  it("performs the one-way payment-nullifier cutover", async () => {
    const { nullifierV2, legacyNullifier, paymentRegistry, paymentVerifierV3 } = await contracts();
    expect(await nullifierV2.legacyNullifierRegistry()).to.eq(legacyNullifier.address);
    expect(await nullifierV2.isWriter(paymentVerifierV3.address)).to.eq(true);
    expect(await legacyNullifier.getWriters()).to.deep.eq([]);

    const methods = await paymentRegistry.getPaymentMethods();
    expect(methods.length).to.be.greaterThan(0);
    expect(await paymentVerifierV3.getPaymentMethods()).to.have.members(methods);
    for (const method of methods) {
      expect(await paymentRegistry.getVerifier(method)).to.eq(paymentVerifierV3.address);
    }
  });

  it("registers the new orchestrator and preserves the configured lifecycle controls", async () => {
    const { orchestrator, orchestratorRegistry } = await contracts();
    expect(await orchestratorRegistry.isOrchestrator(orchestrator.address)).to.eq(true);
    expect(await orchestrator.allowMultipleIntents()).to.eq(true);
    expect(await orchestrator.riskCallbackGasLimit()).to.eq(RISK_CALLBACK_GAS_LIMIT);
  });

  it("sets the configured vault exit delay", async () => {
    const { vault } = await contracts();
    expect(await vault.baseExitDelay()).to.eq(STAKE_VAULT_BASE_EXIT_DELAY);
  });

  for (const [label, paymentMethod] of [["PayPal", PAYPAL], ["Venmo", VENMO]] as const) {
    it(`configures ${label} for stake-backed or risk-manager-funded deferred settlement`, async () => {
      const { manager } = await contracts();
      const config = await manager.getPlatformRiskConfig(paymentMethod);
      expect(config.enabled).to.eq(true);
      expect(config.chargeback.chargebackable).to.eq(true);
      expect(config.chargeback.deferredPayoutEnabled).to.eq(true);
      expect(config.chargeback.reserveBps).to.eq(platformPolicy.reversible.chargeback.reserveBps);
      expect(config.chargeback.riskWindow).to.eq(platformPolicy.reversible.chargeback.riskWindow);
      expect(config.griefing.baseUnbondedAmount).to.eq(0);
    });
  }

  it("configures the reusable unbonded base only for non-chargebackable Zelle", async () => {
    const { manager } = await contracts();
    const config = await manager.getPlatformRiskConfig(ZELLE);
    expect(config.enabled).to.eq(true);
    expect(config.chargeback.chargebackable).to.eq(false);
    expect(config.chargeback.deferredPayoutEnabled).to.eq(false);
    expect(config.chargeback.reserveBps).to.eq(0);
    expect(config.griefing.baseUnbondedAmount)
      .to.eq(platformPolicy.nonChargebackable.griefing.baseUnbondedAmount);
  });

  it("requires an explicit governance-ratified production policy", async () => {
    expect(() => riskSettlementPlatformPolicyForNetwork("base")).to.throw(
      "No governance-ratified risk-settlement platform policy for network: base",
    );
    expect(() => riskWitnessConfigForNetwork("base_staging")).to.throw(
      "No governance-ratified chargeback witness policy for network: base_staging",
    );
  });
});
