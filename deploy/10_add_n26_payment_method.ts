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
import { N26_PROVIDER_CONFIG } from "../deployments/verifiers/n26";

// Deployment Scripts
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const unifiedVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");

  // Add N26 to payment method registry
  const paymentVerifierRegistryContract = await ethers.getContractAt(
    "PaymentVerifierRegistry", paymentVerifierRegistryAddress
  );
  await addPaymentMethodToRegistry(
    hre,
    paymentVerifierRegistryContract,
    N26_PROVIDER_CONFIG.paymentMethodHash,
    unifiedVerifierAddress,
    N26_PROVIDER_CONFIG.currencies
  );
  console.log("N26 added to payment method registry...");

  // Snapshot N26
  savePaymentMethodSnapshot(network, 'n26', {
    paymentMethodHash: N26_PROVIDER_CONFIG.paymentMethodHash,
    currencies: N26_PROVIDER_CONFIG.currencies
  });

  // N26 returns single transaction details
  // Add N26 to unified verifier
  const unifiedVerifierContract = await ethers.getContractAt(
    "UnifiedPaymentVerifier", unifiedVerifierAddress
  );
  await addPaymentMethodToUnifiedVerifier(
    hre,
    unifiedVerifierContract,
    N26_PROVIDER_CONFIG.paymentMethodHash
  );
  console.log("N26 added to unified verifier...");

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  return true;
};

export default func;
