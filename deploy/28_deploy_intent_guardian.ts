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
  getDeployedContractAddress,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import type { IntentGuardian__factory } from "../typechain";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging", "base"]);

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function systemFullyWired(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;

  const intentGuardianAddress = getDeployedContractAddress(network, "IntentGuardian");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  const guardian = await ethers.getContractAt("IntentGuardian", intentGuardianAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);

  if (!sameAddress(await guardian.escrowRegistry(), escrowRegistryAddress)) return false;
  if (!sameAddress(await guardian.owner(), governance)) return false;
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

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  console.log("=== Deploying V2 intent guardian ===");
  console.log("Reusing EscrowV2:", escrowV2Address);

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

  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addEscrowToRegistry(hre, escrowRegistry, escrowV2Address);

  console.log("=== V2 intent guardian deployment prepared ===");
  console.log("IntentGuardian:", intentGuardian.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (process.env.FORCE_RERUN_V2_INTENT_GUARDIAN === "true") return false;
  if (INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network] === undefined) return true;

  try {
    return await systemFullyWired(hre);
  } catch {
    return false;
  }
};

func.tags = ["28_deploy_intent_guardian", "V2IntentGuardian", "IntentGuardian"];
func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
