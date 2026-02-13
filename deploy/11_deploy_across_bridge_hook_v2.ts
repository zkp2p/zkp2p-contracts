import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  ACROSS_ALLOWED_EXCHANGES,
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

function _parseAllowedExchanges(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

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

  let allowedExchanges = _parseAllowedExchanges(ACROSS_ALLOWED_EXCHANGES[network]);
  if (!allowedExchanges.length && process.env.ACROSS_ALLOWED_EXCHANGES) {
    allowedExchanges = _parseAllowedExchanges(process.env.ACROSS_ALLOWED_EXCHANGES);
  }
  if (!allowedExchanges.length) {
    if (network === "localhost" || network === "hardhat") {
      allowedExchanges = [deployer];
    } else {
      throw new Error(`Missing allowed exchanges for network ${network}`);
    }
  }

  const acrossBridgeHookV2 = await deploy("AcrossBridgeHookV2", {
    from: deployer,
    args: [usdcAddress, orchestratorAddress, spokePoolAddress, spokePoolPeripheryAddress, allowedExchanges],
  });
  console.log("AcrossBridgeHookV2 deployed at", acrossBridgeHookV2.address);
  await waitForDeploymentDelay(hre);

  const postIntentHookRegistry = await ethers.getContractAt("PostIntentHookRegistry", postIntentHookRegistryAddress);
  await addPostIntentHook(hre, postIntentHookRegistry, acrossBridgeHookV2.address);
  console.log("AcrossBridgeHookV2 added to post intent hook registry");

  const acrossBridgeHookV2Contract = await ethers.getContractAt("AcrossBridgeHookV2", acrossBridgeHookV2.address);
  await setNewOwner(hre, acrossBridgeHookV2Contract, multiSig);
  console.log("AcrossBridgeHookV2 ownership transferred to", multiSig);

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "localhost") {
    try {
      getDeployedContractAddress(hre.network.name, "AcrossBridgeHookV2");
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
};

func.dependencies = ["00_deploy_system"];
func.tags = ["AcrossBridgeHookV2"];

export default func;
