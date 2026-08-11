import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { waitForDeploymentDelay } from "../deployments/helpers";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging"]);

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();

  console.log("=== Deploying deposit creation guard ===");

  const guard = await deploy("DepositCreationGuard", {
    from: deployer,
    args: [],
    log: true,
  });
  if (guard.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  console.log("DepositCreationGuard:", guard.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  return !SUPPORTED_NETWORKS.has(hre.deployments.getNetworkName());
};

func.tags = ["32_deploy_deposit_creation_guard", "DepositCreationGuard"];
export default func;
