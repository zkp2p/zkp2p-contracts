import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { ACTIVE_PAYMENT_METHODS, MULTI_SIG } from "../deployments/parameters";
import {
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  addWritePermission,
  removePaymentMethodFromRegistry,
  removeWritePermission,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";

const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);
const RETIRED_VERIFIER_DEPLOYMENTS = [
  "UnifiedPaymentVerifier",
  "UnifiedPaymentVerifierV2",
] as const;

const EXISTING_PAYMENT_BINDING: Record<
  string,
  {
    nullifierRegistryV2: string;
    nullifierRegistryV2CodeHash: string;
    unifiedPaymentVerifierV3: string;
    unifiedPaymentVerifierV3CodeHash: string;
  }
> = {
  base: {
    nullifierRegistryV2: "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB",
    nullifierRegistryV2CodeHash:
      "0x423e2a2183ecd538864079b6268f41957028c25514d1de57bd3d0e70fa6b9bd4",
    unifiedPaymentVerifierV3: "0xC6F4a193576C60892a47e111Bb5706c30162502B",
    unifiedPaymentVerifierV3CodeHash:
      "0x7636c79f0f46cf88c7122767e553264f1898fa253ea214f6a1c3187b0f0a4bcf",
  },
  base_staging: {
    nullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
    nullifierRegistryV2CodeHash:
      "0xd9d2f4b8bbca6fe26d7a0dfd7e0d6a6d63823ab2a1fe12971e752cf33dee72a0",
    unifiedPaymentVerifierV3: "0x4c62E99649c8Ba745E67018f5c8a483D77c429C4",
    unifiedPaymentVerifierV3CodeHash:
      "0x3125872c0996c6d79fc3ed080a1b85b0f6eeb1fd51d1003d517ea3053af5a8fa",
  },
};

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameStringSet(actual: string[], expected: string[]): boolean {
  const normalizedActual = actual.map((value) => value.toLowerCase()).sort();
  const normalizedExpected = expected
    .map((value) => value.toLowerCase())
    .sort();
  return (
    normalizedActual.length === normalizedExpected.length &&
    normalizedActual.every(
      (value, index) => value === normalizedExpected[index]
    )
  );
}

function paymentMethodHash(name: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
}

async function assertCode(address: string, label: string): Promise<string> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no bytecode: ${address}`);
  return code;
}

async function getPaymentBindingDeployments(
  hre: HardhatRuntimeEnvironment
): Promise<{
  nullifierRegistryV2: any | null;
  unifiedPaymentVerifierV3: any | null;
}> {
  const nullifierRegistryV2 = await hre.deployments.getOrNull(
    "NullifierRegistryV2"
  );
  const unifiedPaymentVerifierV3 = await hre.deployments.getOrNull(
    "UnifiedPaymentVerifierV3"
  );
  if (!!nullifierRegistryV2 !== !!unifiedPaymentVerifierV3) {
    throw new Error(
      "NullifierRegistryV2 and UnifiedPaymentVerifierV3 artifacts must both exist or both be absent"
    );
  }
  return { nullifierRegistryV2, unifiedPaymentVerifierV3 };
}

async function getRetiredVerifierAddresses(
  hre: HardhatRuntimeEnvironment
): Promise<string[]> {
  const deployments = await Promise.all(
    RETIRED_VERIFIER_DEPLOYMENTS.map((name) => hre.deployments.getOrNull(name))
  );
  if (
    EXISTING_PAYMENT_BINDING[hre.deployments.getNetworkName()] &&
    deployments.some((deployment) => deployment === null)
  ) {
    throw new Error(
      "Production-like networks require both retired verifier deployment artifacts"
    );
  }
  return Array.from(
    new Set(
      deployments
        .filter((deployment): deployment is any => deployment !== null)
        .map((deployment) => deployment.address.toLowerCase())
    )
  );
}

export async function assertPaymentBindingReady(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const deployments = await getPaymentBindingDeployments(hre);
  if (!deployments.nullifierRegistryV2 || !deployments.unifiedPaymentVerifierV3)
    return false;

  const expectedExisting = EXISTING_PAYMENT_BINDING[network];
  if (expectedExisting) {
    if (
      !sameAddress(
        deployments.nullifierRegistryV2.address,
        expectedExisting.nullifierRegistryV2
      )
    ) {
      throw new Error(
        "NullifierRegistryV2 address does not match the ratified deployment"
      );
    }
    if (
      !sameAddress(
        deployments.unifiedPaymentVerifierV3.address,
        expectedExisting.unifiedPaymentVerifierV3
      )
    ) {
      throw new Error(
        "UnifiedPaymentVerifierV3 address does not match the ratified deployment"
      );
    }
  }

  const nullifierRegistryV2Code = await assertCode(
    deployments.nullifierRegistryV2.address,
    "NullifierRegistryV2"
  );
  const unifiedPaymentVerifierV3Code = await assertCode(
    deployments.unifiedPaymentVerifierV3.address,
    "UnifiedPaymentVerifierV3"
  );
  if (expectedExisting) {
    if (
      ethers.utils.keccak256(nullifierRegistryV2Code) !==
      expectedExisting.nullifierRegistryV2CodeHash
    ) {
      throw new Error(
        "NullifierRegistryV2 runtime bytecode does not match the ratified deployment"
      );
    }
    if (
      ethers.utils.keccak256(unifiedPaymentVerifierV3Code) !==
      expectedExisting.unifiedPaymentVerifierV3CodeHash
    ) {
      throw new Error(
        "UnifiedPaymentVerifierV3 runtime bytecode does not match the ratified deployment"
      );
    }
  }

  const legacyNullifierRegistryAddress = (
    await hre.deployments.get("NullifierRegistry")
  ).address;
  const orchestratorRegistryAddress = (
    await hre.deployments.get("OrchestratorRegistry")
  ).address;
  const attestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));
  const nullifierRegistryV2 = await ethers.getContractAt(
    "NullifierRegistryV2",
    deployments.nullifierRegistryV2.address
  );
  const unifiedPaymentVerifierV3 = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3",
    deployments.unifiedPaymentVerifierV3.address
  );

  if (
    !sameAddress(
      await nullifierRegistryV2.legacyNullifierRegistry(),
      legacyNullifierRegistryAddress
    )
  ) {
    throw new Error("NullifierRegistryV2 legacy registry mismatch");
  }
  if (!sameAddress(await nullifierRegistryV2.owner(), governance)) {
    throw new Error("NullifierRegistryV2 owner mismatch");
  }
  if (
    !sameAddress(
      await unifiedPaymentVerifierV3.orchestratorRegistry(),
      orchestratorRegistryAddress
    )
  ) {
    throw new Error("UnifiedPaymentVerifierV3 orchestrator registry mismatch");
  }
  if (
    !sameAddress(
      await unifiedPaymentVerifierV3.nullifierRegistry(),
      nullifierRegistryV2.address
    )
  ) {
    throw new Error("UnifiedPaymentVerifierV3 nullifier registry mismatch");
  }
  if (
    !sameAddress(
      await unifiedPaymentVerifierV3.attestationVerifier(),
      attestationVerifier.address
    )
  ) {
    throw new Error("UnifiedPaymentVerifierV3 attestation verifier mismatch");
  }
  if (!sameAddress(await unifiedPaymentVerifierV3.owner(), governance)) {
    throw new Error("UnifiedPaymentVerifierV3 owner mismatch");
  }

  const expectedPaymentMethods = ACTIVE_PAYMENT_METHODS.map(paymentMethodHash);
  const actualPaymentMethods =
    await unifiedPaymentVerifierV3.getPaymentMethods();
  if (!sameStringSet(actualPaymentMethods, expectedPaymentMethods)) {
    throw new Error(
      "UnifiedPaymentVerifierV3 payment methods do not match the active method set"
    );
  }
  const writers: string[] = await nullifierRegistryV2.getWriters();
  if (
    writers.length !== 1 ||
    !sameAddress(writers[0], unifiedPaymentVerifierV3.address)
  ) {
    throw new Error(
      "NullifierRegistryV2 writers must contain only UnifiedPaymentVerifierV3"
    );
  }

  return true;
}

async function assertRegistrySurface(
  hre: HardhatRuntimeEnvironment,
  paymentVerifierRegistry: any,
  legacyNullifierRegistry: any
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  if (!sameAddress(await paymentVerifierRegistry.owner(), governance)) {
    throw new Error("PaymentVerifierRegistry owner mismatch");
  }
  if (!sameAddress(await legacyNullifierRegistry.owner(), governance)) {
    throw new Error("Legacy NullifierRegistry owner mismatch");
  }
  const actualMethods: string[] =
    await paymentVerifierRegistry.getPaymentMethods();
  const expectedMethods = ACTIVE_PAYMENT_METHODS.map(paymentMethodHash);
  if (!sameStringSet(actualMethods, expectedMethods)) {
    throw new Error(
      "PaymentVerifierRegistry methods do not match the active method set"
    );
  }
  for (const method of actualMethods) {
    if ((await paymentVerifierRegistry.getCurrencies(method)).length === 0) {
      throw new Error(`Payment method has no configured currencies: ${method}`);
    }
  }
}

export async function paymentBindingCutoverReady(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  if (!(await assertPaymentBindingReady(hre))) return false;
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    (
      await hre.deployments.get("PaymentVerifierRegistry")
    ).address
  );
  const legacyNullifierRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    (
      await hre.deployments.get("NullifierRegistry")
    ).address
  );
  await assertRegistrySurface(
    hre,
    paymentVerifierRegistry,
    legacyNullifierRegistry
  );
  const unifiedPaymentVerifierV3Address = (
    await hre.deployments.get("UnifiedPaymentVerifierV3")
  ).address;
  for (const method of await paymentVerifierRegistry.getPaymentMethods()) {
    if (
      !sameAddress(
        await paymentVerifierRegistry.getVerifier(method),
        unifiedPaymentVerifierV3Address
      )
    ) {
      return false;
    }
  }
  return (await legacyNullifierRegistry.getWriters()).length === 0;
}

async function deployLocalPaymentBinding(
  hre: HardhatRuntimeEnvironment,
  deployer: string,
  governance: string
): Promise<void> {
  const legacyNullifierRegistryAddress = (
    await hre.deployments.get("NullifierRegistry")
  ).address;
  const orchestratorRegistryAddress = (
    await hre.deployments.get("OrchestratorRegistry")
  ).address;
  const attestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));
  await assertCode(legacyNullifierRegistryAddress, "NullifierRegistry");
  await assertCode(orchestratorRegistryAddress, "OrchestratorRegistry");
  await assertCode(attestationVerifier.address, "AttestationVerifier");

  const nullifierRegistryV2Deployment = await hre.deployments.deploy(
    "NullifierRegistryV2",
    {
      from: deployer,
      args: [legacyNullifierRegistryAddress],
      log: true,
    }
  );
  if (!nullifierRegistryV2Deployment.newlyDeployed) {
    throw new Error("NullifierRegistryV2 was not freshly deployed");
  }
  await waitForDeploymentDelay(hre);

  const unifiedPaymentVerifierV3Deployment = await hre.deployments.deploy(
    "UnifiedPaymentVerifierV3",
    {
      from: deployer,
      args: [
        orchestratorRegistryAddress,
        nullifierRegistryV2Deployment.address,
        attestationVerifier.address,
      ],
      log: true,
    }
  );
  if (!unifiedPaymentVerifierV3Deployment.newlyDeployed) {
    throw new Error("UnifiedPaymentVerifierV3 was not freshly deployed");
  }
  await waitForDeploymentDelay(hre);

  const nullifierRegistryV2 = await ethers.getContractAt(
    "NullifierRegistryV2",
    nullifierRegistryV2Deployment.address
  );
  const unifiedPaymentVerifierV3 = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3",
    unifiedPaymentVerifierV3Deployment.address
  );
  for (const methodName of ACTIVE_PAYMENT_METHODS) {
    await addPaymentMethodToUnifiedVerifier(
      hre,
      unifiedPaymentVerifierV3,
      paymentMethodHash(methodName)
    );
  }
  await addWritePermission(
    hre,
    nullifierRegistryV2,
    unifiedPaymentVerifierV3.address
  );
  await setNewOwner(hre, nullifierRegistryV2, governance);
  await setNewOwner(hre, unifiedPaymentVerifierV3, governance);
}

async function cutOverPaymentBinding(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    (
      await hre.deployments.get("PaymentVerifierRegistry")
    ).address
  );
  const legacyNullifierRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    (
      await hre.deployments.get("NullifierRegistry")
    ).address
  );
  const unifiedPaymentVerifierV3Address = (
    await hre.deployments.get("UnifiedPaymentVerifierV3")
  ).address;
  await assertRegistrySurface(
    hre,
    paymentVerifierRegistry,
    legacyNullifierRegistry
  );

  const methodOrder: string[] =
    await paymentVerifierRegistry.getPaymentMethods();
  const retiredVerifierAddresses = await getRetiredVerifierAddresses(hre);
  const currentVerifiers = await Promise.all(
    methodOrder.map((method) => paymentVerifierRegistry.getVerifier(method))
  );
  const routesAreRetired = currentVerifiers.every((verifier) =>
    retiredVerifierAddresses.some((retired) => sameAddress(verifier, retired))
  );
  const routesAreV3 = currentVerifiers.every((verifier) =>
    sameAddress(verifier, unifiedPaymentVerifierV3Address)
  );
  if (!routesAreRetired && !routesAreV3) {
    throw new Error(
      "PaymentVerifierRegistry is in an unsupported partial or unknown cutover state"
    );
  }

  const legacyWriters: string[] = await legacyNullifierRegistry.getWriters();
  if (
    !legacyWriters.every((writer) =>
      retiredVerifierAddresses.some((retired) => sameAddress(writer, retired))
    )
  ) {
    throw new Error("Legacy NullifierRegistry has an unknown writer");
  }
  if (
    routesAreRetired &&
    legacyWriters.length !== retiredVerifierAddresses.length
  ) {
    throw new Error(
      "Legacy NullifierRegistry writers do not exactly match the retired verifiers"
    );
  }

  const safeTransactionsBefore = safeBatchCollector.count();
  if (routesAreRetired) {
    const currencies = await Promise.all(
      methodOrder.map((method) => paymentVerifierRegistry.getCurrencies(method))
    );
    for (const method of [...methodOrder].reverse()) {
      await removePaymentMethodFromRegistry(
        hre,
        paymentVerifierRegistry,
        method
      );
    }
    for (let index = 0; index < methodOrder.length; index += 1) {
      await addPaymentMethodToRegistry(
        hre,
        paymentVerifierRegistry,
        methodOrder[index],
        unifiedPaymentVerifierV3Address,
        currencies[index]
      );
    }
  }
  for (const writer of legacyWriters) {
    await removeWritePermission(hre, legacyNullifierRegistry, writer);
  }

  const expectedQueued =
    (routesAreRetired ? methodOrder.length * 2 : 0) + legacyWriters.length;
  const actualQueued = safeBatchCollector.count() - safeTransactionsBefore;
  if (actualQueued > 0) {
    if (actualQueued !== expectedQueued) {
      throw new Error(
        `Expected ${expectedQueued} Base cutover calls, queued ${actualQueued}`
      );
    }
    if (
      hre.deployments.getNetworkName() === "base" &&
      routesAreRetired &&
      expectedQueued !== 22
    ) {
      throw new Error(`Fresh Base cutover must contain exactly 22 calls`);
    }
    console.log(
      `=== V3 payment binding verified; ${actualQueued}-call Safe cutover prepared ===`
    );
  } else if (!(await paymentBindingCutoverReady(hre))) {
    throw new Error("V3 payment binding cutover verification failed");
  } else {
    console.log("=== V3 payment binding deployed, cut over, and verified ===");
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const existing = await getPaymentBindingDeployments(hre);

  if (!existing.nullifierRegistryV2 && !existing.unifiedPaymentVerifierV3) {
    if (EXISTING_PAYMENT_BINDING[network]) {
      throw new Error(
        "Ratified V3 payment-binding artifacts are missing; restore the canonical artifacts instead of redeploying"
      );
    }
    await deployLocalPaymentBinding(hre, deployer, governance);
  }

  await assertPaymentBindingReady(hre);
  await cutOverPaymentBinding(hre);
  const verified = await getPaymentBindingDeployments(hre);
  console.log("NullifierRegistryV2:", verified.nullifierRegistryV2.address);
  console.log(
    "UnifiedPaymentVerifierV3:",
    verified.unifiedPaymentVerifierV3.address
  );
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (await paymentBindingCutoverReady(hre)) return true;
  if (network === "base") {
    return process.env.ENABLE_BASE_V3_PAYMENT_BINDING_CUTOVER !== "true";
  }
  if (network === "base_staging") {
    return process.env.ENABLE_STAGING_V3_PAYMENT_BINDING_CUTOVER !== "true";
  }
  return false;
};

func.tags = ["31_deploy_v3_payment_binding_stack", "V3PaymentBindingStack"];

export default func;
