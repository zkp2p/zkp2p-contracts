import { spawnSync } from "child_process";
import { resolve } from "path";
import type { BigNumber, Contract, providers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";
import {
  BYPASS_ARTIFACT_NAMES,
  BYPASS_DEPLOYMENT_NAMES,
  BYPASS_EXPECTED_LIVE,
  BYPASS_PREDECESSOR_DEPLOYMENT_NAMES,
  LANE_46_TAG,
  expectedPaymentMethodCurrencies,
  isBypassLiveNetwork,
  paymentMethodHash,
} from "../deployments/bypassDisputeStack";
import type { BypassNetwork } from "../deployments/bypassDisputeStack";
import {
  BYPASS_ACTIVATION_NETWORKS,
  assertBypassAdvance,
  assertBypassGuardExpectationsUnchanged,
  buildBypassActionTransaction,
  buildBypassCutoverTransactions,
  buildBypassInventory,
  buildBypassTrustSurface,
  bypassActivationActions,
  bypassInventoryTupleArgs,
  bypassTrustSurfaceTuple,
  reduceBypassActivation,
} from "../deployments/bypassDisputeActivation";
import type {
  BypassActivationNetwork,
  BypassActivationReduction,
  BypassActivationSnapshot,
  BypassExpectedActivationState,
  BypassInventory,
  BypassInventoryTuple,
} from "../deployments/bypassDisputeActivation";
import {
  BYPASS_ACTIVATION_BATCH_PATHS,
  bypassSafeBatchJson,
  computeBypassManifestSha256,
  validateBypassActivationBatchManifest,
} from "../deployments/bypassActivationBatchManifest";
import type { BypassActivationBatchManifest } from "../deployments/bypassActivationBatchManifest";
import {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
} from "../deployments/canonicalDeployment";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  MULTI_SIG,
  RETIRED_DISPUTABLE_PAYMENT_METHODS,
  USDC,
} from "../deployments/parameters";
import { installSafeArtifactPair } from "../deployments/safeArtifacts";
import { canonicalTransactionHash } from "../deployments/safeBatchManifest";
import {
  EXPECTED_LIVE,
  FORBIDDEN_POLICY_LIFECYCLE_EVENTS,
  classifyFreshStackActivity,
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
  assertBypassArtifactGitState,
  verifyBypassActivationCandidate,
} from "../scripts/verify-bypass-dispute-safe-batch";

export { assertBypassAdvance };
export const TAG = LANE_46_TAG;
export const SUPPORTED_NETWORKS = new Set<string>(BYPASS_ACTIVATION_NETWORKS);
export const FLAGS = {
  stagingPrepare: "PREPARE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION",
  stagingExecute: "ENABLE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION",
  baseCutoverPrepare: "ENABLE_BASE_V3_DISPUTE_BYPASS_CUTOVER_PREPARATION",
  confirmActivation: (network: BypassNetwork) =>
    `CONFIRM_${
      network === "base" ? "BASE" : "STAGING"
    }_V3_DISPUTE_BYPASS_ACTIVATION`,
  confirmDownstreamReady: (network: BypassNetwork) =>
    `CONFIRM_${
      network === "base" ? "BASE" : "STAGING"
    }_V3_DISPUTE_BYPASS_DOWNSTREAM_READY`,
  releaseReadySha: "CONFIRM_BASE_V3_DISPUTE_BYPASS_RELEASE_READY_SHA",
  forkRpcUrl: "BASE_FORK_RPC_URL",
} as const;

const RECORD_NAMES = {
  escrow: "EscrowV2",
  freshVault: "StakeVaultBypass",
  freshPolicy: "DisputeProtectionPolicyBypass",
  freshHook: "IntentLifecycleHookV1Bypass",
  verifier: "UnifiedPaymentVerifierV4",
  retiredVerifier: "UnifiedPaymentVerifierV3",
  predecessorVault: BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.vault,
  predecessorPolicy: BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.policy,
  predecessorHook: BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.hook,
  disputeRegistry: "DisputeNullifierRegistry",
  nullifierRegistryV2: "NullifierRegistryV2",
  paymentVerifierRegistry: "PaymentVerifierRegistry",
  orchestrator: "OrchestratorV3",
  orchestratorRegistry: "OrchestratorRegistry",
  escrowRegistry: "EscrowRegistry",
  relayerRegistry: "RelayerRegistry",
  whitelistPolicy: "WhitelistPolicyMethodScoped",
  groupRegistry: "AddressGroupRegistry",
} as const;
type RecordKey = keyof typeof RECORD_NAMES;
type ActivationContext = {
  expected: BypassExpectedActivationState;
  records: Record<RecordKey, Deployment>;
  simpleAttestation: boolean;
};
// Preserve the target catalog while the executor temporarily removes registry rows.
const expectedCache = new Map<
  BypassActivationNetwork,
  BypassExpectedActivationState
>();
const contextCache = new Map<BypassActivationNetwork, ActivationContext>();
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
function readConcurrency(): number {
  const raw = process.env.BYPASS_READ_CONCURRENCY;
  if (raw === undefined) return 16;
  const value = Number(raw);
  requireState(
    /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(value) && value <= 64,
    "BYPASS_READ_CONCURRENCY must be an integer from 1 to 64"
  );
  return value;
}
async function pagedLogs(
  hre: HardhatRuntimeEnvironment,
  filter: Omit<providers.Filter, "fromBlock" | "toBlock">,
  from: number,
  to: number
): Promise<providers.Log[]> {
  if (from > to) return [];
  async function readRange(
    start: number,
    end: number
  ): Promise<providers.Log[]> {
    try {
      return await hre.ethers.provider.getLogs({
        ...filter,
        fromBlock: start,
        toBlock: end,
      });
    } catch (error) {
      if (start === end) throw error;
      const middle = start + Math.floor((end - start) / 2);
      const left = await readRange(start, middle);
      const right = await readRange(middle + 1, end);
      return left.concat(right);
    }
  }
  const logs = await readRange(from, to);
  return logs.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex
  );
}

type RecordPin = {
  name: string;
  artifact: string;
  address: string;
  hash?: string;
};
function liveRecordPins(network: BypassNetwork): RecordPin[] {
  const p = BYPASS_EXPECTED_LIVE[network];
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
          BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.vault,
          "StakeVault",
          p.predecessorVault,
        ],
        [
          BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.policy,
          "DisputeProtectionPolicy",
          p.predecessorPolicy,
        ],
        [
          BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.hook,
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
  network: BypassActivationNetwork,
  blockTag: string | number
): Promise<void> {
  for (const name of BYPASS_DEPLOYMENT_NAMES) {
    await assertCanonicalDeployment(
      hre,
      await hre.deployments.get(name),
      name,
      BYPASS_ARTIFACT_NAMES[name],
      blockTag
    );
  }
  if (!isBypassLiveNetwork(network)) return;
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

export async function resolveBypassActivationContext(
  hre: HardhatRuntimeEnvironment,
  network: BypassActivationNetwork,
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
  const live = isBypassLiveNetwork(network)
    ? BYPASS_EXPECTED_LIVE[network]
    : null;
  const governance = lower(live ? MULTI_SIG[network] || deployer : deployer);
  if (live) {
    requireState(
      governance === lower(live.governance) &&
        deployer === lower(live.deployer),
      "Bypass activation governance or deployer mismatch"
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
  const shared = isBypassLiveNetwork(network) ? EXPECTED_LIVE[network] : null;
  const addresses: BypassExpectedActivationState["addresses"] = {
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
  const riskWindows: Record<string, string> = Object.fromEntries(
    paymentMethods.map(({ paymentMethod }) => [paymentMethod, "0"])
  );
  for (const name of RETIRED_DISPUTABLE_PAYMENT_METHODS)
    riskWindows[lower(paymentMethodHash(name))] = "0";
  for (const name of DISPUTABLE_PAYMENT_METHODS) {
    riskWindows[lower(paymentMethodHash(name))] = live
      ? live.riskWindows[name] || "0"
      : decimal(DISPUTE_RISK_WINDOW[network]);
  }
  const expected: BypassExpectedActivationState = {
    network,
    governance,
    deployer,
    addresses,
    paymentMethods,
    riskWindows,
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
export async function loadBypassActivationContext(
  hre: HardhatRuntimeEnvironment,
  network: BypassActivationNetwork
): Promise<void> {
  if (!expectedCache.has(network))
    await resolveBypassActivationContext(hre, network);
}
export function expectedBypassActivationState(
  network: BypassActivationNetwork
): BypassExpectedActivationState {
  const expected = expectedCache.get(network);
  if (!expected)
    throw new Error(
      `Bypass activation deployment records for ${network} have not been loaded`
    );
  return expected;
}
async function contextAt(
  hre: HardhatRuntimeEnvironment,
  network: BypassActivationNetwork,
  block: string | number
): Promise<ActivationContext> {
  return (
    contextCache.get(network) ||
    resolveBypassActivationContext(hre, network, block)
  );
}

async function authorizedHooks(
  hre: HardhatRuntimeEnvironment,
  record: Deployment,
  block: number
): Promise<string[]> {
  const iface = new hre.ethers.utils.Interface(record.abi);
  const logs = await pagedLogs(
    hre,
    {
      address: record.address,
      topics: [iface.getEventTopic("LifecycleHookAuthorizationUpdated")],
    },
    deploymentBlock(record),
    block
  );
  const authorized = new Map<string, boolean>();
  for (const log of logs) {
    const { args } = iface.parseLog(log);
    requireState(
      typeof args.hook === "string" && typeof args.isAuthorized === "boolean",
      "Invalid lifecycle authorization event"
    );
    authorized.set(lower(args.hook), args.isAuthorized);
  }
  return [...authorized].filter(([, enabled]) => enabled).map(([hook]) => hook);
}
async function readInventory(
  hre: HardhatRuntimeEnvironment,
  context: ActivationContext,
  block: number,
  riskWindows: Record<string, string>
): Promise<BypassInventory> {
  const { addresses: a } = context.expected;
  const record = context.records.predecessorPolicy;
  const iface = new hre.ethers.utils.Interface(record.abi);
  const logs = await pagedLogs(
    hre,
    {
      address: record.address,
      topics: [
        iface.getEventTopic("DisputeProtectionEnabledUpdated"),
        hre.ethers.utils.hexZeroPad(a.escrow, 32),
      ],
    },
    deploymentBlock(record),
    block
  );
  const distinct = new Map<string, BypassInventoryTuple>();
  for (const log of logs) {
    const { args } = iface.parseLog(log);
    const tuple = {
      escrow: lower(args.escrow),
      depositId: decimal(args.depositId),
      paymentMethod: lower(args.paymentMethod),
    };
    distinct.set(
      `${tuple.escrow}:${tuple.depositId}:${tuple.paymentMethod}`,
      tuple
    );
  }
  const escrow = await hre.ethers.getContractAt("EscrowV2", a.escrow);
  const predecessor = await hre.ethers.getContractAt(
    "DisputeProtectionPolicy",
    a.predecessorPolicy
  );
  const fresh = await hre.ethers.getContractAt(
    "DisputeProtectionPolicy",
    a.freshPolicy
  );
  const tuples = await mapWithConcurrency(
    [...distinct.values()],
    readConcurrency(),
    async (tuple) => {
      const deposit = await read<{ depositor: string }>(
        escrow,
        "getDeposit",
        [tuple.depositId],
        block
      );
      return {
        ...tuple,
        depositor: lower(deposit.depositor),
        listedPaymentMethods: (
          await read<string[]>(
            escrow,
            "getDepositPaymentMethods",
            [tuple.depositId],
            block
          )
        ).map(lower),
        predecessorEnabled: await read<boolean>(
          predecessor,
          "isDisputeProtectionEnabled",
          [tuple.escrow, tuple.depositId, tuple.paymentMethod],
          block
        ),
        freshEnabled: await read<boolean>(
          fresh,
          "isDisputeProtectionEnabled",
          [tuple.escrow, tuple.depositId, tuple.paymentMethod],
          block
        ),
      };
    }
  );
  return buildBypassInventory({
    escrow: a.escrow,
    block: decimal(block),
    freshRiskWindows: riskWindows,
    tuples,
  });
}

export async function readBypassActivationSnapshot(
  hre: HardhatRuntimeEnvironment,
  network: BypassActivationNetwork,
  blockTag: string | number
): Promise<BypassActivationSnapshot> {
  const block = await hre.ethers.provider.getBlock(blockTag);
  requireState(
    !!block?.hash,
    `Bypass activation block ${blockTag} is unavailable`
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
  const vault = await at("StakeVault", a.freshVault);
  const policy = await at("DisputeProtectionPolicy", a.freshPolicy);
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
  const whitelist = await at("WhitelistPolicy", a.whitelistPolicy);
  const attestation = await at(
    context.simpleAttestation
      ? "SimpleAttestationVerifier"
      : "MultiAttestationVerifier",
    a.attestationVerifier
  );
  const disputeVerifier = await at("DisputeVerifier", a.disputeVerifier);
  const riskWindows = Object.fromEntries(
    await mapWithConcurrency(
      Object.keys(context.expected.riskWindows),
      readConcurrency(),
      async (method) => [
        lower(method),
        await number(policy, "getRiskWindow", [method]),
      ]
    )
  );
  return {
    network,
    blockNumber: decimal(block.number),
    blockHash: lower(block.hash),
    blockTimestamp: decimal(block.timestamp),
    freshVault: {
      ...(await ownership(vault)),
      controller: await address(vault, "controller"),
      pendingController: await address(vault, "pendingController"),
      pendingControllerValidAt: await number(vault, "pendingControllerValidAt"),
      controllerChangeDelay: await number(vault, "controllerChangeDelay"),
      stakeToken: await address(vault, "stakeToken"),
    },
    freshPolicy: {
      ...(await ownership(policy)),
      admissionsPaused: await bool(policy, "admissionsPaused"),
      stakeVault: await address(policy, "stakeVault"),
      disputeVerifier: await address(policy, "disputeVerifier"),
      disputeNullifierRegistry: await address(
        policy,
        "disputeNullifierRegistry"
      ),
      authorizedHooks: await authorizedHooks(
        hre,
        context.records.freshPolicy,
        block.number
      ),
      riskWindows,
    },
    freshHook: await hook(await at("IntentLifecycleHookV1", a.freshHook)),
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
    inventory: await readInventory(hre, context, block.number, riskWindows),
  };
}

function recognized(
  snapshot: BypassActivationSnapshot,
  expected: BypassExpectedActivationState
): BypassActivationReduction {
  const reduction = reduceBypassActivation(snapshot, expected);
  requireState(
    reduction.phase !== "unrecognized",
    `Bypass activation state is unrecognized: ${reduction.violations.join(
      ", "
    )}`
  );
  return reduction;
}
/** Unlike lane 45, activation admits each recognized prefix. Fresh lifecycle
 * activity is legitimate only after O3 has switched to the successor hook. */
export async function assertBypassActivationSharedState(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork,
  blockTag: string | number
): Promise<BypassActivationSnapshot> {
  const block = await hre.ethers.provider.getBlock(blockTag);
  requireState(!!block, `Bypass activation block ${blockTag} is unavailable`);
  const pins = BYPASS_EXPECTED_LIVE[network];
  const [deployer] = await hre.getUnnamedAccounts();
  requireState(
    (await hre.ethers.provider.getNetwork()).chainId === 8453,
    "Bypass activation chain ID mismatch"
  );
  requireState(
    typeof deployer === "string" && lower(deployer) === lower(pins.deployer),
    "Deployment signer does not match the approved deployer"
  );
  requireState(
    lower(USDC[network]) === lower(pins.stakeToken),
    "Bypass activation USDC target mismatch"
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
  const snapshot = await readBypassActivationSnapshot(
    hre,
    network,
    block.number
  );
  const record = context.records.freshPolicy;
  const events = decodeFreshStackLogs(
    new hre.ethers.utils.Interface(record.abi),
    await pagedLogs(
      hre,
      { address: record.address },
      deploymentBlock(record),
      block.number
    ),
    "DisputeProtectionPolicyBypass"
  );
  const beforeCutover =
    snapshot.orchestrator.lifecycleHook ===
    context.expected.addresses.predecessorHook;
  classifyFreshStackActivity({
    policyEvents: beforeCutover
      ? events
      : events.filter(
          (event) =>
            !FORBIDDEN_POLICY_LIFECYCLE_EVENTS.some(
              (name) => name === event.name
            )
        ),
  });
  recognized(snapshot, context.expected);
  return snapshot;
}

/** Downstream readiness confirms UPV4-domain attestations with the bypass flag and
 * clients encoding intent.data = abi.encode(policy, abi.encode(bool noStake)). */
function requireConfirmations(network: BypassNetwork): void {
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
  network: BypassActivationNetwork
) {
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  const snapshot = isBypassLiveNetwork(network)
    ? await assertBypassActivationSharedState(hre, network, blockNumber)
    : await readBypassActivationSnapshot(hre, network, blockNumber);
  const expected = expectedBypassActivationState(network);
  const reduction = recognized(snapshot, expected);
  const transaction = reduction.nextAction
    ? buildBypassActionTransaction(reduction.nextAction, expected)
    : null;
  return { blockNumber, snapshot, expected, reduction, transaction };
}
function logActive(snapshot: BypassActivationSnapshot): void {
  console.log(
    `=== ${snapshot.network} bypass dispute activation is active ===`
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
      "Bypass activation has no next transaction"
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
        "Base staging bypass activation state changed after preflight"
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
    assertBypassAdvance(before.reduction, after.reduction);
    console.log(
      `${network} bypass activation advanced exactly one action: ${before.reduction.nextAction}`
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
    "Base staging bypass activation has no next transaction"
  );
  const remaining = bypassActivationActions(
    state.expected.paymentMethods.map((method) => method.paymentMethod)
  ).slice(state.reduction.completedActions);
  for (const action of remaining)
    console.log(
      `Remaining bypass action: ${action}; ${JSON.stringify(
        buildBypassActionTransaction(action, state.expected)
      )}`
    );
  const preflight = await preflightStagingTransaction(
    hre,
    state.transaction,
    state.expected.deployer,
    state.blockNumber
  );
  console.log(
    `Base staging next bypass activation call: ${
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
    "Local bypass activation requires localhost or hardhat"
  );
  await executeActivation(hre, network);
}

export async function runPinnedSimulation(
  manifest: BypassActivationBatchManifest,
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
      resolve(repositoryRoot, "scripts/simulate-bypass-dispute-safe-batch.ts"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_FORK_RPC_URL: forkRpcUrl,
        DISPUTE_BYPASS_SAFE_SIMULATION_PAYLOAD: JSON.stringify({ manifest }),
      },
    }
  );
  if (result.error) throw result.error;
  requireState(
    result.status === 0,
    `Pinned Base bypass Safe simulation failed:\n${result.stdout || ""}${
      result.stderr || ""
    }`
  );
}
export type BasePreparationOverrides = {
  repositoryRoot?: string;
  artifactRoot?: string;
  assertArtifactGitState?: typeof assertBypassArtifactGitState;
  deployContract?: typeof deployActivationContract;
  verifyCandidate?: typeof verifyBypassActivationCandidate;
  installArtifactPair?: typeof installSafeArtifactPair;
  simulate?: typeof runPinnedSimulation;
};
export async function prepareBaseCutoverBatch(
  hre: HardhatRuntimeEnvironment,
  overrides: BasePreparationOverrides = {}
): Promise<void> {
  const sourceSha = (process.env[FLAGS.releaseReadySha] || "").toLowerCase();
  requireState(
    /^[0-9a-f]{40}$/.test(sourceSha),
    `Base batch preparation requires an exact ${FLAGS.releaseReadySha}`
  );
  const repositoryRoot = overrides.repositoryRoot || resolve(__dirname, "..");
  (overrides.assertArtifactGitState || assertBypassArtifactGitState)(
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
  await assertBypassActivationSharedState(hre, "base", proofBlockNumber);
  const proofSnapshot = await readBypassActivationSnapshot(
    hre,
    "base",
    proofBlockNumber
  );
  const expected = expectedBypassActivationState("base");
  const reduction = recognized(proofSnapshot, expected);
  if (reduction.phase === "active") {
    console.log("=== Base bypass cutover is active; nothing to prepare ===");
    return;
  }
  requireState(
    reduction.phase === "deployed" && proofSnapshot.inventory.ok,
    "Base bypass batch requires deployed phase with inventory ok"
  );
  const trustSurface = buildBypassTrustSurface(expected, proofSnapshot);
  const includeVaultAcceptOwnership =
    proofSnapshot.freshVault.owner !== expected.addresses.safe &&
    proofSnapshot.freshVault.pendingOwner === expected.addresses.safe;
  const includePolicyAcceptOwnership =
    proofSnapshot.freshPolicy.owner !== expected.addresses.safe &&
    proofSnapshot.freshPolicy.pendingOwner === expected.addresses.safe;
  const deployContract = overrides.deployContract || deployActivationContract;
  const guard = await deployContract(hre, "DisputeBypassCutoverGuard", [
    bypassTrustSurfaceTuple(trustSurface),
    includeVaultAcceptOwnership,
    includePolicyAcceptOwnership,
    bypassInventoryTupleArgs(proofSnapshot.inventory),
  ]);
  const postcondition = await deployContract(
    hre,
    "DisputeBypassCutoverPostcondition",
    [bypassTrustSurfaceTuple(trustSurface)]
  );
  const simulationBlockNumber = await hre.ethers.provider.getBlockNumber();
  requireState(
    simulationBlockNumber > proofBlockNumber,
    "Simulation block must follow the proof block"
  );
  const simulationBlock = await withBlockLagRetry(
    `Base bypass simulation block ${simulationBlockNumber}`,
    () => hre.ethers.provider.getBlock(simulationBlockNumber)
  );
  requireState(!!simulationBlock?.hash, "Could not pin the simulation block");
  const simulationSnapshot = await withBlockLagRetry(
    `Base bypass simulation snapshot at block ${simulationBlockNumber}`,
    () => readBypassActivationSnapshot(hre, "base", simulationBlockNumber)
  );
  assertBypassGuardExpectationsUnchanged(proofSnapshot, simulationSnapshot);
  const transactions = buildBypassCutoverTransactions({
    expected,
    guard: guard.address,
    includeVaultAcceptOwnership,
    includePolicyAcceptOwnership,
  });
  const safe = await hre.ethers.getContractAt(
    ["function nonce() view returns (uint256)"],
    expected.addresses.safe
  );
  const unsigned: Omit<BypassActivationBatchManifest, "manifestSha256"> = {
    version: 4,
    kind: "dispute-bypass-cutover",
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
  const manifest: BypassActivationBatchManifest = {
    ...unsigned,
    manifestSha256: computeBypassManifestSha256(unsigned),
  };
  validateBypassActivationBatchManifest(manifest, manifest);
  const batch = bypassSafeBatchJson(
    transactions,
    simulationBlock.timestamp * 1000
  );
  const paths = BYPASS_ACTIVATION_BATCH_PATHS;
  const artifactRoot = overrides.artifactRoot || repositoryRoot;
  const artifactPaths = {
    batch: resolve(artifactRoot, paths.batch),
    sidecar: resolve(artifactRoot, paths.sidecar),
  };
  await (overrides.verifyCandidate || verifyBypassActivationCandidate)(hre, {
    batch,
    manifest,
    mode: "generation",
    repositoryRoot,
    forkRpcUrl,
    artifactPaths,
    lane: {
      loadBypassActivationContext,
      expectedBypassActivationState,
      readBypassActivationSnapshot,
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
    `Prepared and simulated Base dispute-bypass-cutover Safe batch: ${artifactPaths.batch}`
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
func.tags = [TAG, "V3DisputeBypassActivation"];
func.dependencies = [];
export default func;
