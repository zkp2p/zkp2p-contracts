import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  getDeployedContractAddress,
  removePaymentMethodFromRegistry,
  removePaymentMethodFromUnifiedVerifier,
  removePaymentMethodSnapshot,
  savePaymentMethodSnapshot,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { LUXON_PROVIDER_CONFIG } from "../deployments/verifiers/luxon";
import { N26_PROVIDER_CONFIG } from "../deployments/verifiers/n26";
import { ZELLE_PROVIDER_CONFIG } from "../deployments/verifiers/zelle";

const REMOVED_PAYMENT_METHODS = [
  { key: "n26", config: N26_PROVIDER_CONFIG },
  { key: "luxon", config: LUXON_PROVIDER_CONFIG },
];

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();

  const legacyVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
  const v2VerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");

  const legacyVerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", legacyVerifierAddress);
  const v2VerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", v2VerifierAddress);
  const paymentVerifierRegistryContract = await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistryAddress);

  console.log("\nConfiguring generic Zelle payment method");

  // New Zelle liquidity uses only the generic zelle hash. The legacy
  // zelle-citi/chase/bofa hashes remain registered in earlier scripts for
  // historical fulfillment and drain support only.
  await addPaymentMethodToUnifiedVerifier(
    hre,
    v2VerifierContract,
    ZELLE_PROVIDER_CONFIG.paymentMethodHash
  );

  await addPaymentMethodToRegistry(
    hre,
    paymentVerifierRegistryContract,
    ZELLE_PROVIDER_CONFIG.paymentMethodHash,
    v2VerifierAddress,
    ZELLE_PROVIDER_CONFIG.currencies
  );

  savePaymentMethodSnapshot(network, "zelle", {
    paymentMethodHash: ZELLE_PROVIDER_CONFIG.paymentMethodHash,
    currencies: ZELLE_PROVIDER_CONFIG.currencies,
  });

  console.log("Generic Zelle added to PaymentVerifierRegistry with V2 verifier");

  for (const { key, config } of REMOVED_PAYMENT_METHODS) {
    console.log(`\nRemoving ${key} payment method from verifier surfaces`);
    await removePaymentMethodFromUnifiedVerifier(hre, legacyVerifierContract, config.paymentMethodHash);
    await removePaymentMethodFromUnifiedVerifier(hre, v2VerifierContract, config.paymentMethodHash);
    await removePaymentMethodFromRegistry(hre, paymentVerifierRegistryContract, config.paymentMethodHash);
    removePaymentMethodSnapshot(network, key);
  }

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();

  try {
    const legacyVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
    const v2VerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");

    const legacyVerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", legacyVerifierAddress);
    const v2VerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", v2VerifierAddress);
    const paymentVerifierRegistryContract = await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistryAddress);

    const legacyPaymentMethods = await legacyVerifierContract.getPaymentMethods();
    const paymentMethods = await v2VerifierContract.getPaymentMethods();
    const inUnifiedVerifier = paymentMethods.includes(ZELLE_PROVIDER_CONFIG.paymentMethodHash);
    const inRegistry = await paymentVerifierRegistryContract.isPaymentMethod(ZELLE_PROVIDER_CONFIG.paymentMethodHash);
    const removedMethodsAbsent = await Promise.all(
      REMOVED_PAYMENT_METHODS.map(async ({ config }) => {
        const inLegacyUnifiedVerifier = legacyPaymentMethods.includes(config.paymentMethodHash);
        const inUnifiedVerifier = paymentMethods.includes(config.paymentMethodHash);
        const inRegistry = await paymentVerifierRegistryContract.isPaymentMethod(config.paymentMethodHash);
        return !inLegacyUnifiedVerifier && !inUnifiedVerifier && !inRegistry;
      })
    );

    if (!inUnifiedVerifier || !inRegistry) {
      return false;
    }

    if (removedMethodsAbsent.some((isAbsent) => !isAbsent)) {
      return false;
    }

    const verifier = await paymentVerifierRegistryContract.getVerifier(ZELLE_PROVIDER_CONFIG.paymentMethodHash);
    return verifier.toLowerCase() === v2VerifierAddress.toLowerCase();
  } catch (e) {
    return false;
  }
};

func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
