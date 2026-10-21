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
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { utils } = require("ethers");

/** @param {number} value */
const address = (value) => `0x${value.toString(16).padStart(40, "0")}`;
/** @param {number} value */
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const ZERO = address(0);

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
      "user.name=Vault Activation",
      "-c",
      "user.email=vault-activation@example.invalid",
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

/** @param {{ root: string }} repository @param {string[]} paths */
function commitRepositoryPaths(repository, paths) {
  for (const path of paths) {
    mkdirSync(dirname(join(repository.root, path)), { recursive: true });
    writeFileSync(join(repository.root, path), `${path}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: repository.root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Vault Activation",
      "-c",
      "user.email=vault-activation@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: repository.root }
  );
}

/** @typedef {import("../deployments/orchestratorV4Activation").O4ExpectedActivationState} Expected */
/** @typedef {import("../deployments/orchestratorV4Activation").O4ActivationSnapshot} Snapshot */
/** @typedef {import("../deployments/orchestratorV4ActivationBatchManifest").O4ActivationBatchManifest} Manifest */
const model = require("../deployments/orchestratorV4Activation.ts");
const manifests = require("../deployments/orchestratorV4ActivationBatchManifest.ts");
const {
  canonicalTransactionHash,
} = require("../deployments/safeBatchManifest.ts");
const {
  assertO4ArtifactGitState,
  deriveO4ConstructorArgs,
} = require("./verify-orchestrator-v4-safe-batch.ts");
const lane = require("../deploy/46_activate_orchestrator_v4_stack.ts");
const guardArtifact = require("../artifacts/contracts/mocks/OrchestratorV4CutoverGuard.sol/OrchestratorV4CutoverGuard.json");
const postconditionArtifact = require("../artifacts/contracts/mocks/OrchestratorV4CutoverPostcondition.sol/OrchestratorV4CutoverPostcondition.json");

/** @param {"base" | "base_staging"} [network] @returns {Expected} */
function expected(network = "base") {
  const addresses = {
    safe: address(1),
    deployer: address(2),
    escrow: address(3),
    freshVault: address(4),
    freshPolicy: address(5),
    verifier: address(7),
    retiredVerifier: address(8),
    predecessorVault: address(9),
    predecessorPolicy: address(10),
    predecessorHook: address(11),
    disputeRegistry: address(12),
    nullifierRegistryV2: address(13),
    paymentVerifierRegistry: address(14),
    orchestrator: address(15),
    orchestratorRegistry: address(16),
    escrowRegistry: address(17),
    relayerRegistry: address(18),
    protocolFeeRecipient: address(19),
    whitelistPolicy: address(20),
    freshWhitelistPolicy: address(28),
    groupRegistry: address(21),
    freshGroupRegistry: address(26),
    attestationVerifier: address(22),
    disputeVerifier: address(23),
    stakeToken: address(24),
    orchestratorV4: address(25),
  };
  return {
    network,
    addresses,
    chainId: "8453",
    retainedDisputeWriters:
      network === "base_staging"
        ? [addresses.predecessorPolicy, address(27)]
        : [addresses.predecessorPolicy],
    governance: network === "base" ? addresses.safe : addresses.deployer,
    deployer: addresses.deployer,
    allowedWhitelistPolicyOwners: [addresses.deployer, addresses.safe],
    witnesses: [address(30), address(31)],
    allowMultipleIntents: true,
    protocolFee: "0",
    paymentMethods: [
      { paymentMethod: hash(103), currencies: [hash(203), hash(201)] },
      { paymentMethod: hash(101), currencies: [hash(204)] },
      {
        paymentMethod: hash(102),
        currencies: [hash(206), hash(205), hash(207)],
      },
    ],
  };
}

/** @param {Expected} wanted @param {number} [k] @returns {Snapshot} */
function snapshot(wanted, k = 0) {
  const a = wanted.addresses;
  const row = model.o4RowStateAfter(wanted, k);
  const owner = wanted.governance;
  const ownership =
    wanted.network === "base"
      ? k === 2 * wanted.paymentMethods.length + 4
        ? { owner: a.safe, pendingOwner: ZERO }
        : { owner: wanted.deployer, pendingOwner: a.safe }
      : { owner: wanted.deployer, pendingOwner: ZERO };
  return {
    network: wanted.network,
    blockNumber: "100",
    blockHash: hash(1000),
    blockTimestamp: "10000",
    freshVault: {
      ...ownership,
      policyAuthorized: true,
      stakeToken: a.stakeToken,
    },
    freshPolicy: {
      ...ownership,
      stakeVault: a.freshVault,
      disputeVerifier: a.disputeVerifier,
      disputeNullifierRegistry: a.disputeRegistry,
      orchestratorRegistry: a.orchestratorRegistry,
    },
    verifier: {
      owner,
      orchestratorRegistry: a.orchestratorRegistry,
      nullifierRegistry: a.nullifierRegistryV2,
      attestationVerifier: a.attestationVerifier,
      paymentMethods: wanted.paymentMethods.map(
        (method) => method.paymentMethod
      ),
    },
    retiredVerifier: {
      owner,
      paymentMethods: wanted.paymentMethods.map(
        (method) => method.paymentMethod
      ),
    },
    predecessorVault: {
      owner,
      controller: a.predecessorPolicy,
      pendingController: ZERO,
    },
    predecessorPolicy: {
      owner,
      pendingOwner: ZERO,
      stakeVault: a.predecessorVault,
      disputeVerifier: a.disputeVerifier,
      disputeNullifierRegistry: a.disputeRegistry,
      predecessorHookAuthorized: true,
    },
    predecessorHook: {
      orchestratorRegistry: a.orchestratorRegistry,
      whitelistPolicy: a.whitelistPolicy,
      disputeProtectionPolicy: a.predecessorPolicy,
    },
    disputeRegistry: { owner, writers: row.disputeWriters },
    nullifierRegistryV2: { owner, writers: row.nrv2Writers },
    paymentVerifierRegistry: { owner, methods: row.registry },
    orchestrator: {
      owner,
      paused: false,
      lifecycleHook: a.predecessorHook,
      escrowRegistry: a.escrowRegistry,
      paymentVerifierRegistry: a.paymentVerifierRegistry,
      relayerRegistry: a.relayerRegistry,
      protocolFee: wanted.protocolFee,
      protocolFeeRecipient: a.protocolFeeRecipient,
      allowMultipleIntents: wanted.allowMultipleIntents,
      registered: true,
    },
    orchestratorRegistry: { owner },
    orchestratorV4: {
      owner,
      paused: false,
      chainId: wanted.chainId,
      settlementPolicy: a.freshPolicy,
      whitelistPolicy: a.freshWhitelistPolicy,
      escrowRegistry: a.escrowRegistry,
      paymentVerifierRegistry: a.paymentVerifierRegistry,
      relayerRegistry: a.relayerRegistry,
      protocolFee: wanted.protocolFee,
      protocolFeeRecipient: a.protocolFeeRecipient,
      allowMultipleIntents: wanted.allowMultipleIntents,
      registered: row.o4Registered,
    },
    freshWhitelistPolicy: { groupRegistry: a.freshGroupRegistry },
    whitelistPolicy: {
      owner: wanted.deployer,
      escrowRegistry: a.escrowRegistry,
      groupRegistry: a.groupRegistry,
      orchestratorRegistry: a.orchestratorRegistry,
    },
    attestationVerifier: {
      owner,
      requiredSignatures: "1",
      witnesses: [...wanted.witnesses],
    },
    disputeVerifier: {
      owner,
      pendingOwner: ZERO,
      attestationVerifier: a.attestationVerifier,
      nullifierRegistry: a.nullifierRegistryV2,
    },
  };
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {Snapshot} state @param {Expected} wanted @param {string} path */
function assertViolation(state, wanted, path) {
  const result = model.reduceO4Activation(state, wanted);
  assert.equal(result.phase, "unrecognized", path);
  assert.ok(
    result.violations.includes(path),
    `${path}: ${result.violations.join(", ")}`
  );
}

test("O4 actions preserve reverse removal and forward registration order", () => {
  assert.deepEqual(
    model.o4ActivationActions([hash(103), hash(101), hash(102)]),
    [
      "add-dispute-writer",
      "add-verifier-writer",
      `remove-method:${hash(102)}`,
      `remove-method:${hash(101)}`,
      `remove-method:${hash(103)}`,
      `add-method:${hash(103)}`,
      `add-method:${hash(101)}`,
      `add-method:${hash(102)}`,
      "remove-retired-verifier-writer",
      "register-orchestrator",
    ]
  );
});

test("staging recognizes every O4 action prefix", () => {
  const wanted = expected("base_staging");
  const actions = model.o4ActivationActions(
    wanted.paymentMethods.map((method) => method.paymentMethod)
  );
  assert.equal(actions.length, 10);
  for (let k = 0; k <= actions.length; k++) {
    assert.deepEqual(
      model.reduceO4Activation(snapshot(wanted, k), wanted),
      {
        phase:
          k === 0 ? "deployed" : k === actions.length ? "active" : "activating",
        completedActions: k,
        nextAction: actions[k] ?? null,
        violations: [],
      }
    );
  }
});

test("Base requires atomic O4 cutover and Safe ownership at completion", () => {
  const wanted = expected();
  const total = 2 * wanted.paymentMethods.length + 4;
  for (const k of [0, total]) {
    assert.deepEqual(
      model.reduceO4Activation(snapshot(wanted, k), wanted),
      {
        phase: k === 0 ? "deployed" : "active",
        completedActions: k,
        nextAction: null,
        violations: [],
      }
    );
  }
  for (let k = 1; k < total; k++)
    assertViolation(snapshot(wanted, k), wanted, "base.atomicCutover");
  for (const name of /** @type {const} */ (["freshVault", "freshPolicy"])) {
    const state = snapshot(wanted, total);
    state[name].owner = wanted.deployer;
    state[name].pendingOwner = wanted.addresses.safe;
    assertViolation(state, wanted, `${name}.owner`);
    assertViolation(state, wanted, `${name}.pendingOwner`);
  }
});

test("O4 ownership permits Base handovers and requires staging deployer ownership", () => {
  const wanted = expected();
  for (const vaultReady of [false, true])
    for (const policyReady of [false, true]) {
      const state = snapshot(wanted);
      if (vaultReady)
        Object.assign(state.freshVault, {
          owner: wanted.addresses.safe,
          pendingOwner: ZERO,
        });
      if (policyReady)
        Object.assign(state.freshPolicy, {
          owner: wanted.addresses.safe,
          pendingOwner: ZERO,
        });
      assert.equal(
        model.reduceO4Activation(state, wanted).phase,
        "deployed"
      );
    }
  const staging = expected("base_staging");
  assert.equal(
    model.reduceO4Activation(snapshot(staging), staging).phase,
    "deployed"
  );
  for (const name of /** @type {const} */ (["freshVault", "freshPolicy"])) {
    for (const ownership of [
      { owner: staging.deployer, pendingOwner: staging.addresses.safe },
      { owner: staging.addresses.safe, pendingOwner: ZERO },
    ]) {
      const state = snapshot(staging);
      Object.assign(state[name], ownership);
      assertViolation(state, staging, `${name}.ownership`);
    }
  }
});

test("O4 reducer names trust and ordered registry drift", () => {
  const wanted = expected("base_staging");
  /** @type {Array<[string, (state: Snapshot) => void]>} */
  const cases = [
    ["freshPolicy.orchestratorRegistry", (s) => { s.freshPolicy.orchestratorRegistry = address(90); }],
    ["orchestrator.lifecycleHook", (s) => { s.orchestrator.lifecycleHook = address(90); }],
    [
      "disputeRegistry.writers",
      (s) => {
        s.disputeRegistry.writers.push(address(90));
      },
    ],
    [
      "nullifierRegistryV2.writers",
      (s) => {
        s.nullifierRegistryV2.writers.reverse();
      },
    ],
    [
      "paymentVerifierRegistry.methods",
      (s) => {
        s.paymentVerifierRegistry.methods[0].verifier = address(90);
      },
    ],
    [
      "paymentVerifierRegistry.methods",
      (s) => {
        s.paymentVerifierRegistry.methods[0].currencies.reverse();
      },
    ],
    [
      "paymentVerifierRegistry.methods",
      (s) => {
        s.paymentVerifierRegistry.methods.reverse();
      },
    ],
    [
      "freshVault.policyAuthorized",
      (s) => {
        s.freshVault.policyAuthorized = false;
      },
    ],
    [
      "orchestrator.protocolFee",
      (s) => {
        s.orchestrator.protocolFee = "1";
      },
    ],
    [
      "whitelistPolicy.owner",
      (s) => {
        s.whitelistPolicy.owner = address(90);
      },
    ],
    [
      "verifier.paymentMethods",
      (s) => {
        s.verifier.paymentMethods.reverse();
      },
    ],
    [
      "predecessorPolicy.predecessorHookAuthorized",
      (s) => {
        s.predecessorPolicy.predecessorHookAuthorized = false;
      },
    ],
  ];
  for (const [path, mutate] of cases) {
    const state = snapshot(wanted, 3);
    mutate(state);
    assertViolation(state, wanted, path);
  }
});

test("O4 advance accepts exactly one recognized action", () => {
  const wanted = expected("base_staging");
  const total = 2 * wanted.paymentMethods.length + 4;
  const reductions = Array.from({ length: total + 1 }, (_, k) =>
    model.reduceO4Activation(snapshot(wanted, k), wanted)
  );
  const bad = snapshot(wanted);
  bad.orchestrator.protocolFee = "1";
  const unrecognized = model.reduceO4Activation(bad, wanted);
  for (let k = 0; k < total; k++) {
    assert.doesNotThrow(() =>
      model.assertO4Advance(reductions[k], reductions[k + 1])
    );
    if (k < total - 1)
      assert.throws(
        () => model.assertO4Advance(reductions[k], reductions[k + 2]),
        /exactly one action/
      );
    assert.throws(
      () => model.assertO4Advance(reductions[k], unrecognized),
      /exactly one action/
    );
  }
});

const transactionInterface = new utils.Interface([
  "function addWritePermission(address)",
  "function removeWritePermission(address)",
  "function removePaymentMethod(bytes32)",
  "function addPaymentMethod(bytes32,address,bytes32[])",
  "function addOrchestrator(address)",
  "function assertReady()",
  "function acceptOwnership()",
]);

/** @param {unknown} value @returns {unknown} */
function abiValue(value) {
  if (Array.isArray(value)) return value.map(abiValue);
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value === "object" && value !== null && "toHexString" in value)
    return String(value);
  return value;
}

test("O4 action calldata targets the exact contracts and arguments", () => {
  const wanted = expected();
  const a = wanted.addresses;
  /** @type {Array<[string, string, string, unknown[]]>} */
  const cases = [
    [
      "add-dispute-writer",
      a.disputeRegistry,
      "addWritePermission",
      [a.freshPolicy],
    ],
    [
      "add-verifier-writer",
      a.nullifierRegistryV2,
      "addWritePermission",
      [a.verifier],
    ],
    [
      "remove-retired-verifier-writer",
      a.nullifierRegistryV2,
      "removeWritePermission",
      [a.retiredVerifier],
    ],
    [
      "register-orchestrator",
      a.orchestratorRegistry,
      "addOrchestrator",
      [a.orchestratorV4],
    ],
  ];
  for (const method of wanted.paymentMethods) {
    cases.push([
      `remove-method:${method.paymentMethod}`,
      a.paymentVerifierRegistry,
      "removePaymentMethod",
      [method.paymentMethod],
    ]);
    cases.push([
      `add-method:${method.paymentMethod}`,
      a.paymentVerifierRegistry,
      "addPaymentMethod",
      [method.paymentMethod, a.verifier, method.currencies],
    ]);
  }
  for (const [action, to, name, args] of cases) {
    const transaction = model.buildO4ActionTransaction(action, wanted);
    assert.equal(transaction.to, to);
    assert.equal(transaction.value, "0");
    assert.equal(transaction.operation, 0);
    const decoded = transactionInterface.parseTransaction(transaction);
    assert.equal(decoded.name, name);
    assert.deepEqual(abiValue(decoded.args), args);
  }
});

test("13-method O4 batches contain 31 to 33 ordered calls", () => {
  const wanted = expected();
  wanted.paymentMethods = Array.from({ length: 13 }, (_, i) => ({
    paymentMethod: hash(100 + i),
    currencies: [hash(200 + i)],
  }));
  const actions = model
    .o4ActivationActions(
      wanted.paymentMethods.map((method) => method.paymentMethod)
    )
    .map((action) => model.buildO4ActionTransaction(action, wanted));
  for (const includeVaultAcceptOwnership of [false, true])
    for (const includePolicyAcceptOwnership of [false, true]) {
      const transactions = model.buildO4CutoverTransactions({
        expected: wanted,
        guard: address(50),
        includeVaultAcceptOwnership,
        includePolicyAcceptOwnership,
      });
      const targets = [
        ...(includeVaultAcceptOwnership ? [wanted.addresses.freshVault] : []),
        ...(includePolicyAcceptOwnership ? [wanted.addresses.freshPolicy] : []),
      ];
      assert.equal(transactions.length, 31 + targets.length);
      assert.equal(transactions[0].to, address(50));
      assert.equal(
        transactionInterface.parseTransaction(transactions[0]).name,
        "assertReady"
      );
      targets.forEach((target, i) => {
        assert.equal(transactions[i + 1].to, target);
        assert.equal(
          transactionInterface.parseTransaction(transactions[i + 1]).name,
          "acceptOwnership"
        );
      });
      assert.deepEqual(transactions.slice(1 + targets.length), actions);
    }
});

test("canonical O4 transactions reject calls and flag drift", () => {
  const wanted = expected();
  const guard = address(50);
  const transactions = model.buildO4CutoverTransactions({
    expected: wanted,
    guard,
    includeVaultAcceptOwnership: true,
    includePolicyAcceptOwnership: true,
  });
  model.assertO4CanonicalTransactions(
    transactions,
    wanted,
    guard,
    true,
    true
  );
  model.assertO4CanonicalTransactions(
    transactions.map((transaction) => ({
      ...transaction,
      to: "0x" + transaction.to.slice(2).toUpperCase(),
      data: "0x" + transaction.data.slice(2).toUpperCase(),
    })),
    wanted,
    guard,
    true,
    true
  );
  const swapped = [...transactions];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  for (const changed of [
    [...transactions, transactions[0]],
    transactions.slice(1),
    swapped,
  ]) {
    assert.throws(
      () =>
        model.assertO4CanonicalTransactions(
          changed,
          wanted,
          guard,
          true,
          true
        ),
      /O4 Safe batch transactions differ from the canonical cutover/
    );
  }
  for (const [includeVault, includePolicy] of [
    [false, true],
    [true, false],
  ]) {
    assert.throws(
      () =>
        model.assertO4CanonicalTransactions(
          transactions,
          wanted,
          guard,
          includeVault,
          includePolicy
        ),
      /O4 Safe batch transactions differ from the canonical cutover/
    );
  }
});

test("O4 trust surface round-trips guard and postcondition constructor ABIs", () => {
  const wanted = expected();
  const state = snapshot(wanted);
  state.whitelistPolicy.owner = wanted.addresses.safe;
  const surface = model.buildO4TrustSurface(wanted, state);
  assert.equal(surface.whitelistPolicyOwner, state.whitelistPolicy.owner);
  assert.equal(surface.freshWhitelistPolicy, wanted.addresses.freshWhitelistPolicy);
  assert.notEqual(surface.freshWhitelistPolicy, surface.whitelistPolicy);
  assert.deepEqual(surface.paymentMethods, [hash(103), hash(101), hash(102)]);
  assert.deepEqual(surface.currencies, [
    hash(203),
    hash(201),
    hash(204),
    hash(206),
    hash(205),
    hash(207),
  ]);
  assert.deepEqual(surface.currencyCounts, ["2", "1", "3"]);
  const tuple = model.o4TrustSurfaceTuple(surface);
  for (const [
    artifact,
    args,
  ] of /** @type {Array<[{ abi: any[] }, any[]]>} */ ([
    [guardArtifact, [tuple, true, false]],
    [postconditionArtifact, [tuple]],
  ])) {
    const iface = new utils.Interface(artifact.abi);
    const encoded = iface.encodeDeploy(args);
    const decoded = utils.defaultAbiCoder.decode(iface.deploy.inputs, encoded);
    assert.deepEqual(abiValue(decoded), args);
    for (const [key, value] of Object.entries(surface))
      assert.deepEqual(abiValue(decoded[0][key]), value, key);
  }
});

test("O4 guard expectations bind routes, writers, O4, and whitelist owner", () => {
  const proof = snapshot(expected());
  assert.doesNotThrow(() =>
    model.assertO4GuardExpectationsUnchanged(proof, clone(proof))
  );
  /** @type {Array<[string, (state: Snapshot) => void]>} */
  const cases = [
    [
      "paymentVerifierRegistry.methods.verifier",
      (s) => {
        s.paymentVerifierRegistry.methods[0].verifier = address(99);
      },
    ],
    [
      "nullifierRegistryV2.writers",
      (s) => {
        s.nullifierRegistryV2.writers[0] = address(99);
      },
    ],
    [
      "whitelistPolicy.owner",
      (s) => {
        s.whitelistPolicy.owner = address(99);
      },
    ],
  ];
  for (const [path, mutate] of cases) {
    const simulation = clone(proof);
    mutate(simulation);
    assert.throws(
      () => model.assertO4GuardExpectationsUnchanged(proof, simulation),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path));
        return true;
      }
    );
  }
  const later = clone(proof);
  later.blockNumber = "101";
  assert.doesNotThrow(() =>
    model.assertO4GuardExpectationsUnchanged(proof, later)
  );
});

/** @returns {Manifest} */
function manifest() {
  const wanted = expected();
  const proofSnapshot = snapshot(wanted);
  const trustSurface = model.buildO4TrustSurface(wanted, proofSnapshot);
  const tuple = model.o4TrustSurfaceTuple(trustSurface);
  /** @param {string} artifactName @param {number} id @param {unknown[]} constructorArgs @returns {import("../deployments/orchestratorV4ActivationBatchManifest").ContractIdentity} */
  const identity = (artifactName, id, constructorArgs) => ({
    artifactName,
    address: address(id),
    constructorArgs,
    deployTransactionHash: hash(id),
    runtimeCodeHash: hash(id + 100),
  });
  const guard = identity("OrchestratorV4CutoverGuard", 50, [tuple, true, true]);
  const postcondition = identity("OrchestratorV4CutoverPostcondition", 51, [
    tuple,
  ]);
  const transactions = model.buildO4CutoverTransactions({
    expected: wanted,
    guard: guard.address,
    includeVaultAcceptOwnership: true,
    includePolicyAcceptOwnership: true,
  });
  /** @type {Omit<Manifest, "manifestSha256">} */
  const unsigned = {
    version: 12,
    kind: "orchestrator-v4-cutover",
    chainId: 8453,
    safe: wanted.addresses.safe,
    safeNonce: "12",
    sourceSha: "a".repeat(40),
    proofBlock: { number: 100, hash: proofSnapshot.blockHash },
    simulationBlockNumber: 102,
    simulationBlockHash: hash(1002),
    simulationResult: "success",
    transactions,
    transactionsSha256: canonicalTransactionHash(transactions),
    guard,
    postcondition,
    trustSurface,
    proofSnapshot,
  };
  return {
    ...unsigned,
    manifestSha256: manifests.computeO4ManifestSha256(unsigned),
  };
}

test("unsigned v12 O4 manifests validate and reject v11 and tampering", () => {
  const valid = manifest();
  assert.deepEqual(
    deriveO4ConstructorArgs(valid, "guard"),
    valid.guard.constructorArgs
  );
  assert.deepEqual(
    deriveO4ConstructorArgs(valid, "postcondition"),
    valid.postcondition.constructorArgs
  );
  const oldVersion = { ...valid, version: 11 };
  const { manifestSha256: oldDigest, ...oldUnsigned } = oldVersion;
  oldVersion.manifestSha256 = manifests.computeO4ManifestSha256(
    /** @type {any} */ (oldUnsigned)
  );
  assert.throws(
    () => manifests.validateO4ActivationBatchManifest(oldVersion),
    /Invalid OrchestratorV4 Safe batch manifest/
  );
  assert.doesNotThrow(() =>
    manifests.validateO4ActivationBatchManifest(valid, valid)
  );
  /** @type {Array<(value: Manifest) => void>} */
  const mutations = [
    (m) => {
      Object.assign(m, { version: 11 });
    },
    (m) => {
      Object.assign(m, { chainId: 31337 });
    },
    (m) => {
      m.transactions[0].to = address(99);
    },
    (m) => {
      m.trustSurface.whitelistPolicyOwner = address(99);
    },
    (m) => {
      m.proofSnapshot.orchestrator.protocolFee = "1";
    },
    (m) => {
      Object.assign(m.proofSnapshot.freshPolicy, { admissionsPaused: false });
    },
    (m) => {
      Object.assign(m.proofSnapshot.freshPolicy, { relayerRegistry: address(18) });
    },
    (m) => {
      Object.assign(m.proofSnapshot.freshPolicy, { whitelistPolicy: address(28) });
    },
    (m) => {
      Object.assign(m.trustSurface, { riskWindowMethods: [], riskWindows: [] });
    },
    (m) => {
      Object.assign(m, { extra: true });
    },
    (m) => {
      m.manifestSha256 = "f".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const changed = clone(valid);
    mutate(changed);
    assert.throws(
      () => manifests.validateO4ActivationBatchManifest(changed),
      /Invalid OrchestratorV4 Safe batch manifest/
    );
  }
  // Rehashing cannot make unknown schema keys valid.
  const extra = clone(valid);
  Object.assign(extra.proofSnapshot.freshVault, { extra: true });
  const { manifestSha256, ...unsigned } = extra;
  extra.manifestSha256 = manifests.computeO4ManifestSha256(unsigned);
  assert.throws(
    () => manifests.validateO4ActivationBatchManifest(extra),
    /Invalid OrchestratorV4 Safe batch manifest/
  );
});

test("O4 Safe batch matches manifest order and canonical artifact paths", () => {
  const valid = manifest();
  const batch = manifests.o4SafeBatchJson(valid.transactions, 10000);
  assert.doesNotThrow(() =>
    manifests.assertBatchMatchesO4ActivationManifest(batch, valid)
  );
  const reordered = manifests.o4SafeBatchJson(
    [...valid.transactions].reverse(),
    10000
  );
  assert.throws(
    () =>
      manifests.assertBatchMatchesO4ActivationManifest(reordered, valid),
    /Safe batch does not match OrchestratorV4 activation manifest/
  );
  assert.equal(
    manifests.O4_ACTIVATION_BATCH_PATHS.batch,
    "deployments/outputs/safe-batches/base_orchestrator_v4_cutover.json"
  );
  assert.equal(
    manifests.O4_ACTIVATION_BATCH_PATHS.sidecar,
    "deployments/outputs/safe-batches/base_orchestrator_v4_cutover.sha256.json"
  );
  assert.equal(
    manifests.O4_ACTIVATION_BATCH_PATHS.supersededDir,
    "deployments/outputs/safe-batches/superseded"
  );
});

test("O4 artifact generation requires exact HEAD and a clean tree", () => {
  const repository = temporaryGitRepository("O4-generation-");
  assert.doesNotThrow(() =>
    assertO4ArtifactGitState(
      repository.root,
      repository.sourceSha,
      "generation"
    )
  );
  commitRepositoryPaths(repository, ["README.md"]);
  assert.throws(
    () =>
      assertO4ArtifactGitState(
        repository.root,
        repository.sourceSha,
        "generation"
      ),
    /Generation HEAD does not equal/
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository.root,
    encoding: "utf8",
  }).trim();
  writeFileSync(join(repository.root, "tracked"), "dirty\n");
  assert.throws(
    () => assertO4ArtifactGitState(repository.root, head, "generation"),
    /clean worktree/
  );
});

test("O4 artifact-child permits unrelated paths", () => {
  const repository = temporaryGitRepository("O4-unrelated-");
  commitRepositoryPaths(repository, [
    "README.md",
    ".github/workflows/x.yml",
    "deployments/outputs/safe-batches/x.json",
  ]);
  assert.doesNotThrow(() =>
    assertO4ArtifactGitState(
      repository.root,
      repository.sourceSha,
      "artifact-child"
    )
  );
});

test("O4 artifact-child rejects each protected path", () => {
  for (const path of [
    "deploy/45_deploy_orchestrator_v4_stack.ts",
    "deploy/46_activate_orchestrator_v4_stack.ts",
    "contracts/mocks/X.sol",
    "deployments/base/StakeVaultV2.json",
    "scripts/verify-orchestrator-v4-safe-batch.ts",
    "deployments/orchestratorV4Activation.ts",
  ]) {
    const repository = temporaryGitRepository("O4-protected-");
    commitRepositoryPaths(repository, [path]);
    assert.throws(
      () =>
        assertO4ArtifactGitState(
          repository.root,
          repository.sourceSha,
          "artifact-child"
        ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path));
        return true;
      }
    );
  }
});

const ACTION_ENV = [
  lane.FLAGS.stagingPrepare,
  lane.FLAGS.stagingExecute,
  lane.FLAGS.baseCutoverPrepare,
];
/** @param {string} network */
function fakeHre(network) {
  return { deployments: { getNetworkName: () => network } };
}
/** @param {() => Promise<void> | void} run */
async function withCleanLaneEnv(run) {
  const names = [
    "DEPLOY_ACTIVE_TAG",
    ...ACTION_ENV,
    lane.FLAGS.releaseReadySha,
  ];
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  );
  try {
    names.forEach((name) => delete process.env[name]);
    await run();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("lane 46 classifies O4 policy activity across O4 registration", () => {
  /** @param {string} name */
  const event = (name) =>
    /** @type {import("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack").FreshStackEvent} */ ({
      name,
      blockNumber: 1,
      transactionIndex: 0,
      logIndex: 0,
      transactionHash: hash(1),
    });
  const configuration = [
    "DisputeVerifierUpdated",
    "OwnershipTransferStarted",
    "OwnershipTransferred",
  ].map(event);
  assert.deepEqual(lane.O4_POLICY_LIFECYCLE_EVENTS, [
    "ProtectionOpened",
    "ProtectionReleased",
    "DisputeResolved",
  ]);
  for (const name of lane.O4_POLICY_LIFECYCLE_EVENTS) {
    assert.throws(
      () => lane.classifyO4PolicyActivity([event(name)], true),
      {
        message:
          "Fresh DisputeProtectionPolicyV2 has lifecycle activity before cutover: " +
          `${name} in ${hash(1)}`,
      }
    );
  }
  assert.doesNotThrow(() =>
    lane.classifyO4PolicyActivity(configuration, true)
  );
  assert.doesNotThrow(() =>
    lane.classifyO4PolicyActivity(
      lane.O4_POLICY_LIFECYCLE_EVENTS.map(event).concat(configuration),
      false
    )
  );
  for (const removed of [
    "DisputeProtectionIntentSettled",
    "DisputeProtectionIntentReleased",
    "DeferredPayoutClaimed",
    "OrchestratorAuthorizationUpdated",
    "DepositOptOutForRelayerBypassUpdated",
  ]) {
    for (const beforeCutover of [true, false]) {
      assert.throws(
        () =>
          lane.classifyO4PolicyActivity(
            [...configuration, event(removed)],
            beforeCutover
          ),
        new RegExp(`emitted an unclassified event: ${removed}`)
      );
    }
  }
});

test("lane 46 exposes O4 activation tags and no dependencies", () => {
  assert.equal(lane.TAG, "46_activate_orchestrator_v4_stack");
  assert.deepEqual(lane.default.tags, [lane.TAG, "OrchestratorV4Activation"]);
  assert.deepEqual(lane.default.dependencies, []);
});

test("lane 46 skips unselected live and unsupported networks but runs locally", async () => {
  await withCleanLaneEnv(async () => {
    for (const network of ["localhost", "hardhat"])
      assert.equal(
        await /** @type {(hre: any) => Promise<boolean>} */ (lane.default.skip)(
          fakeHre(network)
        ),
        false
      );
    for (const network of ["sepolia", "base_staging", "base"])
      assert.equal(
        await /** @type {(hre: any) => Promise<boolean>} */ (lane.default.skip)(
          fakeHre(network)
        ),
        true
      );
  });
});

test("lane 46 action flags require the exact activation tag", async () => {
  for (const flag of ACTION_ENV) {
    await withCleanLaneEnv(async () => {
      process.env[flag] = "true";
      for (const network of [
        "localhost",
        "hardhat",
        "sepolia",
        "base_staging",
        "base",
      ]) {
        await assert.rejects(
          () =>
            /** @type {(hre: any) => Promise<boolean>} */ (lane.default.skip)(
              fakeHre(network)
            ),
          /Lane 46 flags require DEPLOY_ACTIVE_TAG=46_activate_orchestrator_v4_stack/
        );
      }
    });
  }
});

test("lane 46 rejects conflicting staging flags and cross-network flags", async () => {
  await withCleanLaneEnv(async () => {
    process.env.DEPLOY_ACTIVE_TAG = lane.TAG;
    process.env[lane.FLAGS.stagingPrepare] = "true";
    process.env[lane.FLAGS.stagingExecute] = "true";
    await assert.rejects(
      () =>
        /** @type {(hre: any) => Promise<boolean>} */ (lane.default.skip)(
          fakeHre("base_staging")
        ),
      /Set exactly one of/
    );
  });
  await withCleanLaneEnv(async () => {
    process.env.DEPLOY_ACTIVE_TAG = lane.TAG;
    process.env[lane.FLAGS.baseCutoverPrepare] = "true";
    await assert.rejects(
      () =>
        /** @type {(hre: any) => Promise<boolean>} */ (lane.default.skip)(
          fakeHre("base_staging")
        ),
      /Base lane-46 flag selected on Base staging/
    );
  });
  for (const flag of [lane.FLAGS.stagingPrepare, lane.FLAGS.stagingExecute]) {
    await withCleanLaneEnv(async () => {
      process.env.DEPLOY_ACTIVE_TAG = lane.TAG;
      process.env[flag] = "true";
      await assert.rejects(
        () =>
          /** @type {(hre: any) => Promise<boolean>} */ (lane.default.skip)(
            fakeHre("base")
          ),
        /Base staging lane-46 flag selected on Base/
      );
    });
  }
});

test("Base O4 preparation requires release-ready SHA before chain or git access", async () => {
  await withCleanLaneEnv(async () => {
    await assert.rejects(
      () =>
        /** @type {(hre: any) => Promise<void>} */ (
          lane.prepareBaseCutoverBatch
        )(fakeHre("base")),
      /Base batch preparation requires an exact CONFIRM_BASE_ORCHESTRATOR_V4_RELEASE_READY_SHA/
    );
  });
});

test("lane 45 prepared check delegates activating and active stacks to lane 46", async () => {
  const lane45 = require("../deploy/45_deploy_orchestrator_v4_stack.ts");
  const {
    O4_DEPLOYMENT_NAMES,
    O4_EXPECTED_LIVE,
  } = require("../deployments/orchestratorV4Stack.ts");
  const disputeRegistry = O4_EXPECTED_LIVE.base_staging.disputeNullifierRegistry.address;
  // Required module exports are patched because lane 45 lazily requires lane 46.
  const mutableLane = /** @type {any} */ (lane);
  const original = {
    loadO4ActivationContext: lane.loadO4ActivationContext,
    assertO4ActivationSharedState: lane.assertO4ActivationSharedState,
    expectedO4ActivationState: lane.expectedO4ActivationState,
  };
  const wanted = expected("base_staging");
  /** @type {Array<string>} */
  const calls = [];
  const records = new Map(
    O4_DEPLOYMENT_NAMES.map((name) => [
      name,
      {
        address:
          name === "DisputeProtectionPolicyV2"
            ? wanted.addresses.freshPolicy
            : address(90),
      },
    ])
  );
  const hre = /** @type {any} */ ({
    deployments: {
      getNetworkName: () => "base_staging",
      /** @param {string} name */
      getOrNull: async (name) =>
        records.get(
          /** @type {import("../deployments/orchestratorV4Stack").O4DeploymentName} */ (
            name
          )
        ),
    },
    ethers: {
      provider: { getBlockNumber: async () => 100 },
      /** @param {string} name @param {string} target */
      getContractAt: async (name, target) => {
        assert.equal(name, "NullifierRegistry");
        assert.equal(target, disputeRegistry);
        return {
          isWriter: async (/** @type {string} */ writer) =>
            writer === wanted.addresses.freshPolicy,
        };
      },
    },
  });
  try {
    mutableLane.loadO4ActivationContext = async (
      /** @type {any} */ actual,
      /** @type {string} */ network
    ) => {
      assert.equal(actual, hre);
      assert.equal(network, "base_staging");
      calls.push("context");
    };
    mutableLane.expectedO4ActivationState = (
      /** @type {string} */ network
    ) => {
      assert.equal(network, "base_staging");
      calls.push("expected");
      return wanted;
    };
    for (const count of [1, 2 * wanted.paymentMethods.length + 4]) {
      const state = snapshot(wanted, count);
      assert.equal(
        model.reduceO4Activation(state, wanted).phase,
        count === 1 ? "activating" : "active"
      );
      mutableLane.assertO4ActivationSharedState = async (
        /** @type {any} */ actual,
        /** @type {string} */ network,
        /** @type {number} */ block
      ) => {
        assert.equal(actual, hre);
        assert.equal(network, "base_staging");
        assert.equal(block, 100);
        calls.push("shared");
        return state;
      };
      calls.length = 0;
      assert.equal(await lane45.orchestratorV4StackPrepared(hre), true);
      assert.deepEqual(calls, ["context", "shared", "expected"]);
    }
    const failure = new Error("Unrecognized O4 activation state");
    mutableLane.assertO4ActivationSharedState = async () => {
      throw failure;
    };
    calls.length = 0;
    await assert.rejects(
      lane45.orchestratorV4StackPrepared(hre),
      (error) => error === failure
    );
    assert.deepEqual(calls, ["context"]);
  } finally {
    Object.assign(mutableLane, original);
  }
});

test("O4 batches never call OrchestratorV3", () => {
  const wanted = expected();
  const calls = model.buildO4CutoverTransactions({
    expected: wanted,
    guard: address(50),
    includeVaultAcceptOwnership: true,
    includePolicyAcceptOwnership: true,
  });
  assert.ok(calls.every((call) => call.to !== wanted.addresses.orchestrator));
  assert.equal(
    transactionInterface.parseTransaction(calls[calls.length - 1]).name,
    "addOrchestrator"
  );
  const staging = expected("base_staging");
  assert.deepEqual(model.o4ActivationActions([]), [
    "add-dispute-writer",
    "add-verifier-writer",
    "remove-retired-verifier-writer",
    "register-orchestrator",
  ]);
  const initial = model.o4RowStateAfter(staging, 0);
  assert.deepEqual(initial.disputeWriters, staging.retainedDisputeWriters);
  assert.deepEqual(initial.nrv2Writers, [staging.addresses.retiredVerifier]);
  assert.equal(initial.registry.length, staging.paymentMethods.length);
});

test("fresh whitelist bindings and group registry fail closed independently of O3", () => {
  const wanted = expected();
  const drifted = snapshot(wanted);
  drifted.freshWhitelistPolicy.groupRegistry = address(99);
  assertViolation(drifted, wanted, "freshWhitelistPolicy.groupRegistry");
  assert.throws(() => model.assertO4GuardExpectationsUnchanged(snapshot(wanted), drifted), /freshWhitelistPolicy/);
  const state = snapshot(wanted);
  state.orchestratorV4.whitelistPolicy = wanted.addresses.whitelistPolicy;
  assertViolation(state, wanted, "orchestratorV4.whitelistPolicy");
  const reused = expected();
  reused.addresses.freshWhitelistPolicy = reused.addresses.whitelistPolicy;
  assertViolation(snapshot(reused), reused, "freshWhitelistPolicy.distinct");
});

test("O4 and registry trust drift fails closed", () => {
  const wanted = expected();
  for (const [key, value] of Object.entries({
    owner: address(99),
    paused: true,
    chainId: "1",
    settlementPolicy: ZERO,
    whitelistPolicy: ZERO,
    escrowRegistry: ZERO,
    paymentVerifierRegistry: ZERO,
    relayerRegistry: ZERO,
    protocolFee: "1",
    protocolFeeRecipient: ZERO,
    allowMultipleIntents: false,
    registered: true,
  })) {
    const state = snapshot(wanted);
    Object.assign(state.orchestratorV4, { [key]: value });
    assertViolation(state, wanted, `orchestratorV4.${key}`);
    assert.throws(
      () =>
        model.assertO4GuardExpectationsUnchanged(snapshot(wanted), state),
      /orchestratorV4/
    );
  }
  const state = snapshot(wanted);
  state.orchestratorRegistry.owner = ZERO;
  assertViolation(state, wanted, "orchestratorRegistry.owner");
  state.orchestrator.lifecycleHook = wanted.addresses.freshPolicy;
  assertViolation(state, wanted, "orchestrator.lifecycleHook");
});

test("staging rows follow each registry mutation and register O4 last", () => {
  const wanted = expected("base_staging");
  const a = wanted.addresses;
  const state = {
    disputeWriters: [...wanted.retainedDisputeWriters],
    nrv2Writers: [a.retiredVerifier],
    registry: wanted.paymentMethods.map((method) => ({
      ...method,
      verifier: a.retiredVerifier,
    })),
    o4Registered: false,
  };
  const actions = model.o4ActivationActions(
    wanted.paymentMethods.map((method) => method.paymentMethod)
  );
  assert.deepEqual(model.o4RowStateAfter(wanted, 0), state);
  actions.forEach((action, index) => {
    if (action === "add-dispute-writer")
      state.disputeWriters.push(a.freshPolicy);
    else if (action === "add-verifier-writer")
      state.nrv2Writers.push(a.verifier);
    else if (action === "remove-retired-verifier-writer")
      state.nrv2Writers = [a.verifier];
    else if (action === "register-orchestrator") state.o4Registered = true;
    else if (action.startsWith("remove-method:")) {
      const removed = state.registry.pop();
      assert.equal(
        removed?.paymentMethod,
        action.slice("remove-method:".length)
      );
    } else {
      const method = wanted.paymentMethods.find(
        (method) => action === `add-method:${method.paymentMethod}`
      );
      assert.ok(method);
      state.registry.push({ ...method, verifier: a.verifier });
    }
    assert.deepEqual(model.o4RowStateAfter(wanted, index + 1), state);
  });
  for (const invalid of [-1, 0.5, actions.length + 1])
    assert.throws(
      () => model.o4RowStateAfter(wanted, invalid),
      /Invalid completed action count/
    );
});

test("Base preparation rejects missing recorded pins before chain access", async () => {
  await withCleanLaneEnv(async () => {
    process.env[lane.FLAGS.releaseReadySha] = "a".repeat(40);
    await assert.rejects(
      () => lane.prepareBaseCutoverBatch(
        /** @type {any} */ (fakeHre("base")),
        { assertArtifactGitState() {} }
      ),
      /Base batch preparation requires recorded pin: StakeVaultV2/
    );
  });
});

test("Base preparation verifies every recorded fresh deployment pin", async () => {
  const stack = require("../deployments/orchestratorV4Stack.ts");
  const pins = Object.fromEntries(
    stack.O4_DEPLOYMENT_NAMES.map((name, i) => [
      name,
      { address: address(100 + i), runtimeCodeHash: utils.keccak256("0x1234") },
    ])
  );
  const original = stack.O4_RECORDED_DEPLOYMENTS.base;
  stack.O4_RECORDED_DEPLOYMENTS.base = /** @type {any} */ (pins);
  /** @type {string[]} */
  const checked = [];
  /** @type {any} */
  const hre = {
    deployments: {
      get: async (/** @type {string} */ name) => ({
        address: pins[name].address,
        abi: [],
        deployedBytecode: "0x1234",
        solcInputHash: "build",
      }),
      getExtendedArtifact: async () => ({ solcInputHash: "build" }),
    },
    ethers: {
      provider: {
        getCode: async (
          /** @type {string} */ target,
          /** @type {number} */ block
        ) => {
          assert.equal(block, 100);
          checked.push(target);
          return "0x1234";
        },
      },
    },
  };
  try {
    await lane.assertBaseRecordedDeployments(hre, 100);
    assert.deepEqual(
      [...new Set(checked)], Object.values(pins).map((pin) => pin.address)
    );
    for (const name of stack.O4_DEPLOYMENT_NAMES) {
      const pin = pins[name];
      delete pins[name];
      await assert.rejects(
        () => lane.assertBaseRecordedDeployments(hre, 100),
        /requires recorded pin/
      );
      pins[name] = pin;
    }
    pins.OrchestratorV4.runtimeCodeHash = hash(99);
    await assert.rejects(
      () => lane.assertBaseRecordedDeployments(hre, 100),
      /runtime bytecode hash mismatch/
    );
    pins.OrchestratorV4.runtimeCodeHash = utils.keccak256("0x1234");
    const getRecord = hre.deployments.get;
    hre.deployments.get = async (/** @type {string} */ name) => ({
      ...await getRecord(name), address: address(999),
    });
    await assert.rejects(
      () => lane.assertBaseRecordedDeployments(hre, 100),
      /deployment address mismatch/
    );
  } finally {
    if (original === undefined) delete stack.O4_RECORDED_DEPLOYMENTS.base;
    else stack.O4_RECORDED_DEPLOYMENTS.base = original;
  }
});
