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
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  // Resolve V2 addresses
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const orchestratorV2Address = getDeployedContractAddress(network, "OrchestratorV2");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");
  const postIntentHookRegistryAddress = getDeployedContractAddress(network, "PostIntentHookRegistry");

  const usdcAddress = USDC[network]
    ? USDC[network]
    : getDeployedContractAddress(network, "USDCMock");

  // Deploy WhitelistPreIntentHook (NOT Ownable)
  const whitelistPreIntentHook = await deploy("WhitelistPreIntentHook", {
    from: deployer,
    args: [orchestratorRegistryAddress],
  });
  console.log("WhitelistPreIntentHook deployed at", whitelistPreIntentHook.address);
  await waitForDeploymentDelay(hre);

  // Deploy SignatureGatingPreIntentHook (NOT Ownable)
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const signatureGatingPreIntentHook = await deploy("SignatureGatingPreIntentHook", {
    from: deployer,
    args: [orchestratorRegistryAddress, chainId],
  });
  console.log("SignatureGatingPreIntentHook deployed at", signatureGatingPreIntentHook.address);
  await waitForDeploymentDelay(hre);

  // Deploy AcrossSpokePoolMock if needed (localhost only)
  let spokePoolAddress = ACROSS_SPOKE_POOL[network] || "";
  if (!spokePoolAddress) {
    if (network === "localhost" || network === "hardhat") {
      try {
        spokePoolAddress = getDeployedContractAddress(network, "AcrossSpokePoolMock");
        console.log("Reusing existing AcrossSpokePoolMock at", spokePoolAddress);
      } catch (e) {
        const spokePoolMock = await deploy("AcrossSpokePoolMock", {
          from: deployer,
          args: [],
        });
        spokePoolAddress = spokePoolMock.address;
        console.log("AcrossSpokePoolMock deployed at", spokePoolAddress);
        await waitForDeploymentDelay(hre);
      }
    } else {
      throw new Error(`Missing Across SpokePool address for network ${network}`);
    }
  }

  // Deploy AcrossBridgeHookV2
  const acrossBridgeHookV2 = await deploy("AcrossBridgeHookV2", {
    from: deployer,
    args: [usdcAddress, orchestratorV2Address, spokePoolAddress],
  });
  console.log("AcrossBridgeHookV2 deployed at", acrossBridgeHookV2.address);
  await waitForDeploymentDelay(hre);

  // Deploy RateManagerV1 (NOT Ownable)
  const rateManagerV1 = await deploy("RateManagerV1", {
    from: deployer,
    args: [],
  });
  console.log("RateManagerV1 deployed at", rateManagerV1.address);
  await waitForDeploymentDelay(hre);

  // Deploy ChainlinkOracleAdapter (NOT Ownable, stateless)
  const chainlinkOracleAdapter = await deploy("ChainlinkOracleAdapter", {
    from: deployer,
    args: [],
  });
  console.log("ChainlinkOracleAdapter deployed at", chainlinkOracleAdapter.address);
  await waitForDeploymentDelay(hre);

  // Deploy ProtocolViewerV2 (same contract, new deployment name with V2 addresses)
  const protocolViewerV2 = await deploy("ProtocolViewerV2", {
    contract: "ProtocolViewer",
    from: deployer,
    args: [escrowV2Address, orchestratorV2Address],
  });
  console.log("ProtocolViewerV2 deployed at", protocolViewerV2.address);
  await waitForDeploymentDelay(hre);

  // Register AcrossBridgeHookV2 in PostIntentHookRegistry
  const postIntentHookRegistry = await ethers.getContractAt("PostIntentHookRegistry", postIntentHookRegistryAddress);
  await addPostIntentHook(hre, postIntentHookRegistry, acrossBridgeHookV2.address);
  console.log("AcrossBridgeHookV2 added to PostIntentHookRegistry");

  // Transfer ownership to multiSig (only for Ownable contracts)
  console.log("Transferring ownership of V2 periphery contracts...");

  const acrossBridgeHookV2Contract = await ethers.getContractAt("AcrossBridgeHookV2", acrossBridgeHookV2.address);
  await setNewOwner(hre, acrossBridgeHookV2Contract, multiSig);
  console.log("AcrossBridgeHookV2 ownership transferred to", multiSig);

  const protocolViewerV2Contract = await ethers.getContractAt("ProtocolViewer", protocolViewerV2.address);
  await setNewOwner(hre, protocolViewerV2Contract, multiSig);
  console.log("ProtocolViewerV2 ownership transferred to", multiSig);

  console.log("V2 periphery deploy finished...");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "localhost") {
    try {
      getDeployedContractAddress(hre.network.name, "ChainlinkOracleAdapter");
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
};

func.dependencies = ["13_deploy_v2_system"];

export default func;
