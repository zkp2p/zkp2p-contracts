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

// Audited production-like registry currency snapshot. A run must stop instead
// of silently carrying unexpected currency drift into the new verifier route.
export const RATIFIED_PAYMENT_METHOD_CURRENCIES: Record<string, string[]> = {
  alipay: ["CNY"],
  chime: ["USD"],
  venmo: ["USD"],
  revolut: [
    "USD",
    "EUR",
    "GBP",
    "SGD",
    "NZD",
    "AUD",
    "CAD",
    "JPY",
    "HKD",
    "MXN",
    "SAR",
    "AED",
    "THB",
    "TRY",
    "PLN",
    "CHF",
    "ZAR",
    "CNY",
    "CZK",
    "DKK",
    "HUF",
    "NOK",
    "RON",
    "SEK",
  ],
  cashapp: ["USD"],
  wise: [
    "USD",
    "CNY",
    "EUR",
    "GBP",
    "AUD",
    "NZD",
    "CAD",
    "AED",
    "CHF",
    "ZAR",
    "SGD",
    "ILS",
    "HKD",
    "JPY",
    "PLN",
    "TRY",
    "IDR",
    "KES",
    "MYR",
    "MXN",
    "THB",
    "VND",
    "UGX",
    "CZK",
    "DKK",
    "HUF",
    "INR",
    "NOK",
    "PHP",
    "RON",
    "SEK",
  ],
  mercadopago: ["ARS"],
  zelle: ["USD"],
  monzo: ["GBP"],
  paypal: ["USD", "EUR", "GBP", "SGD", "NZD", "AUD", "CAD"],
};

export const RATIFIED_PAYMENT_METHOD_ORDER: Record<string, string[]> = {
  // Base block 49,791,973.
  base: [
    "alipay",
    "chime",
    "venmo",
    "revolut",
    "cashapp",
    "wise",
    "mercadopago",
    "zelle",
    "monzo",
    "paypal",
  ],
  // Base staging block 49,793,275. Staging was already hard-cut to UPV3 before
  // this lane was introduced, so lane 31 verifies this live order and never
  // attempts an unsafe multi-transaction EOA cutover there.
  base_staging: [
    "zelle",
    "monzo",
    "alipay",
    "chime",
    "venmo",
    "revolut",
    "cashapp",
    "wise",
    "mercadopago",
    "paypal",
  ],
};

const EXISTING_PAYMENT_BINDING: Record<
  string,
  {
    nullifierRegistryV2: string;
    nullifierRegistryV2CodeHash: string;
    unifiedPaymentVerifierV3: string;
    unifiedPaymentVerifierV3CodeHash: string;
    attestationVerifier: string;
    attestationVerifierCodeHash: string;
    governance: string;
    chainId: number;
    orchestratorRegistry: string;
    orchestrator: string;
    orchestratorCodeHash: string;
    orchestratorOwner: string;
    paymentVerifierRegistry: string;
    legacyNullifierRegistry: string;
    retiredVerifiers: [string, string];
    attestationWitnesses: [string, string];
    attestationThreshold: number;
  }
> = {
  base: {
    nullifierRegistryV2: "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB",
    nullifierRegistryV2CodeHash:
      "0x423e2a2183ecd538864079b6268f41957028c25514d1de57bd3d0e70fa6b9bd4",
    unifiedPaymentVerifierV3: "0xC6F4a193576C60892a47e111Bb5706c30162502B",
    unifiedPaymentVerifierV3CodeHash:
      "0x7636c79f0f46cf88c7122767e553264f1898fa253ea214f6a1c3187b0f0a4bcf",
    attestationVerifier: "0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5",
    attestationVerifierCodeHash:
      "0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a",
    governance: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    chainId: 8453,
    orchestratorRegistry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
    orchestrator: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
    orchestratorCodeHash:
      "0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9",
    orchestratorOwner: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    paymentVerifierRegistry: "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e",
    legacyNullifierRegistry: "0x8d8e1A0e5345a5cc9AA206c3ca76D6d28c514608",
    retiredVerifiers: [
      "0x16b3e4a3CA36D3A4bCA281767f15C7ADeF4ab163",
      "0x46A58Dc65587D4D7B8198C6A25eEdf5b2535Da94",
    ],
    attestationWitnesses: [
      "0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754",
      "0xE078D93bFdd87A8c5C5cCA5905DCbA0Dd7A1F0BD",
    ],
    attestationThreshold: 1,
  },
  base_staging: {
    nullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
    nullifierRegistryV2CodeHash:
      "0xd9d2f4b8bbca6fe26d7a0dfd7e0d6a6d63823ab2a1fe12971e752cf33dee72a0",
    unifiedPaymentVerifierV3: "0x4c62E99649c8Ba745E67018f5c8a483D77c429C4",
    unifiedPaymentVerifierV3CodeHash:
      "0x3125872c0996c6d79fc3ed080a1b85b0f6eeb1fd51d1003d517ea3053af5a8fa",
    attestationVerifier: "0x9855a39aC5975069632e91160d8712CBfF19e864",
    attestationVerifierCodeHash:
      "0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a",
    governance: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    chainId: 8453,
    orchestratorRegistry: "0xfA6384EB6176cfEC049540526A3d2126C3666d8A",
    orchestrator: "0x2b5E8Ab562e45fA89D73802605E145ED3E3EeF4f",
    orchestratorCodeHash:
      "0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9",
    orchestratorOwner: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    paymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
    legacyNullifierRegistry: "0x3FFd04f7909a16d3476263A1f4ce413A089dCc69",
    retiredVerifiers: [
      "0xfFf74adAE1fb470d49cA37772C9859C4a6dBcc03",
      "0x7750f8Cc276f21B7Db1477FA044Bf3FD4951Bf20",
    ],
    attestationWitnesses: [
      "0x66649F896521b0fb487fE2077b4FBDA283d7f19a",
      "0x4ab950AE1e3326578Bf7e643a2031E858aBa2927",
    ],
    attestationThreshold: 1,
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

function sameStringArray(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (value, index) => value.toLowerCase() === expected[index].toLowerCase()
    )
  );
}

export function assertPaymentBindingChainId(
  actualChainId: number,
  expectedChainId: number
): void {
  if (actualChainId !== expectedChainId) {
    throw new Error(
      `Provider chain ID ${actualChainId} does not match expected chain ID ${expectedChainId}`
    );
  }
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
  const expected = EXISTING_PAYMENT_BINDING[hre.deployments.getNetworkName()];
  const deployments = await Promise.all(
    RETIRED_VERIFIER_DEPLOYMENTS.map((name) => hre.deployments.getOrNull(name))
  );
  if (
    EXISTING_PAYMENT_BINDING[hre.deployments.getNetworkName()] &&
    deployments.some((deployment) => deployment == null)
  ) {
    throw new Error(
      "Production-like networks require both retired verifier deployment artifacts"
    );
  }
  if (
    expected &&
    !sameStringArray(
      deployments.map((deployment) => deployment!.address),
      expected.retiredVerifiers
    )
  ) {
    throw new Error(
      "Retired verifier artifacts do not match the audited targets"
    );
  }
  return Array.from(
    new Set(
      deployments
        .filter((deployment): deployment is any => deployment != null)
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
    const providerNetwork = await ethers.provider.getNetwork();
    assertPaymentBindingChainId(
      providerNetwork.chainId,
      expectedExisting.chainId
    );
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
  const orchestratorAddress = (await hre.deployments.get("OrchestratorV3"))
    .address;
  const expectedGovernance = expectedExisting?.governance || governance;
  if (
    expectedExisting &&
    (!sameAddress(
      legacyNullifierRegistryAddress,
      expectedExisting.legacyNullifierRegistry
    ) ||
      !sameAddress(
        orchestratorRegistryAddress,
        expectedExisting.orchestratorRegistry
      ) ||
      !sameAddress(orchestratorAddress, expectedExisting.orchestrator))
  ) {
    throw new Error("Payment-binding dependency artifact address mismatch");
  }
  if (expectedExisting) {
    const orchestratorRegistry = await ethers.getContractAt(
      "OrchestratorRegistry",
      orchestratorRegistryAddress
    );
    const orchestrator = await ethers.getContractAt(
      "OrchestratorV3",
      orchestratorAddress
    );
    const orchestratorCode = await assertCode(
      orchestratorAddress,
      "OrchestratorV3"
    );
    if (
      ethers.utils.keccak256(orchestratorCode) !==
      expectedExisting.orchestratorCodeHash
    ) {
      throw new Error("Active OrchestratorV3 runtime bytecode mismatch");
    }
    if (!(await orchestratorRegistry.isOrchestrator(orchestratorAddress))) {
      throw new Error(
        "Active OrchestratorV3 is not registered before the payment cutover"
      );
    }
    if (
      !sameAddress(
        await orchestrator.owner(),
        expectedExisting.orchestratorOwner
      )
    ) {
      throw new Error("Active OrchestratorV3 owner mismatch");
    }
    if (await orchestrator.paused()) {
      throw new Error("Active OrchestratorV3 is paused");
    }
    if (
      !(await orchestrator.chainId()).eq(expectedExisting.chainId) ||
      !sameAddress(
        await orchestrator.paymentVerifierRegistry(),
        expectedExisting.paymentVerifierRegistry
      )
    ) {
      throw new Error(
        "Active OrchestratorV3 payment-routing configuration mismatch"
      );
    }
  }
  const attestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));
  if (expectedExisting) {
    if (
      !sameAddress(
        attestationVerifier.address,
        expectedExisting.attestationVerifier
      )
    ) {
      throw new Error("Attestation verifier address mismatch");
    }
    const attestationVerifierCode = await assertCode(
      attestationVerifier.address,
      "MultiAttestationVerifier"
    );
    if (
      ethers.utils.keccak256(attestationVerifierCode) !==
      expectedExisting.attestationVerifierCodeHash
    ) {
      throw new Error("Attestation verifier runtime bytecode mismatch");
    }
    const multiAttestationVerifier = await ethers.getContractAt(
      "MultiAttestationVerifier",
      attestationVerifier.address
    );
    if (
      !sameAddress(await multiAttestationVerifier.owner(), expectedGovernance)
    ) {
      throw new Error("Attestation verifier owner mismatch");
    }
    if (
      !sameStringArray(
        await multiAttestationVerifier.witnesses(),
        expectedExisting.attestationWitnesses
      ) ||
      !(await multiAttestationVerifier.requiredSignatures()).eq(
        expectedExisting.attestationThreshold
      )
    ) {
      throw new Error("Attestation verifier witness configuration mismatch");
    }
  }
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
  if (!sameAddress(await nullifierRegistryV2.owner(), expectedGovernance)) {
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
  if (
    !sameAddress(await unifiedPaymentVerifierV3.owner(), expectedGovernance)
  ) {
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
  const expected = EXISTING_PAYMENT_BINDING[network];
  const expectedGovernance = expected?.governance || governance;
  if (
    expected &&
    (!sameAddress(
      paymentVerifierRegistry.address,
      expected.paymentVerifierRegistry
    ) ||
      !sameAddress(
        legacyNullifierRegistry.address,
        expected.legacyNullifierRegistry
      ))
  ) {
    throw new Error("Payment registry target address mismatch");
  }
  if (!sameAddress(await paymentVerifierRegistry.owner(), expectedGovernance)) {
    throw new Error("PaymentVerifierRegistry owner mismatch");
  }
  if (!sameAddress(await legacyNullifierRegistry.owner(), expectedGovernance)) {
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
  const ratifiedOrder = RATIFIED_PAYMENT_METHOD_ORDER[network];
  if (
    network === "base" &&
    !sameStringArray(ACTIVE_PAYMENT_METHODS, ratifiedOrder)
  ) {
    throw new Error(
      "ACTIVE_PAYMENT_METHODS drifted from the audited Base method order"
    );
  }
  const expectedOrder = ratifiedOrder?.map(paymentMethodHash);
  if (expectedOrder && !sameStringArray(actualMethods, expectedOrder)) {
    throw new Error(
      `${network} PaymentVerifierRegistry method order drifted from the audited snapshot`
    );
  }
  for (const method of actualMethods) {
    const currencies: string[] = await paymentVerifierRegistry.getCurrencies(
      method
    );
    if (currencies.length === 0) {
      throw new Error(`Payment method has no configured currencies: ${method}`);
    }
  }
  if (ratifiedOrder) {
    for (let index = 0; index < ratifiedOrder.length; index += 1) {
      const methodName = ratifiedOrder[index];
      const expectedCurrencies =
        RATIFIED_PAYMENT_METHOD_CURRENCIES[methodName].map(paymentMethodHash);
      const actualCurrencies: string[] =
        await paymentVerifierRegistry.getCurrencies(actualMethods[index]);
      if (!sameStringArray(actualCurrencies, expectedCurrencies)) {
        throw new Error(
          `${network} PaymentVerifierRegistry currencies drifted for ${methodName}`
        );
      }
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
  const network = hre.deployments.getNetworkName();
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
  const expectedRetiredVerifierAddress = (
    await hre.deployments.get("UnifiedPaymentVerifierV2")
  ).address;
  const currentVerifiers = await Promise.all(
    methodOrder.map((method) => paymentVerifierRegistry.getVerifier(method))
  );
  const routesAreRetired = currentVerifiers.every((verifier) =>
    sameAddress(verifier, expectedRetiredVerifierAddress)
  );
  const routesAreV3 = currentVerifiers.every((verifier) =>
    sameAddress(verifier, unifiedPaymentVerifierV3Address)
  );
  if (!routesAreRetired && !routesAreV3) {
    throw new Error(
      "PaymentVerifierRegistry is in an unsupported partial or unknown cutover state"
    );
  }

  if (network === "base" && routesAreRetired) {
    const nullifierRegistryV2Deployment = await hre.deployments.get(
      "NullifierRegistryV2"
    );
    const deploymentBlock = nullifierRegistryV2Deployment.receipt?.blockNumber;
    if (deploymentBlock == null) {
      throw new Error(
        "NullifierRegistryV2 deployment block is missing from the canonical artifact"
      );
    }
    const nullifierEvents = await ethers.provider.getLogs({
      address: nullifierRegistryV2Deployment.address,
      fromBlock: deploymentBlock,
      toBlock: "latest",
      topics: [ethers.utils.id("NullifierAdded(bytes32,bytes32,address)")],
    });
    if (nullifierEvents.length !== 0) {
      throw new Error(
        "NullifierRegistryV2 has pre-cutover nullifier history; stop and reconcile the one-way migration invariant"
      );
    }
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
    !sameStringArray(legacyWriters, retiredVerifierAddresses)
  ) {
    throw new Error(
      "Legacy NullifierRegistry writer order does not exactly match UPV1 then UPV2"
    );
  }
  if (routesAreV3 && legacyWriters.length !== 0) {
    throw new Error(
      "Payment routes are on UPV3 but retired legacy writers remain; stop and reconcile the unexpected partial cutover state"
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
    if (network === "base" && routesAreRetired && expectedQueued !== 22) {
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
  if (network === "base_staging") {
    if (!(await paymentBindingCutoverReady(hre))) {
      throw new Error(
        "Base staging is verification-only because its EOA-owned registries cannot execute the cutover atomically; repair any drift with a separately reviewed recovery plan"
      );
    }
    console.log(
      "=== Existing Base staging V3 payment binding verified as fully cut over ==="
    );
    return;
  }
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
    throw new Error(
      "Base staging V3 payment binding is not ready; direct EOA cutover is disabled because it cannot be atomic"
    );
  }
  return false;
};

func.tags = ["31_deploy_v3_payment_binding_stack", "V3PaymentBindingStack"];

export default func;
