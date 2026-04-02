import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  getDeployedContractAddress,
  waitForDeploymentDelay,
} from "../deployments/helpers";

// Old WhitelistPreIntentHook addresses deployed before PR #141 (referralFees struct change).
// These were compiled against the old IPreIntentHook with (address referrer, uint256 referrerFee),
// causing selector mismatch (0x723907b0 vs 0x16bbe4b3) when called by OrchestratorV2.
const OLD_WHITELIST_HOOK: Record<string, string> = {
  "base_staging": "0x1F27426836F2436276B99723a1be484Cb2FBF181",
  "base": "0xd793369b11357cdd076A9c631F6c44ff8e6353eA",
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();

  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");

  console.log("=== Redeploying WhitelistPreIntentHook ===");
  console.log("Old WhitelistPreIntentHook:", OLD_WHITELIST_HOOK[network]);

  const whitelistPreIntentHook = await deploy("WhitelistPreIntentHook", {
    from: deployer,
    args: [orchestratorRegistryAddress],
  });
  console.log("New WhitelistPreIntentHook deployed at", whitelistPreIntentHook.address);
  await waitForDeploymentDelay(hre);

  console.log("=== Redeployment finished ===");
  console.log("NOTE: Depositors using the old hook must call setDepositWhitelistHook with the new address");
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  const oldHook = OLD_WHITELIST_HOOK[network];
  if (!oldHook) return true;
  try {
    const currentHook = getDeployedContractAddress(network, "WhitelistPreIntentHook");
    return currentHook !== oldHook;
  } catch (e) {
    return false;
  }
};

func.tags = ["23_redeploy_whitelist_pre_intent_hook"];
func.dependencies = ["15_deploy_v2_periphery"];

export default func;
