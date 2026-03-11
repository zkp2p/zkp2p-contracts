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
import { safeBatchCollector } from "../deployments/safeBatchCollector";

// Old addresses being replaced
const OLD_ESCROW_V2 = "0x0FfDC232E735F9C009EFD8e1129772157A06D777";
const OLD_ORCHESTRATOR_V2 = "0xaCE45eaFf44a7f6BFff91f5a872f453507677777";

// Vanity deployer addresses (must match private keys in .env)
const VANITY_ESCROW_DEPLOYER = "0x4080036512dae45b1cd40fabad353201766dcd62";
const VANITY_ORCHESTRATOR_DEPLOYER = "0x34d86c21cc664ada046ad703ec45a3f5117cfa2e";

// Expected vanity contract addresses (deployer nonce 0)
const EXPECTED_ESCROW_V2 = "0x777777779d229cdf3110e9de47943791c26300ef";
const EXPECTED_ORCHESTRATOR_V2 = "0x888888359e981b5225ca48fbcdceff702fc3b888";

// ETH to fund vanity deployers (enough for one contract deploy)
const VANITY_DEPLOYER_FUNDING = ethers.utils.parseEther("0.003");

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const accounts = await hre.getUnnamedAccounts();
  const deployer = accounts[0];
  const multiSig = MULTI_SIG[network];

  // Resolve vanity deployer accounts from hardhat config
  let escrowVanityDeployer: string | undefined;
  let orchestratorVanityDeployer: string | undefined;
  for (const account of accounts.slice(1)) {
    if (account.toLowerCase() === VANITY_ESCROW_DEPLOYER.toLowerCase()) {
      escrowVanityDeployer = account;
    }
    if (account.toLowerCase() === VANITY_ORCHESTRATOR_DEPLOYER.toLowerCase()) {
      orchestratorVanityDeployer = account;
    }
  }

  if (!escrowVanityDeployer) {
    throw new Error(
      `Escrow vanity deployer ${VANITY_ESCROW_DEPLOYER} not found in accounts. ` +
      `Set VANITY_ESCROW_V2_PROD_PRIVATE_KEY in .env`
    );
  }
  if (!orchestratorVanityDeployer) {
    throw new Error(
      `Orchestrator vanity deployer ${VANITY_ORCHESTRATOR_DEPLOYER} not found in accounts. ` +
      `Set VANITY_ORCHESTRATOR_V2_PROD_PRIVATE_KEY in .env`
    );
  }

  console.log("=== Redeploying EscrowV2, OrchestratorV2, SignatureGatingPreIntentHook (prod) ===");
  console.log("Main deployer:", deployer);
  console.log("Escrow vanity deployer:", escrowVanityDeployer);
  console.log("Orchestrator vanity deployer:", orchestratorVanityDeployer);
  console.log("Old EscrowV2:", OLD_ESCROW_V2);
  console.log("Old OrchestratorV2:", OLD_ORCHESTRATOR_V2);

  // Verify vanity deployer nonces are 0
  const escrowNonce = await ethers.provider.getTransactionCount(escrowVanityDeployer);
  const orchestratorNonce = await ethers.provider.getTransactionCount(orchestratorVanityDeployer);
  if (escrowNonce !== 0) {
    throw new Error(`Escrow vanity deployer nonce is ${escrowNonce}, expected 0. Vanity address will not match.`);
  }
  if (orchestratorNonce !== 0) {
    throw new Error(`Orchestrator vanity deployer nonce is ${orchestratorNonce}, expected 0. Vanity address will not match.`);
  }
  console.log("Vanity deployer nonces verified (both 0)");

  // Resolve existing infrastructure addresses
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");

  // Fund vanity deployers from main deployer
  const escrowBalance = await ethers.provider.getBalance(escrowVanityDeployer);
  if (escrowBalance.lt(VANITY_DEPLOYER_FUNDING)) {
    console.log("Funding escrow vanity deployer...");
    const signer = ethers.provider.getSigner(deployer);
    const tx = await signer.sendTransaction({
      to: escrowVanityDeployer,
      value: VANITY_DEPLOYER_FUNDING,
    });
    await tx.wait();
    console.log("Funded escrow vanity deployer with 0.005 ETH");
    await waitForDeploymentDelay(hre);
  }

  const orchestratorBalance = await ethers.provider.getBalance(orchestratorVanityDeployer);
  if (orchestratorBalance.lt(VANITY_DEPLOYER_FUNDING)) {
    console.log("Funding orchestrator vanity deployer...");
    const signer = ethers.provider.getSigner(deployer);
    const tx = await signer.sendTransaction({
      to: orchestratorVanityDeployer,
      value: VANITY_DEPLOYER_FUNDING,
    });
    await tx.wait();
    console.log("Funded orchestrator vanity deployer with 0.005 ETH");
    await waitForDeploymentDelay(hre);
  }

  // 1. Deploy new EscrowV2 from vanity deployer
  const escrowV2 = await deploy("EscrowV2", {
    from: escrowVanityDeployer,
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
  if (escrowV2.address.toLowerCase() !== EXPECTED_ESCROW_V2.toLowerCase()) {
    throw new Error(
      `EscrowV2 address mismatch! Got ${escrowV2.address}, expected ${EXPECTED_ESCROW_V2}`
    );
  }
  console.log("EscrowV2 vanity address verified");
  await waitForDeploymentDelay(hre);

  // 2. Deploy new OrchestratorV2 from vanity deployer
  const orchestratorV2 = await deploy("OrchestratorV2", {
    from: orchestratorVanityDeployer,
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
  if (orchestratorV2.address.toLowerCase() !== EXPECTED_ORCHESTRATOR_V2.toLowerCase()) {
    throw new Error(
      `OrchestratorV2 address mismatch! Got ${orchestratorV2.address}, expected ${EXPECTED_ORCHESTRATOR_V2}`
    );
  }
  console.log("OrchestratorV2 vanity address verified");
  await waitForDeploymentDelay(hre);

  // 3. Deploy new SignatureGatingPreIntentHook from main deployer
  const signatureGatingPreIntentHook = await deploy("SignatureGatingPreIntentHook", {
    from: deployer,
    args: [orchestratorRegistryAddress, chainId],
  });
  console.log("New SignatureGatingPreIntentHook deployed at", signatureGatingPreIntentHook.address);
  await waitForDeploymentDelay(hre);

  // 4. Registry wiring (goes to Safe batch since multisig owns registries)
  console.log("=== Registry wiring (Safe batch) ===");
  const escrowRegistryContract = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addEscrowToRegistry(hre, escrowRegistryContract, escrowV2.address);
  await removeEscrowFromRegistry(hre, escrowRegistryContract, OLD_ESCROW_V2);

  const orchestratorRegistryContract = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  await addOrchestratorToRegistry(hre, orchestratorRegistryContract, orchestratorV2.address);
  await removeOrchestratorFromRegistry(hre, orchestratorRegistryContract, OLD_ORCHESTRATOR_V2);

  // 5. Transfer ownership to multisig (direct tx from deployer since deployer is initial owner)
  const escrowV2Contract = await ethers.getContractAt("EscrowV2", escrowV2.address);
  await setNewOwner(hre, escrowV2Contract, multiSig);
  console.log("EscrowV2 ownership transferred to", multiSig);

  const orchestratorV2Contract = await ethers.getContractAt("OrchestratorV2", orchestratorV2.address);
  await setNewOwner(hre, orchestratorV2Contract, multiSig);
  console.log("OrchestratorV2 ownership transferred to", multiSig);

  // 6. Write Safe batch file
  const batchCount = safeBatchCollector.count();
  if (batchCount > 0) {
    const batchFile = safeBatchCollector.writeBatchFile(network, String(chainId), multiSig);
    console.log(`Safe batch file written with ${batchCount} transactions: ${batchFile}`);
  }

  console.log("=== Redeployment finished ===");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "base") return true;

  try {
    const currentEscrowV2 = getDeployedContractAddress(network, "EscrowV2");
    const currentOrchestratorV2 = getDeployedContractAddress(network, "OrchestratorV2");
    // Skip if both have already been replaced
    return (
      currentEscrowV2.toLowerCase() !== OLD_ESCROW_V2.toLowerCase() &&
      currentOrchestratorV2.toLowerCase() !== OLD_ORCHESTRATOR_V2.toLowerCase()
    );
  } catch (e) {
    return false;
  }
};

func.tags = ["20_redeploy_escrowv2_orchestratorv2_prod"];
func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
