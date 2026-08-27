import { resolve } from "path";
import type { BigNumber, Contract, providers, utils } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";

import {
  VAULT_ACTIVATION_BATCH_PATHS,
  computeVaultManifestSha256,
  validateVaultActivationBatchManifest,
  vaultSafeBatchJson,
  type ContractIdentity,
  type VaultActivationBatchManifest,
} from "../deployments/vaultActivationBatchManifest";
import { assertDeploymentMatchesChain } from "../deployments/canonicalDeployment";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  ActivationNetwork,
  type ConfigEvent,
  type IntentLockState,
} from "../deployments/methodScopedActivation";
import {
  buildDepositorInventory,
  buildVaultCutoverTransactions,
  buildVaultStagingTransaction,
  buildVaultTrustSurface,
  buildVaultWriterRemovalTransactions,
  classifyIntentLock,
  proveNoLivePredecessorLocks,
  reduceVaultActivation,
  assertVaultGuardExpectationsUnchanged,
  type VaultActivationBatchKind,
  type VaultActivationReduction,
  VaultActivationSnapshot,
  VaultExpectedActivationState,
} from "../deployments/vaultMethodScopedActivation";
import { installSafeArtifactPair } from "../deployments/safeArtifacts";
import { canonicalTransactionHash } from "../deployments/safeBatchManifest";
import type { NormalizedSafeBatchTransaction } from "../deployments/safeBatchManifest";
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
import { paymentBindingCutoverReady } from "./31_deploy_v3_payment_binding_stack";
import { METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME } from "./36_deploy_method_scoped_whitelist_policy";
import {
  EXPECTED_LIVE,
  FORBIDDEN_POLICY_LIFECYCLE_EVENTS,
  classifyFreshStackActivity,
  decodeFreshStackLogs,
  getRiskWindowPaymentMethods,
  type FreshStackEvent,
} from "./37_deploy_method_scoped_dispute_lifecycle_stack";
import {
  ARTIFACT_NAMES as VAULT_STACK_ARTIFACT_NAMES,
  STAGING_PREDECESSOR_PENDING_CONTROLLER,
  assertPredecessorVaultTransitionState,
} from "./39_deploy_method_scoped_vault_stack";
import { BASE_SAFE } from "../scripts/simulate-dispute-opt-in-safe-batch";
import {
  assertActivationArtifactGitState,
  verifyVaultActivationCandidate,
} from "../scripts/verify-method-scoped-safe-batch";
import {
  deployActivationContract as deployLegacyActivationContract,
  mapWithConcurrency,
  preflightStagingTransaction,
  requireStableStagingNonce,
  runPinnedSimulation as runLegacyPinnedSimulation,
  withBlockLagRetry,
} from "./38_activate_method_scoped_dispute_lifecycle_stack";

export const SUPPORTED_NETWORKS = new Set(["base_staging", "base"]);
export const TAG = "40_activate_method_scoped_vault_stack";

export const FLAGS = {
  stagingPrepare: "PREPARE_STAGING_V3_DISPUTE_METHOD_SCOPED_VAULT_ACTIVATION",
  stagingExecute: "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_VAULT_ACTIVATION",
  baseCutoverPrepare:
    "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_CUTOVER_PREPARATION",
  baseWriterRemovalPrepare:
    "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_WRITER_REMOVAL_PREPARATION",
  baseReleaseMatured:
    "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_RELEASE_MATURED",
  confirmActivation: (network: ActivationNetwork): string =>
    `CONFIRM_${
      network === "base" ? "BASE" : "STAGING"
    }_V3_DISPUTE_METHOD_SCOPED_VAULT_ACTIVATION`,
  confirmDownstreamReady: (network: ActivationNetwork): string =>
    `CONFIRM_${
      network === "base" ? "BASE" : "STAGING"
    }_V3_DISPUTE_METHOD_SCOPED_VAULT_DOWNSTREAM_READY`,
  releaseReadySha:
    "CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_RELEASE_READY_SHA",
  forkRpcUrl: "BASE_FORK_RPC_URL",
} as const;

type ActivationContext = {
  expected: VaultExpectedActivationState;
  records: {
    escrow: Deployment;
    whitelistPolicy: Deployment;
    freshVault: Deployment;
    freshPolicy: Deployment;
    freshHook: Deployment;
    predecessorVault: Deployment;
    predecessorPolicy: Deployment;
  };
};

const expectedCache = new Map<
  ActivationNetwork,
  VaultExpectedActivationState
>();
const PAGE_SIZE = 10_000;
const DEFAULT_READ_CONCURRENCY = 16;
const MAX_READ_CONCURRENCY = 64;

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

function isLiveNetwork(network: string): network is ActivationNetwork {
  return network === "base" || network === "base_staging";
}

function deploymentBlock(deployment: Deployment, label: string): number {
  const blockNumber = deployment.receipt?.blockNumber;
  if (!Number.isSafeInteger(blockNumber)) {
    throw new Error(`${label} lacks deployment block evidence`);
  }
  return blockNumber as number;
}

function readConcurrency(): number {
  const raw = process.env.METHOD_SCOPED_READ_CONCURRENCY;
  if (raw === undefined) return DEFAULT_READ_CONCURRENCY;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      `METHOD_SCOPED_READ_CONCURRENCY must be an integer from 1 to ${MAX_READ_CONCURRENCY}`
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_READ_CONCURRENCY) {
    throw new Error(
      `METHOD_SCOPED_READ_CONCURRENCY must be an integer from 1 to ${MAX_READ_CONCURRENCY}`
    );
  }
  return value;
}

async function getRequiredDeployment(
  hre: HardhatRuntimeEnvironment,
  name: string
): Promise<Deployment> {
  const deployment = await hre.deployments.getOrNull(name);
  if (!deployment) throw new Error(`${name} deployment record missing`);
  return deployment;
}

async function resolveVaultActivationContext(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork
): Promise<ActivationContext> {
  const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network];
  const predecessorVaultEvidence = predecessor.contracts.StakeVault;
  const predecessorPolicyEvidence =
    predecessor.contracts.DisputeProtectionPolicy;
  const predecessorVaultName =
    predecessorVaultEvidence.deploymentName || "StakeVault";
  const predecessorPolicyName =
    predecessorPolicyEvidence.deploymentName || "DisputeProtectionPolicy";
  const [deployer] = await hre.getUnnamedAccounts();
  const [
    escrow,
    whitelistPolicy,
    freshVault,
    freshPolicy,
    freshHook,
    predecessorVault,
    predecessorPolicy,
  ] = await Promise.all([
    getRequiredDeployment(hre, "EscrowV2"),
    getRequiredDeployment(hre, METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME),
    getRequiredDeployment(hre, "StakeVaultMethodScoped"),
    getRequiredDeployment(hre, "DisputeProtectionPolicyMethodScopedStaked"),
    getRequiredDeployment(hre, "IntentLifecycleHookV1MethodScopedStaked"),
    getRequiredDeployment(hre, predecessorVaultName),
    getRequiredDeployment(hre, predecessorPolicyName),
  ]);
  if (
    !sameAddress(predecessorVault.address, predecessorVaultEvidence.address)
  ) {
    throw new Error("Predecessor vault deployment record address mismatch");
  }
  if (
    !sameAddress(predecessorPolicy.address, predecessorPolicyEvidence.address)
  ) {
    throw new Error("Predecessor policy deployment record address mismatch");
  }
  const live = EXPECTED_LIVE[network];
  const governance = MULTI_SIG[network] || deployer;
  const addresses = {
    safe: normalizedAddress(governance),
    deployer: normalizedAddress(deployer),
    escrow: normalizedAddress(escrow.address),
    predecessorVault: normalizedAddress(predecessorVault.address),
    freshVault: normalizedAddress(freshVault.address),
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
  const expected: VaultExpectedActivationState = {
    network,
    governance: normalizedAddress(governance),
    deployer: normalizedAddress(deployer),
    addresses,
    riskWindows,
    witnesses: live.attestationWitnesses.map(normalizedAddress),
    controllerChangeDelay: decimal(STAKE_VAULT_CONTROLLER_CHANGE_DELAY),
    allowMultipleIntents: live.allowMultipleIntents,
    predecessorVaultPendingController:
      network === "base"
        ? normalizedAddress(hre.ethers.constants.AddressZero)
        : normalizedAddress(STAGING_PREDECESSOR_PENDING_CONTROLLER),
    predecessorAdmissionsPaused: network === "base_staging",
  };
  expectedCache.set(network, expected);
  return {
    expected,
    records: {
      escrow,
      whitelistPolicy,
      freshVault,
      freshPolicy,
      freshHook,
      predecessorVault,
      predecessorPolicy,
    },
  };
}

export async function loadVaultActivationContext(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork
): Promise<void> {
  if (expectedCache.has(network)) return;
  await resolveVaultActivationContext(hre, network);
}

export function expectedVaultActivationState(
  network: ActivationNetwork
): VaultExpectedActivationState {
  const expected = expectedCache.get(network);
  if (!expected) {
    throw new Error(
      `Vault activation deployment records for ${network} have not been loaded`
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
  const { predecessorPolicy, predecessorVault } = context.records;
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
  const vault = await contractAt(hre, "StakeVault", predecessorVault.address);
  const intents = await mapWithConcurrency(
    intentHashes,
    readConcurrency(),
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
      "DisputeProtectionPolicyMethodScopedStaked"
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
  const successorTuples = deposits.flatMap((deposit) =>
    deposit.listedPaymentMethods
      .filter((method) => (successorRiskWindows[method] ?? "0") !== "0")
      .map((method) => ({ depositId: deposit.depositId, method }))
  );
  const successorEnabled = await mapWithConcurrency(
    successorTuples,
    concurrency,
    async ({ depositId, method }) =>
      Boolean(
        await taggedRead(
          successor,
          "isDisputeProtectionEnabled",
          [addresses.escrow, depositId, method],
          blockTag
        )
      )
  );
  const enabledByTuple = new Map<string, boolean>();
  successorTuples.forEach(({ depositId, method }, index) =>
    enabledByTuple.set(`${depositId}:${method}`, successorEnabled[index])
  );

  // The predecessor record ABI is authoritative: Base OptIn emits the
  // three-argument deposit-scoped event while the successor is method-scoped.
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
        "DisputeProtectionPolicyMethodScopedStaked"
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

export async function readVaultActivationSnapshot(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork,
  blockTag: string | number
): Promise<VaultActivationSnapshot> {
  const startedAt = Date.now();
  const context = await resolveVaultActivationContext(hre, network);
  const block = await hre.ethers.provider.getBlock(blockTag);
  if (!block)
    throw new Error(`Vault activation block ${blockTag} is unavailable`);
  const blockNumber = block.number;
  const blockTimestamp = decimal(block.timestamp);
  const { addresses } = context.expected;
  const [
    freshPolicy,
    predecessorPolicy,
    disputeVerifier,
    freshVault,
    predecessorVault,
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
    contractAt(hre, "StakeVault", addresses.freshVault),
    contractAt(hre, "StakeVault", addresses.predecessorVault),
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
  const values = await Promise.all([
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
    read(predecessorPolicy, "stakeVault"),
    read(disputeVerifier, "owner"),
    read(disputeVerifier, "pendingOwner"),
    read(disputeVerifier, "attestationVerifier"),
    read(disputeVerifier, "nullifierRegistry"),
    read(freshVault, "owner"),
    read(freshVault, "pendingOwner"),
    read(freshVault, "controller"),
    read(freshVault, "pendingController"),
    read(freshVault, "pendingControllerValidAt"),
    read(freshVault, "controllerChangeDelay"),
    read(freshVault, "stakeToken"),
    read(predecessorVault, "pendingController"),
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
  let index = 0;
  const take = () => values[index++];
  const snapshot: VaultActivationSnapshot = {
    network,
    blockNumber,
    blockHash: normalizedHash(block.hash),
    blockTimestamp,
    freshPolicy: {
      owner: addressValue(take()),
      pendingOwner: addressValue(take()),
      admissionsPaused: Boolean(take()),
      disputeVerifier: addressValue(take()),
      disputeNullifierRegistry: addressValue(take()),
      stakeVault: addressValue(take()),
      authorizedHooks,
      riskWindows,
    },
    predecessorPolicy: {
      owner: addressValue(take()),
      pendingOwner: addressValue(take()),
      admissionsPaused: Boolean(take()),
      disputeVerifier: addressValue(take()),
      disputeNullifierRegistry: addressValue(take()),
      stakeVault: addressValue(take()),
    },
    disputeVerifier: {
      owner: addressValue(take()),
      pendingOwner: addressValue(take()),
      attestationVerifier: addressValue(take()),
      nullifierRegistry: addressValue(take()),
    },
    freshVault: {
      owner: addressValue(take()),
      pendingOwner: addressValue(take()),
      controller: addressValue(take()),
      pendingController: addressValue(take()),
      pendingControllerValidAt: decimal(take()),
      controllerChangeDelay: decimal(take()),
      stakeToken: addressValue(take()),
    },
    predecessorVault: { pendingController: addressValue(take()) },
    registry: {
      owner: addressValue(take()),
      writers: (take() as string[]).map(addressValue),
    },
    orchestrator: {
      owner: addressValue(take()),
      paused: Boolean(take()),
      lifecycleHook: addressValue(take()),
      escrowRegistry: addressValue(take()),
      paymentVerifierRegistry: addressValue(take()),
      relayerRegistry: addressValue(take()),
      protocolFee: decimal(take()),
      protocolFeeRecipient: addressValue(take()),
      allowMultipleIntents: Boolean(take()),
      registered: Boolean(take()),
    },
    freshHook: {
      orchestratorRegistry: addressValue(take()),
      whitelistPolicy: addressValue(take()),
      disputeProtectionPolicy: addressValue(take()),
    },
    whitelistPolicy: {
      owner: addressValue(take()),
      escrowRegistry: addressValue(take()),
      groupRegistry: addressValue(take()),
      orchestratorRegistry: addressValue(take()),
    },
    attestationVerifier: {
      owner: addressValue(take()),
      requiredSignatures: decimal(take()),
      witnesses: (take() as string[]).map(addressValue),
    },
    lockProof,
    inventory,
  };
  console.log(
    `vault snapshot ${network}@${blockNumber}: ${
      inventory.depositCounter
    } deposits, ${lockProof.intents.length} predecessor intents, ${
      Date.now() - startedAt
    } ms`
  );
  return snapshot;
}

export function classifyVaultActivationFreshStackActivity(
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

export function assertRecognizedVaultActivationState(
  label: string,
  snapshot: VaultActivationSnapshot,
  reduction: VaultActivationReduction
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

export async function assertVaultActivationSharedState(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork,
  blockTag: string | number
): Promise<void> {
  const context = await resolveVaultActivationContext(hre, network);
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  if (chainId !== 8453) throw new Error("Lane 40 requires chain id 8453");
  if (
    !sameAddress(context.expected.deployer, EXPECTED_LIVE[network].deployer)
  ) {
    throw new Error("Deployment signer does not match the approved deployer");
  }
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
      context.records.freshVault,
      "StakeVaultMethodScoped",
      VAULT_STACK_ARTIFACT_NAMES.StakeVaultMethodScoped,
      blockTag
    ),
    assertDeploymentMatchesChain(
      hre,
      context.records.freshPolicy,
      "DisputeProtectionPolicyMethodScopedStaked",
      VAULT_STACK_ARTIFACT_NAMES.DisputeProtectionPolicyMethodScopedStaked,
      blockTag
    ),
    assertDeploymentMatchesChain(
      hre,
      context.records.freshHook,
      "IntentLifecycleHookV1MethodScopedStaked",
      VAULT_STACK_ARTIFACT_NAMES.IntentLifecycleHookV1MethodScopedStaked,
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
  const snapshot = await readVaultActivationSnapshot(hre, network, blockTag);
  if (
    !sameAddress(
      snapshot.predecessorPolicy.stakeVault,
      context.records.predecessorVault.address
    )
  ) {
    throw new Error(
      "Predecessor policy stakeVault does not match the pinned record"
    );
  }
  const predecessorVault = await contractAt(
    hre,
    "StakeVault",
    context.records.predecessorVault.address
  );
  assertPredecessorVaultTransitionState(
    network,
    snapshot.predecessorVault.pendingController,
    await taggedRead(
      predecessorVault,
      "pendingControllerValidAt",
      [],
      blockTag
    ),
    snapshot.predecessorPolicy.admissionsPaused
  );
  const artifact = await hre.deployments.getExtendedArtifact(
    "DisputeProtectionPolicy"
  );
  const block = await hre.ethers.provider.getBlock(blockTag);
  if (!block)
    throw new Error(`Vault activation block ${blockTag} is unavailable`);
  const logs = await pagedLogs(
    hre.ethers.provider,
    { address: context.records.freshPolicy.address },
    deploymentBlock(
      context.records.freshPolicy,
      "DisputeProtectionPolicyMethodScopedStaked"
    ),
    block.number
  );
  classifyVaultActivationFreshStackActivity(
    decodeFreshStackLogs(
      new hre.ethers.utils.Interface(artifact.abi),
      logs,
      "DisputeProtectionPolicyMethodScopedStaked"
    ),
    snapshot.orchestrator.lifecycleHook,
    context.expected.addresses.predecessorHook
  );
  const reduction = reduceVaultActivation(snapshot, context.expected);
  if (reduction.phase === "unrecognized") {
    assertRecognizedVaultActivationState(
      "Dedicated-vault activation shared state drifted",
      snapshot,
      reduction
    );
  }
}

export function vaultActivationConfirmation(
  network: ActivationNetwork,
  suffix: "ACTIVATION" | "DOWNSTREAM_READY"
): boolean {
  const name =
    suffix === "ACTIVATION"
      ? FLAGS.confirmActivation(network)
      : FLAGS.confirmDownstreamReady(network);
  return process.env[name] === "true";
}

function requireVaultActivationConfirmations(network: ActivationNetwork): void {
  const activation = FLAGS.confirmActivation(network);
  if (!vaultActivationConfirmation(network, "ACTIVATION")) {
    throw new Error(`Set ${activation}=true before activation`);
  }
  const downstream = FLAGS.confirmDownstreamReady(network);
  if (!vaultActivationConfirmation(network, "DOWNSTREAM_READY")) {
    throw new Error(`Set ${downstream}=true after ${activation}`);
  }
}

function transactionEqual(
  left: NormalizedSafeBatchTransaction,
  right: NormalizedSafeBatchTransaction
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actionIndex(
  action: VaultActivationReduction["nextStagingAction"]
): number {
  return [
    "add-fresh-writer",
    "set-fresh-hook",
    "remove-predecessor-writer",
    null,
  ].indexOf(action);
}

export function assertVaultStagingAdvance(
  before: VaultActivationReduction,
  after: VaultActivationReduction
): void {
  if (after.phase === "unrecognized") {
    throw new Error(
      "Base staging vault activation entered an unrecognized state"
    );
  }
  if (
    actionIndex(after.nextStagingAction) !==
    actionIndex(before.nextStagingAction) + 1
  ) {
    throw new Error(
      "Base staging vault activation did not advance by exactly one step"
    );
  }
}

async function readPinnedStagingState(
  hre: HardhatRuntimeEnvironment,
  verifySharedState: boolean
) {
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  if (verifySharedState) {
    await assertVaultActivationSharedState(hre, "base_staging", blockNumber);
  }
  const snapshot = await readVaultActivationSnapshot(
    hre,
    "base_staging",
    blockNumber
  );
  const expected = expectedVaultActivationState("base_staging");
  const reduction = reduceVaultActivation(snapshot, expected);
  if (reduction.phase === "unrecognized") {
    assertRecognizedVaultActivationState(
      "Base staging vault activation state is unrecognized",
      snapshot,
      reduction
    );
  }
  const transaction = reduction.nextStagingAction
    ? buildVaultStagingTransaction(
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
  requireVaultActivationConfirmations("base_staging");
  const before = await readPinnedStagingState(hre, true);
  if (!before.transaction) {
    if (before.reduction.waiting) {
      console.log(
        `Base staging vault activation waiting: ${
          before.reduction.waiting.reason
        }; earliest=${before.reduction.waiting.earliestChangeAt ?? "unknown"}`
      );
    } else {
      console.log(
        "=== Base staging method-scoped dedicated-vault stack is writer-removed; nothing to do ==="
      );
    }
    return;
  }
  const deployer = expectedVaultActivationState("base_staging").deployer;
  const preflight = await preflightStagingTransaction(
    hre,
    before.transaction,
    deployer,
    before.blockNumber
  );
  console.log(
    `Base staging next vault activation call: ${
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
    throw new Error(
      "Base staging vault activation state changed after preflight"
    );
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
  assertVaultStagingAdvance(before.reduction, after.reduction);
  console.log(
    `Base staging vault activation advanced exactly one step: ${before.reduction.nextStagingAction}`
  );
}

export async function releaseMaturedPredecessorIntents(
  hre: HardhatRuntimeEnvironment,
  network: ActivationNetwork
): Promise<void> {
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  await assertVaultActivationSharedState(hre, network, blockNumber);
  const snapshot = await readVaultActivationSnapshot(hre, network, blockNumber);
  if (
    network === "base" &&
    !assertBaseVaultActionPhase(
      "release-matured",
      snapshot,
      expectedVaultActivationState("base")
    )
  ) {
    return;
  }
  if (snapshot.lockProof.releasable.length === 0) {
    console.log(`No matured predecessor intents to release on ${network}`);
    return;
  }
  const expected = expectedVaultActivationState(network);
  const transaction = buildVaultReleaseMaturedTransaction(
    expected.addresses.predecessorPolicy,
    snapshot.lockProof.releasable,
    hre.ethers.utils.Interface
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

export function buildVaultReleaseMaturedTransaction(
  predecessorPolicy: string,
  releasable: string[],
  InterfaceConstructor: typeof utils.Interface
): NormalizedSafeBatchTransaction {
  const policyInterface = new InterfaceConstructor([
    "function releaseMaturedDisputeProtectionIntents(bytes32[] intentHashes)",
  ]);
  return {
    to: normalizedAddress(predecessorPolicy),
    value: "0",
    data: policyInterface
      .encodeFunctionData("releaseMaturedDisputeProtectionIntents", [
        releasable,
      ])
      .toLowerCase(),
    operation: 0,
  };
}

export async function deployActivationContract(
  hre: HardhatRuntimeEnvironment,
  artifactName: string,
  constructorArgs: unknown[]
): Promise<ContractIdentity> {
  return deployLegacyActivationContract(hre, artifactName, constructorArgs);
}

export async function runPinnedSimulation(
  manifest: VaultActivationBatchManifest,
  forkRpcUrl: string
): Promise<void> {
  await runLegacyPinnedSimulation(manifest as never, forkRpcUrl);
}

type BaseAction = VaultActivationBatchKind | "release-matured";

export function assertBaseVaultActionPhase(
  action: BaseAction,
  snapshot: VaultActivationSnapshot,
  expected: VaultExpectedActivationState
): boolean {
  const reduction = reduceVaultActivation(snapshot, expected);
  if (reduction.phase === "unrecognized") {
    assertRecognizedVaultActivationState(
      "Base dedicated-vault activation state is unrecognized",
      snapshot,
      reduction
    );
  }
  if (action === "vault-cutover" && reduction.phase === "active") {
    console.log(
      "=== Base method-scoped dedicated-vault cutover is active; nothing to prepare ==="
    );
    return false;
  }
  if (
    action === "vault-writer-removal" &&
    reduction.phase === "writer-removed"
  ) {
    console.log(
      "=== Base predecessor writer is removed; nothing to prepare ==="
    );
    return false;
  }
  if (action === "release-matured") {
    return reduction.phase !== "writer-removed";
  }
  const requiredPhase = action === "vault-cutover" ? "deployed" : "active";
  if (reduction.phase !== requiredPhase || reduction.waiting !== null) {
    throw new Error(
      `${action} batch requires ${requiredPhase} with no waiting condition`
    );
  }
  return true;
}

type BasePreparationOverrides = {
  repositoryRoot?: string;
  artifactRoot?: string;
  assertArtifactGitState?: typeof assertActivationArtifactGitState;
  deployContract?: typeof deployActivationContract;
  verifyCandidate?: typeof verifyVaultActivationCandidate;
  installArtifactPair?: typeof installSafeArtifactPair;
  simulate?: typeof runPinnedSimulation;
};

async function prepareBaseVaultBatch(
  hre: HardhatRuntimeEnvironment,
  kind: VaultActivationBatchKind,
  overrides: BasePreparationOverrides = {}
): Promise<void> {
  const sourceSha = (process.env[FLAGS.releaseReadySha] || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(
      `Base batch preparation requires an exact ${FLAGS.releaseReadySha}`
    );
  }
  const repositoryRoot = overrides.repositoryRoot || resolve(__dirname, "..");
  (overrides.assertArtifactGitState || assertActivationArtifactGitState)(
    repositoryRoot,
    sourceSha,
    "generation",
    []
  );
  const forkRpcUrl = process.env[FLAGS.forkRpcUrl] || "";
  if (!forkRpcUrl) {
    throw new Error("BASE_FORK_RPC_URL is required for Base batch preparation");
  }

  const proofBlockNumber = await hre.ethers.provider.getBlockNumber();
  await assertVaultActivationSharedState(hre, "base", proofBlockNumber);
  const proofSnapshot = await readVaultActivationSnapshot(
    hre,
    "base",
    proofBlockNumber
  );
  const expected = expectedVaultActivationState("base");
  if (!assertBaseVaultActionPhase(kind, proofSnapshot, expected)) return;

  const trustSurface = buildVaultTrustSurface(expected);
  const includeVaultAcceptOwnership =
    !sameAddress(proofSnapshot.freshVault.owner, expected.addresses.safe) &&
    sameAddress(proofSnapshot.freshVault.pendingOwner, expected.addresses.safe);
  const includePolicyAcceptOwnership =
    !sameAddress(proofSnapshot.freshPolicy.owner, expected.addresses.safe) &&
    sameAddress(
      proofSnapshot.freshPolicy.pendingOwner,
      expected.addresses.safe
    );
  const guardArgs: unknown[] =
    kind === "vault-cutover"
      ? [
          trustSurface,
          includeVaultAcceptOwnership,
          includePolicyAcceptOwnership,
          proofSnapshot.inventory.tuples.map((tuple) => ({
            escrow: tuple.escrow,
            depositId: tuple.depositId,
            paymentMethod: tuple.paymentMethod,
          })),
          proofSnapshot.inventory.escrow,
          proofSnapshot.inventory.depositCounter,
        ]
      : [
          trustSurface,
          proofSnapshot.lockProof.intents.map((intent) => intent.intentHash),
        ];
  const title =
    kind === "vault-cutover" ? "VaultCutover" : "VaultWriterRemoval";
  const deployContract = overrides.deployContract || deployActivationContract;
  const guard = await deployContract(
    hre,
    `DisputeMethodScoped${title}Guard`,
    guardArgs
  );
  const postcondition = await deployContract(
    hre,
    `DisputeMethodScoped${title}Postcondition`,
    [trustSurface]
  );
  const simulationBlockNumber = await hre.ethers.provider.getBlockNumber();
  if (simulationBlockNumber <= proofBlockNumber) {
    throw new Error("Simulation block must follow the proof block");
  }
  const simulationBlock = await withBlockLagRetry(
    `Base vault simulation block ${simulationBlockNumber}`,
    () => hre.ethers.provider.getBlock(simulationBlockNumber)
  );
  if (!simulationBlock?.hash) {
    throw new Error("Could not pin the simulation block");
  }
  const simulationSnapshot = await withBlockLagRetry(
    `Base vault simulation snapshot at block ${simulationBlockNumber}`,
    () => readVaultActivationSnapshot(hre, "base", simulationBlockNumber)
  );
  assertVaultGuardExpectationsUnchanged(
    kind,
    proofSnapshot,
    simulationSnapshot
  );
  const transactions =
    kind === "vault-cutover"
      ? buildVaultCutoverTransactions({
          addresses: expected.addresses,
          guard: guard.address,
          includeVaultAcceptOwnership,
          includePolicyAcceptOwnership,
        })
      : buildVaultWriterRemovalTransactions({
          addresses: expected.addresses,
          guard: guard.address,
        });
  const safe = await hre.ethers.getContractAt(
    ["function nonce() view returns (uint256)"],
    BASE_SAFE
  );
  const unsignedManifest: Omit<VaultActivationBatchManifest, "manifestSha256"> =
    {
      version: 3,
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
  const manifest: VaultActivationBatchManifest = {
    ...unsignedManifest,
    manifestSha256: computeVaultManifestSha256(unsignedManifest),
  };
  validateVaultActivationBatchManifest(manifest, manifest);
  const batch = vaultSafeBatchJson(
    kind,
    transactions,
    simulationBlock.timestamp * 1000
  );
  const paths = VAULT_ACTIVATION_BATCH_PATHS[kind];
  const artifactRoot = overrides.artifactRoot || repositoryRoot;
  const artifactPaths = {
    batch: resolve(artifactRoot, paths.batch),
    sidecar: resolve(artifactRoot, paths.sidecar),
  };
  const simulate = overrides.simulate || runPinnedSimulation;
  const verifyCandidate =
    overrides.verifyCandidate || verifyVaultActivationCandidate;
  await verifyCandidate(hre, {
    kind,
    batch,
    manifest,
    mode: "generation",
    repositoryRoot,
    forkRpcUrl,
    artifactPaths,
    lane: {
      loadVaultActivationContext,
      expectedVaultActivationState,
      readVaultActivationSnapshot,
      runPinnedSimulation: simulate,
    },
  });
  (overrides.installArtifactPair || installSafeArtifactPair)({
    batchPath: artifactPaths.batch,
    sidecarPath: artifactPaths.sidecar,
    supersededDir: resolve(artifactRoot, paths.supersededDir),
    batchContents: `${JSON.stringify(batch, null, 2)}\n`,
    sidecarContents: `${JSON.stringify(manifest, null, 2)}\n`,
    supersededSuffix: `${simulationBlockNumber}_${manifest.manifestSha256.slice(
      0,
      12
    )}`,
  });
  console.log(
    `Prepared and simulated Base ${kind} Safe batch: ${artifactPaths.batch}`
  );
  console.log("No Safe transaction was signed, proposed, or executed.");
}

export async function prepareBaseVaultCutoverBatch(
  hre: HardhatRuntimeEnvironment,
  overrides?: BasePreparationOverrides
): Promise<void> {
  await prepareBaseVaultBatch(hre, "vault-cutover", overrides);
}

export async function prepareBaseVaultWriterRemovalBatch(
  hre: HardhatRuntimeEnvironment,
  overrides?: BasePreparationOverrides
): Promise<void> {
  await prepareBaseVaultBatch(hre, "vault-writer-removal", overrides);
}

const actionFlags = [
  FLAGS.stagingPrepare,
  FLAGS.stagingExecute,
  FLAGS.baseCutoverPrepare,
  FLAGS.baseWriterRemovalPrepare,
  FLAGS.baseReleaseMatured,
] as const;

function selectedFlags(): string[] {
  return actionFlags.filter((flag) => process.env[flag] === "true");
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") {
    throw new Error("no predecessor stack on local networks");
  }
  if (process.env.DEPLOY_ACTIVE_TAG !== TAG) {
    throw new Error(`Lane 40 activation requires DEPLOY_ACTIVE_TAG=${TAG}`);
  }
  if (!isLiveNetwork(network)) return;
  if (network === "base_staging") {
    await prepareOrExecuteStagingActivation(hre);
    return;
  }
  requireVaultActivationConfirmations("base");
  if (process.env[FLAGS.baseCutoverPrepare] === "true") {
    await prepareBaseVaultCutoverBatch(hre);
  } else if (process.env[FLAGS.baseWriterRemovalPrepare] === "true") {
    await prepareBaseVaultWriterRemovalBatch(hre);
  } else if (process.env[FLAGS.baseReleaseMatured] === "true") {
    await releaseMaturedPredecessorIntents(hre, "base");
  } else {
    throw new Error("Select exactly one Base lane-40 action flag");
  }
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  const selected = selectedFlags();
  const tagged = process.env.DEPLOY_ACTIVE_TAG === TAG;
  if (selected.length > 0 && !tagged) {
    throw new Error(`Lane 40 flags require DEPLOY_ACTIVE_TAG=${TAG}`);
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
      process.env[FLAGS.baseCutoverPrepare] === "true" ||
      process.env[FLAGS.baseWriterRemovalPrepare] === "true" ||
      process.env[FLAGS.baseReleaseMatured] === "true"
    ) {
      throw new Error("Base lane-40 flag selected on Base staging");
    }
  } else if (
    process.env[FLAGS.stagingPrepare] === "true" ||
    process.env[FLAGS.stagingExecute] === "true"
  ) {
    throw new Error("Base staging lane-40 flag selected on Base");
  } else if (selected.length > 1) {
    throw new Error("Select exactly one Base lane-40 action flag");
  }
  return selected.length === 0;
};

func.tags = [TAG, "V3DisputeMethodScopedVaultActivation"];
func.dependencies = [];

export default func;
