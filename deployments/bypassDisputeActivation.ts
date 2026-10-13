import { BigNumber, utils } from "ethers";
import type { NormalizedSafeBatchTransaction } from "./safeBatchManifest";

export const BYPASS_ACTIVATION_NETWORKS = [
  "base",
  "base_staging",
  "localhost",
  "hardhat",
] as const;
export type BypassActivationNetwork =
  (typeof BYPASS_ACTIVATION_NETWORKS)[number];
type Ownership = { owner: string; pendingOwner: string };
type Hook = {
  orchestratorRegistry: string;
  whitelistPolicy: string;
  disputeProtectionPolicy: string;
};
type PaymentMethod = { paymentMethod: string; currencies: string[] };
type Route = PaymentMethod & { verifier: string };
export type BypassInventoryTuple = {
  escrow: string;
  depositId: string;
  paymentMethod: string;
};
export type BypassInventory = {
  escrow: string;
  block: string;
  tuples: BypassInventoryTuple[];
  violations: BypassInventoryTuple[];
  ok: boolean;
};
export type BypassActivationSnapshot = {
  network: BypassActivationNetwork;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
  freshVault: Ownership & {
    controller: string;
    pendingController: string;
    pendingControllerValidAt: string;
    controllerChangeDelay: string;
    stakeToken: string;
  };
  freshPolicy: Ownership & {
    admissionsPaused: boolean;
    stakeVault: string;
    disputeVerifier: string;
    disputeNullifierRegistry: string;
    authorizedHooks: string[];
    riskWindows: Record<string, string>;
  };
  freshHook: Hook;
  verifier: {
    owner: string;
    orchestratorRegistry: string;
    nullifierRegistry: string;
    attestationVerifier: string;
    paymentMethods: string[];
  };
  retiredVerifier: { owner: string; paymentMethods: string[] };
  predecessorVault: {
    owner: string;
    controller: string;
    pendingController: string;
  };
  predecessorPolicy: Ownership & {
    stakeVault: string;
    disputeVerifier: string;
    disputeNullifierRegistry: string;
    predecessorHookAuthorized: boolean;
  };
  predecessorHook: Hook;
  disputeRegistry: { owner: string; writers: string[] };
  nullifierRegistryV2: { owner: string; writers: string[] };
  paymentVerifierRegistry: { owner: string; methods: Route[] };
  orchestrator: {
    owner: string;
    paused: boolean;
    lifecycleHook: string;
    escrowRegistry: string;
    paymentVerifierRegistry: string;
    relayerRegistry: string;
    protocolFee: string;
    protocolFeeRecipient: string;
    allowMultipleIntents: boolean;
    registered: boolean;
  };
  whitelistPolicy: {
    owner: string;
    escrowRegistry: string;
    groupRegistry: string;
    orchestratorRegistry: string;
  };
  attestationVerifier: {
    owner: string;
    requiredSignatures: string;
    witnesses: string[];
  };
  disputeVerifier: Ownership & {
    attestationVerifier: string;
    nullifierRegistry: string;
  };
  inventory: BypassInventory;
};
export type BypassExpectedActivationState = {
  network: BypassActivationNetwork;
  governance: string;
  deployer: string;
  addresses: Record<
    | "safe"
    | "deployer"
    | "escrow"
    | "freshVault"
    | "freshPolicy"
    | "freshHook"
    | "verifier"
    | "retiredVerifier"
    | "predecessorVault"
    | "predecessorPolicy"
    | "predecessorHook"
    | "disputeRegistry"
    | "nullifierRegistryV2"
    | "paymentVerifierRegistry"
    | "orchestrator"
    | "orchestratorRegistry"
    | "escrowRegistry"
    | "relayerRegistry"
    | "protocolFeeRecipient"
    | "whitelistPolicy"
    | "groupRegistry"
    | "attestationVerifier"
    | "disputeVerifier"
    | "stakeToken",
    string
  >;
  allowedWhitelistPolicyOwners: string[];
  witnesses: string[];
  allowMultipleIntents: boolean;
  paymentMethods: PaymentMethod[];
  protocolFee: string;
  riskWindows: Record<string, string>;
};
export type BypassActivationReduction = {
  phase: "deployed" | "activating" | "active" | "unrecognized";
  completedActions: number | null;
  nextAction: string | null;
  violations: string[];
};

/** Field order is the constructor ABI order of Solidity BypassTrustSurface. */
export type BypassTrustSurfaceInput = {
  safe: string;
  deployer: string;
  orchestrator: string;
  orchestratorRegistry: string;
  escrowRegistry: string;
  paymentVerifierRegistry: string;
  relayerRegistry: string;
  protocolFeeRecipient: string;
  allowMultipleIntents: boolean;
  nullifierRegistryV2: string;
  retiredVerifier: string;
  verifier: string;
  attestationVerifier: string;
  witnesses: string[];
  disputeRegistry: string;
  disputeVerifier: string;
  whitelistPolicy: string;
  whitelistPolicyOwner: string;
  groupRegistry: string;
  stakeToken: string;
  predecessorVault: string;
  predecessorPolicy: string;
  predecessorHook: string;
  freshVault: string;
  freshPolicy: string;
  freshHook: string;
  paymentMethods: string[];
  currencies: string[];
  currencyCounts: string[];
  riskWindowMethods: string[];
  riskWindows: string[];
};
const ZERO = "0x0000000000000000000000000000000000000000";
type Invariant = readonly [string, boolean];

function decimal(value: string): BigNumber {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`Invalid decimal: ${value}`);
  return BigNumber.from(value);
}
function comparable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(comparable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${comparable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(
    typeof value === "string" && value.startsWith("0x")
      ? value.toLowerCase()
      : value
  );
}
function equal(left: unknown, right: unknown): boolean {
  return comparable(left) === comparable(right);
}
function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current))
      return current.map((item: unknown) => getPath(item, key));
    return typeof current === "object" && current !== null
      ? (current as Record<string, unknown>)[key]
      : undefined;
  }, value);
}
function violations(invariants: readonly Invariant[]): string[] {
  return invariants.filter(([, holds]) => !holds).map(([name]) => name);
}

/** Keep the predecessor dispute writer until old intents drain in a later lane.
 * Remove methods from the end so swap-and-pop preserves the remaining order. */
export function bypassActivationActions(
  paymentMethodHashes: string[]
): string[] {
  return [
    "add-dispute-writer",
    "add-verifier-writer",
    ...[...paymentMethodHashes]
      .reverse()
      .map((method) => `remove-method:${method}`),
    ...paymentMethodHashes.map((method) => `add-method:${method}`),
    "remove-retired-verifier-writer",
    "set-lifecycle-hook",
  ];
}
export function bypassRowStateAfter(
  expected: BypassExpectedActivationState,
  k: number
): {
  disputeWriters: string[];
  nrv2Writers: string[];
  registry: Route[];
  hook: string;
} {
  const { addresses: a, paymentMethods } = expected;
  const n = paymentMethods.length;
  if (!Number.isSafeInteger(k) || k < 0 || k > 2 * n + 4)
    throw new Error("Invalid completed action count");
  const removing = k <= n + 2;
  const count = k <= 2 ? n : removing ? n - (k - 2) : Math.min(n, k - n - 2);
  return {
    disputeWriters:
      k >= 1 ? [a.predecessorPolicy, a.freshPolicy] : [a.predecessorPolicy],
    nrv2Writers:
      k < 2
        ? [a.retiredVerifier]
        : k < 2 * n + 3
        ? [a.retiredVerifier, a.verifier]
        : [a.verifier],
    registry: paymentMethods.slice(0, count).map((method) => ({
      ...method,
      currencies: [...method.currencies],
      verifier: removing ? a.retiredVerifier : a.verifier,
    })),
    hook: k === 2 * n + 4 ? a.freshHook : a.predecessorHook,
  };
}
function commonInvariants(
  s: BypassActivationSnapshot,
  e: BypassExpectedActivationState
): Invariant[] {
  const a = e.addresses;
  const wanted: Record<string, unknown> = {
    network: e.network,
    "freshVault.controller": a.freshPolicy,
    "freshVault.pendingController": ZERO,
    "freshVault.pendingControllerValidAt": "0",
    "freshVault.controllerChangeDelay": "0",
    "freshVault.stakeToken": a.stakeToken,
    "freshPolicy.admissionsPaused": false,
    "freshPolicy.stakeVault": a.freshVault,
    "freshPolicy.disputeVerifier": a.disputeVerifier,
    "freshPolicy.disputeNullifierRegistry": a.disputeRegistry,
    "freshPolicy.authorizedHooks": [a.freshHook],
    "freshPolicy.riskWindows": e.riskWindows,
    "freshHook.orchestratorRegistry": a.orchestratorRegistry,
    "freshHook.whitelistPolicy": a.whitelistPolicy,
    "freshHook.disputeProtectionPolicy": a.freshPolicy,
    "verifier.owner": e.governance,
    "verifier.orchestratorRegistry": a.orchestratorRegistry,
    "verifier.nullifierRegistry": a.nullifierRegistryV2,
    "verifier.attestationVerifier": a.attestationVerifier,
    "verifier.paymentMethods": e.paymentMethods.map(
      (method) => method.paymentMethod
    ),
    "retiredVerifier.owner": e.governance,
    "predecessorVault.owner": e.governance,
    "predecessorVault.controller": a.predecessorPolicy,
    "predecessorVault.pendingController": ZERO,
    "predecessorPolicy.owner": e.governance,
    "predecessorPolicy.pendingOwner": ZERO,
    "predecessorPolicy.stakeVault": a.predecessorVault,
    "predecessorPolicy.disputeVerifier": a.disputeVerifier,
    "predecessorPolicy.disputeNullifierRegistry": a.disputeRegistry,
    "predecessorPolicy.predecessorHookAuthorized": true,
    "predecessorHook.orchestratorRegistry": a.orchestratorRegistry,
    "predecessorHook.whitelistPolicy": a.whitelistPolicy,
    "predecessorHook.disputeProtectionPolicy": a.predecessorPolicy,
    "disputeRegistry.owner": e.governance,
    "nullifierRegistryV2.owner": e.governance,
    "paymentVerifierRegistry.owner": e.governance,
    "orchestrator.owner": e.governance,
    "orchestrator.paused": false,
    "orchestrator.escrowRegistry": a.escrowRegistry,
    "orchestrator.paymentVerifierRegistry": a.paymentVerifierRegistry,
    "orchestrator.relayerRegistry": a.relayerRegistry,
    "orchestrator.protocolFee": e.protocolFee,
    "orchestrator.protocolFeeRecipient": a.protocolFeeRecipient,
    "orchestrator.allowMultipleIntents": e.allowMultipleIntents,
    "orchestrator.registered": true,
    "whitelistPolicy.escrowRegistry": a.escrowRegistry,
    "whitelistPolicy.groupRegistry": a.groupRegistry,
    "whitelistPolicy.orchestratorRegistry": a.orchestratorRegistry,
    "attestationVerifier.owner": e.governance,
    "attestationVerifier.requiredSignatures": "1",
    "attestationVerifier.witnesses": e.witnesses,
    "disputeVerifier.owner": e.governance,
    "disputeVerifier.pendingOwner": ZERO,
    "disputeVerifier.attestationVerifier": a.attestationVerifier,
    "disputeVerifier.nullifierRegistry": a.nullifierRegistryV2,
    "inventory.block": s.blockNumber,
    "inventory.escrow": a.escrow,
  };
  const invariants: Invariant[] = Object.entries(wanted).map(
    ([path, value]) => [path, equal(getPath(s, path), value)]
  );
  invariants.push([
    "whitelistPolicy.owner",
    e.allowedWhitelistPolicyOwners.some((owner) =>
      equal(owner, s.whitelistPolicy.owner)
    ),
  ]);
  const methods = (values: string[]) =>
    [...new Set(values.map((value) => value.toLowerCase()))].sort();
  invariants.push([
    "retiredVerifier.paymentMethods",
    equal(
      methods(s.retiredVerifier.paymentMethods),
      methods(e.paymentMethods.map((method) => method.paymentMethod))
    ),
  ]);
  for (const name of ["freshVault", "freshPolicy"] as const) {
    const { owner, pendingOwner } = s[name];
    const ready = equal(owner, e.governance) && equal(pendingOwner, ZERO);
    const pending =
      equal(owner, e.deployer) && equal(pendingOwner, e.governance);
    invariants.push([
      `${name}.ownership`,
      e.network === "base"
        ? ready || pending
        : equal(owner, e.deployer) && equal(pendingOwner, ZERO),
    ]);
  }
  return invariants;
}
function rowInvariants(
  s: BypassActivationSnapshot,
  e: BypassExpectedActivationState,
  k: number
): Invariant[] {
  const row = bypassRowStateAfter(e, k);
  return [
    [
      "disputeRegistry.writers",
      equal(s.disputeRegistry.writers, row.disputeWriters),
    ],
    [
      "nullifierRegistryV2.writers",
      equal(s.nullifierRegistryV2.writers, row.nrv2Writers),
    ],
    [
      "paymentVerifierRegistry.methods",
      equal(s.paymentVerifierRegistry.methods, row.registry),
    ],
    [
      "orchestrator.lifecycleHook",
      equal(s.orchestrator.lifecycleHook, row.hook),
    ],
  ];
}
/** Inventory gates only the initial state; once activation starts it is informational.
 * Base must move atomically from deployed to active, while staging/local can resume a prefix. */
export function reduceBypassActivation(
  snapshot: BypassActivationSnapshot,
  expected: BypassExpectedActivationState
): BypassActivationReduction {
  const actions = bypassActivationActions(
    expected.paymentMethods.map((method) => method.paymentMethod)
  );
  const common = violations(commonInvariants(snapshot, expected));
  const rows = Array.from({ length: actions.length + 1 }, (_, k) => ({
    k,
    violations: violations(rowInvariants(snapshot, expected, k)),
  }));
  const matches = rows.filter((row) => row.violations.length === 0);
  const failures = [...common];
  if (matches.length !== 1) {
    failures.push(
      ...[...rows].sort(
        (left, right) => left.violations.length - right.violations.length
      )[0].violations
    );
    if (matches.length > 1) failures.push("rows.uniqueMatch");
  }
  const k = matches.length === 1 ? matches[0].k : null;
  if (k === 0 && !snapshot.inventory.ok) failures.push("inventory.ok");
  if (k !== null && expected.network === "base") {
    if (k > 0 && k < actions.length) failures.push("base.atomicCutover");
    if (k === actions.length) {
      for (const name of ["freshVault", "freshPolicy"] as const) {
        if (!equal(snapshot[name].owner, expected.governance))
          failures.push(`${name}.owner`);
        if (!equal(snapshot[name].pendingOwner, ZERO))
          failures.push(`${name}.pendingOwner`);
      }
    }
  }
  if (failures.length || k === null)
    return {
      phase: "unrecognized",
      completedActions: null,
      nextAction: null,
      violations: failures,
    };
  return {
    phase:
      k === 0 ? "deployed" : k === actions.length ? "active" : "activating",
    completedActions: k,
    nextAction: expected.network === "base" ? null : actions[k] ?? null,
    violations: [],
  };
}

const interfaces = {
  writer: new utils.Interface([
    "function addWritePermission(address)",
    "function removeWritePermission(address)",
  ]),
  registry: new utils.Interface([
    "function addPaymentMethod(bytes32,address,bytes32[])",
    "function removePaymentMethod(bytes32)",
  ]),
  orchestrator: new utils.Interface(["function setLifecycleHook(address)"]),
  guard: new utils.Interface(["function assertReady()"]),
  ownership: new utils.Interface(["function acceptOwnership()"]),
};
function transaction(to: string, data: string): NormalizedSafeBatchTransaction {
  return {
    to: to.toLowerCase(),
    value: "0",
    data: data.toLowerCase(),
    operation: 0,
  };
}
export function buildBypassActionTransaction(
  action: string,
  expected: BypassExpectedActivationState
): NormalizedSafeBatchTransaction {
  const a = expected.addresses;
  switch (action) {
    case "add-dispute-writer":
      return transaction(
        a.disputeRegistry,
        interfaces.writer.encodeFunctionData("addWritePermission", [
          a.freshPolicy,
        ])
      );
    case "add-verifier-writer":
      return transaction(
        a.nullifierRegistryV2,
        interfaces.writer.encodeFunctionData("addWritePermission", [a.verifier])
      );
    case "remove-retired-verifier-writer":
      return transaction(
        a.nullifierRegistryV2,
        interfaces.writer.encodeFunctionData("removeWritePermission", [
          a.retiredVerifier,
        ])
      );
    case "set-lifecycle-hook":
      return transaction(
        a.orchestrator,
        interfaces.orchestrator.encodeFunctionData("setLifecycleHook", [
          a.freshHook,
        ])
      );
  }
  for (const method of expected.paymentMethods) {
    if (action === `remove-method:${method.paymentMethod}`)
      return transaction(
        a.paymentVerifierRegistry,
        interfaces.registry.encodeFunctionData("removePaymentMethod", [
          method.paymentMethod,
        ])
      );
    if (action === `add-method:${method.paymentMethod}`)
      return transaction(
        a.paymentVerifierRegistry,
        interfaces.registry.encodeFunctionData("addPaymentMethod", [
          method.paymentMethod,
          a.verifier,
          method.currencies,
        ])
      );
  }
  throw new Error(`Unknown bypass action: ${action}`);
}
export function buildBypassCutoverTransactions(input: {
  expected: BypassExpectedActivationState;
  guard: string;
  includeVaultAcceptOwnership: boolean;
  includePolicyAcceptOwnership: boolean;
}): NormalizedSafeBatchTransaction[] {
  const transactions = [
    transaction(
      input.guard,
      interfaces.guard.encodeFunctionData("assertReady")
    ),
  ];
  if (input.includeVaultAcceptOwnership)
    transactions.push(
      transaction(
        input.expected.addresses.freshVault,
        interfaces.ownership.encodeFunctionData("acceptOwnership")
      )
    );
  if (input.includePolicyAcceptOwnership)
    transactions.push(
      transaction(
        input.expected.addresses.freshPolicy,
        interfaces.ownership.encodeFunctionData("acceptOwnership")
      )
    );
  return transactions.concat(
    bypassActivationActions(
      input.expected.paymentMethods.map((method) => method.paymentMethod)
    ).map((action) => buildBypassActionTransaction(action, input.expected))
  );
}
export function assertBypassCanonicalTransactions(
  transactions: NormalizedSafeBatchTransaction[],
  expected: BypassExpectedActivationState,
  guard: string,
  includeVaultAcceptOwnership: boolean,
  includePolicyAcceptOwnership: boolean
): void {
  const canonical = buildBypassCutoverTransactions({
    expected,
    guard,
    includeVaultAcceptOwnership,
    includePolicyAcceptOwnership,
  });
  if (!equal(transactions, canonical)) {
    throw new Error(
      "Bypass Safe batch transactions differ from the canonical cutover"
    );
  }
}

export function buildBypassTrustSurface(
  expected: BypassExpectedActivationState,
  snapshot: BypassActivationSnapshot
): BypassTrustSurfaceInput {
  const a = expected.addresses;
  const paymentMethods = expected.paymentMethods.map(
    (method) => method.paymentMethod
  );
  const riskWindowMethods = [
    ...paymentMethods,
    ...Object.keys(expected.riskWindows)
      .filter((method) => !paymentMethods.includes(method))
      .sort(),
  ];
  return {
    safe: a.safe,
    deployer: expected.deployer,
    orchestrator: a.orchestrator,
    orchestratorRegistry: a.orchestratorRegistry,
    escrowRegistry: a.escrowRegistry,
    paymentVerifierRegistry: a.paymentVerifierRegistry,
    relayerRegistry: a.relayerRegistry,
    protocolFeeRecipient: a.protocolFeeRecipient,
    allowMultipleIntents: expected.allowMultipleIntents,
    nullifierRegistryV2: a.nullifierRegistryV2,
    retiredVerifier: a.retiredVerifier,
    verifier: a.verifier,
    attestationVerifier: a.attestationVerifier,
    witnesses: [...expected.witnesses],
    disputeRegistry: a.disputeRegistry,
    disputeVerifier: a.disputeVerifier,
    whitelistPolicy: a.whitelistPolicy,
    whitelistPolicyOwner: snapshot.whitelistPolicy.owner,
    groupRegistry: a.groupRegistry,
    stakeToken: a.stakeToken,
    predecessorVault: a.predecessorVault,
    predecessorPolicy: a.predecessorPolicy,
    predecessorHook: a.predecessorHook,
    freshVault: a.freshVault,
    freshPolicy: a.freshPolicy,
    freshHook: a.freshHook,
    paymentMethods,
    currencies: expected.paymentMethods.flatMap((method) => method.currencies),
    currencyCounts: expected.paymentMethods.map((method) =>
      String(method.currencies.length)
    ),
    riskWindowMethods,
    riskWindows: riskWindowMethods.map((method) =>
      decimal(expected.riskWindows[method]).toString()
    ),
  };
}
export function bypassTrustSurfaceTuple(
  s: BypassTrustSurfaceInput
): (string | boolean | string[])[] {
  return [
    s.safe,
    s.deployer,
    s.orchestrator,
    s.orchestratorRegistry,
    s.escrowRegistry,
    s.paymentVerifierRegistry,
    s.relayerRegistry,
    s.protocolFeeRecipient,
    s.allowMultipleIntents,
    s.nullifierRegistryV2,
    s.retiredVerifier,
    s.verifier,
    s.attestationVerifier,
    s.witnesses,
    s.disputeRegistry,
    s.disputeVerifier,
    s.whitelistPolicy,
    s.whitelistPolicyOwner,
    s.groupRegistry,
    s.stakeToken,
    s.predecessorVault,
    s.predecessorPolicy,
    s.predecessorHook,
    s.freshVault,
    s.freshPolicy,
    s.freshHook,
    s.paymentMethods,
    s.currencies,
    s.currencyCounts,
    s.riskWindowMethods,
    s.riskWindows,
  ];
}
export function bypassInventoryTupleArgs(
  inventory: BypassInventory
): [string, string, string][] {
  return inventory.tuples.map(({ escrow, depositId, paymentMethod }) => [
    escrow,
    depositId,
    paymentMethod,
  ]);
}

export const BYPASS_GUARD_BOUND_FIELDS = [
  "freshVault.owner",
  "freshVault.pendingOwner",
  "freshVault.controller",
  "freshVault.pendingController",
  "freshVault.pendingControllerValidAt",
  "freshVault.controllerChangeDelay",
  "freshVault.stakeToken",
  "freshPolicy.owner",
  "freshPolicy.pendingOwner",
  "freshPolicy.admissionsPaused",
  "freshPolicy.stakeVault",
  "freshPolicy.disputeVerifier",
  "freshPolicy.disputeNullifierRegistry",
  "freshPolicy.authorizedHooks",
  "freshPolicy.riskWindows",
  "freshHook.orchestratorRegistry",
  "freshHook.whitelistPolicy",
  "freshHook.disputeProtectionPolicy",
  "verifier.owner",
  "verifier.orchestratorRegistry",
  "verifier.nullifierRegistry",
  "verifier.attestationVerifier",
  "verifier.paymentMethods",
  "retiredVerifier.owner",
  "predecessorVault.owner",
  "predecessorVault.controller",
  "predecessorPolicy.owner",
  "predecessorPolicy.pendingOwner",
  "predecessorPolicy.stakeVault",
  "predecessorPolicy.disputeVerifier",
  "predecessorPolicy.disputeNullifierRegistry",
  "predecessorPolicy.predecessorHookAuthorized",
  "disputeRegistry.owner",
  "disputeRegistry.writers",
  "nullifierRegistryV2.owner",
  "nullifierRegistryV2.writers",
  "paymentVerifierRegistry.owner",
  "paymentVerifierRegistry.methods.paymentMethod",
  "paymentVerifierRegistry.methods.verifier",
  "paymentVerifierRegistry.methods.currencies",
  "orchestrator.owner",
  "orchestrator.paused",
  "orchestrator.lifecycleHook",
  "orchestrator.escrowRegistry",
  "orchestrator.paymentVerifierRegistry",
  "orchestrator.relayerRegistry",
  "orchestrator.protocolFee",
  "orchestrator.protocolFeeRecipient",
  "orchestrator.allowMultipleIntents",
  "orchestrator.registered",
  "whitelistPolicy.owner",
  "whitelistPolicy.escrowRegistry",
  "whitelistPolicy.groupRegistry",
  "whitelistPolicy.orchestratorRegistry",
  "attestationVerifier.owner",
  "attestationVerifier.requiredSignatures",
  "attestationVerifier.witnesses",
  "disputeVerifier.owner",
  "disputeVerifier.pendingOwner",
  "disputeVerifier.attestationVerifier",
  "disputeVerifier.nullifierRegistry",
  "inventory.escrow",
  "inventory.tuples.escrow",
  "inventory.tuples.depositId",
  "inventory.tuples.paymentMethod",
  "inventory.violations",
  "inventory.ok",
] as const;
export function assertBypassGuardExpectationsUnchanged(
  proof: BypassActivationSnapshot,
  simulation: BypassActivationSnapshot
): void {
  const changed = BYPASS_GUARD_BOUND_FIELDS.filter(
    (path) => !equal(getPath(proof, path), getPath(simulation, path))
  );
  if (changed.length)
    throw new Error(`Bypass guard expectations changed: ${changed.join(", ")}`);
}
/** Only live, listed, windowed predecessor opt-outs require a mirrored fresh opt-out. */
export function buildBypassInventory(input: {
  escrow: string;
  block: string;
  freshRiskWindows: Record<string, string>;
  tuples: Array<
    BypassInventoryTuple & {
      depositor: string;
      listedPaymentMethods: string[];
      predecessorEnabled: boolean;
      freshEnabled: boolean;
    }
  >;
}): BypassInventory {
  const required = input.tuples
    .filter((tuple) => {
      if (!equal(tuple.escrow, input.escrow))
        throw new Error("Inventory escrow mismatch");
      return (
        !equal(tuple.depositor, ZERO) &&
        tuple.listedPaymentMethods.some((method) =>
          equal(method, tuple.paymentMethod)
        ) &&
        !decimal(input.freshRiskWindows[tuple.paymentMethod] ?? "0").isZero() &&
        !tuple.predecessorEnabled
      );
    })
    .sort((left, right) => {
      const leftId = decimal(left.depositId);
      const rightId = decimal(right.depositId);
      return leftId.eq(rightId)
        ? left.paymentMethod.localeCompare(right.paymentMethod)
        : leftId.lt(rightId)
        ? -1
        : 1;
    });
  const tupleOnly = ({
    escrow,
    depositId,
    paymentMethod,
  }: BypassInventoryTuple): BypassInventoryTuple => ({
    escrow: escrow.toLowerCase(),
    depositId: decimal(depositId).toString(),
    paymentMethod: paymentMethod.toLowerCase(),
  });
  const failed = required.filter((tuple) => tuple.freshEnabled).map(tupleOnly);
  return {
    escrow: input.escrow.toLowerCase(),
    block: decimal(input.block).toString(),
    tuples: required.map(tupleOnly),
    violations: failed,
    ok: failed.length === 0,
  };
}
export function assertBypassAdvance(
  before: BypassActivationReduction,
  after: BypassActivationReduction
): void {
  if (
    before.completedActions === null ||
    after.phase === "unrecognized" ||
    after.completedActions !== before.completedActions + 1
  ) {
    throw new Error("Bypass activation did not advance exactly one action");
  }
}
