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
const { test } = require("node:test");
const { BigNumber, constants, utils } = require("ethers");
const {
  assertAliasRiskWindows,
  assertPinnedBootstrapSurface,
  assertPinnedBootstrapContract,
  assertBootstrapAttestationAuthority,
  pinnedBootstrapPredecessor,
  readBootstrapPredecessor,
  assertNamespacePrefix,
  bootstrapNamespaces,
  bootstrapRequested,
  UPV4_BOOTSTRAP_TAG,
  VENMO_METHOD,
  VENMO_BALANCE_METHOD,
} = require("../deployments/unifiedVerifierV4Bootstrap.ts");
const lane =
  require("../deploy/43_deploy_unified_payment_verifier_v4.ts").default;
const deployLane = /** @type {(hre: any) => Promise<void>} */ (lane);
const skipLane = /** @type {(hre: any) => Promise<boolean>} */ (lane.skip);

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

// A provider-only local stack exercises the real preflight and lane ordering.
// Live addresses/catalogs are covered separately by the pinned-evidence tests.
function predecessorFixture() {
  const names = [
    "UnifiedPaymentVerifierV3",
    "NullifierRegistryV2",
    "NullifierRegistry",
    "PaymentVerifierRegistry",
    "OrchestratorRegistry",
    "OrchestratorV3",
    "IntentLifecycleHookV1MethodScopedStaked",
    "DisputeProtectionPolicyMethodScopedStaked",
    "MultiAttestationVerifier",
  ];
  const addresses = Object.fromEntries(
    names.map((name, index) => [
      name,
      utils.getAddress(utils.hexZeroPad(utils.hexlify(index + 1), 20)),
    ])
  );
  const governance = utils.getAddress(utils.hexZeroPad("0xff", 20));
  const block = { number: 123, hash: utils.id("preflight-block") };
  const methods = [VENMO_METHOD, utils.id("paypal")];
  /** @type {Record<string, Record<string, any>>} */
  const values = Object.fromEntries(
    names.map((name) => [name, { owner: governance }])
  );
  Object.assign(values.UnifiedPaymentVerifierV3, {
    nullifierRegistry: addresses.NullifierRegistryV2,
    orchestratorRegistry: addresses.OrchestratorRegistry,
    attestationVerifier: addresses.MultiAttestationVerifier,
    getPaymentMethods: methods,
    isPaymentMethod: true,
    DOMAIN_SEPARATOR: utils._TypedDataEncoder.hashDomain({
      name: "UnifiedPaymentVerifier",
      version: "1",
      chainId: 31337,
      verifyingContract: addresses.UnifiedPaymentVerifierV3,
    }),
  });
  Object.assign(values.NullifierRegistryV2, {
    legacyNullifierRegistry: addresses.NullifierRegistry,
    getWriters: [addresses.UnifiedPaymentVerifierV3],
  });
  values.NullifierRegistry.getWriters = [];
  Object.assign(values.PaymentVerifierRegistry, {
    getPaymentMethods: methods,
    getVerifier: addresses.UnifiedPaymentVerifierV3,
    getCurrencies: [utils.id("USD")],
  });
  values.OrchestratorRegistry.isOrchestrator = true;
  Object.assign(values.OrchestratorV3, {
    paymentVerifierRegistry: addresses.PaymentVerifierRegistry,
    lifecycleHook: addresses.IntentLifecycleHookV1MethodScopedStaked,
    paused: false,
    chainId: BigNumber.from(31337),
  });
  Object.assign(values.IntentLifecycleHookV1MethodScopedStaked, {
    orchestratorRegistry: addresses.OrchestratorRegistry,
    disputeProtectionPolicy:
      addresses.DisputeProtectionPolicyMethodScopedStaked,
  });
  Object.assign(values.DisputeProtectionPolicyMethodScopedStaked, {
    isLifecycleHookAuthorized: true,
    getRiskWindow: BigNumber.from(0),
  });
  Object.assign(values.MultiAttestationVerifier, {
    witnesses: [governance],
    requiredSignatures: BigNumber.from(1),
    witnessCount: BigNumber.from(1),
  });
  /** @type {string[]} */
  const calls = [];
  const controls = {
    network: "localhost",
    chainId: 31337,
    code: "0x6000",
    changedBlock: false,
    deploys: 0,
  };
  /** @type {any} */
  const hre = {
    getUnnamedAccounts: async () => [governance],
    ethers: {
      provider: {
        getNetwork: async () => ({ chainId: controls.chainId }),
        getBlock: async (/** @type {string | number} */ tag) => {
          assert.ok(tag === "latest" || tag === block.number);
          return tag === "latest" || !controls.changedBlock
            ? block
            : { ...block, hash: utils.id("changed-block") };
        },
        getCode: async (
          /** @type {string} */ address,
          /** @type {number} */ tag
        ) => {
          assert.ok(Object.values(addresses).includes(address));
          assert.equal(tag, block.number);
          return controls.code;
        },
      },
      getContractAt: async (
        /** @type {string} */ _artifact,
        /** @type {string} */ address
      ) => {
        const name = names.find((item) => addresses[item] === address);
        assert.ok(name);
        return {
          address,
          ...Object.fromEntries(
            Object.keys(values[name]).map((getter) => [
              getter,
              async (/** @type {any[]} */ ...args) => {
                assert.deepEqual(args.at(-1), { blockTag: block.number });
                calls.push(`${name}.${getter}`);
                return values[name][getter];
              },
            ])
          ),
        };
      },
    },
    deployments: {
      getNetworkName: () => controls.network,
      get: async (/** @type {string} */ name) => ({
        address: addresses[name],
        deployedBytecode: "0x6000",
        solcInputHash: "fixture",
      }),
      getExtendedArtifact: async () => ({ solcInputHash: "fixture" }),
      getOrNull: async () => {
        throw new Error("Successor lookup reached before preflight rejection");
      },
      deploy: async () => {
        controls.deploys++;
        throw new Error("Unexpected deployment");
      },
    },
  };
  return { hre, values, controls, calls, governance, block };
}

test("preflight reads one block and captures attestation authority for resume", async () => {
  const fixture = predecessorFixture();
  const result = await readBootstrapPredecessor(fixture.hre);
  assert.equal(result.blockNumber, fixture.block.number);
  assert.equal(result.blockHash, fixture.block.hash);
  assert.deepEqual(result.state.witnesses, [fixture.governance]);
  assert.equal(result.state.attestationThreshold, "1");
  assert.deepEqual(
    result.state.entries,
    bootstrapNamespaces([VENMO_METHOD, utils.id("paypal")])
  );
  assert.ok(fixture.calls.includes("MultiAttestationVerifier.owner"));
  assert.ok(
    fixture.calls.includes("UnifiedPaymentVerifierV3.DOMAIN_SEPARATOR")
  );
});

test("preflight drift aborts the actual lane before successor lookup or deployment", async () => {
  /** @type {Array<{ name: string, change: (fixture: ReturnType<typeof predecessorFixture>) => void, error: RegExp }>} */
  const cases = [
    {
      name: "wrong live chain",
      change: (f) => {
        f.controls.network = "base";
      },
      error: /chain mismatch/,
    },
    {
      name: "wrong live identity",
      change: (f) => {
        f.controls.network = "base";
        f.controls.chainId = 8453;
      },
      error: /contract identity/,
    },
    {
      name: "runtime",
      change: (f) => {
        f.controls.code = "0x6001";
      },
      error: /on-chain code/,
    },
    {
      name: "paused O3",
      change: (f) => {
        f.values.OrchestratorV3.paused = true;
      },
      error: /dependency or active lifecycle/,
    },
    {
      name: "O3 chain",
      change: (f) => {
        f.values.OrchestratorV3.chainId = BigNumber.from(1);
      },
      error: /dependency or active lifecycle/,
    },
    {
      name: "unauthorized O3",
      change: (f) => {
        f.values.OrchestratorRegistry.isOrchestrator = false;
      },
      error: /dependency or active lifecycle/,
    },
    {
      name: "unauthorized hook",
      change: (f) => {
        f.values.DisputeProtectionPolicyMethodScopedStaked.isLifecycleHookAuthorized = false;
      },
      error: /dependency or active lifecycle/,
    },
    {
      name: "extra V2 writer",
      change: (f) => {
        f.values.NullifierRegistryV2.getWriters.push(constants.AddressZero);
      },
      error: /sole writer/,
    },
    {
      name: "legacy writer",
      change: (f) => {
        f.values.NullifierRegistry.getWriters = [constants.AddressZero];
      },
      error: /sole writer/,
    },
    {
      name: "method set",
      change: (f) => {
        f.values.UnifiedPaymentVerifierV3.getPaymentMethods = [VENMO_METHOD];
      },
      error: /method set differs/,
    },
    {
      name: "inactive method",
      change: (f) => {
        f.values.UnifiedPaymentVerifierV3.isPaymentMethod = false;
      },
      error: /inactive method or partial route/,
    },
    {
      name: "partial route",
      change: (f) => {
        f.values.PaymentVerifierRegistry.getVerifier = constants.AddressZero;
      },
      error: /inactive method or partial route/,
    },
    {
      name: "missing currency",
      change: (f) => {
        f.values.PaymentVerifierRegistry.getCurrencies = [];
      },
      error: /no currencies/,
    },
    {
      name: "protected alias",
      change: (f) => {
        f.values.DisputeProtectionPolicyMethodScopedStaked.getRiskWindow =
          BigNumber.from(1);
      },
      error: /Protected nullifier aliases/,
    },
    {
      name: "empty witnesses",
      change: (f) => {
        f.values.MultiAttestationVerifier.witnesses = [];
      },
      error: /attestation authority/,
    },
    {
      name: "threshold",
      change: (f) => {
        f.values.MultiAttestationVerifier.requiredSignatures =
          BigNumber.from(0);
      },
      error: /attestation authority/,
    },
    {
      name: "domain",
      change: (f) => {
        f.values.UnifiedPaymentVerifierV3.DOMAIN_SEPARATOR = constants.HashZero;
      },
      error: /signing domain/,
    },
    {
      name: "block hash",
      change: (f) => {
        f.controls.changedBlock = true;
      },
      error: /block changed/,
    },
  ];
  for (const [name, getters] of Object.entries({
    UnifiedPaymentVerifierV3: [
      "nullifierRegistry",
      "orchestratorRegistry",
      "attestationVerifier",
    ],
    NullifierRegistryV2: ["legacyNullifierRegistry"],
    OrchestratorV3: ["paymentVerifierRegistry", "lifecycleHook"],
    IntentLifecycleHookV1MethodScopedStaked: [
      "orchestratorRegistry",
      "disputeProtectionPolicy",
    ],
  })) {
    for (const getter of getters)
      cases.push({
        name: `${name}.${getter}`,
        change: (f) => {
          f.values[name][getter] = constants.AddressZero;
        },
        error: /dependency or active lifecycle/,
      });
  }
  for (const name of Object.keys(predecessorFixture().values).filter(
    (name) => !name.startsWith("IntentLifecycleHook")
  ))
    cases.push({
      name: `${name}.owner`,
      change: (f) => {
        f.values[name].owner = constants.AddressZero;
      },
      error:
        /governance mismatch|dependency or active lifecycle|attestation authority/,
    });
  const keys = [
    "DEPLOY_ACTIVE_TAG",
    "ENABLE_BASE_UPV4_BOOTSTRAP",
    "ENABLE_STAGING_UPV4_BOOTSTRAP",
  ];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const { name, change, error } of cases) {
      const fixture = predecessorFixture();
      change(fixture);
      keys.forEach((key) => delete process.env[key]);
      process.env.DEPLOY_ACTIVE_TAG = UPV4_BOOTSTRAP_TAG;
      if (fixture.controls.network === "base")
        process.env.ENABLE_BASE_UPV4_BOOTSTRAP = "true";
      await assert.rejects(deployLane(fixture.hre), error, name);
      assert.equal(fixture.controls.deploys, 0, name);
    }
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
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
      assert.equal(await skipLane(hre), true);
      await deployLane(hre); // No accounts, provider or deployment API is available.
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

test("current Base bootstrap preserves the observed eleven-method surface including UPI", () => {
  const expected = pinnedBootstrapPredecessor("base");
  assert.ok(expected);
  const names = [
    "alipay",
    "chime",
    "venmo",
    "revolut",
    "cashapp",
    "wise",
    "mercadopago",
    "zelle",
    "monzo",
    "paypal",
    "upi",
  ];
  const methods = names.map(utils.id);
  const currencies = expected.routes.map((route) => [...route.currencies]);
  assert.deepEqual(
    expected.routes.map((route) => route.method),
    methods
  );
  assert.deepEqual(currencies[10], [utils.id("INR")]);
  assert.doesNotThrow(() =>
    assertPinnedBootstrapSurface(expected, methods, currencies, methods)
  );
  assert.throws(
    () =>
      assertPinnedBootstrapSurface(
        expected,
        methods.slice(0, 10),
        currencies.slice(0, 10),
        methods.slice(0, 10)
      ),
    /surface changed/
  );
  const entries = bootstrapNamespaces(methods);
  assert.deepEqual(entries[10], {
    method: utils.id("upi"),
    namespace: utils.id("upi"),
  });
});

test("staging preserves its distinct registry and predecessor method orders", () => {
  const expected = pinnedBootstrapPredecessor("base_staging");
  assert.ok(expected);
  const methods = [
    "zelle",
    "monzo",
    "alipay",
    "chime",
    "venmo",
    "revolut",
    "cashapp",
    "wise",
    "mercadopago",
    "paypal",
    "monobank",
    "mercury",
    "upi",
  ].map(utils.id);
  const predecessorMethods = [
    "monzo",
    "alipay",
    "chime",
    "venmo",
    "revolut",
    "cashapp",
    "wise",
    "mercadopago",
    "zelle",
    "paypal",
    "monobank",
    "mercury",
    "upi",
  ].map(utils.id);
  const currencies = expected.routes.map((route) => [...route.currencies]);
  assert.doesNotThrow(() =>
    assertPinnedBootstrapSurface(
      expected,
      methods,
      currencies,
      predecessorMethods
    )
  );
  assert.throws(
    () => assertPinnedBootstrapSurface(expected, methods, currencies, methods),
    /surface changed/
  );
  assert.throws(
    () =>
      assertPinnedBootstrapSurface(
        expected,
        predecessorMethods,
        currencies,
        predecessorMethods
      ),
    /surface changed/
  );
});

test("current predecessor catalog validation refuses unreviewed route or currency drift", () => {
  const expected = pinnedBootstrapPredecessor("base");
  assert.ok(expected);
  const methods = expected.routes.map((route) => route.method);
  const currencies = expected.routes.map((route) => [...route.currencies]);
  const predecessor = [...expected.predecessorMethods];
  const changedCurrency = currencies.map((row) => [...row]);
  changedCurrency[0] = [utils.id("USD")];
  const reorderedCurrencies = currencies.map((row) => [...row]);
  reorderedCurrencies[3].reverse();
  const duplicateCurrency = currencies.map((row) => [...row]);
  duplicateCurrency[0].push(duplicateCurrency[0][0]);
  for (const actual of [
    {
      methods: [...methods, utils.id("unreviewed")],
      currencies: [...currencies, [utils.id("USD")]],
      predecessor: [...predecessor, utils.id("unreviewed")],
    },
    {
      methods: [...methods.slice(0, -1), VENMO_BALANCE_METHOD],
      currencies,
      predecessor: [...predecessor.slice(0, -1), VENMO_BALANCE_METHOD],
    },
    {
      methods: [...methods].reverse(),
      currencies: [...currencies].reverse(),
      predecessor,
    },
    { methods, currencies: currencies.slice(0, -1), predecessor },
    { methods, currencies: changedCurrency, predecessor },
    { methods, currencies: reorderedCurrencies, predecessor },
    { methods, currencies: duplicateCurrency, predecessor },
    { methods, currencies, predecessor: [...predecessor].reverse() },
  ]) {
    assert.throws(
      () =>
        assertPinnedBootstrapSurface(
          expected,
          actual.methods,
          actual.currencies,
          actual.predecessor
        ),
      /surface changed/
    );
  }
  assert.equal(pinnedBootstrapPredecessor("localhost"), undefined);
  assert.equal(pinnedBootstrapPredecessor("hardhat"), undefined);
  assert.throws(() => pinnedBootstrapPredecessor("sepolia"), /Unsupported/);
});

test("live predecessor pins reject changed addresses and full runtime hashes", () => {
  for (const network of ["base", "base_staging"]) {
    const expected = pinnedBootstrapPredecessor(network);
    assert.ok(expected);
    for (const contract of Object.values(expected.contracts)) {
      assert.doesNotThrow(() =>
        assertPinnedBootstrapContract(
          contract,
          contract.address.toLowerCase(),
          contract.runtimeCodeHash
        )
      );
      assert.throws(
        () =>
          assertPinnedBootstrapContract(
            contract,
            constants.AddressZero,
            contract.runtimeCodeHash
          ),
        /identity mismatch/
      );
      assert.throws(
        () =>
          assertPinnedBootstrapContract(
            contract,
            contract.address,
            constants.HashZero
          ),
        /identity mismatch/
      );
    }
  }
});

test("bootstrap refuses governance, witness and threshold drift", () => {
  for (const network of ["base", "base_staging"]) {
    const expected = pinnedBootstrapPredecessor(network);
    assert.ok(expected);
    const authority = {
      owner: expected.governance.toLowerCase(),
      witnesses: expected.witnesses.map((address) => address.toLowerCase()),
      threshold: "1",
      witnessCount: "2",
    };
    assert.doesNotThrow(() =>
      assertBootstrapAttestationAuthority(
        expected.governance,
        expected,
        authority
      )
    );
    for (const change of [
      { owner: constants.AddressZero },
      { witnesses: [...authority.witnesses].reverse() },
      { witnesses: [constants.AddressZero, authority.witnesses[1]] },
      { witnesses: [], witnessCount: "0" },
      { threshold: "0" },
      { threshold: "2" },
      { threshold: "3" },
      { witnessCount: "1" },
    ]) {
      assert.throws(
        () =>
          assertBootstrapAttestationAuthority(expected.governance, expected, {
            ...authority,
            ...change,
          }),
        /authority mismatch/
      );
    }
    assert.doesNotThrow(() =>
      assertBootstrapAttestationAuthority(
        expected.governance,
        undefined,
        authority
      )
    );
    assert.throws(
      () =>
        assertBootstrapAttestationAuthority(expected.governance, undefined, {
          ...authority,
          owner: constants.AddressZero,
        }),
      /authority mismatch/
    );
    assert.throws(
      () =>
        assertBootstrapAttestationAuthority(expected.governance, undefined, {
          ...authority,
          threshold: "0",
        }),
      /authority mismatch/
    );
    assert.throws(
      () =>
        assertBootstrapAttestationAuthority(expected.governance, undefined, {
          ...authority,
          witnesses: [],
          witnessCount: "0",
        }),
      /authority mismatch/
    );
    assert.throws(
      () =>
        assertBootstrapAttestationAuthority(expected.governance, undefined, {
          ...authority,
          witnessCount: "1",
        }),
      /authority mismatch/
    );
    assert.throws(
      () =>
        assertBootstrapAttestationAuthority(expected.governance, undefined, {
          ...authority,
          threshold: "3",
        }),
      /authority mismatch/
    );
  }
});
