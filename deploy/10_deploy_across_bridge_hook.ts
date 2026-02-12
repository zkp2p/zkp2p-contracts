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
  addPostIntentHook,
  callContractAsOwner,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const ZERO_ADDRESS = ethers.constants.AddressZero;

const normalizeAddress = (value: string): string => value.toLowerCase();

const syncAcrossBridgeHookOrchestrator = async (
  hre: HardhatRuntimeEnvironment,
  acrossBridgeHookContract: any,
  expectedOrchestrator: string
): Promise<void> => {
  const currentOrchestrator = await acrossBridgeHookContract.orchestrator();
  if (normalizeAddress(currentOrchestrator) === normalizeAddress(expectedOrchestrator)) {
    console.log("AcrossBridgeHook orchestrator already in sync");
    return;
  }

  let pendingOrchestrator = await acrossBridgeHookContract.pendingOrchestrator();

  if (
    normalizeAddress(pendingOrchestrator) !== normalizeAddress(ZERO_ADDRESS) &&
    normalizeAddress(pendingOrchestrator) !== normalizeAddress(expectedOrchestrator)
  ) {
    console.log("Cancelling stale AcrossBridgeHook pending orchestrator update...");
    await callContractAsOwner(hre, acrossBridgeHookContract, "cancelOrchestratorUpdate", []);
    pendingOrchestrator = await acrossBridgeHookContract.pendingOrchestrator();
  }

  if (normalizeAddress(pendingOrchestrator) !== normalizeAddress(expectedOrchestrator)) {
    console.log("Proposing AcrossBridgeHook orchestrator update...");
    await callContractAsOwner(hre, acrossBridgeHookContract, "proposeOrchestrator", [expectedOrchestrator]);
    return;
  }

  const executeAfter = await acrossBridgeHookContract.pendingOrchestratorActivationTime();
  const latestBlock = await hre.ethers.provider.getBlock("latest");
  if (latestBlock.timestamp < executeAfter.toNumber()) {
    console.log(`AcrossBridgeHook orchestrator update is pending until ${executeAfter.toString()}`);
    return;
  }

  console.log("Accepting AcrossBridgeHook orchestrator update...");
  await callContractAsOwner(hre, acrossBridgeHookContract, "acceptOrchestrator", []);
};

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

  const acrossBridgeHook = await deploy("AcrossBridgeHook", {
    from: deployer,
    args: [usdcAddress, orchestratorAddress, spokePoolAddress],
    skipIfAlreadyDeployed: true,
  });
  console.log("AcrossBridgeHook deployed at", acrossBridgeHook.address);
  await waitForDeploymentDelay(hre);

  const postIntentHookRegistry = await ethers.getContractAt("PostIntentHookRegistry", postIntentHookRegistryAddress);
  await addPostIntentHook(hre, postIntentHookRegistry, acrossBridgeHook.address);
  console.log("AcrossBridgeHook added to post intent hook registry");

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
