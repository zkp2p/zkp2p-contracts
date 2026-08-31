import "module-alias/register";

import type { Contract } from "ethers";
import { ethers } from "hardhat";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import {
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  savePaymentMethodSnapshot,
} from "../deployments/helpers";
import { XMONEY_PROVIDER_CONFIG } from "../deployments/verifiers/xmoney";
import {
  RATIFIED_PAYMENT_METHOD_CURRENCIES,
  RATIFIED_PAYMENT_METHOD_ORDER,
} from "./31_deploy_v3_payment_binding_stack";
import { calculatePaymentMethodHash } from "../utils/protocolUtils";

export const XMONEY_PREPARE_FLAG = "PREPARE_STAGING_XMONEY_PAYMENT_METHOD";
export const XMONEY_EXECUTE_FLAG = "EXECUTE_STAGING_XMONEY_PAYMENT_METHOD";
export const XMONEY_DEPLOY_TAG = "41_add_xmoney_payment_method";
const EXPECTED_CHAIN_ID = 8453;
const EXPECTED_STAGING = {
  governance: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
  legacyNullifierRegistry: "0x3FFd04f7909a16d3476263A1f4ce413A089dCc69",
  nullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
  paymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
  unifiedPaymentVerifierV3: "0x4c62E99649c8Ba745E67018f5c8a483D77c429C4",
} as const;

type StagingContracts = {
  legacyNullifierRegistry: Contract;
  nullifierRegistryV2: Contract;
  paymentVerifierRegistry: Contract;
  unifiedPaymentVerifierV3: Contract;
};

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameOrderedValues(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => value.toLowerCase() === right[index].toLowerCase(),
    )
  );
}

function sameValueSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left.map((value) => value.toLowerCase())).size === left.length &&
    left.every((value) =>
      right.some((candidate) => sameAddress(value, candidate)),
    )
  );
}

async function loadStagingContracts(
  hre: HardhatRuntimeEnvironment,
): Promise<StagingContracts> {
  if (hre.deployments.getNetworkName() !== "base_staging") {
    throw new Error("X Money payment-method activation is Base-staging only");
  }

  const providerNetwork = await ethers.provider.getNetwork();
  if (providerNetwork.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Provider chain ID ${providerNetwork.chainId} does not match Base ${EXPECTED_CHAIN_ID}`,
    );
  }

  const [
    registryDeployment,
    verifierDeployment,
    nullifierV2Deployment,
    legacyNullifierDeployment,
  ] = await Promise.all([
    hre.deployments.get("PaymentVerifierRegistry"),
    hre.deployments.get("UnifiedPaymentVerifierV3"),
    hre.deployments.get("NullifierRegistryV2"),
    hre.deployments.get("NullifierRegistry"),
  ]);
  const expectedDeployments = [
    [
      "PaymentVerifierRegistry",
      registryDeployment.address,
      EXPECTED_STAGING.paymentVerifierRegistry,
    ],
    [
      "UnifiedPaymentVerifierV3",
      verifierDeployment.address,
      EXPECTED_STAGING.unifiedPaymentVerifierV3,
    ],
    [
      "NullifierRegistryV2",
      nullifierV2Deployment.address,
      EXPECTED_STAGING.nullifierRegistryV2,
    ],
    [
      "NullifierRegistry",
      legacyNullifierDeployment.address,
      EXPECTED_STAGING.legacyNullifierRegistry,
    ],
  ] as const;

  for (const [label, actual, expected] of expectedDeployments) {
    if (!sameAddress(actual, expected)) {
      throw new Error(
        `${label} deployment artifact does not match Base staging`,
      );
    }
    if ((await ethers.provider.getCode(actual)) === "0x") {
      throw new Error(`${label} has no bytecode at ${actual}`);
    }
  }

  const contracts: StagingContracts = {
    paymentVerifierRegistry: await ethers.getContractAt(
      "PaymentVerifierRegistry",
      registryDeployment.address,
    ),
    unifiedPaymentVerifierV3: await ethers.getContractAt(
      "UnifiedPaymentVerifierV3",
      verifierDeployment.address,
    ),
    nullifierRegistryV2: await ethers.getContractAt(
      "NullifierRegistryV2",
      nullifierV2Deployment.address,
    ),
    legacyNullifierRegistry: await ethers.getContractAt(
      "NullifierRegistry",
      legacyNullifierDeployment.address,
    ),
  };
  const [deployer] = await hre.getUnnamedAccounts();
  const owners = await Promise.all([
    contracts.paymentVerifierRegistry.owner(),
    contracts.unifiedPaymentVerifierV3.owner(),
    contracts.nullifierRegistryV2.owner(),
    contracts.legacyNullifierRegistry.owner(),
  ]);
  if (
    !sameAddress(deployer, EXPECTED_STAGING.governance) ||
    owners.some((owner) => !sameAddress(owner, EXPECTED_STAGING.governance))
  ) {
    throw new Error("X Money activation signer or contract owner mismatch");
  }

  return contracts;
}

async function assertPaymentBindingState({
  legacyNullifierRegistry,
  nullifierRegistryV2,
  paymentVerifierRegistry,
  unifiedPaymentVerifierV3,
}: StagingContracts): Promise<boolean> {
  const paymentMethodHash = XMONEY_PROVIDER_CONFIG.paymentMethodHash;
  const [registryMethods, verifierMethods, nullifierWriters, legacyWriters] =
    (await Promise.all([
      paymentVerifierRegistry.getPaymentMethods(),
      unifiedPaymentVerifierV3.getPaymentMethods(),
      nullifierRegistryV2.getWriters(),
      legacyNullifierRegistry.getWriters(),
    ])) as [string[], string[], string[], string[]];
  const registryHasMethod = registryMethods.some((method) =>
    sameAddress(method, paymentMethodHash),
  );
  const verifierHasMethod = verifierMethods.some((method) =>
    sameAddress(method, paymentMethodHash),
  );
  if (registryHasMethod !== verifierHasMethod) {
    throw new Error("X Money payment binding is only partially configured");
  }

  const predecessorNames = RATIFIED_PAYMENT_METHOD_ORDER.base_staging;
  const expectedNames = registryHasMethod
    ? [...predecessorNames, "xmoney"]
    : predecessorNames;
  const expectedMethods = expectedNames.map(calculatePaymentMethodHash);
  if (!sameOrderedValues(registryMethods, expectedMethods)) {
    throw new Error(
      "PaymentVerifierRegistry methods drifted from the X Money plan",
    );
  }
  if (!sameValueSet(verifierMethods, expectedMethods)) {
    throw new Error(
      "UnifiedPaymentVerifierV3 methods drifted from the X Money plan",
    );
  }
  if (
    !sameAddress(
      await unifiedPaymentVerifierV3.nullifierRegistry(),
      nullifierRegistryV2.address,
    ) ||
    !sameAddress(
      await nullifierRegistryV2.legacyNullifierRegistry(),
      legacyNullifierRegistry.address,
    ) ||
    nullifierWriters.length !== 1 ||
    !sameAddress(nullifierWriters[0], unifiedPaymentVerifierV3.address) ||
    legacyWriters.length !== 0
  ) {
    throw new Error("X Money activation nullifier invariant failed");
  }

  for (let index = 0; index < expectedNames.length; index += 1) {
    const methodName = expectedNames[index];
    const methodHash = expectedMethods[index];
    const expectedCurrencies =
      methodName === "xmoney"
        ? XMONEY_PROVIDER_CONFIG.currencies
        : RATIFIED_PAYMENT_METHOD_CURRENCIES[methodName].map(
            calculatePaymentMethodHash,
          );
    const [verifier, currencies] = (await Promise.all([
      paymentVerifierRegistry.getVerifier(methodHash),
      paymentVerifierRegistry.getCurrencies(methodHash),
    ])) as [string, string[]];
    if (
      !sameAddress(verifier, unifiedPaymentVerifierV3.address) ||
      !sameOrderedValues(currencies, expectedCurrencies)
    ) {
      throw new Error(`Base-staging payment binding drifted for ${methodName}`);
    }
  }

  return registryHasMethod;
}

async function simulateMissingWrites({
  paymentVerifierRegistry,
  unifiedPaymentVerifierV3,
}: StagingContracts): Promise<void> {
  const paymentMethodHash = XMONEY_PROVIDER_CONFIG.paymentMethodHash;
  const verifierMethods =
    (await unifiedPaymentVerifierV3.getPaymentMethods()) as string[];
  if (
    !verifierMethods.some((method) => sameAddress(method, paymentMethodHash))
  ) {
    await ethers.provider.call({
      from: EXPECTED_STAGING.governance,
      to: unifiedPaymentVerifierV3.address,
      data: unifiedPaymentVerifierV3.interface.encodeFunctionData(
        "addPaymentMethod",
        [paymentMethodHash],
      ),
    });
  }
  if (!(await paymentVerifierRegistry.isPaymentMethod(paymentMethodHash))) {
    await ethers.provider.call({
      from: EXPECTED_STAGING.governance,
      to: paymentVerifierRegistry.address,
      data: paymentVerifierRegistry.interface.encodeFunctionData(
        "addPaymentMethod",
        [
          paymentMethodHash,
          EXPECTED_STAGING.unifiedPaymentVerifierV3,
          XMONEY_PROVIDER_CONFIG.currencies,
        ],
      ),
    });
  }
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment,
): Promise<void> {
  const contracts = await loadStagingContracts(hre);
  const alreadyActive = await assertPaymentBindingState(contracts);
  await simulateMissingWrites(contracts);

  if (process.env[XMONEY_PREPARE_FLAG] === "true") return;

  if (!alreadyActive) {
    await addPaymentMethodToUnifiedVerifier(
      hre,
      contracts.unifiedPaymentVerifierV3,
      XMONEY_PROVIDER_CONFIG.paymentMethodHash,
    );
    await addPaymentMethodToRegistry(
      hre,
      contracts.paymentVerifierRegistry,
      XMONEY_PROVIDER_CONFIG.paymentMethodHash,
      EXPECTED_STAGING.unifiedPaymentVerifierV3,
      XMONEY_PROVIDER_CONFIG.currencies,
    );
  }

  if (!(await assertPaymentBindingState(contracts))) {
    throw new Error("X Money Base-staging activation verification failed");
  }
  savePaymentMethodSnapshot("base_staging", "xmoney", {
    paymentMethodHash: XMONEY_PROVIDER_CONFIG.paymentMethodHash,
    currencies: XMONEY_PROVIDER_CONFIG.currencies,
  });
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  if (hre.deployments.getNetworkName() !== "base_staging") return true;

  const prepare = process.env[XMONEY_PREPARE_FLAG] === "true";
  const execute = process.env[XMONEY_EXECUTE_FLAG] === "true";
  if (prepare && execute) {
    throw new Error("Choose either X Money prepare or execute mode");
  }
  if (!prepare && !execute) {
    if (process.env.DEPLOY_ACTIVE_TAG === XMONEY_DEPLOY_TAG) {
      throw new Error(
        `Set ${XMONEY_PREPARE_FLAG}=true or ${XMONEY_EXECUTE_FLAG}=true for X Money staging activation`,
      );
    }
    return true;
  }
  return false;
};

func.tags = [XMONEY_DEPLOY_TAG, "XMoneyPaymentMethod"];
func.dependencies = [];

export default func;
