import "module-alias/register";

import { ethers } from "hardhat";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import {
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  savePaymentMethodSnapshot,
} from "../deployments/helpers";
import { MERCURY_PROVIDER_CONFIG } from "../deployments/verifiers/mercury";

const PREPARE_FLAG = "PREPARE_STAGING_MERCURY_PAYMENT_METHOD";
const EXECUTE_FLAG = "EXECUTE_STAGING_MERCURY_PAYMENT_METHOD";
const TAG = "35_add_mercury_payment_method";
const EXPECTED_CHAIN_ID = 8453;
const EXPECTED_STAGING = {
  governance: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
  paymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
  unifiedPaymentVerifierV3: "0x4c62E99649c8Ba745E67018f5c8a483D77c429C4",
} as const;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => value.toLowerCase() === right[index].toLowerCase()
    )
  );
}

async function loadStagingContracts(hre: HardhatRuntimeEnvironment): Promise<{
  paymentVerifierRegistry: any;
  unifiedPaymentVerifierV3: any;
}> {
  const network = hre.deployments.getNetworkName();
  if (network !== "base_staging") {
    throw new Error("Mercury payment-method activation is Base-staging only");
  }

  const providerNetwork = await ethers.provider.getNetwork();
  if (providerNetwork.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Provider chain ID ${providerNetwork.chainId} does not match Base ${EXPECTED_CHAIN_ID}`
    );
  }

  const registryDeployment = await hre.deployments.get(
    "PaymentVerifierRegistry"
  );
  const verifierDeployment = await hre.deployments.get(
    "UnifiedPaymentVerifierV3"
  );
  if (
    !sameAddress(
      registryDeployment.address,
      EXPECTED_STAGING.paymentVerifierRegistry
    ) ||
    !sameAddress(
      verifierDeployment.address,
      EXPECTED_STAGING.unifiedPaymentVerifierV3
    )
  ) {
    throw new Error(
      "Mercury activation deployment artifacts do not match staging"
    );
  }

  for (const [label, address] of [
    ["PaymentVerifierRegistry", registryDeployment.address],
    ["UnifiedPaymentVerifierV3", verifierDeployment.address],
  ] as const) {
    if ((await ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${label} has no bytecode at ${address}`);
    }
  }

  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    registryDeployment.address
  );
  const unifiedPaymentVerifierV3 = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3",
    verifierDeployment.address
  );
  const [deployer] = await hre.getUnnamedAccounts();
  const [registryOwner, verifierOwner] = await Promise.all([
    paymentVerifierRegistry.owner(),
    unifiedPaymentVerifierV3.owner(),
  ]);
  if (
    !sameAddress(deployer, EXPECTED_STAGING.governance) ||
    !sameAddress(registryOwner, EXPECTED_STAGING.governance) ||
    !sameAddress(verifierOwner, EXPECTED_STAGING.governance)
  ) {
    throw new Error("Mercury activation signer or contract owner mismatch");
  }

  return { paymentVerifierRegistry, unifiedPaymentVerifierV3 };
}

export async function mercuryStagingReady(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const { paymentVerifierRegistry, unifiedPaymentVerifierV3 } =
    await loadStagingContracts(hre);
  const paymentMethodHash = MERCURY_PROVIDER_CONFIG.paymentMethodHash;
  const verifierMethods: string[] =
    await unifiedPaymentVerifierV3.getPaymentMethods();
  const registryHasMethod = await paymentVerifierRegistry.isPaymentMethod(
    paymentMethodHash
  );
  const verifierHasMethod = verifierMethods.some((method) =>
    sameAddress(method, paymentMethodHash)
  );

  if (registryHasMethod) {
    if (!verifierHasMethod) {
      throw new Error(
        "PaymentVerifierRegistry contains Mercury before UnifiedPaymentVerifierV3"
      );
    }
    const [verifier, currencies] = await Promise.all([
      paymentVerifierRegistry.getVerifier(paymentMethodHash),
      paymentVerifierRegistry.getCurrencies(paymentMethodHash),
    ]);
    if (
      !sameAddress(verifier, EXPECTED_STAGING.unifiedPaymentVerifierV3) ||
      !sameStringArray(currencies, MERCURY_PROVIDER_CONFIG.currencies)
    ) {
      throw new Error("Existing Mercury registry configuration drifted");
    }
  }

  return registryHasMethod && verifierHasMethod;
}

async function simulateMissingWrites(
  paymentVerifierRegistry: any,
  unifiedPaymentVerifierV3: any
): Promise<void> {
  const paymentMethodHash = MERCURY_PROVIDER_CONFIG.paymentMethodHash;
  const verifierMethods: string[] =
    await unifiedPaymentVerifierV3.getPaymentMethods();
  const verifierHasMethod = verifierMethods.some((method) =>
    sameAddress(method, paymentMethodHash)
  );
  const registryHasMethod = await paymentVerifierRegistry.isPaymentMethod(
    paymentMethodHash
  );

  if (!verifierHasMethod) {
    await ethers.provider.call({
      from: EXPECTED_STAGING.governance,
      to: unifiedPaymentVerifierV3.address,
      data: unifiedPaymentVerifierV3.interface.encodeFunctionData(
        "addPaymentMethod",
        [paymentMethodHash]
      ),
    });
  }
  if (!registryHasMethod) {
    await ethers.provider.call({
      from: EXPECTED_STAGING.governance,
      to: paymentVerifierRegistry.address,
      data: paymentVerifierRegistry.interface.encodeFunctionData(
        "addPaymentMethod",
        [
          paymentMethodHash,
          EXPECTED_STAGING.unifiedPaymentVerifierV3,
          MERCURY_PROVIDER_CONFIG.currencies,
        ]
      ),
    });
  }

  console.log("Mercury Base-staging activation plan verified");
  console.log("Payment method:", paymentMethodHash);
  console.log("Currency:", MERCURY_PROVIDER_CONFIG.currencies[0]);
  console.log("UnifiedPaymentVerifierV3:", unifiedPaymentVerifierV3.address);
  console.log("PaymentVerifierRegistry:", paymentVerifierRegistry.address);
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const { paymentVerifierRegistry, unifiedPaymentVerifierV3 } =
    await loadStagingContracts(hre);
  await simulateMissingWrites(
    paymentVerifierRegistry,
    unifiedPaymentVerifierV3
  );

  if (process.env[PREPARE_FLAG] === "true") {
    return;
  }

  await addPaymentMethodToUnifiedVerifier(
    hre,
    unifiedPaymentVerifierV3,
    MERCURY_PROVIDER_CONFIG.paymentMethodHash
  );
  await addPaymentMethodToRegistry(
    hre,
    paymentVerifierRegistry,
    MERCURY_PROVIDER_CONFIG.paymentMethodHash,
    EXPECTED_STAGING.unifiedPaymentVerifierV3,
    MERCURY_PROVIDER_CONFIG.currencies
  );

  if (!(await mercuryStagingReady(hre))) {
    throw new Error("Mercury Base-staging activation verification failed");
  }
  savePaymentMethodSnapshot("base_staging", "mercury", {
    paymentMethodHash: MERCURY_PROVIDER_CONFIG.paymentMethodHash,
    currencies: MERCURY_PROVIDER_CONFIG.currencies,
  });
  console.log("Mercury is active on Base staging");
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  if (hre.deployments.getNetworkName() !== "base_staging") return true;

  const prepare = process.env[PREPARE_FLAG] === "true";
  const execute = process.env[EXECUTE_FLAG] === "true";
  if (prepare && execute) {
    throw new Error("Choose either Mercury prepare or execute mode");
  }
  if (!prepare && !execute) {
    if (process.env.DEPLOY_ACTIVE_TAG === TAG) {
      throw new Error(
        `Set ${PREPARE_FLAG}=true or ${EXECUTE_FLAG}=true for Mercury staging activation`
      );
    }
    return true;
  }
  return false;
};

func.tags = [TAG, "MercuryPaymentMethod"];
func.dependencies = [];

export default func;
