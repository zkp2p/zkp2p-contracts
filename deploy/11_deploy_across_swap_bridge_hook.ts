import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  ACROSS_SPOKE_POOL,
  ACROSS_SPOKE_POOL_PERIPHERY,
  MULTI_SIG,
  USDC,
} from "../deployments/parameters";
import {
  addPostIntentHook,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();

  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;
  const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
  const postIntentHookRegistryAddress = getDeployedContractAddress(network, "PostIntentHookRegistry");
  const usdcAddress = USDC[network]
    ? USDC[network]
    : getDeployedContractAddress(network, "USDCMock");

  let spokePoolAddress = ACROSS_SPOKE_POOL[network] || "";
  if (!spokePoolAddress) {
    if (network === "localhost" || network === "hardhat") {
      const spokePoolMock = await deploy("AcrossSpokePoolMock", {
        from: deployer,
        args: [],
      });
      spokePoolAddress = spokePoolMock.address;
      console.log("AcrossSpokePoolMock deployed at", spokePoolAddress);
      await waitForDeploymentDelay(hre);
    } else {
      throw new Error(`Missing Across SpokePool address for network ${network}`);
    }
  }

  let spokePoolPeripheryAddress = ACROSS_SPOKE_POOL_PERIPHERY[network] || "";
  if (!spokePoolPeripheryAddress) {
    if (network === "localhost" || network === "hardhat") {
      const spokePoolPeripheryMock = await deploy("AcrossSpokePoolPeripheryMock", {
        from: deployer,
        args: [],
      });
      spokePoolPeripheryAddress = spokePoolPeripheryMock.address;
      console.log("AcrossSpokePoolPeripheryMock deployed at", spokePoolPeripheryAddress);
      await waitForDeploymentDelay(hre);
    } else {
      throw new Error(`Missing Across SpokePoolPeriphery address for network ${network}`);
    }
  }

  const acrossSwapBridgeHook = await deploy("AcrossSwapBridgeHook", {
    from: deployer,
    args: [usdcAddress, orchestratorAddress, spokePoolAddress, spokePoolPeripheryAddress],
  });
  console.log("AcrossSwapBridgeHook deployed at", acrossSwapBridgeHook.address);
  await waitForDeploymentDelay(hre);

  const postIntentHookRegistry = await ethers.getContractAt("PostIntentHookRegistry", postIntentHookRegistryAddress);
  await addPostIntentHook(hre, postIntentHookRegistry, acrossSwapBridgeHook.address);
  console.log("AcrossSwapBridgeHook added to post intent hook registry");

  const acrossSwapBridgeHookContract = await ethers.getContractAt("AcrossSwapBridgeHook", acrossSwapBridgeHook.address);
  await setNewOwner(hre, acrossSwapBridgeHookContract, multiSig);
  console.log("AcrossSwapBridgeHook ownership transferred to", multiSig);

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "localhost") {
    try {
      getDeployedContractAddress(hre.network.name, "AcrossSwapBridgeHook");
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
};

func.dependencies = ["00_deploy_system"];
func.tags = ["AcrossSwapBridgeHook"];

export default func;
