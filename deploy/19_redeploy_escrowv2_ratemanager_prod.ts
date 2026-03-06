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
} from "../deployments/parameters";
import {
  addEscrowToRegistry,
  removeEscrowFromRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

// Current prod addresses being replaced (deployed by script 14, before rate-floor refactor)
const OLD_ESCROW_V2 = "0x0ff4Bd09CDbc00cD5Fb9D7D270AeF6a6BCB87777";
const OLD_RATE_MANAGER_V1 = "0x8fca5A2642905Ca9C63076bE21C7e6D4db8799f3";

// Expected vanity address: deployer 0x871aa3F9Ba085bA55E3589b4449bDa5ad9533882 at nonce 0
const EXPECTED_NEW_ESCROW_V2 = "0x0FfDC232E735F9C009EFD8e1129772157A06D777";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const accounts = await hre.getUnnamedAccounts();
  const deployer = accounts[0];
  const vanityDeployer = accounts[1];
  const multiSig = MULTI_SIG[network];

  if (!multiSig) throw new Error(`No MULTI_SIG configured for network ${network}`);
  if (!vanityDeployer) throw new Error(
    "Vanity deployer not configured. Set VANITY_ESCROW_V2_PROD_PRIVATE_KEY in .env"
  );

  // Verify vanity deployer nonce is 0 (required for deterministic contract address)
  const vanityNonce = await ethers.provider.getTransactionCount(vanityDeployer);
  if (vanityNonce !== 0) {
    throw new Error(
      `Vanity deployer ${vanityDeployer} nonce is ${vanityNonce}, expected 0. ` +
      `Cannot deploy to expected address ${EXPECTED_NEW_ESCROW_V2}.`
    );
  }

  // Resolve existing infrastructure addresses
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");

  console.log("=== Redeploying EscrowV2 (vanity) and RateManagerV1 on base prod ===");
  console.log("Regular deployer:          ", deployer);
  console.log("Vanity deployer:           ", vanityDeployer);
  console.log("Expected new EscrowV2:     ", EXPECTED_NEW_ESCROW_V2);
  console.log("Old EscrowV2:              ", OLD_ESCROW_V2);
  console.log("Old RateManagerV1:         ", OLD_RATE_MANAGER_V1);
  console.log("OrchestratorRegistry:      ", orchestratorRegistryAddress);
  console.log("PaymentVerifierRegistry:   ", paymentVerifierRegistryAddress);
  console.log("EscrowRegistry:            ", escrowRegistryAddress);

  // 1. Deploy new EscrowV2 from vanity deployer (nonce 0 -> vanity address)
  const escrowV2 = await deploy("EscrowV2", {
    from: vanityDeployer,
    args: [
      vanityDeployer,
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

  // Verify vanity address match
  if (escrowV2.address.toLowerCase() !== EXPECTED_NEW_ESCROW_V2.toLowerCase()) {
    throw new Error(
      `EscrowV2 deployed to ${escrowV2.address} but expected ${EXPECTED_NEW_ESCROW_V2}. ` +
      `Vanity address mismatch!`
    );
  }
  console.log("Vanity address verified:", escrowV2.address);
  await waitForDeploymentDelay(hre);

  // 2. Deploy new RateManagerV1 from regular deployer
  const rateManagerV1 = await deploy("RateManagerV1", {
    from: deployer,
    args: [escrowRegistryAddress],
  });
  console.log("New RateManagerV1 deployed at", rateManagerV1.address);
  await waitForDeploymentDelay(hre);

  // 3. Wire EscrowRegistry: add new EscrowV2, remove old EscrowV2
  //    These generate Safe batch transactions since the registry is owned by the multisig
  const escrowRegistryContract = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);

  await addEscrowToRegistry(hre, escrowRegistryContract, escrowV2.address);
  console.log("Queued: EscrowRegistry.addEscrow(%s)", escrowV2.address);

  await removeEscrowFromRegistry(hre, escrowRegistryContract, OLD_ESCROW_V2);
  console.log("Queued: EscrowRegistry.removeEscrow(%s)", OLD_ESCROW_V2);

  // 4. Transfer ownership to multiSig
  const escrowV2Contract = await ethers.getContractAt("EscrowV2", escrowV2.address);
  await setNewOwner(hre, escrowV2Contract, multiSig);
  console.log("EscrowV2 ownership transferred to", multiSig);

  const rateManagerV1Contract = await ethers.getContractAt("RateManagerV1", rateManagerV1.address);
  await setNewOwner(hre, rateManagerV1Contract, multiSig);
  console.log("RateManagerV1 ownership transferred to", multiSig);

  console.log("\n=== Redeployment finished ===");
  console.log("Safe batch JSON will be generated by deploy_summary.");
  console.log("Upload it to Safe UI > Transaction Builder to execute registry wiring.");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network !== "base") return true; // Only run on base mainnet

  try {
    const currentEscrowV2 = getDeployedContractAddress(network, "EscrowV2");
    // Run only if the current deployment is still the old address
    return currentEscrowV2.toLowerCase() !== OLD_ESCROW_V2.toLowerCase();
  } catch (e) {
    return false; // No deployment found, proceed
  }
};

func.dependencies = ["18_redeploy_escrowv2_ratemanager"];

export default func;
