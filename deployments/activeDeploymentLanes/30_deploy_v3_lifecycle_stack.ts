import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { guardManagedDisputeLifecycleHook } from "../managedDisputeLifecycleHook";

const historicalLane = require("../../deploy/30_deploy_v3_lifecycle_stack")
  .default as DeployFunction;

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (await guardManagedDisputeLifecycleHook(hre)) return;
  await historicalLane(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  if (await guardManagedDisputeLifecycleHook(hre)) return true;
  return (await historicalLane.skip?.(hre)) ?? false;
};

func.tags = [
  "30_deploy_v3_lifecycle_stack",
  "V3LifecycleStack",
  "OrchestratorV3",
];
func.dependencies = ["29_deploy_whitelist_policy"];

export default func;
