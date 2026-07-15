import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  getDeployedContractAddress,
  removePaymentMethodFromRegistry,
  removePaymentMethodFromUnifiedVerifier,
  removePaymentMethodSnapshot,
  waitForDeploymentDelay,
} from "../deployments/helpers";

export const GENERIC_ZELLE_PAYMENT_METHOD_HASH =
  "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3";

export const LEGACY_ZELLE_PAYMENT_METHODS = [
  {
    key: "zelle-citi",
    hash: "0x817260692b75e93c7fbc51c71637d4075a975e221e1ebc1abeddfabd731fd90d",
  },
  {
    key: "zelle-chase",
    hash: "0x6aa1d1401e79ad0549dced8b1b96fb72c41cd02b32a7d9ea1fed54ba9e17152e",
  },
  {
    key: "zelle-bofa",
    hash: "0x4bc42b322a3ad413b91b2fde30549ca70d6ee900eded1681de91aaf32ffd7ab5",
  },
] as const;

type VerifierContracts = {
  paymentVerifierRegistry: any;
  legacyUnifiedPaymentVerifier: any;
  unifiedPaymentVerifierV2: any;
};

async function assertGenericZelleProtected(
  contracts: VerifierContracts,
  unifiedPaymentVerifierV2Address: string
): Promise<void> {
  const expectedGenericHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));
  if (GENERIC_ZELLE_PAYMENT_METHOD_HASH !== expectedGenericHash) {
    throw new Error("Generic Zelle hash does not match keccak256(zelle)");
  }

  const legacyHashes = new Set<string>();
  for (const { key, hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
    const expectedLegacyHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(key));
    if (hash !== expectedLegacyHash || String(hash) === GENERIC_ZELLE_PAYMENT_METHOD_HASH) {
      throw new Error(`Invalid legacy Zelle payment method hash for ${key}`);
    }
    legacyHashes.add(hash);
  }
  if (legacyHashes.size !== LEGACY_ZELLE_PAYMENT_METHODS.length) {
    throw new Error("Legacy Zelle payment method hashes must be unique");
  }

  const genericRegistered = await contracts.paymentVerifierRegistry.isPaymentMethod(
    GENERIC_ZELLE_PAYMENT_METHOD_HASH
  );
  const genericVerifier = await contracts.paymentVerifierRegistry.getVerifier(
    GENERIC_ZELLE_PAYMENT_METHOD_HASH
  );
  const v2PaymentMethods = await contracts.unifiedPaymentVerifierV2.getPaymentMethods();

  if (
    !genericRegistered ||
    genericVerifier.toLowerCase() !== unifiedPaymentVerifierV2Address.toLowerCase() ||
    !v2PaymentMethods.includes(GENERIC_ZELLE_PAYMENT_METHOD_HASH)
  ) {
    throw new Error("Generic Zelle must remain registered to UnifiedPaymentVerifierV2");
  }
}

export async function removeLegacyZelleVerifierRegistrations(
  hre: HardhatRuntimeEnvironment,
  contracts: VerifierContracts,
  unifiedPaymentVerifierV2Address: string
): Promise<void> {
  await assertGenericZelleProtected(contracts, unifiedPaymentVerifierV2Address);

  // Close routing first, then remove both verifier allowlists.
  for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
    await removePaymentMethodFromRegistry(hre, contracts.paymentVerifierRegistry, hash);
  }
  for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
    await removePaymentMethodFromUnifiedVerifier(hre, contracts.legacyUnifiedPaymentVerifier, hash);
  }
  for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
    await removePaymentMethodFromUnifiedVerifier(hre, contracts.unifiedPaymentVerifierV2, hash);
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  const legacyVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
  const unifiedPaymentVerifierV2Address = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");

  const contracts: VerifierContracts = {
    paymentVerifierRegistry: await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistryAddress),
    legacyUnifiedPaymentVerifier: await ethers.getContractAt("UnifiedPaymentVerifier", legacyVerifierAddress),
    unifiedPaymentVerifierV2: await ethers.getContractAt("UnifiedPaymentVerifier", unifiedPaymentVerifierV2Address),
  };

  console.log("\nRemoving legacy Zelle payment methods");
  await removeLegacyZelleVerifierRegistrations(hre, contracts, unifiedPaymentVerifierV2Address);

  for (const { key } of LEGACY_ZELLE_PAYMENT_METHODS) {
    removePaymentMethodSnapshot(network, key);
  }

  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();

  try {
    const legacyVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
    const unifiedPaymentVerifierV2Address = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
    const contracts: VerifierContracts = {
      paymentVerifierRegistry: await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistryAddress),
      legacyUnifiedPaymentVerifier: await ethers.getContractAt("UnifiedPaymentVerifier", legacyVerifierAddress),
      unifiedPaymentVerifierV2: await ethers.getContractAt("UnifiedPaymentVerifier", unifiedPaymentVerifierV2Address),
    };

    await assertGenericZelleProtected(contracts, unifiedPaymentVerifierV2Address);

    const legacyPaymentMethods = await contracts.legacyUnifiedPaymentVerifier.getPaymentMethods();
    const v2PaymentMethods = await contracts.unifiedPaymentVerifierV2.getPaymentMethods();
    const legacyMethodsAbsent = await Promise.all(
      LEGACY_ZELLE_PAYMENT_METHODS.map(async ({ hash }) =>
        !(await contracts.paymentVerifierRegistry.isPaymentMethod(hash)) &&
        !legacyPaymentMethods.includes(hash) &&
        !v2PaymentMethods.includes(hash)
      )
    );

    return legacyMethodsAbsent.every(Boolean);
  } catch {
    return false;
  }
};

func.tags = ["27_remove_legacy_zelle_payment_methods"];

export default func;
