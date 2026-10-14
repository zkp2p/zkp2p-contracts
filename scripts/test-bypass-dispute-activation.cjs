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

/** @typedef {import("../deployments/bypassDisputeActivation").BypassExpectedActivationState} Expected */
/** @typedef {import("../deployments/bypassDisputeActivation").BypassActivationSnapshot} Snapshot */
/** @typedef {import("../deployments/bypassActivationBatchManifest").BypassActivationBatchManifest} Manifest */
const model = require("../deployments/bypassDisputeActivation.ts");
const manifests = require("../deployments/bypassActivationBatchManifest.ts");
const {
  canonicalTransactionHash,
} = require("../deployments/safeBatchManifest.ts");
const {
  assertBypassArtifactGitState,
  deriveBypassConstructorArgs,
} = require("./verify-bypass-dispute-safe-batch.ts");
const lane = require("../deploy/46_activate_bypass_dispute_stack.ts");
const guardArtifact = require("../artifacts/contracts/mocks/DisputeBypassCutoverGuard.sol/DisputeBypassCutoverGuard.json");
const postconditionArtifact = require("../artifacts/contracts/mocks/DisputeBypassCutoverPostcondition.sol/DisputeBypassCutoverPostcondition.json");

/** @param {"base" | "base_staging"} [network] @returns {Expected} */
function expected(network = "base") {
  const addresses = {
    safe: address(1),
    deployer: address(2),
    escrow: address(3),
    freshVault: address(4),
    freshPolicy: address(5),
    freshHook: address(6),
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
    groupRegistry: address(21),
    attestationVerifier: address(22),
    disputeVerifier: address(23),
    stakeToken: address(24),
    orchestratorV4: address(25),
    initialO3Hook: network === "base_staging" ? address(26) : address(11),
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
    riskWindows: {
      [hash(103)]: "86400",
      [hash(101)]: "172800",
      [hash(102)]: "0",
      [hash(99)]: "0",
    },
  };
}

/** @param {Expected} wanted @param {number} [k] @returns {Snapshot} */
function snapshot(wanted, k = 0) {
  const a = wanted.addresses;
  const row = model.bypassRowStateAfter(wanted, k);
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
      controller: a.freshPolicy,
      pendingController: ZERO,
      pendingControllerValidAt: "0",
      controllerChangeDelay: "0",
      stakeToken: a.stakeToken,
    },
    freshPolicy: {
      ...ownership,
      admissionsPaused: false,
      stakeVault: a.freshVault,
      disputeVerifier: a.disputeVerifier,
      disputeNullifierRegistry: a.disputeRegistry,
      authorizedHooks: [a.freshHook],
      riskWindows: { ...wanted.riskWindows },
    },
    freshHook: {
      orchestratorRegistry: a.orchestratorRegistry,
      whitelistPolicy: a.whitelistPolicy,
      disputeProtectionPolicy: a.freshPolicy,
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
      lifecycleHook: row.o3Hook,
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
      lifecycleHook: a.freshHook,
      escrowRegistry: a.escrowRegistry,
      paymentVerifierRegistry: a.paymentVerifierRegistry,
      relayerRegistry: a.relayerRegistry,
      protocolFee: wanted.protocolFee,
      protocolFeeRecipient: a.protocolFeeRecipient,
      allowMultipleIntents: wanted.allowMultipleIntents,
      registered: row.o4Registered,
    },
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
  const result = model.reduceBypassActivation(state, wanted);
  assert.equal(result.phase, "unrecognized", path);
  assert.ok(
    result.violations.includes(path),
    `${path}: ${result.violations.join(", ")}`
  );
}

test("bypass actions preserve reverse removal and forward registration order", () => {
  assert.deepEqual(
    model.bypassActivationActions([hash(103), hash(101), hash(102)], "base"),
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

test("staging recognizes every bypass action prefix", () => {
  const wanted = expected("base_staging");
  const actions = model.bypassActivationActions(
    wanted.paymentMethods.map((method) => method.paymentMethod),
    wanted.network
  );
  assert.equal(actions.length, 11);
  for (let k = 0; k <= actions.length; k++) {
    assert.deepEqual(
      model.reduceBypassActivation(snapshot(wanted, k), wanted),
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

test("Base requires atomic bypass cutover and Safe ownership at completion", () => {
  const wanted = expected();
  const total = 2 * wanted.paymentMethods.length + 4;
  for (const k of [0, total]) {
    assert.deepEqual(
      model.reduceBypassActivation(snapshot(wanted, k), wanted),
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

test("bypass ownership permits Base handovers and requires staging deployer ownership", () => {
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
        model.reduceBypassActivation(state, wanted).phase,
        "deployed"
      );
    }
  const staging = expected("base_staging");
  assert.equal(
    model.reduceBypassActivation(snapshot(staging), staging).phase,
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

test("bypass reducer names trust and ordered registry drift", () => {
  const wanted = expected("base_staging");
  /** @type {Array<[string, (state: Snapshot) => void]>} */
  const cases = [
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
      "freshVault.controllerChangeDelay",
      (s) => {
        s.freshVault.controllerChangeDelay = "1";
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

test("bypass advance accepts exactly one recognized action", () => {
  const wanted = expected("base_staging");
  const reductions = Array.from({ length: 12 }, (_, k) =>
    model.reduceBypassActivation(snapshot(wanted, k), wanted)
  );
  const bad = snapshot(wanted);
  bad.orchestrator.protocolFee = "1";
  const unrecognized = model.reduceBypassActivation(bad, wanted);
  for (let k = 0; k < 11; k++) {
    assert.doesNotThrow(() =>
      model.assertBypassAdvance(reductions[k], reductions[k + 1])
    );
    if (k < 10)
      assert.throws(
        () => model.assertBypassAdvance(reductions[k], reductions[k + 2]),
        /exactly one action/
      );
    assert.throws(
      () => model.assertBypassAdvance(reductions[k], unrecognized),
      /exactly one action/
    );
  }
});

const transactionInterface = new utils.Interface([
  "function addWritePermission(address)",
  "function removeWritePermission(address)",
  "function removePaymentMethod(bytes32)",
  "function addPaymentMethod(bytes32,address,bytes32[])",
  "function setLifecycleHook(address)",
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

test("bypass action calldata targets the exact contracts and arguments", () => {
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
    const transaction = model.buildBypassActionTransaction(action, wanted);
    assert.equal(transaction.to, to);
    assert.equal(transaction.value, "0");
    assert.equal(transaction.operation, 0);
    const decoded = transactionInterface.parseTransaction(transaction);
    assert.equal(decoded.name, name);
    assert.deepEqual(abiValue(decoded.args), args);
  }
});

test("13-method bypass batches contain 31 to 33 ordered calls", () => {
  const wanted = expected();
  wanted.paymentMethods = Array.from({ length: 13 }, (_, i) => ({
    paymentMethod: hash(100 + i),
    currencies: [hash(200 + i)],
  }));
  const actions = model
    .bypassActivationActions(
      wanted.paymentMethods.map((method) => method.paymentMethod),
      wanted.network
    )
    .map((action) => model.buildBypassActionTransaction(action, wanted));
  for (const includeVaultAcceptOwnership of [false, true])
    for (const includePolicyAcceptOwnership of [false, true]) {
      const transactions = model.buildBypassCutoverTransactions({
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

test("canonical bypass transactions reject calls and flag drift", () => {
  const wanted = expected();
  const guard = address(50);
  const transactions = model.buildBypassCutoverTransactions({
    expected: wanted,
    guard,
    includeVaultAcceptOwnership: true,
    includePolicyAcceptOwnership: true,
  });
  model.assertBypassCanonicalTransactions(
    transactions,
    wanted,
    guard,
    true,
    true
  );
  model.assertBypassCanonicalTransactions(
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
        model.assertBypassCanonicalTransactions(
          changed,
          wanted,
          guard,
          true,
          true
        ),
      /Bypass Safe batch transactions differ from the canonical cutover/
    );
  }
  for (const [includeVault, includePolicy] of [
    [false, true],
    [true, false],
  ]) {
    assert.throws(
      () =>
        model.assertBypassCanonicalTransactions(
          transactions,
          wanted,
          guard,
          includeVault,
          includePolicy
        ),
      /Bypass Safe batch transactions differ from the canonical cutover/
    );
  }
});

test("bypass trust surface round-trips guard and postcondition constructor ABIs", () => {
  const wanted = expected();
  const state = snapshot(wanted);
  state.whitelistPolicy.owner = wanted.addresses.safe;
  const surface = model.buildBypassTrustSurface(wanted, state);
  assert.equal(surface.whitelistPolicyOwner, state.whitelistPolicy.owner);
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
  assert.deepEqual(surface.riskWindowMethods, [
    hash(103),
    hash(101),
    hash(102),
    hash(99),
  ]);
  assert.deepEqual(surface.riskWindows, ["86400", "172800", "0", "0"]);
  const tuple = model.bypassTrustSurfaceTuple(surface);
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

test("bypass guard expectations bind routes, writers, O4, and whitelist owner", () => {
  const proof = snapshot(expected());
  assert.doesNotThrow(() =>
    model.assertBypassGuardExpectationsUnchanged(proof, clone(proof))
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
      () => model.assertBypassGuardExpectationsUnchanged(proof, simulation),
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
    model.assertBypassGuardExpectationsUnchanged(proof, later)
  );
});

/** @returns {Manifest} */
function manifest() {
  const wanted = expected();
  const proofSnapshot = snapshot(wanted);
  const trustSurface = model.buildBypassTrustSurface(wanted, proofSnapshot);
  const tuple = model.bypassTrustSurfaceTuple(trustSurface);
  /** @param {string} artifactName @param {number} id @param {unknown[]} constructorArgs @returns {import("../deployments/bypassActivationBatchManifest").ContractIdentity} */
  const identity = (artifactName, id, constructorArgs) => ({
    artifactName,
    address: address(id),
    constructorArgs,
    deployTransactionHash: hash(id),
    runtimeCodeHash: hash(id + 100),
  });
  const guard = identity("DisputeBypassCutoverGuard", 50, [tuple, true, true]);
  const postcondition = identity("DisputeBypassCutoverPostcondition", 51, [
    tuple,
  ]);
  const transactions = model.buildBypassCutoverTransactions({
    expected: wanted,
    guard: guard.address,
    includeVaultAcceptOwnership: true,
    includePolicyAcceptOwnership: true,
  });
  /** @type {Omit<Manifest, "manifestSha256">} */
  const unsigned = {
    version: 5,
    kind: "dispute-bypass-cutover",
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
    manifestSha256: manifests.computeBypassManifestSha256(unsigned),
  };
}

test("unsigned v5 bypass manifests validate and reject v4 and tampering", () => {
  const valid = manifest();
  assert.deepEqual(
    deriveBypassConstructorArgs(valid, "guard"),
    valid.guard.constructorArgs
  );
  assert.deepEqual(
    deriveBypassConstructorArgs(valid, "postcondition"),
    valid.postcondition.constructorArgs
  );
  const oldVersion = { ...valid, version: 4 };
  const { manifestSha256: oldDigest, ...oldUnsigned } = oldVersion;
  oldVersion.manifestSha256 = manifests.computeBypassManifestSha256(
    /** @type {any} */ (oldUnsigned)
  );
  assert.throws(
    () => manifests.validateBypassActivationBatchManifest(oldVersion),
    /Invalid dispute bypass Safe batch manifest/
  );
  assert.doesNotThrow(() =>
    manifests.validateBypassActivationBatchManifest(valid, valid)
  );
  /** @type {Array<(value: Manifest) => void>} */
  const mutations = [
    (m) => {
      Object.assign(m, { version: 4 });
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
      () => manifests.validateBypassActivationBatchManifest(changed),
      /Invalid dispute bypass Safe batch manifest/
    );
  }
  // Rehashing cannot make unknown schema keys valid.
  const extra = clone(valid);
  Object.assign(extra.proofSnapshot.freshVault, { extra: true });
  const { manifestSha256, ...unsigned } = extra;
  extra.manifestSha256 = manifests.computeBypassManifestSha256(unsigned);
  assert.throws(
    () => manifests.validateBypassActivationBatchManifest(extra),
    /Invalid dispute bypass Safe batch manifest/
  );
});

test("bypass Safe batch matches manifest order and canonical artifact paths", () => {
  const valid = manifest();
  const batch = manifests.bypassSafeBatchJson(valid.transactions, 10000);
  assert.doesNotThrow(() =>
    manifests.assertBatchMatchesBypassActivationManifest(batch, valid)
  );
  const reordered = manifests.bypassSafeBatchJson(
    [...valid.transactions].reverse(),
    10000
  );
  assert.throws(
    () =>
      manifests.assertBatchMatchesBypassActivationManifest(reordered, valid),
    /Safe batch does not match dispute bypass activation manifest/
  );
  assert.equal(
    manifests.BYPASS_ACTIVATION_BATCH_PATHS.batch,
    "deployments/outputs/safe-batches/base_dispute_bypass_cutover.json"
  );
  assert.equal(
    manifests.BYPASS_ACTIVATION_BATCH_PATHS.sidecar,
    "deployments/outputs/safe-batches/base_dispute_bypass_cutover.sha256.json"
  );
  assert.equal(
    manifests.BYPASS_ACTIVATION_BATCH_PATHS.supersededDir,
    "deployments/outputs/safe-batches/superseded"
  );
});

test("bypass artifact generation requires exact HEAD and a clean tree", () => {
  const repository = temporaryGitRepository("bypass-generation-");
  assert.doesNotThrow(() =>
    assertBypassArtifactGitState(
      repository.root,
      repository.sourceSha,
      "generation"
    )
  );
  commitRepositoryPaths(repository, ["README.md"]);
  assert.throws(
    () =>
      assertBypassArtifactGitState(
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
    () => assertBypassArtifactGitState(repository.root, head, "generation"),
    /clean worktree/
  );
});

test("bypass artifact-child permits unrelated paths", () => {
  const repository = temporaryGitRepository("bypass-unrelated-");
  commitRepositoryPaths(repository, [
    "README.md",
    ".github/workflows/x.yml",
    "deployments/outputs/safe-batches/x.json",
  ]);
  assert.doesNotThrow(() =>
    assertBypassArtifactGitState(
      repository.root,
      repository.sourceSha,
      "artifact-child"
    )
  );
});

test("bypass artifact-child rejects each protected path", () => {
  for (const path of [
    "deploy/45_deploy_bypass_dispute_stack.ts",
    "deploy/46_activate_bypass_dispute_stack.ts",
    "contracts/mocks/X.sol",
    "deployments/base/StakeVaultBypass.json",
    "scripts/verify-bypass-dispute-safe-batch.ts",
    "deployments/bypassDisputeActivation.ts",
  ]) {
    const repository = temporaryGitRepository("bypass-protected-");
    commitRepositoryPaths(repository, [path]);
    assert.throws(
      () =>
        assertBypassArtifactGitState(
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

test("lane 46 classifies bypass policy activity across O4 registration", () => {
  const {
    FORBIDDEN_POLICY_LIFECYCLE_EVENTS,
  } = require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts");
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
    "DisputeProtectionEnabledUpdated",
    "RiskWindowUpdated",
    "LifecycleHookAuthorizationUpdated",
    "OwnershipTransferStarted",
  ].map(event);
  assert.deepEqual(lane.BYPASS_POLICY_LIFECYCLE_EVENTS, [
    ...FORBIDDEN_POLICY_LIFECYCLE_EVENTS,
    "DeferredPayoutFunded",
    "DeferredPayoutClaimed",
  ]);
  for (const name of [
    "DeferredPayoutFunded",
    "DeferredPayoutClaimed",
    "DisputeProtectionIntentOpened",
  ]) {
    assert.throws(
      () => lane.classifyBypassPolicyActivity([event(name)], true),
      {
        message:
          "Fresh CascadeDisputeProtectionPolicy has lifecycle activity before cutover: " +
          `${name} in ${hash(1)}`,
      }
    );
  }
  assert.doesNotThrow(() =>
    lane.classifyBypassPolicyActivity(configuration, true)
  );
  assert.doesNotThrow(() =>
    lane.classifyBypassPolicyActivity(
      [
        "DisputeProtectionIntentOpened",
        "DisputeProtectionIntentSettled",
        "DisputeProtectionIntentReleased",
        "DisputeProtectionIntentCancelled",
        "DisputeResolved",
        "DeferredPayoutFunded",
        "DeferredPayoutClaimed",
      ]
        .map(event)
        .concat(configuration),
      false
    )
  );
  for (const beforeCutover of [true, false]) {
    assert.throws(
      () =>
        lane.classifyBypassPolicyActivity(
          [...configuration, event("DisputeProtectionIntentStakeModeChanged")],
          beforeCutover
        ),
      /emitted an unclassified event: DisputeProtectionIntentStakeModeChanged/
    );
  }
});

test("lane 46 exposes bypass activation tags and no dependencies", () => {
  assert.equal(lane.TAG, "46_activate_bypass_dispute_stack");
  assert.deepEqual(lane.default.tags, [lane.TAG, "V3DisputeBypassActivation"]);
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
          /Lane 46 flags require DEPLOY_ACTIVE_TAG=46_activate_bypass_dispute_stack/
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

test("Base bypass preparation requires release-ready SHA before chain or git access", async () => {
  await withCleanLaneEnv(async () => {
    await assert.rejects(
      () =>
        /** @type {(hre: any) => Promise<void>} */ (
          lane.prepareBaseCutoverBatch
        )(fakeHre("base")),
      /Base batch preparation requires an exact CONFIRM_BASE_V3_DISPUTE_BYPASS_RELEASE_READY_SHA/
    );
  });
});

test("lane 45 prepared check delegates activating and active stacks to lane 46", async () => {
  const lane45 = require("../deploy/45_deploy_bypass_dispute_stack.ts");
  const {
    BYPASS_DEPLOYMENT_NAMES,
    BYPASS_EXPECTED_LIVE,
  } = require("../deployments/bypassDisputeStack.ts");
  // Required module exports are patched because lane 45 lazily requires lane 46.
  const mutableLane = /** @type {any} */ (lane);
  const original = {
    loadBypassActivationContext: lane.loadBypassActivationContext,
    assertBypassActivationSharedState: lane.assertBypassActivationSharedState,
    expectedBypassActivationState: lane.expectedBypassActivationState,
  };
  const wanted = expected("base_staging");
  /** @type {Array<string>} */
  const calls = [];
  const records = new Map(
    BYPASS_DEPLOYMENT_NAMES.map((name) => [
      name,
      {
        address:
          name === "CascadeDisputeProtectionPolicy"
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
          /** @type {import("../deployments/bypassDisputeStack").BypassDeploymentName} */ (
            name
          )
        ),
    },
    ethers: {
      provider: { getBlockNumber: async () => 100 },
      /** @param {string} name @param {string} target */
      getContractAt: async (name, target) => {
        if (name === "NullifierRegistry") return {};
        assert.equal(name, "OrchestratorV3");
        assert.equal(
          target,
          require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts")
            .EXPECTED_LIVE.base_staging.orchestrator
        );
        return {
          lifecycleHook: async () =>
            BYPASS_EXPECTED_LIVE.base_staging.predecessorHook.address,
        };
      },
    },
  });
  try {
    mutableLane.loadBypassActivationContext = async (
      /** @type {any} */ actual,
      /** @type {string} */ network
    ) => {
      assert.equal(actual, hre);
      assert.equal(network, "base_staging");
      calls.push("context");
    };
    mutableLane.expectedBypassActivationState = (
      /** @type {string} */ network
    ) => {
      assert.equal(network, "base_staging");
      calls.push("expected");
      return wanted;
    };
    for (const count of [1, 2 * wanted.paymentMethods.length + 5]) {
      const state = snapshot(wanted, count);
      assert.equal(
        model.reduceBypassActivation(state, wanted).phase,
        count === 1 ? "activating" : "active"
      );
      mutableLane.assertBypassActivationSharedState = async (
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
      assert.equal(await lane45.bypassDisputeStackPrepared(hre), true);
      assert.deepEqual(calls, ["context", "shared", "expected"]);
    }
    const failure = new Error("Unrecognized bypass activation state");
    mutableLane.assertBypassActivationSharedState = async () => {
      throw failure;
    };
    calls.length = 0;
    await assert.rejects(
      lane45.bypassDisputeStackPrepared(hre),
      (error) => error === failure
    );
    assert.deepEqual(calls, ["context"]);
  } finally {
    Object.assign(mutableLane, original);
  }
});

test("bypass batches never call OrchestratorV3", () => {
  const wanted = expected();
  const calls = model.buildBypassCutoverTransactions({
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
  const restore = model.buildBypassActionTransaction(
    "restore-o3-hook",
    staging
  );
  assert.equal(restore.to, staging.addresses.orchestrator);
  assert.deepEqual(
    abiValue(transactionInterface.parseTransaction(restore).args),
    [staging.addresses.predecessorHook]
  );
  assert.deepEqual(model.bypassActivationActions([], "base_staging"), [
    "restore-o3-hook",
    "add-dispute-writer",
    "add-verifier-writer",
    "remove-retired-verifier-writer",
    "register-orchestrator",
  ]);
  const initial = model.bypassRowStateAfter(staging, 0);
  assert.deepEqual(initial.disputeWriters, staging.retainedDisputeWriters);
  assert.deepEqual(initial.nrv2Writers, [staging.addresses.retiredVerifier]);
  assert.equal(initial.registry.length, staging.paymentMethods.length);
  assert.equal(initial.o3Hook, staging.addresses.initialO3Hook);
});

test("O4 and registry trust drift fails closed", () => {
  const wanted = expected();
  for (const [key, value] of Object.entries({
    owner: address(99),
    paused: true,
    chainId: "1",
    lifecycleHook: ZERO,
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
        model.assertBypassGuardExpectationsUnchanged(snapshot(wanted), state),
      /orchestratorV4/
    );
  }
  const state = snapshot(wanted);
  state.orchestratorRegistry.owner = ZERO;
  assertViolation(state, wanted, "orchestratorRegistry.owner");
  state.orchestrator.lifecycleHook = wanted.addresses.freshHook;
  assertViolation(state, wanted, "orchestrator.lifecycleHook");
});

for (const mode of ["staked", "no-stake", "staked then switched to no-stake"]) {
  test(`${mode} PENDING stale-policy intent blocks rotation`, async () => {
    const events = [
      { name: "DisputeProtectionIntentOpened", intentHash: hash(1) },
    ];
    if (mode.includes("switched"))
      events.push({
        name: "DisputeProtectionIntentStakeModeChanged",
        intentHash: hash(1),
      });
    assert.deepEqual(model.openStaleBypassIntents(events), [hash(1)]);
  });
}

test("a settled or cancelled intent does not block", () => {
  assert.deepEqual(
    model.openStaleBypassIntents([
      { name: "DisputeProtectionIntentOpened", intentHash: hash(1) },
      { name: "DisputeProtectionIntentOpened", intentHash: hash(2) },
      { name: "DisputeProtectionIntentSettled", intentHash: hash(1) },
      { name: "DisputeProtectionIntentCancelled", intentHash: hash(2) },
    ]),
    []
  );
});

test("staging rotation waits for stale bypass intents", async () => {
  const abi = [
    "event DisputeProtectionIntentOpened(bytes32 indexed intentHash, uint256 amount)",
    "event DisputeProtectionIntentSettled(bytes32 indexed intentHash)",
    "event DisputeProtectionIntentCancelled(bytes32 indexed intentHash)",
  ];
  const iface = new utils.Interface(abi);
  const record = {
    address: address(80),
    abi,
    receipt: {
      blockNumber: 10,
      from: address(1),
      transactionHash: hash(1),
      blockHash: hash(2),
      transactionIndex: 0,
      gasUsed: "1",
      cumulativeGasUsed: "1",
      logs: [],
    },
  };
  const opened = iface.encodeEventLog(
    iface.getEvent("DisputeProtectionIntentOpened"),
    [hash(1), 100]
  );
  const settled = iface.encodeEventLog(
    iface.getEvent("DisputeProtectionIntentSettled"),
    [hash(1)]
  );
  const logs = [opened];
  /** @param {import("ethers").providers.Filter} filter */
  const readLogs = async (filter) => {
    assert.deepEqual(filter, {
      address: record.address,
      fromBlock: 10,
      toBlock: 100,
    });
    return logs;
  };
  await assert.rejects(
    () => lane.assertStaleBypassIntentsDrained(readLogs, record, 100),
    /Stale bypass intents still open: 1/
  );
  const lane45 = require("../deploy/45_deploy_bypass_dispute_stack.ts");
  /** @type {string[]} */
  const reports = [];
  await lane45.reportOpenStaleBypassIntents(
    readLogs, record, 100,
    (/** @type {string} */ message) => reports.push(message)
  );
  assert.deepEqual(reports, [`Stale bypass intents still open: 1; ${hash(1)}`]);
  logs.push(settled);
  await assert.doesNotReject(() =>
    lane.assertStaleBypassIntentsDrained(readLogs, record, 100)
  );
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
    o3Hook: a.initialO3Hook,
    o4Registered: false,
  };
  const actions = model.bypassActivationActions(
    wanted.paymentMethods.map((method) => method.paymentMethod),
    wanted.network
  );
  assert.deepEqual(model.bypassRowStateAfter(wanted, 0), state);
  actions.forEach((action, index) => {
    if (action === "restore-o3-hook") state.o3Hook = a.predecessorHook;
    else if (action === "add-dispute-writer")
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
    assert.deepEqual(model.bypassRowStateAfter(wanted, index + 1), state);
  });
  for (const invalid of [-1, 0.5, actions.length + 1])
    assert.throws(
      () => model.bypassRowStateAfter(wanted, invalid),
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
      /Base batch preparation requires recorded pin: StakeVaultCascade/
    );
  });
});

test("Base preparation verifies every recorded fresh deployment pin", async () => {
  const stack = require("../deployments/bypassDisputeStack.ts");
  const pins = Object.fromEntries(
    stack.BYPASS_DEPLOYMENT_NAMES.map((name, i) => [
      name,
      { address: address(100 + i), runtimeCodeHash: utils.keccak256("0x1234") },
    ])
  );
  const original = stack.BYPASS_RECORDED_DEPLOYMENTS.base;
  stack.BYPASS_RECORDED_DEPLOYMENTS.base = /** @type {any} */ (pins);
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
    for (const name of stack.BYPASS_DEPLOYMENT_NAMES) {
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
    if (original === undefined) delete stack.BYPASS_RECORDED_DEPLOYMENTS.base;
    else stack.BYPASS_RECORDED_DEPLOYMENTS.base = original;
  }
});
