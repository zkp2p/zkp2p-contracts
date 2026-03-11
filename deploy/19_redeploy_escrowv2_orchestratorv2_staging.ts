import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  ESCROW_V2_INTENT_EXPIRATION_PERIOD,
  ESCROW_V2_MAX_INTENTS_PER_DEPOSIT,
  ESCROW_V2_DUST_THRESHOLD,
  ESCROW_V2_DUST_RECIPIENT,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
} from "../deployments/parameters";
import {
  addEscrowToRegistry,
  removeEscrowFromRegistry,
  addOrchestratorToRegistry,
  removeOrchestratorFromRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

// Old addresses being replaced (deployed by scripts 14/18, before referral-fees + signed-spreads)
const OLD_ESCROW_V2: any = {
  "base_staging": "0xEf77c802C9Ab4923ca4f5FD499ACD2f5C551Af58",
};

const OLD_ORCHESTRATOR_V2: any = {
  "base_staging": "0xF806656fCc55c94f17bB9B5CB735C2fd000DE5DF",
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  // Resolve existing infrastructure addresses
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");

  const oldEscrowV2 = OLD_ESCROW_V2[network];
  const oldOrchestratorV2 = OLD_ORCHESTRATOR_V2[network];
  if (!oldEscrowV2 || !oldOrchestratorV2) {
    throw new Error(`No old addresses configured for network ${network}`);
  }

  console.log("=== Redeploying EscrowV2, OrchestratorV2, SignatureGatingPreIntentHook ===");
  console.log("Old EscrowV2:", oldEscrowV2);
  console.log("Old OrchestratorV2:", oldOrchestratorV2);

  // 1. Deploy new EscrowV2
  const escrowV2 = await deploy("EscrowV2", {
    from: deployer,
    args: [
      deployer,
      chainId,
      orchestratorRegistryAddress,
      paymentVerifierRegistryAddress,
      ESCROW_V2_DUST_RECIPIENT[network] != ""
        ? ESCROW_V2_DUST_RECIPIENT[network]
        : deployer,
      ESCROW_V2_DUST_THRESHOLD[network],
      ESCROW_V2_MAX_INTENTS_PER_DEPOSIT[network],
      ESCROW_V2_INTENT_EXPIRATION_PERIOD[network],
    ],
  });
  console.log("New EscrowV2 deployed at", escrowV2.address);
  await waitForDeploymentDelay(hre);

  // 2. Deploy new OrchestratorV2
  const orchestratorV2 = await deploy("OrchestratorV2", {
    from: deployer,
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      relayerRegistryAddress,
      ORCHESTRATOR_V2_PROTOCOL_FEE[network],
      ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network] != ""
        ? ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network]
        : deployer,
    ],
  });
  console.log("New OrchestratorV2 deployed at", orchestratorV2.address);
  await waitForDeploymentDelay(hre);

  // 3. Deploy new SignatureGatingPreIntentHook (IPreIntentHook struct changed)
  const signatureGatingPreIntentHook = await deploy("SignatureGatingPreIntentHook", {
    from: deployer,
    args: [orchestratorRegistryAddress, chainId],
  });
  console.log("New SignatureGatingPreIntentHook deployed at", signatureGatingPreIntentHook.address);
  await waitForDeploymentDelay(hre);

  // 4. Wire EscrowRegistry: add new, remove old
  const escrowRegistryContract = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addEscrowToRegistry(hre, escrowRegistryContract, escrowV2.address);
  console.log("New EscrowV2 added to EscrowRegistry");

  await removeEscrowFromRegistry(hre, escrowRegistryContract, oldEscrowV2);
  console.log("Old EscrowV2 removed from EscrowRegistry");

  // 5. Wire OrchestratorRegistry: add new, remove old
  const orchestratorRegistryContract = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  await addOrchestratorToRegistry(hre, orchestratorRegistryContract, orchestratorV2.address);
  console.log("New OrchestratorV2 added to OrchestratorRegistry");

  await removeOrchestratorFromRegistry(hre, orchestratorRegistryContract, oldOrchestratorV2);
  console.log("Old OrchestratorV2 removed from OrchestratorRegistry");

  // 6. Transfer ownership to multiSig
  const escrowV2Contract = await ethers.getContractAt("EscrowV2", escrowV2.address);
  await setNewOwner(hre, escrowV2Contract, multiSig);
  console.log("EscrowV2 ownership transferred to", multiSig);

  const orchestratorV2Contract = await ethers.getContractAt("OrchestratorV2", orchestratorV2.address);
  await setNewOwner(hre, orchestratorV2Contract, multiSig);
  console.log("OrchestratorV2 ownership transferred to", multiSig);

  console.log("=== Redeployment finished ===");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  const oldEscrow = OLD_ESCROW_V2[network];
  const oldOrchestrator = OLD_ORCHESTRATOR_V2[network];
  if (!oldEscrow || !oldOrchestrator) return true; // Skip networks without old addresses
  try {
    const currentEscrowV2 = getDeployedContractAddress(network, "EscrowV2");
    const currentOrchestratorV2 = getDeployedContractAddress(network, "OrchestratorV2");
    // Skip if both have already been replaced
    return currentEscrowV2 !== oldEscrow && currentOrchestratorV2 !== oldOrchestrator;
  } catch (e) {
    return false;
  }
};

func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
