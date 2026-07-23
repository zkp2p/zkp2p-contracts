import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  getDeployedContractAddress,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();

  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");

  console.log("=== Deploying AddressGroupRegistry + WhitelistPreIntentHookV2 ===");

  const addressGroupRegistry = await deploy("AddressGroupRegistry", {
    from: deployer,
    args: [[]],
  });
  console.log("AddressGroupRegistry deployed at", addressGroupRegistry.address);
  await waitForDeploymentDelay(hre);

  const whitelistPreIntentHookV2 = await deploy("WhitelistPreIntentHookV2", {
    from: deployer,
    args: [orchestratorRegistryAddress, addressGroupRegistry.address],
  });
  console.log("WhitelistPreIntentHookV2 deployed at", whitelistPreIntentHookV2.address);
  await waitForDeploymentDelay(hre);

  console.log("=== Deployment finished ===");
  console.log("NOTE: neither contract is owned or registered anywhere — depositors opt in via setDepositWhitelistHook");
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  try {
    getDeployedContractAddress(network, "WhitelistPreIntentHookV2");
    return true; // already deployed
  } catch (e) {
    return false;
  }
};

func.tags = ["29_deploy_whitelist_groups"];
func.dependencies = ["14_deploy_v2_system"];

export default func;
