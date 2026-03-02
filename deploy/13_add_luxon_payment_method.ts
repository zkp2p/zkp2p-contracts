import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
} from "../deployments/parameters";
import {
  getDeployedContractAddress,
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  savePaymentMethodSnapshot,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { LUXON_PROVIDER_CONFIG } from "../deployments/verifiers/luxon";

// Deployment Scripts
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const unifiedVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");

  // Add Luxon to payment method registry
  const paymentVerifierRegistryContract = await ethers.getContractAt(
    "PaymentVerifierRegistry", paymentVerifierRegistryAddress
  );
  await addPaymentMethodToRegistry(
    hre,
    paymentVerifierRegistryContract,
    LUXON_PROVIDER_CONFIG.paymentMethodHash,
    unifiedVerifierAddress,
    LUXON_PROVIDER_CONFIG.currencies
  );
  console.log("Luxon added to payment method registry...");

  // Snapshot Luxon
  savePaymentMethodSnapshot(network, 'luxon', {
    paymentMethodHash: LUXON_PROVIDER_CONFIG.paymentMethodHash,
    currencies: LUXON_PROVIDER_CONFIG.currencies
  });

  // Luxon returns single transaction details
  // Add Luxon to unified verifier
  const unifiedVerifierContract = await ethers.getContractAt(
    "UnifiedPaymentVerifier", unifiedVerifierAddress
  );
  await addPaymentMethodToUnifiedVerifier(
    hre,
    unifiedVerifierContract,
    LUXON_PROVIDER_CONFIG.paymentMethodHash
  );
  console.log("Luxon added to unified verifier...");

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network === "localhost" || network === "hardhat") {
    return false;
  }
  return true; // Frozen: payment methods are now managed by 16_configure_v2_payment_methods
};

export default func;
