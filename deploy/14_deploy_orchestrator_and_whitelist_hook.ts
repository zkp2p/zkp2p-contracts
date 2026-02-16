import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  PROTOCOL_TAKER_FEE,
  PROTOCOL_TAKER_FEE_RECIPIENT,
} from "../deployments/parameters";
import {
  getDeployedContractAddress,
  setDepositRateManagerController,
  setNewOwner,
  setOrchestrator,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  // Read existing contract addresses
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const escrowAddress = getDeployedContractAddress(network, "Escrow");
  const depositRateManagerControllerAddress = getDeployedContractAddress(network, "DepositRateManagerController");

  // 1. Deploy new Orchestrator (with whitelist hook slot)
  const orchestrator = await deploy("Orchestrator", {
    from: deployer,
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      relayerRegistryAddress,
      PROTOCOL_TAKER_FEE[network],
      PROTOCOL_TAKER_FEE_RECIPIENT[network] != ""
        ? PROTOCOL_TAKER_FEE_RECIPIENT[network]
        : deployer,
    ],
  });
  console.log("Orchestrator deployed at", orchestrator.address);
  await waitForDeploymentDelay(hre);

  // 2. Wire Escrow to new Orchestrator
  const escrowContract = await ethers.getContractAt("Escrow", escrowAddress);
  await setOrchestrator(hre, escrowContract, orchestrator.address);
  console.log("Orchestrator set on Escrow");

  // 3. Set deposit rate manager controller on new Orchestrator
  const orchestratorContract = await ethers.getContractAt("Orchestrator", orchestrator.address);
  await setDepositRateManagerController(hre, orchestratorContract, depositRateManagerControllerAddress);
  console.log("DepositRateManagerController set on Orchestrator");
  await waitForDeploymentDelay(hre);

  // 3a. Update UnifiedPaymentVerifier to trust the new Orchestrator
  const unifiedPaymentVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
  const unifiedPaymentVerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", unifiedPaymentVerifierAddress);
  await setOrchestrator(hre, unifiedPaymentVerifierContract, orchestrator.address);
  console.log("Orchestrator set on UnifiedPaymentVerifier");
  await waitForDeploymentDelay(hre);

  // 3b. Update AcrossBridgeHook to trust the new Orchestrator
  const acrossBridgeHookAddress = getDeployedContractAddress(network, "AcrossBridgeHook");
  const acrossBridgeHookContract = await ethers.getContractAt("AcrossBridgeHook", acrossBridgeHookAddress);
  await setOrchestrator(hre, acrossBridgeHookContract, orchestrator.address);
  console.log("Orchestrator set on AcrossBridgeHook");
  await waitForDeploymentDelay(hre);

  // 4. Deploy WhitelistPreIntentHook
  const whitelistHook = await deploy("WhitelistPreIntentHook", {
    from: deployer,
    args: [orchestrator.address],
  });
  console.log("WhitelistPreIntentHook deployed at", whitelistHook.address);
  await waitForDeploymentDelay(hre);

  // 5. Update ProtocolViewer with new Orchestrator
  const protocolViewer = await deploy("ProtocolViewer", {
    from: deployer,
    args: [escrowAddress, orchestrator.address],
  });
  console.log("ProtocolViewer deployed at", protocolViewer.address);
  await waitForDeploymentDelay(hre);

  // 6. Transfer ownership to multisig
  await setNewOwner(hre, orchestratorContract, multiSig);
  console.log("Orchestrator ownership transferred to", multiSig);

  const protocolViewerContract = await ethers.getContractAt("ProtocolViewer", protocolViewer.address);
  await setNewOwner(hre, protocolViewerContract, multiSig);
  console.log("ProtocolViewer ownership transferred to", multiSig);

  console.log("Deploy finished.");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "localhost") {
    try {
      getDeployedContractAddress(network, "WhitelistPreIntentHook");
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
};

func.dependencies = ["00_deploy_system"];

export default func;
