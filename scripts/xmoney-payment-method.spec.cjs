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
    `({ binding: exports, pinned: EXISTING_PAYMENT_BINDING.${network} })`);
  const names = network === "base" ? parameters.getActivePaymentMethods(network) : binding.RATIFIED_PAYMENT_METHOD_ORDER[network];
  const registryMethods = names.filter((name) => name !== "xmoney" || registryHas).map(hash);
  const verifierMethods = names.filter((name) => name !== "xmoney" || verifierHas).map(hash);
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
  const liveLane = loadLane("../deployments/activeDeploymentLanes/31_deploy_v3_payment_binding_stack.ts", {
    "node:assert/strict": assert,
    hardhat: dependencies.hardhat,
    "../../deploy/31_deploy_v3_payment_binding_stack": binding,
    "../parameters": parameters,
  }, env).default;
  return {
    run: () => lane(hre), ready: () => binding.paymentBindingCutoverReady(hre),
    runLive: () => liveLane(hre), skipLive: () => liveLane.skip(hre),
    calls, contracts, provider, hre, registryMethods, verifierMethods,
    actions: () => calls.filter((call) => call !== "read"),
  };
}

test("X Money is active on Base and staging with USD and a zero risk window", () => {
  assert.deepEqual(XMONEY_PROVIDER_CONFIG, { paymentMethodHash: method, currencies: [hash("USD")] });
  for (const network of ["base", "base_staging"]) {
    assert.equal(parameters.getActivePaymentMethods(network).includes("xmoney"), true);
    assert.equal(evidence.riskWindowSecondsByPaymentMethod[network][method], "0");
  }
  assert.equal(parameters.getActivePaymentMethods("hardhat").includes("xmoney"), false);
});

test("the mounted live lane verifies Base and staging without invoking the historical cutover", async () => {
  for (const network of ["base", "base_staging"]) {
    const h = harness({ network, registryHas: true, verifierHas: true });
    assert.equal(await h.skipLive(), true);
    await h.runLive();
    assert.deepEqual(h.actions(), []);
  }
});

test("the mounted live lane rejects missing artifacts and registry drift without writes", async () => {
  const mutations = [
    [(h) => { h.hre.deployments.getOrNull = async () => null; }, /artifacts are missing/],
    [(h) => { h.contracts.PaymentVerifierRegistry.owner = async () => ethers.constants.AddressZero; }, /Payment registry owner mismatch/],
    [(h) => { h.contracts.NullifierRegistry.owner = async () => ethers.constants.AddressZero; }, /Legacy nullifier registry owner mismatch/],
    [(h) => { h.contracts.PaymentVerifierRegistry.getPaymentMethods = async () => [...h.registryMethods].reverse(); }, /method order mismatch/],
    [(h) => { h.contracts.PaymentVerifierRegistry.getCurrencies = async () => [hash("EUR")]; }, /currencies mismatch/],
    [(h) => { h.contracts.PaymentVerifierRegistry.getVerifier = async () => ethers.constants.AddressZero; }, /verifier route mismatch/],
    [(h) => { h.contracts.NullifierRegistry.getWriters = async () => [ethers.constants.AddressZero]; }, /legacy nullifier writers remain/],
  ];
  for (const [mutate, expected] of mutations) {
    const h = harness({ network: "base", registryHas: true, verifierHas: true });
    mutate(h);
    await assert.rejects(h.skipLive(), expected);
    await assert.rejects(h.runLive(), expected);
    assert.deepEqual(h.actions(), []);
  }
});

test("the mounted lane preserves local deployment and skip behavior", async () => {
  const calls = [];
  const historical = async (hre) => calls.push(["deploy", hre]);
  historical.skip = async (hre) => { calls.push(["skip", hre]); return false; };
  historical.tags = ["31_deploy_v3_payment_binding_stack", "V3PaymentBindingStack"];
  const lane = loadLane("../deployments/activeDeploymentLanes/31_deploy_v3_payment_binding_stack.ts", {
    "node:assert/strict": assert,
    hardhat: { ethers },
    "../../deploy/31_deploy_v3_payment_binding_stack": { default: historical },
    "../parameters": parameters,
  }, {}).default;
  const hre = { deployments: { getNetworkName: () => "localhost" } };
  assert.equal(await lane.skip(hre), false);
  await lane(hre);
  assert.deepEqual(calls, [["skip", hre], ["deploy", hre]]);
  assert.deepEqual(lane.tags, historical.tags);
});

test("lane 31 source is pinned and the runner selects the live wrapper", () => {
  const { assertImmutableDeploymentLanes, selectActiveDeploymentScripts } = require("../deployments/immutableDeploymentLanes");
  const root = require("node:path").resolve(__dirname, "..");
  const filename = "31_deploy_v3_payment_binding_stack.ts";
  assertImmutableDeploymentLanes(root);
  assert.deepEqual(selectActiveDeploymentScripts(root, [filename]), [{
    filename, sourcePath: `${root}/deployments/activeDeploymentLanes/${filename}`,
  }]);
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
