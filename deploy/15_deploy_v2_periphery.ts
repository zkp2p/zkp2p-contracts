import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import { MULTI_SIG } from "../deployments/parameters";
import {
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

  // Deploy RateManagerV1 (Ownable, needs escrowRegistry)
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const rateManagerV1 = await deploy("RateManagerV1", {
    from: deployer,
    args: [escrowRegistryAddress],
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

  // Deploy ProtocolViewerV2 (stateless, NOT Ownable)
  const protocolViewerV2 = await deploy("ProtocolViewerV2", {
    from: deployer,
    args: [],
  });
  console.log("ProtocolViewerV2 deployed at", protocolViewerV2.address);
  await waitForDeploymentDelay(hre);

  // Transfer ownership to multiSig (only for Ownable contracts)
  console.log("Transferring ownership of V2 periphery contracts...");

  const rateManagerV1Contract = await ethers.getContractAt("RateManagerV1", rateManagerV1.address);
  await setNewOwner(hre, rateManagerV1Contract, multiSig);
  console.log("RateManagerV1 ownership transferred to", multiSig);

  console.log("V2 periphery deploy finished...");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "localhost") {
    try {
      getDeployedContractAddress(hre.network.name, "ProtocolViewerV2");
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
};

func.tags = ["15_deploy_v2_periphery"];
func.dependencies = ["14_deploy_v2_system"];

export default func;
