import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  getDeployedContractAddress,
  waitForDeploymentDelay,
} from "../deployments/helpers";

// Old ProtocolViewerV2 addresses compiled against pre-multi-referral OrchestratorV2 interface.
// The deployed OrchestratorV2 now returns referralFees: ReferralFee[] but these PV2 instances
// expect the old (referrer, referrerFee) struct layout, causing ABI decode reverts.
const OLD_PROTOCOL_VIEWER_V2: any = {
  "base_staging": "0xA4d0f8729EE91e676cCFCC3a0041605c604A7605",
  "base": "0x19E4AA000839836568c0BBEF7804724DE0a0f5a0",
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();

  const oldAddress = OLD_PROTOCOL_VIEWER_V2[network];
  console.log("=== Redeploying ProtocolViewerV2 ===");
  console.log("Old ProtocolViewerV2:", oldAddress);

  // ProtocolViewerV2 is stateless (no constructor args, NOT Ownable)
  const protocolViewerV2 = await deploy("ProtocolViewerV2", {
    from: deployer,
    args: [],
  });
  console.log("New ProtocolViewerV2 deployed at", protocolViewerV2.address);
  await waitForDeploymentDelay(hre);

  console.log("=== ProtocolViewerV2 redeployment finished ===");
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  const oldAddress = OLD_PROTOCOL_VIEWER_V2[network];
  if (!oldAddress) return true; // Skip networks without old addresses
  try {
    const currentAddress = getDeployedContractAddress(network, "ProtocolViewerV2");
    return currentAddress !== oldAddress; // Skip if already replaced
  } catch (e) {
    return false;
  }
};

func.dependencies = ["15_deploy_v2_periphery"];

export default func;
