import { spawnSync } from "child_process";
import { resolve } from "path";
import { utils } from "ethers";
import type { BigNumber, Contract, providers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";
import {
  O4_DEPLOYMENT_NAMES,
  O4_RECORDED_DEPLOYMENTS,
  O4_EXPECTED_LIVE,
  O4_PREDECESSOR_DEPLOYMENT_NAMES,
  LANE_46_TAG,
  assertO4DeploymentRecord,
  expectedPaymentMethodCurrencies,
  isO4LiveNetwork,
  paymentMethodHash,
} from "../deployments/orchestratorV4Stack";
import type { O4Network } from "../deployments/orchestratorV4Stack";
import {
  O4_ACTIVATION_NETWORKS,
  assertO4Advance,
  assertO4GuardExpectationsUnchanged,
  buildO4ActionTransaction,
  buildO4CutoverTransactions,
  buildO4TrustSurface,
  o4ActivationActions,
  o4TrustSurfaceTuple,
  reduceO4Activation,
} from "../deployments/orchestratorV4Activation";
import type {
  O4ActivationNetwork,
  O4ActivationReduction,
  O4ActivationSnapshot,
  O4ExpectedActivationState,
} from "../deployments/orchestratorV4Activation";
import {
  O4_ACTIVATION_BATCH_PATHS,
  o4SafeBatchJson,
  computeO4ManifestSha256,
  validateO4ActivationBatchManifest,
} from "../deployments/orchestratorV4ActivationBatchManifest";
import type { O4ActivationBatchManifest } from "../deployments/orchestratorV4ActivationBatchManifest";
import { assertDeploymentMatchesChain } from "../deployments/canonicalDeployment";
import { waitForDeploymentDelay } from "../deployments/helpers";
import { MULTI_SIG, USDC } from "../deployments/parameters";
import { installSafeArtifactPair } from "../deployments/safeArtifacts";
import { canonicalTransactionHash } from "../deployments/safeBatchManifest";
import {
  EXPECTED_LIVE,
  decodeFreshStackLogs,
} from "./37_deploy_method_scoped_dispute_lifecycle_stack";
import {
  deployActivationContract,
  mapWithConcurrency,
  preflightStagingTransaction,
  requireStableStagingNonce,
  withBlockLagRetry,
} from "./38_activate_method_scoped_dispute_lifecycle_stack";
import {
  assertO4ArtifactGitState,
  verifyO4ActivationCandidate,
} from "../scripts/verify-orchestrator-v4-safe-batch";
import { classifyO4PolicyActivity } from "./45_deploy_orchestrator_v4_stack";
export {
  O4_POLICY_LIFECYCLE_EVENTS,
  classifyO4PolicyActivity,
} from "./45_deploy_orchestrator_v4_stack";

export { assertO4Advance };
export const TAG = LANE_46_TAG;
export const SUPPORTED_NETWORKS = new Set<string>(O4_ACTIVATION_NETWORKS);
export const FLAGS = {
  stagingPrepare: "PREPARE_STAGING_ORCHESTRATOR_V4_ACTIVATION",
  stagingExecute: "ENABLE_STAGING_ORCHESTRATOR_V4_ACTIVATION",
  baseCutoverPrepare: "ENABLE_BASE_ORCHESTRATOR_V4_CUTOVER_PREPARATION",
  confirmActivation: (network: O4Network) =>
    `CONFIRM_${
      network === "base" ? "BASE" : "STAGING"
    }_ORCHESTRATOR_V4_ACTIVATION`,
  confirmDownstreamReady: (network: O4Network) =>
    `CONFIRM_${
      network === "base" ? "BASE" : "STAGING"
    }_ORCHESTRATOR_V4_DOWNSTREAM_READY`,
  releaseReadySha: "CONFIRM_BASE_ORCHESTRATOR_V4_RELEASE_READY_SHA",
  forkRpcUrl: "BASE_FORK_RPC_URL",
} as const;

const RECORD_NAMES = {
  escrow: "EscrowV2",
  freshVault: "StakeVaultV2",
  freshPolicy: "DisputeProtectionPolicyV2",
  verifier: "UnifiedPaymentVerifierV4",
  retiredVerifier: "UnifiedPaymentVerifierV3",
  predecessorVault: O4_PREDECESSOR_DEPLOYMENT_NAMES.vault,
  predecessorPolicy: O4_PREDECESSOR_DEPLOYMENT_NAMES.policy,
  predecessorHook: O4_PREDECESSOR_DEPLOYMENT_NAMES.hook,
  disputeRegistry: "DisputeNullifierRegistry",
  nullifierRegistryV2: "NullifierRegistryV2",
  paymentVerifierRegistry: "PaymentVerifierRegistry",
  orchestrator: "OrchestratorV3",
  orchestratorV4: "OrchestratorV4",
  orchestratorRegistry: "OrchestratorRegistry",
  escrowRegistry: "EscrowRegistry",
  relayerRegistry: "RelayerRegistry",
  whitelistPolicy: "WhitelistPolicyMethodScoped",
  freshWhitelistPolicy: "WhitelistPolicyV4",
  groupRegistry: "AddressGroupRegistry",
  freshGroupRegistry: "AddressGroupRegistryV4",
} as const;
type RecordKey = keyof typeof RECORD_NAMES;
type ActivationContext = {
  expected: O4ExpectedActivationState;
  records: Record<RecordKey, Deployment>;
  simpleAttestation: boolean;
};
// Preserve the target catalog while the executor temporarily removes registry rows.
const expectedCache = new Map<
  O4ActivationNetwork,
  O4ExpectedActivationState
>();
const contextCache = new Map<O4ActivationNetwork, ActivationContext>();
const lower = (value: string): string => value.toLowerCase();
const decimal = (value: BigNumber | string | number): string =>
  value.toString();
function requireState(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function read<T>(
  contract: Contract,
  method: string,
  args: unknown[],
  blockTag: string | number
): Promise<T> {
  return contract[method](...args, { blockTag }) as Promise<T>;
}
function deploymentBlock(record: Deployment): number {
  const block = record.receipt?.blockNumber;
  requireState(
    typeof block === "number" && Number.isSafeInteger(block) && block >= 0,
    `${record.address} lacks deployment block evidence`
  );
  return block;
}
const LOG_PAGE_SIZE = 10_000;
async function pagedLogs(
  provider: providers.Provider,
  filter: Omit<providers.Filter, "fromBlock" | "toBlock">,
  fromBlock: number,
  toBlock: number
): Promise<providers.Log[]> {
  const logs: providers.Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_PAGE_SIZE) {
    const end = Math.min(toBlock, start + LOG_PAGE_SIZE - 1);
    logs.push(
      ...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }))
    );
  }
  return logs;
}
function readConcurrency(): number {
  const raw = process.env.O4_READ_CONCURRENCY;
  if (raw === undefined) return 16;
  const value = Number(raw);
  requireState(
    /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(value) && value <= 64,
    "O4_READ_CONCURRENCY must be an integer from 1 to 64"
  );
  return value;
}

type RecordPin = {
  name: string;
  artifact: string;
  address: string;
  hash?: string;
};
function liveRecordPins(network: O4Network): RecordPin[] {
  const p = O4_EXPECTED_LIVE[network];
  const e = EXPECTED_LIVE[network];
  return [
    {
      name: "OrchestratorV3",
      artifact: "OrchestratorV3",
      address: e.orchestrator,
      hash: e.orchestratorCodeHash,
    },
    {
      name: "OrchestratorRegistry",
      artifact: "OrchestratorRegistry",
      address: e.orchestratorRegistry,
      hash: e.orchestratorRegistryCodeHash,
    },
    {
      name: "NullifierRegistryV2",
      artifact: "NullifierRegistryV2",
      address: e.nullifierRegistryV2,
      hash: e.nullifierRegistryV2CodeHash,
    },
    {
      name: "MultiAttestationVerifier",
      artifact: "MultiAttestationVerifier",
      address: e.attestationVerifier,
      hash: e.attestationVerifierCodeHash,
    },
    { name: "EscrowV2", artifact: "EscrowV2", address: p.escrow },
    ...(
      [
        [
          "UnifiedPaymentVerifierV3",
          "UnifiedPaymentVerifierV3",
          p.unifiedPaymentVerifierV3,
        ],
        [
          "PaymentVerifierRegistry",
          "PaymentVerifierRegistry",
          p.paymentVerifierRegistry,
        ],
        ["DisputeVerifier", "DisputeVerifier", p.disputeVerifier],
        [
          "DisputeNullifierRegistry",
          "NullifierRegistry",
          p.disputeNullifierRegistry,
        ],
        ["WhitelistPolicyMethodScoped", "WhitelistPolicy", p.whitelistPolicy],
        [
          O4_PREDECESSOR_DEPLOYMENT_NAMES.vault,
          "StakeVault",
          p.predecessorVault,
        ],
        [
          O4_PREDECESSOR_DEPLOYMENT_NAMES.policy,
          "DisputeProtectionPolicy",
          p.predecessorPolicy,
        ],
        [
          O4_PREDECESSOR_DEPLOYMENT_NAMES.hook,
          "IntentLifecycleHookV1",
          p.predecessorHook,
        ],
      ] as const
    ).map(([name, artifact, pin]) => ({
      name,
      artifact,
      address: pin.address,
      hash: pin.runtimeCodeHash,
    })),
  ];
}
async function verifyRecords(
  hre: HardhatRuntimeEnvironment,
  network: O4ActivationNetwork,
  blockTag: string | number
): Promise<void> {
  for (const name of O4_DEPLOYMENT_NAMES) {
    const record = await hre.deployments.get(name);
    await assertO4DeploymentRecord(hre, network, name, record, blockTag);
  }
  if (!isO4LiveNetwork(network)) return;
  for (const pin of liveRecordPins(network)) {
    const record = await hre.deployments.get(pin.name);
    requireState(
      lower(record.address) === lower(pin.address),
      `${pin.name} deployment address mismatch`
    );
    await assertDeploymentMatchesChain(
      hre,
      record,
      pin.name,
      pin.artifact,
      blockTag
    );
    const code = await hre.ethers.provider.getCode(pin.address, blockTag);
    requireState(
      code !== "0x" &&
        (!pin.hash ||
          lower(hre.ethers.utils.keccak256(code)) === lower(pin.hash)),
      `${pin.name} runtime bytecode hash mismatch`
    );
  }
}

export async function resolveO4ActivationContext(
  hre: HardhatRuntimeEnvironment,
  network: O4ActivationNetwork,
  blockTag?: string | number
): Promise<ActivationContext> {
  const block = blockTag ?? (await hre.ethers.provider.getBlockNumber());
  await verifyRecords(hre, network, block);
  const records = Object.fromEntries(
    await Promise.all(
      Object.entries(RECORD_NAMES).map(async ([key, name]) => [
        key,
        await hre.deployments.get(name),
      ])
    )
  ) as Record<RecordKey, Deployment>;
  const multi = await hre.deployments.getOrNull("MultiAttestationVerifier");
  const attestation =
    multi || (await hre.deployments.get("SimpleAttestationVerifier"));
  const [account] = await hre.getUnnamedAccounts();
  requireState(typeof account === "string", "Deployment signer is missing");
  const deployer = lower(account);
  const live = isO4LiveNetwork(network)
    ? O4_EXPECTED_LIVE[network]
    : null;
  const governance = lower(live ? MULTI_SIG[network] || deployer : deployer);
  if (live) {
    requireState(
      governance === lower(live.governance) &&
        deployer === lower(live.deployer),
      "O4 activation governance or deployer mismatch"
    );
  }
  const orchestrator = await hre.ethers.getContractAt(
    "OrchestratorV3",
    records.orchestrator.address
  );
  const whitelist = await hre.ethers.getContractAt(
    "WhitelistPolicy",
    records.whitelistPolicy.address
  );
  const verifier = await hre.ethers.getContractAt(
    multi ? "MultiAttestationVerifier" : "SimpleAttestationVerifier",
    attestation.address
  );
  const shared = isO4LiveNetwork(network) ? EXPECTED_LIVE[network] : null;
  const addresses: O4ExpectedActivationState["addresses"] = {
    ...(Object.fromEntries(
      Object.entries(records).map(([key, record]) => [
        key,
        lower(record.address),
      ])
    ) as Record<RecordKey, string>),
    safe: governance,
    deployer,
    protocolFeeRecipient: lower(
      shared
        ? shared.protocolFeeRecipient
        : await read<string>(orchestrator, "protocolFeeRecipient", [], block)
    ),
    attestationVerifier: lower(attestation.address),
    disputeVerifier: lower(
      (await hre.deployments.get("DisputeVerifier")).address
    ),
    stakeToken: lower(
      live
        ? live.stakeToken
        : USDC[network] || (await hre.deployments.get("USDCMock")).address
    ),
  };
  if (shared) {
    for (const [key, pin] of Object.entries({
      escrowRegistry: shared.escrowRegistry,
      relayerRegistry: shared.relayerRegistry,
      groupRegistry: shared.addressGroupRegistry,
    })) {
      requireState(
        addresses[key as keyof typeof addresses] === lower(pin),
        `${key} deployment address mismatch`
      );
    }
  }
  const registry = await hre.ethers.getContractAt(
    "PaymentVerifierRegistry",
    addresses.paymentVerifierRegistry
  );
  const paymentMethods = live
    ? live.paymentMethods.map((name) => ({
        paymentMethod: lower(paymentMethodHash(name)),
        currencies: expectedPaymentMethodCurrencies(name)
          .map(paymentMethodHash)
          .map(lower),
      }))
    : await mapWithConcurrency(
        await read<string[]>(registry, "getPaymentMethods", [], block),
        readConcurrency(),
        async (method) => ({
          paymentMethod: lower(method),
          currencies: (
            await read<string[]>(registry, "getCurrencies", [method], block)
          ).map(lower),
        })
      );
  requireState(
    paymentMethods.length > 0 &&
      new Set(paymentMethods.map((method) => method.paymentMethod)).size ===
        paymentMethods.length,
    "Invalid activation payment catalog"
  );
  const expected: O4ExpectedActivationState = {
    network,
    chainId: String(
      live ? 8453 : (await hre.ethers.provider.getNetwork()).chainId
    ),
    retainedDisputeWriters: live
      ? live.retainedDisputeWriters.map(lower)
      : [addresses.predecessorPolicy],
    governance,
    deployer,
    addresses,
    paymentMethods,
    protocolFee: live
      ? "0"
      : decimal(await read<BigNumber>(orchestrator, "protocolFee", [], block)),
    allowedWhitelistPolicyOwners: live
      ? live.allowedWhitelistPolicyOwners.map(lower)
      : [lower(await read<string>(whitelist, "owner", [], block))],
    witnesses: shared
      ? shared.attestationWitnesses.map(lower)
      : multi
      ? (await read<string[]>(verifier, "witnesses", [], block)).map(lower)
      : [lower(await read<string>(verifier, "witness", [], block))],
    allowMultipleIntents: shared
      ? shared.allowMultipleIntents
      : await read<boolean>(orchestrator, "allowMultipleIntents", [], block),
  };
  const context = { expected, records, simpleAttestation: !multi };
  expectedCache.set(network, expected);
  contextCache.set(network, context);
  return context;
}
export async function loadO4ActivationContext(
  hre: HardhatRuntimeEnvironment,
  network: O4ActivationNetwork
): Promise<void> {
  if (!expectedCache.has(network))
    await resolveO4ActivationContext(hre, network);
}
export function expectedO4ActivationState(
  network: O4ActivationNetwork
): O4ExpectedActivationState {
  const expected = expectedCache.get(network);
  if (!expected)
    throw new Error(
      `O4 activation deployment records for ${network} have not been loaded`
    );
  return expected;
}
async function contextAt(
  hre: HardhatRuntimeEnvironment,
  network: O4ActivationNetwork,
  block: string | number
): Promise<ActivationContext> {
  return (
    contextCache.get(network) ||
    resolveO4ActivationContext(hre, network, block)
  );
}

export async function readO4ActivationSnapshot(
  hre: HardhatRuntimeEnvironment,
  network: O4ActivationNetwork,
  blockTag: string | number
): Promise<O4ActivationSnapshot> {
  const block = await hre.ethers.provider.getBlock(blockTag);
  requireState(
    !!block?.hash,
    `O4 activation block ${blockTag} is unavailable`
  );
  // Resolve symbolic tags once; all subsequent reads and logs use this exact block.
  const context = await contextAt(hre, network, block.number);
  const a = context.expected.addresses;
  const at = (artifact: string, address: string) =>
    hre.ethers.getContractAt(artifact, address);
  const address = async (c: Contract, fn: string, args: unknown[] = []) =>
    lower(await read<string>(c, fn, args, block.number));
  const number = async (c: Contract, fn: string, args: unknown[] = []) =>
    decimal(await read<BigNumber>(c, fn, args, block.number));
  const bool = (c: Contract, fn: string, args: unknown[] = []) =>
    read<boolean>(c, fn, args, block.number);
  const list = async (c: Contract, fn: string) =>
    (await read<string[]>(c, fn, [], block.number)).map(lower);
  const ownership = async (c: Contract) => ({
    owner: await address(c, "owner"),
    pendingOwner: await address(c, "pendingOwner"),
  });
  const hook = async (c: Contract) => ({
    orchestratorRegistry: await address(c, "orchestratorRegistry"),
    whitelistPolicy: await address(c, "whitelistPolicy"),
    disputeProtectionPolicy: await address(c, "disputeProtectionPolicy"),
  });
  const registry = async (c: Contract) => ({
    owner: await address(c, "owner"),
    writers: await list(c, "getWriters"),
  });
  const vault = await at("StakeVaultV2", a.freshVault);
  const policy = await at("DisputeProtectionPolicyV2", a.freshPolicy);
  const predecessorVault = await at("StakeVault", a.predecessorVault);
  const predecessorPolicy = await at(
    "DisputeProtectionPolicy",
    a.predecessorPolicy
  );
  const verifier = await at("UnifiedPaymentVerifierV4", a.verifier);
  const retired = await at("UnifiedPaymentVerifierV3", a.retiredVerifier);
  const paymentRegistry = await at(
    "PaymentVerifierRegistry",
    a.paymentVerifierRegistry
  );
  const orchestrator = await at("OrchestratorV3", a.orchestrator);
  const orchestratorV4 = await at("OrchestratorV4", a.orchestratorV4);
  const orchestratorRegistry = await at(
    "OrchestratorRegistry",
    a.orchestratorRegistry
  );
  const whitelist = await at("WhitelistPolicy", a.whitelistPolicy);
  const freshWhitelist = await at("WhitelistPolicy", a.freshWhitelistPolicy);
  const attestation = await at(
    context.simpleAttestation
      ? "SimpleAttestationVerifier"
      : "MultiAttestationVerifier",
    a.attestationVerifier
  );
  const disputeVerifier = await at("DisputeVerifier", a.disputeVerifier);
  return {
    network,
    blockNumber: decimal(block.number),
    blockHash: lower(block.hash),
    blockTimestamp: decimal(block.timestamp),
    freshVault: {
      ...(await ownership(vault)),
      policyAuthorized: await bool(vault, "isController", [a.freshPolicy]),
      stakeToken: await address(vault, "stakeToken"),
    },
    freshPolicy: {
      ...(await ownership(policy)),
      stakeVault: await address(policy, "stakeVault"),
      disputeVerifier: await address(policy, "disputeVerifier"),
      disputeNullifierRegistry: await address(
        policy,
        "disputeNullifierRegistry"
      ),
      orchestratorRegistry: await address(policy, "orchestratorRegistry"),
    },
    verifier: {
      owner: await address(verifier, "owner"),
      orchestratorRegistry: await address(verifier, "orchestratorRegistry"),
      nullifierRegistry: await address(verifier, "nullifierRegistry"),
      attestationVerifier: await address(verifier, "attestationVerifier"),
      paymentMethods: await list(verifier, "getPaymentMethods"),
    },
    retiredVerifier: {
      owner: await address(retired, "owner"),
      paymentMethods: await list(retired, "getPaymentMethods"),
    },
    predecessorVault: {
      owner: await address(predecessorVault, "owner"),
      controller: await address(predecessorVault, "controller"),
      pendingController: await address(predecessorVault, "pendingController"),
    },
    predecessorPolicy: {
      ...(await ownership(predecessorPolicy)),
      stakeVault: await address(predecessorPolicy, "stakeVault"),
      disputeVerifier: await address(predecessorPolicy, "disputeVerifier"),
      disputeNullifierRegistry: await address(
        predecessorPolicy,
        "disputeNullifierRegistry"
      ),
      predecessorHookAuthorized: await bool(
        predecessorPolicy,
        "isLifecycleHookAuthorized",
        [a.predecessorHook]
      ),
    },
    predecessorHook: await hook(
      await at("IntentLifecycleHookV1", a.predecessorHook)
    ),
    disputeRegistry: await registry(
      await at("NullifierRegistry", a.disputeRegistry)
    ),
    nullifierRegistryV2: await registry(
      await at("NullifierRegistryV2", a.nullifierRegistryV2)
    ),
    paymentVerifierRegistry: {
      owner: await address(paymentRegistry, "owner"),
      methods: await mapWithConcurrency(
        await list(paymentRegistry, "getPaymentMethods"),
        readConcurrency(),
        async (method) => ({
          paymentMethod: method,
          verifier: await address(paymentRegistry, "getVerifier", [method]),
          currencies: (
            await read<string[]>(
              paymentRegistry,
              "getCurrencies",
              [method],
              block.number
            )
          ).map(lower),
        })
      ),
    },
    orchestrator: {
      owner: await address(orchestrator, "owner"),
      paused: await bool(orchestrator, "paused"),
      lifecycleHook: await address(orchestrator, "lifecycleHook"),
      escrowRegistry: await address(orchestrator, "escrowRegistry"),
      paymentVerifierRegistry: await address(
        orchestrator,
        "paymentVerifierRegistry"
      ),
      relayerRegistry: await address(orchestrator, "relayerRegistry"),
      protocolFee: await number(orchestrator, "protocolFee"),
      protocolFeeRecipient: await address(orchestrator, "protocolFeeRecipient"),
      allowMultipleIntents: await bool(orchestrator, "allowMultipleIntents"),
      registered: await bool(
        await at("OrchestratorRegistry", a.orchestratorRegistry),
        "isOrchestrator",
        [a.orchestrator]
      ),
    },
    orchestratorV4: {
      chainId: await number(orchestratorV4, "chainId"),
      owner: await address(orchestratorV4, "owner"),
      paused: await bool(orchestratorV4, "paused"),
      settlementPolicy: await address(orchestratorV4, "settlementPolicy"),
      whitelistPolicy: await address(orchestratorV4, "whitelistPolicy"),
      escrowRegistry: await address(orchestratorV4, "escrowRegistry"),
      paymentVerifierRegistry: await address(
        orchestratorV4,
        "paymentVerifierRegistry"
      ),
      relayerRegistry: await address(orchestratorV4, "relayerRegistry"),
      protocolFee: await number(orchestratorV4, "protocolFee"),
      protocolFeeRecipient: await address(
        orchestratorV4,
        "protocolFeeRecipient"
      ),
      allowMultipleIntents: await bool(orchestratorV4, "allowMultipleIntents"),
      registered: await bool(
        await at("OrchestratorRegistry", a.orchestratorRegistry),
        "isOrchestrator",
        [a.orchestratorV4]
      ),
    },
    orchestratorRegistry: {
      owner: await address(orchestratorRegistry, "owner"),
    },
    freshWhitelistPolicy: {
      owner: await address(freshWhitelist, "owner"),
      escrowRegistry: await address(freshWhitelist, "escrowRegistry"),
      groupRegistry: await address(freshWhitelist, "groupRegistry"),
      orchestratorRegistry: await address(freshWhitelist, "orchestratorRegistry"),
    },
    whitelistPolicy: {
      owner: await address(whitelist, "owner"),
      escrowRegistry: await address(whitelist, "escrowRegistry"),
      groupRegistry: await address(whitelist, "groupRegistry"),
      orchestratorRegistry: await address(whitelist, "orchestratorRegistry"),
    },
    attestationVerifier: {
      owner: await address(attestation, "owner"),
      requiredSignatures: await number(
        attestation,
        context.simpleAttestation
          ? "MIN_WITNESS_SIGNATURES"
          : "requiredSignatures"
      ),
      witnesses: context.simpleAttestation
        ? [await address(attestation, "witness")]
        : await list(attestation, "witnesses"),
    },
    disputeVerifier: {
      ...(await ownership(disputeVerifier)),
      attestationVerifier: await address(
        disputeVerifier,
        "attestationVerifier"
      ),
      nullifierRegistry: await address(disputeVerifier, "nullifierRegistry"),
    },
  };
}

function recognized(
  snapshot: O4ActivationSnapshot,
  expected: O4ExpectedActivationState
): O4ActivationReduction {
  const reduction = reduceO4Activation(snapshot, expected);
  requireState(
    reduction.phase !== "unrecognized",
    `O4 activation state is unrecognized: ${reduction.violations.join(
      ", "
    )}`
  );
  return reduction;
}
/** Unlike lane 45, activation admits each recognized prefix. Fresh lifecycle
 * activity is legitimate only after O4 has been registered. */
export async function assertO4ActivationSharedState(
  hre: HardhatRuntimeEnvironment,
  network: O4Network,
  blockTag: string | number
): Promise<O4ActivationSnapshot> {
  const block = await hre.ethers.provider.getBlock(blockTag);
  requireState(!!block, `O4 activation block ${blockTag} is unavailable`);
  const pins = O4_EXPECTED_LIVE[network];
  const [deployer] = await hre.getUnnamedAccounts();
  requireState(
    (await hre.ethers.provider.getNetwork()).chainId === 8453,
    "O4 activation chain ID mismatch"
  );
  requireState(
    typeof deployer === "string" && lower(deployer) === lower(pins.deployer),
    "Deployment signer does not match the approved deployer"
  );
  requireState(
    lower(USDC[network]) === lower(pins.stakeToken),
    "O4 activation USDC target mismatch"
  );
  await verifyRecords(hre, network, block.number);
  requireState(
    (await hre.ethers.provider.getCode(pins.stakeToken, block.number)) !== "0x",
    "USDC has no runtime bytecode"
  );
  const context = await contextAt(hre, network, block.number);
  // Cached targets must still refer to the current records, never silently follow replacements.
  for (const [key, name] of Object.entries(RECORD_NAMES)) {
    requireState(
      lower((await hre.deployments.get(name)).address) ===
        context.expected.addresses[key as RecordKey],
      `${name} cached activation address mismatch`
    );
  }
  const snapshot = await readO4ActivationSnapshot(
    hre,
    network,
    block.number
  );
  const record = context.records.freshPolicy;
  const events = decodeFreshStackLogs(
    new hre.ethers.utils.Interface(record.abi),
    await pagedLogs(
      hre.ethers.provider,
      { address: record.address },
      deploymentBlock(record),
      block.number
    ),
    "DisputeProtectionPolicyV2"
  );
  const beforeCutover = !snapshot.orchestratorV4.registered;
  classifyO4PolicyActivity(events, beforeCutover);
  recognized(snapshot, context.expected);
  return snapshot;
}

/** Downstream readiness confirms UPV4 settlement-data attestations for both
 * orchestrators and clients routing new intents to O4. */
function requireConfirmations(network: O4Network): void {
  for (const flag of [
    FLAGS.confirmActivation(network),
    FLAGS.confirmDownstreamReady(network),
  ]) {
    requireState(
      process.env[flag] === "true",
      `Set ${flag}=true before activation`
    );
  }
}
async function readPinnedState(
  hre: HardhatRuntimeEnvironment,
  network: O4ActivationNetwork
) {
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  const snapshot = isO4LiveNetwork(network)
    ? await assertO4ActivationSharedState(hre, network, blockNumber)
    : await readO4ActivationSnapshot(hre, network, blockNumber);
  const expected = expectedO4ActivationState(network);
  const reduction = recognized(snapshot, expected);
  const transaction = reduction.nextAction
    ? buildO4ActionTransaction(reduction.nextAction, expected)
    : null;
  return { blockNumber, snapshot, expected, reduction, transaction };
}
function logActive(snapshot: O4ActivationSnapshot): void {
  console.log(
    `=== ${snapshot.network} OrchestratorV4 activation is active ===`
  );
  console.log(JSON.stringify(snapshot, null, 2));
}

/** Staging/local resume a verified action prefix; Base must switch atomically so
 * users cannot observe a partially rerouted production payment catalog.
 * The predecessor dispute writer stays until its old intents drain in a later lane. */
async function executeActivation(
  hre: HardhatRuntimeEnvironment,
  network: "base_staging" | "localhost" | "hardhat"
): Promise<void> {
  for (;;) {
    const before = await readPinnedState(hre, network);
    if (before.reduction.phase === "active") {
      logActive(before.snapshot);
      return;
    }
    requireState(
      before.transaction !== null,
      "O4 activation has no next transaction"
    );
    const signer = await hre.ethers.getSigner(before.expected.deployer);
    if (network === "base_staging") {
      const preflight = await preflightStagingTransaction(
        hre,
        before.transaction,
        before.expected.deployer,
        before.blockNumber
      );
      const execution = await readPinnedState(hre, network);
      requireState(
        execution.transaction !== null &&
          execution.reduction.nextAction === before.reduction.nextAction &&
          JSON.stringify(execution.transaction) ===
            JSON.stringify(before.transaction),
        "Base staging O4 activation state changed after preflight"
      );
      const executionPreflight = await preflightStagingTransaction(
        hre,
        execution.transaction,
        before.expected.deployer,
        execution.blockNumber
      );
      requireStableStagingNonce(preflight.nonce, executionPreflight.nonce);
      await (await signer.sendTransaction(executionPreflight.request)).wait();
    } else {
      const { to, value, data } = before.transaction;
      await (await signer.sendTransaction({ to, value, data })).wait();
    }
    await waitForDeploymentDelay(hre);
    const after = await readPinnedState(hre, network);
    assertO4Advance(before.reduction, after.reduction);
    console.log(
      `${network} O4 activation advanced exactly one action: ${before.reduction.nextAction}`
    );
  }
}
export async function prepareOrExecuteStagingActivation(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const preparing = process.env[FLAGS.stagingPrepare] === "true";
  const executing = process.env[FLAGS.stagingExecute] === "true";
  requireState(
    preparing !== executing,
    `Set exactly one of ${FLAGS.stagingPrepare}=true or ${FLAGS.stagingExecute}=true`
  );
  requireConfirmations("base_staging");
  if (executing) {
    await executeActivation(hre, "base_staging");
    return;
  }
  const state = await readPinnedState(hre, "base_staging");
  if (state.reduction.phase === "active") {
    logActive(state.snapshot);
    return;
  }
  requireState(
    state.transaction !== null && state.reduction.completedActions !== null,
    "Base staging O4 activation has no next transaction"
  );
  const remaining = o4ActivationActions(
    state.expected.paymentMethods.map((method) => method.paymentMethod)
  ).slice(state.reduction.completedActions);
  for (const action of remaining)
    console.log(
      `Remaining O4 action: ${action}; ${JSON.stringify(
        buildO4ActionTransaction(action, state.expected)
      )}`
    );
  const preflight = await preflightStagingTransaction(
    hre,
    state.transaction,
    state.expected.deployer,
    state.blockNumber
  );
  console.log(
    `Base staging next O4 activation call: ${
      state.reduction.nextAction
    }; nonce=${preflight.nonce}; gas=${preflight.gasLimit.toString()}`
  );
}
export async function activateLocal(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  requireState(
    network === "localhost" || network === "hardhat",
    "Local O4 activation requires localhost or hardhat"
  );
  await executeActivation(hre, network);
}

export async function runPinnedSimulation(
  manifest: O4ActivationBatchManifest,
  forkRpcUrl: string
): Promise<void> {
  const repositoryRoot = resolve(__dirname, "..");
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("hardhat/internal/cli/cli"),
      "run",
      "--network",
      "hardhat",
      "--no-compile",
      resolve(repositoryRoot, "scripts/simulate-orchestrator-v4-safe-batch.ts"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_FORK_RPC_URL: forkRpcUrl,
        ORCHESTRATOR_V4_SAFE_SIMULATION_PAYLOAD: JSON.stringify({ manifest }),
      },
    }
  );
  if (result.error) throw result.error;
  requireState(
    result.status === 0,
    `Pinned Base O4 Safe simulation failed:\n${result.stdout || ""}${
      result.stderr || ""
    }`
  );
}
export type BasePreparationOverrides = {
  repositoryRoot?: string;
  artifactRoot?: string;
  assertArtifactGitState?: typeof assertO4ArtifactGitState;
  deployContract?: typeof deployActivationContract;
  verifyCandidate?: typeof verifyO4ActivationCandidate;
  installArtifactPair?: typeof installSafeArtifactPair;
  simulate?: typeof runPinnedSimulation;
};
function requireBaseRecordedPins(): void {
  for (const name of O4_DEPLOYMENT_NAMES) {
    const pin = O4_RECORDED_DEPLOYMENTS.base?.[name];
    requireState(
      !!pin?.address && !!pin.runtimeCodeHash,
      `Base batch preparation requires recorded pin: ${name}`
    );
  }
}

export async function assertBaseRecordedDeployments(
  hre: HardhatRuntimeEnvironment,
  blockTag: number
): Promise<void> {
  requireBaseRecordedPins();
  for (const name of O4_DEPLOYMENT_NAMES) {
    const record = await hre.deployments.get(name);
    await assertO4DeploymentRecord(hre, "base", name, record, blockTag);
  }
}

export async function prepareBaseCutoverBatch(
  hre: HardhatRuntimeEnvironment,
  overrides: BasePreparationOverrides = {}
): Promise<void> {
  const sourceSha = (process.env[FLAGS.releaseReadySha] || "").toLowerCase();
  requireState(
    /^[0-9a-f]{40}$/.test(sourceSha),
    `Base batch preparation requires an exact ${FLAGS.releaseReadySha}`
  );
  requireBaseRecordedPins();
  const repositoryRoot = overrides.repositoryRoot || resolve(__dirname, "..");
  (overrides.assertArtifactGitState || assertO4ArtifactGitState)(
    repositoryRoot,
    sourceSha,
    "generation"
  );
  const forkRpcUrl = process.env[FLAGS.forkRpcUrl] || "";
  requireState(
    !!forkRpcUrl,
    "BASE_FORK_RPC_URL is required for Base batch preparation"
  );
  const proofBlockNumber = await hre.ethers.provider.getBlockNumber();
  await assertBaseRecordedDeployments(hre, proofBlockNumber);
  await assertO4ActivationSharedState(hre, "base", proofBlockNumber);
  const proofSnapshot = await readO4ActivationSnapshot(
    hre,
    "base",
    proofBlockNumber
  );
  const expected = expectedO4ActivationState("base");
  const reduction = recognized(proofSnapshot, expected);
  if (reduction.phase === "active") {
    console.log("=== Base O4 cutover is active; nothing to prepare ===");
    return;
  }
  requireState(
    reduction.phase === "deployed",
    "Base O4 batch requires deployed phase"
  );
  const trustSurface = buildO4TrustSurface(expected, proofSnapshot);
  const includeVaultAcceptOwnership =
    proofSnapshot.freshVault.owner !== expected.addresses.safe &&
    proofSnapshot.freshVault.pendingOwner === expected.addresses.safe;
  const includePolicyAcceptOwnership =
    proofSnapshot.freshPolicy.owner !== expected.addresses.safe &&
    proofSnapshot.freshPolicy.pendingOwner === expected.addresses.safe;
  const deployContract = overrides.deployContract || deployActivationContract;
  const guard = await deployContract(hre, "OrchestratorV4CutoverGuard", [
    o4TrustSurfaceTuple(trustSurface),
    includeVaultAcceptOwnership,
    includePolicyAcceptOwnership,
  ]);
  const postcondition = await deployContract(
    hre,
    "OrchestratorV4CutoverPostcondition",
    [o4TrustSurfaceTuple(trustSurface)]
  );
  const simulationBlockNumber = await hre.ethers.provider.getBlockNumber();
  requireState(
    simulationBlockNumber > proofBlockNumber,
    "Simulation block must follow the proof block"
  );
  const simulationBlock = await withBlockLagRetry(
    `Base O4 simulation block ${simulationBlockNumber}`,
    () => hre.ethers.provider.getBlock(simulationBlockNumber)
  );
  requireState(!!simulationBlock?.hash, "Could not pin the simulation block");
  const simulationSnapshot = await withBlockLagRetry(
    `Base O4 simulation snapshot at block ${simulationBlockNumber}`,
    () => readO4ActivationSnapshot(hre, "base", simulationBlockNumber)
  );
  assertO4GuardExpectationsUnchanged(proofSnapshot, simulationSnapshot);
  const transactions = buildO4CutoverTransactions({
    expected,
    guard: guard.address,
    includeVaultAcceptOwnership,
    includePolicyAcceptOwnership,
  });
  const safe = await hre.ethers.getContractAt(
    ["function nonce() view returns (uint256)"],
    expected.addresses.safe
  );
  const unsigned: Omit<O4ActivationBatchManifest, "manifestSha256"> = {
    version: 12,
    kind: "orchestrator-v4-cutover",
    chainId: 8453,
    safe: expected.addresses.safe,
    safeNonce: decimal(
      await read<BigNumber>(safe, "nonce", [], simulationBlockNumber)
    ),
    sourceSha,
    proofBlock: {
      number: Number(proofSnapshot.blockNumber),
      hash: proofSnapshot.blockHash,
    },
    simulationBlockNumber,
    simulationBlockHash: lower(simulationBlock.hash),
    simulationResult: "success",
    transactions,
    transactionsSha256: canonicalTransactionHash(transactions),
    guard,
    postcondition,
    trustSurface,
    proofSnapshot,
  };
  const manifest: O4ActivationBatchManifest = {
    ...unsigned,
    manifestSha256: computeO4ManifestSha256(unsigned),
  };
  validateO4ActivationBatchManifest(manifest, manifest);
  const batch = o4SafeBatchJson(
    transactions,
    simulationBlock.timestamp * 1000
  );
  const paths = O4_ACTIVATION_BATCH_PATHS;
  const artifactRoot = overrides.artifactRoot || repositoryRoot;
  const artifactPaths = {
    batch: resolve(artifactRoot, paths.batch),
    sidecar: resolve(artifactRoot, paths.sidecar),
  };
  await (overrides.verifyCandidate || verifyO4ActivationCandidate)(hre, {
    batch,
    manifest,
    mode: "generation",
    repositoryRoot,
    forkRpcUrl,
    artifactPaths,
    lane: {
      loadO4ActivationContext,
      expectedO4ActivationState,
      readO4ActivationSnapshot,
      runPinnedSimulation: overrides.simulate || runPinnedSimulation,
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
    `Prepared and simulated Base orchestrator-v4-cutover Safe batch: ${artifactPaths.batch}`
  );
  console.log("No Safe transaction was signed, proposed, or executed.");
}

const actionFlags = [
  FLAGS.stagingPrepare,
  FLAGS.stagingExecute,
  FLAGS.baseCutoverPrepare,
];
function validateActionFlags(network: string): void {
  if (actionFlags.some((flag) => process.env[flag] === "true")) {
    requireState(
      process.env.DEPLOY_ACTIVE_TAG === TAG,
      `Lane 46 flags require DEPLOY_ACTIVE_TAG=${TAG}`
    );
  }
  if (network === "base_staging") {
    requireState(
      process.env[FLAGS.baseCutoverPrepare] !== "true",
      "Base lane-46 flag selected on Base staging"
    );
    requireState(
      !(
        process.env[FLAGS.stagingPrepare] === "true" &&
        process.env[FLAGS.stagingExecute] === "true"
      ),
      `Set exactly one of ${FLAGS.stagingPrepare}=true or ${FLAGS.stagingExecute}=true`
    );
  } else if (network === "base") {
    requireState(
      process.env[FLAGS.stagingPrepare] !== "true" &&
        process.env[FLAGS.stagingExecute] !== "true",
      "Base staging lane-46 flag selected on Base"
    );
  }
}
const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  validateActionFlags(network);
  if (network === "localhost" || network === "hardhat") {
    await activateLocal(hre);
    return;
  }
  requireState(
    process.env.DEPLOY_ACTIVE_TAG === TAG,
    `Lane 46 activation requires DEPLOY_ACTIVE_TAG=${TAG}`
  );
  if (network === "base_staging") {
    await prepareOrExecuteStagingActivation(hre);
    return;
  }
  if (network !== "base") return;
  requireConfirmations("base");
  requireState(
    process.env[FLAGS.baseCutoverPrepare] === "true",
    `Set ${FLAGS.baseCutoverPrepare}=true`
  );
  await prepareBaseCutoverBatch(hre);
};
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  validateActionFlags(network);
  if (network === "localhost" || network === "hardhat") return false;
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (network === "base_staging")
    return !(
      process.env[FLAGS.stagingPrepare] === "true" ||
      process.env[FLAGS.stagingExecute] === "true"
    );
  return process.env[FLAGS.baseCutoverPrepare] !== "true";
};
func.tags = [TAG, "OrchestratorV4Activation"];
func.dependencies = [];
export default func;
