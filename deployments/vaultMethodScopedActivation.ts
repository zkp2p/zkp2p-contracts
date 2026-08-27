import { BigNumber, utils } from "ethers";

import type { NormalizedSafeBatchTransaction } from "./safeBatchManifest";
import type {
  ActivationNetwork,
  ActivationSnapshot,
  DepositorInventory,
  LockProof,
  OwnershipState,
} from "./methodScopedActivation";

export {
  buildDepositorInventory,
  classifyIntentLock,
  proveNoLivePredecessorLocks,
} from "./methodScopedActivation";

export type VaultActivationBatchKind = "vault-cutover" | "vault-writer-removal";

export type VaultActivationAddresses = {
  safe: string;
  deployer: string;
  escrow: string;
  predecessorVault: string;
  freshVault: string;
  predecessorPolicy: string;
  freshPolicy: string;
  predecessorHook: string;
  freshHook: string;
  registry: string;
  orchestrator: string;
  orchestratorRegistry: string;
  escrowRegistry: string;
  paymentVerifierRegistry: string;
  relayerRegistry: string;
  protocolFeeRecipient: string;
  whitelistPolicy: string;
  groupRegistry: string;
  attestationVerifier: string;
  disputeVerifier: string;
  nullifierRegistryV2: string;
  stakeToken: string;
};

export type VaultActivationSnapshot = Omit<
  ActivationSnapshot,
  "vault" | "predecessorPolicy"
> & {
  freshVault: OwnershipState & {
    controller: string;
    pendingController: string;
    pendingControllerValidAt: string;
    controllerChangeDelay: string;
    stakeToken: string;
  };
  predecessorVault: {
    pendingController: string;
  };
  predecessorPolicy: ActivationSnapshot["predecessorPolicy"] & {
    stakeVault: string;
  };
  lockProof: LockProof;
  inventory: DepositorInventory;
};

export type VaultExpectedActivationState = {
  network: ActivationNetwork;
  governance: string;
  deployer: string;
  addresses: VaultActivationAddresses;
  riskWindows: Record<string, string>;
  witnesses: string[];
  controllerChangeDelay: string;
  allowMultipleIntents: boolean;
  predecessorVaultPendingController: string;
  predecessorAdmissionsPaused: boolean;
};

export type VaultActivationPhase =
  | "deployed"
  | "cutover-pending"
  | "active"
  | "writer-removed"
  | "unrecognized";
export type VaultStagingAction =
  | "add-fresh-writer"
  | "set-fresh-hook"
  | "remove-predecessor-writer";
export type VaultActivationReduction = {
  phase: VaultActivationPhase;
  nextStagingAction: VaultStagingAction | null;
  waiting: {
    reason: "predecessor-drain";
    earliestChangeAt: string | null;
  } | null;
  violations: string[];
};

type Invariant = readonly [string, boolean];

const ZERO = utils.getAddress("0x0000000000000000000000000000000000000000");

function decimal(value: string): BigNumber {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid decimal string: ${value}`);
  }
  return BigNumber.from(value);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameOrderedAddresses(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => sameAddress(value, right[index]))
  );
}

function equalRiskWindows(
  actual: Record<string, string>,
  wanted: Record<string, string>
): boolean {
  const normalize = (value: Record<string, string>) =>
    Object.entries(value)
      .map(([method, window]) => [
        method.toLowerCase(),
        decimal(window).toString(),
      ])
      .sort(([left], [right]) => left.localeCompare(right));
  return (
    JSON.stringify(normalize(actual)) === JSON.stringify(normalize(wanted))
  );
}

function violations(invariants: readonly Invariant[]): string[] {
  return invariants.filter(([, holds]) => !holds).map(([name]) => name);
}

function commonInvariants(
  snapshot: VaultActivationSnapshot,
  expected: VaultExpectedActivationState
): Invariant[] {
  const { addresses } = expected;
  const governance = expected.governance;
  return [
    ["network", snapshot.network === expected.network],
    ["freshPolicy.admissionsPaused", !snapshot.freshPolicy.admissionsPaused],
    [
      "freshPolicy.disputeVerifier",
      sameAddress(
        snapshot.freshPolicy.disputeVerifier,
        addresses.disputeVerifier
      ),
    ],
    [
      "freshPolicy.disputeNullifierRegistry",
      sameAddress(
        snapshot.freshPolicy.disputeNullifierRegistry,
        addresses.registry
      ),
    ],
    [
      "freshPolicy.stakeVault",
      sameAddress(snapshot.freshPolicy.stakeVault, addresses.freshVault),
    ],
    [
      "freshPolicy.authorizedHooks",
      sameOrderedAddresses(snapshot.freshPolicy.authorizedHooks, [
        addresses.freshHook,
      ]),
    ],
    [
      "freshPolicy.riskWindows",
      equalRiskWindows(snapshot.freshPolicy.riskWindows, expected.riskWindows),
    ],
    [
      "predecessorPolicy.owner",
      sameAddress(snapshot.predecessorPolicy.owner, governance),
    ],
    [
      "predecessorPolicy.pendingOwner",
      sameAddress(snapshot.predecessorPolicy.pendingOwner, ZERO),
    ],
    [
      "predecessorPolicy.admissionsPaused",
      snapshot.predecessorPolicy.admissionsPaused ===
        expected.predecessorAdmissionsPaused,
    ],
    [
      "predecessorPolicy.disputeVerifier",
      sameAddress(
        snapshot.predecessorPolicy.disputeVerifier,
        addresses.disputeVerifier
      ),
    ],
    [
      "predecessorPolicy.disputeNullifierRegistry",
      sameAddress(
        snapshot.predecessorPolicy.disputeNullifierRegistry,
        addresses.registry
      ),
    ],
    [
      "predecessorPolicy.stakeVault",
      sameAddress(
        snapshot.predecessorPolicy.stakeVault,
        addresses.predecessorVault
      ),
    ],
    [
      "predecessorVault.pendingController",
      sameAddress(
        snapshot.predecessorVault.pendingController,
        expected.predecessorVaultPendingController
      ),
    ],
    [
      "disputeVerifier.owner",
      sameAddress(snapshot.disputeVerifier.owner, governance),
    ],
    [
      "disputeVerifier.pendingOwner",
      sameAddress(snapshot.disputeVerifier.pendingOwner, ZERO),
    ],
    [
      "disputeVerifier.attestationVerifier",
      sameAddress(
        snapshot.disputeVerifier.attestationVerifier,
        addresses.attestationVerifier
      ),
    ],
    [
      "disputeVerifier.nullifierRegistry",
      sameAddress(
        snapshot.disputeVerifier.nullifierRegistry,
        addresses.nullifierRegistryV2
      ),
    ],
    [
      "freshVault.controller",
      sameAddress(snapshot.freshVault.controller, addresses.freshPolicy),
    ],
    [
      "freshVault.pendingController",
      sameAddress(snapshot.freshVault.pendingController, ZERO),
    ],
    [
      "freshVault.pendingControllerValidAt",
      decimal(snapshot.freshVault.pendingControllerValidAt).isZero(),
    ],
    [
      "freshVault.controllerChangeDelay",
      decimal(snapshot.freshVault.controllerChangeDelay).eq(
        expected.controllerChangeDelay
      ),
    ],
    [
      "freshVault.stakeToken",
      sameAddress(snapshot.freshVault.stakeToken, addresses.stakeToken),
    ],
    ["registry.owner", sameAddress(snapshot.registry.owner, governance)],
    [
      "orchestrator.owner",
      sameAddress(snapshot.orchestrator.owner, governance),
    ],
    ["orchestrator.paused", !snapshot.orchestrator.paused],
    [
      "orchestrator.escrowRegistry",
      sameAddress(
        snapshot.orchestrator.escrowRegistry,
        addresses.escrowRegistry
      ),
    ],
    [
      "orchestrator.paymentVerifierRegistry",
      sameAddress(
        snapshot.orchestrator.paymentVerifierRegistry,
        addresses.paymentVerifierRegistry
      ),
    ],
    [
      "orchestrator.relayerRegistry",
      sameAddress(
        snapshot.orchestrator.relayerRegistry,
        addresses.relayerRegistry
      ),
    ],
    [
      "orchestrator.protocolFee",
      decimal(snapshot.orchestrator.protocolFee).isZero(),
    ],
    [
      "orchestrator.protocolFeeRecipient",
      sameAddress(
        snapshot.orchestrator.protocolFeeRecipient,
        addresses.protocolFeeRecipient
      ),
    ],
    [
      "orchestrator.allowMultipleIntents",
      snapshot.orchestrator.allowMultipleIntents ===
        expected.allowMultipleIntents,
    ],
    ["orchestrator.registered", snapshot.orchestrator.registered],
    [
      "freshHook.orchestratorRegistry",
      sameAddress(
        snapshot.freshHook.orchestratorRegistry,
        addresses.orchestratorRegistry
      ),
    ],
    [
      "freshHook.whitelistPolicy",
      sameAddress(
        snapshot.freshHook.whitelistPolicy,
        addresses.whitelistPolicy
      ),
    ],
    [
      "freshHook.disputeProtectionPolicy",
      sameAddress(
        snapshot.freshHook.disputeProtectionPolicy,
        addresses.freshPolicy
      ),
    ],
    [
      "whitelistPolicy.owner",
      sameAddress(snapshot.whitelistPolicy.owner, governance),
    ],
    [
      "whitelistPolicy.escrowRegistry",
      sameAddress(
        snapshot.whitelistPolicy.escrowRegistry,
        addresses.escrowRegistry
      ),
    ],
    [
      "whitelistPolicy.groupRegistry",
      sameAddress(
        snapshot.whitelistPolicy.groupRegistry,
        addresses.groupRegistry
      ),
    ],
    [
      "whitelistPolicy.orchestratorRegistry",
      sameAddress(
        snapshot.whitelistPolicy.orchestratorRegistry,
        addresses.orchestratorRegistry
      ),
    ],
    [
      "attestationVerifier.owner",
      sameAddress(snapshot.attestationVerifier.owner, governance),
    ],
    [
      "attestationVerifier.requiredSignatures",
      decimal(snapshot.attestationVerifier.requiredSignatures).eq(1),
    ],
    [
      "attestationVerifier.witnesses",
      sameOrderedAddresses(
        snapshot.attestationVerifier.witnesses,
        expected.witnesses
      ),
    ],
    ["lockProof.toBlock", snapshot.lockProof.toBlock === snapshot.blockNumber],
    ["inventory.block", snapshot.inventory.block === snapshot.blockNumber],
    [
      "inventory.escrow",
      sameAddress(snapshot.inventory.escrow, addresses.escrow),
    ],
  ];
}

function ownershipValid(
  state: OwnershipState,
  expected: VaultExpectedActivationState
): boolean {
  if (expected.network === "base_staging") {
    return (
      sameAddress(state.owner, expected.deployer) &&
      sameAddress(state.pendingOwner, ZERO)
    );
  }
  return (
    (sameAddress(state.owner, expected.deployer) &&
      sameAddress(state.pendingOwner, expected.addresses.safe)) ||
    (sameAddress(state.owner, expected.addresses.safe) &&
      sameAddress(state.pendingOwner, ZERO))
  );
}

function rowInvariants(
  snapshot: VaultActivationSnapshot,
  expected: VaultExpectedActivationState,
  phase: Exclude<VaultActivationPhase, "unrecognized">
): Invariant[] {
  const { addresses } = expected;
  const writers =
    phase === "deployed"
      ? [addresses.predecessorPolicy]
      : phase === "writer-removed"
      ? [addresses.freshPolicy]
      : [addresses.predecessorPolicy, addresses.freshPolicy];
  const hook =
    phase === "deployed" || phase === "cutover-pending"
      ? addresses.predecessorHook
      : addresses.freshHook;
  return [
    ["freshVault.ownership", ownershipValid(snapshot.freshVault, expected)],
    ["freshPolicy.ownership", ownershipValid(snapshot.freshPolicy, expected)],
    [
      "registry.writers",
      sameOrderedAddresses(snapshot.registry.writers, writers),
    ],
    [
      "orchestrator.lifecycleHook",
      sameAddress(snapshot.orchestrator.lifecycleHook, hook),
    ],
  ];
}

export function reduceVaultActivation(
  snapshot: VaultActivationSnapshot,
  expected: VaultExpectedActivationState
): VaultActivationReduction {
  const common = violations(commonInvariants(snapshot, expected));
  const phases: Exclude<VaultActivationPhase, "unrecognized">[] = [
    "deployed",
    "cutover-pending",
    "active",
    "writer-removed",
  ];
  const allowed =
    expected.network === "base"
      ? phases.filter((phase) => phase !== "cutover-pending")
      : phases;
  const matches = allowed.filter(
    (phase) => violations(rowInvariants(snapshot, expected, phase)).length === 0
  );
  if (common.length > 0 || matches.length !== 1) {
    const closest = allowed
      .map((phase) => violations(rowInvariants(snapshot, expected, phase)))
      .sort((left, right) => left.length - right.length)[0];
    return {
      phase: "unrecognized",
      nextStagingAction: null,
      waiting: null,
      violations: [...common, ...(matches.length === 1 ? [] : closest)],
    };
  }
  const phase = matches[0];
  if (phase === "deployed" && !snapshot.inventory.ok) {
    return {
      phase: "unrecognized",
      nextStagingAction: null,
      waiting: null,
      violations: ["inventory.ok"],
    };
  }
  if (phase === "active" && !snapshot.lockProof.ok) {
    return {
      phase,
      nextStagingAction: null,
      waiting: {
        reason: "predecessor-drain",
        earliestChangeAt: snapshot.lockProof.earliestMaturity,
      },
      violations: [],
    };
  }
  const nextStagingAction: VaultStagingAction | null =
    expected.network === "base"
      ? null
      : phase === "deployed"
      ? "add-fresh-writer"
      : phase === "cutover-pending"
      ? "set-fresh-hook"
      : phase === "active"
      ? "remove-predecessor-writer"
      : null;
  return { phase, nextStagingAction, waiting: null, violations: [] };
}

export type VaultTrustSurfaceInput = {
  safe: string;
  disputeRegistry: string;
  orchestrator: string;
  orchestratorRegistry: string;
  escrowRegistry: string;
  paymentVerifierRegistry: string;
  relayerRegistry: string;
  protocolFeeRecipient: string;
  allowMultipleIntents: boolean;
  freshHook: string;
  whitelistPolicy: string;
  groupRegistry: string;
  attestationVerifier: string;
  witnesses: string[];
  disputeVerifier: string;
  nullifierRegistryV2: string;
  predecessorPolicy: string;
  freshPolicy: string;
  vaults: { freshVault: string; predecessorVault: string };
  predecessorHook: string;
  paymentMethods: string[];
  riskWindows: string[];
};

export function buildVaultTrustSurface(
  expected: VaultExpectedActivationState
): VaultTrustSurfaceInput {
  const paymentMethods = Object.keys(expected.riskWindows);
  const { addresses } = expected;
  return {
    safe: addresses.safe,
    disputeRegistry: addresses.registry,
    orchestrator: addresses.orchestrator,
    orchestratorRegistry: addresses.orchestratorRegistry,
    escrowRegistry: addresses.escrowRegistry,
    paymentVerifierRegistry: addresses.paymentVerifierRegistry,
    relayerRegistry: addresses.relayerRegistry,
    protocolFeeRecipient: addresses.protocolFeeRecipient,
    allowMultipleIntents: expected.allowMultipleIntents,
    freshHook: addresses.freshHook,
    whitelistPolicy: addresses.whitelistPolicy,
    groupRegistry: addresses.groupRegistry,
    attestationVerifier: addresses.attestationVerifier,
    witnesses: [...expected.witnesses],
    disputeVerifier: addresses.disputeVerifier,
    nullifierRegistryV2: addresses.nullifierRegistryV2,
    predecessorPolicy: addresses.predecessorPolicy,
    freshPolicy: addresses.freshPolicy,
    vaults: {
      freshVault: addresses.freshVault,
      predecessorVault: addresses.predecessorVault,
    },
    predecessorHook: addresses.predecessorHook,
    paymentMethods,
    riskWindows: paymentMethods.map((method) => expected.riskWindows[method]),
  };
}

export const VAULT_ACTIVATION_INTERFACES = {
  guard: new utils.Interface(["function assertReady()"]),
  vault: new utils.Interface(["function acceptOwnership()"]),
  policy: new utils.Interface(["function acceptOwnership()"]),
  registry: new utils.Interface([
    "function addWritePermission(address writer)",
    "function removeWritePermission(address writer)",
  ]),
  orchestrator: new utils.Interface([
    "function setLifecycleHook(address hook)",
  ]),
};

function transaction(to: string, data: string): NormalizedSafeBatchTransaction {
  return {
    to: to.toLowerCase(),
    value: "0",
    data: data.toLowerCase(),
    operation: 0,
  };
}

export function buildVaultCutoverTransactions(input: {
  addresses: VaultActivationAddresses;
  guard: string;
  includeVaultAcceptOwnership: boolean;
  includePolicyAcceptOwnership: boolean;
}): NormalizedSafeBatchTransaction[] {
  const transactions = [
    transaction(
      input.guard,
      VAULT_ACTIVATION_INTERFACES.guard.encodeFunctionData("assertReady")
    ),
  ];
  if (input.includeVaultAcceptOwnership) {
    transactions.push(
      transaction(
        input.addresses.freshVault,
        VAULT_ACTIVATION_INTERFACES.vault.encodeFunctionData("acceptOwnership")
      )
    );
  }
  if (input.includePolicyAcceptOwnership) {
    transactions.push(
      transaction(
        input.addresses.freshPolicy,
        VAULT_ACTIVATION_INTERFACES.policy.encodeFunctionData("acceptOwnership")
      )
    );
  }
  transactions.push(
    transaction(
      input.addresses.registry,
      VAULT_ACTIVATION_INTERFACES.registry.encodeFunctionData(
        "addWritePermission",
        [input.addresses.freshPolicy]
      )
    ),
    transaction(
      input.addresses.orchestrator,
      VAULT_ACTIVATION_INTERFACES.orchestrator.encodeFunctionData(
        "setLifecycleHook",
        [input.addresses.freshHook]
      )
    )
  );
  return transactions;
}

export function buildVaultWriterRemovalTransactions(input: {
  addresses: VaultActivationAddresses;
  guard: string;
}): NormalizedSafeBatchTransaction[] {
  return [
    transaction(
      input.guard,
      VAULT_ACTIVATION_INTERFACES.guard.encodeFunctionData("assertReady")
    ),
    transaction(
      input.addresses.registry,
      VAULT_ACTIVATION_INTERFACES.registry.encodeFunctionData(
        "removeWritePermission",
        [input.addresses.predecessorPolicy]
      )
    ),
  ];
}

export function buildVaultStagingTransaction(
  action: VaultStagingAction,
  addresses: VaultActivationAddresses,
  _lockProof: LockProof
): NormalizedSafeBatchTransaction {
  switch (action) {
    case "add-fresh-writer":
      return transaction(
        addresses.registry,
        VAULT_ACTIVATION_INTERFACES.registry.encodeFunctionData(
          "addWritePermission",
          [addresses.freshPolicy]
        )
      );
    case "set-fresh-hook":
      return transaction(
        addresses.orchestrator,
        VAULT_ACTIVATION_INTERFACES.orchestrator.encodeFunctionData(
          "setLifecycleHook",
          [addresses.freshHook]
        )
      );
    case "remove-predecessor-writer":
      if (!_lockProof.ok)
        throw new Error("Predecessor lock proof is not clean");
      return transaction(
        addresses.registry,
        VAULT_ACTIVATION_INTERFACES.registry.encodeFunctionData(
          "removeWritePermission",
          [addresses.predecessorPolicy]
        )
      );
  }
}

const VAULT_TRUST_SURFACE_FIELDS = [
  "freshPolicy.disputeVerifier",
  "freshPolicy.disputeNullifierRegistry",
  "freshPolicy.stakeVault",
  "predecessorPolicy.owner",
  "predecessorPolicy.pendingOwner",
  "predecessorPolicy.disputeVerifier",
  "predecessorPolicy.disputeNullifierRegistry",
  "predecessorPolicy.stakeVault",
  "predecessorVault.pendingController",
  "disputeVerifier.owner",
  "disputeVerifier.pendingOwner",
  "disputeVerifier.attestationVerifier",
  "disputeVerifier.nullifierRegistry",
  "freshVault.controller",
  "freshVault.pendingController",
  "freshVault.pendingControllerValidAt",
  "freshVault.controllerChangeDelay",
  "freshVault.stakeToken",
  "registry.owner",
  "orchestrator.owner",
  "orchestrator.paused",
  "orchestrator.escrowRegistry",
  "orchestrator.paymentVerifierRegistry",
  "orchestrator.relayerRegistry",
  "orchestrator.protocolFee",
  "orchestrator.protocolFeeRecipient",
  "orchestrator.allowMultipleIntents",
  "orchestrator.registered",
  "freshHook.orchestratorRegistry",
  "freshHook.whitelistPolicy",
  "freshHook.disputeProtectionPolicy",
  "whitelistPolicy.owner",
  "whitelistPolicy.escrowRegistry",
  "whitelistPolicy.groupRegistry",
  "whitelistPolicy.orchestratorRegistry",
  "attestationVerifier.owner",
  "attestationVerifier.requiredSignatures",
  "attestationVerifier.witnesses",
  "freshPolicy.admissionsPaused",
  "freshPolicy.authorizedHooks",
  "freshPolicy.riskWindows",
] as const;

export const VAULT_GUARD_BOUND_FIELDS: Record<
  VaultActivationBatchKind,
  readonly string[]
> = {
  "vault-cutover": [
    ...VAULT_TRUST_SURFACE_FIELDS,
    "freshVault.owner",
    "freshVault.pendingOwner",
    "freshPolicy.owner",
    "freshPolicy.pendingOwner",
    "registry.writers",
    "orchestrator.lifecycleHook",
    "inventory.escrow",
    "inventory.depositCounter",
    "inventory.tuples.escrow",
    "inventory.tuples.depositId",
    "inventory.tuples.paymentMethod",
  ],
  "vault-writer-removal": [
    ...VAULT_TRUST_SURFACE_FIELDS,
    "registry.writers",
    "orchestrator.lifecycleHook",
    "lockProof.intents.intentHash",
    "lockProof.intents.status",
    "lockProof.intents.lockAmount",
  ],
};

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current)) {
      return current.map((item) =>
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)[key]
          : undefined
      );
    }
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function comparable(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "string" && item.startsWith("0x")
      ? item.toLowerCase()
      : item
  );
}

export function assertVaultGuardExpectationsUnchanged(
  kind: VaultActivationBatchKind,
  proof: VaultActivationSnapshot,
  simulation: VaultActivationSnapshot
): void {
  const changed = VAULT_GUARD_BOUND_FIELDS[kind].filter(
    (path) =>
      comparable(getPath(proof, path)) !== comparable(getPath(simulation, path))
  );
  if (changed.length > 0)
    throw new Error(`Vault guard expectations changed: ${changed.join(", ")}`);
}
