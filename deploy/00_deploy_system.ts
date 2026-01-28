import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const circom = require("circomlibjs");

import {
  INTENT_EXPIRATION_PERIOD,
  MULTI_SIG,
  PROTOCOL_TAKER_FEE,
  PROTOCOL_TAKER_FEE_RECIPIENT,
  ESCROW_DUST_RECIPIENT,
  USDC,
  USDC_MINT_AMOUNT,
  USDC_RECIPIENT,
  ESCROW_DUST_THRESHOLD,
  MAX_INTENTS_PER_DEPOSIT,
} from "../deployments/parameters";
import {
  addEscrowToRegistry,
  getDeployedContractAddress,
  setNewOwner,
  setOrchestrator,
  waitForDeploymentDelay,
} from "../deployments/helpers";

// Deployment Scripts
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  let usdcAddress;
  if (!USDC[network]) {
    const usdcToken = await deploy("USDCMock", {
      from: deployer,
      args: [USDC_MINT_AMOUNT, "USDC", "USDC"],
    });
    usdcAddress = usdcToken.address;
    console.log("USDC deployed...");
    await waitForDeploymentDelay(hre);
  } else {
    usdcAddress = USDC[network];
  }

  // Deploy payment verifier registry
  const paymentVerifierRegistry = await deploy("PaymentVerifierRegistry", {
    from: deployer,
    args: [],
  });
  console.log("Payment verifier registry deployed at", paymentVerifierRegistry.address);
  await waitForDeploymentDelay(hre);

  // Deploy deposit rate manager registry (permissionless)
  const depositRateManagerRegistry = await deploy("DepositRateManagerRegistryV1", {
    from: deployer,
    args: [],
  });
  console.log("Deposit rate manager registry deployed at", depositRateManagerRegistry.address);
  await waitForDeploymentDelay(hre);

  // Deploy post intent hook registry
  const postIntentHookRegistry = await deploy("PostIntentHookRegistry", {
    from: deployer,
    args: [],
  });
  console.log("Post intent hook registry deployed at", postIntentHookRegistry.address);
  await waitForDeploymentDelay(hre);

  // Deploy relayer registry
  const relayerRegistry = await deploy("RelayerRegistry", {
    from: deployer,
    args: [],
  });
  console.log("Relayer registry deployed at", relayerRegistry.address);
  await waitForDeploymentDelay(hre);

  // Deploy nullifier registry
  const nullifierRegistry = await deploy("NullifierRegistry", {
    from: deployer,
    args: [],
  });
  console.log("Nullifier deployed at", nullifierRegistry.address);
  await waitForDeploymentDelay(hre);

  // Deploy escrow registry
  const escrowRegistry = await deploy("EscrowRegistry", {
    from: deployer,
    args: [],
  });
  console.log("Escrow registry deployed at", escrowRegistry.address);
  await waitForDeploymentDelay(hre);

  // Deploy escrow
  const escrow = await deploy("Escrow", {
    from: deployer,
    args: [
      deployer,
      chainId,
      paymentVerifierRegistry.address,
      ESCROW_DUST_RECIPIENT[network] != ""
        ? ESCROW_DUST_RECIPIENT[network]
        : deployer,
      ESCROW_DUST_THRESHOLD[network],
      MAX_INTENTS_PER_DEPOSIT[network],
      INTENT_EXPIRATION_PERIOD[network],
    ],
  });
  console.log("Escrow deployed at", escrow.address);
  await waitForDeploymentDelay(hre);

  // Set escrow registry on escrow
  const escrowRegistryContract = await ethers.getContractAt("EscrowRegistry", escrowRegistry.address);
  await addEscrowToRegistry(hre, escrowRegistryContract, escrow.address);
  console.log("Escrow added to escrow registry");

  // Deploy orchestrator
  const orchestrator = await deploy("Orchestrator", {
    from: deployer,
    args: [
      deployer,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      postIntentHookRegistry.address,
      relayerRegistry.address,
      PROTOCOL_TAKER_FEE[network],
      PROTOCOL_TAKER_FEE_RECIPIENT[network] != ""
        ? PROTOCOL_TAKER_FEE_RECIPIENT[network]
        : deployer
    ],
  });
  console.log("Orchestrator deployed at", orchestrator.address);
  await waitForDeploymentDelay(hre);

  // Set orchestrator on escrow
  const escrowContract = await ethers.getContractAt("Escrow", escrow.address);
  await setOrchestrator(hre, escrowContract, orchestrator.address);
  console.log("Orchestrator set on escrow");

  // Set deposit rate manager registry on escrow
  await escrowContract.setDepositRateManagerRegistry(depositRateManagerRegistry.address);
  console.log("Deposit rate manager registry set on escrow");
  await waitForDeploymentDelay(hre);

  // Deploy protocol viewer
  const protocolViewer = await deploy("ProtocolViewer", {
    from: deployer,
    args: [escrow.address, orchestrator.address],
  });
  console.log("Protocol viewer deployed at", protocolViewer.address);
  await waitForDeploymentDelay(hre);

  const orchestratorContract = await ethers.getContractAt("Orchestrator", orchestrator.address);
  const paymentVerifierRegistryContract = await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistry.address);
  const postIntentHookRegistryContract = await ethers.getContractAt("PostIntentHookRegistry", postIntentHookRegistry.address);
  const relayerRegistryContract = await ethers.getContractAt("RelayerRegistry", relayerRegistry.address);
  const nullifierRegistryContract = await ethers.getContractAt("NullifierRegistry", nullifierRegistry.address);

  if (network == "goerli") {
    const usdcContract = await ethers.getContractAt("USDCMock", usdcAddress);
    await usdcContract.transfer(USDC_RECIPIENT, USDC_MINT_AMOUNT);
  }

  if (network == "localhost") {
    const [owner] = await ethers.getSigners();
    const usdcContract = await ethers.getContractAt("USDCMock", usdcAddress);
    await usdcContract.transfer(owner.address, USDC_MINT_AMOUNT);
    console.log("Transferred USDC to ", owner.address);
  }

  console.log("Transferring ownership of contracts...");
  await setNewOwner(hre, escrowContract, multiSig);
  console.log("Escrow ownership transferred to", multiSig);
  await setNewOwner(hre, orchestratorContract, multiSig);
  console.log("Orchestrator ownership transferred to", multiSig);
  await setNewOwner(hre, paymentVerifierRegistryContract, multiSig);
  console.log("Payment verifier registry ownership transferred to", multiSig);
  await setNewOwner(hre, postIntentHookRegistryContract, multiSig);
  console.log("Post intent hook registry ownership transferred to", multiSig);
  await setNewOwner(hre, relayerRegistryContract, multiSig);
  console.log("Relayer registry ownership transferred to", multiSig);
  await setNewOwner(hre, nullifierRegistryContract, multiSig);
  console.log("Nullifier registry ownership transferred to", multiSig);
  await setNewOwner(hre, escrowRegistryContract, multiSig);
  console.log("Escrow registry ownership transferred to", multiSig);

  console.log("Deploy finished...");

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network != "localhost") {
    try { getDeployedContractAddress(hre.network.name, "ProtocolViewer") } catch (e) { return false; }
    return true;
  }
  return false;
};

export default func;
