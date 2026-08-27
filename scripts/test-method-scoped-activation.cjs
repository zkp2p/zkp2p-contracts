#!/usr/bin/env node

process.env.ALCHEMY_API_KEY ||= "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY ||=
  "1111111111111111111111111111111111111111111111111111111111111111";
process.env.TESTNET_DEPLOY_PRIVATE_KEY ||=
  "2222222222222222222222222222222222222222222222222222222222222222";

require(require.resolve("ts-node/register/transpile-only"));
require(require.resolve("module-alias/register"));
const moduleAlias = require(require.resolve("module-alias"));
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join } = require("node:path");
const { test } = require("node:test");
const { BigNumber, utils } = require("ethers");
const ethersPackage = require("ethers");
const { readFileSync: readTextFileSync } = require("node:fs");

const {
  ACTIVATION_INTERFACES,
  assertGuardExpectationsUnchanged,
  buildCutoverTransactions,
  buildDepositorInventory,
  buildRotationTransactions,
  buildStagingTransaction,
  buildTrustSurface,
  classifyIntentLock,
  proveNoLivePredecessorLocks,
  reduceActivation,
} = require("../deployments/methodScopedActivation.ts");
const {
  ACTIVATION_BATCH_PATHS,
  assertBatchMatchesActivationManifest,
  canonicalJson,
  computeManifestSha256,
  safeBatchJson,
  validateActivationBatchManifest,
} = require("../deployments/activationBatchManifest.ts");
const {
  assertSafeArtifactPairConsistent,
  installSafeArtifactPair,
} = require("../deployments/safeArtifacts.ts");
const {
  canonicalTransactionHash,
} = require("../deployments/safeBatchManifest.ts");

/** @param {number} value */
const address = (value) => `0x${value.toString(16).padStart(40, "0")}`;
/** @param {number} value */
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const ZERO = address(0);
const METHOD_A = hash(101);
const METHOD_B = hash(102);
const METHOD_ZERO = hash(103);

const addresses = {
  safe: address(1),
  deployer: address(2),
  escrow: address(3),
  vault: address(4),
  predecessorPolicy: address(5),
  freshPolicy: address(6),
  predecessorHook: address(7),
  freshHook: address(8),
  registry: address(9),
  orchestrator: address(10),
  orchestratorRegistry: address(11),
  escrowRegistry: address(12),
  paymentVerifierRegistry: address(13),
  relayerRegistry: address(14),
  protocolFeeRecipient: address(15),
  whitelistPolicy: address(16),
  groupRegistry: address(17),
  attestationVerifier: address(18),
  disputeVerifier: address(19),
  nullifierRegistryV2: address(20),
  stakeToken: address(21),
};

/**
 * @param {import("../deployments/methodScopedActivation").ActivationNetwork} network
 * @returns {import("../deployments/methodScopedActivation").ExpectedActivationState}
 */
function expected(network = "base") {
  return {
    network,
    governance: network === "base" ? addresses.safe : addresses.deployer,
    deployer: addresses.deployer,
    addresses,
    riskWindows: { [METHOD_A]: "86400", [METHOD_B]: "172800" },
    witnesses: [address(31), address(32)],
    controllerChangeDelay: "172800",
  };
}

/**
 * @param {string} intentHash
 * @returns {import("../deployments/methodScopedActivation").IntentLockState}
 */
function terminalIntent(intentHash = hash(201)) {
  return {
    intentHash,
    status: 4,
    lockAmount: "0",
    maturesAt: "0",
    classification: "terminal",
  };
}

/**
 * @param {import("../deployments/methodScopedActivation").IntentLockState[]} intents
 */
function lockProof(intents = [terminalIntent()]) {
  return proveNoLivePredecessorLocks(intents, 100, 200);
}

/**
 * @param {import("../deployments/methodScopedActivation").ActivationNetwork} network
 * @returns {import("../deployments/methodScopedActivation").ActivationSnapshot}
 */
function snapshot(network = "base") {
  const wanted = expected(network);
  const governance = wanted.governance;
  return {
    network,
    blockNumber: 200,
    blockHash: hash(200),
    blockTimestamp: "1000",
    freshPolicy: {
      owner: governance,
      pendingOwner: ZERO,
      admissionsPaused: false,
      disputeVerifier: addresses.disputeVerifier,
      disputeNullifierRegistry: addresses.registry,
      stakeVault: addresses.vault,
      authorizedHooks: [addresses.freshHook],
      riskWindows: { ...wanted.riskWindows },
    },
    predecessorPolicy: {
      owner: governance,
      pendingOwner: ZERO,
      admissionsPaused: false,
      disputeVerifier: addresses.disputeVerifier,
      disputeNullifierRegistry: addresses.registry,
    },
    disputeVerifier: {
      owner: governance,
      pendingOwner: ZERO,
      attestationVerifier: addresses.attestationVerifier,
      nullifierRegistry: addresses.nullifierRegistryV2,
    },
    vault: {
      owner: governance,
      pendingOwner: ZERO,
      controller: addresses.predecessorPolicy,
      pendingController: ZERO,
      pendingControllerValidAt: "0",
      controllerChangeDelay: wanted.controllerChangeDelay,
      stakeToken: addresses.stakeToken,
    },
    registry: { owner: governance, writers: [addresses.predecessorPolicy] },
    orchestrator: {
      owner: governance,
      paused: false,
      lifecycleHook: addresses.predecessorHook,
      escrowRegistry: addresses.escrowRegistry,
      paymentVerifierRegistry: addresses.paymentVerifierRegistry,
      relayerRegistry: addresses.relayerRegistry,
      protocolFee: "0",
      protocolFeeRecipient: addresses.protocolFeeRecipient,
      allowMultipleIntents: false,
      registered: true,
    },
    freshHook: {
      orchestratorRegistry: addresses.orchestratorRegistry,
      whitelistPolicy: addresses.whitelistPolicy,
      disputeProtectionPolicy: addresses.freshPolicy,
    },
    whitelistPolicy: {
      owner: governance,
      escrowRegistry: addresses.escrowRegistry,
      groupRegistry: addresses.groupRegistry,
      orchestratorRegistry: addresses.orchestratorRegistry,
    },
    attestationVerifier: {
      owner: governance,
      requiredSignatures: "1",
      witnesses: [...wanted.witnesses],
    },
    lockProof: lockProof(),
    inventory: {
      escrow: addresses.escrow,
      depositCounter: "4",
      block: 200,
      tuples: [],
      violations: [],
      ok: true,
    },
  };
}

/**
 * @param {import("../deployments/methodScopedActivation").ActivationSnapshot} state
 */
function proposed(state) {
  state.predecessorPolicy.admissionsPaused = true;
  state.vault.pendingController = addresses.freshPolicy;
  state.vault.pendingControllerValidAt = "900";
  return state;
}

/**
 * @param {import("../deployments/methodScopedActivation").ActivationSnapshot} state
 */
function active(state) {
  state.predecessorPolicy.admissionsPaused = true;
  state.vault.controller = addresses.freshPolicy;
  state.registry.writers = [addresses.freshPolicy];
  state.orchestrator.lifecycleHook = addresses.freshHook;
  return state;
}

test("classifyIntentLock covers every status and terminal locks", () => {
  /** @type {[import("../deployments/methodScopedActivation").IntentStatus, string, string, string, import("../deployments/methodScopedActivation").IntentClassification][]} */
  const cases = [
    [0, "0", "0", "10", "none"],
    [1, "5", "20", "10", "pending"],
    [2, "0", "0", "10", "terminal"],
    [2, "1", "0", "10", "terminal-locked"],
    [3, "5", "20", "10", "settled-unmatured"],
    [3, "5", "10", "10", "settled-matured"],
    [4, "0", "0", "10", "terminal"],
    [4, "1", "0", "10", "terminal-locked"],
    [5, "0", "0", "10", "terminal"],
    [5, "1", "0", "10", "terminal-locked"],
  ];
  for (const [status, amount, maturesAt, now, classification] of cases) {
    assert.equal(
      classifyIntentLock(status, amount, maturesAt, now),
      classification
    );
  }
});

test("proveNoLivePredecessorLocks reports terminal, releasable, blocking, and earliest maturity", () => {
  /** @type {import("../deployments/methodScopedActivation").IntentLockState[]} */
  const intents = [
    terminalIntent(hash(1)),
    {
      intentHash: hash(2),
      status: 3,
      lockAmount: "5",
      maturesAt: "90",
      classification: "settled-matured",
    },
    {
      intentHash: hash(3),
      status: 3,
      lockAmount: "5",
      maturesAt: "130",
      classification: "settled-unmatured",
    },
    {
      intentHash: hash(4),
      status: 1,
      lockAmount: "5",
      maturesAt: "0",
      classification: "pending",
    },
  ];
  const proof = proveNoLivePredecessorLocks(intents, 10, 20);
  assert.equal(proof.ok, false);
  assert.deepEqual(proof.releasable, [hash(2)]);
  assert.deepEqual(proof.blocking, [hash(2), hash(3), hash(4)]);
  assert.equal(proof.earliestMaturity, "130");
  assert.equal(
    proveNoLivePredecessorLocks([terminalIntent()], 10, 20).ok,
    true
  );
  assert.equal(
    proveNoLivePredecessorLocks(
      [{ ...terminalIntent(), classification: "pending" }],
      10,
      20
    ).ok,
    true
  );
});

test("buildDepositorInventory applies extant, escrow, window, event-order, and token rules", () => {
  const otherEscrow = address(99);
  const result = buildDepositorInventory({
    escrow: addresses.escrow,
    depositCounter: "6",
    stakeToken: addresses.stakeToken,
    block: 500,
    deposits: [
      {
        depositId: "0",
        depositor: address(40),
        token: addresses.stakeToken,
        listedPaymentMethods: [METHOD_A, METHOD_ZERO],
      },
      {
        depositId: "1",
        depositor: ZERO,
        token: address(88),
        listedPaymentMethods: [METHOD_A],
      },
      {
        depositId: "2",
        depositor: address(42),
        token: addresses.stakeToken,
        listedPaymentMethods: [METHOD_A, METHOD_B],
      },
      {
        depositId: "3",
        depositor: address(43),
        token: address(88),
        listedPaymentMethods: [METHOD_A],
      },
      {
        depositId: "4",
        depositor: address(44),
        token: address(88),
        listedPaymentMethods: [METHOD_B],
      },
      {
        depositId: "5",
        depositor: address(45),
        token: addresses.stakeToken,
        listedPaymentMethods: [METHOD_A],
      },
    ],
    successorRiskWindows: {
      [METHOD_A]: "10",
      [METHOD_B]: "20",
      [METHOD_ZERO]: "0",
    },
    predecessorEvents: [
      {
        escrow: addresses.escrow,
        depositId: "0",
        paymentMethod: null,
        enabled: false,
        blockNumber: 100,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        escrow: addresses.escrow,
        depositId: "2",
        paymentMethod: null,
        enabled: false,
        blockNumber: 200,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        escrow: addresses.escrow,
        depositId: "3",
        paymentMethod: null,
        enabled: false,
        blockNumber: 250,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        escrow: addresses.escrow,
        depositId: "4",
        paymentMethod: null,
        enabled: false,
        blockNumber: 300,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        escrow: addresses.escrow,
        depositId: "5",
        paymentMethod: null,
        enabled: false,
        blockNumber: 400,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        escrow: otherEscrow,
        depositId: "0",
        paymentMethod: null,
        enabled: true,
        blockNumber: 999,
        transactionIndex: 0,
        logIndex: 0,
      },
    ],
    successorEvents: [
      {
        escrow: addresses.escrow,
        depositId: "2",
        paymentMethod: METHOD_A,
        enabled: true,
        blockNumber: 201,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        escrow: addresses.escrow,
        depositId: "3",
        paymentMethod: METHOD_A,
        enabled: true,
        blockNumber: 251,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        escrow: addresses.escrow,
        depositId: "4",
        paymentMethod: METHOD_B,
        enabled: true,
        blockNumber: 299,
        transactionIndex: 9,
        logIndex: 9,
      },
      {
        escrow: addresses.escrow,
        depositId: "5",
        paymentMethod: METHOD_A,
        enabled: false,
        blockNumber: 401,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        escrow: otherEscrow,
        depositId: "0",
        paymentMethod: METHOD_A,
        enabled: true,
        blockNumber: 999,
        transactionIndex: 0,
        logIndex: 0,
      },
    ],
    successorEnabled: (depositId, method) =>
      depositId === "2" && method === METHOD_B,
  });
  assert.deepEqual(result.tuples, [
    {
      escrow: addresses.escrow,
      depositId: "0",
      paymentMethod: METHOD_A,
      sources: ["predecessor-opt-out"],
    },
    {
      escrow: addresses.escrow,
      depositId: "2",
      paymentMethod: METHOD_B,
      sources: ["predecessor-opt-out"],
    },
    {
      escrow: addresses.escrow,
      depositId: "3",
      paymentMethod: METHOD_A,
      sources: ["token-mismatch"],
    },
    {
      escrow: addresses.escrow,
      depositId: "4",
      paymentMethod: METHOD_B,
      sources: ["predecessor-opt-out", "token-mismatch"],
    },
  ]);
  assert.deepEqual(result.violations, [result.tuples[1]]);
  assert.equal(result.ok, false);
});

test("reduceActivation recognizes every Base phase and rejects invalid combinations", () => {
  assert.deepEqual(reduceActivation(snapshot(), expected()), {
    phase: "deployed",
    nextStagingAction: null,
    waiting: null,
    violations: [],
  });
  assert.equal(
    reduceActivation(proposed(snapshot()), expected()).phase,
    "rotation-proposed"
  );
  assert.equal(
    reduceActivation(active(snapshot()), expected()).phase,
    "active"
  );

  /** @type {((state: import("../deployments/methodScopedActivation").ActivationSnapshot) => void)[]} */
  const invalidStates = [
    (state) => {
      state.vault.pendingController = address(90);
    },
    (state) => {
      state.freshPolicy.pendingOwner = address(91);
    },
    (state) => {
      state.registry.writers.push(addresses.freshPolicy);
    },
    (state) => {
      state.vault.controller = addresses.freshPolicy;
    },
    (state) => {
      state.freshPolicy.authorizedHooks.push(addresses.predecessorHook);
    },
  ];
  for (const mutate of invalidStates) {
    const state = snapshot();
    mutate(state);
    const result = reduceActivation(state, expected());
    assert.equal(result.phase, "unrecognized");
    assert.ok(result.violations.length > 0);
  }
});

test("reduceActivation recognizes the full staging action table and waiting states", () => {
  /** @type {[import("../deployments/methodScopedActivation").ActivationSnapshot, import("../deployments/methodScopedActivation").StagingAction | null][]} */
  const cases = [];
  cases.push([snapshot("base_staging"), "pause-predecessor-admissions"]);
  const paused = snapshot("base_staging");
  paused.predecessorPolicy.admissionsPaused = true;
  cases.push([paused, "propose-controller"]);
  const releasable = proposed(snapshot("base_staging"));
  releasable.lockProof = lockProof([
    {
      intentHash: hash(77),
      status: 3,
      lockAmount: "4",
      maturesAt: "900",
      classification: "settled-matured",
    },
  ]);
  cases.push([releasable, "release-matured-predecessor-intents"]);
  const accept = proposed(snapshot("base_staging"));
  cases.push([accept, "accept-vault-controller"]);
  const addWriter = proposed(snapshot("base_staging"));
  addWriter.vault.controller = addresses.freshPolicy;
  addWriter.vault.pendingController = ZERO;
  addWriter.vault.pendingControllerValidAt = "0";
  cases.push([addWriter, "add-fresh-writer"]);
  const setHook = structuredClone(addWriter);
  setHook.registry.writers = [
    addresses.predecessorPolicy,
    addresses.freshPolicy,
  ];
  cases.push([setHook, "set-fresh-hook"]);
  const removeWriter = structuredClone(setHook);
  removeWriter.orchestrator.lifecycleHook = addresses.freshHook;
  cases.push([removeWriter, "remove-predecessor-writer"]);
  const done = active(snapshot("base_staging"));
  cases.push([done, null]);

  for (const [state, action] of cases) {
    const result = reduceActivation(state, expected("base_staging"));
    assert.notEqual(result.phase, "unrecognized", action ?? "active");
    assert.equal(result.nextStagingAction, action);
  }

  const delay = proposed(snapshot("base_staging"));
  delay.vault.pendingControllerValidAt = "1100";
  assert.deepEqual(reduceActivation(delay, expected("base_staging")).waiting, {
    reason: "controller-delay",
    earliestChangeAt: "1100",
  });
  const drain = proposed(snapshot("base_staging"));
  drain.lockProof = lockProof([
    {
      intentHash: hash(78),
      status: 3,
      lockAmount: "4",
      maturesAt: "1200",
      classification: "settled-unmatured",
    },
  ]);
  assert.deepEqual(reduceActivation(drain, expected("base_staging")).waiting, {
    reason: "predecessor-drain",
    earliestChangeAt: "1200",
  });
});

test("lane 38 unrecognized-state errors identify offending inventory tuples", () => {
  const {
    assertRecognizedActivationState,
  } = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  const state = proposed(snapshot("base_staging"));
  state.inventory.ok = false;
  state.inventory.violations = [
    {
      escrow: addresses.escrow,
      depositId: "42",
      paymentMethod: METHOD_A,
      sources: ["predecessor-opt-out", "token-mismatch"],
    },
  ];
  const result = reduceActivation(state, expected("base_staging"));
  assert.equal(result.phase, "unrecognized");
  assert.throws(
    () => assertRecognizedActivationState("Base staging", state, result),
    new RegExp(
      `${addresses.escrow}:42:${METHOD_A}.*predecessor-opt-out.*token-mismatch`
    )
  );
});

test("fresh successor lifecycle activity is rejected only before the hook switch", () => {
  const {
    classifyActivationFreshStackActivity,
  } = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  const fakeHre = {
    predecessor: { lifecycleHook: addresses.predecessorHook },
    successor: { lifecycleHook: addresses.freshHook },
  };
  const events = [
    {
      name: "DisputeProtectionIntentOpened",
      blockNumber: 10,
      transactionIndex: 0,
      logIndex: 0,
      transactionHash: hash(10),
    },
  ];
  assert.doesNotThrow(() =>
    classifyActivationFreshStackActivity(
      events,
      fakeHre.successor.lifecycleHook,
      addresses.predecessorHook
    )
  );
  assert.throws(
    () =>
      classifyActivationFreshStackActivity(
        events,
        fakeHre.predecessor.lifecycleHook,
        addresses.predecessorHook
      ),
    /lifecycle activity/
  );
});

test("guard expectation comparison ignores block metadata and reports changed writers", () => {
  const proof = snapshot();
  const current = structuredClone(proof);
  current.blockNumber += 1;
  current.blockTimestamp = "2000";
  current.blockHash = hash(201);
  assert.doesNotThrow(() =>
    assertGuardExpectationsUnchanged("rotation", proof, current)
  );
  current.registry.writers = [addresses.freshPolicy];
  assert.throws(
    () => assertGuardExpectationsUnchanged("rotation", proof, current),
    /registry\.writers/
  );
});

test("cutover guard comparison binds only intent and inventory fields checked on-chain", () => {
  const proof = snapshot();
  proof.inventory.tuples = [
    {
      escrow: addresses.escrow,
      depositId: "1",
      paymentMethod: METHOD_A,
      sources: ["predecessor-opt-out"],
    },
  ];
  const current = structuredClone(proof);
  current.lockProof.intents[0].maturesAt = "999";
  current.lockProof.intents[0].classification = "terminal-locked";
  current.inventory.tuples[0].sources = ["token-mismatch"];
  assert.doesNotThrow(() =>
    assertGuardExpectationsUnchanged("cutover", proof, current)
  );
  current.lockProof.intents[0].status = 5;
  assert.throws(
    () => assertGuardExpectationsUnchanged("cutover", proof, current),
    /lockProof\.intents\.status/
  );
  current.lockProof.intents[0].status = proof.lockProof.intents[0].status;
  current.inventory.escrow = address(404);
  assert.throws(
    () => assertGuardExpectationsUnchanged("cutover", proof, current),
    /inventory\.escrow/
  );
});

test("buildTrustSurface maps addresses and preserves payment method and witness order", () => {
  assert.deepEqual(buildTrustSurface(expected()), {
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
    witnesses: expected().witnesses,
    disputeVerifier: addresses.disputeVerifier,
    nullifierRegistryV2: addresses.nullifierRegistryV2,
    predecessorPolicy: addresses.predecessorPolicy,
    freshPolicy: addresses.freshPolicy,
    vault: addresses.vault,
    predecessorHook: addresses.predecessorHook,
    paymentMethods: [METHOD_A, METHOD_B],
    riskWindows: ["86400", "172800"],
  });
});

/**
 * @param {import("ethers").utils.Interface} iface
 * @param {import("../deployments/safeBatchManifest").NormalizedSafeBatchTransaction} transaction
 */
function decode(iface, transaction) {
  return iface.parseTransaction({ data: transaction.data });
}

test("rotation and cutover builders encode exact atomic call order", () => {
  const guard = address(80);
  const rotation = buildRotationTransactions({
    addresses,
    guard,
    includeAcceptOwnership: true,
  });
  assert.deepEqual(
    rotation.map((transaction) => transaction.to),
    [guard, addresses.freshPolicy, addresses.predecessorPolicy, addresses.vault]
  );
  assert.deepEqual(
    rotation.map(
      (transaction) =>
        decode(
          transaction.to === guard
            ? ACTIVATION_INTERFACES.guard
            : transaction.to === addresses.vault
            ? ACTIVATION_INTERFACES.vault
            : ACTIVATION_INTERFACES.policy,
          transaction
        ).name
    ),
    [
      "assertReady",
      "acceptOwnership",
      "setAdmissionsPaused",
      "proposeController",
    ]
  );
  assert.equal(decode(ACTIVATION_INTERFACES.policy, rotation[2]).args[0], true);
  assert.equal(
    decode(ACTIVATION_INTERFACES.vault, rotation[3]).args[0].toLowerCase(),
    addresses.freshPolicy
  );
  assert.equal(
    buildRotationTransactions({
      addresses,
      guard,
      includeAcceptOwnership: false,
    }).length,
    3
  );

  const cutover = buildCutoverTransactions({ addresses, guard });
  assert.deepEqual(
    cutover.map((transaction) => transaction.to),
    [
      guard,
      addresses.freshPolicy,
      addresses.registry,
      addresses.registry,
      addresses.orchestrator,
    ]
  );
  assert.deepEqual(
    [
      decode(ACTIVATION_INTERFACES.guard, cutover[0]).name,
      decode(ACTIVATION_INTERFACES.policy, cutover[1]).name,
      decode(ACTIVATION_INTERFACES.registry, cutover[2]).name,
      decode(ACTIVATION_INTERFACES.registry, cutover[3]).name,
      decode(ACTIVATION_INTERFACES.orchestrator, cutover[4]).name,
    ],
    [
      "assertReady",
      "acceptVaultController",
      "addWritePermission",
      "removeWritePermission",
      "setLifecycleHook",
    ]
  );
});

test("buildStagingTransaction encodes every staging action", () => {
  const proof = { ...lockProof(), releasable: [hash(300), hash(301)] };
  /** @type {Record<import("../deployments/methodScopedActivation").StagingAction, [string, import("ethers").utils.Interface, string]>} */
  const expectedCalls = {
    "pause-predecessor-admissions": [
      addresses.predecessorPolicy,
      ACTIVATION_INTERFACES.policy,
      "setAdmissionsPaused",
    ],
    "propose-controller": [
      addresses.vault,
      ACTIVATION_INTERFACES.vault,
      "proposeController",
    ],
    "release-matured-predecessor-intents": [
      addresses.predecessorPolicy,
      ACTIVATION_INTERFACES.policy,
      "releaseMaturedDisputeProtectionIntents",
    ],
    "accept-vault-controller": [
      addresses.freshPolicy,
      ACTIVATION_INTERFACES.policy,
      "acceptVaultController",
    ],
    "add-fresh-writer": [
      addresses.registry,
      ACTIVATION_INTERFACES.registry,
      "addWritePermission",
    ],
    "set-fresh-hook": [
      addresses.orchestrator,
      ACTIVATION_INTERFACES.orchestrator,
      "setLifecycleHook",
    ],
    "remove-predecessor-writer": [
      addresses.registry,
      ACTIVATION_INTERFACES.registry,
      "removeWritePermission",
    ],
  };
  for (const [action, [target, iface, call]] of Object.entries(expectedCalls)) {
    const transaction = buildStagingTransaction(
      /** @type {import("../deployments/methodScopedActivation").StagingAction} */ (
        action
      ),
      addresses,
      proof
    );
    assert.equal(transaction.to, target);
    assert.equal(decode(iface, transaction).name, call);
  }
  assert.deepEqual(
    decode(
      ACTIVATION_INTERFACES.policy,
      buildStagingTransaction(
        "release-matured-predecessor-intents",
        addresses,
        proof
      )
    ).args[0],
    proof.releasable
  );
});

test("canonicalJson sorts object keys and rejects lossy or unsupported values", () => {
  assert.equal(
    canonicalJson({ z: [2, { b: true, a: null }], a: "x" }),
    '{"a":"x","z":[2,{"a":null,"b":true}]}'
  );
  for (const value of [
    BigNumber.from(1),
    { _hex: "0x01" },
    { value: undefined },
    Object.assign({}, { [Symbol("key")]: "value" }),
    new Array(1),
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    () => {},
    Symbol("x"),
  ]) {
    assert.throws(() => canonicalJson(value));
  }
});

function manifestFixture() {
  const transactions = buildRotationTransactions({
    addresses,
    guard: address(80),
    includeAcceptOwnership: false,
  });
  const proofSnapshot = snapshot();
  /** @type {Omit<import("../deployments/activationBatchManifest").ActivationBatchManifest, "manifestSha256">} */
  const unsigned = {
    version: 2,
    kind: "rotation",
    chainId: 8453,
    safe: addresses.safe,
    safeNonce: "7",
    sourceSha: "a".repeat(40),
    proofBlock: { number: 200, hash: hash(200) },
    simulationBlockNumber: 201,
    simulationBlockHash: hash(201),
    simulationResult: "success",
    transactions,
    transactionsSha256: canonicalTransactionHash(transactions),
    guard: {
      address: address(80),
      artifactName: "DisputeMethodScopedRotationGuard",
      constructorArgs: [],
      deployTransactionHash: hash(800),
      runtimeCodeHash: hash(801),
    },
    postcondition: {
      address: address(81),
      artifactName: "DisputeMethodScopedRotationPostcondition",
      constructorArgs: [],
      deployTransactionHash: hash(810),
      runtimeCodeHash: hash(811),
    },
    trustSurface: buildTrustSurface(expected()),
    proofSnapshot,
  };
  return { ...unsigned, manifestSha256: computeManifestSha256(unsigned) };
}

test("manifest validation covers exact schema, transaction digest, full snapshot digest, and expected fields", () => {
  const manifest = manifestFixture();
  assert.doesNotThrow(() =>
    validateActivationBatchManifest(manifest, {
      kind: "rotation",
      safe: addresses.safe,
    })
  );
  const tampered = structuredClone(manifest);
  tampered.proofSnapshot.lockProof.intents[0].status = 5;
  assert.throws(
    () => validateActivationBatchManifest(tampered),
    /Invalid activation Safe batch manifest/
  );
  const extra = { ...manifest, unexpected: true };
  assert.throws(
    () => validateActivationBatchManifest(extra),
    /Invalid activation Safe batch manifest/
  );
});

test("safeBatchJson uses lane-38 metadata and matches its manifest", () => {
  const manifest = manifestFixture();
  /** @type {any} */
  const batch = safeBatchJson("rotation", manifest.transactions, 1234);
  assert.equal(batch.meta.name, ACTIVATION_BATCH_PATHS.rotation.meta.name);
  assert.equal(batch.createdAt, 1234);
  assert.doesNotThrow(() =>
    assertBatchMatchesActivationManifest(batch, manifest)
  );
  batch.transactions[0].data = "0x";
  assert.throws(() => assertBatchMatchesActivationManifest(batch, manifest));
});

test("installSafeArtifactPair installs, detects unchanged, and archives a replaced pair", () => {
  const directory = mkdtempSync(join(tmpdir(), "method-scoped-artifacts-"));
  const supersededDir = join(directory, "superseded");
  const batchPath = join(directory, "base_method_scoped_rotation.json");
  const sidecarPath = join(
    directory,
    "base_method_scoped_rotation.sha256.json"
  );
  const input = {
    batchPath,
    sidecarPath,
    supersededDir,
    batchContents: "batch-v1",
    sidecarContents: "sidecar-v1",
    supersededSuffix: "100_abcdef",
  };
  assert.equal(installSafeArtifactPair(input), "installed");
  assert.equal(installSafeArtifactPair(input), "unchanged");
  assert.equal(
    installSafeArtifactPair({
      ...input,
      batchContents: "batch-v2",
      sidecarContents: "sidecar-v2",
    }),
    "installed"
  );
  assert.equal(
    readFileSync(
      join(supersededDir, `${basename(batchPath, ".json")}_100_abcdef.json`),
      "utf8"
    ),
    "batch-v1"
  );
  assert.equal(
    readFileSync(
      join(
        supersededDir,
        `${basename(batchPath, ".json")}_100_abcdef.sha256.json`
      ),
      "utf8"
    ),
    "sidecar-v1"
  );
});

test("installSafeArtifactPair rejects a one-file pair", () => {
  const directory = mkdtempSync(join(tmpdir(), "method-scoped-incomplete-"));
  const batchPath = join(directory, "batch.json");
  const sidecarPath = join(directory, "batch.sha256.json");
  mkdirSync(join(directory, "superseded"));
  writeFileSync(batchPath, "batch");
  assert.throws(
    () =>
      installSafeArtifactPair({
        batchPath,
        sidecarPath,
        supersededDir: join(directory, "superseded"),
        batchContents: "new",
        sidecarContents: "new",
        supersededSuffix: "x",
      }),
    /incomplete artifact pair/
  );
});

test("assertSafeArtifactPairConsistent parses and verifies the transaction hash", () => {
  const directory = mkdtempSync(join(tmpdir(), "method-scoped-consistent-"));
  const batchPath = join(directory, "batch.json");
  const sidecarPath = join(directory, "batch.sha256.json");
  const manifest = manifestFixture();
  /** @type {any} */
  const batch = safeBatchJson("rotation", manifest.transactions, 1234);
  writeFileSync(batchPath, JSON.stringify(batch));
  writeFileSync(sidecarPath, JSON.stringify(manifest));
  const pair = assertSafeArtifactPairConsistent(batchPath, sidecarPath);
  assert.deepEqual(pair.batch, batch);
  assert.deepEqual(pair.manifest, manifest);
  manifest.transactionsSha256 = "0".repeat(64);
  writeFileSync(sidecarPath, JSON.stringify(manifest));
  assert.throws(
    () => assertSafeArtifactPairConsistent(batchPath, sidecarPath),
    /incomplete artifact pair/
  );
});

test("lane 38 exports its identity, Base helpers, and no dependencies", () => {
  const lane = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  assert.deepEqual([...lane.SUPPORTED_NETWORKS], ["base_staging", "base"]);
  assert.equal(lane.TAG, "38_activate_method_scoped_dispute_lifecycle_stack");
  assert.deepEqual(lane.default.tags, [
    "38_activate_method_scoped_dispute_lifecycle_stack",
    "V3DisputeMethodScopedActivation",
  ]);
  assert.deepEqual(lane.default.dependencies, []);
  assert.equal(
    lane.FLAGS.stagingPrepare,
    "PREPARE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION"
  );
  assert.equal(
    lane.FLAGS.stagingExecute,
    "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION"
  );
  assert.equal(
    lane.FLAGS.baseRotationPrepare,
    "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_ROTATION_PREPARATION"
  );
  assert.equal(
    lane.FLAGS.baseCutoverPrepare,
    "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_CUTOVER_PREPARATION"
  );
  assert.equal(
    lane.FLAGS.baseReleaseMatured,
    "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_RELEASE_MATURED"
  );
  assert.equal(
    lane.FLAGS.confirmActivation("base_staging"),
    "CONFIRM_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION"
  );
  assert.equal(
    lane.FLAGS.confirmDownstreamReady("base"),
    "CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_DOWNSTREAM_READY"
  );
  assert.equal(
    lane.FLAGS.releaseReadySha,
    "CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_RELEASE_READY_SHA"
  );
  assert.equal(typeof lane.prepareBaseRotationBatch, "function");
  assert.equal(typeof lane.prepareBaseCutoverBatch, "function");
  assert.equal(typeof lane.deployActivationContract, "function");
  assert.equal(typeof lane.runPinnedSimulation, "function");
});

test("deploy summary includes both lane 38 tags without a dependency chain", () => {
  const summary = readTextFileSync("deploy/deploy_summary.ts", "utf8");
  assert.match(summary, /38_activate_method_scoped_dispute_lifecycle_stack/);
  assert.match(summary, /V3DisputeMethodScopedActivation/);
  const tsconfig = JSON.parse(
    readTextFileSync("tsconfig.dispute-deployment.json", "utf8")
  );
  assert.ok(
    tsconfig.files.includes(
      "deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts"
    )
  );
});

test("lane 38 skip rejects unsafe selection before any chain read", async () => {
  const lane = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  const envNames = [
    "DEPLOY_ACTIVE_TAG",
    lane.FLAGS.stagingPrepare,
    lane.FLAGS.stagingExecute,
    lane.FLAGS.baseRotationPrepare,
    lane.FLAGS.baseCutoverPrepare,
    lane.FLAGS.baseReleaseMatured,
  ];
  const saved = Object.fromEntries(
    envNames.map((name) => [name, process.env[name]])
  );
  const skip = lane.default.skip;
  assert.ok(skip);
  /** @param {string} network */
  const hre = (network) =>
    /** @type {any} */ ({
      deployments: { getNetworkName: () => network },
      ethers: {
        provider: new Proxy(
          {},
          {
            get: () => () => {
              throw new Error("unexpected chain read");
            },
          }
        ),
      },
    });
  try {
    for (const name of envNames) delete process.env[name];
    assert.equal(await skip(hre("sepolia")), true);
    assert.equal(await skip(hre("localhost")), true);
    process.env.DEPLOY_ACTIVE_TAG = lane.TAG;
    await assert.rejects(
      skip(hre("hardhat")),
      /no predecessor stack on local networks/
    );
    delete process.env.DEPLOY_ACTIVE_TAG;
    assert.equal(await skip(hre("base")), true);
    process.env[lane.FLAGS.baseRotationPrepare] = "true";
    await assert.rejects(skip(hre("base")), /DEPLOY_ACTIVE_TAG/);
    await assert.rejects(skip(hre("localhost")), /DEPLOY_ACTIVE_TAG/);
    await assert.rejects(skip(hre("sepolia")), /DEPLOY_ACTIVE_TAG/);
  } finally {
    for (const name of envNames) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("Base rotation, cutover, and release flags treat an active snapshot as a no-op", async () => {
  const {
    assertBaseActionPhase,
    default: laneFunction,
    FLAGS: laneFlags,
    TAG: laneTag,
  } = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  const fakeHre = /** @type {any} */ ({
    deployments: { getNetworkName: () => "base" },
    snapshot: active(snapshot()),
  });
  const skip = laneFunction.skip;
  assert.ok(skip);
  const cases = /** @type {const} */ ([
    [laneFlags.baseRotationPrepare, "rotation"],
    [laneFlags.baseCutoverPrepare, "cutover"],
    [laneFlags.baseReleaseMatured, "release-matured"],
  ]);
  const savedTag = process.env.DEPLOY_ACTIVE_TAG;
  const savedFlags = Object.fromEntries(
    cases.map(([flag]) => [flag, process.env[flag]])
  );
  /** @type {string[]} */
  const messages = [];
  const originalLog = console.log;
  console.log = (message) => messages.push(String(message));
  try {
    process.env.DEPLOY_ACTIVE_TAG = laneTag;
    for (const [selectedFlag, action] of cases) {
      for (const [flag] of cases) delete process.env[flag];
      process.env[selectedFlag] = "true";
      assert.equal(await skip(fakeHre), false);
      assert.equal(
        assertBaseActionPhase(action, fakeHre.snapshot, expected()),
        false
      );
    }
  } finally {
    console.log = originalLog;
    if (savedTag === undefined) delete process.env.DEPLOY_ACTIVE_TAG;
    else process.env.DEPLOY_ACTIVE_TAG = savedTag;
    for (const [flag] of cases) {
      const saved = savedFlags[flag];
      if (saved === undefined) delete process.env[flag];
      else process.env[flag] = saved;
    }
  }
  assert.deepEqual(messages, [
    "=== Base method-scoped dispute stack is active; nothing to prepare ===",
    "=== Base method-scoped dispute stack is active; nothing to prepare ===",
    "=== Base method-scoped dispute stack is active; nothing to prepare ===",
  ]);
});

test("canonical and predecessor helpers thread an optional block tag", async () => {
  const {
    assertCanonicalDeployment,
    assertDeploymentMatchesChain,
  } = require("../deployments/canonicalDeployment.ts");
  const {
    assertHistoricalDisputeStack,
  } = require("../deployments/predecessorDisputeStack.ts");
  const code = "0x6000";
  const deployment = {
    address: address(500),
    abi: [],
    deployedBytecode: code,
    solcInputHash: hash(500),
  };
  /** @type {Array<[string, string | number | undefined]>} */
  const calls = [];
  const canonicalHre = /** @type {any} */ ({
    deployments: {
      getExtendedArtifact: async () => ({
        deployedBytecode: code,
        solcInputHash: deployment.solcInputHash,
        evm: { deployedBytecode: { immutableReferences: {} } },
      }),
    },
    ethers: {
      provider: {
        /** @param {string} target @param {string | number | undefined} blockTag */
        getCode: async (target, blockTag) => {
          calls.push([target, blockTag]);
          return code;
        },
      },
    },
  });
  await assertDeploymentMatchesChain(
    canonicalHre,
    deployment,
    "Example",
    "Example",
    123
  );
  await assertCanonicalDeployment(
    canonicalHre,
    deployment,
    "Example",
    "Example",
    "0xabc"
  );
  assert.deepEqual(calls, [
    [deployment.address, 123],
    [deployment.address, "0xabc"],
    [deployment.address, "0xabc"],
  ]);

  /** @type {Array<[string, string | number | undefined]>} */
  const historicalCalls = [];
  const historicalHre = {
    deployments: {
      getNetworkName: () => "base_staging",
      /** @param {string} name */
      get: async (name) => require(`../deployments/base_staging/${name}.json`),
    },
    ethers: {
      provider: {
        /** @param {string} target @param {string | number | undefined} blockTag */
        getCode: async (target, blockTag) => {
          historicalCalls.push([target, blockTag]);
          return "0x";
        },
      },
    },
  };
  await assert.rejects(
    assertHistoricalDisputeStack(historicalHre, undefined, 456),
    /runtime bytecode hash mismatch/
  );
  assert.equal(historicalCalls[0][1], 456);
});

test("readActivationSnapshot pins every read and decodes both policy event signatures", async () => {
  const lane = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  const {
    EXPECTED_LIVE,
    getRiskWindowPaymentMethods,
  } = require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts");
  const {
    METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS,
  } = require("../deployments/predecessorDisputeStack.ts");
  const {
    DISPUTABLE_PAYMENT_METHODS,
    DISPUTE_RISK_WINDOW,
  } = require("../deployments/parameters.ts");
  const compiledPolicy = require("../artifacts/contracts/hooks/DisputeProtectionPolicy.sol/DisputeProtectionPolicy.json");
  const predecessorRecord = require("../deployments/base_staging/DisputeProtectionPolicy.json");
  const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS.base_staging;
  const live = EXPECTED_LIVE.base_staging;
  const deployer = live.deployer.toLowerCase();
  const escrow = address(600);
  const whitelistPolicy = address(601);
  const freshPolicy = address(602);
  const freshHook = address(603);
  const thirdHook = address(604);
  const blockTag = 20777;
  const blockHash = hash(blockTag);
  const paymentMethods = getRiskWindowPaymentMethods("base_staging");
  const riskWindows = Object.fromEntries(
    paymentMethods.map((method) => [
      utils.keccak256(utils.toUtf8Bytes(method)).toLowerCase(),
      DISPUTABLE_PAYMENT_METHODS.includes(method)
        ? DISPUTE_RISK_WINDOW.base_staging.toString()
        : "0",
    ])
  );
  const listedMethod = utils
    .keccak256(utils.toUtf8Bytes("paypal"))
    .toLowerCase();
  const unlistedMethod = hash(705);
  /** @type {string[]} */
  const successorEnabledReads = [];
  const intentHash = hash(700);
  const predecessorInterface = new utils.Interface(predecessorRecord.abi);
  const successorInterface = new utils.Interface(compiledPolicy.abi);

  /**
   * @param {utils.Interface} iface
   * @param {string} eventName
   * @param {unknown[]} args
   * @param {string} emitter
   * @param {number} blockNumber
   * @param {number} logIndex
   */
  function rawLog(iface, eventName, args, emitter, blockNumber, logIndex) {
    const encoded = iface.encodeEventLog(iface.getEvent(eventName), args);
    return {
      address: emitter,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber,
      transactionIndex: 0,
      logIndex,
      transactionHash: hash(800 + logIndex),
      blockHash: hash(blockNumber),
      removed: false,
    };
  }

  const logs = [
    rawLog(
      predecessorInterface,
      "DisputeProtectionIntentOpened",
      [
        intentHash,
        address(701),
        address(702),
        address(703),
        listedMethod,
        "5",
        "100",
      ],
      predecessor.contracts.DisputeProtectionPolicy.address,
      120,
      1
    ),
    rawLog(
      successorInterface,
      "DisputeProtectionEnabledUpdated",
      [escrow, "0", listedMethod, true],
      freshPolicy,
      130,
      2
    ),
    rawLog(
      predecessorInterface,
      "DisputeProtectionEnabledUpdated",
      [escrow, "0", false],
      predecessor.contracts.DisputeProtectionPolicy.address,
      140,
      3
    ),
    rawLog(
      successorInterface,
      "LifecycleHookAuthorizationUpdated",
      [freshHook, true],
      freshPolicy,
      150,
      4
    ),
    rawLog(
      successorInterface,
      "LifecycleHookAuthorizationUpdated",
      [thirdHook, true],
      freshPolicy,
      151,
      5
    ),
    rawLog(
      successorInterface,
      "LifecycleHookAuthorizationUpdated",
      [thirdHook, false],
      freshPolicy,
      152,
      6
    ),
  ];
  assert.notEqual(
    predecessorInterface.getEventTopic("DisputeProtectionEnabledUpdated"),
    successorInterface.getEventTopic("DisputeProtectionEnabledUpdated")
  );

  /** @param {Record<string, unknown>} methods */
  const taggedContract = (methods) =>
    new Proxy(
      {},
      {
        /** @param {object} _target @param {string} property */
        get(_target, property) {
          if (property === "then") return undefined;
          /** @param {unknown[]} args */
          return async (...args) => {
            const override = args.at(-1);
            assert.deepEqual(override, { blockTag });
            const value = methods[property];
            return typeof value === "function"
              ? value(...args.slice(0, -1))
              : value;
          };
        },
      }
    );

  const contracts = new Map();
  contracts.set(
    freshPolicy.toLowerCase(),
    taggedContract({
      owner: deployer,
      pendingOwner: ZERO,
      admissionsPaused: false,
      disputeVerifier: predecessor.contracts.DisputeVerifier.address,
      disputeNullifierRegistry:
        predecessor.contracts.DisputeNullifierRegistry.address,
      stakeVault: predecessor.contracts.StakeVault.address,
      /** @param {string} method */
      getRiskWindow: (method) => BigNumber.from(riskWindows[method]),
      /** @param {string} _escrow @param {BigNumber} _depositId @param {string} method */
      isDisputeProtectionEnabled: (_escrow, _depositId, method) => {
        successorEnabledReads.push(method);
        return false;
      },
    })
  );
  contracts.set(
    predecessor.contracts.DisputeProtectionPolicy.address.toLowerCase(),
    taggedContract({
      owner: deployer,
      pendingOwner: ZERO,
      admissionsPaused: false,
      disputeVerifier: predecessor.contracts.DisputeVerifier.address,
      disputeNullifierRegistry:
        predecessor.contracts.DisputeNullifierRegistry.address,
      getDisputeProtectionIntent: { status: 4 },
    })
  );
  contracts.set(
    predecessor.contracts.DisputeVerifier.address.toLowerCase(),
    taggedContract({
      owner: deployer,
      pendingOwner: ZERO,
      attestationVerifier: live.attestationVerifier,
      nullifierRegistry: live.nullifierRegistryV2,
    })
  );
  contracts.set(
    predecessor.contracts.StakeVault.address.toLowerCase(),
    taggedContract({
      owner: deployer,
      pendingOwner: ZERO,
      controller: predecessor.contracts.DisputeProtectionPolicy.address,
      pendingController: ZERO,
      pendingControllerValidAt: BigNumber.from(0),
      controllerChangeDelay: BigNumber.from(172800),
      stakeToken: live.stakeToken,
      locks: [address(701), BigNumber.from(0), BigNumber.from(0)],
    })
  );
  contracts.set(
    predecessor.contracts.DisputeNullifierRegistry.address.toLowerCase(),
    taggedContract({
      owner: deployer,
      getWriters: [predecessor.contracts.DisputeProtectionPolicy.address],
    })
  );
  contracts.set(
    live.orchestrator.toLowerCase(),
    taggedContract({
      owner: deployer,
      paused: false,
      lifecycleHook: predecessor.activeLifecycleHook.address,
      escrowRegistry: live.escrowRegistry,
      paymentVerifierRegistry: live.paymentVerifierRegistry,
      relayerRegistry: live.relayerRegistry,
      protocolFee: BigNumber.from(0),
      protocolFeeRecipient: live.protocolFeeRecipient,
      allowMultipleIntents: false,
    })
  );
  contracts.set(
    live.orchestratorRegistry.toLowerCase(),
    taggedContract({ isOrchestrator: true })
  );
  contracts.set(
    freshHook.toLowerCase(),
    taggedContract({
      orchestratorRegistry: live.orchestratorRegistry,
      whitelistPolicy,
      disputeProtectionPolicy: freshPolicy,
    })
  );
  contracts.set(
    whitelistPolicy.toLowerCase(),
    taggedContract({
      owner: deployer,
      escrowRegistry: live.escrowRegistry,
      groupRegistry: live.addressGroupRegistry,
      orchestratorRegistry: live.orchestratorRegistry,
    })
  );
  contracts.set(
    live.attestationVerifier.toLowerCase(),
    taggedContract({
      owner: deployer,
      requiredSignatures: BigNumber.from(1),
      witnesses: live.attestationWitnesses,
    })
  );
  contracts.set(
    escrow.toLowerCase(),
    taggedContract({
      depositCounter: BigNumber.from(1),
      getDeposit: {
        depositor: address(900),
        token: live.stakeToken,
      },
      getDepositPaymentMethods: [listedMethod, unlistedMethod],
    })
  );

  /** @type {Record<string, any>} */
  const records = {
    EscrowV2: { address: escrow, abi: [], receipt: { blockNumber: 100 } },
    WhitelistPolicyMethodScoped: {
      address: whitelistPolicy,
      abi: [],
      receipt: { blockNumber: 100 },
    },
    DisputeProtectionPolicyMethodScoped: {
      address: freshPolicy,
      abi: compiledPolicy.abi,
      receipt: { blockNumber: 100 },
    },
    IntentLifecycleHookV1MethodScoped: {
      address: freshHook,
      abi: [],
      receipt: { blockNumber: 100 },
    },
    DisputeProtectionPolicy: {
      ...predecessorRecord,
      receipt: { ...predecessorRecord.receipt, blockNumber: 100 },
    },
  };
  /** @type {any[]} */
  const logQueries = [];
  const provider = {
    /** @param {string | number} requestedTag */
    getBlock: async (requestedTag) => {
      assert.equal(requestedTag, blockTag);
      return { number: blockTag, hash: blockHash, timestamp: 1000 };
    },
    /** @param {any} filter */
    getLogs: async (filter) => {
      logQueries.push(filter);
      assert.ok(Number.isSafeInteger(filter.fromBlock));
      assert.ok(Number.isSafeInteger(filter.toBlock));
      assert.ok(filter.toBlock - filter.fromBlock < 10000);
      return logs.filter((log) => {
        if (log.address.toLowerCase() !== filter.address.toLowerCase())
          return false;
        if (
          log.blockNumber < filter.fromBlock ||
          log.blockNumber > filter.toBlock
        )
          return false;
        return (filter.topics || []).every(
          /** @param {string | null} topic @param {number} index */
          (topic, index) => topic == null || log.topics[index] === topic
        );
      });
    },
  };
  const hre = /** @type {any} */ ({
    getUnnamedAccounts: async () => [deployer],
    deployments: {
      /** @param {string} name */
      getOrNull: async (name) => records[name] || null,
      /** @param {string} name */
      getExtendedArtifact: async (name) => {
        assert.equal(name, "DisputeProtectionPolicy");
        return compiledPolicy;
      },
    },
    ethers: {
      provider,
      BigNumber,
      utils,
      /** @param {unknown} _artifact @param {string} target */
      getContractAt: async (_artifact, target) => {
        const contract = contracts.get(target.toLowerCase());
        if (!contract) throw new Error(`unexpected contract ${target}`);
        return contract;
      },
    },
  });
  const result = await lane.readActivationSnapshot(
    hre,
    "base_staging",
    blockTag
  );
  assert.equal(result.blockNumber, blockTag);
  assert.equal(result.lockProof.intents[0].intentHash, intentHash);
  assert.equal(result.lockProof.intents[0].classification, "terminal");
  assert.deepEqual(result.freshPolicy.authorizedHooks, [freshHook]);
  assert.deepEqual(result.inventory.tuples, [
    {
      escrow,
      depositId: "0",
      paymentMethod: listedMethod,
      sources: ["predecessor-opt-out"],
    },
  ]);
  assert.equal(result.inventory.ok, true);
  assert.deepEqual(successorEnabledReads, [listedMethod]);
  assert.ok(logQueries.some((query) => query.fromBlock >= 10000));
  assert.equal(
    lane.expectedActivationState("base_staging").addresses.freshPolicy,
    freshPolicy
  );
});

test("staging advance accepts the controller wait but rejects a two-step jump", () => {
  const {
    assertStagingAdvance,
  } = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  /** @type {import("../deployments/methodScopedActivation").ActivationReduction} */
  const before = {
    phase: "rotation-proposed",
    nextStagingAction: "propose-controller",
    waiting: null,
    violations: [],
  };
  assert.doesNotThrow(() =>
    assertStagingAdvance(before, {
      phase: "rotation-proposed",
      nextStagingAction: null,
      waiting: { reason: "controller-delay", earliestChangeAt: "100" },
      violations: [],
    })
  );
  assert.throws(
    () =>
      assertStagingAdvance(before, {
        phase: "rotation-proposed",
        nextStagingAction: "add-fresh-writer",
        waiting: null,
        violations: [],
      }),
    /exactly one step/
  );
});

test("staging flags are mutually exclusive and confirmations fail in order", async () => {
  const lane = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  const names = [
    lane.FLAGS.stagingPrepare,
    lane.FLAGS.stagingExecute,
    lane.FLAGS.confirmActivation("base_staging"),
    lane.FLAGS.confirmDownstreamReady("base_staging"),
  ];
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  );
  const hre = /** @type {any} */ ({});
  try {
    for (const name of names) delete process.env[name];
    process.env[lane.FLAGS.stagingPrepare] = "true";
    process.env[lane.FLAGS.stagingExecute] = "true";
    await assert.rejects(
      lane.prepareOrExecuteStagingActivation(hre),
      /Set exactly one/
    );
    delete process.env[lane.FLAGS.stagingExecute];
    await assert.rejects(
      lane.prepareOrExecuteStagingActivation(hre),
      new RegExp(lane.FLAGS.confirmActivation("base_staging"))
    );
    process.env[lane.FLAGS.confirmActivation("base_staging")] = "true";
    await assert.rejects(
      lane.prepareOrExecuteStagingActivation(hre),
      new RegExp(lane.FLAGS.confirmDownstreamReady("base_staging"))
    );
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("Task 4 simulator and verifier expose the lane-38 verification surface", () => {
  const simulator = require("./simulate-method-scoped-safe-batch.ts");
  const verifier = require("./verify-method-scoped-safe-batch.ts");
  assert.equal(typeof simulator.simulateMethodScopedSafeBatch, "function");
  assert.equal(typeof verifier.verifyActivationCandidate, "function");
  assert.equal(typeof verifier.verifyMethodScopedSafeArtifacts, "function");
  assert.equal(typeof verifier.assertActivationArtifactGitState, "function");
});

test("Task 4 manifest digest binds guard, postcondition, trust surface, lock proof, and inventory", () => {
  const manifest = manifestFixture();
  /** @type {Array<(value: any) => unknown>} */
  const mutations = [
    (value) => (value.guard.runtimeCodeHash = hash(900)),
    (value) => (value.postcondition.deployTransactionHash = hash(901)),
    (value) => (value.trustSurface.vault = address(902)),
    (value) => (value.proofSnapshot.lockProof.intents[0].status = 5),
    (value) => (value.proofSnapshot.inventory.depositCounter = "5"),
  ];
  for (const mutate of mutations) {
    const tampered = structuredClone(manifest);
    mutate(tampered);
    assert.throws(() => validateActivationBatchManifest(tampered));
  }
});

test("Task 4 simulator rejects a wrong guard runtime hash", async () => {
  const {
    assertManifestContractRuntimeHashes,
  } = require("./simulate-method-scoped-safe-batch.ts");
  const manifest = manifestFixture();
  const code = "0x6000";
  manifest.guard.runtimeCodeHash = hash(999);
  manifest.postcondition.runtimeCodeHash = utils.keccak256(code);
  const hre = /** @type {any} */ ({
    ethers: {
      provider: {
        getCode: async () => code,
      },
    },
  });
  await assert.rejects(
    assertManifestContractRuntimeHashes(hre, manifest),
    /Activation guard runtime bytecode hash mismatch/
  );
});

test("Task 4 Safe simulation envelope decoder accepts a fake-provider success envelope", () => {
  const {
    decodeMethodScopedSafeSimulationEnvelope,
  } = require("./simulate-method-scoped-safe-batch.ts");
  const envelope = utils.hexConcat([
    utils.hexZeroPad("0x01", 32),
    utils.hexZeroPad("0x00", 32),
  ]);
  assert.deepEqual(decodeMethodScopedSafeSimulationEnvelope(envelope), {
    success: true,
    returnData: "0x",
  });
});

/** @param {string} prefix */
function temporaryGitRepository(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "tracked"), "base\n");
  execFileSync("git", ["add", "tracked"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Task Four",
      "-c",
      "user.email=task4@example.invalid",
      "commit",
      "-qm",
      "base",
    ],
    { cwd: root }
  );
  return {
    root,
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  };
}

test("generation Git mode requires a clean worktree and exact source HEAD", () => {
  const {
    assertActivationArtifactGitState,
  } = require("./verify-method-scoped-safe-batch.ts");
  const repository = temporaryGitRepository("method-scoped-generation-");
  assert.doesNotThrow(() =>
    assertActivationArtifactGitState(
      repository.root,
      repository.sourceSha,
      "generation",
      []
    )
  );
  assert.throws(
    () =>
      assertActivationArtifactGitState(
        repository.root,
        "f".repeat(40),
        "generation",
        []
      ),
    /HEAD does not equal/
  );
  writeFileSync(join(repository.root, "tracked"), "dirty\n");
  assert.throws(
    () =>
      assertActivationArtifactGitState(
        repository.root,
        repository.sourceSha,
        "generation",
        []
      ),
    /clean worktree/
  );
});

test("artifact-child Git mode allows only the selected lane-38 pair and its superseded copies", () => {
  const {
    assertActivationArtifactGitState,
  } = require("./verify-method-scoped-safe-batch.ts");
  const repository = temporaryGitRepository("method-scoped-child-");
  const allowed = ACTIVATION_BATCH_PATHS.rotation;
  mkdirSync(join(repository.root, "deployments/outputs/safe-batches"), {
    recursive: true,
  });
  writeFileSync(join(repository.root, allowed.batch), "{}\n");
  writeFileSync(join(repository.root, allowed.sidecar), "{}\n");
  execFileSync("git", ["add", "."], { cwd: repository.root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Task Four",
      "-c",
      "user.email=task4@example.invalid",
      "commit",
      "-qm",
      "artifacts",
    ],
    { cwd: repository.root }
  );
  const allowlist = [
    allowed.batch,
    allowed.sidecar,
    `${allowed.supersededDir}/base_method_scoped_rotation_*`,
  ];
  assert.doesNotThrow(() =>
    assertActivationArtifactGitState(
      repository.root,
      repository.sourceSha,
      "artifact-child",
      allowlist
    )
  );
  mkdirSync(
    join(repository.root, "deployments/outputs/safe-batches/superseded"),
    {
      recursive: true,
    }
  );
  const lane34Path =
    "deployments/outputs/safe-batches/superseded/base_opt_in_dispute_lifecycle.json";
  writeFileSync(join(repository.root, lane34Path), "{}\n");
  execFileSync("git", ["add", "."], { cwd: repository.root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Task Four",
      "-c",
      "user.email=task4@example.invalid",
      "commit",
      "-qm",
      "unrelated",
    ],
    { cwd: repository.root }
  );
  assert.throws(
    () =>
      assertActivationArtifactGitState(
        repository.root,
        repository.sourceSha,
        "artifact-child",
        allowlist
      ),
    /base_opt_in_dispute_lifecycle/
  );
});

/**
 * @param {"rotation" | "cutover"} kind
 * @param {{ nonce?: string, proofBlockHash?: string, snapshotAtF?: import("../deployments/methodScopedActivation").ActivationSnapshot, simulationError?: Error }} [overrides]
 */
function verificationFixture(kind, overrides = {}) {
  const {
    deriveActivationConstructorArgs,
    verifyActivationCandidate,
  } = require("./verify-method-scoped-safe-batch.ts");
  const { BASE_SAFE } = require("./simulate-dispute-opt-in-safe-batch.ts");
  const repository = temporaryGitRepository(`method-scoped-core-${kind}-`);
  const proofSnapshot = kind === "rotation" ? snapshot() : proposed(snapshot());
  const guardAddress = address(kind === "rotation" ? 950 : 960);
  const postconditionAddress = address(kind === "rotation" ? 951 : 961);
  const transactions =
    kind === "rotation"
      ? buildRotationTransactions({
          addresses,
          guard: guardAddress,
          includeAcceptOwnership: false,
        })
      : buildCutoverTransactions({ addresses, guard: guardAddress });
  const guardArtifactName = `DisputeMethodScoped${
    kind === "rotation" ? "Rotation" : "Cutover"
  }Guard`;
  const postconditionArtifactName = `DisputeMethodScoped${
    kind === "rotation" ? "Rotation" : "Cutover"
  }Postcondition`;
  const runtime = "0x6001";
  const runtimeHash = utils.keccak256(runtime);
  /** @type {any} */
  const unsigned = {
    version: 2,
    kind,
    chainId: 8453,
    safe: BASE_SAFE.toLowerCase(),
    safeNonce: "7",
    sourceSha: repository.sourceSha,
    proofBlock: { number: 200, hash: hash(200) },
    simulationBlockNumber: 201,
    simulationBlockHash: hash(201),
    simulationResult: "success",
    transactions,
    transactionsSha256: canonicalTransactionHash(transactions),
    guard: {
      address: guardAddress,
      artifactName: guardArtifactName,
      constructorArgs: [],
      deployTransactionHash: hash(952),
      runtimeCodeHash: runtimeHash,
    },
    postcondition: {
      address: postconditionAddress,
      artifactName: postconditionArtifactName,
      constructorArgs: [],
      deployTransactionHash: hash(953),
      runtimeCodeHash: runtimeHash,
    },
    trustSurface: buildTrustSurface(expected()),
    proofSnapshot,
  };
  /** @type {any} */
  const manifest = {
    ...unsigned,
    manifestSha256: computeManifestSha256(unsigned),
  };
  manifest.guard.constructorArgs = deriveActivationConstructorArgs(
    manifest,
    "guard"
  );
  manifest.postcondition.constructorArgs = deriveActivationConstructorArgs(
    manifest,
    "postcondition"
  );
  {
    const { manifestSha256: _oldDigest, ...withConstructorArgs } = manifest;
    manifest.manifestSha256 = computeManifestSha256(withConstructorArgs);
  }
  const hardhatGuard = require(`../artifacts/contracts/mocks/${guardArtifactName}.sol/${guardArtifactName}.json`);
  const hardhatPostcondition = require(`../artifacts/contracts/mocks/${postconditionArtifactName}.sol/${postconditionArtifactName}.json`);
  /** @type {Record<string, any>} */
  const artifacts = {
    [guardArtifactName]: {
      abi: hardhatGuard.abi,
      bytecode: "0x6000",
      deployedBytecode: runtime,
      evm: { deployedBytecode: { immutableReferences: {} } },
    },
    [postconditionArtifactName]: {
      abi: hardhatPostcondition.abi,
      bytecode: "0x6000",
      deployedBytecode: runtime,
      evm: { deployedBytecode: { immutableReferences: {} } },
    },
  };
  /** @type {Record<string, {data: string}>} */
  const deploymentTransactions = {};
  /** @type {Record<string, {status: number, contractAddress: string}>} */
  const receipts = {};
  for (const [role, identity] of [
    ["guard", manifest.guard],
    ["postcondition", manifest.postcondition],
  ]) {
    const artifact = artifacts[identity.artifactName];
    const encoded = new utils.Interface(artifact.abi).encodeDeploy(
      deriveActivationConstructorArgs(
        manifest,
        /** @type {"guard" | "postcondition"} */ (role)
      )
    );
    deploymentTransactions[identity.deployTransactionHash] = {
      data: `${artifact.bytecode}${encoded.slice(2)}`,
    };
    receipts[identity.deployTransactionHash] = {
      status: 1,
      contractAddress: identity.address,
    };
  }
  const provider = {
    _isProvider: true,
    getNetwork: async () => ({ chainId: 8453, name: "base" }),
    /** @param {string | number} blockTag */
    getBlock: async (blockTag) =>
      blockTag === manifest.proofBlock.number
        ? {
            number: manifest.proofBlock.number,
            hash: overrides.proofBlockHash || manifest.proofBlock.hash,
            timestamp: manifest.proofBlock.number,
          }
        : { number: 300, hash: hash(300), timestamp: 300 },
    /** @param {string} name */
    resolveName: async (name) => name,
    call: async () =>
      utils.defaultAbiCoder.encode(["uint256"], [overrides.nonce || "7"]),
    /** @param {string} transactionHash */
    getTransactionReceipt: async (transactionHash) =>
      receipts[transactionHash] || null,
    /** @param {string} transactionHash */
    getTransaction: async (transactionHash) =>
      deploymentTransactions[transactionHash] || null,
    getCode: async () => runtime,
  };
  const hre = /** @type {any} */ ({
    __methodScopedVerificationProvider: provider,
    deployments: {
      /** @param {string} name */
      getExtendedArtifact: async (name) => artifacts[name],
      /** @param {string} name */
      getArtifact: async (name) => artifacts[name],
    },
    ethers: ethersPackage,
  });
  const batch = safeBatchJson(kind, transactions, 1234);
  const lane = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  const originalRead = lane.readActivationSnapshot;
  const originalSimulation = lane.runPinnedSimulation;
  const originalExpected = lane.expectedActivationState;
  lane.readActivationSnapshot = async () =>
    overrides.snapshotAtF || structuredClone(proofSnapshot);
  lane.runPinnedSimulation = async () => {
    if (overrides.simulationError) throw overrides.simulationError;
  };
  lane.expectedActivationState = () => expected();
  const run = async () => {
    try {
      await verifyActivationCandidate(hre, {
        kind,
        batch,
        manifest,
        mode: "generation",
        repositoryRoot: repository.root,
        forkRpcUrl: "fake-rpc",
        artifactPaths: { batch: "unused", sidecar: "unused" },
      });
    } finally {
      lane.readActivationSnapshot = originalRead;
      lane.runPinnedSimulation = originalSimulation;
      lane.expectedActivationState = originalExpected;
    }
  };
  return { run, manifest, provider, receipts, deploymentTransactions };
}

test("verifier core rejects nonce, proof-block hash, initcode, postcondition identity, and receipt-address drift", async () => {
  await assert.rejects(
    verificationFixture("rotation", { nonce: "8" }).run(),
    /Safe nonce drifted/
  );
  await assert.rejects(
    verificationFixture("rotation", { proofBlockHash: hash(999) }).run(),
    /proof block hash/i
  );
  {
    const fixture = verificationFixture("rotation");
    fixture.deploymentTransactions[
      fixture.manifest.guard.deployTransactionHash
    ].data = "0x6002";
    await assert.rejects(fixture.run(), /guard deployment initcode mismatch/);
  }
  {
    const fixture = verificationFixture("rotation");
    fixture.deploymentTransactions[
      fixture.manifest.postcondition.deployTransactionHash
    ].data = "0x6002";
    await assert.rejects(
      fixture.run(),
      /postcondition deployment initcode mismatch/
    );
  }
  {
    const fixture = verificationFixture("rotation");
    fixture.receipts[
      fixture.manifest.guard.deployTransactionHash
    ].contractAddress = address(999);
    await assert.rejects(fixture.run(), /contractAddress mismatch/);
  }
});

test("verifier core rejects inventory, lock-proof, authorized-hook, and simulation drift", async () => {
  /** @type {import("../deployments/methodScopedActivation").InventorySource[][]} */
  const inventorySources = [["predecessor-opt-out"], ["token-mismatch"]];
  for (const sources of inventorySources) {
    const current = proposed(snapshot());
    current.inventory.tuples.push({
      escrow: addresses.escrow,
      depositId: "2",
      paymentMethod: METHOD_A,
      sources,
    });
    await assert.rejects(
      verificationFixture("cutover", { snapshotAtF: current }).run(),
      /inventory\.tuples/
    );
  }
  {
    const fixture = verificationFixture("cutover");
    fixture.manifest.proofSnapshot.inventory.escrow = address(997);
    const { manifestSha256: _digest, ...unsigned } = fixture.manifest;
    fixture.manifest.manifestSha256 = computeManifestSha256(unsigned);
    await assert.rejects(fixture.run(), /inventory escrow/i);
  }
  {
    const current = proposed(snapshot());
    current.lockProof.intents[0].status = 5;
    await assert.rejects(
      verificationFixture("cutover", { snapshotAtF: current }).run(),
      /lockProof\.intents\.status/
    );
  }
  {
    const current = proposed(snapshot());
    current.freshPolicy.authorizedHooks.push(address(998));
    await assert.rejects(
      verificationFixture("cutover", { snapshotAtF: current }).run(),
      /authorizedHooks/
    );
  }
  await assert.rejects(
    verificationFixture("rotation", {
      simulationError: new Error("simulation revert"),
    }).run(),
    /simulation revert/
  );
});

test("artifact-child verifier refuses a sidecar transaction digest mismatch", async () => {
  const {
    verifyActivationCandidate,
  } = require("./verify-method-scoped-safe-batch.ts");
  const directory = mkdtempSync(join(tmpdir(), "method-scoped-sidecar-"));
  const batchPath = join(directory, "batch.json");
  const sidecarPath = join(directory, "batch.sha256.json");
  const manifest = manifestFixture();
  const batch = safeBatchJson("rotation", manifest.transactions, 1234);
  manifest.transactionsSha256 = "0".repeat(64);
  writeFileSync(batchPath, JSON.stringify(batch));
  writeFileSync(sidecarPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyActivationCandidate(/** @type {any} */ ({}), {
      kind: "rotation",
      batch: undefined,
      manifest: undefined,
      mode: "artifact-child",
      repositoryRoot: directory,
      forkRpcUrl: "fake-rpc",
      artifactPaths: { batch: batchPath, sidecar: sidecarPath },
    }),
    /incomplete artifact pair/
  );
});
