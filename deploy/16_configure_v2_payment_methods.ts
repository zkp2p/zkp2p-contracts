import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  getDeployedContractAddress,
  addPaymentMethodToUnifiedVerifier,
  addPaymentMethodToRegistry,
  removePaymentMethodFromRegistry,
  savePaymentMethodSnapshot,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { MULTI_SIG } from "../deployments/parameters";
import { safeBatchCollector } from "../deployments/safeBatchCollector";
import { VENMO_PROVIDER_CONFIG } from "../deployments/verifiers/venmo";
import { REVOLUT_PROVIDER_CONFIG } from "../deployments/verifiers/revolut";
import { CASHAPP_PROVIDER_CONFIG } from "../deployments/verifiers/cashapp";
import { WISE_PROVIDER_CONFIG } from "../deployments/verifiers/wise";
import { MERCADOPAGO_PROVIDER_CONFIG } from "../deployments/verifiers/mercadopago";
import {
  ZELLE_CITI_PROVIDER_CONFIG,
  ZELLE_CHASE_PROVIDER_CONFIG,
  ZELLE_BOFA_PROVIDER_CONFIG,
} from "../deployments/verifiers/zelle";
import { PAYPAL_PROVIDER_CONFIG } from "../deployments/verifiers/paypal";
import { MONZO_PROVIDER_CONFIG } from "../deployments/verifiers/monzo";
import { N26_PROVIDER_CONFIG } from "../deployments/verifiers/n26";
import { ALIPAY_PROVIDER_CONFIG } from "../deployments/verifiers/alipay";
import { CHIME_PROVIDER_CONFIG } from "../deployments/verifiers/chime";
import { LUXON_PROVIDER_CONFIG } from "../deployments/verifiers/luxon";

const ALL_PAYMENT_METHODS = [
  { key: "venmo", config: VENMO_PROVIDER_CONFIG },
  { key: "revolut", config: REVOLUT_PROVIDER_CONFIG },
  { key: "cashapp", config: CASHAPP_PROVIDER_CONFIG },
  { key: "wise", config: WISE_PROVIDER_CONFIG },
  { key: "mercadopago", config: MERCADOPAGO_PROVIDER_CONFIG },
  { key: "zelle-citi", config: ZELLE_CITI_PROVIDER_CONFIG },
  { key: "zelle-chase", config: ZELLE_CHASE_PROVIDER_CONFIG },
  { key: "zelle-bofa", config: ZELLE_BOFA_PROVIDER_CONFIG },
  { key: "paypal", config: PAYPAL_PROVIDER_CONFIG },
  { key: "monzo", config: MONZO_PROVIDER_CONFIG },
  { key: "n26", config: N26_PROVIDER_CONFIG },
  { key: "alipay", config: ALIPAY_PROVIDER_CONFIG },
  { key: "chime", config: CHIME_PROVIDER_CONFIG },
  { key: "luxon", config: LUXON_PROVIDER_CONFIG },
];

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const v2VerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");

  const v2VerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", v2VerifierAddress);
  const paymentVerifierRegistryContract = await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistryAddress);

  // Detect whether deployer can execute transactions directly
  const registryOwner = await paymentVerifierRegistryContract.owner();
  const deployerIsOwner = (await hre.getUnnamedAccounts()).includes(registryOwner);

  for (const { key, config } of ALL_PAYMENT_METHODS) {
    console.log(`\nConfiguring payment method: ${key}`);

    // Step 1: Add payment method to V2 unified verifier
    await addPaymentMethodToUnifiedVerifier(hre, v2VerifierContract, config.paymentMethodHash);

    // Step 2: Check if registry already points to V2 verifier
    const isPaymentMethod = await paymentVerifierRegistryContract.isPaymentMethod(config.paymentMethodHash);
    if (isPaymentMethod) {
      const currentVerifier = await paymentVerifierRegistryContract.getVerifier(config.paymentMethodHash);
      if (currentVerifier === v2VerifierAddress) {
        console.log(`${key} already points to V2 verifier, skipping registry update`);
        savePaymentMethodSnapshot(network, key, {
          paymentMethodHash: config.paymentMethodHash,
          currencies: config.currencies,
        });
        continue;
      }

      // Step 3: Remove existing entry from registry
      await removePaymentMethodFromRegistry(hre, paymentVerifierRegistryContract, config.paymentMethodHash);
      console.log(`${key} removed from PaymentVerifierRegistry`);
    }

    // Step 4: Re-add with V2 verifier
    // On production (deployer ≠ owner), the removal in step 3 only logged calldata
    // without executing, so isPaymentMethod() still returns true. The
    // addPaymentMethodToRegistry helper would skip due to its idempotency check.
    // Bypass it by encoding the calldata directly.
    if (!deployerIsOwner && isPaymentMethod) {
      const addCalldata = paymentVerifierRegistryContract.interface.encodeFunctionData("addPaymentMethod", [
        config.paymentMethodHash,
        v2VerifierAddress,
        config.currencies
      ]);
      safeBatchCollector.add(
        paymentVerifierRegistryContract.address,
        addCalldata,
        `PaymentVerifierRegistry.addPaymentMethod(${key}, ${v2VerifierAddress})`
      );
    } else {
      await addPaymentMethodToRegistry(
        hre,
        paymentVerifierRegistryContract,
        config.paymentMethodHash,
        v2VerifierAddress,
        config.currencies
      );
    }
    console.log(`${key} added to PaymentVerifierRegistry with V2 verifier`);

    // Step 5: Save snapshot
    savePaymentMethodSnapshot(network, key, {
      paymentMethodHash: config.paymentMethodHash,
      currencies: config.currencies,
    });
  }

  console.log("\nV2 payment method configuration finished...");

  // Transfer UPV2 ownership to multisig (deferred from script 14 so deployer
  // can add payment methods directly without multisig calldata)
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;
  await setNewOwner(hre, v2VerifierContract, multiSig);
  console.log("UnifiedPaymentVerifierV2 ownership transferred to", multiSig);

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  return false;
};

func.dependencies = ["15_deploy_v2_periphery"];

export default func;
