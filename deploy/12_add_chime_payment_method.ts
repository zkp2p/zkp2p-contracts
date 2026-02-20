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
import { CHIME_PROVIDER_CONFIG } from "../deployments/verifiers/chime";

// Deployment Scripts
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const unifiedVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");

  // Add Chime to payment method registry
  const paymentVerifierRegistryContract = await ethers.getContractAt(
    "PaymentVerifierRegistry", paymentVerifierRegistryAddress
  );
  await addPaymentMethodToRegistry(
    hre,
    paymentVerifierRegistryContract,
    CHIME_PROVIDER_CONFIG.paymentMethodHash,
    unifiedVerifierAddress,
    CHIME_PROVIDER_CONFIG.currencies
  );
  console.log("Chime added to payment method registry...");

  // Snapshot Chime
  savePaymentMethodSnapshot(network, 'chime', {
    paymentMethodHash: CHIME_PROVIDER_CONFIG.paymentMethodHash,
    currencies: CHIME_PROVIDER_CONFIG.currencies
  });

  // Chime returns single transaction details
  // Add Chime to unified verifier
  const unifiedVerifierContract = await ethers.getContractAt(
    "UnifiedPaymentVerifier", unifiedVerifierAddress
  );
  await addPaymentMethodToUnifiedVerifier(
    hre,
    unifiedVerifierContract,
    CHIME_PROVIDER_CONFIG.paymentMethodHash
  );
  console.log("Chime added to unified verifier...");

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  return true; // Frozen: payment methods are now managed by 22_configure_v2_payment_methods
};

export default func;
