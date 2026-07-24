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

  console.log("=== Deploying AddressGroupRegistry ===");

  const addressGroupRegistry = await deploy("AddressGroupRegistry", {
    from: deployer,
    args: [[]],
  });
  console.log("AddressGroupRegistry deployed at", addressGroupRegistry.address);
  await waitForDeploymentDelay(hre);

  console.log("=== Deployment finished ===");
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  try {
    getDeployedContractAddress(network, "AddressGroupRegistry");
    return true; // already deployed
  } catch (e) {
    return false;
  }
};

func.tags = ["29_deploy_whitelist_groups"];
func.dependencies = ["14_deploy_v2_system"];

export default func;
