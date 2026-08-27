import { spawnSync } from "child_process";
import { resolve } from "path";
import type { BigNumber, Contract, providers, utils } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";

import type {
  ActivationBatchKind,
  ActivationBatchManifest,
  ContractIdentity,
} from "../deployments/activationBatchManifest";
import {
  ACTIVATION_BATCH_PATHS,
  computeManifestSha256,
  safeBatchJson,
  validateActivationBatchManifest,
} from "../deployments/activationBatchManifest";
import { assertDeploymentMatchesChain } from "../deployments/canonicalDeployment";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  type ActivationAddresses,
  type ActivationNetwork,
  type ActivationReduction,
  type ActivationSnapshot,
  type ConfigEvent,
  type ExpectedActivationState,
  type IntentLockState,
  type StagingAction,
  buildDepositorInventory,
  buildCutoverTransactions,
  buildRotationTransactions,
  buildStagingTransaction,
  buildTrustSurface,
  classifyIntentLock,
  assertGuardExpectationsUnchanged,
  proveNoLivePredecessorLocks,
  reduceActivation,
} from "../deployments/methodScopedActivation";
import { installSafeArtifactPair } from "../deployments/safeArtifacts";
import { canonicalTransactionHash } from "../deployments/safeBatchManifest";
import {
  METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS,
  assertHistoricalDisputeStack,
} from "../deployments/predecessorDisputeStack";
import {
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  MULTI_SIG,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
} from "../deployments/parameters";
import type { NormalizedSafeBatchTransaction } from "../deployments/safeBatchManifest";
import { paymentBindingCutoverReady } from "./31_deploy_v3_payment_binding_stack";
import { METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME } from "./36_deploy_method_scoped_whitelist_policy";
import {
  ARTIFACT_NAMES as SUCCESSOR_ARTIFACT_NAMES,
  EXPECTED_LIVE,
  FORBIDDEN_POLICY_LIFECYCLE_EVENTS,
  type FreshStackEvent,
  classifyFreshStackActivity,
  decodeFreshStackLogs,
  getRiskWindowPaymentMethods,
} from "./37_deploy_method_scoped_dispute_lifecycle_stack";
import { BASE_SAFE } from "../scripts/simulate-dispute-opt-in-safe-batch";
import {
  assertActivationArtifactGitState,
  verifyActivationCandidate,
} from "../scripts/verify-method-scoped-safe-batch";

export const SUPPORTED_NETWORKS = new Set(["base_staging", "base"]);
export const TAG = "38_activate_method_scoped_dispute_lifecycle_stack";

export const FLAGS = {
  stagingPrepare: "PREPARE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION",
  stagingExecute: "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION",
  baseRotationPrepare:
    "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_ROTATION_PREPARATION",
  baseCutoverPrepare:
    "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_CUTOVER_PREPARATION",
  baseReleaseMatured: "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_RELEASE_MATURED",
  confirmActivation: (network: ActivationNetwork): string =>
    `CONFIRM_${
      network === "base" ? "BASE" : "STAGING"
    }_V3_DISPUTE_METHOD_SCOPED_ACTIVATION`,
  confirmDownstreamReady: (network: ActivationNetwork): string =>
    `CONFIRM_${
      network === "base" ? "BASE" : "STAGING"
    }_V3_DISPUTE_METHOD_SCOPED_DOWNSTREAM_READY`,
  releaseReadySha: "CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_RELEASE_READY_SHA",
} as const;

type ActivationContext = {
  expected: ExpectedActivationState;
  records: {
    escrow: Deployment;
    whitelistPolicy: Deployment;
    freshPolicy: Deployment;
    freshHook: Deployment;
    predecessorPolicy: Deployment;
  };
};

const expectedCache = new Map<ActivationNetwork, ExpectedActivationState>();
const PAGE_SIZE = 10_000;
const DEFAULT_READ_CONCURRENCY = 16;
const MAX_READ_CONCURRENCY = 64;
const DEFAULT_BLOCK_LAG_ATTEMPTS = 15;
const DEFAULT_BLOCK_LAG_DELAY_MS = 2_000;
const BLOCK_LAG_ERROR =
  /unknown block|header not found|block not found|missing trie node/i;

function blockLagSetting(
  name: "METHOD_SCOPED_BLOCK_LAG_RETRIES" | "METHOD_SCOPED_BLOCK_LAG_DELAY_MS",
  fallback: number,
  allowZero: boolean
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (!allowZero && value === 0)) {
    throw new Error(
      `${name} must be ${
        allowZero ? "a non-negative" : "a positive"
      } safe integer`
    );
  }
  return value;
}

export async function withBlockLagRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retryResult: (result: T) => boolean = () => false
): Promise<T> {
  const attempts = blockLagSetting(
    "METHOD_SCOPED_BLOCK_LAG_RETRIES",
    DEFAULT_BLOCK_LAG_ATTEMPTS,
    false
  );
  const delayMs = blockLagSetting(
    "METHOD_SCOPED_BLOCK_LAG_DELAY_MS",
    DEFAULT_BLOCK_LAG_DELAY_MS,
    true
  );
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fn();
      if (!retryResult(result) || attempt === attempts) return result;
      console.log(
        `Retrying ${label} after block lag (${attempt}/${attempts}): empty result`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!BLOCK_LAG_ERROR.test(message) || attempt === attempts) throw error;
      console.log(
        `Retrying ${label} after block lag (${attempt}/${attempts}): ${message}`
      );
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("Block lag retry attempts exhausted");
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_READ_CONCURRENCY
  ) {
    throw new Error(
      `Concurrency limit must be an integer from 1 to ${MAX_READ_CONCURRENCY}`
    );
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function readConcurrency(): number {
  const raw = process.env.METHOD_SCOPED_READ_CONCURRENCY;
  if (raw === undefined) return DEFAULT_READ_CONCURRENCY;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      `METHOD_SCOPED_READ_CONCURRENCY must be an integer from 1 to ${MAX_READ_CONCURRENCY}`
    );
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > MAX_READ_CONCURRENCY) {
    throw new Error(
      `METHOD_SCOPED_READ_CONCURRENCY must be an integer from 1 to ${MAX_READ_CONCURRENCY}`
    );
  }
  return limit;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function normalizedAddress(value: string): string {
  return value.toLowerCase();
}

function normalizedHash(value: string): string {
  return value.toLowerCase();
}

function decimal(value: { toString(): string } | string | number): string {
  return value.toString();
}

function deploymentBlock(deployment: Deployment, label: string): number {
  const blockNumber = deployment.receipt?.blockNumber;
  if (!Number.isSafeInteger(blockNumber)) {
    throw new Error(`${label} lacks deployment block evidence`);
  }
  return blockNumber as number;
}

function isLiveNetwork(network: string): network is ActivationNetwork {
  return network === "base" || network === "base_staging";
}

async function getRequiredDeployment(
  hre: HardhatRuntimeEnvironment,
  name: string
): Promise<Deployment> {
  const deployment = await hre.deployments.getOrNull(name);
  if (!deployment) throw new Error(`${name} deployment record missing`);
  return deployment;
}

async function resolveActivationContext(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork
): Promise<ActivationContext> {
  const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network];
  const predecessorPolicyName =
    predecessor.contracts.DisputeProtectionPolicy.deploymentName ||
    "DisputeProtectionPolicy";
  const [deployer] = await hre.getUnnamedAccounts();
  const [escrow, whitelistPolicy, freshPolicy, freshHook, predecessorPolicy] =
    await Promise.all([
      getRequiredDeployment(hre, "EscrowV2"),
      getRequiredDeployment(
        hre,
        METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME
      ),
      getRequiredDeployment(hre, "DisputeProtectionPolicyMethodScoped"),
      getRequiredDeployment(hre, "IntentLifecycleHookV1MethodScoped"),
      getRequiredDeployment(hre, predecessorPolicyName),
    ]);
  if (
    !sameAddress(
      predecessorPolicy.address,
      predecessor.contracts.DisputeProtectionPolicy.address
    )
  ) {
    throw new Error("Predecessor policy deployment record address mismatch");
  }
  const live = EXPECTED_LIVE[network];
  const governance = MULTI_SIG[network] || deployer;
  const addresses: ActivationAddresses = {
    safe: normalizedAddress(governance),
    deployer: normalizedAddress(deployer),
    escrow: normalizedAddress(escrow.address),
    vault: normalizedAddress(predecessor.contracts.StakeVault.address),
    predecessorPolicy: normalizedAddress(predecessorPolicy.address),
    freshPolicy: normalizedAddress(freshPolicy.address),
    predecessorHook: normalizedAddress(predecessor.activeLifecycleHook.address),
    freshHook: normalizedAddress(freshHook.address),
    registry: normalizedAddress(
      predecessor.contracts.DisputeNullifierRegistry.address
    ),
    orchestrator: normalizedAddress(live.orchestrator),
    orchestratorRegistry: normalizedAddress(live.orchestratorRegistry),
    escrowRegistry: normalizedAddress(live.escrowRegistry),
    paymentVerifierRegistry: normalizedAddress(live.paymentVerifierRegistry),
    relayerRegistry: normalizedAddress(live.relayerRegistry),
    protocolFeeRecipient: normalizedAddress(live.protocolFeeRecipient),
    whitelistPolicy: normalizedAddress(whitelistPolicy.address),
    groupRegistry: normalizedAddress(live.addressGroupRegistry),
    attestationVerifier: normalizedAddress(live.attestationVerifier),
    disputeVerifier: normalizedAddress(
      predecessor.contracts.DisputeVerifier.address
    ),
    nullifierRegistryV2: normalizedAddress(live.nullifierRegistryV2),
    stakeToken: normalizedAddress(live.stakeToken),
  };
  const disputable = new Set(DISPUTABLE_PAYMENT_METHODS);
  const riskWindows = Object.fromEntries(
    getRiskWindowPaymentMethods(network).map((method) => {
      const methodHash = normalizedHash(
        hre.ethers.utils.keccak256(hre.ethers.utils.toUtf8Bytes(method))
      );
      return [
        methodHash,
        disputable.has(method) ? decimal(DISPUTE_RISK_WINDOW[network]) : "0",
      ];
    })
  );
  const expected: ExpectedActivationState = {
    network,
    governance: normalizedAddress(governance),
    deployer: normalizedAddress(deployer),
    addresses,
    riskWindows,
    witnesses: live.attestationWitnesses.map(normalizedAddress),
    controllerChangeDelay: decimal(STAKE_VAULT_CONTROLLER_CHANGE_DELAY),
    allowMultipleIntents: live.allowMultipleIntents,
  };
  expectedCache.set(network, expected);
  return {
    expected,
    records: {
      escrow,
      whitelistPolicy,
      freshPolicy,
      freshHook,
      predecessorPolicy,
    },
  };
}

export function expectedActivationState(
  network: ActivationNetwork
): ExpectedActivationState {
  const expected = expectedCache.get(network);
  if (!expected) {
    throw new Error(
      `Activation deployment records for ${network} have not been loaded`
    );
  }
  return expected;
}

async function contractAt(
  hre: HardhatRuntimeEnvironment,
  artifactOrAbi: string | unknown[],
  address: string
): Promise<Contract> {
  return hre.ethers.getContractAt(artifactOrAbi, address);
}

function taggedRead(
  contract: Contract,
  method: string,
  args: unknown[],
  blockTag: string | number
): ReturnType<Contract["functions"][string]> {
  return contract[method](...args, { blockTag });
}

async function pagedLogs(
  provider: providers.Provider,
  filter: Omit<providers.Filter, "fromBlock" | "toBlock">,
  fromBlock: number,
  toBlock: number
): Promise<providers.Log[]> {
  const logs: providers.Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += PAGE_SIZE) {
    const end = Math.min(toBlock, start + PAGE_SIZE - 1);
    logs.push(
      ...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }))
    );
  }
  return logs;
}

async function assertRuntimeHashAt(
  hre: HardhatRuntimeEnvironment,
  address: string,
  expectedHash: string,
  label: string,
  blockTag: string | number
): Promise<void> {
  const code = await hre.ethers.provider.getCode(address, blockTag);
  if (
    code === "0x" ||
    normalizedHash(hre.ethers.utils.keccak256(code)) !==
      normalizedHash(expectedHash)
  ) {
    throw new Error(`${label} runtime bytecode hash mismatch`);
  }
}

function parseConfigEvents(
  contractInterface: utils.Interface,
  logs: providers.Log[],
  paymentMethodScoped: boolean
): ConfigEvent[] {
  return logs.map((log) => {
    const parsed = contractInterface.parseLog(log);
    return {
      escrow: normalizedAddress(parsed.args.escrow),
      depositId: decimal(parsed.args.depositId),
      paymentMethod: paymentMethodScoped
        ? normalizedHash(parsed.args.paymentMethod)
        : null,
      enabled: Boolean(parsed.args.isDisputeProtectionEnabled),
      blockNumber: log.blockNumber,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
    };
  });
}

async function enumeratePredecessorIntents(
  hre: HardhatRuntimeEnvironment,
  context: ActivationContext,
  blockNumber: number,
  blockTimestamp: string,
  blockTag: string | number
) {
  const { predecessorPolicy } = context.records;
  const contractInterface = new hre.ethers.utils.Interface(
    predecessorPolicy.abi || []
  );
  const event = contractInterface.getEvent("DisputeProtectionIntentOpened");
  const fromBlock = deploymentBlock(
    predecessorPolicy,
    "Predecessor DisputeProtectionPolicy"
  );
  const logs = await pagedLogs(
    hre.ethers.provider,
    {
      address: predecessorPolicy.address,
      topics: [contractInterface.getEventTopic(event)],
    },
    fromBlock,
    blockNumber
  );
  const intentHashes = [
    ...new Set(logs.map((log) => normalizedHash(log.topics[1]))),
  ];
  const policy = await contractAt(
    hre,
    predecessorPolicy.abi || [],
    predecessorPolicy.address
  );
  const vault = await contractAt(
    hre,
    "StakeVault",
    context.expected.addresses.vault
  );
  const concurrency = readConcurrency();
  const intents = await mapWithConcurrency(
    intentHashes,
    concurrency,
    async (intentHash): Promise<IntentLockState> => {
      const [intent, lock] = await Promise.all([
        taggedRead(
          policy,
          "getDisputeProtectionIntent",
          [intentHash],
          blockTag
        ),
        taggedRead(vault, "locks", [intentHash], blockTag),
      ]);
      const status = Number(
        intent.status ?? intent[4]
      ) as IntentLockState["status"];
      const lockAmount = decimal(lock.amount ?? lock[1]);
      const maturesAt = decimal(lock.maturesAt ?? lock[2]);
      return {
        intentHash,
        status,
        lockAmount,
        maturesAt,
        classification: classifyIntentLock(
          status,
          lockAmount,
          maturesAt,
          blockTimestamp
        ),
      };
    }
  );
  return proveNoLivePredecessorLocks(intents, fromBlock, blockNumber);
}

async function readFreshPolicyAuthorizedHooks(
  hre: HardhatRuntimeEnvironment,
  context: ActivationContext,
  blockNumber: number
): Promise<string[]> {
  const artifact = await hre.deployments.getExtendedArtifact(
    "DisputeProtectionPolicy"
  );
  const contractInterface = new hre.ethers.utils.Interface(artifact.abi);
  const event = contractInterface.getEvent("LifecycleHookAuthorizationUpdated");
  const logs = await pagedLogs(
    hre.ethers.provider,
    {
      address: context.records.freshPolicy.address,
      topics: [contractInterface.getEventTopic(event)],
    },
    deploymentBlock(
      context.records.freshPolicy,
      "DisputeProtectionPolicyMethodScoped"
    ),
    blockNumber
  );
  const authorization = new Map<string, boolean>();
  for (const log of logs) {
    const parsed = contractInterface.parseLog(log);
    authorization.set(
      normalizedAddress(parsed.args.hook),
      Boolean(parsed.args.isAuthorized)
    );
  }
  return [...authorization.entries()]
    .filter(([, authorized]) => authorized)
    .map(([hook]) => hook);
}

async function readInventoryInputs(
  hre: HardhatRuntimeEnvironment,
  context: ActivationContext,
  blockNumber: number,
  blockTag: string | number,
  successorRiskWindows: Record<string, string>
) {
  const { addresses } = context.expected;
  const escrow = await contractAt(hre, "EscrowV2", addresses.escrow);
  const successor = await contractAt(
    hre,
    "DisputeProtectionPolicy",
    addresses.freshPolicy
  );
  const depositCounterValue = hre.ethers.BigNumber.from(
    await taggedRead(escrow, "depositCounter", [], blockTag)
  );
  const depositCounter = decimal(depositCounterValue);
  const depositIds = [];
  for (
    let depositId = hre.ethers.BigNumber.from(0);
    depositId.lt(depositCounterValue);
    depositId = depositId.add(1)
  ) {
    depositIds.push(depositId);
  }
  const concurrency = readConcurrency();
  const deposits = await mapWithConcurrency(
    depositIds,
    concurrency,
    async (depositId) => {
      const [deposit, listedPaymentMethods] = await Promise.all([
        taggedRead(escrow, "getDeposit", [depositId], blockTag),
        taggedRead(escrow, "getDepositPaymentMethods", [depositId], blockTag),
      ]);
      return {
        depositId: depositId.toString(),
        depositor: normalizedAddress(deposit.depositor ?? deposit[0]),
        token: normalizedAddress((deposit.token ?? deposit[2]).toString()),
        listedPaymentMethods: (listedPaymentMethods as string[]).map(
          normalizedHash
        ),
      };
    }
  );
  const enabledByTuple = new Map<string, boolean>();
  const successorTuples = deposits.flatMap((deposit) =>
    deposit.listedPaymentMethods
      .filter((method) => (successorRiskWindows[method] ?? "0") !== "0")
      .map((method) => ({ depositId: deposit.depositId, method }))
  );
  const successorEnabled = await mapWithConcurrency(
    successorTuples,
    concurrency,
    async ({ depositId, method }) => {
      const enabled = await taggedRead(
        successor,
        "isDisputeProtectionEnabled",
        [addresses.escrow, depositId, method],
        blockTag
      );
      return Boolean(enabled);
    }
  );
  for (let index = 0; index < successorTuples.length; index += 1) {
    const { depositId, method } = successorTuples[index];
    enabledByTuple.set(`${depositId}:${method}`, successorEnabled[index]);
  }

  const predecessorInterface = new hre.ethers.utils.Interface(
    context.records.predecessorPolicy.abi || []
  );
  const successorArtifact = await hre.deployments.getExtendedArtifact(
    "DisputeProtectionPolicy"
  );
  const successorInterface = new hre.ethers.utils.Interface(
    successorArtifact.abi
  );
  const predecessorEvent = predecessorInterface.getEvent(
    "DisputeProtectionEnabledUpdated"
  );
  const successorEvent = successorInterface.getEvent(
    "DisputeProtectionEnabledUpdated"
  );
  const escrowTopic = hre.ethers.utils.hexZeroPad(addresses.escrow, 32);
  const [predecessorLogs, successorLogs] = await Promise.all([
    pagedLogs(
      hre.ethers.provider,
      {
        address: context.records.predecessorPolicy.address,
        topics: [
          predecessorInterface.getEventTopic(predecessorEvent),
          escrowTopic,
        ],
      },
      deploymentBlock(
        context.records.predecessorPolicy,
        "Predecessor DisputeProtectionPolicy"
      ),
      blockNumber
    ),
    pagedLogs(
      hre.ethers.provider,
      {
        address: context.records.freshPolicy.address,
        topics: [successorInterface.getEventTopic(successorEvent), escrowTopic],
      },
      deploymentBlock(
        context.records.freshPolicy,
        "DisputeProtectionPolicyMethodScoped"
      ),
      blockNumber
    ),
  ]);
  return buildDepositorInventory({
    escrow: addresses.escrow,
    depositCounter,
    stakeToken: addresses.stakeToken,
    block: blockNumber,
    deposits,
    successorRiskWindows,
    predecessorEvents: parseConfigEvents(
      predecessorInterface,
      predecessorLogs,
      false
    ),
    successorEvents: parseConfigEvents(successorInterface, successorLogs, true),
    successorEnabled: (depositId, paymentMethod) =>
      enabledByTuple.get(`${depositId}:${paymentMethod.toLowerCase()}`) ??
      false,
  });
}

export async function readActivationSnapshot(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork,
  blockTag: string | number
): Promise<ActivationSnapshot> {
  const startedAt = Date.now();
  const context = await resolveActivationContext(hre, network);
  const block = await hre.ethers.provider.getBlock(blockTag);
  if (!block) throw new Error(`Activation block ${blockTag} is unavailable`);
  const blockNumber = block.number;
  const blockTimestamp = decimal(block.timestamp);
  const { addresses } = context.expected;
  const [
    freshPolicy,
    predecessorPolicy,
    disputeVerifier,
    vault,
    registry,
    orchestrator,
    orchestratorRegistry,
    freshHook,
    whitelistPolicy,
    attestationVerifier,
  ] = await Promise.all([
    contractAt(hre, "DisputeProtectionPolicy", addresses.freshPolicy),
    contractAt(
      hre,
      context.records.predecessorPolicy.abi || [],
      addresses.predecessorPolicy
    ),
    contractAt(hre, "DisputeVerifier", addresses.disputeVerifier),
    contractAt(hre, "StakeVault", addresses.vault),
    contractAt(hre, "NullifierRegistry", addresses.registry),
    contractAt(hre, "OrchestratorV3", addresses.orchestrator),
    contractAt(hre, "OrchestratorRegistry", addresses.orchestratorRegistry),
    contractAt(hre, "IntentLifecycleHookV1", addresses.freshHook),
    contractAt(hre, "WhitelistPolicy", addresses.whitelistPolicy),
    contractAt(hre, "MultiAttestationVerifier", addresses.attestationVerifier),
  ]);
  const read = (contract: Contract, method: string, args: unknown[] = []) =>
    taggedRead(contract, method, args, blockTag);
  const riskWindows: Record<string, string> = {};
  for (const method of Object.keys(context.expected.riskWindows)) {
    riskWindows[method] = decimal(
      await read(freshPolicy, "getRiskWindow", [method])
    );
  }
  const [authorizedHooks, lockProof] = await Promise.all([
    readFreshPolicyAuthorizedHooks(hre, context, blockNumber),
    enumeratePredecessorIntents(
      hre,
      context,
      blockNumber,
      blockTimestamp,
      blockTag
    ),
  ]);
  const inventory = await readInventoryInputs(
    hre,
    context,
    blockNumber,
    blockTag,
    riskWindows
  );
  const [
    freshOwner,
    freshPendingOwner,
    freshPaused,
    freshVerifier,
    freshRegistry,
    freshVault,
    predecessorOwner,
    predecessorPendingOwner,
    predecessorPaused,
    predecessorVerifier,
    predecessorRegistry,
    verifierOwner,
    verifierPendingOwner,
    verifierAttestation,
    verifierNullifier,
    vaultOwner,
    vaultPendingOwner,
    vaultController,
    vaultPendingController,
    vaultPendingControllerValidAt,
    controllerChangeDelay,
    stakeToken,
    registryOwner,
    writers,
    orchestratorOwner,
    orchestratorPaused,
    lifecycleHook,
    escrowRegistry,
    paymentVerifierRegistry,
    relayerRegistry,
    protocolFee,
    protocolFeeRecipient,
    allowMultipleIntents,
    registered,
    hookOrchestratorRegistry,
    hookWhitelistPolicy,
    hookDisputePolicy,
    whitelistOwner,
    whitelistEscrowRegistry,
    whitelistGroupRegistry,
    whitelistOrchestratorRegistry,
    attestationOwner,
    requiredSignatures,
    witnesses,
  ] = await Promise.all([
    read(freshPolicy, "owner"),
    read(freshPolicy, "pendingOwner"),
    read(freshPolicy, "admissionsPaused"),
    read(freshPolicy, "disputeVerifier"),
    read(freshPolicy, "disputeNullifierRegistry"),
    read(freshPolicy, "stakeVault"),
    read(predecessorPolicy, "owner"),
    read(predecessorPolicy, "pendingOwner"),
    read(predecessorPolicy, "admissionsPaused"),
    read(predecessorPolicy, "disputeVerifier"),
    read(predecessorPolicy, "disputeNullifierRegistry"),
    read(disputeVerifier, "owner"),
    read(disputeVerifier, "pendingOwner"),
    read(disputeVerifier, "attestationVerifier"),
    read(disputeVerifier, "nullifierRegistry"),
    read(vault, "owner"),
    read(vault, "pendingOwner"),
    read(vault, "controller"),
    read(vault, "pendingController"),
    read(vault, "pendingControllerValidAt"),
    read(vault, "controllerChangeDelay"),
    read(vault, "stakeToken"),
    read(registry, "owner"),
    read(registry, "getWriters"),
    read(orchestrator, "owner"),
    read(orchestrator, "paused"),
    read(orchestrator, "lifecycleHook"),
    read(orchestrator, "escrowRegistry"),
    read(orchestrator, "paymentVerifierRegistry"),
    read(orchestrator, "relayerRegistry"),
    read(orchestrator, "protocolFee"),
    read(orchestrator, "protocolFeeRecipient"),
    read(orchestrator, "allowMultipleIntents"),
    read(orchestratorRegistry, "isOrchestrator", [addresses.orchestrator]),
    read(freshHook, "orchestratorRegistry"),
    read(freshHook, "whitelistPolicy"),
    read(freshHook, "disputeProtectionPolicy"),
    read(whitelistPolicy, "owner"),
    read(whitelistPolicy, "escrowRegistry"),
    read(whitelistPolicy, "groupRegistry"),
    read(whitelistPolicy, "orchestratorRegistry"),
    read(attestationVerifier, "owner"),
    read(attestationVerifier, "requiredSignatures"),
    read(attestationVerifier, "witnesses"),
  ]);
  const addressValue = (value: string) => normalizedAddress(value);
  const snapshot: ActivationSnapshot = {
    network,
    blockNumber,
    blockHash: normalizedHash(block.hash),
    blockTimestamp,
    freshPolicy: {
      owner: addressValue(freshOwner),
      pendingOwner: addressValue(freshPendingOwner),
      admissionsPaused: Boolean(freshPaused),
      disputeVerifier: addressValue(freshVerifier),
      disputeNullifierRegistry: addressValue(freshRegistry),
      stakeVault: addressValue(freshVault),
      authorizedHooks,
      riskWindows,
    },
    predecessorPolicy: {
      owner: addressValue(predecessorOwner),
      pendingOwner: addressValue(predecessorPendingOwner),
      admissionsPaused: Boolean(predecessorPaused),
      disputeVerifier: addressValue(predecessorVerifier),
      disputeNullifierRegistry: addressValue(predecessorRegistry),
    },
    disputeVerifier: {
      owner: addressValue(verifierOwner),
      pendingOwner: addressValue(verifierPendingOwner),
      attestationVerifier: addressValue(verifierAttestation),
      nullifierRegistry: addressValue(verifierNullifier),
    },
    vault: {
      owner: addressValue(vaultOwner),
      pendingOwner: addressValue(vaultPendingOwner),
      controller: addressValue(vaultController),
      pendingController: addressValue(vaultPendingController),
      pendingControllerValidAt: decimal(vaultPendingControllerValidAt),
      controllerChangeDelay: decimal(controllerChangeDelay),
      stakeToken: addressValue(stakeToken),
    },
    registry: {
      owner: addressValue(registryOwner),
      writers: (writers as string[]).map(addressValue),
    },
    orchestrator: {
      owner: addressValue(orchestratorOwner),
      paused: Boolean(orchestratorPaused),
      lifecycleHook: addressValue(lifecycleHook),
      escrowRegistry: addressValue(escrowRegistry),
      paymentVerifierRegistry: addressValue(paymentVerifierRegistry),
      relayerRegistry: addressValue(relayerRegistry),
      protocolFee: decimal(protocolFee),
      protocolFeeRecipient: addressValue(protocolFeeRecipient),
      allowMultipleIntents: Boolean(allowMultipleIntents),
      registered: Boolean(registered),
    },
    freshHook: {
      orchestratorRegistry: addressValue(hookOrchestratorRegistry),
      whitelistPolicy: addressValue(hookWhitelistPolicy),
      disputeProtectionPolicy: addressValue(hookDisputePolicy),
    },
    whitelistPolicy: {
      owner: addressValue(whitelistOwner),
      escrowRegistry: addressValue(whitelistEscrowRegistry),
      groupRegistry: addressValue(whitelistGroupRegistry),
      orchestratorRegistry: addressValue(whitelistOrchestratorRegistry),
    },
    attestationVerifier: {
      owner: addressValue(attestationOwner),
      requiredSignatures: decimal(requiredSignatures),
      witnesses: (witnesses as string[]).map(addressValue),
    },
    lockProof,
    inventory,
  };
  console.log(
    `snapshot ${network}@${blockNumber}: ${
      inventory.depositCounter
    } deposits, ${lockProof.intents.length} predecessor intents, ${
      Date.now() - startedAt
    } ms`
  );
  return snapshot;
}

export async function assertActivationSharedState(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork,
  blockTag: string | number
): Promise<void> {
  const context = await resolveActivationContext(hre, network);
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  if (chainId !== 8453) throw new Error("Lane 38 requires chain id 8453");
  if (
    !sameAddress(context.expected.deployer, EXPECTED_LIVE[network].deployer)
  ) {
    throw new Error("Deployment signer does not match the approved deployer");
  }
  // Deliberate latest-block read: callers invoke this shared preflight once per run.
  if (!(await paymentBindingCutoverReady(hre))) {
    throw new Error("V3 payment binding is not fully cut over");
  }
  await Promise.all([
    assertDeploymentMatchesChain(
      hre,
      context.records.whitelistPolicy,
      METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME,
      "WhitelistPolicy",
      blockTag
    ),
    assertDeploymentMatchesChain(
      hre,
      context.records.freshPolicy,
      "DisputeProtectionPolicyMethodScoped",
      SUCCESSOR_ARTIFACT_NAMES.DisputeProtectionPolicyMethodScoped,
      blockTag
    ),
    assertDeploymentMatchesChain(
      hre,
      context.records.freshHook,
      "IntentLifecycleHookV1MethodScoped",
      SUCCESSOR_ARTIFACT_NAMES.IntentLifecycleHookV1MethodScoped,
      blockTag
    ),
    assertHistoricalDisputeStack(
      hre,
      METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS,
      blockTag
    ),
    assertRuntimeHashAt(
      hre,
      context.expected.addresses.orchestratorRegistry,
      EXPECTED_LIVE[network].orchestratorRegistryCodeHash,
      "OrchestratorRegistry",
      blockTag
    ),
    assertRuntimeHashAt(
      hre,
      context.expected.addresses.orchestrator,
      EXPECTED_LIVE[network].orchestratorCodeHash,
      "OrchestratorV3",
      blockTag
    ),
    assertRuntimeHashAt(
      hre,
      context.expected.addresses.nullifierRegistryV2,
      EXPECTED_LIVE[network].nullifierRegistryV2CodeHash,
      "NullifierRegistryV2",
      blockTag
    ),
    assertRuntimeHashAt(
      hre,
      context.expected.addresses.attestationVerifier,
      EXPECTED_LIVE[network].attestationVerifierCodeHash,
      "MultiAttestationVerifier",
      blockTag
    ),
    (async () => {
      if (
        (await hre.ethers.provider.getCode(
          context.expected.addresses.stakeToken,
          blockTag
        )) === "0x"
      ) {
        throw new Error("USDC has no runtime bytecode");
      }
    })(),
  ]);
  const snapshot = await readActivationSnapshot(hre, network, blockTag);
  const artifact = await hre.deployments.getExtendedArtifact(
    "DisputeProtectionPolicy"
  );
  const logs = await pagedLogs(
    hre.ethers.provider,
    { address: context.records.freshPolicy.address },
    deploymentBlock(
      context.records.freshPolicy,
      "DisputeProtectionPolicyMethodScoped"
    ),
    (
      await hre.ethers.provider.getBlock(blockTag)
    ).number
  );
  classifyActivationFreshStackActivity(
    decodeFreshStackLogs(
      new hre.ethers.utils.Interface(artifact.abi),
      logs,
      "DisputeProtectionPolicyMethodScoped"
    ),
    snapshot.orchestrator.lifecycleHook,
    context.expected.addresses.predecessorHook
  );
  const reduction = reduceActivation(snapshot, context.expected);
  if (reduction.phase === "unrecognized") {
    assertRecognizedActivationState(
      "Method-scoped activation shared state drifted",
      snapshot,
      reduction
    );
  }
}

export function classifyActivationFreshStackActivity(
  policyEvents: FreshStackEvent[],
  lifecycleHook: string,
  predecessorHook: string
): void {
  const eventsToClassify = sameAddress(lifecycleHook, predecessorHook)
    ? policyEvents
    : policyEvents.filter(
        (event) =>
          !FORBIDDEN_POLICY_LIFECYCLE_EVENTS.some(
            (eventName) => eventName === event.name
          )
      );
  classifyFreshStackActivity({ policyEvents: eventsToClassify });
}

export function assertRecognizedActivationState(
  label: string,
  snapshot: ActivationSnapshot,
  reduction: ActivationReduction
): void {
  if (reduction.phase !== "unrecognized") return;
  const inventoryViolations = reduction.violations.includes("inventory.ok")
    ? snapshot.inventory.violations.map(
        (tuple) =>
          `${tuple.escrow}:${tuple.depositId}:${
            tuple.paymentMethod
          } sources=${tuple.sources.join("+")}`
      )
    : [];
  throw new Error(
    `${label}: ${[...reduction.violations, ...inventoryViolations].join(", ")}`
  );
}

export function activationConfirmation(
  network: ActivationNetwork,
  suffix: "ACTIVATION" | "DOWNSTREAM_READY"
): boolean {
  const name =
    suffix === "ACTIVATION"
      ? FLAGS.confirmActivation(network)
      : FLAGS.confirmDownstreamReady(network);
  return process.env[name] === "true";
}

function requireActivationConfirmations(network: ActivationNetwork): void {
  const activation = FLAGS.confirmActivation(network);
  if (!activationConfirmation(network, "ACTIVATION")) {
    throw new Error(`Set ${activation}=true before activation`);
  }
  const downstream = FLAGS.confirmDownstreamReady(network);
  if (!activationConfirmation(network, "DOWNSTREAM_READY")) {
    throw new Error(`Set ${downstream}=true after ${activation}`);
  }
}

export function requireStableStagingNonce(
  initialNonce: number,
  executionNonce: number
): void {
  if (initialNonce !== executionNonce) {
    throw new Error("Base staging deployer nonce changed after preflight");
  }
}

function transactionEqual(
  left: NormalizedSafeBatchTransaction,
  right: NormalizedSafeBatchTransaction
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actionIndex(action: StagingAction | null): number {
  const actions: Array<StagingAction | null> = [
    "pause-predecessor-admissions",
    "propose-controller",
    "release-matured-predecessor-intents",
    "accept-vault-controller",
    "add-fresh-writer",
    "set-fresh-hook",
    "remove-predecessor-writer",
    null,
  ];
  return actions.indexOf(action);
}

export function assertStagingAdvance(
  before: ActivationReduction,
  after: ActivationReduction
): void {
  if (after.phase === "unrecognized") {
    throw new Error("Base staging activation entered an unrecognized state");
  }
  if (
    before.nextStagingAction === "propose-controller" &&
    after.nextStagingAction === null &&
    after.waiting?.reason === "controller-delay"
  ) {
    return;
  }
  if (
    before.nextStagingAction === "release-matured-predecessor-intents" &&
    (after.nextStagingAction === "release-matured-predecessor-intents" ||
      after.waiting?.reason === "predecessor-drain" ||
      after.nextStagingAction === "accept-vault-controller")
  ) {
    return;
  }
  if (
    actionIndex(after.nextStagingAction) !==
    actionIndex(before.nextStagingAction) + 1
  ) {
    throw new Error(
      "Base staging activation did not advance by exactly one step"
    );
  }
}

export async function preflightStagingTransaction(
  hre: HardhatRuntimeEnvironment,
  transaction: NormalizedSafeBatchTransaction,
  deployer: string,
  blockTag: number
): Promise<{
  request: providers.TransactionRequest;
  nonce: number;
  gasLimit: BigNumber;
}> {
  const provider = hre.ethers.provider;
  const nonce = await provider.getTransactionCount(deployer, "pending");
  const [balance, feeData] = await Promise.all([
    provider.getBalance(deployer, blockTag),
    provider.getFeeData(),
  ]);
  const baseRequest: providers.TransactionRequest = {
    from: deployer,
    to: transaction.to,
    value: transaction.value,
    data: transaction.data,
    nonce,
  };
  await provider.call(baseRequest, blockTag);
  const estimate = await (provider as providers.JsonRpcProvider).send(
    "eth_estimateGas",
    [
      {
        from: deployer,
        to: transaction.to,
        value: hre.ethers.utils.hexValue(
          hre.ethers.BigNumber.from(transaction.value)
        ),
        data: transaction.data,
        nonce: hre.ethers.utils.hexValue(nonce),
      },
      hre.ethers.utils.hexValue(blockTag),
    ]
  );
  const gasLimit = hre.ethers.BigNumber.from(estimate);
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  if (!gasPrice)
    throw new Error("Base staging RPC returned no usable gas price");
  if (balance.lt(gasLimit.mul(gasPrice))) {
    throw new Error("Base staging deployer balance is insufficient");
  }
  const request: providers.TransactionRequest = { ...baseRequest, gasLimit };
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    request.maxFeePerGas = feeData.maxFeePerGas;
    request.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    request.type = 2;
  } else {
    request.gasPrice = gasPrice;
  }
  return { request, nonce, gasLimit };
}

async function readPinnedStagingState(
  hre: HardhatRuntimeEnvironment,
  verifySharedState: boolean
) {
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  if (verifySharedState) {
    await assertActivationSharedState(hre, "base_staging", blockNumber);
  }
  const snapshot = await readActivationSnapshot(
    hre,
    "base_staging",
    blockNumber
  );
  const expected = expectedActivationState("base_staging");
  const reduction = reduceActivation(snapshot, expected);
  if (reduction.phase === "unrecognized") {
    assertRecognizedActivationState(
      "Base staging activation state is unrecognized",
      snapshot,
      reduction
    );
  }
  const transaction = reduction.nextStagingAction
    ? buildStagingTransaction(
        reduction.nextStagingAction,
        expected.addresses,
        snapshot.lockProof
      )
    : null;
  return { blockNumber, snapshot, reduction, transaction };
}

export async function prepareOrExecuteStagingActivation(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const preparing = process.env[FLAGS.stagingPrepare] === "true";
  const executing = process.env[FLAGS.stagingExecute] === "true";
  if (preparing === executing) {
    throw new Error(
      `Set exactly one of ${FLAGS.stagingPrepare}=true or ${FLAGS.stagingExecute}=true`
    );
  }
  requireActivationConfirmations("base_staging");
  const before = await readPinnedStagingState(hre, true);
  if (!before.transaction) {
    if (before.reduction.waiting) {
      console.log(
        `Base staging activation waiting: ${
          before.reduction.waiting.reason
        }; earliest=${before.reduction.waiting.earliestChangeAt ?? "unknown"}`
      );
    } else {
      console.log("=== Base staging method-scoped dispute stack is active ===");
    }
    return;
  }
  const deployer = expectedActivationState("base_staging").deployer;
  const preflight = await preflightStagingTransaction(
    hre,
    before.transaction,
    deployer,
    before.blockNumber
  );
  console.log(
    `Base staging next activation call: ${
      before.reduction.nextStagingAction
    }; nonce=${preflight.nonce}; gas=${preflight.gasLimit.toString()}`
  );
  if (!executing) return;

  const execution = await readPinnedStagingState(hre, false);
  if (
    !execution.transaction ||
    execution.reduction.nextStagingAction !==
      before.reduction.nextStagingAction ||
    !transactionEqual(execution.transaction, before.transaction)
  ) {
    throw new Error("Base staging activation state changed after preflight");
  }
  const executionPreflight = await preflightStagingTransaction(
    hre,
    execution.transaction,
    deployer,
    execution.blockNumber
  );
  requireStableStagingNonce(preflight.nonce, executionPreflight.nonce);
  const signer = await hre.ethers.getSigner(deployer);
  const response = await signer.sendTransaction(executionPreflight.request);
  await response.wait();
  await waitForDeploymentDelay(hre);
  const after = await readPinnedStagingState(hre, false);
  assertStagingAdvance(before.reduction, after.reduction);
  console.log(
    `Base staging activation advanced exactly one step: ${before.reduction.nextStagingAction}`
  );
}

export async function releaseMaturedPredecessorIntents(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork
): Promise<void> {
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  await assertActivationSharedState(hre, network, blockNumber);
  const snapshot = await readActivationSnapshot(hre, network, blockNumber);
  if (
    network === "base" &&
    !assertBaseActionPhase(
      "release-matured",
      snapshot,
      expectedActivationState("base")
    )
  ) {
    return;
  }
  if (snapshot.lockProof.releasable.length === 0) {
    console.log(`No matured predecessor intents to release on ${network}`);
    return;
  }
  const expected = expectedActivationState(network);
  const transaction = buildStagingTransaction(
    "release-matured-predecessor-intents",
    expected.addresses,
    snapshot.lockProof
  );
  const signer = await hre.ethers.getSigner(expected.deployer);
  const response = await signer.sendTransaction({
    to: transaction.to,
    value: transaction.value,
    data: transaction.data,
  });
  await response.wait();
  await waitForDeploymentDelay(hre);
}

export async function deployActivationContract(
  hre: HardhatRuntimeEnvironment,
  artifactName: string,
  constructorArgs: unknown[]
): Promise<ContractIdentity> {
  const [deployer] = await hre.getUnnamedAccounts();
  const signer = await hre.ethers.getSigner(deployer);
  const factory = await hre.ethers.getContractFactory(artifactName, signer);
  const contract = await factory.deploy(...constructorArgs);
  const receipt = await contract.deployTransaction.wait();
  if (receipt.status !== 1 || !receipt.contractAddress) {
    throw new Error(`${artifactName} deployment did not succeed`);
  }
  const runtimeCode = await withBlockLagRetry(
    `${artifactName} runtime code at block ${receipt.blockNumber}`,
    () =>
      hre.ethers.provider.getCode(
        receipt.contractAddress as string,
        receipt.blockNumber
      ),
    (code) => code === "0x"
  );
  if (runtimeCode === "0x") {
    throw new Error(`${artifactName} deployment has no runtime bytecode`);
  }
  return {
    address: normalizedAddress(receipt.contractAddress),
    artifactName,
    constructorArgs,
    deployTransactionHash: normalizedHash(receipt.transactionHash),
    runtimeCodeHash: normalizedHash(hre.ethers.utils.keccak256(runtimeCode)),
  };
}

export async function runPinnedSimulation(
  manifest: ActivationBatchManifest,
  forkRpcUrl: string
): Promise<void> {
  const repositoryRoot = resolve(__dirname, "..");
  const hardhatCli = require.resolve("hardhat/internal/cli/cli");
  const simulationScript = resolve(
    repositoryRoot,
    "scripts/simulate-method-scoped-safe-batch.ts"
  );
  const result = spawnSync(
    process.execPath,
    [
      hardhatCli,
      "run",
      "--network",
      "hardhat",
      "--no-compile",
      simulationScript,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_FORK_RPC_URL: forkRpcUrl,
        METHOD_SCOPED_SAFE_SIMULATION_PAYLOAD: JSON.stringify({ manifest }),
      },
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Pinned Base Safe simulation failed:\n${result.stdout || ""}${
        result.stderr || ""
      }`
    );
  }
}

function trustSurfaceConstructorArg(
  expected: ExpectedActivationState
): ReturnType<typeof buildTrustSurface> {
  return buildTrustSurface(expected);
}

type BaseAction = ActivationBatchKind | "release-matured";

export function assertBaseActionPhase(
  action: BaseAction,
  snapshot: ActivationSnapshot,
  expected: ExpectedActivationState
): boolean {
  const reduction = reduceActivation(snapshot, expected);
  if (reduction.phase === "active") {
    console.log(
      "=== Base method-scoped dispute stack is active; nothing to prepare ==="
    );
    return false;
  }
  if (action === "release-matured") return true;
  const requiredPhase =
    action === "rotation" ? "deployed" : "rotation-proposed";
  if (reduction.phase !== requiredPhase || reduction.waiting !== null) {
    throw new Error(
      `${action} batch requires ${requiredPhase} with no waiting condition`
    );
  }
  return true;
}

async function prepareBaseBatch(
  hre: HardhatRuntimeEnvironment,
  kind: ActivationBatchKind
): Promise<void> {
  const proofBlockNumber = await hre.ethers.provider.getBlockNumber();
  await assertActivationSharedState(hre, "base", proofBlockNumber);
  const proofSnapshot = await readActivationSnapshot(
    hre,
    "base",
    proofBlockNumber
  );
  const expected = expectedActivationState("base");
  if (!assertBaseActionPhase(kind, proofSnapshot, expected)) return;
  const sourceSha = (process.env[FLAGS.releaseReadySha] || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(
      `Base batch preparation requires an exact ${FLAGS.releaseReadySha}`
    );
  }
  const repositoryRoot = resolve(__dirname, "..");
  assertActivationArtifactGitState(repositoryRoot, sourceSha, "generation", []);
  const forkRpcUrl = process.env.BASE_FORK_RPC_URL || "";
  if (!forkRpcUrl) {
    throw new Error("BASE_FORK_RPC_URL is required for Base batch preparation");
  }
  const trustSurface = trustSurfaceConstructorArg(expected);
  const includeAcceptOwnership =
    !sameAddress(proofSnapshot.freshPolicy.owner, expected.addresses.safe) &&
    sameAddress(
      proofSnapshot.freshPolicy.pendingOwner,
      expected.addresses.safe
    );
  const guardArgs: unknown[] =
    kind === "rotation"
      ? [trustSurface, includeAcceptOwnership, expected.deployer]
      : [
          trustSurface,
          proofSnapshot.lockProof.intents.map((intent) => intent.intentHash),
          proofSnapshot.inventory.tuples.map((tuple) => ({
            escrow: tuple.escrow,
            depositId: tuple.depositId,
            paymentMethod: tuple.paymentMethod,
          })),
          proofSnapshot.inventory.escrow,
          proofSnapshot.inventory.depositCounter,
        ];
  const guardArtifactName =
    kind === "rotation"
      ? "DisputeMethodScopedRotationGuard"
      : "DisputeMethodScopedCutoverGuard";
  const postconditionArtifactName =
    kind === "rotation"
      ? "DisputeMethodScopedRotationPostcondition"
      : "DisputeMethodScopedCutoverPostcondition";
  const guard = await deployActivationContract(
    hre,
    guardArtifactName,
    guardArgs
  );
  const postconditionArgs: unknown[] =
    kind === "rotation"
      ? [trustSurface, expected.controllerChangeDelay]
      : [trustSurface];
  const postcondition = await deployActivationContract(
    hre,
    postconditionArtifactName,
    postconditionArgs
  );
  const simulationBlockNumber = await hre.ethers.provider.getBlockNumber();
  if (simulationBlockNumber <= proofBlockNumber) {
    throw new Error("Simulation block must follow the proof block");
  }
  const simulationBlock = await withBlockLagRetry(
    `Base simulation block ${simulationBlockNumber}`,
    () => hre.ethers.provider.getBlock(simulationBlockNumber)
  );
  if (!simulationBlock?.hash) {
    throw new Error("Could not pin the simulation block");
  }
  const simulationSnapshot = await withBlockLagRetry(
    `Base simulation snapshot at block ${simulationBlockNumber}`,
    () => readActivationSnapshot(hre, "base", simulationBlockNumber)
  );
  assertGuardExpectationsUnchanged(kind, proofSnapshot, simulationSnapshot);
  const transactions =
    kind === "rotation"
      ? buildRotationTransactions({
          addresses: expected.addresses,
          guard: guard.address,
          includeAcceptOwnership,
        })
      : buildCutoverTransactions({
          addresses: expected.addresses,
          guard: guard.address,
        });
  const safe = await hre.ethers.getContractAt(
    ["function nonce() view returns (uint256)"],
    BASE_SAFE
  );
  const unsignedManifest: Omit<ActivationBatchManifest, "manifestSha256"> = {
    version: 2,
    kind,
    chainId: 8453,
    safe: BASE_SAFE.toLowerCase(),
    safeNonce: decimal(
      await taggedRead(safe, "nonce", [], simulationBlockNumber)
    ),
    sourceSha,
    proofBlock: {
      number: proofSnapshot.blockNumber,
      hash: proofSnapshot.blockHash,
    },
    simulationBlockNumber,
    simulationBlockHash: normalizedHash(simulationBlock.hash),
    simulationResult: "success",
    transactions,
    transactionsSha256: canonicalTransactionHash(transactions),
    guard,
    postcondition,
    trustSurface,
    proofSnapshot,
  };
  const manifest: ActivationBatchManifest = {
    ...unsignedManifest,
    manifestSha256: computeManifestSha256(unsignedManifest),
  };
  validateActivationBatchManifest(manifest, manifest);
  const batch = safeBatchJson(
    kind,
    transactions,
    simulationBlock.timestamp * 1000
  );
  const paths = ACTIVATION_BATCH_PATHS[kind];
  const artifactPaths = {
    batch: resolve(repositoryRoot, paths.batch),
    sidecar: resolve(repositoryRoot, paths.sidecar),
  };
  await verifyActivationCandidate(hre, {
    kind,
    batch,
    manifest,
    mode: "generation",
    repositoryRoot,
    forkRpcUrl,
    artifactPaths,
  });
  installSafeArtifactPair({
    batchPath: artifactPaths.batch,
    sidecarPath: artifactPaths.sidecar,
    supersededDir: resolve(repositoryRoot, paths.supersededDir),
    batchContents: `${JSON.stringify(batch, null, 2)}\n`,
    sidecarContents: `${JSON.stringify(manifest, null, 2)}\n`,
    supersededSuffix: `${simulationBlockNumber}_${manifest.manifestSha256.slice(
      0,
      12
    )}`,
  });
  console.log(`Prepared and simulated Base ${kind} Safe batch: ${paths.batch}`);
  console.log("No Safe transaction was signed, proposed, or executed.");
}

export async function prepareBaseRotationBatch(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  await prepareBaseBatch(hre, "rotation");
}

export async function prepareBaseCutoverBatch(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  await prepareBaseBatch(hre, "cutover");
}

const actionFlags = [
  FLAGS.stagingPrepare,
  FLAGS.stagingExecute,
  FLAGS.baseRotationPrepare,
  FLAGS.baseCutoverPrepare,
  FLAGS.baseReleaseMatured,
] as const;

function selectedFlags(): string[] {
  return actionFlags.filter((flag) => process.env[flag] === "true");
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (!isLiveNetwork(network)) {
    throw new Error("no predecessor stack on local networks");
  }
  if (process.env.DEPLOY_ACTIVE_TAG !== TAG) {
    throw new Error(`Lane 38 activation requires DEPLOY_ACTIVE_TAG=${TAG}`);
  }
  if (network === "base_staging") {
    await prepareOrExecuteStagingActivation(hre);
    return;
  }
  requireActivationConfirmations("base");
  if (process.env[FLAGS.baseRotationPrepare] === "true") {
    await prepareBaseRotationBatch(hre);
  } else if (process.env[FLAGS.baseCutoverPrepare] === "true") {
    await prepareBaseCutoverBatch(hre);
  } else if (process.env[FLAGS.baseReleaseMatured] === "true") {
    await releaseMaturedPredecessorIntents(hre, "base");
  } else {
    throw new Error("Select exactly one Base lane-38 action flag");
  }
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  const selected = selectedFlags();
  const tagged = process.env.DEPLOY_ACTIVE_TAG === TAG;
  if (selected.length > 0 && !tagged) {
    throw new Error(`Lane 38 flags require DEPLOY_ACTIVE_TAG=${TAG}`);
  }
  if (network === "localhost" || network === "hardhat") {
    if (tagged) throw new Error("no predecessor stack on local networks");
    return true;
  }
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (network === "base_staging") {
    const prepare = process.env[FLAGS.stagingPrepare] === "true";
    const execute = process.env[FLAGS.stagingExecute] === "true";
    if (prepare && execute) {
      throw new Error(
        `Set exactly one of ${FLAGS.stagingPrepare}=true or ${FLAGS.stagingExecute}=true`
      );
    }
    if (
      process.env[FLAGS.baseRotationPrepare] === "true" ||
      process.env[FLAGS.baseCutoverPrepare] === "true" ||
      process.env[FLAGS.baseReleaseMatured] === "true"
    ) {
      throw new Error("Base lane-38 flag selected on Base staging");
    }
  } else if (
    process.env[FLAGS.stagingPrepare] === "true" ||
    process.env[FLAGS.stagingExecute] === "true"
  ) {
    throw new Error("Base staging lane-38 flag selected on Base");
  } else if (selected.length > 1) {
    throw new Error("Select exactly one Base lane-38 action flag");
  }
  return selected.length === 0;
};

func.tags = [TAG, "V3DisputeMethodScopedActivation"];
func.dependencies = [];

export default func;
