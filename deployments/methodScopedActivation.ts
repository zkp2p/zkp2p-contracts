import { BigNumber, utils } from "ethers";

import type { NormalizedSafeBatchTransaction } from "./safeBatchManifest";

type ActivationBatchKind = "rotation" | "cutover";

export type ActivationNetwork = "base" | "base_staging";
export type IntentStatus = 0 | 1 | 2 | 3 | 4 | 5;
export type IntentClassification =
  | "none"
  | "pending"
  | "settled-unmatured"
  | "settled-matured"
  | "terminal"
  | "terminal-locked";
export type IntentLockState = {
  intentHash: string;
  status: IntentStatus;
  lockAmount: string;
  maturesAt: string;
  classification: IntentClassification;
};

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

export function classifyIntentLock(
  status: IntentStatus,
  lockAmount: string,
  maturesAt: string,
  now: string
): IntentClassification {
  const amount = decimal(lockAmount);
  if (status === 0) return "none";
  if (status === 1) return "pending";
  if (status === 3) {
    return decimal(now).gte(decimal(maturesAt))
      ? "settled-matured"
      : "settled-unmatured";
  }
  return amount.isZero() ? "terminal" : "terminal-locked";
}

export type LockProof = {
  fromBlock: number;
  toBlock: number;
  intents: IntentLockState[];
  ok: boolean;
  releasable: string[];
  blocking: string[];
  earliestMaturity: string | null;
};

export function proveNoLivePredecessorLocks(
  intents: IntentLockState[],
  fromBlock: number,
  toBlock: number
): LockProof {
  const blocking = intents
    .filter(
      (intent) =>
        ![2, 4, 5].includes(intent.status) ||
        !decimal(intent.lockAmount).isZero()
    )
    .map((intent) => intent.intentHash);
  const releasable = intents
    .filter((intent) => intent.classification === "settled-matured")
    .map((intent) => intent.intentHash);
  const futureMaturities = intents
    .filter((intent) => intent.classification === "settled-unmatured")
    .map((intent) => decimal(intent.maturesAt));
  const earliestMaturity = futureMaturities.reduce<BigNumber | null>(
    (earliest, maturity) =>
      earliest === null || maturity.lt(earliest) ? maturity : earliest,
    null
  );
  return {
    fromBlock,
    toBlock,
    intents,
    ok: blocking.length === 0,
    releasable,
    blocking,
    earliestMaturity: earliestMaturity?.toString() ?? null,
  };
}

export type InventorySource = "predecessor-opt-out" | "token-mismatch";
export type InventoryTuple = {
  escrow: string;
  depositId: string;
  paymentMethod: string;
  sources: InventorySource[];
};
export type ConfigEvent = {
  escrow: string;
  depositId: string;
  paymentMethod: string | null;
  enabled: boolean;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
};
export type InventoryDeposit = {
  depositId: string;
  depositor: string;
  token: string;
  listedPaymentMethods: string[];
};
export type InventoryInput = {
  escrow: string;
  depositCounter: string;
  stakeToken: string;
  block: number;
  deposits: InventoryDeposit[];
  successorRiskWindows: Record<string, string>;
  predecessorEvents: ConfigEvent[];
  successorEvents: ConfigEvent[];
  successorEnabled: (depositId: string, paymentMethod: string) => boolean;
};
export type DepositorInventory = {
  escrow: string;
  depositCounter: string;
  block: number;
  tuples: InventoryTuple[];
  violations: InventoryTuple[];
  ok: boolean;
};

function compareEvents(left: ConfigEvent, right: ConfigEvent): number {
  return (
    left.blockNumber - right.blockNumber ||
    left.transactionIndex - right.transactionIndex ||
    left.logIndex - right.logIndex
  );
}

function tupleKey(depositId: string, paymentMethod: string): string {
  return `${decimal(depositId).toString()}:${paymentMethod.toLowerCase()}`;
}

export function buildDepositorInventory(
  input: InventoryInput
): DepositorInventory {
  decimal(input.depositCounter);
  const relevantPredecessorEvents = input.predecessorEvents.filter(
    (event) =>
      sameAddress(event.escrow, input.escrow) && event.paymentMethod === null
  );
  const relevantSuccessorEvents = input.successorEvents.filter(
    (event) =>
      sameAddress(event.escrow, input.escrow) && event.paymentMethod !== null
  );
  const latestPredecessor = new Map<string, ConfigEvent>();
  for (const event of relevantPredecessorEvents) {
    const key = decimal(event.depositId).toString();
    const current = latestPredecessor.get(key);
    if (!current || compareEvents(current, event) < 0) {
      latestPredecessor.set(key, event);
    }
  }
  const latestSuccessor = new Map<string, ConfigEvent>();
  for (const event of relevantSuccessorEvents) {
    const key = tupleKey(event.depositId, event.paymentMethod as string);
    const current = latestSuccessor.get(key);
    if (!current || compareEvents(current, event) < 0) {
      latestSuccessor.set(key, event);
    }
  }

  const tupleSources = new Map<
    string,
    { depositId: string; paymentMethod: string; sources: Set<InventorySource> }
  >();
  for (const deposit of input.deposits) {
    if (
      sameAddress(
        deposit.depositor,
        utils.getAddress("0x0000000000000000000000000000000000000000")
      )
    ) {
      continue;
    }
    const depositId = decimal(deposit.depositId).toString();
    const predecessorEvent = latestPredecessor.get(depositId);
    for (const paymentMethod of deposit.listedPaymentMethods) {
      const riskWindow =
        input.successorRiskWindows[paymentMethod] ??
        input.successorRiskWindows[paymentMethod.toLowerCase()] ??
        "0";
      if (decimal(riskWindow).isZero()) continue;
      const key = tupleKey(depositId, paymentMethod);
      const sources = new Set<InventorySource>();
      if (predecessorEvent && !predecessorEvent.enabled) {
        const successorEvent = latestSuccessor.get(key);
        if (
          !successorEvent ||
          compareEvents(predecessorEvent, successorEvent) >= 0
        ) {
          sources.add("predecessor-opt-out");
        }
      }
      if (!sameAddress(deposit.token, input.stakeToken)) {
        sources.add("token-mismatch");
      }
      if (sources.size > 0) {
        tupleSources.set(key, { depositId, paymentMethod, sources });
      }
    }
  }

  const sourceOrder: InventorySource[] = [
    "predecessor-opt-out",
    "token-mismatch",
  ];
  const tuples = [...tupleSources.values()]
    .map(({ depositId, paymentMethod, sources }) => ({
      escrow: input.escrow,
      depositId,
      paymentMethod,
      sources: sourceOrder.filter((source) => sources.has(source)),
    }))
    .sort(
      (left, right) =>
        (decimal(left.depositId).lt(decimal(right.depositId))
          ? -1
          : decimal(left.depositId).gt(decimal(right.depositId))
          ? 1
          : 0) ||
        left.paymentMethod
          .toLowerCase()
          .localeCompare(right.paymentMethod.toLowerCase())
    );
  const violations = tuples.filter((tuple) =>
    input.successorEnabled(tuple.depositId, tuple.paymentMethod)
  );
  return {
    escrow: input.escrow,
    depositCounter: input.depositCounter,
    block: input.block,
    tuples,
    violations,
    ok: violations.length === 0,
  };
}

export type OwnershipState = { owner: string; pendingOwner: string };
export type ActivationSnapshot = {
  network: ActivationNetwork;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: string;
  freshPolicy: OwnershipState & {
    admissionsPaused: boolean;
    disputeVerifier: string;
    disputeNullifierRegistry: string;
    stakeVault: string;
    authorizedHooks: string[];
    riskWindows: Record<string, string>;
  };
  predecessorPolicy: OwnershipState & {
    admissionsPaused: boolean;
    disputeVerifier: string;
    disputeNullifierRegistry: string;
  };
  disputeVerifier: OwnershipState & {
    attestationVerifier: string;
    nullifierRegistry: string;
  };
  vault: OwnershipState & {
    controller: string;
    pendingController: string;
    pendingControllerValidAt: string;
    controllerChangeDelay: string;
    stakeToken: string;
  };
  registry: { owner: string; writers: string[] };
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
  freshHook: {
    orchestratorRegistry: string;
    whitelistPolicy: string;
    disputeProtectionPolicy: string;
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
  lockProof: LockProof;
  inventory: DepositorInventory;
};
export type ExpectedActivationState = {
  network: ActivationNetwork;
  governance: string;
  deployer: string;
  addresses: ActivationAddresses;
  riskWindows: Record<string, string>;
  witnesses: string[];
  controllerChangeDelay: string;
};
export type ActivationAddresses = {
  safe: string;
  deployer: string;
  escrow: string;
  vault: string;
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
export type ActivationPhase =
  | "deployed"
  | "rotation-proposed"
  | "active"
  | "unrecognized";
export type StagingAction =
  | "pause-predecessor-admissions"
  | "propose-controller"
  | "release-matured-predecessor-intents"
  | "accept-vault-controller"
  | "add-fresh-writer"
  | "set-fresh-hook"
  | "remove-predecessor-writer";
export type WaitingReason = "controller-delay" | "predecessor-drain";
export type ActivationReduction = {
  phase: ActivationPhase;
  nextStagingAction: StagingAction | null;
  waiting: { reason: WaitingReason; earliestChangeAt: string | null } | null;
  violations: string[];
};

type Invariant = readonly [name: string, holds: boolean];
type StateRow = {
  phase: Exclude<ActivationPhase, "unrecognized">;
  action: StagingAction | null;
  invariants: Invariant[];
};

function violated(invariants: readonly Invariant[]): string[] {
  return invariants.filter(([, holds]) => !holds).map(([name]) => name);
}

function equalRiskWindows(
  actual: Record<string, string>,
  expectedWindows: Record<string, string>
): boolean {
  const normalize = (value: Record<string, string>) =>
    Object.entries(value)
      .map(([method, window]) => [
        method.toLowerCase(),
        decimal(window).toString(),
      ])
      .sort(([left], [right]) => left.localeCompare(right));
  return (
    JSON.stringify(normalize(actual)) ===
    JSON.stringify(normalize(expectedWindows))
  );
}

function commonInvariants(
  snapshot: ActivationSnapshot,
  expected: ExpectedActivationState
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
      sameAddress(snapshot.freshPolicy.stakeVault, addresses.vault),
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
      sameAddress(
        snapshot.predecessorPolicy.pendingOwner,
        utils.getAddress("0x0000000000000000000000000000000000000000")
      ),
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
      "disputeVerifier.owner",
      sameAddress(snapshot.disputeVerifier.owner, governance),
    ],
    [
      "disputeVerifier.pendingOwner",
      sameAddress(
        snapshot.disputeVerifier.pendingOwner,
        utils.getAddress("0x0000000000000000000000000000000000000000")
      ),
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
    ["vault.owner", sameAddress(snapshot.vault.owner, governance)],
    [
      "vault.pendingOwner",
      sameAddress(
        snapshot.vault.pendingOwner,
        utils.getAddress("0x0000000000000000000000000000000000000000")
      ),
    ],
    [
      "vault.controllerChangeDelay",
      decimal(snapshot.vault.controllerChangeDelay).eq(
        decimal(expected.controllerChangeDelay)
      ),
    ],
    [
      "vault.stakeToken",
      sameAddress(snapshot.vault.stakeToken, addresses.stakeToken),
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
      !snapshot.orchestrator.allowMultipleIntents,
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

function ownershipInvariant(
  snapshot: ActivationSnapshot,
  owner: string,
  pendingOwner: string
): Invariant[] {
  return [
    ["freshPolicy.owner", sameAddress(snapshot.freshPolicy.owner, owner)],
    [
      "freshPolicy.pendingOwner",
      sameAddress(snapshot.freshPolicy.pendingOwner, pendingOwner),
    ],
  ];
}

function transitionInvariants(
  snapshot: ActivationSnapshot,
  expected: ExpectedActivationState,
  state:
    | "deployed"
    | "paused"
    | "proposed"
    | "controller-accepted"
    | "writer-added"
    | "hook-set"
    | "active"
): Invariant[] {
  const { addresses } = expected;
  const zero = utils.getAddress("0x0000000000000000000000000000000000000000");
  const controllerAccepted = [
    "controller-accepted",
    "writer-added",
    "hook-set",
    "active",
  ].includes(state);
  const writerAdded = ["writer-added", "hook-set"].includes(state);
  const hookFresh = ["hook-set", "active"].includes(state);
  const writers =
    state === "active"
      ? [addresses.freshPolicy]
      : writerAdded
      ? [addresses.predecessorPolicy, addresses.freshPolicy]
      : [addresses.predecessorPolicy];
  return [
    [
      "predecessorPolicy.admissionsPaused",
      snapshot.predecessorPolicy.admissionsPaused === (state !== "deployed"),
    ],
    [
      "vault.controller",
      sameAddress(
        snapshot.vault.controller,
        controllerAccepted ? addresses.freshPolicy : addresses.predecessorPolicy
      ),
    ],
    [
      "vault.pendingController",
      sameAddress(
        snapshot.vault.pendingController,
        state === "proposed" ? addresses.freshPolicy : zero
      ),
    ],
    [
      "vault.pendingControllerValidAt",
      state === "proposed"
        ? decimal(snapshot.vault.pendingControllerValidAt).gt(0)
        : decimal(snapshot.vault.pendingControllerValidAt).isZero(),
    ],
    [
      "registry.writers",
      sameOrderedAddresses(snapshot.registry.writers, writers),
    ],
    [
      "orchestrator.lifecycleHook",
      sameAddress(
        snapshot.orchestrator.lifecycleHook,
        hookFresh ? addresses.freshHook : addresses.predecessorHook
      ),
    ],
  ];
}

function closestViolations(rows: StateRow[]): string[] {
  return rows
    .map((row) => violated(row.invariants))
    .sort((left, right) => left.length - right.length)[0];
}

export function reduceActivation(
  snapshot: ActivationSnapshot,
  expected: ExpectedActivationState
): ActivationReduction {
  const commonViolations = violated(commonInvariants(snapshot, expected));
  const zero = utils.getAddress("0x0000000000000000000000000000000000000000");
  const governanceOwnership = ownershipInvariant(
    snapshot,
    expected.governance,
    zero
  );

  if (snapshot.network === "base") {
    const deployedOwnership = [
      [
        "freshPolicy.ownership",
        violated(governanceOwnership).length === 0 ||
          (sameAddress(snapshot.freshPolicy.owner, expected.deployer) &&
            sameAddress(
              snapshot.freshPolicy.pendingOwner,
              expected.addresses.safe
            )),
      ],
    ] as Invariant[];
    const rows: StateRow[] = [
      {
        phase: "deployed",
        action: null,
        invariants: [
          ...deployedOwnership,
          ...transitionInvariants(snapshot, expected, "deployed"),
        ],
      },
      {
        phase: "rotation-proposed",
        action: null,
        invariants: [
          ...governanceOwnership,
          ...transitionInvariants(snapshot, expected, "proposed"),
        ],
      },
      {
        phase: "active",
        action: null,
        invariants: [
          ...governanceOwnership,
          ...transitionInvariants(snapshot, expected, "active"),
        ],
      },
    ];
    const row = rows.find(
      (candidate) => violated(candidate.invariants).length === 0
    );
    if (commonViolations.length > 0 || !row) {
      return {
        phase: "unrecognized",
        nextStagingAction: null,
        waiting: null,
        violations: [
          ...commonViolations,
          ...(row ? [] : closestViolations(rows)),
        ],
      };
    }
    if (row.phase === "rotation-proposed") {
      if (!snapshot.inventory.ok) {
        return {
          phase: "unrecognized",
          nextStagingAction: null,
          waiting: null,
          violations: ["inventory.ok"],
        };
      }
      if (
        decimal(snapshot.blockTimestamp).lt(
          decimal(snapshot.vault.pendingControllerValidAt)
        )
      ) {
        return {
          phase: row.phase,
          nextStagingAction: null,
          waiting: {
            reason: "controller-delay",
            earliestChangeAt: snapshot.vault.pendingControllerValidAt,
          },
          violations: [],
        };
      }
      if (!snapshot.lockProof.ok) {
        return {
          phase: row.phase,
          nextStagingAction: null,
          waiting: {
            reason: "predecessor-drain",
            earliestChangeAt: snapshot.lockProof.earliestMaturity,
          },
          violations: [],
        };
      }
    }
    return {
      phase: row.phase,
      nextStagingAction: null,
      waiting: null,
      violations: [],
    };
  }

  const rows: StateRow[] = [
    {
      phase: "deployed",
      action: "pause-predecessor-admissions",
      invariants: [
        ...governanceOwnership,
        ...transitionInvariants(snapshot, expected, "deployed"),
      ],
    },
    {
      phase: "rotation-proposed",
      action: "propose-controller",
      invariants: [
        ...governanceOwnership,
        ...transitionInvariants(snapshot, expected, "paused"),
      ],
    },
    {
      phase: "rotation-proposed",
      action: null,
      invariants: [
        ...governanceOwnership,
        ...transitionInvariants(snapshot, expected, "proposed"),
      ],
    },
    {
      phase: "rotation-proposed",
      action: "add-fresh-writer",
      invariants: [
        ...governanceOwnership,
        ...transitionInvariants(snapshot, expected, "controller-accepted"),
      ],
    },
    {
      phase: "rotation-proposed",
      action: "set-fresh-hook",
      invariants: [
        ...governanceOwnership,
        ...transitionInvariants(snapshot, expected, "writer-added"),
      ],
    },
    {
      phase: "rotation-proposed",
      action: "remove-predecessor-writer",
      invariants: [
        ...governanceOwnership,
        ...transitionInvariants(snapshot, expected, "hook-set"),
      ],
    },
    {
      phase: "active",
      action: null,
      invariants: [
        ...governanceOwnership,
        ...transitionInvariants(snapshot, expected, "active"),
      ],
    },
  ];
  const row = rows.find(
    (candidate) => violated(candidate.invariants).length === 0
  );
  if (commonViolations.length > 0 || !row) {
    return {
      phase: "unrecognized",
      nextStagingAction: null,
      waiting: null,
      violations: [
        ...commonViolations,
        ...(row ? [] : closestViolations(rows)),
      ],
    };
  }
  if (row.action === null && row.phase === "rotation-proposed") {
    if (snapshot.lockProof.releasable.length > 0) {
      return {
        phase: row.phase,
        nextStagingAction: "release-matured-predecessor-intents",
        waiting: null,
        violations: [],
      };
    }
    if (
      decimal(snapshot.blockTimestamp).lt(
        decimal(snapshot.vault.pendingControllerValidAt)
      )
    ) {
      return {
        phase: row.phase,
        nextStagingAction: null,
        waiting: {
          reason: "controller-delay",
          earliestChangeAt: snapshot.vault.pendingControllerValidAt,
        },
        violations: [],
      };
    }
    if (!snapshot.lockProof.ok) {
      return {
        phase: row.phase,
        nextStagingAction: null,
        waiting: {
          reason: "predecessor-drain",
          earliestChangeAt: snapshot.lockProof.earliestMaturity,
        },
        violations: [],
      };
    }
    if (!snapshot.inventory.ok) {
      return {
        phase: "unrecognized",
        nextStagingAction: null,
        waiting: null,
        violations: ["inventory.ok"],
      };
    }
    return {
      phase: row.phase,
      nextStagingAction: "accept-vault-controller",
      waiting: null,
      violations: [],
    };
  }
  return {
    phase: row.phase,
    nextStagingAction: row.action,
    waiting: null,
    violations: [],
  };
}

const TRUST_SURFACE_FIELDS = [
  "freshPolicy.disputeVerifier",
  "freshPolicy.disputeNullifierRegistry",
  "freshPolicy.stakeVault",
  "predecessorPolicy.owner",
  "predecessorPolicy.pendingOwner",
  "predecessorPolicy.disputeVerifier",
  "predecessorPolicy.disputeNullifierRegistry",
  "disputeVerifier.owner",
  "disputeVerifier.pendingOwner",
  "disputeVerifier.attestationVerifier",
  "disputeVerifier.nullifierRegistry",
  "vault.controllerChangeDelay",
  "vault.stakeToken",
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
] as const;
const ROTATION_STATE_FIELDS = [
  "vault.controller",
  "vault.pendingController",
  "vault.owner",
  "vault.pendingOwner",
  "predecessorPolicy.admissionsPaused",
  "registry.writers",
  "orchestrator.lifecycleHook",
  "freshPolicy.owner",
  "freshPolicy.pendingOwner",
  "freshPolicy.admissionsPaused",
  "freshPolicy.authorizedHooks",
  "freshPolicy.riskWindows",
] as const;

export const GUARD_BOUND_FIELDS: Record<
  ActivationBatchKind,
  readonly string[]
> = {
  rotation: [...TRUST_SURFACE_FIELDS, ...ROTATION_STATE_FIELDS],
  cutover: [
    ...TRUST_SURFACE_FIELDS,
    ...ROTATION_STATE_FIELDS,
    "vault.pendingControllerValidAt",
    "lockProof.intents.intentHash",
    "lockProof.intents.status",
    "lockProof.intents.lockAmount",
    "inventory.depositCounter",
    "inventory.tuples.escrow",
    "inventory.tuples.depositId",
    "inventory.tuples.paymentMethod",
  ],
};
export const GUARD_PREDICATE_FIELDS: Record<
  ActivationBatchKind,
  readonly string[]
> = {
  rotation: [],
  cutover: [
    "blockTimestamp >= vault.pendingControllerValidAt",
    "lockProof.intents terminal and unlocked",
    "inventory.tuples disabled",
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

export function assertGuardExpectationsUnchanged(
  kind: ActivationBatchKind,
  proof: ActivationSnapshot,
  simulation: ActivationSnapshot
): void {
  const differences = GUARD_BOUND_FIELDS[kind].filter(
    (path) =>
      comparable(getPath(proof, path)) !== comparable(getPath(simulation, path))
  );
  if (differences.length > 0) {
    throw new Error(`Guard expectations changed: ${differences.join(", ")}`);
  }
}

export type TrustSurfaceInput = {
  safe: string;
  disputeRegistry: string;
  orchestrator: string;
  orchestratorRegistry: string;
  escrowRegistry: string;
  paymentVerifierRegistry: string;
  relayerRegistry: string;
  protocolFeeRecipient: string;
  freshHook: string;
  whitelistPolicy: string;
  groupRegistry: string;
  attestationVerifier: string;
  witnesses: string[];
  disputeVerifier: string;
  nullifierRegistryV2: string;
  predecessorPolicy: string;
  freshPolicy: string;
  vault: string;
  predecessorHook: string;
  paymentMethods: string[];
  riskWindows: string[];
};

export function buildTrustSurface(
  expected: ExpectedActivationState
): TrustSurfaceInput {
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
    freshHook: addresses.freshHook,
    whitelistPolicy: addresses.whitelistPolicy,
    groupRegistry: addresses.groupRegistry,
    attestationVerifier: addresses.attestationVerifier,
    witnesses: [...expected.witnesses],
    disputeVerifier: addresses.disputeVerifier,
    nullifierRegistryV2: addresses.nullifierRegistryV2,
    predecessorPolicy: addresses.predecessorPolicy,
    freshPolicy: addresses.freshPolicy,
    vault: addresses.vault,
    predecessorHook: addresses.predecessorHook,
    paymentMethods,
    riskWindows: paymentMethods.map((method) => expected.riskWindows[method]),
  };
}

export const ACTIVATION_INTERFACES = {
  guard: new utils.Interface(["function assertReady()"]),
  postcondition: new utils.Interface(["function assertPostconditions()"]),
  policy: new utils.Interface([
    "function acceptOwnership()",
    "function setAdmissionsPaused(bool paused)",
    "function acceptVaultController()",
    "function releaseMaturedDisputeProtectionIntents(bytes32[] intentHashes)",
  ]),
  vault: new utils.Interface([
    "function proposeController(address controller)",
  ]),
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

export function buildRotationTransactions(input: {
  addresses: ActivationAddresses;
  guard: string;
  includeAcceptOwnership: boolean;
}): NormalizedSafeBatchTransaction[] {
  const transactions = [
    transaction(
      input.guard,
      ACTIVATION_INTERFACES.guard.encodeFunctionData("assertReady")
    ),
  ];
  if (input.includeAcceptOwnership) {
    transactions.push(
      transaction(
        input.addresses.freshPolicy,
        ACTIVATION_INTERFACES.policy.encodeFunctionData("acceptOwnership")
      )
    );
  }
  transactions.push(
    transaction(
      input.addresses.predecessorPolicy,
      ACTIVATION_INTERFACES.policy.encodeFunctionData("setAdmissionsPaused", [
        true,
      ])
    ),
    transaction(
      input.addresses.vault,
      ACTIVATION_INTERFACES.vault.encodeFunctionData("proposeController", [
        input.addresses.freshPolicy,
      ])
    )
  );
  return transactions;
}

export function buildCutoverTransactions(input: {
  addresses: ActivationAddresses;
  guard: string;
}): NormalizedSafeBatchTransaction[] {
  return [
    transaction(
      input.guard,
      ACTIVATION_INTERFACES.guard.encodeFunctionData("assertReady")
    ),
    transaction(
      input.addresses.freshPolicy,
      ACTIVATION_INTERFACES.policy.encodeFunctionData("acceptVaultController")
    ),
    transaction(
      input.addresses.registry,
      ACTIVATION_INTERFACES.registry.encodeFunctionData("addWritePermission", [
        input.addresses.freshPolicy,
      ])
    ),
    transaction(
      input.addresses.registry,
      ACTIVATION_INTERFACES.registry.encodeFunctionData(
        "removeWritePermission",
        [input.addresses.predecessorPolicy]
      )
    ),
    transaction(
      input.addresses.orchestrator,
      ACTIVATION_INTERFACES.orchestrator.encodeFunctionData(
        "setLifecycleHook",
        [input.addresses.freshHook]
      )
    ),
  ];
}

export function buildStagingTransaction(
  action: StagingAction,
  addresses: ActivationAddresses,
  lockProof: LockProof
): NormalizedSafeBatchTransaction {
  switch (action) {
    case "pause-predecessor-admissions":
      return transaction(
        addresses.predecessorPolicy,
        ACTIVATION_INTERFACES.policy.encodeFunctionData("setAdmissionsPaused", [
          true,
        ])
      );
    case "propose-controller":
      return transaction(
        addresses.vault,
        ACTIVATION_INTERFACES.vault.encodeFunctionData("proposeController", [
          addresses.freshPolicy,
        ])
      );
    case "release-matured-predecessor-intents":
      return transaction(
        addresses.predecessorPolicy,
        ACTIVATION_INTERFACES.policy.encodeFunctionData(
          "releaseMaturedDisputeProtectionIntents",
          [lockProof.releasable]
        )
      );
    case "accept-vault-controller":
      return transaction(
        addresses.freshPolicy,
        ACTIVATION_INTERFACES.policy.encodeFunctionData("acceptVaultController")
      );
    case "add-fresh-writer":
      return transaction(
        addresses.registry,
        ACTIVATION_INTERFACES.registry.encodeFunctionData(
          "addWritePermission",
          [addresses.freshPolicy]
        )
      );
    case "set-fresh-hook":
      return transaction(
        addresses.orchestrator,
        ACTIVATION_INTERFACES.orchestrator.encodeFunctionData(
          "setLifecycleHook",
          [addresses.freshHook]
        )
      );
    case "remove-predecessor-writer":
      return transaction(
        addresses.registry,
        ACTIVATION_INTERFACES.registry.encodeFunctionData(
          "removeWritePermission",
          [addresses.predecessorPolicy]
        )
      );
  }
}
