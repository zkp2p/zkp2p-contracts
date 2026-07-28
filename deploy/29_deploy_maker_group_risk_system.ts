import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { MULTI_SIG } from "../deployments/parameters";
import {
  addEscrowToRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import type { WhitelistPolicy__factory } from "../typechain";

async function systemFullyWired(network: string): Promise<boolean> {
  const registryAddress = getDeployedContractAddress(network, "AddressGroupRegistry");
  const policyAddress = getDeployedContractAddress(network, "WhitelistPolicy");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  const policy = await ethers.getContractAt("WhitelistPolicy", policyAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);

  // Capability probe for the deposit-scoped policy schema. The currently deployed policy is maker-scoped and
  // exposes enabled(address) rather than enabled(address,uint256), so this call reverts against stale bytecode
  // (argument-count mismatch) and forces hardhat-deploy to process the changed policy wiring.
  await policy.enabled(ethers.constants.AddressZero, 0);

  if ((await policy.groupRegistry()).toLowerCase() !== registryAddress.toLowerCase()) return false;
  if ((await policy.escrowRegistry()).toLowerCase() !== escrowRegistryAddress.toLowerCase()) return false;
  if ((await policy.orchestratorRegistry()).toLowerCase() !== orchestratorRegistryAddress.toLowerCase()) return false;
  if (!(await escrowRegistry.isWhitelistedEscrow(escrowV2Address))) return false;

  return true;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  console.log("=== Deploying deposit whitelist system ===");

  const addressGroupRegistry = await deploy("AddressGroupRegistry", {
    from: deployer,
    args: [],
  });
  if (addressGroupRegistry.newlyDeployed) {
    console.log("AddressGroupRegistry deployed at", addressGroupRegistry.address);
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
  });
  if (whitelistPolicy.newlyDeployed) {
    console.log("WhitelistPolicy deployed at", whitelistPolicy.address);
    await waitForDeploymentDelay(hre);
  }

  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addEscrowToRegistry(hre, escrowRegistry, escrowV2Address);

  const whitelistPolicyContract = await ethers.getContractAt("WhitelistPolicy", whitelistPolicy.address);
  await setNewOwner(hre, whitelistPolicyContract, governance);

  console.log("=== Deposit whitelist system deployment prepared ===");
  console.log("AddressGroupRegistry:", addressGroupRegistry.address);
  console.log("WhitelistPolicy:", whitelistPolicy.address);
  console.log("EscrowV2 reused without redeployment:", escrowV2Address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "base") return true;
  if (
    network !== "localhost"
    && network !== "hardhat"
    && network !== "base_staging"
  ) {
    return true;
  }
  if (process.env.FORCE_RERUN_MINIMAL_V3_RISK_SYSTEM === "true") return false;

  try {
    return await systemFullyWired(network);
  } catch {
    return false;
  }
};

func.tags = ["29_deploy_maker_group_risk_system"];
func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
