import "module-alias/register";

import { ethers } from "hardhat";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import {
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  savePaymentMethodSnapshot,
} from "../deployments/helpers";
import { UPI_PROVIDER_CONFIG } from "../deployments/verifiers/upi";
import { calculatePaymentMethodHash } from "../utils/protocolUtils";
import {
  RATIFIED_PAYMENT_METHOD_CURRENCIES,
  RATIFIED_PAYMENT_METHOD_ORDER,
} from "./31_deploy_v3_payment_binding_stack";

const PREPARE_FLAG = "PREPARE_STAGING_UPI_PAYMENT_METHOD";
const EXECUTE_FLAG = "EXECUTE_STAGING_UPI_PAYMENT_METHOD";
const TAG = "41_add_upi_payment_method";
const EXPECTED_CHAIN_ID = 8453;
const EXPECTED_STAGING = {
  governance: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
  legacyNullifierRegistry: "0x3FFd04f7909a16d3476263A1f4ce413A089dCc69",
  nullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
  paymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
  unifiedPaymentVerifierV3: "0x4c62E99649c8Ba745E67018f5c8a483D77c429C4",
} as const;

function sameValue(left: string, right: string): boolean {
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

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left.map((value) => value.toLowerCase())).size === left.length &&
    left.every((value) =>
      right.some((candidate) => sameValue(value, candidate))
    )
  );
}

async function loadStagingContracts(hre: HardhatRuntimeEnvironment): Promise<{
  legacyNullifierRegistry: any;
  nullifierRegistryV2: any;
  paymentVerifierRegistry: any;
  unifiedPaymentVerifierV3: any;
}> {
  const network = hre.deployments.getNetworkName();
  if (network !== "base_staging") {
    throw new Error("UPI payment-method activation is Base-staging only");
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
  const nullifierV2Deployment = await hre.deployments.get(
    "NullifierRegistryV2"
  );
  const legacyNullifierDeployment = await hre.deployments.get(
    "NullifierRegistry"
  );
  if (
    !sameValue(
      registryDeployment.address,
      EXPECTED_STAGING.paymentVerifierRegistry
    ) ||
    !sameValue(
      verifierDeployment.address,
      EXPECTED_STAGING.unifiedPaymentVerifierV3
    ) ||
    !sameValue(
      nullifierV2Deployment.address,
      EXPECTED_STAGING.nullifierRegistryV2
    ) ||
    !sameValue(
      legacyNullifierDeployment.address,
      EXPECTED_STAGING.legacyNullifierRegistry
    )
  ) {
    throw new Error("UPI activation deployment artifacts do not match staging");
  }

  for (const [label, address] of [
    ["PaymentVerifierRegistry", registryDeployment.address],
    ["UnifiedPaymentVerifierV3", verifierDeployment.address],
    ["NullifierRegistryV2", nullifierV2Deployment.address],
    ["NullifierRegistry", legacyNullifierDeployment.address],
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
  const nullifierRegistryV2 = await ethers.getContractAt(
    "NullifierRegistryV2",
    nullifierV2Deployment.address
  );
  const legacyNullifierRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    legacyNullifierDeployment.address
  );
  const [deployer] = await hre.getUnnamedAccounts();
  const [registryOwner, verifierOwner, nullifierV2Owner, legacyNullifierOwner] =
    await Promise.all([
      paymentVerifierRegistry.owner(),
      unifiedPaymentVerifierV3.owner(),
      nullifierRegistryV2.owner(),
      legacyNullifierRegistry.owner(),
    ]);
  if (
    !sameValue(deployer, EXPECTED_STAGING.governance) ||
    !sameValue(registryOwner, EXPECTED_STAGING.governance) ||
    !sameValue(verifierOwner, EXPECTED_STAGING.governance) ||
    !sameValue(nullifierV2Owner, EXPECTED_STAGING.governance) ||
    !sameValue(legacyNullifierOwner, EXPECTED_STAGING.governance)
  ) {
    throw new Error("UPI activation signer or contract owner mismatch");
  }

  return {
    legacyNullifierRegistry,
    nullifierRegistryV2,
    paymentVerifierRegistry,
    unifiedPaymentVerifierV3,
  };
}

async function assertPaymentBindingState(
  paymentVerifierRegistry: any,
  unifiedPaymentVerifierV3: any,
  nullifierRegistryV2: any,
  legacyNullifierRegistry: any
): Promise<{ registryHasMethod: boolean; verifierHasMethod: boolean }> {
  const paymentMethodHash = UPI_PROVIDER_CONFIG.paymentMethodHash;
  const [registryMethods, verifierMethods, nullifierWriters, legacyWriters] =
    await Promise.all([
      paymentVerifierRegistry.getPaymentMethods(),
      unifiedPaymentVerifierV3.getPaymentMethods(),
      nullifierRegistryV2.getWriters(),
      legacyNullifierRegistry.getWriters(),
    ]);
  const registryHasMethod = registryMethods.some((method: string) =>
    sameValue(method, paymentMethodHash)
  );
  const verifierHasMethod = verifierMethods.some((method: string) =>
    sameValue(method, paymentMethodHash)
  );
  if (registryHasMethod && !verifierHasMethod) {
    throw new Error(
      "PaymentVerifierRegistry contains UPI before UnifiedPaymentVerifierV3"
    );
  }

  const ratifiedOrder = RATIFIED_PAYMENT_METHOD_ORDER.base_staging;
  const preActivationMethodNames = ratifiedOrder.filter(
    (name) => name !== "upi"
  );
  const expectedRegistryNames = registryHasMethod
    ? ratifiedOrder
    : preActivationMethodNames;
  const expectedVerifierNames = verifierHasMethod
    ? ratifiedOrder
    : preActivationMethodNames;
  const expectedRegistryMethods = expectedRegistryNames.map(
    calculatePaymentMethodHash
  );
  const expectedVerifierMethods = expectedVerifierNames.map(
    calculatePaymentMethodHash
  );

  if (!sameStringArray(registryMethods, expectedRegistryMethods)) {
    throw new Error(
      "PaymentVerifierRegistry methods drifted from the ratified staging order"
    );
  }
  if (!sameStringSet(verifierMethods, expectedVerifierMethods)) {
    throw new Error(
      "UnifiedPaymentVerifierV3 methods drifted from the ratified staging set"
    );
  }
  if (
    !sameValue(
      await unifiedPaymentVerifierV3.nullifierRegistry(),
      nullifierRegistryV2.address
    ) ||
    !sameValue(
      await nullifierRegistryV2.legacyNullifierRegistry(),
      legacyNullifierRegistry.address
    )
  ) {
    throw new Error("UPI activation nullifier binding mismatch");
  }
  if (
    nullifierWriters.length !== 1 ||
    !sameValue(nullifierWriters[0], unifiedPaymentVerifierV3.address) ||
    legacyWriters.length !== 0
  ) {
    throw new Error("UPI activation nullifier writer invariant failed");
  }

  for (let index = 0; index < expectedRegistryNames.length; index += 1) {
    const methodName = expectedRegistryNames[index];
    const methodHash = expectedRegistryMethods[index];
    const [verifier, currencies] = await Promise.all([
      paymentVerifierRegistry.getVerifier(methodHash),
      paymentVerifierRegistry.getCurrencies(methodHash),
    ]);
    const expectedCurrencies = RATIFIED_PAYMENT_METHOD_CURRENCIES[
      methodName
    ].map(calculatePaymentMethodHash);
    if (
      !sameValue(verifier, unifiedPaymentVerifierV3.address) ||
      !sameStringArray(currencies, expectedCurrencies)
    ) {
      throw new Error(`Staging payment binding drifted for ${methodName}`);
    }
  }

  return { registryHasMethod, verifierHasMethod };
}

export async function upiStagingReady(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const {
    legacyNullifierRegistry,
    nullifierRegistryV2,
    paymentVerifierRegistry,
    unifiedPaymentVerifierV3,
  } = await loadStagingContracts(hre);
  const { registryHasMethod, verifierHasMethod } =
    await assertPaymentBindingState(
      paymentVerifierRegistry,
      unifiedPaymentVerifierV3,
      nullifierRegistryV2,
      legacyNullifierRegistry
    );
  if (
    registryHasMethod !==
    (await paymentVerifierRegistry.isPaymentMethod(
      UPI_PROVIDER_CONFIG.paymentMethodHash
    ))
  ) {
    throw new Error("UPI registry membership views disagree");
  }

  return registryHasMethod && verifierHasMethod;
}

async function simulateMissingWrites(
  paymentVerifierRegistry: any,
  unifiedPaymentVerifierV3: any
): Promise<void> {
  const paymentMethodHash = UPI_PROVIDER_CONFIG.paymentMethodHash;
  const verifierMethods: string[] =
    await unifiedPaymentVerifierV3.getPaymentMethods();
  const verifierHasMethod = verifierMethods.some((method) =>
    sameValue(method, paymentMethodHash)
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
          UPI_PROVIDER_CONFIG.currencies,
        ]
      ),
    });
  }

  console.log("UPI Base-staging activation plan verified");
  console.log("Payment method:", paymentMethodHash);
  console.log("Currency:", UPI_PROVIDER_CONFIG.currencies[0]);
  console.log("UnifiedPaymentVerifierV3:", unifiedPaymentVerifierV3.address);
  console.log("PaymentVerifierRegistry:", paymentVerifierRegistry.address);
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const {
    legacyNullifierRegistry,
    nullifierRegistryV2,
    paymentVerifierRegistry,
    unifiedPaymentVerifierV3,
  } = await loadStagingContracts(hre);
  await assertPaymentBindingState(
    paymentVerifierRegistry,
    unifiedPaymentVerifierV3,
    nullifierRegistryV2,
    legacyNullifierRegistry
  );
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
    UPI_PROVIDER_CONFIG.paymentMethodHash
  );
  await addPaymentMethodToRegistry(
    hre,
    paymentVerifierRegistry,
    UPI_PROVIDER_CONFIG.paymentMethodHash,
    EXPECTED_STAGING.unifiedPaymentVerifierV3,
    UPI_PROVIDER_CONFIG.currencies
  );

  if (!(await upiStagingReady(hre))) {
    throw new Error("UPI Base-staging activation verification failed");
  }
  savePaymentMethodSnapshot("base_staging", "upi", {
    paymentMethodHash: UPI_PROVIDER_CONFIG.paymentMethodHash,
    currencies: UPI_PROVIDER_CONFIG.currencies,
  });
  console.log("UPI is active on Base staging");
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  if (hre.deployments.getNetworkName() !== "base_staging") return true;

  const prepare = process.env[PREPARE_FLAG] === "true";
  const execute = process.env[EXECUTE_FLAG] === "true";
  if (prepare && execute) {
    throw new Error("Choose either UPI prepare or execute mode");
  }
  if (!prepare && !execute) {
    if (process.env.DEPLOY_ACTIVE_TAG === TAG) {
      throw new Error(
        `Set ${PREPARE_FLAG}=true or ${EXECUTE_FLAG}=true for UPI staging activation`
      );
    }
    return true;
  }
  return false;
};

func.tags = [TAG, "UpiPaymentMethod"];
func.dependencies = [];

export default func;
