import type { DeployFunction } from "hardhat-deploy/types";
import { constants, utils } from "ethers";
import { assertCanonicalDeployment } from "../deployments/canonicalDeployment";
import { DISPUTABLE_PAYMENT_METHODS, DISPUTE_RISK_WINDOW } from "../deployments/parameters";

const TAG = "43_deploy_local_payment_policy_stack";

/** Current policy integration fixture. Live activation requires its own reviewed lane. */
const func: DeployFunction = async (hre) => {
  const network = hre.deployments.getNetworkName();
  if (network !== "localhost" && network !== "hardhat") {
    throw new Error("Payment policy lane is local-only");
  }
  const [deployer] = await hre.getUnnamedAccounts();
  const signer = await hre.ethers.getSigner(deployer);
  const orchestrator = await hre.ethers.getContractAt(
    "OrchestratorV3", (await hre.deployments.get("OrchestratorV3")).address, signer
  );
  const upv = await hre.ethers.getContractAt(
    "UnifiedPaymentVerifierV3", (await hre.deployments.get("UnifiedPaymentVerifierV3")).address, signer
  );
  const oldVault = await hre.ethers.getContractAt(
    "StakeVault", (await hre.deployments.get("StakeVaultMethodScoped")).address, signer
  );
  const disputeVerifier = await hre.deployments.get("DisputeVerifier");
  const disputeRegistry = await hre.deployments.get("DisputeNullifierRegistry");
  const orchestratorRegistry = await hre.deployments.get("OrchestratorRegistry");
  const whitelist = await hre.deployments.get("WhitelistPolicyMethodScoped");

  async function deploy(name: string, contract: string, args: unknown[]) {
    const existing = await hre.deployments.getOrNull(name);
    if (existing) {
      if (JSON.stringify(existing.args) !== JSON.stringify(args)) {
        throw new Error(`${name} constructor arguments changed`);
      }
      await assertCanonicalDeployment(hre, existing, name, contract);
      return existing;
    }
    const deployed = await hre.deployments.deploy(name, { contract, from: deployer, args, log: true });
    await assertCanonicalDeployment(hre, deployed, name, contract);
    return deployed;
  }
  const vaultRecord = await deploy("PaymentPolicyStakeVault", "StakeVault", [
    deployer, await oldVault.stakeToken(), constants.AddressZero,
    (await oldVault.controllerChangeDelay()).toString(),
  ]);
  const policyRecord = await deploy("PaymentPolicy", "DisputeProtectionPolicy", [
    deployer, vaultRecord.address, disputeVerifier.address, disputeRegistry.address,
  ]);
  const hookRecord = await deploy("PaymentPolicyLifecycleHook", "IntentLifecycleHookV1", [
    orchestratorRegistry.address, whitelist.address, policyRecord.address,
  ]);
  const vault = await hre.ethers.getContractAt("StakeVault", vaultRecord.address, signer);
  const policy = await hre.ethers.getContractAt("DisputeProtectionPolicy", policyRecord.address, signer);
  const registry = await hre.ethers.getContractAt("NullifierRegistry", disputeRegistry.address, signer);

  if (await vault.controller() === constants.AddressZero) {
    await (await vault.initializeController(policy.address)).wait();
  }
  if (await vault.controller() !== policy.address) {
    throw new Error("Payment policy vault controller mismatch");
  }
  if (!await registry.isWriter(policy.address)) {
    await (await registry.addWritePermission(policy.address)).wait();
  }
  if (!await policy.isLifecycleHookAuthorized(hookRecord.address)) {
    await (await policy.setLifecycleHookAuthorization(hookRecord.address, true)).wait();
  }
  if (await policy.paymentVerifierByOrchestrator(orchestrator.address) === constants.AddressZero) {
    const signatures = await upv.attestationVerifier();
    if (signatures === policy.address) throw new Error("Payment policy signature route missing");
    await (await policy.registerPolicyRoute(orchestrator.address, upv.address, signatures)).wait();
  }
  if (await policy.paymentVerifierByOrchestrator(orchestrator.address) !== upv.address) {
    throw new Error("Payment policy verifier route mismatch");
  }
  for (const method of DISPUTABLE_PAYMENT_METHODS) {
    const hash = utils.id(method);
    const rule = await policy.policyRules(hash, constants.HashZero);
    if (!rule.registered) {
      await (await policy.setPolicy(hash, constants.HashZero, DISPUTE_RISK_WINDOW[network], true)).wait();
    }
    const configured = await policy.policyRules(hash, constants.HashZero);
    if (!configured.enabled || !configured.riskWindow.eq(DISPUTE_RISK_WINDOW[network])) {
      throw new Error(`Payment policy default mismatch: ${method}`);
    }
  }
  if (await upv.attestationVerifier() !== policy.address) {
    await (await upv.setAttestationVerifier(policy.address)).wait();
  }
  if (await orchestrator.lifecycleHook() !== hookRecord.address) {
    await (await orchestrator.setLifecycleHook(hookRecord.address)).wait();
  }
};
func.skip = async (hre) => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  if (process.env.DEPLOY_ACTIVE_TAG === TAG) throw new Error("Payment policy lane is local-only");
  return true;
};
func.tags = [TAG];
func.dependencies = ["39_deploy_method_scoped_vault_stack", "42_retire_dispute_risk_windows"];
export default func;
