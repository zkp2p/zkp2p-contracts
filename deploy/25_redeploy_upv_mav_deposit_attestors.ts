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
import {
  MULTI_WITNESS_ADDRESSES,
  MULTI_WITNESS_THRESHOLD,
  MULTI_SIG,
} from "../deployments/parameters";
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

// Old addresses being replaced (deployed by scripts 22 and 24, before deposit attestor data).
// The new UnifiedPaymentVerifierV2 forwards deposit verification data to the attestation verifier and
// the new MultiAttestationVerifier resolves tagged deposit attestors from it.
const OLD_UPV_V2: any = {
  "base_staging": "0x7750f8Cc276f21B7Db1477FA044Bf3FD4951Bf20",
  "base": "0x46A58Dc65587D4D7B8198C6A25eEdf5b2535Da94",
};

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

const PAYMENT_METHOD_LABELS = new Map(
  ALL_PAYMENT_METHODS.map(({ key, config }) => [config.paymentMethodHash.toLowerCase(), key])
);
const DEPRECATED_PAYMENT_METHODS = new Set([
  N26_PROVIDER_CONFIG.paymentMethodHash.toLowerCase(),
  LUXON_PROVIDER_CONFIG.paymentMethodHash.toLowerCase(),
]);

type PaymentMethodMigration = {
  key: string;
  paymentMethodHash: string;
  currencies: string[];
};

function getPaymentMethodLabel(paymentMethodHash: string): string {
  return PAYMENT_METHOD_LABELS.get(paymentMethodHash.toLowerCase()) ?? `unknown-${paymentMethodHash.slice(0, 10)}`;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const oldUpvV2 = OLD_UPV_V2[network];
  if (!oldUpvV2) {
    throw new Error(`No old UPV V2 address configured for network ${network}`);
  }

  const initialWitnesses = MULTI_WITNESS_ADDRESSES[network];
  const initialThreshold = MULTI_WITNESS_THRESHOLD[network];
  if (!initialWitnesses || initialWitnesses.length === 0) {
    throw new Error(`No MultiAttestationVerifier witnesses configured for ${network}`);
  }
  if (!initialThreshold) {
    throw new Error(`No MultiAttestationVerifier threshold configured for ${network}`);
  }

  // Resolve existing infrastructure
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const nullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");

  console.log("=== Redeploying UPV V2 + MultiAttestationVerifier (deposit attestors) ===");
  console.log("Old UPV V2:", oldUpvV2);

  // 1. Deploy new MultiAttestationVerifier with the same witness set and threshold
  //    (overwrites deployment artifact)
  const multiAttestationVerifier = await deploy("MultiAttestationVerifier", {
    from: deployer,
    args: [initialWitnesses, initialThreshold],
  });
  console.log("New MultiAttestationVerifier deployed at", multiAttestationVerifier.address);
  await waitForDeploymentDelay(hre);

  // 2. Deploy new UnifiedPaymentVerifier wired to the new MultiAttestationVerifier
  //    (overwrites deployment artifact)
  const upv = await deploy("UnifiedPaymentVerifierV2", {
    contract: "UnifiedPaymentVerifier",
    from: deployer,
    args: [
      orchestratorRegistryAddress,
      nullifierRegistryAddress,
      multiAttestationVerifier.address,
    ],
  });
  console.log("New UnifiedPaymentVerifierV2 deployed at", upv.address);
  await waitForDeploymentDelay(hre);

  // 3. Build migration plan from live registry state before mutating permissions.
  const paymentVerifierRegistryContract = await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistryAddress);
  const v2VerifierContract = await ethers.getContractAt("UnifiedPaymentVerifier", upv.address);
  const livePaymentMethods = await paymentVerifierRegistryContract.getPaymentMethods();
  const migrationPlan: PaymentMethodMigration[] = [];
  const deprecatedPlan: PaymentMethodMigration[] = [];

  for (const paymentMethodHash of livePaymentMethods) {
    const currencies = await paymentVerifierRegistryContract.getCurrencies(paymentMethodHash);
    if (currencies.length === 0) {
      throw new Error(`Payment method ${paymentMethodHash} has no currencies configured`);
    }

    if (DEPRECATED_PAYMENT_METHODS.has(paymentMethodHash.toLowerCase())) {
      deprecatedPlan.push({
        key: getPaymentMethodLabel(paymentMethodHash),
        paymentMethodHash,
        currencies,
      });
      continue;
    }

    const currentVerifier = await paymentVerifierRegistryContract.getVerifier(paymentMethodHash);
    if (currentVerifier.toLowerCase() !== oldUpvV2.toLowerCase()) {
      continue;
    }

    migrationPlan.push({
      key: getPaymentMethodLabel(paymentMethodHash),
      paymentMethodHash,
      currencies,
    });
  }

  if (migrationPlan.length === 0 && deprecatedPlan.length === 0) {
    throw new Error(`No payment methods found for migration or deprecation`);
  }

  console.log(`Migration plan includes ${migrationPlan.length} payment methods:`);
  for (const { key, paymentMethodHash, currencies } of migrationPlan) {
    console.log(`- ${key}: ${paymentMethodHash} (${currencies.length} currencies)`);
  }
  console.log(`Deprecation plan includes ${deprecatedPlan.length} payment methods:`);
  for (const { key, paymentMethodHash } of deprecatedPlan) {
    console.log(`- ${key}: ${paymentMethodHash}`);
  }

  // 4. Grant NullifierRegistry write permission to new UPV
  const nullifierRegistryContract = await ethers.getContractAt("NullifierRegistry", nullifierRegistryAddress);
  await addWritePermission(hre, nullifierRegistryContract, upv.address);
  console.log("NullifierRegistry write permission granted to new UPV");

  // 5. Configure payment methods on new UPV and update PaymentVerifierRegistry
  // Detect whether deployer can execute registry transactions directly
  const registryOwner = await paymentVerifierRegistryContract.owner();
  const deployerIsRegistryOwner = (await hre.getUnnamedAccounts()).includes(registryOwner);

  for (const { key, paymentMethodHash, currencies } of migrationPlan) {
    console.log(`\nConfiguring payment method: ${key}`);

    // Add payment method to new UPV (deployer owns new UPV, always direct)
    await addPaymentMethodToUnifiedVerifier(hre, v2VerifierContract, paymentMethodHash);

    const isPaymentMethod = await paymentVerifierRegistryContract.isPaymentMethod(paymentMethodHash);

    // Remove from registry (currently points to old UPV)
    await removePaymentMethodFromRegistry(hre, paymentVerifierRegistryContract, paymentMethodHash);

    // Re-add with new UPV address
    // On production (deployer != registry owner), the removal above only logged Safe
    // batch calldata without executing, so isPaymentMethod() still returns true.
    // addPaymentMethodToRegistry would skip due to its idempotency check. Bypass it
    // by encoding the calldata directly into the Safe batch.
    if (!deployerIsRegistryOwner && isPaymentMethod) {
      const addCalldata = paymentVerifierRegistryContract.interface.encodeFunctionData("addPaymentMethod", [
        paymentMethodHash,
        upv.address,
        currencies,
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
        paymentMethodHash,
        upv.address,
        currencies
      );
    }
    console.log(`${key} wired to new UPV in PaymentVerifierRegistry`);

    // Save snapshot
    savePaymentMethodSnapshot(network, key, {
      paymentMethodHash,
      currencies,
    });
  }

  for (const { key, paymentMethodHash } of deprecatedPlan) {
    console.log(`\nRemoving deprecated payment method: ${key}`);
    await removePaymentMethodFromRegistry(hre, paymentVerifierRegistryContract, paymentMethodHash);
  }

  if (deployerIsRegistryOwner) {
    for (const { paymentMethodHash } of migrationPlan) {
      const verifier = await paymentVerifierRegistryContract.getVerifier(paymentMethodHash);
      if (verifier.toLowerCase() !== upv.address.toLowerCase()) {
        throw new Error(`Payment method ${paymentMethodHash} was not migrated to new UPV V2`);
      }
    }
    for (const { paymentMethodHash } of deprecatedPlan) {
      if (await paymentVerifierRegistryContract.isPaymentMethod(paymentMethodHash)) {
        throw new Error(`Deprecated payment method ${paymentMethodHash} was not removed`);
      }
    }
  } else {
    console.log("Registry ownership is multisig controlled; migration transactions were appended to the Safe batch");
  }

  // 6. Remove old UPV write permission from NullifierRegistry after registry migration steps
  await removeWritePermission(hre, nullifierRegistryContract, oldUpvV2);
  console.log("Old UPV V2 write permission removal queued/executed after registry rewiring");

  // 7. Transfer ownership of both new contracts
  await setNewOwner(hre, v2VerifierContract, multiSig);
  console.log("UnifiedPaymentVerifierV2 ownership transferred to", multiSig);

  const multiAttestationVerifierContract = await ethers.getContractAt(
    "MultiAttestationVerifier",
    multiAttestationVerifier.address
  );
  await setNewOwner(hre, multiAttestationVerifierContract, multiSig);
  console.log("MultiAttestationVerifier ownership transferred to", multiSig);

  // 8. Write Safe batch file if any multisig transactions were collected
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const batchCount = safeBatchCollector.count();
  if (batchCount > 0) {
    const batchFile = safeBatchCollector.writeBatchFile(network, String(chainId), multiSig);
    console.log(`\nSafe batch file written with ${batchCount} transactions: ${batchFile}`);
  }

  console.log("=== UPV V2 + MultiAttestationVerifier redeployment finished ===");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  const oldAddress = OLD_UPV_V2[network];
  if (!oldAddress) return true; // Skip networks without old addresses (localhost gets current code from script 14)
  try {
    const currentAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    return currentAddress !== oldAddress; // Skip if already replaced
  } catch (e) {
    return false;
  }
};

func.tags = ["25_redeploy_upv_mav_deposit_attestors"];
func.dependencies = ["MultiAttestationVerifier"];

export default func;
