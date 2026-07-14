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
import {
  ZELLE_PROVIDER_CONFIG,
} from "../deployments/verifiers/zelle";

// Deployment Scripts
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const unifiedVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");

  // Get contract instances
  const paymentVerifierRegistryContract = await ethers.getContractAt(
    "PaymentVerifierRegistry", paymentVerifierRegistryAddress
  );
  const unifiedVerifierContract = await ethers.getContractAt(
    "UnifiedPaymentVerifier", unifiedVerifierAddress
  );

  // Add generic Zelle
  await addPaymentMethodToRegistry(
    hre,
    paymentVerifierRegistryContract,
    ZELLE_PROVIDER_CONFIG.paymentMethodHash,
    unifiedVerifierAddress,
    ZELLE_PROVIDER_CONFIG.currencies
  );
  console.log("Zelle added to payment method registry...");

  savePaymentMethodSnapshot(network, 'zelle', {
    paymentMethodHash: ZELLE_PROVIDER_CONFIG.paymentMethodHash,
    currencies: ZELLE_PROVIDER_CONFIG.currencies
  });

  await addPaymentMethodToUnifiedVerifier(
    hre,
    unifiedVerifierContract,
    ZELLE_PROVIDER_CONFIG.paymentMethodHash
  );
  console.log("Zelle added to unified verifier...");

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  if (network === "localhost" || network === "hardhat") {
    return false;
  }
  return true; // Frozen: payment methods are now managed by 15_configure_v2_payment_methods
};

export default func;
