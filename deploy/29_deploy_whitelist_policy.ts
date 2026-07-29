import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { MULTI_SIG } from "../deployments/parameters";
import {
  addEscrowToRegistry,
  addOrchestratorToRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import type { WhitelistPolicy__factory } from "../typechain";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging", "base"]);

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function systemFullyWired(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;

  const addressGroupRegistryAddress = getDeployedContractAddress(network, "AddressGroupRegistry");
  const whitelistPolicyAddress = getDeployedContractAddress(network, "WhitelistPolicy");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const orchestratorV2Address = getDeployedContractAddress(network, "OrchestratorV2");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  const policy = await ethers.getContractAt("WhitelistPolicy", whitelistPolicyAddress);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);

  if (!sameAddress(await policy.groupRegistry(), addressGroupRegistryAddress)) return false;
  if (!sameAddress(await policy.escrowRegistry(), escrowRegistryAddress)) return false;
  if (!sameAddress(await policy.orchestratorRegistry(), orchestratorRegistryAddress)) return false;
  if (!sameAddress(await policy.owner(), governance)) return false;
  if (!(await orchestratorRegistry.isOrchestrator(orchestratorV2Address))) return false;
  if (!(await escrowRegistry.isWhitelistedEscrow(escrowV2Address))) return false;

  return true;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;

  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const orchestratorV2Address = getDeployedContractAddress(network, "OrchestratorV2");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  console.log("=== Deploying V2 whitelist policy ===");
  console.log("Reusing OrchestratorV2:", orchestratorV2Address);
  console.log("Reusing EscrowV2:", escrowV2Address);

  const addressGroupRegistry = await deploy("AddressGroupRegistry", {
    from: deployer,
    args: [],
    log: true,
  });
  if (addressGroupRegistry.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const whitelistPolicyArgs: Parameters<WhitelistPolicy__factory["deploy"]> = [
    addressGroupRegistry.address,
    escrowRegistryAddress,
    orchestratorRegistryAddress,
  ];
  const whitelistPolicy = await deploy("WhitelistPolicy", {
    from: deployer,
    args: whitelistPolicyArgs,
    log: true,
  });
  if (whitelistPolicy.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV2Address);
  await addEscrowToRegistry(hre, escrowRegistry, escrowV2Address);

  const whitelistPolicyContract = await ethers.getContractAt("WhitelistPolicy", whitelistPolicy.address);
  await setNewOwner(hre, whitelistPolicyContract, governance);

  console.log("=== V2 whitelist policy deployment prepared ===");
  console.log("AddressGroupRegistry:", addressGroupRegistry.address);
  console.log("WhitelistPolicy:", whitelistPolicy.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (process.env.FORCE_RERUN_V2_WHITELIST_POLICY === "true") return false;

  try {
    return await systemFullyWired(hre);
  } catch {
    return false;
  }
};

func.tags = ["29_deploy_whitelist_policy", "V2WhitelistPolicy", "WhitelistPolicy"];
func.dependencies = ["28_deploy_intent_guardian"];

export default func;
