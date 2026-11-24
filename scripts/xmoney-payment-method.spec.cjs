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
  const liveLane = loadLane("../deployments/activeDeploymentLanes/31_deploy_v3_payment_binding_stack.ts", {
    "node:assert/strict": assert,
    hardhat: dependencies.hardhat,
    "../../deploy/31_deploy_v3_payment_binding_stack": binding,
    "../../deploy/47_deploy_unified_payment_verifier_v4": { upv4RoutesActive: async () => false },
    "../../deploy/49_deploy_unified_payment_verifier_v5_stack": { upv5RoutesActive: async () => false },
    "../parameters": parameters,
  }, env).default;
  return {
    runLive: () => liveLane(hre), skipLive: () => liveLane.skip(hre),
    calls, contracts, provider, hre, registryMethods, verifierMethods, binding, ethers: dependencies.hardhat.ethers,
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
    "../../deploy/47_deploy_unified_payment_verifier_v4": { upv4RoutesActive: async () => false },
    "../../deploy/49_deploy_unified_payment_verifier_v5_stack": { upv5RoutesActive: async () => false },
    "../parameters": parameters,
  }, {}).default;
  const hre = { deployments: { getNetworkName: () => "localhost" } };
  assert.equal(await lane.skip(hre), false);
  await lane(hre);
  assert.deepEqual(calls, [["skip", hre], ["deploy", hre]]);
  assert.deepEqual(lane.tags, historical.tags);
});

test("the lane 31 wrapper defers to active UPV4 and preserves frozen live checks", async () => {
  const writerMessage = "NullifierRegistryV2 writers must contain only UnifiedPaymentVerifierV3";
  for (const network of ["localhost", "base", "base_staging"]) {
    const h = network === "localhost" ? null : harness({ network, registryHas: true, verifierHas: true });
    const hre = h?.hre ?? { deployments: {
      getNetworkName: () => network,
      get: async () => assert.fail("local deferral must not read deployment records"),
    } };
    const upv4 = parameters.UPV4_BASE_RELEASE.unifiedPaymentVerifierV4;
    const abi = ["function owner() view returns (address)"];
    const iface = new ethers.utils.Interface(abi);
    let liveReads = 0;
    if (h) {
      const get = hre.deployments.get;
      hre.deployments.get = async (name) => name === "UnifiedPaymentVerifierV4" ? { address: upv4, abi } : get(name);
      h.contracts.UnifiedPaymentVerifierV4 = { address: upv4, owner: h.contracts.UnifiedPaymentVerifierV3.owner };
      h.contracts.PaymentVerifierRegistry.getVerifier = async () => upv4;
      h.provider._isProvider = true;
      h.provider.call = async (request) => {
        liveReads++;
        assert.equal((await request.to).toLowerCase(), upv4.toLowerCase());
        assert.equal(iface.parseTransaction({ data: await request.data }).name, "owner");
        return iface.encodeFunctionResult("owner", [await h.contracts.UnifiedPaymentVerifierV4.owner()]);
      };
    }
    let drift = false;
    let checks = 0;
    let bindingChecks = 0;
    let bindingReady = async () => { throw new Error(writerMessage); };
    const historical = async () => assert.fail("historical deployment must not run");
    historical.skip = async () => assert.fail("historical skip must not run");
    const lane = loadLane("../deployments/activeDeploymentLanes/31_deploy_v3_payment_binding_stack.ts", {
      "node:assert/strict": assert,
      hardhat: { ethers: h?.ethers ?? {
        ...ethers, getContractAt: async () => assert.fail("local deferral must not read contracts"),
      } },
      "../../deploy/31_deploy_v3_payment_binding_stack": {
        ...h?.binding,
        default: historical,
        assertPaymentBindingReady: async (actual) => {
          assert.ok(h, "local deferral must not run frozen readiness checks");
          assert.equal(actual, hre);
          bindingChecks++;
          return bindingReady();
        },
      },
      "../../deploy/49_deploy_unified_payment_verifier_v5_stack": { upv5RoutesActive: async () => false },
      "../../deploy/47_deploy_unified_payment_verifier_v4": {
        upv4RoutesActive: async (actual) => {
          assert.equal(actual, hre);
          checks++;
          if (drift) throw new Error("UPV4 writer drift");
          return true;
        },
      },
      "../parameters": parameters,
    }, {}).default;
    assert.equal(await lane.skip(hre), true);
    await lane(hre);
    assert.equal(liveReads, h ? 2 : 0);
    assert.equal(bindingChecks, h ? 2 : 0);
    if (h) {
      bindingReady = async () => true;
      assert.equal(await lane.skip(hre), true);
      await lane(hre);
      assert.equal(bindingChecks, 4);
      assert.equal(liveReads, 4);

      bindingReady = async () => false;
      await assert.rejects(lane.skip(hre), { message: "Live payment-binding artifacts are missing" });
      await assert.rejects(lane(hre), { message: "Live payment-binding artifacts are missing" });
      assert.equal(bindingChecks, 6);
      const failures = [
        new Error("Attestation verifier witness configuration mismatch"),
        new Error("Active OrchestratorV3 is paused"),
        new Error(writerMessage + " (unexpected writer)"),
        { message: writerMessage },
      ];
      for (const failure of failures) {
        bindingReady = async () => { throw failure; };
        await assert.rejects(lane.skip(hre), (error) => error === failure);
        await assert.rejects(lane(hre), (error) => error === failure);
      }
      assert.equal(bindingChecks, 6 + failures.length * 2);
      assert.equal(liveReads, 4, "frozen readiness failures must precede UPV4 registry-surface reads");

      bindingReady = async () => true;
      const currencies = h.contracts.PaymentVerifierRegistry.getCurrencies;
      const mutations = [
        ["PaymentVerifierRegistry", "getCurrencies", (method) => method === hash("alipay") ? [hash("USD")] : currencies(method), /Payment currencies mismatch: alipay/],
        ["PaymentVerifierRegistry", "getVerifier", () => parameters.UPV4_BASE_RELEASE.unifiedPaymentVerifierV3, /verifier route mismatch/],
        ["PaymentVerifierRegistry", "owner", () => ethers.constants.AddressZero, /Payment registry owner mismatch/],
        ["NullifierRegistry", "owner", () => ethers.constants.AddressZero, /Legacy nullifier registry owner mismatch/],
        ["NullifierRegistryV2", "owner", () => ethers.constants.AddressZero, /Nullifier registry V2 owner mismatch/],
        ["UnifiedPaymentVerifierV4", "owner", () => ethers.constants.AddressZero, /Payment registry owner mismatch/],
        ["OrchestratorV3", "paymentVerifierRegistry", () => ethers.constants.AddressZero, /target address mismatch/],
        ["PaymentVerifierRegistry", "getPaymentMethods", () => [...h.registryMethods].reverse(), /method order mismatch/],
        ["NullifierRegistry", "getWriters", () => [upv4], /legacy nullifier writers remain/],
      ];
      for (const [name, method, mutate, expected] of mutations) {
        const original = h.contracts[name][method];
        h.contracts[name][method] = async (...args) => mutate(...args);
        await assert.rejects(lane.skip(hre), expected);
        await assert.rejects(lane(hre), expected);
        h.contracts[name][method] = original;
      }
      assert.deepEqual(h.actions(), []);
    }
    const checksBeforeDrift = checks;
    const bindingChecksBeforeDrift = bindingChecks;
    drift = true;
    await assert.rejects(lane.skip(hre), /UPV4 writer drift/);
    await assert.rejects(lane(hre), /UPV4 writer drift/);
    assert.equal(checks, checksBeforeDrift + 2);
    assert.equal(bindingChecks, bindingChecksBeforeDrift);
  }
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


test("the lane 31 wrapper defers to active UPV5 before probing UPV4", async () => {
  const writerMessage = "NullifierRegistryV2 writers must contain only UnifiedPaymentVerifierV3";
  const upv5 = "0x5000000000000000000000000000000000000005";
  for (const network of ["localhost", "base", "base_staging"]) {
    const h = network === "localhost" ? null : harness({ network, registryHas: true, verifierHas: true });
    const hre = h?.hre ?? { deployments: {
      getNetworkName: () => network,
      get: async () => assert.fail("local deferral must not read deployment records"),
    } };
    const abi = ["function owner() view returns (address)"];
    const iface = new ethers.utils.Interface(abi);
    if (h) {
      const get = hre.deployments.get;
      hre.deployments.get = async (name) => name === "UnifiedPaymentVerifierV5" ? { address: upv5, abi } : get(name);
      h.contracts.PaymentVerifierRegistry.getVerifier = async () => upv5;
      h.provider._isProvider = true;
      h.provider.call = async (request) => {
        assert.equal((await request.to).toLowerCase(), upv5.toLowerCase());
        return iface.encodeFunctionResult("owner", [await h.contracts.UnifiedPaymentVerifierV3.owner()]);
      };
    }
    let upv5Checks = 0;
    const historical = async () => assert.fail("historical deployment must not run");
    historical.skip = async () => assert.fail("historical skip must not run");
    const lane = loadLane("../deployments/activeDeploymentLanes/31_deploy_v3_payment_binding_stack.ts", {
      "node:assert/strict": assert,
      hardhat: { ethers: h?.ethers ?? { ...ethers, getContractAt: async () => assert.fail("local deferral must not read contracts") } },
      "../../deploy/31_deploy_v3_payment_binding_stack": {
        ...h?.binding, default: historical,
        assertPaymentBindingReady: async () => { throw new Error(writerMessage); },
      },
      "../../deploy/47_deploy_unified_payment_verifier_v4": {
        upv4RoutesActive: async () => assert.fail("UPV4 probe must not run once UPV5 is routed"),
      },
      "../../deploy/49_deploy_unified_payment_verifier_v5_stack": {
        upv5RoutesActive: async (actual) => { assert.equal(actual, hre); upv5Checks++; return true; },
      },
      "../parameters": parameters,
    }, {}).default;
    assert.equal(await lane.skip(hre), true);
    await lane(hre);
    assert.equal(upv5Checks, 2);
    if (h) {
      h.contracts.PaymentVerifierRegistry.getVerifier = async () => parameters.UPV4_BASE_RELEASE.unifiedPaymentVerifierV4;
      await assert.rejects(lane.skip(hre), /verifier route mismatch/);
      assert.deepEqual(h.actions(), []);
    }
  }
});

const STAGING_PVR = "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc";
const STAGING_UPV4 = "0x7Da43ba0F85cfb64733216C4A2288f80dFfe1EAb";
const STAGING_NRV2 = "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C";
const STAGING_SIGNER = "0x41123d6419C7b8e44157f6F3b0088442116641eC";
const STAGING_UPV5 = "0x5000000000000000000000000000000000000005";
const STAGING_NRV3 = "0x3000000000000000000000000000000000000003";

function activationHarness({ active = "v5", mode = "execute", selectedTag = tag, network = "base_staging",
  registryHas = false, verifierHas = false, failRegistry = false } = {}) {
  const calls = [];
  const env = { DEPLOY_ACTIVE_TAG: selectedTag };
  if (mode === "prepare" || mode === "both") env.PREPARE_STAGING_XMONEY_PAYMENT_METHOD = "true";
  if (mode === "execute" || mode === "both") env.EXECUTE_STAGING_XMONEY_PAYMENT_METHOD = "true";
  const routed = active === "v5" ? STAGING_UPV5 : STAGING_UPV4;
  const existing = ["venmo", "paypal"].map(hash);
  const registryMethods = [...existing, ...(registryHas ? [method] : [])];
  const verifierMethods = [...existing, ...(verifierHas ? [method] : [])];
  const routes = new Map(registryMethods.map((value) => [value, { verifier: routed, currencies: [hash("USD")] }]));
  const records = {
    PaymentVerifierRegistry: { address: STAGING_PVR },
    UnifiedPaymentVerifierV4: { address: STAGING_UPV4 },
    UnifiedPaymentVerifierV5: { address: STAGING_UPV5 },
  };
  const owner = async () => STAGING_SIGNER;
  const verifier = {
    address: routed, owner,
    nullifierRegistry: async () => active === "v5" ? STAGING_NRV3 : STAGING_NRV2,
    isPaymentMethod: async (value) => verifierMethods.includes(value),
    callStatic: { addPaymentMethod: async (...args) => calls.push(["simulate-verifier", ...args]) },
  };
  const contracts = {
    PaymentVerifierRegistry: {
      address: STAGING_PVR, owner,
      getPaymentMethods: async () => [...registryMethods],
      getVerifier: async (value) => routes.get(value)?.verifier ?? ethers.constants.AddressZero,
      getCurrencies: async (value) => routes.get(value)?.currencies ?? [],
      isPaymentMethod: async (value) => routes.has(value),
      callStatic: { addPaymentMethod: async (...args) => calls.push(["simulate-registry", ...args]) },
    },
    [active === "v5" ? "UnifiedPaymentVerifierV5" : "UnifiedPaymentVerifierV4"]: verifier,
    NullifierRegistryV2: { address: STAGING_NRV2, getWriters: async () => active === "v5" ? [] : [STAGING_UPV4] },
    NullifierRegistryV3: { address: STAGING_NRV3, getWriters: async () => [STAGING_UPV5] },
  };
  const provider = { getNetwork: async () => { calls.push("read"); return { chainId: 8453 }; } };
  const hre = {
    deployments: {
      getNetworkName: () => network,
      get: async (name) => { assert.ok(records[name], `missing ${name}`); return records[name]; },
      getOrNull: async (name) => records[name] ?? null,
    },
    ethers: {
      provider,
      getContractAt: async (name, address) => {
        assert.ok(contracts[name], `unexpected contract ${name}`);
        assert.equal(address.toLowerCase(), contracts[name].address.toLowerCase());
        return contracts[name];
      },
    },
    getUnnamedAccounts: async () => [STAGING_SIGNER],
  };
  const helpers = {
    addPaymentMethodToUnifiedVerifier: async (_hre, contract, value) => {
      assert.equal(contract, verifier);
      if (!verifierMethods.includes(value)) {
        calls.push("verifier-write");
        verifierMethods.push(value);
      }
    },
    addPaymentMethodToRegistry: async (_hre, contract, value, verifierAddress, currencies) => {
      assert.equal(contract, contracts.PaymentVerifierRegistry);
      assert.equal(verifierAddress, routed);
      if (!routes.has(value)) {
        calls.push("registry-write");
        if (failRegistry) throw new Error("registry transaction failed");
        routes.set(value, { verifier: verifierAddress, currencies });
        registryMethods.push(value);
      }
    },
    savePaymentMethodSnapshot: (...args) => calls.push(["snapshot", ...args]),
  };
  const activation = loadLane("../deployments/paymentMethodActivation.ts", { "./helpers": helpers }, env);
  const lane = loadLane("43_add_xmoney_payment_method.ts", {
    "module-alias/register": {},
    "../deployments/paymentMethodActivation": activation,
    "../deployments/verifiers/xmoney": { XMONEY_PROVIDER_CONFIG },
  }, env).default;
  return {
    run: () => lane(hre), skip: () => lane.skip(hre), activation, calls, contracts, verifier, records, routes,
    provider, hre, registryMethods, verifierMethods, actions: () => calls.filter((call) => call !== "read"),
  };
}

test("untagged and non-staging invocations are inert", async () => {
  for (const config of [{ selectedTag: "" }, { selectedTag: "another-lane" }, { network: "base" }]) {
    const h = activationHarness(config);
    assert.equal(await h.skip(), true);
    await h.run();
    assert.deepEqual(h.calls, []);
  }
});

test("missing or conflicting mode rejects before RPC", async () => {
  for (const mode of ["none", "both"]) {
    const h = activationHarness({ mode });
    await assert.rejects(h.run(), /Set exactly one/);
    assert.deepEqual(h.calls, []);
  }
});

test("the active verifier is the one every route uses: UPV5 after its cutover, UPV4 before", async () => {
  const after = activationHarness({ active: "v5" });
  assert.deepEqual({ ...await after.activation.resolveActivePaymentVerifier(after.hre) }, {
    name: "UnifiedPaymentVerifierV5", address: STAGING_UPV5, nullifierRegistryName: "NullifierRegistryV3",
  });
  // A recorded but not yet routed UPV5 must not receive new methods: V3 would not let it write.
  const before = activationHarness({ active: "v4" });
  assert.ok(before.records.UnifiedPaymentVerifierV5);
  assert.deepEqual({ ...await before.activation.resolveActivePaymentVerifier(before.hre) }, {
    name: "UnifiedPaymentVerifierV4", address: STAGING_UPV4, nullifierRegistryName: "NullifierRegistryV2",
  });
  delete before.records.UnifiedPaymentVerifierV5;
  assert.equal((await before.activation.resolveActivePaymentVerifier(before.hre)).address, STAGING_UPV4);
  const mixed = activationHarness();
  mixed.routes.get(hash("venmo")).verifier = STAGING_UPV4;
  await assert.rejects(mixed.activation.resolveActivePaymentVerifier(mixed.hre), /routes to several verifiers/);
  const unknown = activationHarness();
  delete unknown.records.UnifiedPaymentVerifierV5;
  await assert.rejects(unknown.activation.resolveActivePaymentVerifier(unknown.hre), /neither the recorded UPV5 nor UPV4/);
});

test("prepare simulates exactly the two writes on the active verifier without sending", async () => {
  for (const active of ["v4", "v5"]) {
    const h = activationHarness({ active, mode: "prepare" });
    await h.run();
    assert.deepEqual(h.actions(), [
      ["simulate-verifier", method],
      ["simulate-registry", method, h.verifier.address, [hash("USD")]],
    ]);
  }
});

test("execution adds the method to the active verifier, then routes it there", async () => {
  for (const active of ["v4", "v5"]) {
    const h = activationHarness({ active });
    await h.run();
    assert.deepEqual(h.actions().slice(2), [
      "verifier-write", "registry-write", ["snapshot", "base_staging", "xmoney", XMONEY_PROVIDER_CONFIG],
    ]);
    assert.deepEqual(h.routes.get(method), { verifier: h.verifier.address, currencies: [hash("USD")] });
    assert.deepEqual(h.registryMethods.slice(0, 2), ["venmo", "paypal"].map(hash));
  }
});

test("verifier-only activation resumes; an active binding sends no transactions", async () => {
  const partial = activationHarness({ verifierHas: true });
  await partial.run();
  assert.deepEqual(partial.actions().map((call) => Array.isArray(call) ? call[0] : call),
    ["simulate-registry", "registry-write", "snapshot"]);
  const active = activationHarness({ verifierHas: true, registryHas: true });
  await active.run();
  assert.deepEqual(active.actions(), [["snapshot", "base_staging", "xmoney", XMONEY_PROVIDER_CONFIG]]);
});

test("registry-before-verifier is rejected before simulation or writes", async () => {
  const h = activationHarness({ registryHas: true });
  await assert.rejects(h.run(), /contains X Money before UnifiedPaymentVerifierV5/);
  assert.deepEqual(h.actions(), []);
});

test("chain, signer, owner, writer and route drift reject before work", async () => {
  const mutations = [
    [(h) => { h.provider.getNetwork = async () => ({ chainId: 1 }); }, /chain ID 1/],
    [(h) => { h.hre.getUnnamedAccounts = async () => [ethers.constants.AddressZero]; }, /signer or contract owner mismatch/],
    [(h) => { h.contracts.PaymentVerifierRegistry.owner = async () => ethers.constants.AddressZero; }, /signer or contract owner mismatch/],
    [(h) => { h.verifier.owner = async () => ethers.constants.AddressZero; }, /signer or contract owner mismatch/],
    [(h) => { h.contracts.NullifierRegistryV3.getWriters = async () => []; }, /nullifier writer invariant failed/],
    [(h) => { h.routes.get(hash("paypal")).verifier = STAGING_UPV4; }, /routes to several verifiers/],
    [(h) => { h.hre.deployments.getOrNull = async () => null; }, /neither the recorded UPV5 nor UPV4/],
  ];
  for (const [mutate, expected] of mutations) {
    const h = activationHarness();
    mutate(h);
    await assert.rejects(h.run(), expected);
    assert.deepEqual(h.actions(), []);
  }
  const elsewhere = activationHarness({ registryHas: true, verifierHas: true });
  elsewhere.contracts.PaymentVerifierRegistry.getCurrencies = async (value) => value === method ? [hash("EUR")] : [hash("USD")];
  await assert.rejects(elsewhere.run(), /registry routes it to .* with \[/);
  assert.deepEqual(elsewhere.actions(), []);
});

test("simulation or transaction failure cannot record an active snapshot", async () => {
  const simulation = activationHarness();
  simulation.contracts.PaymentVerifierRegistry.callStatic.addPaymentMethod = async () => {
    throw new Error("simulation failed");
  };
  await assert.rejects(simulation.run(), /simulation failed/);
  assert.deepEqual(simulation.actions(), [["simulate-verifier", method]]);
  const transaction = activationHarness({ failRegistry: true });
  await assert.rejects(transaction.run(), /registry transaction failed/);
  assert.equal(transaction.actions().some((call) => Array.isArray(call) && call[0] === "snapshot"), false);
});

test("post-write drift cannot record an active snapshot", async () => {
  const h = activationHarness();
  const getVerifier = h.contracts.PaymentVerifierRegistry.getVerifier;
  let writes = 0;
  h.contracts.PaymentVerifierRegistry.getVerifier = async (value) => {
    if (value === method && h.registryMethods.includes(method)) writes++;
    return value === method && writes > 0 ? ethers.constants.AddressZero : getVerifier(value);
  };
  await assert.rejects(h.run(), /activation verification failed/);
  assert.equal(h.actions().some((call) => Array.isArray(call) && call[0] === "snapshot"), false);
});
