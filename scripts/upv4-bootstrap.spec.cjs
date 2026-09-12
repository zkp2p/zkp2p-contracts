#!/usr/bin/env node

process.env.ALCHEMY_API_KEY ||= "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY ||=
  "1111111111111111111111111111111111111111111111111111111111111111";
process.env.TESTNET_DEPLOY_PRIVATE_KEY ||=
  "2222222222222222222222222222222222222222222222222222222222222222";
require("ts-node/register/transpile-only");
require("module-alias/register");
const moduleAlias = require("module-alias");
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { constants, utils } = require("ethers");
const {
  assertAliasRiskWindows,
  assertNamespacePrefix,
  bootstrapNamespaces,
  bootstrapRequested,
  UPV4_BOOTSTRAP_TAG,
  VENMO_METHOD,
  VENMO_BALANCE_METHOD,
} = require("../deployments/unifiedVerifierV4Bootstrap.ts");
const lane =
  require("../deploy/43_deploy_unified_payment_verifier_v4.ts").default;

test("bootstrap preserves every existing namespace and adds only the balance alias", () => {
  const methods = [utils.id("paypal"), VENMO_METHOD, utils.id("cashapp")];
  const entries = bootstrapNamespaces(methods);
  assert.deepEqual(entries, [
    { method: methods[0], namespace: methods[0] },
    { method: VENMO_METHOD, namespace: VENMO_METHOD },
    { method: methods[2], namespace: methods[2] },
    { method: VENMO_BALANCE_METHOD, namespace: VENMO_METHOD },
  ]);
  for (const invalid of [
    [],
    [VENMO_BALANCE_METHOD],
    [VENMO_METHOD, VENMO_BALANCE_METHOD],
    [VENMO_METHOD, VENMO_METHOD],
    [VENMO_METHOD, constants.HashZero],
  ]) {
    assert.throws(
      () => bootstrapNamespaces(invalid),
      /distinct predecessor methods/
    );
  }
});

test("risk gate rejects every protected alias while preserving regular protected methods", () => {
  const entries = bootstrapNamespaces([VENMO_METHOD, utils.id("paypal")]);
  assert.doesNotThrow(() =>
    assertAliasRiskWindows(entries, ["1209600", "1209600", "0"])
  );
  assert.throws(
    () => assertAliasRiskWindows(entries, ["1209600", "1209600", "1"]),
    /Protected nullifier aliases/
  );
  assert.throws(
    () => assertAliasRiskWindows(entries, ["1209600"]),
    /Missing method risk windows/
  );
  assert.throws(
    () =>
      assertAliasRiskWindows(
        [{ method: utils.id("another-alias"), namespace: utils.id("paypal") }],
        ["1"]
      ),
    /Protected nullifier aliases/
  );
});

test("resume accepts each contiguous prefix with exact active flags and assignments", () => {
  const entries = bootstrapNamespaces([VENMO_METHOD, utils.id("paypal")]);
  for (let count = 0; count <= entries.length; count++) {
    assert.equal(
      assertNamespacePrefix(
        entries,
        entries.slice(0, count).map((entry) => entry.method),
        entries.map((entry, index) =>
          index < count ? entry.namespace : constants.HashZero
        ),
        entries.map((_, index) => index < count)
      ),
      count
    );
  }
});

test("resume rejects reordered, foreign, disabled, or reassigned namespaces", () => {
  const entries = bootstrapNamespaces([VENMO_METHOD, utils.id("paypal")]);
  const methods = entries.map((entry) => entry.method);
  const namespaces = entries.map((entry) => entry.namespace);
  assert.throws(
    () =>
      assertNamespacePrefix(entries, [...methods].reverse(), namespaces, [
        true,
        true,
        true,
      ]),
    /exact bootstrap prefix/
  );
  assert.throws(
    () =>
      assertNamespacePrefix(
        entries,
        [...methods, utils.id("foreign")],
        namespaces,
        [true, true, true]
      ),
    /exact bootstrap prefix/
  );
  assert.throws(
    () =>
      assertNamespacePrefix(entries, methods, namespaces, [true, true, false]),
    /active flag mismatch/
  );
  assert.throws(
    () =>
      assertNamespacePrefix(
        entries,
        methods,
        [VENMO_METHOD, namespaces[1], VENMO_BALANCE_METHOD],
        [true, true, true]
      ),
    /namespace or active flag mismatch/
  );
  // Removing a method retains its assigned namespace. Do not silently reactivate
  // it as though this were an uninterrupted fresh deployment.
  assert.throws(
    () =>
      assertNamespacePrefix(entries, methods.slice(0, 2), namespaces, [
        true,
        true,
        false,
      ]),
    /namespace or active flag mismatch/
  );
  assert.throws(
    () =>
      assertNamespacePrefix(
        entries,
        methods,
        [constants.HashZero, ...namespaces.slice(1)],
        [true, true, true]
      ),
    /namespace or active flag mismatch/
  );
});

test("untagged runs perform no reads and live runs require exactly one matching opt-in", async () => {
  const keys = [
    "DEPLOY_ACTIVE_TAG",
    "ENABLE_BASE_UPV4_BOOTSTRAP",
    "ENABLE_STAGING_UPV4_BOOTSTRAP",
  ];
  const saved = keys.map((key) => process.env[key]);
  try {
    keys.forEach((key) => delete process.env[key]);
    assert.deepEqual(lane.tags, [UPV4_BOOTSTRAP_TAG]);
    assert.deepEqual(lane.dependencies, []);
    for (const network of [
      "hardhat",
      "localhost",
      "base",
      "base_staging",
      "sepolia",
    ]) {
      const hre = { deployments: { getNetworkName: () => network } };
      assert.equal(await lane.skip(hre), true);
      await lane(hre); // No accounts, provider or deployment API is available.
    }
    process.env.ENABLE_BASE_UPV4_BOOTSTRAP = "true";
    assert.throws(() => bootstrapRequested("base"), /flags require/);
    process.env.DEPLOY_ACTIVE_TAG = UPV4_BOOTSTRAP_TAG;
    assert.equal(bootstrapRequested("base"), true);
    assert.throws(
      () => bootstrapRequested("base_staging"),
      /requires ENABLE_STAGING/
    );
    assert.throws(
      () => bootstrapRequested("localhost"),
      /cannot target a local network/
    );
    process.env.ENABLE_STAGING_UPV4_BOOTSTRAP = "true";
    assert.throws(
      () => bootstrapRequested("base"),
      /conflicting network flags/
    );
    delete process.env.ENABLE_BASE_UPV4_BOOTSTRAP;
    assert.equal(bootstrapRequested("base_staging"), true);
    delete process.env.ENABLE_STAGING_UPV4_BOOTSTRAP;
    assert.throws(() => bootstrapRequested("base"), /requires ENABLE_BASE/);
    assert.equal(bootstrapRequested("hardhat"), true);
    assert.throws(() => bootstrapRequested("sepolia"), /does not support/);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});
