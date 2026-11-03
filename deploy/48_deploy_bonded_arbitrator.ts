import "module-alias/register";

import type { Contract } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { waitForDeploymentDelay } from "../deployments/helpers";
import { CASHAPP_PAYMENT_METHOD_HASH } from "../deployments/verifiers/cashapp";
import { VENMO_PAYMENT_METHOD_HASH } from "../deployments/verifiers/venmo";
import { WISE_PAYMENT_METHOD_HASH } from "../deployments/verifiers/wise";

export const TAG = "48_deploy_bonded_arbitrator";
const PREPARE_FLAG = "PREPARE_STAGING_BONDED_ARBITRATOR";
const EXECUTE_FLAG = "EXECUTE_STAGING_BONDED_ARBITRATOR";

export const DISPUTE_WINDOW_SECONDS = 14 * 24 * 60 * 60;
// Rails whose seller history the attestor can scan for a non-payment attestation.
export const BONDED_RELEASE_PAYMENT_METHODS = [
  VENMO_PAYMENT_METHOD_HASH,
  CASHAPP_PAYMENT_METHOD_HASH,
  WISE_PAYMENT_METHOD_HASH,
];

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

async function skip(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  if (process.env.DEPLOY_ACTIVE_TAG !== TAG) return true;
  if (hre.deployments.getNetworkName() !== "base_staging") return true;
  const prepare = process.env[PREPARE_FLAG] === "true";
  const execute = process.env[EXECUTE_FLAG] === "true";
  if (prepare === execute) {
    throw new Error(`Set exactly one of ${PREPARE_FLAG} or ${EXECUTE_FLAG}=true`);
  }
  return false;
}

/**
 * Deploys NonPaymentVerifier, BondedArbitrator and IntentSignalPolicyV2 on Base staging, wires the arbitrator into the
 * staging StakeVaultV2 and NullifierRegistryV2, opens the bonded-release rails, approves the staging signer as bond
 * owner and selects the new signal policy on OrchestratorV4. Every step is skipped when already in place.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (await skip(hre)) return;
  const [deployer] = await hre.getUnnamedAccounts();
  const signer = await hre.ethers.getSigner(deployer);
  const at = async (artifact: string, name: string = artifact): Promise<Contract> =>
    hre.ethers.getContractAt(artifact, (await hre.deployments.get(name)).address, signer);

  const orchestrator = await at("OrchestratorV4");
  const vault = await at("StakeVaultV2");
  const nullifiers = await at("NullifierRegistryV2");
  const attestationVerifier = (await hre.deployments.get("MultiAttestationVerifier")).address;
  const whitelist = (await hre.deployments.get("WhitelistPolicyV2")).address;
  const currentPolicy = await hre.ethers.getContractAt("IntentSignalPolicy", await orchestrator.signalPolicy());
  const gatingService: string = await currentPolicy.gatingService();
  for (const contract of [orchestrator, vault, nullifiers]) {
    if (!same(await contract.owner(), deployer)) throw new Error(`${contract.address} is not owned by the staging signer`);
  }
  console.log(`[${TAG}] Plan: gating service ${gatingService}, rails ${BONDED_RELEASE_PAYMENT_METHODS.join(", ")}`);
  if (process.env[PREPARE_FLAG] === "true") return;

  async function deploy(name: string, args: unknown[]): Promise<Contract> {
    const result = await hre.deployments.deploy(name, { from: deployer, args, log: true });
    await waitForDeploymentDelay(hre);
    return hre.ethers.getContractAt(name, result.address, signer);
  }
  async function transact(transaction: Promise<{ wait: () => Promise<unknown> }>, action: string): Promise<void> {
    await (await transaction).wait();
    await waitForDeploymentDelay(hre);
    console.log(`[${TAG}] ${action}`);
  }

  const verifier = await deploy("NonPaymentVerifier", [deployer, attestationVerifier]);
  const arbitrator = await deploy("BondedArbitrator", [
    deployer,
    orchestrator.address,
    vault.address,
    nullifiers.address,
    verifier.address,
  ]);
  const policy = await deploy("IntentSignalPolicyV2", [gatingService, whitelist, arbitrator.address]);

  if (!(await vault.isController(arbitrator.address))) {
    await transact(vault.setController(arbitrator.address, true), "Authorized BondedArbitrator as vault controller");
  }
  if (!(await nullifiers.isWriter(arbitrator.address))) {
    await transact(nullifiers.addWritePermission(arbitrator.address), "Authorized BondedArbitrator as nullifier writer");
  }
  for (const method of BONDED_RELEASE_PAYMENT_METHODS) {
    if ((await arbitrator.disputeWindow(method)).toNumber() !== DISPUTE_WINDOW_SECONDS) {
      await transact(arbitrator.setDisputeWindow(method, DISPUTE_WINDOW_SECONDS), `Opened ${method}`);
    }
  }
  if (!(await arbitrator.isBondOwner(deployer))) {
    await transact(arbitrator.setBondOwner(deployer, true), "Approved the staging signer as bond owner");
  }
  if (!same(await orchestrator.signalPolicy(), policy.address)) {
    await transact(orchestrator.setSignalPolicy(policy.address), "Selected IntentSignalPolicyV2 on OrchestratorV4");
  }

  const checks: Array<[string, boolean]> = [
    ["verifier witnesses", same(await verifier.attestationVerifier(), attestationVerifier)],
    ["arbitrator orchestrator", same(await arbitrator.orchestrator(), orchestrator.address)],
    ["arbitrator vault", same(await arbitrator.stakeVault(), vault.address)],
    ["arbitrator verifier", same(await arbitrator.nonPaymentVerifier(), verifier.address)],
    ["policy gating service", same(await policy.gatingService(), gatingService)],
    ["policy default arbitrator", same(await policy.defaultArbitrator(), arbitrator.address)],
    ["orchestrator signal policy", same(await orchestrator.signalPolicy(), policy.address)],
    ["vault controller", await vault.isController(arbitrator.address)],
    ["nullifier writer", await nullifiers.isWriter(arbitrator.address)],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) throw new Error(`Bonded arbitrator verification failed: ${failed.join(", ")}`);
  console.log(`[${TAG}] Verified BondedArbitrator ${arbitrator.address}, policy ${policy.address}`);
};

func.skip = skip;
func.tags = [TAG];

export default func;
