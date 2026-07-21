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
  addOrchestratorToRegistry,
  addWritePermission,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  // Resolve existing V1 addresses
  const orchestratorV1Address = getDeployedContractAddress(network, "Orchestrator");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const nullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
  const simpleAttestationVerifierAddress = getDeployedContractAddress(network, "SimpleAttestationVerifier");

  // Deploy OrchestratorRegistry
  const orchestratorRegistry = await deploy("OrchestratorRegistry", {
    from: deployer,
    args: [],
  });
  console.log("OrchestratorRegistry deployed at", orchestratorRegistry.address);
  await waitForDeploymentDelay(hre);

  // Deploy EscrowV2
  const escrowV2 = await deploy("EscrowV2", {
    from: deployer,
    args: [
      deployer,
      chainId,
      orchestratorRegistry.address,
      paymentVerifierRegistryAddress,
      ESCROW_V2_DUST_RECIPIENT[network] != ""
        ? ESCROW_V2_DUST_RECIPIENT[network]
        : deployer,
      ESCROW_V2_DUST_THRESHOLD[network],
      ESCROW_V2_MAX_INTENTS_PER_DEPOSIT[network],
      ESCROW_V2_INTENT_EXPIRATION_PERIOD[network],
    ],
  });
  console.log("EscrowV2 deployed at", escrowV2.address);
  await waitForDeploymentDelay(hre);

  // Deploy OrchestratorV2
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
  console.log("OrchestratorV2 deployed at", orchestratorV2.address);
  await waitForDeploymentDelay(hre);

  // Deploy UnifiedPaymentVerifierV2 (same contract, new deployment name)
  const unifiedPaymentVerifierV2 = await deploy("UnifiedPaymentVerifierV2", {
    contract: "UnifiedPaymentVerifier",
    from: deployer,
    args: [
      orchestratorRegistry.address,
      nullifierRegistryAddress,
      simpleAttestationVerifierAddress,
    ],
  });
  console.log("UnifiedPaymentVerifierV2 deployed at", unifiedPaymentVerifierV2.address);
  await waitForDeploymentDelay(hre);

  // Wire OrchestratorRegistry: add both V1 and V2 orchestrators
  const orchestratorRegistryContract = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistry.address);
  await addOrchestratorToRegistry(hre, orchestratorRegistryContract, orchestratorV1Address);
  console.log("V1 Orchestrator added to OrchestratorRegistry");
  await addOrchestratorToRegistry(hre, orchestratorRegistryContract, orchestratorV2.address);
  console.log("V2 Orchestrator added to OrchestratorRegistry");

  // Wire EscrowRegistry: add EscrowV2
  const escrowRegistryContract = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addEscrowToRegistry(hre, escrowRegistryContract, escrowV2.address);
  console.log("EscrowV2 added to EscrowRegistry");

  // Wire NullifierRegistry: add write permission for UnifiedPaymentVerifierV2
  const nullifierRegistryContract = await ethers.getContractAt("NullifierRegistry", nullifierRegistryAddress);
  await addWritePermission(hre, nullifierRegistryContract, unifiedPaymentVerifierV2.address);
  console.log("UnifiedPaymentVerifierV2 added to NullifierRegistry write permissions");

  // Transfer ownership to multiSig
  console.log("Transferring ownership of V2 contracts...");

  await setNewOwner(hre, orchestratorRegistryContract, multiSig);
  console.log("OrchestratorRegistry ownership transferred to", multiSig);

  const escrowV2Contract = await ethers.getContractAt("EscrowV2", escrowV2.address);
  await setNewOwner(hre, escrowV2Contract, multiSig);
  console.log("EscrowV2 ownership transferred to", multiSig);

  const orchestratorV2Contract = await ethers.getContractAt("OrchestratorV2", orchestratorV2.address);
  await setNewOwner(hre, orchestratorV2Contract, multiSig);
  console.log("OrchestratorV2 ownership transferred to", multiSig);

  // NOTE: UnifiedPaymentVerifierV2 ownership transfer is deferred to
  // 16_configure_v2_payment_methods so the deployer can add payment methods
  // directly without requiring multisig calldata.

  console.log("V2 system deploy finished...");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network != "localhost") {
    try { getDeployedContractAddress(hre.network.name, "OrchestratorV2"); } catch (e) { return false; }
    return true;
  }
  return false;
};

func.tags = ["14_deploy_v2_system", "V2System"];
func.dependencies = ["01_deploy_unified_verifier"];

export default func;
