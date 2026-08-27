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
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join } = require("node:path");
const { test } = require("node:test");
const { BigNumber } = require("ethers");

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
