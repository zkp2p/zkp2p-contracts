import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  getDeployedContractAddress,
  addWritePermission,
  removeWritePermission,
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
import { ZELLE_PROVIDER_CONFIG } from "../deployments/verifiers/zelle";
import { PAYPAL_PROVIDER_CONFIG } from "../deployments/verifiers/paypal";
import { MONZO_PROVIDER_CONFIG } from "../deployments/verifiers/monzo";
import { N26_PROVIDER_CONFIG } from "../deployments/verifiers/n26";
import { ALIPAY_PROVIDER_CONFIG } from "../deployments/verifiers/alipay";
import { CHIME_PROVIDER_CONFIG } from "../deployments/verifiers/chime";
import { LUXON_PROVIDER_CONFIG } from "../deployments/verifiers/luxon";

// Old UPV V2 addresses being replaced (deployed by script 14, before PR #148 OrchestratorV2 intent compat fix)
const OLD_UPV_V2: any = {
  "base_staging": "0xb9C46A988D4C616Bd4d43042954dF3cC0750726B",
  "base": "0x57833A85208b8E42db7368969662A6D7312b83D1",
};

const ALL_PAYMENT_METHODS = [
  { key: "venmo", config: VENMO_PROVIDER_CONFIG },
  { key: "revolut", config: REVOLUT_PROVIDER_CONFIG },
  { key: "cashapp", config: CASHAPP_PROVIDER_CONFIG },
  { key: "wise", config: WISE_PROVIDER_CONFIG },
  { key: "mercadopago", config: MERCADOPAGO_PROVIDER_CONFIG },
  { key: "zelle", config: ZELLE_PROVIDER_CONFIG },
  { key: "paypal", config: PAYPAL_PROVIDER_CONFIG },
  { key: "monzo", config: MONZO_PROVIDER_CONFIG },
  { key: "n26", config: N26_PROVIDER_CONFIG },
  { key: "alipay", config: ALIPAY_PROVIDER_CONFIG },
  { key: "chime", config: CHIME_PROVIDER_CONFIG },
  { key: "luxon", config: LUXON_PROVIDER_CONFIG },
];

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const oldUpvV2 = OLD_UPV_V2[network];
  if (!oldUpvV2) {
    throw new Error(`No old UPV V2 address configured for network ${network}`);
  }

  // Resolve existing infrastructure
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const nullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
  const simpleAttestationVerifierAddress = getDeployedContractAddress(network, "SimpleAttestationVerifier");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");

  console.log("=== Redeploying UnifiedPaymentVerifierV2 ===");
  console.log("Old UPV V2:", oldUpvV2);

  // 1. Deploy new UnifiedPaymentVerifier (overwrites deployment artifact)
  const upv = await deploy("UnifiedPaymentVerifierV2", {
    contract: "UnifiedPaymentVerifier",
    from: deployer,
    args: [
      orchestratorRegistryAddress,
      nullifierRegistryAddress,
      simpleAttestationVerifierAddress,
    ],
  });
  console.log("New UnifiedPaymentVerifierV2 deployed at", upv.address);
  await waitForDeploymentDelay(hre);

  // 2. Grant NullifierRegistry write permission to new UPV
  const nullifierRegistryContract = await ethers.getContractAt("NullifierRegistry", nullifierRegistryAddress);
  await addWritePermission(hre, nullifierRegistryContract, upv.address);
  console.log("NullifierRegistry write permission granted to new UPV");

  // 3. Remove old UPV write permission from NullifierRegistry
  await removeWritePermission(hre, nullifierRegistryContract, oldUpvV2);
  console.log("Old UPV V2 write permission removed from NullifierRegistry");

  // 4. Configure payment methods on new UPV and update PaymentVerifierRegistry
  const paymentVerifierRegistryContract = await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistryAddress);
  const v2VerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", upv.address);

  // Detect whether deployer can execute registry transactions directly
  const registryOwner = await paymentVerifierRegistryContract.owner();
  const deployerIsRegistryOwner = (await hre.getUnnamedAccounts()).includes(registryOwner);

  for (const { key, config } of ALL_PAYMENT_METHODS) {
    console.log(`\nConfiguring payment method: ${key}`);

    // Add payment method to new UPV (deployer owns new UPV, always direct)
    await addPaymentMethodToUnifiedVerifier(hre, v2VerifierContract, config.paymentMethodHash);

    const isPaymentMethod = await paymentVerifierRegistryContract.isPaymentMethod(config.paymentMethodHash);

    // Remove from registry (currently points to old UPV)
    await removePaymentMethodFromRegistry(hre, paymentVerifierRegistryContract, config.paymentMethodHash);

    // Re-add with new UPV address
    // On production (deployer != registry owner), the removal above only logged Safe
    // batch calldata without executing, so isPaymentMethod() still returns true.
    // addPaymentMethodToRegistry would skip due to its idempotency check. Bypass it
    // by encoding the calldata directly into the Safe batch.
    if (!deployerIsRegistryOwner && isPaymentMethod) {
      const addCalldata = paymentVerifierRegistryContract.interface.encodeFunctionData("addPaymentMethod", [
        config.paymentMethodHash,
        upv.address,
        config.currencies,
      ]);
      safeBatchCollector.add(
        paymentVerifierRegistryContract.address,
        addCalldata,
        `PaymentVerifierRegistry.addPaymentMethod(${key}, ${upv.address})`
      );
    } else {
      await addPaymentMethodToRegistry(
        hre,
        paymentVerifierRegistryContract,
        config.paymentMethodHash,
        upv.address,
        config.currencies
      );
    }
    console.log(`${key} wired to new UPV in PaymentVerifierRegistry`);

    // Save snapshot
    savePaymentMethodSnapshot(network, key, {
      paymentMethodHash: config.paymentMethodHash,
      currencies: config.currencies,
    });
  }

  // 5. Transfer ownership
  await setNewOwner(hre, v2VerifierContract, multiSig);
  console.log("UnifiedPaymentVerifierV2 ownership transferred to", multiSig);

  // 6. Write Safe batch file if any multisig transactions were collected
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const batchCount = safeBatchCollector.count();
  if (batchCount > 0) {
    const batchFile = safeBatchCollector.writeBatchFile(network, String(chainId), multiSig);
    console.log(`\nSafe batch file written with ${batchCount} transactions: ${batchFile}`);
  }

  console.log("=== UnifiedPaymentVerifierV2 redeployment finished ===");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  const oldAddress = OLD_UPV_V2[network];
  if (!oldAddress) return true; // Skip networks without old addresses
  try {
    const currentAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    return currentAddress !== oldAddress; // Skip if already replaced
  } catch (e) {
    return false;
  }
};

func.tags = ["22_redeploy_upv_v2"];
func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
