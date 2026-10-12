/** Staging-only replacement after the stake-owner policy change. Base uses 45/46 unchanged.
 * After execution, the trio records are new but bypass pins, evidence and generated outputs
 * remain superseded until a separate recording PR. Do not run untagged/45/46 in that interval.
 * UPV4 and the August predecessor are retained. The superseded trio is abandoned, not migrated.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BigNumber, constants, utils } from "ethers";
import type { Contract } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";
import {
  BYPASS_ARTIFACT_NAMES,
  LANE_45_STEP_KINDS,
  BYPASS_EXPECTED_LIVE,
  BYPASS_PREDECESSOR_DEPLOYMENT_NAMES,
  BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  expectedPaymentMethodCurrencies,
  paymentMethodHash,
} from "../deployments/bypassDisputeStack";
import {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
} from "../deployments/canonicalDeployment";
import type {
  BypassActivationSnapshot,
  BypassExpectedActivationState,
} from "../deployments/bypassDisputeActivation";
import {
  LANE_47_TAG,
  SUPERSEDED,
  SUPERSEDED_POLICY_BLOCK,
  SUPERSEDED_POLICY_RUNTIME_HASH,
  replacementSteps,
  replacementMode,
  isReplacement,
  classifyReplacement,
  assertPolicyBuildChanged,
  assertArtifactSourcesCurrent,
  replacementWriters,
  assertMountedHook,
  assertReplacementActive,
  same,
  requireState,
} from "../deployments/stagingBypassReplacement";
import type { TrioName } from "../deployments/stagingBypassReplacement";
import {
  EXPECTED_LIVE,
  classifyFreshStackActivity,
  decodeFreshStackLogs,
} from "./37_deploy_method_scoped_dispute_lifecycle_stack";
import {
  preflightStagingTransaction,
  requireStableStagingNonce,
  mapWithConcurrency,
} from "./38_activate_method_scoped_dispute_lifecycle_stack";
import { verifyBypassPaymentBinding } from "../deployments/bypassPaymentBinding";
import { waitForDeploymentDelay } from "../deployments/helpers";

const STEPS = replacementSteps(LANE_45_STEP_KINDS.base_staging);
const pins = BYPASS_EXPECTED_LIVE.base_staging;
const shared = EXPECTED_LIVE.base_staging;
const zero = constants.AddressZero;
const lower = (value: string): string => value.toLowerCase();
const decimal = (value: BigNumber | string | number): string => value.toString();
const sameList = (actual: string[], expected: string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => same(value, expected[index]));
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
    typeof block === "number" && Number.isSafeInteger(block) && block > 0,
    `${record.address} lacks deployment block evidence`
  );
  return block;
}
async function policyEvents(
  hre: HardhatRuntimeEnvironment,
  address: string,
  fromBlock: number,
  toBlock: number
) {
  const artifact = await hre.deployments.getExtendedArtifact("DisputeProtectionPolicy");
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += 2000) {
    logs.push(
      ...(await hre.ethers.provider.getLogs({
        address,
        fromBlock: start,
        toBlock: Math.min(start + 1999, toBlock),
      }))
    );
  }
  return { logs, iface: new utils.Interface(artifact.abi) };
}
export async function assertSupersededUnused(
  hre: HardhatRuntimeEnvironment,
  block: number
): Promise<void> {
  const { logs, iface } = await policyEvents(
    hre,
    SUPERSEDED.DisputeProtectionPolicyBypass,
    SUPERSEDED_POLICY_BLOCK,
    block
  );
  try {
    classifyFreshStackActivity({
      policyEvents: decodeFreshStackLogs(iface, logs, "Superseded staging bypass policy"),
    });
  } catch (error) {
    throw new Error(`Lane 47 refuses to remove superseded writer: ${String(error)}`);
  }
}
async function authorizedHooks(
  hre: HardhatRuntimeEnvironment,
  record: Deployment,
  block: number
): Promise<string[]> {
  const { logs, iface } = await policyEvents(hre, record.address, deploymentBlock(record), block);
  const hooks = new Map<string, boolean>();
  for (const log of logs) {
    if (log.topics[0] !== iface.getEventTopic("LifecycleHookAuthorizationUpdated")) continue;
    const { args } = iface.parseLog(log);
    hooks.set(lower(args.hook), args.isAuthorized);
  }
  return [...hooks].filter(([, enabled]) => enabled).map(([hook]) => hook);
}

async function preflight(hre: HardhatRuntimeEnvironment, block: number): Promise<void> {
  requireState(
    hre.deployments.getNetworkName() === "base_staging",
    "Lane 47 requires base_staging"
  );
  requireState(
    (await hre.ethers.provider.getNetwork()).chainId === pins.chainId,
    "Lane 47 chain ID mismatch"
  );
  const [deployer] = await hre.getUnnamedAccounts();
  requireState(
    same(deployer, pins.deployer) && same(deployer, pins.governance),
    "Lane 47 signer is not pinned staging governance"
  );
  // Reuse the mounted lane-31 UPV4 checks; this never loads the trio's stale pins.
  await verifyBypassPaymentBinding(hre, "base_staging");
  const records = [
    ["DisputeNullifierRegistry", "NullifierRegistry", pins.disputeNullifierRegistry],
    ["DisputeVerifier", "DisputeVerifier", pins.disputeVerifier],
    ["WhitelistPolicyMethodScoped", "WhitelistPolicy", pins.whitelistPolicy],
    ["UnifiedPaymentVerifierV3", "UnifiedPaymentVerifierV3", pins.unifiedPaymentVerifierV3],
    [BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.vault, "StakeVault", pins.predecessorVault],
    [BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.policy, "DisputeProtectionPolicy", pins.predecessorPolicy],
    [BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.hook, "IntentLifecycleHookV1", pins.predecessorHook],
  ] as const;
  for (const [name, artifact, pin] of records) {
    const record = await hre.deployments.get(name);
    requireState(same(record.address, pin.address), `Lane 47 ${name} address mismatch`);
    await assertDeploymentMatchesChain(hre, record, name, artifact, block);
    requireState(
      utils.keccak256(await hre.ethers.provider.getCode(pin.address, block)) ===
        pin.runtimeCodeHash,
      `Lane 47 ${name} runtime hash mismatch`
    );
  }
  for (const [name, address] of Object.entries({
    EscrowV2: pins.escrow,
    EscrowRegistry: shared.escrowRegistry,
    RelayerRegistry: shared.relayerRegistry,
    AddressGroupRegistry: shared.addressGroupRegistry,
  })) {
    requireState(
      same((await hre.deployments.get(name)).address, address),
      `Lane 47 ${name} address mismatch`
    );
  }
  const at = (artifact: string, address: string) => hre.ethers.getContractAt(artifact, address);
  const disputeRegistry = await at("NullifierRegistry", pins.disputeNullifierRegistry.address);
  requireState(
    same(await disputeRegistry.owner({ blockTag: block }), pins.governance),
    "Lane 47 dispute registry owner mismatch"
  );
  requireState(
    await disputeRegistry.isWriter(pins.predecessorPolicy.address, {
      blockTag: block,
    }),
    "Lane 47 August predecessor writer missing"
  );
  for (const name of Object.keys(SUPERSEDED) as TrioName[]) {
    const artifactName = BYPASS_ARTIFACT_NAMES[name];
    assertArtifactSourcesCurrent(
      artifactName,
      (await hre.deployments.getExtendedArtifact(artifactName)).metadata,
      (sourceName) => {
        const filename = join(hre.config.paths.root, sourceName);
        return existsSync(filename) ? utils.keccak256(readFileSync(filename)) : undefined;
      }
    );
  }
  const oldCode = await hre.ethers.provider.getCode(
    SUPERSEDED.DisputeProtectionPolicyBypass,
    block
  );
  requireState(
    utils.keccak256(oldCode) === SUPERSEDED_POLICY_RUNTIME_HASH,
    "Lane 47 superseded policy runtime mismatch"
  );
  const artifact = await hre.deployments.getExtendedArtifact("DisputeProtectionPolicy");
  requireState(
    typeof artifact.deployedBytecode === "string",
    "Policy artifact lacks deployed bytecode"
  );
  assertPolicyBuildChanged(artifact.deployedBytecode, oldCode);
}

type ReplacementState = {
  block: number;
  next: number | null;
  records: Partial<Record<TrioName, Deployment>>;
  contracts: Partial<Record<TrioName, Contract>>;
};
export async function readReplacementState(
  hre: HardhatRuntimeEnvironment
): Promise<ReplacementState> {
  const block = await hre.ethers.provider.getBlockNumber();
  await preflight(hre, block);
  const records: ReplacementState["records"] = {};
  const contracts: ReplacementState["contracts"] = {};
  for (const name of Object.keys(SUPERSEDED) as TrioName[]) {
    const record = await hre.deployments.getOrNull(name);
    if (!record || !isReplacement(name, record.address)) continue;
    await assertCanonicalDeployment(hre, record, name, BYPASS_ARTIFACT_NAMES[name], block);
    records[name] = record;
    contracts[name] = await hre.ethers.getContractAt(BYPASS_ARTIFACT_NAMES[name], record.address);
  }
  const vault = contracts.StakeVaultBypass;
  const policy = contracts.DisputeProtectionPolicyBypass;
  const hook = contracts.IntentLifecycleHookV1Bypass;
  const done: Record<string, boolean> = {
    "deploy-vault": !!vault,
    "deploy-policy": !!policy,
    "deploy-hook": !!hook,
  };
  requireState(!policy || !!vault, "Lane 47 replacement policy lacks replacement vault");
  requireState(!hook || !!policy, "Lane 47 replacement hook lacks replacement policy");
  const opts = { blockTag: block };
  for (const contract of [vault, policy])
    if (contract) {
      requireState(
        same(await contract.owner(opts), pins.governance) &&
          same(await contract.pendingOwner(opts), zero),
        `Lane 47 ${contract.address} ownership mismatch`
      );
    }
  if (vault) {
    requireState(
      same(await vault.stakeToken(opts), pins.stakeToken) &&
        BigNumber.from(await vault.controllerChangeDelay(opts)).eq(
          BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY
        ),
      "Lane 47 vault constructor mismatch"
    );
    const controller = await vault.controller(opts);
    const pending = await vault.pendingController(opts);
    requireState(
      same(pending, zero) === BigNumber.from(await vault.pendingControllerValidAt(opts)).isZero(),
      "Lane 47 pending controller evidence mismatch"
    );
    done["initialize-controller"] = !!policy && same(controller, policy.address);
    requireState(
      same(controller, zero) || done["initialize-controller"],
      "Lane 47 vault controller mismatch"
    );
    requireState(
      BigNumber.from(await vault.pendingControllerValidAt(opts)).isZero() ||
        (!done["initialize-controller"] && !!policy && same(pending, policy.address)),
      "Lane 47 pending controller timestamp mismatch"
    );
    requireState(
      same(pending, zero) ||
        (!done["initialize-controller"] && !!policy && same(pending, policy.address)),
      "Lane 47 pending controller mismatch"
    );
  }
  if (policy) {
    requireState(
      same(await policy.stakeVault(opts), vault!.address) &&
        same(await policy.disputeVerifier(opts), pins.disputeVerifier.address) &&
        same(await policy.disputeNullifierRegistry(opts), pins.disputeNullifierRegistry.address) &&
        !(await policy.admissionsPaused(opts)),
      "Lane 47 policy dependency or pause mismatch"
    );
    const hooks = await authorizedHooks(hre, records.DisputeProtectionPolicyBypass!, block);
    requireState(
      hooks.length === 0 || (!!hook && sameList(hooks, [hook.address])),
      "Lane 47 unexpected authorized hook"
    );
    done["authorize-hook"] = !!hook && (await policy.isLifecycleHookAuthorized(hook.address, opts));
    requireState(
      done["authorize-hook"] === (hooks.length === 1),
      "Lane 47 authorization log/state mismatch"
    );
    for (const name of pins.paymentMethods) {
      const actual = BigNumber.from(await policy.getRiskWindow(paymentMethodHash(name), opts));
      const expected = pins.riskWindows[name] || "0";
      requireState(actual.isZero() || actual.eq(expected), `Lane 47 ${name} risk window mismatch`);
      if (pins.riskWindows[name]) done[`set-risk-window:${name}`] = actual.eq(expected);
    }
  }
  if (hook)
    requireState(
      same(await hook.orchestratorRegistry(opts), shared.orchestratorRegistry) &&
        same(await hook.whitelistPolicy(opts), pins.whitelistPolicy.address) &&
        same(await hook.disputeProtectionPolicy(opts), policy!.address),
      "Lane 47 hook immutable mismatch"
    );
  const registry = await hre.ethers.getContractAt(
    "NullifierRegistry",
    pins.disputeNullifierRegistry.address
  );
  const writers: string[] = await registry.getWriters(opts);
  done["add-policy-writer"] = !!policy && writers.some((writer) => same(writer, policy.address));
  done["remove-superseded-writer"] = !writers.some((writer) =>
    same(writer, SUPERSEDED.DisputeProtectionPolicyBypass)
  );
  requireState(
    sameList(
      writers,
      replacementWriters(
        pins.predecessorPolicy.address,
        policy?.address,
        done["add-policy-writer"],
        done["remove-superseded-writer"]
      )
    ),
    "Lane 47 dispute writer order mismatch"
  );
  const orchestrator = await hre.ethers.getContractAt("OrchestratorV3", shared.orchestrator);
  const mounted = await orchestrator.lifecycleHook(opts);
  assertMountedHook(mounted, hook?.address);
  done["set-lifecycle-hook"] = !!hook && same(mounted, hook.address);
  const next = classifyReplacement(
    STEPS.map((step) => done[step] || false),
    STEPS
  );
  return { block, next, records, contracts };
}

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

async function finalContext(hre: HardhatRuntimeEnvironment) {
  const records = Object.fromEntries(
    await Promise.all(
      Object.entries(RECORD_NAMES).map(async ([key, name]) => [
        key,
        await hre.deployments.get(name),
      ])
    )
  ) as Record<keyof typeof RECORD_NAMES, Deployment>;
  const addresses = {
    ...Object.fromEntries(
      Object.entries(records).map(([key, record]) => [key, lower(record.address)])
    ),
    safe: lower(pins.governance),
    deployer: lower(pins.deployer),
    protocolFeeRecipient: lower(shared.protocolFeeRecipient),
    attestationVerifier: lower(shared.attestationVerifier),
    disputeVerifier: lower(pins.disputeVerifier.address),
    stakeToken: lower(pins.stakeToken),
  } as BypassExpectedActivationState["addresses"];
  const expected: BypassExpectedActivationState = {
    network: "base_staging",
    governance: lower(pins.governance),
    deployer: lower(pins.deployer),
    addresses,
    paymentMethods: pins.paymentMethods.map((name) => ({
      paymentMethod: paymentMethodHash(name),
      currencies: expectedPaymentMethodCurrencies(name).map(paymentMethodHash),
    })),
    riskWindows: Object.fromEntries(
      pins.paymentMethods.map((name) => [paymentMethodHash(name), pins.riskWindows[name] || "0"])
    ),
    protocolFee: "0",
    allowedWhitelistPolicyOwners: pins.allowedWhitelistPolicyOwners.map(lower),
    witnesses: shared.attestationWitnesses.map(lower),
    allowMultipleIntents: shared.allowMultipleIntents,
  };
  return { records, expected };
}
// Read the lane-46 snapshot shape at one block, then use its existing reducer.
// Replacement does not migrate deposit opt-outs; inventory is explicitly not evaluated.
async function finalSnapshot(
  hre: HardhatRuntimeEnvironment,
  blockTag: string | number
): Promise<BypassActivationSnapshot> {
  const block = await hre.ethers.provider.getBlock(blockTag);
  requireState(!!block?.hash, `Bypass activation block ${blockTag} is unavailable`);
  // Resolve symbolic tags once; all subsequent reads and logs use this exact block.
  const context = await finalContext(hre);
  const a = context.expected.addresses;
  const at = (artifact: string, address: string) => hre.ethers.getContractAt(artifact, address);
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
  const predecessorPolicy = await at("DisputeProtectionPolicy", a.predecessorPolicy);
  const verifier = await at("UnifiedPaymentVerifierV4", a.verifier);
  const retired = await at("UnifiedPaymentVerifierV3", a.retiredVerifier);
  const paymentRegistry = await at("PaymentVerifierRegistry", a.paymentVerifierRegistry);
  const orchestrator = await at("OrchestratorV3", a.orchestrator);
  const whitelist = await at("WhitelistPolicy", a.whitelistPolicy);
  const attestation = await at("MultiAttestationVerifier", a.attestationVerifier);
  const disputeVerifier = await at("DisputeVerifier", a.disputeVerifier);
  const riskWindows = Object.fromEntries(
    await mapWithConcurrency(Object.keys(context.expected.riskWindows), 16, async (method) => [
      lower(method),
      await number(policy, "getRiskWindow", [method]),
    ])
  );
  return {
    network: "base_staging",
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
      disputeNullifierRegistry: await address(policy, "disputeNullifierRegistry"),
      authorizedHooks: await authorizedHooks(hre, context.records.freshPolicy, block.number),
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
      disputeNullifierRegistry: await address(predecessorPolicy, "disputeNullifierRegistry"),
      predecessorHookAuthorized: await bool(predecessorPolicy, "isLifecycleHookAuthorized", [
        a.predecessorHook,
      ]),
    },
    predecessorHook: await hook(await at("IntentLifecycleHookV1", a.predecessorHook)),
    disputeRegistry: await registry(await at("NullifierRegistry", a.disputeRegistry)),
    nullifierRegistryV2: await registry(await at("NullifierRegistryV2", a.nullifierRegistryV2)),
    paymentVerifierRegistry: {
      owner: await address(paymentRegistry, "owner"),
      methods: await mapWithConcurrency(
        await list(paymentRegistry, "getPaymentMethods"),
        16,
        async (method) => ({
          paymentMethod: method,
          verifier: await address(paymentRegistry, "getVerifier", [method]),
          currencies: (
            await read<string[]>(paymentRegistry, "getCurrencies", [method], block.number)
          ).map(lower),
        })
      ),
    },
    orchestrator: {
      owner: await address(orchestrator, "owner"),
      paused: await bool(orchestrator, "paused"),
      lifecycleHook: await address(orchestrator, "lifecycleHook"),
      escrowRegistry: await address(orchestrator, "escrowRegistry"),
      paymentVerifierRegistry: await address(orchestrator, "paymentVerifierRegistry"),
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
      requiredSignatures: await number(attestation, "requiredSignatures"),
      witnesses: await list(attestation, "witnesses"),
    },
    disputeVerifier: {
      ...(await ownership(disputeVerifier)),
      attestationVerifier: await address(disputeVerifier, "attestationVerifier"),
      nullifierRegistry: await address(disputeVerifier, "nullifierRegistry"),
    },
    inventory: {
      escrow: a.escrow,
      block: String(block.number),
      tuples: [],
      violations: [],
      ok: false,
    },
  };
}

async function executeStep(
  hre: HardhatRuntimeEnvironment,
  state: ReplacementState,
  nonce: number
): Promise<void> {
  const step = STEPS[state.next!];
  const vault = state.contracts.StakeVaultBypass;
  const policy = state.contracts.DisputeProtectionPolicyBypass;
  const hook = state.contracts.IntentLifecycleHookV1Bypass;
  let deployment: { name: TrioName; args: unknown[] } | undefined;
  let target: Contract | undefined;
  let method = "";
  let args: unknown[] = [];
  if (step === "deploy-vault")
    deployment = {
      name: "StakeVaultBypass",
      args: [pins.deployer, pins.stakeToken, zero, BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY],
    };
  else if (step === "deploy-policy")
    deployment = {
      name: "DisputeProtectionPolicyBypass",
      args: [
        pins.deployer,
        vault!.address,
        pins.disputeVerifier.address,
        pins.disputeNullifierRegistry.address,
      ],
    };
  else if (step === "deploy-hook")
    deployment = {
      name: "IntentLifecycleHookV1Bypass",
      args: [shared.orchestratorRegistry, pins.whitelistPolicy.address, policy!.address],
    };
  else if (step === "initialize-controller") {
    target = vault!;
    args = [policy!.address];
    if (!same(await vault!.pendingController(), zero)) {
      target = policy!;
      method = "acceptVaultController";
      args = [];
    } else
      method =
        BigNumber.from(await vault!.totalStaked()).isZero() &&
        BigNumber.from(await vault!.totalClaimable()).isZero()
          ? "initializeController"
          : "proposeController";
  } else if (step === "authorize-hook") {
    target = policy!;
    method = "setLifecycleHookAuthorization";
    args = [hook!.address, true];
  } else if (step.startsWith("set-risk-window:")) {
    const name = step.slice("set-risk-window:".length);
    target = policy!;
    method = "setRiskWindow";
    args = [paymentMethodHash(name), pins.riskWindows[name]];
  } else if (step === "set-lifecycle-hook") {
    target = await hre.ethers.getContractAt("OrchestratorV3", shared.orchestrator);
    method = "setLifecycleHook";
    args = [hook!.address];
  } else {
    target = await hre.ethers.getContractAt(
      "NullifierRegistry",
      pins.disputeNullifierRegistry.address
    );
    if (step === "add-policy-writer") {
      method = "addWritePermission";
      args = [policy!.address];
    } else {
      requireState(step === "remove-superseded-writer", `Unknown lane 47 step ${step}`);
      await assertSupersededUnused(hre, state.block);
      method = "removeWritePermission";
      args = [SUPERSEDED.DisputeProtectionPolicyBypass];
    }
  }
  if (deployment) {
    requireStableStagingNonce(
      nonce,
      await hre.ethers.provider.getTransactionCount(pins.deployer, "pending")
    );
    // hardhat-deploy otherwise reuses the identical vault creation arguments. Absence is a
    // resumable undeployed step, so interruption between delete and deploy is safe to retry.
    await hre.deployments.delete(deployment.name);
    const record = await hre.deployments.deploy(deployment.name, {
      contract: BYPASS_ARTIFACT_NAMES[deployment.name],
      from: pins.deployer,
      args: deployment.args,
      nonce,
      log: true,
    });
    requireState(
      record.newlyDeployed === true && isReplacement(deployment.name, record.address),
      `${deployment.name} was not freshly deployed`
    );
  } else {
    const transaction = {
      operation: 0 as const,
      to: target!.address,
      value: "0",
      data: target!.interface.encodeFunctionData(method, args),
    };
    const checked = await preflightStagingTransaction(hre, transaction, pins.deployer, state.block);
    requireStableStagingNonce(nonce, checked.nonce);
    requireStableStagingNonce(
      nonce,
      await hre.ethers.provider.getTransactionCount(pins.deployer, "pending")
    );
    await (
      await (await hre.ethers.getSigner(pins.deployer)).sendTransaction(checked.request)
    ).wait();
  }
  await waitForDeploymentDelay(hre);
}

const func: DeployFunction = async (hre) => {
  const mode = replacementMode(hre.deployments.getNetworkName(), process.env);
  if (mode === "skip") return;
  while (true) {
    const nonce = await hre.ethers.provider.getTransactionCount(pins.deployer, "pending");
    const state = await readReplacementState(hre);
    requireStableStagingNonce(
      nonce,
      await hre.ethers.provider.getTransactionCount(pins.deployer, "pending")
    );
    if (state.next === null) {
      const snapshot = await finalSnapshot(hre, state.block);
      assertReplacementActive(snapshot, (await finalContext(hre)).expected);
      console.log("Lane 47 active; recording PR required for pins, evidence and outputs.");
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    console.log(`Lane 47 remaining actions: ${STEPS.slice(state.next).join(" -> ")}`);
    if (mode === "prepare") {
      await assertSupersededUnused(hre, state.block);
      return;
    }
    await executeStep(hre, state, nonce);
  }
};
func.skip = async (hre) =>
  replacementMode(hre.deployments.getNetworkName(), process.env) === "skip";
func.tags = [LANE_47_TAG];
func.dependencies = [];
export default func;
