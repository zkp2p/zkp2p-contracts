#!/usr/bin/env node
require(require.resolve("ts-node/register/transpile-only"));
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { utils } = require("ethers");
const { UPV5_BASE_STAGING_RELEASE } = require("../deployments/parameters.ts");
const { Upv5Function: Fn, buildUpv5CutoverCalls } = require("../deployments/upv5Cutover.ts");
const { assertFreshStagingState, journalInput } = require("./upv5-staging-cutover.ts");

const ROOT = resolve(__dirname, "..");
const DEPLOYED = {
  nullifierRegistryV3: "0x3000000000000000000000000000000000000003",
  unifiedPaymentVerifierV5: "0x5000000000000000000000000000000000000005",
  disputeVerifierV2: "0x2000000000000000000000000000000000000002",
};
const journal = () => ({
  network: "base_staging", chainId: 8453, plannedAtBlock: 1, deployed: { ...DEPLOYED },
  retiredWriters: [UPV5_BASE_STAGING_RELEASE.unifiedPaymentVerifierV4, "0x000000000000000000000000000000000000dEaD"],
  routes: [{ method: utils.id("venmo"), currencies: [utils.id("USD")] }], transactions: [],
});

test("a journaled plan rebuilds the same staging calls", () => {
  const input = journalInput(journal(), DEPLOYED);
  assert.equal(input.paymentVerifierRegistry, UPV5_BASE_STAGING_RELEASE.paymentVerifierRegistry);
  assert.equal(input.nullifierRegistryV2, UPV5_BASE_STAGING_RELEASE.nullifierRegistryV2);
  assert.equal(input.disputeProtectionPolicyV2, UPV5_BASE_STAGING_RELEASE.disputeProtectionPolicyV2);
  const calls = buildUpv5CutoverCalls(input);
  assert.deepEqual(calls.map((call) => call.signature), [
    Fn.RemoveWriter, Fn.RemoveWriter, Fn.AddWriter, Fn.RemoveMethod, Fn.AddMethod, Fn.SetDisputeVerifier,
  ]);
});

test("a journal from another deployment is refused", () => {
  for (const field of Object.keys(DEPLOYED)) {
    const stale = journal();
    stale.deployed[field] = "0x00000000000000000000000000000000000000e1";
    assert.throws(() => journalInput(stale, DEPLOYED), new RegExp(`Journal ${field} differs`));
  }
});

test("the CLI refuses unknown arguments and missing records before any RPC or key use", () => {
  const run = (args) => spawnSync(resolve(ROOT, "node_modules/.bin/ts-node"), ["--transpile-only", "scripts/upv5-staging-cutover.ts", ...args], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, TS_NODE_PROJECT: resolve(ROOT, "tsconfig.json"), STAGING_RPC_URL: "http://127.0.0.1:9", STAGING_DEPLOYER_KEY: "" },
  });
  const unknown = run(["--broadcast"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Usage: upv5-staging-cutover.ts \[--execute\]/);
  const missing = run(["--execute"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /base_staging: UPV5 deployment records missing; run lane 49 first/);
});

test("the script signs only with STAGING_DEPLOYER_KEY as the staging signer and never the retired key", () => {
  const source = readFileSync(resolve(ROOT, "scripts/upv5-staging-cutover.ts"), "utf8");
  assert.match(source, /getDeployerAccounts\(process\.env\)\.base_staging/);
  assert.match(source, /not the staging signer/);
  assert.doesNotMatch(source, /0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929|BASE_DEPLOY_PRIVATE_KEY|BASE_DEPLOYER_KEY/);
});

const STAGING = UPV5_BASE_STAGING_RELEASE;
const ADDRESSES = {
  ...DEPLOYED, nullifierRegistryV2: STAGING.nullifierRegistryV2, unifiedPaymentVerifierV4: STAGING.unifiedPaymentVerifierV4,
  paymentVerifierRegistry: STAGING.paymentVerifierRegistry, disputeProtectionPolicyV2: STAGING.disputeProtectionPolicyV2,
  disputeVerifier: STAGING.disputeVerifier,
};
const STAGING_METHODS = ["venmo", "paypal", "mercury"].map(utils.id);

function untouched() {
  return {
    nullifierRegistryV2Writers: [STAGING.unifiedPaymentVerifierV4, "0x000000000000000000000000000000000000dEaD"],
    nullifierRegistryV3: { writers: [] },
    policy: { disputeVerifier: STAGING.disputeVerifier },
    routes: STAGING_METHODS.map((method) => ({ method, verifier: STAGING.unifiedPaymentVerifierV4, currencies: [utils.id("USD")] })),
    unifiedPaymentVerifierV4: { methods: [...STAGING_METHODS] },
  };
}

test("without a journal only an untouched staging state may be planned", () => {
  assertFreshStagingState(untouched(), ADDRESSES);
  const cases = [
    [(s) => { s.nullifierRegistryV2Writers = []; }, /NullifierRegistryV2 has no writers left/],
    [(s) => { s.nullifierRegistryV3.writers = [DEPLOYED.unifiedPaymentVerifierV5]; }, /NullifierRegistryV3 already has writers/],
    [(s) => { s.policy.disputeVerifier = DEPLOYED.disputeVerifierV2; }, /not the old DisputeVerifier/],
    [(s) => { s.routes[0].verifier = DEPLOYED.unifiedPaymentVerifierV5; }, /not every PaymentVerifierRegistry route is on UPV4/],
    [(s) => { s.routes = []; }, /not every PaymentVerifierRegistry route is on UPV4/],
    // A crash after two removals plus a lost journal: the rest still route to UPV4, but UPV4 lists all three.
    [(s) => { s.routes = s.routes.slice(0, 1); }, /PaymentVerifierRegistry methods .* differ from UPV4's/],
    [(s) => { s.unifiedPaymentVerifierV4.methods.push(utils.id("xmoney")); }, /differ from UPV4's/],
  ];
  for (const [mutate, error] of cases) {
    const snapshot = untouched();
    mutate(snapshot);
    assert.throws(() => assertFreshStagingState(snapshot, ADDRESSES), error);
  }
  // Several symptoms are all reported.
  const crashed = untouched();
  crashed.nullifierRegistryV2Writers = [];
  crashed.nullifierRegistryV3.writers = [DEPLOYED.unifiedPaymentVerifierV5];
  crashed.routes = crashed.routes.slice(0, 2);
  assert.throws(() => assertFreshStagingState(crashed, ADDRESSES), (error) =>
    /no writers left/.test(error.message) && /already has writers/.test(error.message) && /differ from UPV4's/.test(error.message));
});
