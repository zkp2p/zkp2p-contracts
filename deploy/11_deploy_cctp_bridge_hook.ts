import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  CCTP_SOURCE_DOMAIN,
  CCTP_TOKEN_MESSENGER_V2,
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

  let tokenMessengerAddress = CCTP_TOKEN_MESSENGER_V2[network] || "";
  if (!tokenMessengerAddress) {
    if (network === "localhost" || network === "hardhat") {
      const messengerMock = await deploy("TokenMessengerV2Mock", {
        from: deployer,
        args: [],
      });
      tokenMessengerAddress = messengerMock.address;
      console.log("TokenMessengerV2Mock deployed at", tokenMessengerAddress);
      await waitForDeploymentDelay(hre);
    } else {
      throw new Error(`Missing CCTP TokenMessengerV2 address for network ${network}`);
    }
  }

  const sourceDomain = CCTP_SOURCE_DOMAIN[network];
  if (!sourceDomain) {
    throw new Error(`Missing CCTP source domain for network ${network}`);
  }

  const cctpBridgeHook = await deploy("CctpBridgeHook", {
    from: deployer,
    args: [usdcAddress, orchestratorAddress, tokenMessengerAddress, sourceDomain],
  });
  console.log("CctpBridgeHook deployed at", cctpBridgeHook.address);
  await waitForDeploymentDelay(hre);

  const postIntentHookRegistry = await ethers.getContractAt("PostIntentHookRegistry", postIntentHookRegistryAddress);
  await addPostIntentHook(hre, postIntentHookRegistry, cctpBridgeHook.address);
  console.log("CctpBridgeHook added to post intent hook registry");

  const cctpBridgeHookContract = await ethers.getContractAt("CctpBridgeHook", cctpBridgeHook.address);
  await setNewOwner(hre, cctpBridgeHookContract, multiSig);
  console.log("CctpBridgeHook ownership transferred to", multiSig);

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "localhost") {
    try {
      getDeployedContractAddress(hre.network.name, "CctpBridgeHook");
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
};

func.dependencies = ["00_deploy_system"];

export default func;
