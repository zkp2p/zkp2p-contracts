const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");
const { ethers } = require("ethers");

require("ts-node/register/transpile-only");
const { XMONEY_PROVIDER_CONFIG } = require("../deployments/verifiers/xmoney");

const hash = (name) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
const addresses = {
  governance: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
  NullifierRegistry: "0x3FFd04f7909a16d3476263A1f4ce413A089dCc69",
  NullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
  PaymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
  UnifiedPaymentVerifierV3: "0x4c62E99649c8Ba745E67018f5c8a483D77c429C4",
};
const tag = "43_add_xmoney_payment_method";
const source = readFileSync(require.resolve("../deploy/43_add_xmoney_payment_method.ts"), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function harness({ mode = "execute", selectedTag = tag, network = "base_staging",
  chainId = 8453, registryHas = false, verifierHas = false, owner = addresses.governance,
  failRegistry = false, missingCode = false } = {}) {
  const calls = [];
  const env = { DEPLOY_ACTIVE_TAG: selectedTag };
  if (mode === "prepare" || mode === "both") env.PREPARE_STAGING_XMONEY_PAYMENT_METHOD = "true";
  if (mode === "execute" || mode === "both") env.EXECUTE_STAGING_XMONEY_PAYMENT_METHOD = "true";
  const registryMethods = [hash("venmo"), ...(registryHas ? [hash("xmoney")] : [])];
  const verifierMethods = [hash("venmo"), ...(verifierHas ? [hash("xmoney")] : [])];
  const contracts = Object.fromEntries(Object.entries(addresses).map(([name, address]) => [name, {
    address,
    owner: async () => owner,
    interface: { encodeFunctionData: (method, args) => JSON.stringify({ method, args }) },
  }]));
  Object.assign(contracts.PaymentVerifierRegistry, {
    getPaymentMethods: async () => registryMethods,
    getVerifier: async () => addresses.UnifiedPaymentVerifierV3,
    getCurrencies: async () => [hash("USD")],
  });
  Object.assign(contracts.UnifiedPaymentVerifierV3, {
    getPaymentMethods: async () => verifierMethods,
    nullifierRegistry: async () => addresses.NullifierRegistryV2,
  });
  Object.assign(contracts.NullifierRegistryV2, {
    getWriters: async () => [addresses.UnifiedPaymentVerifierV3],
    legacyNullifierRegistry: async () => addresses.NullifierRegistry,
  });
  contracts.NullifierRegistry.getWriters = async () => [];
  const hre = {
    deployments: {
      getNetworkName: () => network,
      get: async (name) => ({ address: addresses[name] }),
    },
    getUnnamedAccounts: async () => [addresses.governance],
  };
  const dependencies = {
    "module-alias/register": {},
    hardhat: { ethers: {
      provider: {
        getNetwork: async () => { calls.push("read"); return { chainId }; },
        getCode: async () => missingCode ? "0x" : "0x1234",
        call: async (request) => { calls.push(["simulate", request]); return "0x"; },
      },
      getContractAt: async (name) => contracts[name],
    } },
    "../deployments/helpers": {
      addPaymentMethodToUnifiedVerifier: async () => {
        if (!verifierMethods.includes(hash("xmoney"))) {
          calls.push("verifier-write");
          verifierMethods.push(hash("xmoney"));
        }
      },
      addPaymentMethodToRegistry: async () => {
        calls.push("registry-write");
        if (failRegistry) throw new Error("registry transaction failed");
        registryMethods.push(hash("xmoney"));
      },
      savePaymentMethodSnapshot: (...args) => calls.push(["snapshot", ...args]),
    },
    "../deployments/verifiers/xmoney": { XMONEY_PROVIDER_CONFIG },
    "./31_deploy_v3_payment_binding_stack": {
      RATIFIED_PAYMENT_METHOD_ORDER: { base_staging: ["venmo"] },
      RATIFIED_PAYMENT_METHOD_CURRENCIES: { venmo: ["USD"] },
    },
    "../utils/protocolUtils": { calculatePaymentMethodHash: hash },
  };
  const loaded = { exports: {} };
  Function("require", "exports", "process", outputText)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), "Unexpected dependency: " + name);
    return dependencies[name];
  }, loaded.exports, { env });
  return { run: () => loaded.exports.default(hre), calls, env };
}

test("uses the canonical X Money hash and USD currency", () => {
  assert.equal(XMONEY_PROVIDER_CONFIG.paymentMethodHash, hash("xmoney"));
  assert.deepEqual(XMONEY_PROVIDER_CONFIG.currencies, [hash("USD")]);
});

test("untagged and other-network invocations do not read or write", async () => {
  for (const config of [{ selectedTag: "" }, { selectedTag: "another-lane" }, { network: "base" }]) {
    const h = harness(config);
    await h.run();
    assert.deepEqual(h.calls, []);
  }
});

test("missing or conflicting mode rejects before any RPC", async () => {
  for (const mode of ["none", "both"]) {
    const h = harness({ mode });
    await assert.rejects(h.run());
    assert.deepEqual(h.calls, []);
  }
});

test("prepare simulates exact writes without sending or recording state", async () => {
  const h = harness({ mode: "prepare" });
  await h.run();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0], "read");
  const requests = h.calls.slice(1).map(([, request]) => request);
  assert.deepEqual(requests.map((request) => request.to), [
    addresses.UnifiedPaymentVerifierV3, addresses.PaymentVerifierRegistry,
  ]);
  assert.deepEqual(JSON.parse(requests[1].data).args, [
    hash("xmoney"), addresses.UnifiedPaymentVerifierV3, [hash("USD")],
  ]);
});

test("execute writes verifier before registry and only then saves the snapshot", async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.calls.slice(3), [
    "verifier-write", "registry-write",
    ["snapshot", "base_staging", "xmoney", XMONEY_PROVIDER_CONFIG],
  ]);
});

test("verifier-only state resumes the remaining registry write", async () => {
  const h = harness({ verifierHas: true });
  await h.run();
  assert.deepEqual(h.calls.filter((call) => typeof call === "string"), ["read", "registry-write"]);
  assert.equal(h.calls.filter((call) => call[0] === "simulate").length, 1);
});

test("registry-only state is rejected without writes", async () => {
  const h = harness({ registryHas: true });
  await assert.rejects(h.run(), /no verifier method/);
  assert.deepEqual(h.calls, ["read"]);
});

test("an active binding is checked without resending transactions", async () => {
  const h = harness({ registryHas: true, verifierHas: true });
  await h.run();
  assert.deepEqual(h.calls, ["read", ["snapshot", "base_staging", "xmoney", XMONEY_PROVIDER_CONFIG]]);
});

test("wrong chain, owner, or missing bytecode rejects before writes", async () => {
  for (const config of [{ chainId: 1 }, { owner: ethers.constants.AddressZero }, { missingCode: true }]) {
    const h = harness(config);
    await assert.rejects(h.run());
    assert.deepEqual(h.calls, ["read"]);
  }
});

test("a failed registry transaction cannot record an active deployment", async () => {
  const h = harness({ failRegistry: true });
  await assert.rejects(h.run(), /registry transaction failed/);
  assert.equal(h.calls.some((call) => call[0] === "snapshot"), false);
});
