const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");
const { ethers } = require("ethers");

require("module-alias").addAlias("hardhat", "ethers");
require("ts-node/register/transpile-only");
const parameters = require("../deployments/parameters");
const { XMONEY_PROVIDER_CONFIG } = require("../deployments/verifiers/xmoney");
const evidence = require("../deployments/dispute-stack-evidence.json");
const hash = ethers.utils.id;
const method = hash("xmoney");
const tag = "43_add_xmoney_payment_method";

function loadLane(filename, dependencies, env, result = "exports") {
  const source = readFileSync(require.resolve("../deploy/" + filename), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  return Function("require", "exports", "process", outputText + "\nreturn " + result)(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), "Unexpected dependency: " + name);
      return dependencies[name];
    }, {}, { env },
  );
}

function harness({ mode = "execute", selectedTag = tag, network = "base_staging",
  registryHas = false, verifierHas = false, failRegistry = false } = {}) {
  const calls = [];
  const env = { DEPLOY_ACTIVE_TAG: selectedTag };
  if (mode === "prepare" || mode === "both") env.PREPARE_STAGING_XMONEY_PAYMENT_METHOD = "true";
  if (mode === "execute" || mode === "both") env.EXECUTE_STAGING_XMONEY_PAYMENT_METHOD = "true";
  const contracts = {};
  const code = new Map();
  const provider = {
    getNetwork: async () => { calls.push("read"); return { chainId: 8453 }; },
    getCode: async (address) => code.get(address),
  };
  const dependencies = {
    "module-alias/register": {},
    hardhat: { ethers: {
      ...ethers, provider,
      getContractAt: async (name, address) => {
        assert.equal(contracts[name].address, address);
        return contracts[name];
      },
    } },
    "../deployments/parameters": parameters,
    "../deployments/helpers": {
      addPaymentMethodToUnifiedVerifier: async (_hre, verifier, value) => {
        assert.equal(verifier, contracts.UnifiedPaymentVerifierV3);
        assert.equal(value, method);
        if (!verifierMethods.includes(method)) {
          calls.push("verifier-write");
          verifierMethods.push(method);
        }
      },
      addPaymentMethodToRegistry: async (_hre, registry, value, verifier, currencies) => {
        assert.equal(registry, contracts.PaymentVerifierRegistry);
        assert.equal(value, method);
        assert.equal(verifier, pinned.unifiedPaymentVerifierV3);
        assert.deepEqual(currencies, [hash("USD")]);
        if (!registryMethods.includes(method)) {
          calls.push("registry-write");
          if (failRegistry) throw new Error("registry transaction failed");
          registryMethods.push(method);
        }
      },
      savePaymentMethodSnapshot: (...args) => calls.push(["snapshot", ...args]),
    },
    "../deployments/safeBatchCollector": {},
    "../deployments/verifiers/xmoney": { XMONEY_PROVIDER_CONFIG },
  };
  // Exercise the real readiness logic with deterministic bytecode fixtures.
  const { binding, pinned } = loadLane("31_deploy_v3_payment_binding_stack.ts", dependencies, env,
    "({ binding: exports, pinned: EXISTING_PAYMENT_BINDING.base_staging })");
  const names = binding.RATIFIED_PAYMENT_METHOD_ORDER.base_staging;
  const predecessor = names.filter((name) => name !== "xmoney").map(hash);
  const registryMethods = [...predecessor, ...(registryHas ? [method] : [])];
  const verifierMethods = [...predecessor, ...(verifierHas ? [method] : [])];
  const addresses = {
    PaymentVerifierRegistry: pinned.paymentVerifierRegistry,
    UnifiedPaymentVerifierV3: pinned.unifiedPaymentVerifierV3,
    NullifierRegistryV2: pinned.nullifierRegistryV2,
    NullifierRegistry: pinned.legacyNullifierRegistry,
    OrchestratorRegistry: pinned.orchestratorRegistry,
    OrchestratorV3: pinned.orchestrator,
    MultiAttestationVerifier: pinned.attestationVerifier,
  };
  for (const [name, address] of Object.entries(addresses)) {
    contracts[name] = { address, owner: async () => pinned.governance };
    code.set(address, "0x6000");
  }
  for (const name of ["nullifierRegistryV2", "unifiedPaymentVerifierV3", "orchestrator", "attestationVerifier"]) {
    pinned[name + "CodeHash"] = ethers.utils.keccak256("0x6000");
  }
  Object.assign(contracts.PaymentVerifierRegistry, {
    getPaymentMethods: async () => registryMethods,
    isPaymentMethod: async (value) => registryMethods.includes(value),
    getVerifier: async () => pinned.unifiedPaymentVerifierV3,
    getCurrencies: async (value) => binding.RATIFIED_PAYMENT_METHOD_CURRENCIES[
      names.find((name) => hash(name) === value)
    ].map(hash),
    callStatic: { addPaymentMethod: async (...args) => calls.push(["simulate-registry", ...args]) },
  });
  Object.assign(contracts.UnifiedPaymentVerifierV3, {
    getPaymentMethods: async () => verifierMethods,
    isPaymentMethod: async (value) => verifierMethods.includes(value),
    nullifierRegistry: async () => pinned.nullifierRegistryV2,
    orchestratorRegistry: async () => pinned.orchestratorRegistry,
    attestationVerifier: async () => pinned.attestationVerifier,
    callStatic: { addPaymentMethod: async (...args) => calls.push(["simulate-verifier", ...args]) },
  });
  Object.assign(contracts.NullifierRegistryV2, {
    getWriters: async () => [pinned.unifiedPaymentVerifierV3],
    legacyNullifierRegistry: async () => pinned.legacyNullifierRegistry,
  });
  contracts.NullifierRegistry.getWriters = async () => [];
  contracts.OrchestratorRegistry.isOrchestrator = async () => true;
  Object.assign(contracts.OrchestratorV3, {
    paused: async () => false,
    chainId: async () => ethers.BigNumber.from(8453),
    paymentVerifierRegistry: async () => pinned.paymentVerifierRegistry,
  });
  Object.assign(contracts.MultiAttestationVerifier, {
    witnesses: async () => pinned.attestationWitnesses,
    requiredSignatures: async () => ethers.BigNumber.from(pinned.attestationThreshold),
  });
  const hre = {
    deployments: {
      getNetworkName: () => network,
      get: async (name) => ({ address: addresses[name] }),
      getOrNull: async (name) => ({ address: addresses[name] }),
    },
    getUnnamedAccounts: async () => [pinned.governance],
  };
  dependencies["./31_deploy_v3_payment_binding_stack"] = binding;
  const lane = loadLane("43_add_xmoney_payment_method.ts", dependencies, env).default;
  return {
    run: () => lane(hre), ready: () => binding.paymentBindingCutoverReady(hre),
    calls, contracts, provider, hre, registryMethods, verifierMethods,
    actions: () => calls.filter((call) => call !== "read"),
  };
}

test("X Money extends only the staging catalog with USD and a zero risk window", () => {
  assert.deepEqual(XMONEY_PROVIDER_CONFIG, { paymentMethodHash: method, currencies: [hash("USD")] });
  assert.equal(parameters.getActivePaymentMethods("base").includes("xmoney"), false);
  assert.equal(parameters.getActivePaymentMethods("base_staging").at(-1), "xmoney");
  assert.equal(evidence.riskWindowSecondsByPaymentMethod.base[method], undefined);
  assert.equal(evidence.riskWindowSecondsByPaymentMethod.base_staging[method], "0");
});

test("untagged and non-staging invocations are inert", async () => {
  for (const config of [{ selectedTag: "" }, { selectedTag: "another-lane" }, { network: "base" }]) {
    const h = harness(config);
    await h.run();
    assert.deepEqual(h.calls, []);
  }
});

test("missing or conflicting mode rejects before RPC", async () => {
  for (const mode of ["none", "both"]) {
    const h = harness({ mode });
    await assert.rejects(h.run(), /Set exactly one/);
    assert.deepEqual(h.calls, []);
  }
});

test("prepare simulates the exact two writes without sending or recording state", async () => {
  const h = harness({ mode: "prepare" });
  await h.run();
  assert.deepEqual(h.actions(), [
    ["simulate-verifier", method],
    ["simulate-registry", method, h.contracts.UnifiedPaymentVerifierV3.address, [hash("USD")]],
  ]);
});

test("activation preserves existing methods and passes ordinary lane-31 readiness", async () => {
  const h = harness();
  const before = [...h.registryMethods];
  await assert.rejects(h.ready(), /payment methods do not match the active method set/);
  await h.run();
  assert.deepEqual(h.registryMethods, [...before, method]);
  assert.deepEqual(h.verifierMethods, [...before, method]);
  assert.deepEqual(h.actions().slice(2), [
    "verifier-write", "registry-write",
    ["snapshot", "base_staging", "xmoney", XMONEY_PROVIDER_CONFIG],
  ]);
  assert.equal(await h.ready(), true);
});

test("verifier-only activation resumes; an active binding sends no transactions", async () => {
  const partial = harness({ verifierHas: true });
  await partial.run();
  assert.deepEqual(partial.actions().map((call) => Array.isArray(call) ? call[0] : call),
    ["simulate-registry", "registry-write", "snapshot"]);
  const active = harness({ verifierHas: true, registryHas: true });
  await active.run();
  assert.deepEqual(active.actions(), [["snapshot", "base_staging", "xmoney", XMONEY_PROVIDER_CONFIG]]);
});

test("registry-before-verifier is rejected before simulation or writes", async () => {
  const h = harness({ registryHas: true });
  await assert.rejects(h.run(), /payment binding is not ready/);
  assert.deepEqual(h.actions(), []);
});

test("chain, signer, owner, bytecode, replay and catalog drift reject before work", async () => {
  const mutations = [
    (h) => { h.provider.getNetwork = async () => ({ chainId: 1 }); },
    (h) => { h.hre.getUnnamedAccounts = async () => [ethers.constants.AddressZero]; },
    (h) => { h.contracts.PaymentVerifierRegistry.owner = async () => ethers.constants.AddressZero; },
    (h) => { h.provider.getCode = async () => "0x6001"; },
    (h) => { h.contracts.NullifierRegistry.getWriters = async () => [ethers.constants.AddressZero]; },
    (h) => { h.contracts.NullifierRegistryV2.getWriters = async () => []; },
    (h) => { h.contracts.UnifiedPaymentVerifierV3.nullifierRegistry = async () => ethers.constants.AddressZero; },
    (h) => { h.registryMethods.reverse(); },
    (h) => { h.verifierMethods.pop(); },
    (h) => { h.registryMethods.push(hash("unapproved")); },
    (h) => { h.contracts.PaymentVerifierRegistry.getCurrencies = async () => [hash("EUR")]; },
    (h) => { h.contracts.PaymentVerifierRegistry.getVerifier = async () => ethers.constants.AddressZero; },
  ];
  for (const mutate of mutations) {
    const h = harness();
    mutate(h);
    await assert.rejects(h.run());
    assert.deepEqual(h.actions(), []);
  }
});

test("simulation or transaction failure cannot record an active snapshot", async () => {
  const simulation = harness();
  simulation.contracts.PaymentVerifierRegistry.callStatic.addPaymentMethod = async () => {
    throw new Error("simulation failed");
  };
  await assert.rejects(simulation.run(), /simulation failed/);
  assert.deepEqual(simulation.actions(), [["simulate-verifier", method]]);
  const transaction = harness({ failRegistry: true });
  await assert.rejects(transaction.run(), /registry transaction failed/);
  assert.equal(transaction.actions().some((call) => Array.isArray(call) && call[0] === "snapshot"), false);
});

test("post-write drift cannot record an active snapshot", async () => {
  const h = harness();
  const getVerifier = h.contracts.PaymentVerifierRegistry.getVerifier;
  h.contracts.PaymentVerifierRegistry.getVerifier = async (value) =>
    value === method ? ethers.constants.AddressZero : getVerifier(value);
  await assert.rejects(h.run(), /activation verification failed/);
  assert.equal(h.actions().some((call) => Array.isArray(call) && call[0] === "snapshot"), false);
});
