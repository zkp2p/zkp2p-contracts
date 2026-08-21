import "ts-node/register/transpile-only";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

import {
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  USDC,
  getActivePaymentMethods,
} from "../../../../deployments/parameters";

type ActiveDisputeStack = { version: number; selectionHash: string };
type DeploymentEntry = {
  address: string;
  deployedBytecode?: string;
  solcInputHash?: string;
  receipt?: { blockNumber?: number };
};
type DeploymentOutput = {
  name: string;
  chainId: string | number;
  contracts: Record<string, { address: string; abi: unknown[] }>;
  activeDisputeStack?: ActiveDisputeStack;
};
type RuntimeIdentityName =
  | "Orchestrator"
  | "OrchestratorV2"
  | "OrchestratorV3"
  | "StakeVault"
  | "DisputeProtectionPolicy"
  | "IntentLifecycleHookV1"
  | "RecognizedPredecessorHook"
  | "RecognizedPredecessorPolicy"
  | "OrchestratorRegistry"
  | "WhitelistPolicy"
  | "DisputeVerifier"
  | "DisputeNullifierRegistry"
  | "MultiAttestationVerifier";
type RuntimeIdentity = { address: string; runtimeCodeHash: string };
type AddressExpectationName =
  | "AddressGroupRegistry"
  | "EscrowRegistry"
  | "PaymentVerifierRegistry"
  | "RelayerRegistry"
  | "NullifierRegistryV2"
  | "StakeToken";
type ReadinessEvidence = {
  schemaVersion: number;
  riskWindowSecondsByPaymentMethod: Record<string, Record<string, string>>;
  sentinel: { escrow: string; depositId: string; expected: false };
  prerequisites: {
    orchestratorPaused: false;
    admissionsPaused: false;
    allowMultipleIntents: true;
    orchestratorRegistered: true;
    lifecycleHookAuthorized: true;
    disputeNullifierWriterAuthorized: true;
    vaultControllerActivated: true;
    vaultPendingController: string;
    vaultPendingControllerValidAt: string;
    pendingCoverageMaturity: string;
  };
  networks: Record<
    string,
    {
      governance: { owner: string; pendingOwner: string };
      attestationTrust: { requiredSignatures: string; witnesses: string[] };
      activeDisputeStack: ActiveDisputeStack;
      recognizedPredecessorHook: RuntimeIdentity;
      recognizedPredecessorPolicy: RuntimeIdentity;
      addresses: Record<
        Exclude<RuntimeIdentityName, "RecognizedPredecessorHook" | "RecognizedPredecessorPolicy">,
        string
      >;
      addressExpectations: Record<AddressExpectationName, string>;
      deploymentEvidence: Record<
        RuntimeIdentityName,
        { deploymentName: string; solcInputHash: string; deployedBytecodeHash: string }
      >;
      runtimeCodeHashes: Record<
        Exclude<RuntimeIdentityName, "RecognizedPredecessorHook" | "RecognizedPredecessorPolicy">,
        string
      >;
    }
  >;
};

const ROOT = path.resolve(__dirname, "../../../../");
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const OUTPUT_DIRECTORY = path.join(PACKAGE_ROOT, "disputeReadiness");
const EVIDENCE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "deployments", "dispute-readiness-evidence.json"), "utf8"),
) as ReadinessEvidence;
const {
  getActiveDisputeDeploymentName,
  getActiveDisputeSelectionStamp,
  resolveActiveDisputeAliases,
} = require(path.join(ROOT, "deployments", "activeDisputeStack.cjs"));

const NETWORKS = [
  {
    packageName: "base",
    manifestName: "base",
    deploymentDirectory: "base",
    outputFile: "baseContracts.ts",
  },
  {
    packageName: "baseStaging",
    manifestName: "base_staging",
    deploymentDirectory: "base_staging",
    outputFile: "baseStagingContracts.ts",
  },
] as const;

const RUNTIME_IDENTITY_NAMES: RuntimeIdentityName[] = [
  "Orchestrator",
  "OrchestratorV2",
  "OrchestratorV3",
  "StakeVault",
  "DisputeProtectionPolicy",
  "IntentLifecycleHookV1",
  "RecognizedPredecessorHook",
  "RecognizedPredecessorPolicy",
  "OrchestratorRegistry",
  "WhitelistPolicy",
  "DisputeVerifier",
  "DisputeNullifierRegistry",
  "MultiAttestationVerifier",
];
const DIRECT_RUNTIME_NAMES = [
  "OrchestratorRegistry",
  "DisputeNullifierRegistry",
  "MultiAttestationVerifier",
] as const;
const ADDRESS_EXPECTATION_NAMES: AddressExpectationName[] = [
  "AddressGroupRegistry",
  "EscrowRegistry",
  "PaymentVerifierRegistry",
  "RelayerRegistry",
  "NullifierRegistryV2",
  "StakeToken",
];
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SENTINEL_ESCROW = "0x0000000000000000000000000000000000000001";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_UINT64 = "18446744073709551615";
const GOVERNED_RUNTIME_IDENTITIES = [
  "OrchestratorRegistry",
  "OrchestratorV3",
  "StakeVault",
  "DisputeProtectionPolicy",
  "WhitelistPolicy",
  "DisputeVerifier",
  "DisputeNullifierRegistry",
  "MultiAttestationVerifier",
] as const;
const TWO_STEP_GOVERNED_RUNTIME_IDENTITIES = [
  "StakeVault",
  "DisputeProtectionPolicy",
  "DisputeVerifier",
] as const;

function isDirectRuntimeName(
  name: RuntimeIdentityName,
): name is (typeof DIRECT_RUNTIME_NAMES)[number] {
  return (DIRECT_RUNTIME_NAMES as readonly string[]).includes(name);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (!sameJson(actual, sortedExpected)) {
    throw new Error(`${label} keys do not match the readiness contract`);
  }
}

function readDeploymentOutput(fileName: string): DeploymentOutput {
  const modulePath = path.join(ROOT, "deployments", "outputs", fileName);
  const loaded = require(modulePath);
  return (loaded.default || loaded) as DeploymentOutput;
}

function readDeployment(network: string, deploymentName: string): DeploymentEntry & { args?: unknown[] } {
  const artifactPath = path.join(ROOT, "deployments", network, `${deploymentName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing readiness deployment evidence ${network}.${deploymentName}`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

function deploymentName(manifestNetwork: string, canonicalName: string): string {
  if (["StakeVault", "DisputeProtectionPolicy", "IntentLifecycleHookV1"].includes(canonicalName)) {
    return getActiveDisputeDeploymentName(manifestNetwork, canonicalName);
  }
  return canonicalName;
}

function validateEvidence(network: (typeof NETWORKS)[number], output: DeploymentOutput): void {
  if (EVIDENCE.schemaVersion !== 1) throw new Error("Unsupported dispute readiness evidence schema");
  requireExactKeys(
    EVIDENCE as unknown as Record<string, unknown>,
    ["schemaVersion", "riskWindowSecondsByPaymentMethod", "sentinel", "prerequisites", "networks"],
    "Readiness evidence",
  );
  requireExactKeys(EVIDENCE.networks, ["base", "base_staging"], "Readiness evidence networks");
  requireExactKeys(
    EVIDENCE.riskWindowSecondsByPaymentMethod,
    ["base", "base_staging"],
    "Readiness evidence risk-window networks",
  );
  const evidence = EVIDENCE.networks[network.manifestName];
  if (!evidence) throw new Error(`Missing dispute readiness evidence for ${network.manifestName}`);
  requireExactKeys(
    evidence as unknown as Record<string, unknown>,
    [
      "governance",
      "attestationTrust",
      "activeDisputeStack",
      "recognizedPredecessorHook",
      "recognizedPredecessorPolicy",
      "addresses",
      "addressExpectations",
      "deploymentEvidence",
      "runtimeCodeHashes",
    ],
    `${network.manifestName} readiness evidence`,
  );
  const expectedSelection = getActiveDisputeSelectionStamp(network.manifestName);
  if (!sameJson(evidence.activeDisputeStack, expectedSelection)) {
    throw new Error(`${network.manifestName} readiness selection evidence mismatch`);
  }
  if (!sameJson(output.activeDisputeStack, expectedSelection)) {
    throw new Error(`${network.manifestName} deployment output selection stamp mismatch`);
  }
  if ([evidence.recognizedPredecessorHook, evidence.recognizedPredecessorPolicy].some(
    (identity) =>
      !ADDRESS_PATTERN.test(identity.address) || !HASH_PATTERN.test(identity.runtimeCodeHash),
  )) {
    throw new Error(`${network.manifestName} predecessor readiness evidence is malformed`);
  }
  if (
    !ADDRESS_PATTERN.test(evidence.governance.owner) ||
    evidence.governance.pendingOwner !== ZERO_ADDRESS ||
    evidence.attestationTrust.requiredSignatures !== "1" ||
    evidence.attestationTrust.witnesses.length === 0 ||
    evidence.attestationTrust.witnesses.some((witness) => !ADDRESS_PATTERN.test(witness)) ||
    new Set(evidence.attestationTrust.witnesses.map((witness) => witness.toLowerCase())).size !==
      evidence.attestationTrust.witnesses.length
  ) {
    throw new Error(`${network.manifestName} governance or attestation trust evidence is malformed`);
  }
  requireExactKeys(
    evidence.addresses,
    RUNTIME_IDENTITY_NAMES.filter(
      (name) => name !== "RecognizedPredecessorHook" && name !== "RecognizedPredecessorPolicy",
    ),
    `${network.manifestName} runtime addresses`,
  );
  requireExactKeys(
    evidence.addressExpectations,
    ADDRESS_EXPECTATION_NAMES,
    `${network.manifestName} address expectations`,
  );
  requireExactKeys(
    evidence.deploymentEvidence,
    RUNTIME_IDENTITY_NAMES,
    `${network.manifestName} deployment evidence`,
  );
  requireExactKeys(
    evidence.runtimeCodeHashes,
    RUNTIME_IDENTITY_NAMES.filter(
      (name) => name !== "RecognizedPredecessorHook" && name !== "RecognizedPredecessorPolicy",
    ),
    `${network.manifestName} runtime evidence`,
  );
  for (const [name, runtimeCodeHash] of Object.entries(evidence.runtimeCodeHashes)) {
    if (!HASH_PATTERN.test(runtimeCodeHash)) {
      throw new Error(`${network.manifestName}.${name} runtime hash is malformed`);
    }
  }
  for (const [name, address] of Object.entries({ ...evidence.addresses, ...evidence.addressExpectations })) {
    if (!ADDRESS_PATTERN.test(address)) {
      throw new Error(`${network.manifestName}.${name} address evidence is malformed`);
    }
  }
  for (const [name, deployment] of Object.entries(evidence.deploymentEvidence)) {
    if (
      typeof deployment.deploymentName !== "string" ||
      !/^[0-9a-f]{32}$/.test(deployment.solcInputHash) ||
      !HASH_PATTERN.test(deployment.deployedBytecodeHash)
    ) {
      throw new Error(`${network.manifestName}.${name} deployment evidence is malformed`);
    }
  }
}

function validateIdentityDeployment(
  network: (typeof NETWORKS)[number],
  canonicalName: RuntimeIdentityName,
  expectedAddress: string,
): DeploymentEntry & { deployedBytecode: string; solcInputHash: string } {
  const evidence = EVIDENCE.networks[network.manifestName].deploymentEvidence[canonicalName];
  if (canonicalName !== "RecognizedPredecessorHook" && canonicalName !== "RecognizedPredecessorPolicy") {
    const selectedDeploymentName = deploymentName(network.manifestName, canonicalName);
    if (evidence.deploymentName !== selectedDeploymentName) {
      throw new Error(`${network.manifestName}.${canonicalName} deployment selection evidence mismatch`);
    }
  }
  const deployment = readDeployment(network.deploymentDirectory, evidence.deploymentName);
  if (!sameAddress(deployment.address, expectedAddress)) {
    throw new Error(`${network.manifestName}.${canonicalName} address does not match deployment evidence`);
  }
  if (deployment.solcInputHash !== evidence.solcInputHash || !deployment.deployedBytecode) {
    throw new Error(`${network.manifestName}.${canonicalName} build evidence mismatch`);
  }
  const deployedBytecodeHash = ethers.utils.keccak256(deployment.deployedBytecode).toLowerCase();
  if (deployedBytecodeHash !== evidence.deployedBytecodeHash) {
    throw new Error(`${network.manifestName}.${canonicalName} deployment bytecode evidence mismatch`);
  }
  return {
    ...deployment,
    deployedBytecode: deployment.deployedBytecode,
    solcInputHash: deployment.solcInputHash,
  };
}

function createRuntimeIdentities(
  network: (typeof NETWORKS)[number],
  outputContracts: Record<string, { address: string }>,
): Record<RuntimeIdentityName, RuntimeIdentity> {
  const evidence = EVIDENCE.networks[network.manifestName];
  const identities = {} as Record<RuntimeIdentityName, RuntimeIdentity>;
  for (const canonicalName of RUNTIME_IDENTITY_NAMES) {
    if (canonicalName === "RecognizedPredecessorHook" || canonicalName === "RecognizedPredecessorPolicy") {
      const predecessor = canonicalName === "RecognizedPredecessorHook"
        ? evidence.recognizedPredecessorHook
        : evidence.recognizedPredecessorPolicy;
      validateIdentityDeployment(network, canonicalName, predecessor.address);
      identities[canonicalName] = predecessor;
      continue;
    }
    const outputEntry = outputContracts[canonicalName];
    if (!outputEntry || !ADDRESS_PATTERN.test(outputEntry.address)) {
      throw new Error(`Missing canonical readiness address ${network.manifestName}.${canonicalName}`);
    }
    if (!sameAddress(outputEntry.address, evidence.addresses[canonicalName])) {
      throw new Error(`${network.manifestName}.${canonicalName} address evidence mismatch`);
    }
    const deployment = validateIdentityDeployment(network, canonicalName, outputEntry.address);
    const expectedRuntimeCodeHash = evidence.runtimeCodeHashes[canonicalName];
    if (isDirectRuntimeName(canonicalName)) {
      const actual = ethers.utils.keccak256(deployment.deployedBytecode).toLowerCase();
      if (actual !== expectedRuntimeCodeHash) {
        throw new Error(`${network.manifestName}.${canonicalName} runtime evidence mismatch`);
      }
    }
    identities[canonicalName] = {
      address: outputEntry.address,
      runtimeCodeHash: expectedRuntimeCodeHash,
    };
  }
  return identities;
}

function createAddressExpectations(
  network: (typeof NETWORKS)[number],
  outputContracts: Record<string, { address: string }>,
): Record<AddressExpectationName, string> {
  const expectations = EVIDENCE.networks[network.manifestName].addressExpectations;
  for (const name of ADDRESS_EXPECTATION_NAMES) {
    const expectedAddress = expectations[name];
    if (name === "StakeToken") {
      if (!sameAddress(expectedAddress, USDC[network.manifestName])) {
        throw new Error(`${network.manifestName}.StakeToken does not match canonical USDC`);
      }
      continue;
    }
    const outputEntry = outputContracts[name];
    if (!outputEntry || !sameAddress(outputEntry.address, expectedAddress)) {
      throw new Error(`${network.manifestName}.${name} address evidence mismatch`);
    }
    const deployment = readDeployment(network.deploymentDirectory, name);
    if (!sameAddress(deployment.address, expectedAddress)) {
      throw new Error(`${network.manifestName}.${name} deployment address evidence mismatch`);
    }
  }
  return expectations;
}

function deploymentBlockNumber(
  network: (typeof NETWORKS)[number],
  canonicalName: RuntimeIdentityName,
): string {
  const evidence = EVIDENCE.networks[network.manifestName].deploymentEvidence[canonicalName];
  const deployment = readDeployment(network.deploymentDirectory, evidence.deploymentName);
  const blockNumber = deployment.receipt?.blockNumber;
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    throw new Error(`${network.manifestName}.${canonicalName} deployment block evidence is malformed`);
  }
  return blockNumber.toString();
}

function configuredRiskWindows(network: string): Record<string, string> {
  const activePaymentMethods = getActivePaymentMethods(network);
  const configured = new Set(DISPUTABLE_PAYMENT_METHODS);
  if (DISPUTABLE_PAYMENT_METHODS.some((method) => !activePaymentMethods.includes(method))) {
    throw new Error("Disputable payment methods must be active");
  }
  const entries = activePaymentMethods.map((method) => [
    ethers.utils.id(method).toLowerCase(),
    configured.has(method) ? DISPUTE_RISK_WINDOW[network].toString() : "0",
  ] as const).sort(([left], [right]) => left.localeCompare(right));
  if (new Set(entries.map(([paymentMethod]) => paymentMethod)).size !== activePaymentMethods.length) {
    throw new Error("Active payment method hashes must be unique");
  }
  return Object.fromEntries(entries);
}

export function buildDisputeReadinessManifest(packageName: "base" | "baseStaging") {
  const network = NETWORKS.find((candidate) => candidate.packageName === packageName);
  if (!network) throw new Error(`Unsupported dispute readiness network ${packageName}`);
  const output = readDeploymentOutput(network.outputFile);
  validateEvidence(network, output);
  const contracts = resolveActiveDisputeAliases(
    network.manifestName,
    output.contracts,
    output.activeDisputeStack,
  ) as Record<string, { address: string }>;
  const runtimeIdentities = createRuntimeIdentities(network, contracts);
  const addressExpectations = createAddressExpectations(network, contracts);
  const configuredWindows = configuredRiskWindows(network.manifestName);
  const evidenceWindows = EVIDENCE.riskWindowSecondsByPaymentMethod[network.manifestName];
  const networkEvidence = EVIDENCE.networks[network.manifestName];
  if (!sameJson(configuredWindows, evidenceWindows)) {
    throw new Error(`${network.manifestName} active payment method risk policy mismatch`);
  }
  if (!sameJson(EVIDENCE.sentinel, { escrow: SENTINEL_ESCROW, depositId: "0", expected: false })) {
    throw new Error("Dispute readiness sentinel evidence mismatch");
  }
  if (
    !sameJson(EVIDENCE.prerequisites, {
      orchestratorPaused: false,
      admissionsPaused: false,
      allowMultipleIntents: true,
      orchestratorRegistered: true,
      lifecycleHookAuthorized: true,
      disputeNullifierWriterAuthorized: true,
      vaultControllerActivated: true,
      vaultPendingController: ZERO_ADDRESS,
      vaultPendingControllerValidAt: "0",
      pendingCoverageMaturity: MAX_UINT64,
    })
  ) {
    throw new Error("Dispute readiness prerequisites evidence mismatch");
  }

  return {
    schemaVersion: 1,
    network: network.manifestName,
    chainId: Number(output.chainId),
    activeDisputeStack: networkEvidence.activeDisputeStack,
    runtimeIdentities,
    addressExpectations,
    expectedRelations: {
      activeLifecycleHook: runtimeIdentities.IntentLifecycleHookV1.address,
      recognizedPredecessorPolicy: runtimeIdentities.RecognizedPredecessorPolicy.address,
      registeredOrchestrator: runtimeIdentities.OrchestratorV3.address,
      authorizedLifecycleHook: runtimeIdentities.IntentLifecycleHookV1.address,
      disputeNullifierAuthorizedWriter: runtimeIdentities.DisputeProtectionPolicy.address,
      orchestratorEscrowRegistry: addressExpectations.EscrowRegistry,
      orchestratorPaymentVerifierRegistry: addressExpectations.PaymentVerifierRegistry,
      orchestratorRelayerRegistry: addressExpectations.RelayerRegistry,
      hookOrchestratorRegistry: runtimeIdentities.OrchestratorRegistry.address,
      hookWhitelistPolicy: runtimeIdentities.WhitelistPolicy.address,
      hookDisputeProtectionPolicy: runtimeIdentities.DisputeProtectionPolicy.address,
      whitelistGroupRegistry: addressExpectations.AddressGroupRegistry,
      whitelistEscrowRegistry: addressExpectations.EscrowRegistry,
      whitelistOrchestratorRegistry: runtimeIdentities.OrchestratorRegistry.address,
      policyStakeVault: runtimeIdentities.StakeVault.address,
      policyDisputeVerifier: runtimeIdentities.DisputeVerifier.address,
      policyDisputeNullifierRegistry: runtimeIdentities.DisputeNullifierRegistry.address,
      disputeVerifierNullifierRegistry: addressExpectations.NullifierRegistryV2,
      disputeVerifierAttestationVerifier: runtimeIdentities.MultiAttestationVerifier.address,
      vaultController: runtimeIdentities.DisputeProtectionPolicy.address,
      vaultStakeToken: addressExpectations.StakeToken,
    },
    expectedGovernance: {
      owner: networkEvidence.governance.owner,
      governedRuntimeIdentities: GOVERNED_RUNTIME_IDENTITIES,
      pendingOwner: networkEvidence.governance.pendingOwner,
      twoStepGovernedRuntimeIdentities: TWO_STEP_GOVERNED_RUNTIME_IDENTITIES,
    },
    attestationTrust: networkEvidence.attestationTrust,
    exactAuthorizationSets: {
      orchestratorAuthorizationFromBlock: deploymentBlockNumber(network, "OrchestratorRegistry"),
      authorizedOrchestrators: [
        runtimeIdentities.Orchestrator.address,
        runtimeIdentities.OrchestratorV2.address,
        runtimeIdentities.OrchestratorV3.address,
      ],
      lifecycleHookAuthorizationFromBlock: deploymentBlockNumber(
        network,
        "DisputeProtectionPolicy",
      ),
      authorizedLifecycleHooks: [runtimeIdentities.IntentLifecycleHookV1.address],
      passiveDisputeNullifierWriters: [runtimeIdentities.RecognizedPredecessorPolicy.address],
      activeDisputeNullifierWriters: [runtimeIdentities.DisputeProtectionPolicy.address],
    },
    riskWindowSecondsByPaymentMethod: evidenceWindows,
    sentinel: EVIDENCE.sentinel,
    prerequisites: EVIDENCE.prerequisites,
  } as const;
}

function ensureDirectory(directory: string): void {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

export async function extractDisputeReadiness(): Promise<void> {
  ensureDirectory(OUTPUT_DIRECTORY);
  for (const network of NETWORKS) {
    const manifest = buildDisputeReadinessManifest(network.packageName);
    fs.writeFileSync(
      path.join(OUTPUT_DIRECTORY, `${network.packageName}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(OUTPUT_DIRECTORY, `${network.packageName}.d.ts`),
      `import type { DisputeProtectionReadinessManifest } from './types';\ndeclare const value: DisputeProtectionReadinessManifest<'${network.manifestName}'>;\nexport default value;\n`,
    );
  }

  const basePaymentMethodHashType = Object.keys(EVIDENCE.riskWindowSecondsByPaymentMethod.base)
    .map((paymentMethodHash) => `'${paymentMethodHash}'`)
    .join(" | ");
  const baseStagingPaymentMethodHashType = Object.keys(
    EVIDENCE.riskWindowSecondsByPaymentMethod.base_staging,
  )
    .map((paymentMethodHash) => `'${paymentMethodHash}'`)
    .join(" | ");
  const riskWindowSecondsType = [...new Set(
    Object.values(EVIDENCE.riskWindowSecondsByPaymentMethod).flatMap((windows) =>
      Object.values(windows),
    ),
  )]
    .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0))
    .map((seconds) => `'${seconds}'`)
    .join(" | ");

  fs.writeFileSync(
    path.join(OUTPUT_DIRECTORY, "types.d.ts"),
    `export type Address = \`0x\${string}\`;
export type RuntimeCodeHash = \`0x\${string}\`;
export type ReadinessNetwork = 'base' | 'base_staging';
export type BasePaymentMethodHash = ${basePaymentMethodHashType};
export type BaseStagingPaymentMethodHash = ${baseStagingPaymentMethodHashType};
export type PaymentMethodHash<Network extends ReadinessNetwork = ReadinessNetwork> = Network extends 'base_staging' ? BaseStagingPaymentMethodHash : BasePaymentMethodHash;
export type RiskWindowSeconds = ${riskWindowSecondsType};
export interface RuntimeIdentity { address: Address; runtimeCodeHash: RuntimeCodeHash; }
export type RuntimeIdentityName = 'Orchestrator' | 'OrchestratorV2' | 'OrchestratorV3' | 'StakeVault' | 'DisputeProtectionPolicy' | 'IntentLifecycleHookV1' | 'RecognizedPredecessorHook' | 'RecognizedPredecessorPolicy' | 'OrchestratorRegistry' | 'WhitelistPolicy' | 'DisputeVerifier' | 'DisputeNullifierRegistry' | 'MultiAttestationVerifier';
export type GovernedRuntimeIdentityName = 'OrchestratorRegistry' | 'OrchestratorV3' | 'StakeVault' | 'DisputeProtectionPolicy' | 'WhitelistPolicy' | 'DisputeVerifier' | 'DisputeNullifierRegistry' | 'MultiAttestationVerifier';
export type TwoStepGovernedRuntimeIdentityName = 'StakeVault' | 'DisputeProtectionPolicy' | 'DisputeVerifier';
export interface DisputeProtectionReadinessManifest<Network extends ReadinessNetwork = ReadinessNetwork> {
  schemaVersion: 1;
  network: Network;
  chainId: 8453;
  activeDisputeStack: { version: 1; selectionHash: string };
  runtimeIdentities: Record<RuntimeIdentityName, RuntimeIdentity>;
  addressExpectations: {
    AddressGroupRegistry: Address;
    EscrowRegistry: Address;
    PaymentVerifierRegistry: Address;
    RelayerRegistry: Address;
    NullifierRegistryV2: Address;
    StakeToken: Address;
  };
  expectedRelations: {
    activeLifecycleHook: Address;
    recognizedPredecessorPolicy: Address;
    registeredOrchestrator: Address;
    authorizedLifecycleHook: Address;
    disputeNullifierAuthorizedWriter: Address;
    orchestratorEscrowRegistry: Address;
    orchestratorPaymentVerifierRegistry: Address;
    orchestratorRelayerRegistry: Address;
    hookOrchestratorRegistry: Address;
    hookWhitelistPolicy: Address;
    hookDisputeProtectionPolicy: Address;
    whitelistGroupRegistry: Address;
    whitelistEscrowRegistry: Address;
    whitelistOrchestratorRegistry: Address;
    policyStakeVault: Address;
    policyDisputeVerifier: Address;
    policyDisputeNullifierRegistry: Address;
    disputeVerifierNullifierRegistry: Address;
    disputeVerifierAttestationVerifier: Address;
    vaultController: Address;
    vaultStakeToken: Address;
  };
  expectedGovernance: {
    owner: Address;
    governedRuntimeIdentities: readonly GovernedRuntimeIdentityName[];
    pendingOwner: '0x0000000000000000000000000000000000000000';
    twoStepGovernedRuntimeIdentities: readonly TwoStepGovernedRuntimeIdentityName[];
  };
  attestationTrust: { requiredSignatures: '1'; witnesses: readonly Address[] };
  exactAuthorizationSets: {
    orchestratorAuthorizationFromBlock: string;
    authorizedOrchestrators: readonly [Address, Address, Address];
    lifecycleHookAuthorizationFromBlock: string;
    authorizedLifecycleHooks: readonly [Address];
    passiveDisputeNullifierWriters: readonly [Address];
    activeDisputeNullifierWriters: readonly [Address];
  };
  riskWindowSecondsByPaymentMethod: Record<PaymentMethodHash<Network>, RiskWindowSeconds>;
  sentinel: { escrow: Address; depositId: '0'; expected: false };
  prerequisites: {
    orchestratorPaused: false;
    admissionsPaused: false;
    allowMultipleIntents: true;
    orchestratorRegistered: true;
    lifecycleHookAuthorized: true;
    disputeNullifierWriterAuthorized: true;
    vaultControllerActivated: true;
    vaultPendingController: '0x0000000000000000000000000000000000000000';
    vaultPendingControllerValidAt: '0';
    pendingCoverageMaturity: '18446744073709551615';
  };
}
`,
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIRECTORY, "index.ts"),
    `// Auto-generated by extract-all.ts
import baseData from './base.json';
import baseStagingData from './baseStaging.json';
import type { DisputeProtectionReadinessManifest } from './types';
export type { Address, DisputeProtectionReadinessManifest, GovernedRuntimeIdentityName, PaymentMethodHash, ReadinessNetwork, RiskWindowSeconds, RuntimeCodeHash, RuntimeIdentity, RuntimeIdentityName, TwoStepGovernedRuntimeIdentityName } from './types';
export { default as base } from './base.json';
export { default as baseStaging } from './baseStaging.json';
export const disputeReadinessByNetwork = {
  base: baseData as DisputeProtectionReadinessManifest<'base'>,
  baseStaging: baseStagingData as DisputeProtectionReadinessManifest<'base_staging'>,
};
`,
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIRECTORY, "index.d.ts"),
    `export type { Address, DisputeProtectionReadinessManifest, GovernedRuntimeIdentityName, PaymentMethodHash, ReadinessNetwork, RiskWindowSeconds, RuntimeCodeHash, RuntimeIdentity, RuntimeIdentityName, TwoStepGovernedRuntimeIdentityName } from './types';\nexport { default as base } from './base';\nexport { default as baseStaging } from './baseStaging';\nexport declare const disputeReadinessByNetwork: { base: import('./types').DisputeProtectionReadinessManifest<'base'>; baseStaging: import('./types').DisputeProtectionReadinessManifest<'base_staging'> };\n`,
  );
  console.log(`✅ Dispute readiness metadata written to ${OUTPUT_DIRECTORY}`);
}
