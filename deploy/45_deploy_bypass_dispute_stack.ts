import { BigNumber, constants, utils } from "ethers";
import type { Contract } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";

import {
  BYPASS_ARTIFACT_NAMES,
  BYPASS_DEPLOYMENT_NAMES,
  BYPASS_EXPECTED_LIVE,
  BYPASS_PREDECESSOR_DEPLOYMENT_NAMES,
  BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS,
  isSupersededStagingRecord,
  LANE_45_STEP_KINDS,
  LANE_45_TAG,
  assertBypassDeploymentRecord,
  classifyLane45Prefix,
  expectedPaymentMethodCurrencies,
  isBypassLiveNetwork,
  paymentMethodHash,
} from "../deployments/bypassDisputeStack";
import type {
  BypassDeploymentName,
  BypassNetwork,
  ContractPin,
} from "../deployments/bypassDisputeStack";
import {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
} from "../deployments/canonicalDeployment";
import { verifySupersededStagingBinding } from "../deployments/bypassPaymentBinding";
import { reduceBypassActivation } from "../deployments/bypassDisputeActivation";
import {
  stalePolicyScan,
  reportOpenStaleBypassIntents,
} from "../deployments/staleBypassIntents";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  ACTIVE_PAYMENT_METHODS,
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  RETIRED_DISPUTABLE_PAYMENT_METHODS,
  USDC,
} from "../deployments/parameters";
import { assertPaymentBindingReady } from "./31_deploy_v3_payment_binding_stack";
import {
  EXPECTED_LIVE,
  type FreshStackEvent,
  assertOrchestratorGovernanceState,
  decodeFreshStackLogs,
  ownershipStepState,
} from "./37_deploy_method_scoped_dispute_lifecycle_stack";

export { reportOpenStaleBypassIntents } from "../deployments/staleBypassIntents";
export { LANE_45_STEP_KINDS, classifyLane45Prefix };
export const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);
export const LIVE_FLAGS: Record<BypassNetwork, string> = {
  base_staging: "ENABLE_STAGING_V3_DISPUTE_BYPASS_STACK_DEPLOYMENT",
  base: "ENABLE_BASE_V3_DISPUTE_BYPASS_STACK_DEPLOYMENT",
};

export const BYPASS_POLICY_GOVERNANCE_EVENTS = [
  "DisputeVerifierUpdated",
  "LifecycleHookAuthorizationUpdated",
  "OwnershipTransferStarted",
  "OwnershipTransferred",
] as const;

export const BYPASS_POLICY_LIFECYCLE_EVENTS = [
  "DisputeProtectionIntentSettled",
  "DisputeProtectionIntentReleased",
  "DisputeResolved",
  "DeferredPayoutClaimed",
] as const;

export function classifyBypassPolicyActivity(
  events: FreshStackEvent[],
  beforeCutover: boolean
): void {
  const lifecycleEvents = events.filter((event) =>
    BYPASS_POLICY_LIFECYCLE_EVENTS.some((name) => name === event.name)
  );
  if (beforeCutover && lifecycleEvents.length > 0) {
    const event = lifecycleEvents[0];
    throw new Error(
      `Fresh DisputeProtectionPolicyV2 has lifecycle activity before cutover: ` +
        `${event.name} in ${event.transactionHash}`
    );
  }
  for (const event of events.filter((event) => !lifecycleEvents.includes(event))) {
    if (!BYPASS_POLICY_GOVERNANCE_EVENTS.some((name) => name === event.name)) {
      throw new Error(
        `DisputeProtectionPolicyV2 emitted an unclassified event: ${event.name} in ${event.transactionHash}`
      );
    }
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameList(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => sameAddress(value, expected[index]))
  );
}

function requireState(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function deploymentBlock(deployment: Deployment): number {
  const block = deployment.receipt?.blockNumber;
  if (typeof block !== "number" || !Number.isSafeInteger(block) || block < 0) {
    throw new Error(
      "DisputeProtectionPolicyV2 lacks deployment block evidence"
    );
  }
  return block;
}

async function assertFreshPolicyUnused(
  hre: HardhatRuntimeEnvironment,
  deployment: Deployment | null
): Promise<void> {
  if (!deployment) return;
  const artifact = await hre.deployments.getExtendedArtifact(
    "DisputeProtectionPolicyV2"
  );
  const logs = await hre.ethers.provider.getLogs({
    address: deployment.address,
    fromBlock: deploymentBlock(deployment),
    toBlock: await hre.ethers.provider.getBlockNumber(),
  });
  classifyBypassPolicyActivity(
    decodeFreshStackLogs(
      new utils.Interface(artifact.abi),
      logs,
      "DisputeProtectionPolicyV2"
    ),
    true
  );
}

async function assertOnlySuccessorHookAuthorization(
  hre: HardhatRuntimeEnvironment,
  policy: Contract,
  deployment: Deployment,
  freshHook: string
): Promise<boolean> {
  const logs = await policy.queryFilter(
    policy.filters.LifecycleHookAuthorizationUpdated(),
    deploymentBlock(deployment),
    await hre.ethers.provider.getBlockNumber()
  );
  const authorization = new Map<string, boolean>();
  for (const log of logs) {
    const hook = log.args?.hook || log.args?.[0];
    const authorized = log.args?.isAuthorized ?? log.args?.[1];
    if (typeof hook !== "string" || typeof authorized !== "boolean") {
      throw new Error("Unable to decode lifecycle-hook authorization history");
    }
    authorization.set(hook.toLowerCase(), authorized);
  }
  const active = [...authorization.entries()]
    .filter(([, authorized]) => authorized)
    .map(([hook]) => hook);
  requireState(
    active.every((hook) => sameAddress(hook, freshHook)),
    "Fresh policy authorized an unexpected lifecycle hook"
  );
  const authorized: boolean = await policy.isLifecycleHookAuthorized(freshHook);
  requireState(
    authorized === (active.length === 1),
    "Fresh lifecycle-hook authorization history mismatch"
  );
  return authorized;
}

async function assertUntransferredOwnership(
  contract: Contract,
  deployer: string,
  label: string
): Promise<void> {
  requireState(
    sameAddress(await contract.owner(), deployer) &&
      sameAddress(await contract.pendingOwner(), constants.AddressZero),
    `${label} ownership advanced before its resumable step`
  );
}

export async function assertLane45PaymentBinding(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork,
  checks = { assertPaymentBindingReady, verifySupersededStagingBinding }
): Promise<void> {
  if (network === "base_staging") {
    await checks.verifySupersededStagingBinding(
      hre,
      BYPASS_EXPECTED_LIVE[network].retiredVerifier
    );
  } else {
    requireState(
      await checks.assertPaymentBindingReady(hre),
      "V3 payment binding artifacts are missing"
    );
  }
}

export async function assertO3PredecessorHook(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<void> {
  const pins = BYPASS_EXPECTED_LIVE[network];
  if (network === "base") {
    const orchestratorV3 = await hre.ethers.getContractAt(
      "OrchestratorV3",
      EXPECTED_LIVE[network].orchestrator
    );
    requireState(
      sameAddress(
        await orchestratorV3.lifecycleHook(),
        pins.predecessorHook.address
      ),
      "OrchestratorV3 lifecycle hook drifted"
    );
  }
}

type VerifierRecordReader = {
  getCode(address: string): Promise<string>;
  assertFreshRecord(record: Deployment): Promise<void>;
};

export async function resolveLane45VerifierRecord(
  deployments: VerifierRecordReader,
  network: string,
  record: Deployment,
  pin: ContractPin
): Promise<"use" | "replace"> {
  if (
    isSupersededStagingRecord(
      network,
      "UnifiedPaymentVerifierV4",
      record.address
    )
  ) {
    requireState(
      sameAddress(record.address, pin.address),
      "Superseded verifier pin address mismatch"
    );
    const code = await deployments.getCode(pin.address);
    requireState(
      code !== "0x" && utils.keccak256(code) === pin.runtimeCodeHash,
      "UnifiedPaymentVerifierV4 runtime bytecode hash mismatch"
    );
    return "replace";
  }
  await deployments.assertFreshRecord(record);
  return "use";
}

export async function deployLane45Verifier(
  hre: HardhatRuntimeEnvironment,
  network: string,
  deployer: string,
  args: unknown[]
): Promise<Deployment> {
  const record = await hre.deployments.getOrNull("UnifiedPaymentVerifierV4");
  if (record) {
    const action = await resolveLane45VerifierRecord(
      {
        getCode: (address) => hre.ethers.provider.getCode(address),
        assertFreshRecord: (existing) =>
          assertBypassDeploymentRecord(
            hre,
            network,
            "UnifiedPaymentVerifierV4",
            existing
          ),
      },
      network,
      record,
      BYPASS_EXPECTED_LIVE.base_staging.retiredVerifier
    );
    requireState(
      action === "replace",
      "UnifiedPaymentVerifierV4 already deployed"
    );
    await hre.deployments.delete("UnifiedPaymentVerifierV4");
  }
  const fresh = await deployFresh(
    hre,
    "UnifiedPaymentVerifierV4",
    deployer,
    args
  );
  requireState(
    !isSupersededStagingRecord(
      network,
      "UnifiedPaymentVerifierV4",
      fresh.address
    ),
    "UnifiedPaymentVerifierV4 reused superseded address"
  );
  return fresh;
}

export async function assertLiveSharedState(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<void> {
  const pins = BYPASS_EXPECTED_LIVE[network];
  const expected = EXPECTED_LIVE[network];
  const [deployer] = await hre.getUnnamedAccounts();
  requireState(
    (await hre.ethers.provider.getNetwork()).chainId === pins.chainId,
    "Bypass deployment chain ID mismatch"
  );
  requireState(
    sameAddress(deployer, pins.deployer),
    "Deployment signer does not match the approved deployer"
  );
  requireState(
    sameAddress(USDC[network], pins.stakeToken),
    "StakeVault token does not match the approved USDC target"
  );
  await assertLane45PaymentBinding(hre, network);
  requireState(
    pins.allowMultipleIntents === expected.allowMultipleIntents,
    "Orchestrator allowMultipleIntents pin mismatch"
  );
  await assertO3PredecessorHook(hre, network);
  const legacyNullifierRegistry = await hre.ethers.getContractAt(
    "NullifierRegistry",
    (
      await hre.deployments.get("NullifierRegistry")
    ).address
  );
  requireState(
    sameAddress(await legacyNullifierRegistry.owner(), pins.governance),
    "Legacy NullifierRegistry owner drifted"
  );
  requireState(
    (await legacyNullifierRegistry.getWriters()).length === 0,
    "Retired legacy nullifier writers remain"
  );

  const records: Array<[string, string, string, string | undefined]> = [
    [
      "OrchestratorRegistry",
      "OrchestratorRegistry",
      expected.orchestratorRegistry,
      expected.orchestratorRegistryCodeHash,
    ],
    [
      "OrchestratorV3",
      "OrchestratorV3",
      expected.orchestrator,
      expected.orchestratorCodeHash,
    ],
    [
      "NullifierRegistryV2",
      "NullifierRegistryV2",
      expected.nullifierRegistryV2,
      expected.nullifierRegistryV2CodeHash,
    ],
    [
      "MultiAttestationVerifier",
      "MultiAttestationVerifier",
      expected.attestationVerifier,
      expected.attestationVerifierCodeHash,
    ],
    ["EscrowV2", "EscrowV2", pins.escrow, undefined],
    [
      "UnifiedPaymentVerifierV3",
      "UnifiedPaymentVerifierV3",
      pins.unifiedPaymentVerifierV3.address,
      pins.unifiedPaymentVerifierV3.runtimeCodeHash,
    ],
    [
      "PaymentVerifierRegistry",
      "PaymentVerifierRegistry",
      pins.paymentVerifierRegistry.address,
      pins.paymentVerifierRegistry.runtimeCodeHash,
    ],
    [
      "DisputeVerifier",
      "DisputeVerifier",
      pins.disputeVerifier.address,
      pins.disputeVerifier.runtimeCodeHash,
    ],
    [
      "DisputeNullifierRegistry",
      "NullifierRegistry",
      pins.disputeNullifierRegistry.address,
      pins.disputeNullifierRegistry.runtimeCodeHash,
    ],
    [
      "WhitelistPolicyMethodScoped",
      "WhitelistPolicy",
      pins.whitelistPolicy.address,
      pins.whitelistPolicy.runtimeCodeHash,
    ],
    [
      BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.vault,
      "StakeVault",
      pins.predecessorVault.address,
      pins.predecessorVault.runtimeCodeHash,
    ],
    [
      BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.policy,
      "DisputeProtectionPolicy",
      pins.predecessorPolicy.address,
      pins.predecessorPolicy.runtimeCodeHash,
    ],
    [
      BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.hook,
      "IntentLifecycleHookV1",
      pins.predecessorHook.address,
      pins.predecessorHook.runtimeCodeHash,
    ],
  ];
  for (const [name, artifact, address, hash] of records) {
    const record = await hre.deployments.get(name);
    requireState(
      sameAddress(record.address, address),
      `${name} deployment address mismatch`
    );
    await assertDeploymentMatchesChain(hre, record, name, artifact);
    const code = await hre.ethers.provider.getCode(address);
    requireState(
      code !== "0x" && (hash === undefined || utils.keccak256(code) === hash),
      `${name} runtime bytecode hash mismatch`
    );
  }
  for (const [name, pin] of [
    ["Retired verifier", pins.retiredVerifier],
    ["Initial O3 hook", pins.initialO3Hook],
  ] as const) {
    const code = await hre.ethers.provider.getCode(pin.address);
    requireState(
      code !== "0x" && utils.keccak256(code) === pin.runtimeCodeHash,
      `${name} runtime bytecode hash mismatch`
    );
  }
  if (network === "base_staging") {
    const stale = BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS;
    for (const [name, pin] of Object.entries(stale)) {
      const code = await hre.ethers.provider.getCode(pin.address);
      requireState(
        code !== "0x" && utils.keccak256(code) === pin.runtimeCodeHash,
        `${name} runtime bytecode hash mismatch`
      );
    }
    const vault = await hre.ethers.getContractAt(
      "StakeVault",
      stale.StakeVaultBypass.address
    );
    const policy = await hre.ethers.getContractAt(
      "DisputeProtectionPolicy",
      stale.DisputeProtectionPolicyBypass.address
    );
    requireState(
      sameAddress(
        await vault.controller(),
        stale.DisputeProtectionPolicyBypass.address
      ),
      "Superseded vault controller drifted"
    );
    requireState(
      await policy.isLifecycleHookAuthorized(
        stale.IntentLifecycleHookV1Bypass.address
      ),
      "Superseded policy hook authorization drifted"
    );
  }
  requireState(
    (await hre.ethers.provider.getCode(pins.stakeToken)) !== "0x",
    "USDC has no runtime bytecode"
  );
  const orchestratorV3 = await hre.ethers.getContractAt(
    "OrchestratorV3",
    expected.orchestrator
  );
  await assertOrchestratorGovernanceState(
    orchestratorV3,
    pins.governance,
    expected
  );
  requireState(
    sameAddress(
      await orchestratorV3.lifecycleHook(),
      pins.initialO3Hook.address
    ),
    "OrchestratorV3 lifecycle hook drifted"
  );
  const orchestratorRegistry = await hre.ethers.getContractAt(
    "OrchestratorRegistry",
    expected.orchestratorRegistry
  );
  requireState(
    await orchestratorRegistry.isOrchestrator(expected.orchestrator),
    "OrchestratorV3 is not registered"
  );

  const disputeRegistry = await hre.ethers.getContractAt(
    "NullifierRegistry",
    pins.disputeNullifierRegistry.address
  );
  requireState(
    sameAddress(await disputeRegistry.owner(), pins.governance) &&
      sameList(await disputeRegistry.getWriters(), pins.retainedDisputeWriters),
    "Predecessor dispute registry owner or writer set drifted"
  );
  const nullifierRegistry = await hre.ethers.getContractAt(
    "NullifierRegistryV2",
    expected.nullifierRegistryV2
  );
  requireState(
    sameAddress(await nullifierRegistry.owner(), pins.governance) &&
      sameList(await nullifierRegistry.getWriters(), [
        pins.retiredVerifier.address,
      ]),
    "NullifierRegistryV2 owner or writer set drifted"
  );
  const registry = await hre.ethers.getContractAt(
    "PaymentVerifierRegistry",
    pins.paymentVerifierRegistry.address
  );
  requireState(
    sameAddress(await registry.owner(), pins.governance),
    "PaymentVerifierRegistry owner drifted"
  );
  requireState(
    sameList(
      await registry.getPaymentMethods(),
      pins.paymentMethods.map(paymentMethodHash)
    ),
    "PaymentVerifierRegistry method order drifted"
  );
  for (const method of pins.paymentMethods) {
    const hash = paymentMethodHash(method);
    requireState(
      sameAddress(
        await registry.getVerifier(hash),
        pins.retiredVerifier.address
      ),
      `Payment verifier route drifted for ${method}`
    );
    requireState(
      sameList(
        await registry.getCurrencies(hash),
        expectedPaymentMethodCurrencies(method).map(paymentMethodHash)
      ),
      `Payment currencies drifted for ${method}`
    );
  }
  const retiredVerifier = await hre.ethers.getContractAt(
    network === "base"
      ? "UnifiedPaymentVerifierV3"
      : "UnifiedPaymentVerifierV4",
    pins.retiredVerifier.address
  );
  requireState(
    sameAddress(await retiredVerifier.owner(), pins.governance),
    "Retired verifier owner drifted"
  );
  const policy = await hre.ethers.getContractAt(
    "DisputeProtectionPolicy",
    pins.predecessorPolicy.address
  );
  requireState(
    sameAddress(await policy.owner(), pins.governance) &&
      sameAddress(await policy.pendingOwner(), constants.AddressZero) &&
      sameAddress(await policy.stakeVault(), pins.predecessorVault.address) &&
      sameAddress(
        await policy.disputeVerifier(),
        pins.disputeVerifier.address
      ) &&
      sameAddress(
        await policy.disputeNullifierRegistry(),
        pins.disputeNullifierRegistry.address
      ) &&
      !(await policy.admissionsPaused()) &&
      (await policy.isLifecycleHookAuthorized(pins.predecessorHook.address)),
    "Predecessor policy configuration drifted"
  );
  for (const method of new Set([
    ...pins.paymentMethods,
    ...RETIRED_DISPUTABLE_PAYMENT_METHODS,
  ])) {
    requireState(
      BigNumber.from(await policy.getRiskWindow(paymentMethodHash(method))).eq(
        pins.predecessorRiskWindows[method] || "0"
      ),
      `Predecessor risk window drifted for ${method}`
    );
  }
  const vault = await hre.ethers.getContractAt(
    "StakeVault",
    pins.predecessorVault.address
  );
  requireState(
    sameAddress(await vault.owner(), pins.governance) &&
      sameAddress(await vault.controller(), pins.predecessorPolicy.address) &&
      sameAddress(await vault.pendingController(), constants.AddressZero) &&
      BigNumber.from(await vault.controllerChangeDelay()).eq(
        pins.predecessorControllerChangeDelay
      ) &&
      sameAddress(await vault.stakeToken(), pins.stakeToken),
    "Predecessor vault configuration drifted"
  );
  const disputeVerifier = await hre.ethers.getContractAt(
    "DisputeVerifier",
    pins.disputeVerifier.address
  );
  requireState(
    sameAddress(await disputeVerifier.owner(), pins.governance) &&
      sameAddress(
        await disputeVerifier.pendingOwner(),
        constants.AddressZero
      ) &&
      sameAddress(
        await disputeVerifier.nullifierRegistry(),
        expected.nullifierRegistryV2
      ) &&
      sameAddress(
        await disputeVerifier.attestationVerifier(),
        expected.attestationVerifier
      ),
    "DisputeVerifier configuration drifted"
  );
  const whitelist = await hre.ethers.getContractAt(
    "WhitelistPolicy",
    pins.whitelistPolicy.address
  );
  const whitelistOwner: string = await whitelist.owner();
  requireState(
    pins.allowedWhitelistPolicyOwners.some((owner) =>
      sameAddress(owner, whitelistOwner)
    ) &&
      sameAddress(
        await whitelist.groupRegistry(),
        expected.addressGroupRegistry
      ) &&
      sameAddress(await whitelist.escrowRegistry(), expected.escrowRegistry) &&
      sameAddress(
        await whitelist.orchestratorRegistry(),
        expected.orchestratorRegistry
      ),
    "WhitelistPolicyMethodScoped configuration drifted"
  );
  const attestationVerifier = await hre.ethers.getContractAt(
    "MultiAttestationVerifier",
    expected.attestationVerifier
  );
  requireState(
    sameAddress(await attestationVerifier.owner(), pins.governance) &&
      BigNumber.from(await attestationVerifier.requiredSignatures()).eq(1) &&
      sameList(
        await attestationVerifier.witnesses(),
        expected.attestationWitnesses
      ),
    "MultiAttestationVerifier configuration drifted"
  );
}

type StackContext = {
  network: string;
  deployer: string;
  governance: string;
  stakeToken: string;
  disputeVerifier: string;
  disputeNullifierRegistry: string;
  orchestratorRegistry: string;
  whitelistPolicy: string;
  nullifierRegistryV2: string;
  attestationVerifier: string;
  paymentMethods: string[];
  transferOwnership: boolean;
  chainId: number;
  escrowRegistry: string;
  paymentVerifierRegistry: string;
  relayerRegistry: string;
  protocolFee: string;
  protocolFeeRecipient: string;
  allowMultipleIntents: boolean;
};

type Lane45State = {
  completed: boolean[];
  deployments: Array<Deployment | null>;
  contracts: {
    vault?: Contract;
    policy?: Contract;
    hook?: Contract;
    verifier?: Contract;
    orchestrator?: Contract;
  };
};

function orchestratorArgs(context: StackContext): unknown[] {
  return [
    context.deployer,
    context.chainId,
    context.escrowRegistry,
    context.paymentVerifierRegistry,
    context.relayerRegistry,
    context.protocolFee,
    context.protocolFeeRecipient,
  ];
}

async function liveContext(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<StackContext> {
  const pins = BYPASS_EXPECTED_LIVE[network];
  const expected = EXPECTED_LIVE[network];
  return {
    network,
    deployer: pins.deployer,
    governance: pins.governance,
    stakeToken: pins.stakeToken,
    disputeVerifier: pins.disputeVerifier.address,
    disputeNullifierRegistry: pins.disputeNullifierRegistry.address,
    orchestratorRegistry: expected.orchestratorRegistry,
    whitelistPolicy: pins.whitelistPolicy.address,
    nullifierRegistryV2: expected.nullifierRegistryV2,
    attestationVerifier: expected.attestationVerifier,
    paymentMethods: pins.paymentMethods.map(paymentMethodHash),
    transferOwnership: network === "base",
    chainId: pins.chainId,
    escrowRegistry: expected.escrowRegistry,
    paymentVerifierRegistry: expected.paymentVerifierRegistry,
    relayerRegistry: expected.relayerRegistry,
    protocolFee: "0",
    protocolFeeRecipient: expected.protocolFeeRecipient,
    allowMultipleIntents: pins.allowMultipleIntents,
  };
}

async function readFreshState(
  hre: HardhatRuntimeEnvironment,
  context: StackContext
): Promise<{
  deployments: Array<Deployment | null>;
  contracts: Lane45State["contracts"];
  completed: Record<string, boolean>;
}> {
  const deployments = await Promise.all(
    BYPASS_DEPLOYMENT_NAMES.map((name) => hre.deployments.getOrNull(name))
  );
  const verifierIndex = BYPASS_DEPLOYMENT_NAMES.indexOf(
    "UnifiedPaymentVerifierV4"
  );
  const existingVerifier = deployments[verifierIndex];
  if (
    existingVerifier &&
    (await resolveLane45VerifierRecord(
      {
        getCode: (address) => hre.ethers.provider.getCode(address),
        assertFreshRecord: (record) =>
          assertBypassDeploymentRecord(
            hre,
            context.network,
            "UnifiedPaymentVerifierV4",
            record
          ),
      },
      context.network,
      existingVerifier,
      BYPASS_EXPECTED_LIVE.base_staging.retiredVerifier
    )) === "replace"
  ) {
    deployments[verifierIndex] = null;
  }
  const firstMissing = deployments.indexOf(null);
  requireState(
    firstMissing < 0 ||
      deployments.slice(firstMissing + 1).every((record) => record === null),
    "Bypass deployment artifacts are not a contiguous prefix"
  );
  for (let index = 0; index < deployments.length; index += 1) {
    const record = deployments[index];
    if (!record) continue;
    const name = BYPASS_DEPLOYMENT_NAMES[index];
    await assertBypassDeploymentRecord(hre, context.network, name, record);
  }
  const [
    vaultRecord,
    policyRecord,
    hookRecord,
    verifierRecord,
    orchestratorRecord,
  ] = deployments;
  await assertFreshPolicyUnused(hre, policyRecord);
  const contracts: Lane45State["contracts"] = {};
  const completed: Record<string, boolean> = {
    "deploy-vault": Boolean(vaultRecord),
    "deploy-policy": Boolean(policyRecord),
    "deploy-hook": Boolean(hookRecord),
    "deploy-verifier": Boolean(verifierRecord),
    "deploy-orchestrator": Boolean(orchestratorRecord),
  };
  if (vaultRecord) {
    const vault = (contracts.vault = await hre.ethers.getContractAt(
      "StakeVault",
      vaultRecord.address
    ));
    requireState(
      sameAddress(await vault.stakeToken(), context.stakeToken) &&
        BigNumber.from(await vault.controllerChangeDelay()).eq(
          BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY
        ),
      "Fresh StakeVaultV2 dependency state drifted"
    );
    const controller: string = await vault.controller();
    requireState(
      sameAddress(controller, constants.AddressZero) ||
        Boolean(policyRecord && sameAddress(controller, policyRecord.address)),
      "Fresh StakeVaultV2 controller drifted"
    );
    const pendingController: string = await vault.pendingController();
    requireState(
      (sameAddress(pendingController, constants.AddressZero) &&
        BigNumber.from(await vault.pendingControllerValidAt()).isZero()) ||
        (sameAddress(controller, constants.AddressZero) &&
          Boolean(
            policyRecord && sameAddress(pendingController, policyRecord.address)
          )),
      "Fresh StakeVaultV2 pending controller drifted"
    );
    completed["initialize-controller"] = Boolean(
      policyRecord && sameAddress(controller, policyRecord.address)
    );
    if (context.transferOwnership) {
      completed["transfer-vault-owner"] = ownershipStepState(
        await vault.owner(),
        await vault.pendingOwner(),
        context.deployer,
        context.governance,
        "StakeVaultV2"
      );
    } else {
      await assertUntransferredOwnership(
        vault,
        context.deployer,
        "StakeVaultV2"
      );
    }
  }
  if (policyRecord) {
    const policy = (contracts.policy = await hre.ethers.getContractAt(
      "DisputeProtectionPolicyV2",
      policyRecord.address
    ));
    requireState(
      sameAddress(await policy.stakeVault(), vaultRecord!.address) &&
        sameAddress(await policy.disputeVerifier(), context.disputeVerifier) &&
        sameAddress(
          await policy.disputeNullifierRegistry(),
          context.disputeNullifierRegistry
        ),
      "Fresh bypass policy dependency state drifted"
    );
    completed["authorize-hook"] = await assertOnlySuccessorHookAuthorization(
      hre,
      policy,
      policyRecord,
      hookRecord?.address || constants.AddressZero
    );
    requireState(
      Boolean(hookRecord) || !completed["authorize-hook"],
      "Fresh policy authorized a hook before deployment"
    );
    if (context.transferOwnership) {
      completed["transfer-policy-owner"] = ownershipStepState(
        await policy.owner(),
        await policy.pendingOwner(),
        context.deployer,
        context.governance,
        "DisputeProtectionPolicyV2"
      );
    } else {
      await assertUntransferredOwnership(
        policy,
        context.deployer,
        "DisputeProtectionPolicyV2"
      );
    }
  }
  if (hookRecord) {
    const hook = (contracts.hook = await hre.ethers.getContractAt(
      "IntentLifecycleHookV2",
      hookRecord.address
    ));
    requireState(
      sameAddress(
        await hook.orchestratorRegistry(),
        context.orchestratorRegistry
      ) &&
        sameAddress(await hook.whitelistPolicy(), context.whitelistPolicy) &&
        sameAddress(
          await hook.disputeProtectionPolicy(),
          policyRecord!.address
        ),
      "Fresh bypass lifecycle hook state drifted"
    );
  }
  if (verifierRecord) {
    const verifier = (contracts.verifier = await hre.ethers.getContractAt(
      "UnifiedPaymentVerifierV4",
      verifierRecord.address
    ));
    requireState(
      sameAddress(
        await verifier.orchestratorRegistry(),
        context.orchestratorRegistry
      ) &&
        sameAddress(
          await verifier.nullifierRegistry(),
          context.nullifierRegistryV2
        ) &&
        sameAddress(
          await verifier.attestationVerifier(),
          context.attestationVerifier
        ),
      "Fresh UnifiedPaymentVerifierV4 dependency state drifted"
    );
    const methods: string[] = await verifier.getPaymentMethods();
    requireState(
      methods.length <= context.paymentMethods.length &&
        sameList(methods, context.paymentMethods.slice(0, methods.length)),
      "Fresh UnifiedPaymentVerifierV4 method prefix drifted"
    );
    context.paymentMethods.forEach((method, index) => {
      completed[`add-verifier-method:${method}`] = index < methods.length;
    });
    const owner: string = await verifier.owner();
    requireState(
      sameAddress(owner, context.deployer) ||
        (context.transferOwnership && sameAddress(owner, context.governance)),
      "Fresh UnifiedPaymentVerifierV4 owner drifted"
    );
    completed["transfer-verifier-owner"] =
      context.transferOwnership && sameAddress(owner, context.governance);
  }
  if (orchestratorRecord) {
    const orchestrator = (contracts.orchestrator =
      await hre.ethers.getContractAt(
        "OrchestratorV4",
        orchestratorRecord.address
      ));
    for (const field of [
      "escrowRegistry",
      "paymentVerifierRegistry",
      "relayerRegistry",
      "protocolFeeRecipient",
    ] as const) {
      requireState(
        sameAddress(await orchestrator[field](), context[field]),
        `Fresh OrchestratorV4 ${field} drifted`
      );
    }
    for (const field of ["chainId", "protocolFee"] as const) {
      requireState(
        BigNumber.from(await orchestrator[field]()).eq(context[field]),
        `Fresh OrchestratorV4 ${field} drifted`
      );
    }
    requireState(
      !(await orchestrator.paused()),
      "Fresh OrchestratorV4 paused state drifted"
    );
    const lifecycleHook = await orchestrator.lifecycleHook();
    requireState(
      sameAddress(lifecycleHook, constants.AddressZero) ||
        sameAddress(lifecycleHook, hookRecord!.address),
      "Fresh OrchestratorV4 lifecycle hook drifted"
    );
    completed["set-orchestrator-hook"] = sameAddress(
      lifecycleHook,
      hookRecord!.address
    );
    const multiple = await orchestrator.allowMultipleIntents();
    requireState(
      !multiple || context.allowMultipleIntents,
      "Fresh OrchestratorV4 allowMultipleIntents drifted"
    );
    completed["set-allow-multiple-intents"] = multiple;
    const owner = await orchestrator.owner();
    requireState(
      sameAddress(owner, context.deployer) ||
        (context.transferOwnership && sameAddress(owner, context.governance)),
      "Fresh OrchestratorV4 owner drifted"
    );
    completed["transfer-orchestrator-owner"] =
      context.transferOwnership && sameAddress(owner, context.governance);
    const registry = await hre.ethers.getContractAt(
      "OrchestratorRegistry",
      context.orchestratorRegistry
    );
    requireState(
      !(await registry.isOrchestrator(orchestrator.address)),
      "OrchestratorV4 registered before lane 46"
    );
  }
  return { completed, deployments, contracts };
}

export async function readLane45State(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<Lane45State> {
  await assertLiveSharedState(hre, network);
  if (network === "base_staging") {
    const block = await hre.ethers.provider.getBlockNumber();
    const { record, readLogs } = await stalePolicyScan(hre, block);
    await reportOpenStaleBypassIntents(readLogs, record, block);
  }
  const state = await readFreshState(hre, await liveContext(hre, network));
  const completed = LANE_45_STEP_KINDS[network].map((step) => {
    if (step.startsWith("add-verifier-method:")) {
      const [kind, method] = step.split(":");
      return state.completed[`${kind}:${paymentMethodHash(method)}`] || false;
    }
    return state.completed[step] || false;
  });
  classifyLane45Prefix(network, completed);
  return { ...state, completed };
}

/** Recover permissionless deposit griefing through a zero-delay handover. */
async function initializeBypassController(
  vault: Contract,
  policy: Contract
): Promise<void> {
  const controller: string = await vault.controller();
  const pendingController: string = await vault.pendingController();
  if (sameAddress(controller, policy.address)) {
    requireState(
      sameAddress(pendingController, constants.AddressZero) &&
        BigNumber.from(await vault.pendingControllerValidAt()).isZero(),
      "Fresh StakeVaultV2 pending controller drifted"
    );
    return;
  }
  requireState(
    sameAddress(controller, constants.AddressZero),
    "Fresh StakeVaultV2 controller drifted"
  );
  if (sameAddress(pendingController, constants.AddressZero)) {
    requireState(
      BigNumber.from(await vault.pendingControllerValidAt()).isZero(),
      "Fresh StakeVaultV2 pending controller drifted"
    );
    if (
      BigNumber.from(await vault.totalStaked()).isZero() &&
      BigNumber.from(await vault.totalClaimable()).isZero()
    ) {
      await (await vault.initializeController(policy.address)).wait();
    } else {
      console.log(
        "StakeVaultV2 liabilities forced the zero-delay handover"
      );
      await (await vault.proposeController(policy.address)).wait();
    }
    return;
  }
  requireState(
    sameAddress(pendingController, policy.address),
    "Fresh StakeVaultV2 pending controller drifted"
  );
  await (await policy.acceptVaultController()).wait();
}

async function deployLiveBypassStack(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<void> {
  requireState(
    process.env[LIVE_FLAGS[network]] === "true",
    `${network} bypass deployment requires ${LIVE_FLAGS[network]}=true`
  );
  const context = await liveContext(hre, network);
  while (true) {
    const state = await readLane45State(hre, network);
    const prefix = classifyLane45Prefix(network, state.completed);
    if (prefix.nextStep === null) {
      await assertFreshPolicyUnused(hre, state.deployments[1]);
      console.log(`=== ${network} bypass dispute stack prepared ===`);
      return;
    }
    const step = LANE_45_STEP_KINDS[network][prefix.nextStep];
    await executeLane45Step(hre, network, context, state, step);
    await waitForDeploymentDelay(hre);
  }
}

export async function executeLane45Step(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork,
  context: StackContext,
  state: Lane45State,
  step: string
): Promise<void> {
  if (step === "deploy-vault") {
    await deployFresh(hre, "StakeVaultV2", context.deployer, [
      context.deployer,
      context.stakeToken,
      constants.AddressZero,
      BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ]);
  } else if (step === "deploy-policy") {
    await deployFresh(hre, "DisputeProtectionPolicyV2", context.deployer, [
      context.deployer,
      state.contracts.vault!.address,
      context.disputeVerifier,
      context.disputeNullifierRegistry,
    ]);
  } else if (step === "initialize-controller") {
    await initializeBypassController(
      state.contracts.vault!,
      state.contracts.policy!
    );
  } else if (step === "deploy-hook") {
    await deployFresh(hre, "IntentLifecycleHookV2", context.deployer, [
      context.orchestratorRegistry,
      context.whitelistPolicy,
      state.contracts.policy!.address,
    ]);
  } else if (step === "authorize-hook") {
    await (
      await state.contracts.policy!.setLifecycleHookAuthorization(
        state.contracts.hook!.address,
        true
      )
    ).wait();
  } else if (step === "deploy-verifier") {
    await deployLane45Verifier(hre, network, context.deployer, [
      context.orchestratorRegistry,
      context.nullifierRegistryV2,
      context.attestationVerifier,
    ]);
  } else if (step.startsWith("add-verifier-method:")) {
    const verifier = state.contracts.verifier!;
    await (
      await verifier.addPaymentMethod(
        paymentMethodHash(step.slice("add-verifier-method:".length))
      )
    ).wait();
  } else if (step === "deploy-orchestrator") {
    await deployFresh(
      hre,
      "OrchestratorV4",
      context.deployer,
      orchestratorArgs(context)
    );
  } else if (step === "set-orchestrator-hook") {
    await (
      await state.contracts.orchestrator!.setLifecycleHook(
        state.contracts.hook!.address
      )
    ).wait();
  } else if (step === "set-allow-multiple-intents") {
    await (
      await state.contracts.orchestrator!.setAllowMultipleIntents(true)
    ).wait();
  } else if (step === "transfer-orchestrator-owner") {
    await (
      await state.contracts.orchestrator!.transferOwnership(context.governance)
    ).wait();
  } else if (step === "transfer-vault-owner") {
    await (
      await state.contracts.vault!.transferOwnership(context.governance)
    ).wait();
  } else if (step === "transfer-policy-owner") {
    await (
      await state.contracts.policy!.transferOwnership(context.governance)
    ).wait();
  } else if (step === "transfer-verifier-owner") {
    await (
      await state.contracts.verifier!.transferOwnership(context.governance)
    ).wait();
  } else {
    throw new Error(`Unknown deploy-only step ${step}`);
  }
}

async function deployFresh(
  hre: HardhatRuntimeEnvironment,
  name: BypassDeploymentName,
  deployer: string,
  args: unknown[]
): Promise<Deployment> {
  const deployment = await hre.deployments.deploy(name, {
    contract: BYPASS_ARTIFACT_NAMES[name],
    from: deployer,
    args,
    log: true,
  });
  requireState(
    Boolean(deployment.newlyDeployed),
    `${name} was not freshly deployed`
  );
  return deployment;
}

async function localContext(
  hre: HardhatRuntimeEnvironment
): Promise<StackContext> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const predecessorVault = await hre.deployments.get(
    BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.vault
  );
  const predecessorPolicy = await hre.deployments.get(
    BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.policy
  );
  await hre.deployments.get(BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.hook);
  const policy = await hre.ethers.getContractAt(
    "DisputeProtectionPolicy",
    predecessorPolicy.address
  );
  requireState(
    sameAddress(await policy.stakeVault(), predecessorVault.address),
    "Local predecessor policy vault mismatch"
  );
  const registry = await hre.ethers.getContractAt(
    "PaymentVerifierRegistry",
    (
      await hre.deployments.get("PaymentVerifierRegistry")
    ).address
  );
  const methods: string[] = await registry.getPaymentMethods();
  requireState(
    new Set(methods.map((method) => method.toLowerCase())).size ===
      methods.length,
    "Local payment method catalog contains duplicates"
  );
  const protectedMethods = DISPUTABLE_PAYMENT_METHODS.map(paymentMethodHash);
  const checkedMethods = new Set([
    ...methods,
    ...ACTIVE_PAYMENT_METHODS.map(paymentMethodHash),
    ...RETIRED_DISPUTABLE_PAYMENT_METHODS.map(paymentMethodHash),
    ...protectedMethods,
  ]);
  for (const method of checkedMethods) {
    const window = BigNumber.from(await policy.getRiskWindow(method));
    const expected = protectedMethods.some((hash) => sameAddress(hash, method))
      ? DISPUTE_RISK_WINDOW[network]
      : constants.Zero;
    requireState(
      window.eq(expected),
      `Local predecessor risk window mismatch for ${method}`
    );
  }
  const orchestratorV3 = await hre.ethers.getContractAt(
    "OrchestratorV3",
    (
      await hre.deployments.get("OrchestratorV3")
    ).address
  );
  const context: StackContext = {
    network,
    deployer,
    governance: deployer,
    stakeToken:
      USDC[network] || (await hre.deployments.get("USDCMock")).address,
    disputeVerifier: (await hre.deployments.get("DisputeVerifier")).address,
    disputeNullifierRegistry: (
      await hre.deployments.get("DisputeNullifierRegistry")
    ).address,
    orchestratorRegistry: (await hre.deployments.get("OrchestratorRegistry"))
      .address,
    whitelistPolicy: (await hre.deployments.get("WhitelistPolicyMethodScoped"))
      .address,
    nullifierRegistryV2: (await hre.deployments.get("NullifierRegistryV2"))
      .address,
    attestationVerifier: (
      (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
      (await hre.deployments.get("SimpleAttestationVerifier"))
    ).address,
    paymentMethods: methods,
    transferOwnership: false,
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    escrowRegistry: await orchestratorV3.escrowRegistry(),
    paymentVerifierRegistry: await orchestratorV3.paymentVerifierRegistry(),
    relayerRegistry: await orchestratorV3.relayerRegistry(),
    protocolFee: (await orchestratorV3.protocolFee()).toString(),
    protocolFeeRecipient: await orchestratorV3.protocolFeeRecipient(),
    allowMultipleIntents: await orchestratorV3.allowMultipleIntents(),
  };
  return context;
}

function localSteps(context: StackContext): string[] {
  return [
    "deploy-vault",
    "deploy-policy",
    "initialize-controller",
    "deploy-hook",
    "authorize-hook",
    "deploy-verifier",
    ...context.paymentMethods.map((method) => `add-verifier-method:${method}`),
    "deploy-orchestrator",
    "set-orchestrator-hook",
    ...(context.allowMultipleIntents ? ["set-allow-multiple-intents"] : []),
  ];
}

async function deployLocalBypassStack(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const context = await localContext(hre);
  const { network, deployer, paymentMethods: methods } = context;
  const deploy = async (
    name: BypassDeploymentName,
    args: unknown[]
  ): Promise<Deployment> => {
    const existing = await hre.deployments.getOrNull(name);
    if (existing) {
      await assertBypassDeploymentRecord(hre, network, name, existing);
      return existing;
    }
    const result = await deployFresh(hre, name, deployer, args);
    await waitForDeploymentDelay(hre);
    await assertCanonicalDeployment(
      hre,
      result,
      name,
      BYPASS_ARTIFACT_NAMES[name]
    );
    return result;
  };
  await readFreshState(hre, context);
  const vaultRecord = await deploy("StakeVaultV2", [
    deployer,
    context.stakeToken,
    constants.AddressZero,
    BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  ]);
  const policyRecord = await deploy("DisputeProtectionPolicyV2", [
    deployer,
    vaultRecord.address,
    context.disputeVerifier,
    context.disputeNullifierRegistry,
  ]);
  let state = await readFreshState(hre, context);
  while (!state.completed["initialize-controller"]) {
    await initializeBypassController(
      state.contracts.vault!,
      state.contracts.policy!
    );
    await waitForDeploymentDelay(hre);
    state = await readFreshState(hre, context);
  }
  const hookRecord = await deploy("IntentLifecycleHookV2", [
    context.orchestratorRegistry,
    context.whitelistPolicy,
    policyRecord.address,
  ]);
  state = await readFreshState(hre, context);
  if (!state.completed["authorize-hook"]) {
    await (
      await state.contracts.policy!.setLifecycleHookAuthorization(
        hookRecord.address,
        true
      )
    ).wait();
    await waitForDeploymentDelay(hre);
  }
  await deploy("UnifiedPaymentVerifierV4", [
    context.orchestratorRegistry,
    context.nullifierRegistryV2,
    context.attestationVerifier,
  ]);
  for (const method of methods) {
    state = await readFreshState(hre, context);
    if (!state.completed[`add-verifier-method:${method}`]) {
      const verifier = state.contracts.verifier!;
      await (await verifier.addPaymentMethod(method)).wait();
      await waitForDeploymentDelay(hre);
    }
  }
  await deploy("OrchestratorV4", orchestratorArgs(context));
  state = await readFreshState(hre, context);
  if (!state.completed["set-orchestrator-hook"]) {
    await (
      await state.contracts.orchestrator!.setLifecycleHook(hookRecord.address)
    ).wait();
    await waitForDeploymentDelay(hre);
  }
  if (
    context.allowMultipleIntents &&
    !state.completed["set-allow-multiple-intents"]
  ) {
    await (
      await state.contracts.orchestrator!.setAllowMultipleIntents(true)
    ).wait();
    await waitForDeploymentDelay(hre);
  }
  state = await readFreshState(hre, context);
  const expectedSteps = localSteps(context);
  requireState(
    expectedSteps.every((step) => state.completed[step]),
    "Local bypass stack preparation verification failed"
  );
}

/** After activation starts, lane 46 verifies the stack and action prefix. */
export async function bypassDisputeStackPrepared(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return false;
  const live = isBypassLiveNetwork(network);
  const records = await Promise.all(
    BYPASS_DEPLOYMENT_NAMES.map((name) => hre.deployments.getOrNull(name))
  );
  if (
    records.every(Boolean) &&
    !isSupersededStagingRecord(
      network,
      "UnifiedPaymentVerifierV4",
      records[3]!.address
    )
  ) {
    const registry = await hre.ethers.getContractAt(
      "NullifierRegistry",
      live
        ? BYPASS_EXPECTED_LIVE[network].disputeNullifierRegistry.address
        : (
            await hre.deployments.get("DisputeNullifierRegistry")
          ).address
    );
    const policy =
      records[
        BYPASS_DEPLOYMENT_NAMES.indexOf("DisputeProtectionPolicyV2")
      ]!;
    const orchestratorV3 = await hre.ethers.getContractAt(
      "OrchestratorV3",
      live
        ? EXPECTED_LIVE[network].orchestrator
        : (
            await hre.deployments.get("OrchestratorV3")
          ).address
    );
    const activationStarted =
      network === "base_staging"
        ? !sameAddress(
            await orchestratorV3.lifecycleHook(),
            BYPASS_EXPECTED_LIVE[network].initialO3Hook.address
          )
        : await registry.isWriter(policy.address);
    if (activationStarted) {
      // Lazy loading avoids a load-time dependency on lane 46 for lane 45.
      const lane46: typeof import("./46_activate_bypass_dispute_stack") = require("./46_activate_bypass_dispute_stack");
      await lane46.loadBypassActivationContext(
        hre,
        network as "base" | "base_staging" | "hardhat" | "localhost"
      );
      const block = await hre.ethers.provider.getBlockNumber();
      const snapshot = live
        ? await lane46.assertBypassActivationSharedState(hre, network, block)
        : await lane46.readBypassActivationSnapshot(
            hre,
            network as "hardhat" | "localhost",
            block
          );
      const { phase } = reduceBypassActivation(
        snapshot,
        lane46.expectedBypassActivationState(
          network as "base" | "base_staging" | "hardhat" | "localhost"
        )
      );
      console.log(
        `=== ${network} bypass dispute stack prepared; lane 46 activation is ${phase} ===`
      );
      return true;
    }
  }
  if (!live) {
    const context = await localContext(hre);
    const state = await readFreshState(hre, context);
    return localSteps(context).every((step) => state.completed[step]);
  }
  const state = await readLane45State(hre, network);
  return classifyLane45Prefix(network, state.completed).nextStep === null;
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return;
  if (isBypassLiveNetwork(network)) {
    requireState(
      process.env[LIVE_FLAGS[network]] === "true",
      `${network} bypass deployment requires ${LIVE_FLAGS[network]}=true`
    );
    await deployLiveBypassStack(hre, network);
    return;
  }
  await deployLocalBypassStack(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (!isBypassLiveNetwork(network)) return false;
  if (process.env.DEPLOY_ACTIVE_TAG !== LANE_45_TAG) return true;
  const records = await Promise.all(
    BYPASS_DEPLOYMENT_NAMES.map((name) => hre.deployments.getOrNull(name))
  );
  if (!records.some(Boolean) && process.env[LIVE_FLAGS[network]] !== "true") {
    throw new Error(
      `${network} bypass deployment requires ${LIVE_FLAGS[network]}=true; set the flag and retry`
    );
  }
  return bypassDisputeStackPrepared(hre);
};

func.tags = [LANE_45_TAG, "V3DisputeBypassStack"];
func.dependencies = [];
export default func;
