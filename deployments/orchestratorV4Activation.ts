import { BigNumber, utils } from "ethers";
import type { NormalizedSafeBatchTransaction } from "./safeBatchManifest";

export const O4_ACTIVATION_NETWORKS = [
  "base",
  "base_staging",
  "localhost",
  "hardhat",
] as const;
export type O4ActivationNetwork =
  (typeof O4_ACTIVATION_NETWORKS)[number];
type Ownership = { owner: string; pendingOwner: string };
type Hook = {
  orchestratorRegistry: string;
  whitelistPolicy: string;
  disputeProtectionPolicy: string;
};
type PaymentMethod = { paymentMethod: string; currencies: string[] };
type Route = PaymentMethod & { verifier: string };
export type O4ActivationSnapshot = {
  network: O4ActivationNetwork;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
  freshVault: Ownership & {
    policyAuthorized: boolean;
    stakeToken: string;
  };
  freshPolicy: Ownership & {
    stakeVault: string;
    disputeVerifier: string;
    disputeNullifierRegistry: string;
    orchestratorRegistry: string;
  };
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
  orchestratorV4: {
    chainId: string;
    owner: string;
    paused: boolean;
    settlementPolicy: string;
    whitelistPolicy: string;
    escrowRegistry: string;
    paymentVerifierRegistry: string;
    relayerRegistry: string;
    protocolFee: string;
    protocolFeeRecipient: string;
    allowMultipleIntents: boolean;
    registered: boolean;
  };
  orchestratorRegistry: { owner: string };
  whitelistPolicy: {
    owner: string;
    escrowRegistry: string;
    groupRegistry: string;
    orchestratorRegistry: string;
  };
  freshWhitelistPolicy: {
    groupRegistry: string;
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
};
export type O4ExpectedActivationState = {
  network: O4ActivationNetwork;
  governance: string;
  deployer: string;
  addresses: Record<
    | "safe"
    | "deployer"
    | "escrow"
    | "freshVault"
    | "freshPolicy"
    | "verifier"
    | "retiredVerifier"
    | "predecessorVault"
    | "predecessorPolicy"
    | "predecessorHook"
    | "disputeRegistry"
    | "nullifierRegistryV2"
    | "paymentVerifierRegistry"
    | "orchestratorV4"
    | "orchestrator"
    | "orchestratorRegistry"
    | "escrowRegistry"
    | "relayerRegistry"
    | "protocolFeeRecipient"
    | "freshWhitelistPolicy"
    | "whitelistPolicy"
    | "groupRegistry"
    | "freshGroupRegistry"
    | "attestationVerifier"
    | "disputeVerifier"
    | "stakeToken",
    string
  >;
  chainId: string;
  retainedDisputeWriters: string[];
  allowedWhitelistPolicyOwners: string[];
  witnesses: string[];
  allowMultipleIntents: boolean;
  paymentMethods: PaymentMethod[];
  protocolFee: string;
};
export type O4ActivationReduction = {
  phase: "deployed" | "activating" | "active" | "unrecognized";
  completedActions: number | null;
  nextAction: string | null;
  violations: string[];
};

/** Field order is the constructor ABI order of Solidity O4TrustSurface. */
export type O4TrustSurfaceInput = {
  safe: string;
  deployer: string;
  orchestrator: string;
  orchestratorV4: string;
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
  freshWhitelistPolicy: string;
  groupRegistry: string;
  freshGroupRegistry: string;
  stakeToken: string;
  predecessorVault: string;
  predecessorPolicy: string;
  predecessorHook: string;
  freshVault: string;
  freshPolicy: string;
  paymentMethods: string[];
  currencies: string[];
  currencyCounts: string[];
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
export function o4ActivationActions(paymentMethodHashes: string[]): string[] {
  return [
    "add-dispute-writer",
    "add-verifier-writer",
    ...[...paymentMethodHashes]
      .reverse()
      .map((method) => `remove-method:${method}`),
    ...paymentMethodHashes.map((method) => `add-method:${method}`),
    "remove-retired-verifier-writer",
    "register-orchestrator",
  ];
}
export function o4RowStateAfter(
  expected: O4ExpectedActivationState,
  k: number
): {
  disputeWriters: string[];
  nrv2Writers: string[];
  registry: Route[];
  o4Registered: boolean;
} {
  const { addresses: a, paymentMethods } = expected;
  const n = paymentMethods.length;
  const actions = o4ActivationActions(
    paymentMethods.map((method) => method.paymentMethod)
  );
  if (!Number.isSafeInteger(k) || k < 0 || k > actions.length)
    throw new Error("Invalid completed action count");
  const removing = k <= n + 2;
  const count = k <= 2 ? n : removing ? n - (k - 2) : Math.min(n, k - n - 2);
  return {
    disputeWriters: [
      ...expected.retainedDisputeWriters,
      ...(k >= 1 ? [a.freshPolicy] : []),
    ],
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
    o4Registered: k === actions.length,
  };
}
function commonInvariants(
  s: O4ActivationSnapshot,
  e: O4ExpectedActivationState
): Invariant[] {
  const a = e.addresses;
  const wanted: Record<string, unknown> = {
    network: e.network,
    "freshVault.policyAuthorized": true,
    "freshVault.stakeToken": a.stakeToken,
    "freshPolicy.stakeVault": a.freshVault,
    "freshPolicy.disputeVerifier": a.disputeVerifier,
    "freshPolicy.disputeNullifierRegistry": a.disputeRegistry,
    "freshPolicy.orchestratorRegistry": a.orchestratorRegistry,
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
    "orchestrator.lifecycleHook": a.predecessorHook,
    "orchestrator.escrowRegistry": a.escrowRegistry,
    "orchestrator.paymentVerifierRegistry": a.paymentVerifierRegistry,
    "orchestrator.relayerRegistry": a.relayerRegistry,
    "orchestrator.protocolFee": e.protocolFee,
    "orchestrator.protocolFeeRecipient": a.protocolFeeRecipient,
    "orchestrator.allowMultipleIntents": e.allowMultipleIntents,
    "orchestrator.registered": true,
    "orchestratorV4.owner": e.governance,
    "orchestratorV4.paused": false,
    "orchestratorV4.escrowRegistry": a.escrowRegistry,
    "orchestratorV4.paymentVerifierRegistry": a.paymentVerifierRegistry,
    "orchestratorV4.relayerRegistry": a.relayerRegistry,
    "orchestratorV4.protocolFee": e.protocolFee,
    "orchestratorV4.protocolFeeRecipient": a.protocolFeeRecipient,
    "orchestratorV4.allowMultipleIntents": e.allowMultipleIntents,
    "orchestratorV4.chainId": e.chainId,
    "orchestratorV4.settlementPolicy": a.freshPolicy,
    "orchestratorV4.whitelistPolicy": a.freshWhitelistPolicy,
    "orchestratorRegistry.owner": e.governance,
    "freshWhitelistPolicy.groupRegistry": a.freshGroupRegistry,
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
  };
  const invariants: Invariant[] = Object.entries(wanted).map(
    ([path, value]) => [path, equal(getPath(s, path), value)]
  );
  invariants.push([
    "freshWhitelistPolicy.distinct",
    !equal(a.freshWhitelistPolicy, a.whitelistPolicy),
  ]);
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
  s: O4ActivationSnapshot,
  e: O4ExpectedActivationState,
  k: number
): Invariant[] {
  const row = o4RowStateAfter(e, k);
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
      "orchestratorV4.registered",
      equal(s.orchestratorV4.registered, row.o4Registered),
    ],
  ];
}
/** Base must move atomically from deployed to active, while staging/local can resume a prefix. */
export function reduceO4Activation(
  snapshot: O4ActivationSnapshot,
  expected: O4ExpectedActivationState
): O4ActivationReduction {
  const actions = o4ActivationActions(
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
  orchestratorRegistry: new utils.Interface([
    "function addOrchestrator(address)",
  ]),
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
export function buildO4ActionTransaction(
  action: string,
  expected: O4ExpectedActivationState
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
    case "register-orchestrator":
      return transaction(
        a.orchestratorRegistry,
        interfaces.orchestratorRegistry.encodeFunctionData("addOrchestrator", [
          a.orchestratorV4,
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
  throw new Error(`Unknown O4 action: ${action}`);
}
export function buildO4CutoverTransactions(input: {
  expected: O4ExpectedActivationState;
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
    o4ActivationActions(
      input.expected.paymentMethods.map((method) => method.paymentMethod)
    ).map((action) => buildO4ActionTransaction(action, input.expected))
  );
}
export function assertO4CanonicalTransactions(
  transactions: NormalizedSafeBatchTransaction[],
  expected: O4ExpectedActivationState,
  guard: string,
  includeVaultAcceptOwnership: boolean,
  includePolicyAcceptOwnership: boolean
): void {
  const canonical = buildO4CutoverTransactions({
    expected,
    guard,
    includeVaultAcceptOwnership,
    includePolicyAcceptOwnership,
  });
  if (!equal(transactions, canonical)) {
    throw new Error(
      "O4 Safe batch transactions differ from the canonical cutover"
    );
  }
}

export function buildO4TrustSurface(
  expected: O4ExpectedActivationState,
  snapshot: O4ActivationSnapshot
): O4TrustSurfaceInput {
  const a = expected.addresses;
  const paymentMethods = expected.paymentMethods.map(
    (method) => method.paymentMethod
  );
  return {
    safe: a.safe,
    deployer: expected.deployer,
    orchestrator: a.orchestrator,
    orchestratorV4: a.orchestratorV4,
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
    freshWhitelistPolicy: a.freshWhitelistPolicy,
    groupRegistry: a.groupRegistry,
    freshGroupRegistry: a.freshGroupRegistry,
    stakeToken: a.stakeToken,
    predecessorVault: a.predecessorVault,
    predecessorPolicy: a.predecessorPolicy,
    predecessorHook: a.predecessorHook,
    freshVault: a.freshVault,
    freshPolicy: a.freshPolicy,
    paymentMethods,
    currencies: expected.paymentMethods.flatMap((method) => method.currencies),
    currencyCounts: expected.paymentMethods.map((method) =>
      String(method.currencies.length)
    ),
  };
}
export function o4TrustSurfaceTuple(
  s: O4TrustSurfaceInput
): (string | boolean | string[])[] {
  return [
    s.safe,
    s.deployer,
    s.orchestrator,
    s.orchestratorV4,
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
    s.freshWhitelistPolicy,
    s.groupRegistry,
    s.freshGroupRegistry,
    s.stakeToken,
    s.predecessorVault,
    s.predecessorPolicy,
    s.predecessorHook,
    s.freshVault,
    s.freshPolicy,
    s.paymentMethods,
    s.currencies,
    s.currencyCounts,
  ];
}
export const O4_GUARD_BOUND_FIELDS = [
  "freshVault.owner",
  "freshVault.pendingOwner",
  "freshVault.policyAuthorized",
  "freshVault.stakeToken",
  "freshPolicy.owner",
  "freshPolicy.pendingOwner",
  "freshPolicy.stakeVault",
  "freshPolicy.disputeVerifier",
  "freshPolicy.disputeNullifierRegistry",
  "freshPolicy.orchestratorRegistry",
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
  "orchestratorV4.owner",
  "orchestratorV4.paused",
  "orchestratorV4.settlementPolicy",
  "orchestratorV4.whitelistPolicy",
  "orchestratorV4.escrowRegistry",
  "orchestratorV4.paymentVerifierRegistry",
  "orchestratorV4.relayerRegistry",
  "orchestratorV4.protocolFee",
  "orchestratorV4.protocolFeeRecipient",
  "orchestratorV4.allowMultipleIntents",
  "orchestratorV4.registered",
  "orchestratorV4.chainId",
  "orchestratorRegistry.owner",
  "freshWhitelistPolicy.groupRegistry",
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
] as const;
export function assertO4GuardExpectationsUnchanged(
  proof: O4ActivationSnapshot,
  simulation: O4ActivationSnapshot
): void {
  const changed = O4_GUARD_BOUND_FIELDS.filter(
    (path) => !equal(getPath(proof, path), getPath(simulation, path))
  );
  if (changed.length)
    throw new Error(`O4 guard expectations changed: ${changed.join(", ")}`);
}
export function assertO4Advance(
  before: O4ActivationReduction,
  after: O4ActivationReduction
): void {
  if (
    before.completedActions === null ||
    after.phase === "unrecognized" ||
    after.completedActions !== before.completedActions + 1
  ) {
    throw new Error("O4 activation did not advance exactly one action");
  }
}
