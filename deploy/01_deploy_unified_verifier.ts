import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
} from "../deployments/parameters";
import {
  callContractAsOwner,
  addWritePermission,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { WITNESS_ADDRESS } from "../deployments/parameters";

const normalizeAddress = (value: string): string => value.toLowerCase();

const syncUnifiedVerifierOrchestrator = async (
  hre: HardhatRuntimeEnvironment,
  unifiedPaymentVerifierContract: any,
  expectedOrchestrator: string
): Promise<void> => {
  const currentOrchestrator = await unifiedPaymentVerifierContract.orchestrator();
  if (normalizeAddress(currentOrchestrator) === normalizeAddress(expectedOrchestrator)) {
    console.log("UnifiedPaymentVerifier orchestrator already in sync");
    return;
  }

  const pendingOrchestrator = await unifiedPaymentVerifierContract.pendingOrchestrator();
  if (normalizeAddress(pendingOrchestrator) !== normalizeAddress(expectedOrchestrator)) {
    console.log("Scheduling UnifiedPaymentVerifier orchestrator update...");
    await callContractAsOwner(hre, unifiedPaymentVerifierContract, "scheduleOrchestratorUpdate", [expectedOrchestrator]);
    return;
  }

  const executeAfter = await unifiedPaymentVerifierContract.orchestratorUpdateTimestamp();
  const latestBlock = await hre.ethers.provider.getBlock("latest");
  if (latestBlock.timestamp < executeAfter.toNumber()) {
    console.log(`UnifiedPaymentVerifier orchestrator update is pending until ${executeAfter.toString()}`);
    return;
  }

  console.log("Finalizing UnifiedPaymentVerifier orchestrator update...");
  await callContractAsOwner(hre, unifiedPaymentVerifierContract, "finalizeOrchestratorUpdate", []);
};

// Deployment Scripts
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
  const nullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");

  // Deploy SimpleAttestationVerifier
  const simpleAttestationVerifier = await deploy("SimpleAttestationVerifier", {
    from: deployer,
    args: [WITNESS_ADDRESS[network]],
    skipIfAlreadyDeployed: true,
  });
  console.log("SimpleAttestationVerifier deployed at", simpleAttestationVerifier.address);
  await waitForDeploymentDelay(hre);

  // Deploy UnifiedPaymentVerifier
  const unifiedPaymentVerifier = await deploy("UnifiedPaymentVerifier", {
    from: deployer,
    args: [
      orchestratorAddress,
      nullifierRegistryAddress,
      simpleAttestationVerifier.address,
    ],
    skipIfAlreadyDeployed: true,
  });
  console.log("UnifiedPaymentVerifier deployed at", unifiedPaymentVerifier.address);
  await waitForDeploymentDelay(hre);

  // Get contract instances
  const nullifierRegistryContract = await ethers.getContractAt("NullifierRegistry", nullifierRegistryAddress);
  const simpleAttestationVerifierContract = await ethers.getContractAt("SimpleAttestationVerifier", simpleAttestationVerifier.address);
  const unifiedPaymentVerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", unifiedPaymentVerifier.address);

  if (!unifiedPaymentVerifier.newlyDeployed) {
    await syncUnifiedVerifierOrchestrator(hre, unifiedPaymentVerifierContract, orchestratorAddress);
  }

  await addWritePermission(hre, nullifierRegistryContract, unifiedPaymentVerifier.address);
  console.log("NullifierRegistry permissions added for UnifiedPaymentVerifier...");

  console.log("Transferring ownership of contracts...");
  await setNewOwner(hre, simpleAttestationVerifierContract, multiSig);
  console.log("SimpleAttestationVerifier ownership transferred to", multiSig);
  await setNewOwner(hre, unifiedPaymentVerifierContract, multiSig);
  console.log("UnifiedPaymentVerifier ownership transferred to", multiSig);

  console.log("Deploy finished...");

  await waitForDeploymentDelay(hre);
};

func.skip = async (_hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  // Keep this script runnable on all networks so mutable orchestrator pointers can be synced
  // without requiring contract redeploys.
  return false;
};

func.dependencies = ["00_deploy_system"];

export default func;
