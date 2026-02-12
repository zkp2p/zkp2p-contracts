import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  ACROSS_SPOKE_POOL,
  MULTI_SIG,
  USDC,
} from "../deployments/parameters";
import {
  getDeployedContractAddress,
  setNewOwner,
  setOrchestrator,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const syncAcrossBridgeHookOrchestrator = async (
  hre: HardhatRuntimeEnvironment,
  acrossBridgeHookContract: any,
  expectedOrchestrator: string
): Promise<void> => {
  await setOrchestrator(hre, acrossBridgeHookContract, expectedOrchestrator);
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");

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

  const acrossBridgeHook = await deploy("AcrossBridgeHook", {
    from: deployer,
    args: [usdcAddress, orchestratorAddress, spokePoolAddress],
    skipIfAlreadyDeployed: true,
  });
  console.log("AcrossBridgeHook deployed at", acrossBridgeHook.address);
  await waitForDeploymentDelay(hre);

  const acrossBridgeHookContract = await ethers.getContractAt("AcrossBridgeHook", acrossBridgeHook.address);
  if (!acrossBridgeHook.newlyDeployed) {
    await syncAcrossBridgeHookOrchestrator(hre, acrossBridgeHookContract, orchestratorAddress);
  }

  await setNewOwner(hre, acrossBridgeHookContract, multiSig);
  console.log("AcrossBridgeHook ownership transferred to", multiSig);

  await waitForDeploymentDelay(hre);
};

func.skip = async (_hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  // Keep this script runnable on all networks so mutable orchestrator pointers can be synced
  // without requiring contract redeploys.
  return false;
};

func.dependencies = ["00_deploy_system"];

export default func;
