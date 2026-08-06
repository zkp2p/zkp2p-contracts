import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { waitForDeploymentDelay } from "../deployments/helpers";
import type { WhitelistPolicy__factory } from "../typechain";

export const CORRECTED_WHITELIST_POLICY_DEPLOYMENT = "WhitelistPolicyV2";
const ENABLE_BASE_DEPLOYMENT = "ENABLE_BASE_CORRECTED_WHITELIST_DEPLOYMENT";
const BASE_CHAIN_ID = 8453;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function assertCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} has no bytecode: ${address}`);
  }
}

async function assertBaseChain(hre: HardhatRuntimeEnvironment): Promise<void> {
  const chainId = Number(await hre.getChainId());
  if (chainId !== BASE_CHAIN_ID) {
    throw new Error(`Corrected WhitelistPolicy requires Base chain ${BASE_CHAIN_ID}, received ${chainId}`);
  }
}

async function replacementReady(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  try {
    if (hre.deployments.getNetworkName() !== "base") return false;
    await assertBaseChain(hre);

    const [deployer] = await hre.getUnnamedAccounts();
    const currentPolicy = await hre.deployments.get("WhitelistPolicy");
    const replacement = await hre.deployments.getOrNull(CORRECTED_WHITELIST_POLICY_DEPLOYMENT);
    if (!replacement || sameAddress(replacement.address, currentPolicy.address)) return false;
    await assertCode(replacement.address, CORRECTED_WHITELIST_POLICY_DEPLOYMENT);

    const addressGroupRegistry = await hre.deployments.get("AddressGroupRegistry");
    const escrowRegistry = await hre.deployments.get("EscrowRegistry");
    const orchestratorRegistry = await hre.deployments.get("OrchestratorRegistry");
    const policy = await ethers.getContractAt("WhitelistPolicy", replacement.address);

    return sameAddress(await policy.groupRegistry(), addressGroupRegistry.address)
      && sameAddress(await policy.escrowRegistry(), escrowRegistry.address)
      && sameAddress(await policy.orchestratorRegistry(), orchestratorRegistry.address)
      && sameAddress(await policy.owner(), deployer);
  } catch {
    return false;
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  if (network !== "base") throw new Error("Corrected WhitelistPolicy deployment is Base-only");
  await assertBaseChain(hre);

  const [deployer] = await hre.getUnnamedAccounts();
  const currentPolicy = await hre.deployments.get("WhitelistPolicy");
  const addressGroupRegistry = await hre.deployments.get("AddressGroupRegistry");
  const escrowRegistry = await hre.deployments.get("EscrowRegistry");
  const orchestratorRegistry = await hre.deployments.get("OrchestratorRegistry");

  await assertCode(currentPolicy.address, "Current WhitelistPolicy");
  await assertCode(addressGroupRegistry.address, "AddressGroupRegistry");
  await assertCode(escrowRegistry.address, "EscrowRegistry");
  await assertCode(orchestratorRegistry.address, "OrchestratorRegistry");

  const constructorArgs: Parameters<WhitelistPolicy__factory["deploy"]> = [
    addressGroupRegistry.address,
    escrowRegistry.address,
    orchestratorRegistry.address,
  ];
  const replacement = await hre.deployments.deploy(CORRECTED_WHITELIST_POLICY_DEPLOYMENT, {
    contract: "WhitelistPolicy",
    from: deployer,
    args: constructorArgs,
    log: true,
  });
  if (replacement.newlyDeployed) await waitForDeploymentDelay(hre);

  if (sameAddress(replacement.address, currentPolicy.address)) {
    throw new Error("Replacement WhitelistPolicy unexpectedly matches the current policy address");
  }
  await assertCode(replacement.address, CORRECTED_WHITELIST_POLICY_DEPLOYMENT);

  const policy = await ethers.getContractAt("WhitelistPolicy", replacement.address);
  if (!sameAddress(await policy.groupRegistry(), addressGroupRegistry.address)) {
    throw new Error("Replacement WhitelistPolicy group registry mismatch");
  }
  if (!sameAddress(await policy.escrowRegistry(), escrowRegistry.address)) {
    throw new Error("Replacement WhitelistPolicy escrow registry mismatch");
  }
  if (!sameAddress(await policy.orchestratorRegistry(), orchestratorRegistry.address)) {
    throw new Error("Replacement WhitelistPolicy orchestrator registry mismatch");
  }
  if (!sameAddress(await policy.owner(), deployer)) {
    throw new Error("Replacement WhitelistPolicy owner must remain the deployer until bootstrap completes");
  }

  console.log("=== Corrected WhitelistPolicy prepared ===");
  console.log("Current WhitelistPolicy (unchanged):", currentPolicy.address);
  console.log("Replacement WhitelistPolicy:", replacement.address);
  console.log("Replacement owner retained by deployer:", deployer);
  console.log("No lifecycle hook or multisig ownership change was performed");
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  if (hre.deployments.getNetworkName() !== "base") return true;
  if (process.env[ENABLE_BASE_DEPLOYMENT] !== "true") return true;
  return replacementReady(hre);
};

func.tags = [
  "32_deploy_corrected_whitelist_policy",
  "CorrectedWhitelistPolicy",
  CORRECTED_WHITELIST_POLICY_DEPLOYMENT,
];
func.dependencies = ["29_deploy_whitelist_policy"];

export default func;
