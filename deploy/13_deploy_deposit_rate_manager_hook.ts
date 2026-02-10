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

  const registryAddress = getDeployedContractAddress(network, "ManualRateManagerRegistry");

  const depositRateManagerHook = await deploy("DepositRateManagerHookV1", {
    from: deployer,
    args: [registryAddress],
  });
  console.log("DepositRateManagerHookV1 deployed at", depositRateManagerHook.address);
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "localhost") {
    try {
      getDeployedContractAddress(hre.network.name, "DepositRateManagerHookV1");
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
};

func.dependencies = ["00_deploy_system"];

export default func;
