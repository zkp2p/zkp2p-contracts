import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { waitForDeploymentDelay } from "../deployments/helpers";
import { disputeStackReady } from "./31_deploy_dispute_lifecycle_stack";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging"]);

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function disputeStackActivated(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  if (!await disputeStackReady(hre)) return false;
  try {
    const orchestratorAddress = (await hre.deployments.get("OrchestratorV3")).address;
    const hookAddress = (await hre.deployments.get("IntentLifecycleHookV1")).address;
    const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorAddress);
    return sameAddress(await orchestrator.lifecycleHook(), hookAddress);
  } catch {
    return false;
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!await disputeStackReady(hre)) {
    throw new Error("Deploy and verify the fresh dispute lifecycle stack before activation");
  }

  const orchestratorAddress = (await hre.deployments.get("OrchestratorV3")).address;
  const hookAddress = (await hre.deployments.get("IntentLifecycleHookV1")).address;
  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorAddress);

  if (!sameAddress(await orchestrator.lifecycleHook(), hookAddress)) {
    await (await orchestrator.setLifecycleHook(hookAddress)).wait();
    await waitForDeploymentDelay(hre);
  }

  if (!await disputeStackActivated(hre)) {
    throw new Error("Dispute lifecycle stack activation verification failed");
  }

  console.log("=== Dispute lifecycle stack activated ===");
  console.log("OrchestratorV3:", orchestratorAddress);
  console.log("IntentLifecycleHookV1:", hookAddress);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (await disputeStackActivated(hre)) return true;
  return network === "base_staging"
    && process.env.ENABLE_STAGING_V3_DISPUTE_ACTIVATION !== "true";
};

func.tags = ["32_activate_dispute_lifecycle_stack", "ActivateV3DisputeLifecycleStack"];
func.dependencies = ["V3DisputeLifecycleStack"];

export default func;
