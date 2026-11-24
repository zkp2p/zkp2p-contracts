#!/usr/bin/env node
require(require.resolve("ts-node/register/transpile-only"));
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { constants, utils } = require("ethers");
const { UPV4_BASE_RELEASE, UPV5_BASE_RELEASE } = require("../deployments/parameters.ts");
const {
  UPV5_STAGING_JOURNAL_PATH, readUpv5Addresses, readUpv5Bindings, readUpv5Deployed, upv5CatalogFor,
} = require("../deployments/upv5Cutover.ts");
const {
  Upv5CheckMode: Mode, Upv5CheckPhase: Phase, evaluateUpv5Postconditions, formatUpv5Checks, routingStateFromSnapshot,
} = require("../deployments/upv5Postconditions.ts");

const ROOT = resolve(__dirname, "..");
const SAFE = UPV5_BASE_RELEASE.governance;
const DEPLOYER = UPV5_BASE_RELEASE.deployer;
const ADDRESSES = {
  nullifierRegistryV3: "0x3000000000000000000000000000000000000003",
  unifiedPaymentVerifierV5: "0x5000000000000000000000000000000000000005",
  disputeVerifierV2: "0x2000000000000000000000000000000000000002",
  nullifierRegistryV2: UPV5_BASE_RELEASE.nullifierRegistryV2,
  unifiedPaymentVerifierV4: UPV5_BASE_RELEASE.unifiedPaymentVerifierV4,
  paymentVerifierRegistry: UPV5_BASE_RELEASE.paymentVerifierRegistry,
  disputeProtectionPolicyV2: UPV5_BASE_RELEASE.disputeProtectionPolicyV2,
  disputeVerifier: UPV5_BASE_RELEASE.disputeVerifier,
};
const BINDINGS = {
  orchestratorRegistry: UPV5_BASE_RELEASE.orchestratorRegistry,
  attestationVerifier: UPV5_BASE_RELEASE.multiAttestationVerifier,
  disputeAttestationVerifier: UPV5_BASE_RELEASE.disputeAttestationVerifier,
};
const PLAN = {
  source: "test plan",
  routes: [["venmo", ["USD"]], ["paypal", ["USD", "EUR"]], ["wise", ["USD"]]]
    .map(([method, currencies]) => ({ method: utils.id(method), currencies: currencies.map(utils.id) })),
};
const METHODS = PLAN.routes.map((route) => route.method);
const EXPECTED = { governance: SAFE, bindings: BINDINGS, catalog: PLAN };
const NAMES = [
  "NullifierRegistryV2 has no writers",
  "Legacy NullifierRegistry has no writers",
  "NullifierRegistryV3's only writer is UPV5",
  "NullifierRegistryV3.predecessor() is NullifierRegistryV2",
  "UPV5.nullifierRegistry() is NullifierRegistryV3",
  "Cutover-time: UPV5 attestation verifier is the one recorded at deployment",
  "UPV5 orchestrator registry is the one recorded at deployment",
  "Every routed payment method is supported by UPV5",
  "Every PaymentVerifierRegistry method routes to UPV5",
  "PaymentVerifierRegistry catalog equals the plan",
  "DisputeProtectionPolicyV2.disputeVerifier() is DisputeVerifierV2",
  "DisputeVerifierV2.nullifierRegistry() is NullifierRegistryV3",
  "Cutover-time: DisputeVerifierV2 attestation verifier is the one recorded at deployment",
  "NullifierRegistryV3 is owned by governance",
  "UPV5 is owned by governance",
  "DisputeVerifierV2 is owned by governance with no pending owner",
];
const CUTOVER_NAMES = [NAMES[0], NAMES[2], NAMES[8], NAMES[9], NAMES[10]];
const clone = (value) => JSON.parse(JSON.stringify(value));

function cutOver() {
  return {
    blockNumber: 1,
    nullifierRegistryV2Writers: [],
    legacyNullifierRegistryWriters: [],
    nullifierRegistryV2Owner: SAFE,
    nullifierRegistryV3: { writers: [ADDRESSES.unifiedPaymentVerifierV5], predecessor: ADDRESSES.nullifierRegistryV2, owner: SAFE },
    unifiedPaymentVerifierV5: {
      nullifierRegistry: ADDRESSES.nullifierRegistryV3, attestationVerifier: BINDINGS.attestationVerifier,
      orchestratorRegistry: BINDINGS.orchestratorRegistry, owner: SAFE, methods: [...METHODS],
    },
    unifiedPaymentVerifierV4: { methods: [...METHODS] },
    routes: PLAN.routes.map((route) => ({ ...route, verifier: ADDRESSES.unifiedPaymentVerifierV5 })),
    paymentVerifierRegistryOwner: SAFE,
    policy: { disputeVerifier: ADDRESSES.disputeVerifierV2, owner: SAFE },
    disputeVerifierV2: {
      nullifierRegistry: ADDRESSES.nullifierRegistryV3, attestationVerifier: BINDINGS.disputeAttestationVerifier,
      owner: SAFE, pendingOwner: constants.AddressZero,
    },
  };
}

function preCutover() {
  const snapshot = cutOver();
  snapshot.nullifierRegistryV2Writers = [...UPV5_BASE_RELEASE.retiredNullifierWriters];
  snapshot.nullifierRegistryV3.writers = [];
  snapshot.routes = snapshot.routes.map((route) => ({ ...route, verifier: ADDRESSES.unifiedPaymentVerifierV4 }));
  snapshot.policy.disputeVerifier = ADDRESSES.disputeVerifier;
  return snapshot;
}

const failing = (snapshot, expected = EXPECTED) =>
  evaluateUpv5Postconditions(snapshot, ADDRESSES, expected).filter((check) => !check.ok).map((check) => check.name);

test("a cut-over network passes every check, in a fixed order and phase", () => {
  const checks = evaluateUpv5Postconditions(cutOver(), ADDRESSES, EXPECTED);
  assert.deepEqual(checks.map((check) => check.name), NAMES);
  assert.ok(checks.every((check) => check.ok));
  assert.deepEqual(checks.filter((check) => check.phase === Phase.Cutover).map((check) => check.name), CUTOVER_NAMES);
});

test("before the cutover the cutover-phase checks are open; the catalog plan already holds", () => {
  assert.deepEqual(failing(preCutover()), [NAMES[0], NAMES[2], NAMES[8], NAMES[10]]);
  // Staging before its journal exists has no plan yet.
  assert.deepEqual(failing(preCutover(), { ...EXPECTED, catalog: null }), CUTOVER_NAMES);
  const pre = formatUpv5Checks(evaluateUpv5Postconditions(preCutover(), ADDRESSES, EXPECTED), Mode.Pre);
  assert.match(pre, /^TODO  NullifierRegistryV2 has no writers: writers \[0xC6F4a193576C60892a47e111Bb5706c30162502B, 0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048\]$/m);
  assert.doesNotMatch(pre, /FAIL/);
  const post = formatUpv5Checks(evaluateUpv5Postconditions(preCutover(), ADDRESSES, EXPECTED), Mode.Post);
  assert.equal(post.split("\n").filter((line) => line.startsWith("FAIL")).length, 4);
  assert.equal(post.split("\n").filter((line) => line.startsWith("PASS")).length, NAMES.length - 4);
});

test("each drift fails exactly its own check", () => {
  const other = "0x00000000000000000000000000000000000000e1";
  const cases = [
    [(s) => { s.nullifierRegistryV2Writers = [other]; }, [NAMES[0]]],
    [(s) => { s.legacyNullifierRegistryWriters = [other]; }, [NAMES[1]]],
    [(s) => { s.nullifierRegistryV3.writers.push(other); }, [NAMES[2]]],
    [(s) => { s.nullifierRegistryV3.predecessor = other; }, [NAMES[3]]],
    [(s) => { s.unifiedPaymentVerifierV5.nullifierRegistry = ADDRESSES.nullifierRegistryV2; }, [NAMES[4]]],
    [(s) => { s.unifiedPaymentVerifierV5.attestationVerifier = other; }, [NAMES[5]]],
    [(s) => { s.unifiedPaymentVerifierV5.orchestratorRegistry = other; }, [NAMES[6]]],
    [(s) => { s.unifiedPaymentVerifierV5.methods.pop(); }, [NAMES[7]]],
    [(s) => { s.routes[1].verifier = ADDRESSES.unifiedPaymentVerifierV4; }, [NAMES[8]]],
    [(s) => { [s.routes[0], s.routes[1]] = [s.routes[1], s.routes[0]]; }, [NAMES[9]]],
    [(s) => { s.routes[1].currencies = [utils.id("USD")]; }, [NAMES[9]]],
    [(s) => { s.routes.pop(); }, [NAMES[9]]],
    [(s) => { s.routes = []; }, [NAMES[7], NAMES[8], NAMES[9]]],
    [(s) => { s.policy.disputeVerifier = ADDRESSES.disputeVerifier; }, [NAMES[10]]],
    [(s) => { s.disputeVerifierV2.nullifierRegistry = ADDRESSES.nullifierRegistryV2; }, [NAMES[11]]],
    [(s) => { s.disputeVerifierV2.attestationVerifier = other; }, [NAMES[12]]],
    [(s) => { s.nullifierRegistryV3.owner = DEPLOYER; }, [NAMES[13]]],
    [(s) => { s.unifiedPaymentVerifierV5.owner = DEPLOYER; }, [NAMES[14]]],
    [(s) => { s.disputeVerifierV2.pendingOwner = SAFE; }, [NAMES[15]]],
    [(s) => { s.disputeVerifierV2.owner = DEPLOYER; }, [NAMES[15]]],
  ];
  for (const [mutate, names] of cases) {
    const snapshot = clone(cutOver());
    mutate(snapshot);
    assert.deepEqual(failing(snapshot), names);
  }
});

test("later changes to UPV4 do not affect the checks", () => {
  const snapshot = clone(cutOver());
  snapshot.unifiedPaymentVerifierV4.methods = [];
  assert.deepEqual(failing(snapshot), []);
});

test("Base's plan is the pinned UPV4 catalog; staging's is its journal", (context) => {
  const base = upv5CatalogFor(ROOT, "base");
  assert.equal(base.source, "UPV4_BASE_RELEASE.paymentRoutes");
  assert.deepEqual(base.routes, UPV4_BASE_RELEASE.paymentRoutes.map(({ method, currencies }) => ({
    method: utils.id(method), currencies: currencies.map(utils.id),
  })));
  const root = mkdtempSync(resolve(tmpdir(), "upv5-journal-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(upv5CatalogFor(root, "base_staging"), null);
  assert.equal(upv5CatalogFor(root, "localhost"), null);
  mkdirSync(resolve(root, "deployments/outputs"), { recursive: true });
  writeFileSync(resolve(root, UPV5_STAGING_JOURNAL_PATH), JSON.stringify({ routes: PLAN.routes }));
  assert.deepEqual(upv5CatalogFor(root, "base_staging"), { source: UPV5_STAGING_JOURNAL_PATH, routes: PLAN.routes });
});

test("routing state mirrors the snapshot fields the cutover predicates read", () => {
  const snapshot = preCutover();
  assert.deepEqual(routingStateFromSnapshot(snapshot, ADDRESSES), {
    unifiedPaymentVerifierV5: ADDRESSES.unifiedPaymentVerifierV5,
    nullifierRegistryV2Writers: snapshot.nullifierRegistryV2Writers, nullifierRegistryV3Writers: [],
    routes: snapshot.routes, policyDisputeVerifier: ADDRESSES.disputeVerifier,
  });
});

function recordRoot(context, network, records, args = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "upv5-records-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "deployments", network), { recursive: true });
  for (const [name, address] of Object.entries(records)) {
    writeFileSync(resolve(root, "deployments", network, `${name}.json`), JSON.stringify({ address, args: args[name] }));
  }
  return root;
}

const BASE_ARGS = {
  NullifierRegistryV3: [UPV5_BASE_RELEASE.nullifierRegistryV2],
  UnifiedPaymentVerifierV5: [UPV5_BASE_RELEASE.orchestratorRegistry, ADDRESSES.nullifierRegistryV3, UPV5_BASE_RELEASE.multiAttestationVerifier],
  DisputeVerifierV2: [SAFE, ADDRESSES.nullifierRegistryV3, UPV5_BASE_RELEASE.disputeAttestationVerifier],
};

const BASE_RECORDS = {
  NullifierRegistryV3: ADDRESSES.nullifierRegistryV3, UnifiedPaymentVerifierV5: ADDRESSES.unifiedPaymentVerifierV5,
  DisputeVerifierV2: ADDRESSES.disputeVerifierV2, NullifierRegistryV2: ADDRESSES.nullifierRegistryV2,
  UnifiedPaymentVerifierV4: ADDRESSES.unifiedPaymentVerifierV4, PaymentVerifierRegistry: ADDRESSES.paymentVerifierRegistry,
  DisputeProtectionPolicyV2: ADDRESSES.disputeProtectionPolicyV2, DisputeVerifier: ADDRESSES.disputeVerifier,
};

test("addresses come from deployment records and must equal the pins on pinned networks", (context) => {
  assert.deepEqual(readUpv5Addresses(recordRoot(context, "base", BASE_RECORDS), "base"), ADDRESSES);
  assert.equal(readUpv5Deployed(ROOT, "base"), null, "Base has no UPV5 records before its deployment");
  assert.throws(() => readUpv5Addresses(recordRoot(context, "base", { ...BASE_RECORDS, DisputeVerifier: ADDRESSES.disputeVerifierV2 }), "base"),
    /disputeVerifier record differs from the release pin/);
  const { DisputeVerifierV2: _dropped, ...partial } = BASE_RECORDS;
  assert.throws(() => readUpv5Addresses(recordRoot(context, "base", partial), "base"), /partial UPV5 deployment records/);
  const { NullifierRegistryV3: _a, UnifiedPaymentVerifierV5: _b, DisputeVerifierV2: _c, ...none } = BASE_RECORDS;
  assert.throws(() => readUpv5Addresses(recordRoot(context, "base", none), "base"), /records missing; run lane 49 first/);
  assert.throws(() => readUpv5Addresses(recordRoot(context, "base", { ...BASE_RECORDS, NullifierRegistryV3: constants.AddressZero }), "base"),
    /invalid or zero address/);
  // Unpinned networks take whatever their records say.
  const local = { ...BASE_RECORDS, DisputeVerifier: "0x00000000000000000000000000000000000000f1" };
  assert.equal(readUpv5Addresses(recordRoot(context, "localhost", local), "localhost").disputeVerifier, local.DisputeVerifier);
});

test("recorded bindings come from the lane 49 records and must equal the pins on pinned networks", (context) => {
  const root = recordRoot(context, "base", BASE_RECORDS, BASE_ARGS);
  assert.deepEqual(readUpv5Bindings(root, "base", ADDRESSES), BINDINGS);
  const cases = [
    [{ ...BASE_ARGS, DisputeVerifierV2: [DEPLOYER, ADDRESSES.nullifierRegistryV3, BINDINGS.disputeAttestationVerifier] }, /DisputeVerifierV2 owner .* differs from the release pin/],
    [{ ...BASE_ARGS, UnifiedPaymentVerifierV5: [BINDINGS.orchestratorRegistry, ADDRESSES.nullifierRegistryV3, SAFE] }, /UPV5 attestationVerifier .* differs/],
    [{ ...BASE_ARGS, UnifiedPaymentVerifierV5: [BINDINGS.orchestratorRegistry, SAFE, BINDINGS.attestationVerifier] }, /not bound to the recorded NullifierRegistryV3/],
    [{ ...BASE_ARGS, NullifierRegistryV3: [SAFE] }, /NullifierRegistryV3 predecessor .* differs/],
    [{ ...BASE_ARGS, DisputeVerifierV2: [SAFE, ADDRESSES.nullifierRegistryV3] }, /expected 3 constructor args/],
  ];
  for (const [args, error] of cases) {
    assert.throws(() => readUpv5Bindings(recordRoot(context, "base", BASE_RECORDS, args), "base", ADDRESSES), error);
  }
  // Unpinned networks take whatever lane 49 recorded.
  const local = { ...BASE_ARGS, DisputeVerifierV2: [DEPLOYER, ADDRESSES.nullifierRegistryV3, SAFE] };
  assert.equal(readUpv5Bindings(recordRoot(context, "localhost", BASE_RECORDS, local), "localhost", ADDRESSES).disputeAttestationVerifier, SAFE);
});

test("the CLI fails closed on usage errors and missing records before any RPC", () => {
  const run = (args) => spawnSync(resolve(ROOT, "node_modules/.bin/ts-node"), ["--transpile-only", "scripts/upv5-postconditions.ts", ...args], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, TS_NODE_PROJECT: resolve(ROOT, "tsconfig.json"), BASE_RPC_URL: "http://127.0.0.1:9" },
  });
  const usage = run([]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: upv5-postconditions.ts <network>/);
  const missing = run(["base", "--pre"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /base: UPV5 deployment records missing; run lane 49 first/);
  const unpinned = run(["localhost"]);
  assert.equal(unpinned.status, 1);
  assert.match(unpinned.stderr, /records missing|--governance is required/);
});
