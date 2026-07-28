import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR,
  MULTI_SIG,
} from "../deployments/parameters";
import {
  addEscrowToRegistry,
  addOrchestratorToRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import type {
  IntentGuardian__factory,
  WhitelistPolicy__factory,
} from "../typechain";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging", "base"]);

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function systemFullyWired(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const extensionFeeBpsPerHour = INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network];

  if (extensionFeeBpsPerHour === undefined) return false;

  const addressGroupRegistryAddress = getDeployedContractAddress(network, "AddressGroupRegistry");
  const whitelistPolicyAddress = getDeployedContractAddress(network, "WhitelistPolicy");
  const intentGuardianAddress = getDeployedContractAddress(network, "IntentGuardian");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const orchestratorV2Address = getDeployedContractAddress(network, "OrchestratorV2");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  const policy = await ethers.getContractAt("WhitelistPolicy", whitelistPolicyAddress);
  const guardian = await ethers.getContractAt("IntentGuardian", intentGuardianAddress);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);

  if (!sameAddress(await policy.groupRegistry(), addressGroupRegistryAddress)) return false;
  if (!sameAddress(await policy.escrowRegistry(), escrowRegistryAddress)) return false;
  if (!sameAddress(await policy.orchestratorRegistry(), orchestratorRegistryAddress)) return false;
  if (!sameAddress(await policy.owner(), governance)) return false;
  if (!sameAddress(await guardian.escrowRegistry(), escrowRegistryAddress)) return false;
  if (!sameAddress(await guardian.owner(), governance)) return false;
  if (!(await orchestratorRegistry.isOrchestrator(orchestratorV2Address))) return false;
  if (!(await escrowRegistry.isWhitelistedEscrow(escrowV2Address))) return false;

  return true;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const extensionFeeBpsPerHour = INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network];

  if (extensionFeeBpsPerHour === undefined) {
    throw new Error(`No initial IntentGuardian fee configured for network: ${network}`);
  }

  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const orchestratorV2Address = getDeployedContractAddress(network, "OrchestratorV2");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  console.log("=== Deploying V2 guardian and whitelist policy ===");
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

  const intentGuardianArgs: Parameters<IntentGuardian__factory["deploy"]> = [
    governance,
    escrowRegistryAddress,
    extensionFeeBpsPerHour,
  ];
  const intentGuardian = await deploy("IntentGuardian", {
    from: deployer,
    args: intentGuardianArgs,
    log: true,
  });
  if (intentGuardian.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV2Address);
  await addEscrowToRegistry(hre, escrowRegistry, escrowV2Address);

  const whitelistPolicyContract = await ethers.getContractAt("WhitelistPolicy", whitelistPolicy.address);
  await setNewOwner(hre, whitelistPolicyContract, governance);

  console.log("=== V2 guardian and whitelist policy deployment prepared ===");
  console.log("AddressGroupRegistry:", addressGroupRegistry.address);
  console.log("WhitelistPolicy:", whitelistPolicy.address);
  console.log("IntentGuardian:", intentGuardian.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (process.env.FORCE_RERUN_V2_GUARDIAN_WHITELIST === "true") return false;

  try {
    return await systemFullyWired(hre);
  } catch {
    return false;
  }
};

func.tags = [
  "29_deploy_v2_guardian_whitelist",
  "V2GuardianWhitelist",
  "IntentGuardian",
  "WhitelistPolicy",
];
func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
