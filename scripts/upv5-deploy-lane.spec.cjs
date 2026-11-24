#!/usr/bin/env node
process.env.DEPLOY_TX_DELAY_MS = "0";
require(require.resolve("ts-node/register/transpile-only"));
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { Signer, constants, utils } = require("ethers");
const { MULTI_SIG, UPV4_BASE_RELEASE, UPV5_BASE_RELEASE, UPV5_BASE_STAGING_RELEASE } = require("../deployments/parameters.ts");
const {
  Upv5Function: Fn, Upv5Network, Upv5Target: Target, buildUpv5CutoverCalls, encodeUpv5Call, pendingUpv5Calls,
  upv5CallApplied, upv5ReleasePins,
} = require("../deployments/upv5Cutover.ts");

const ROOT = resolve(__dirname, "..");
const SIGNER = "0x41123d6419C7b8e44157f6F3b0088442116641eC";
const RETIRED = "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929";
const SAFE = "0x0bC26FF515411396DD588Abd6Ef6846E04470227";
const DEPLOYED = {
  nullifierRegistryV3: "0x3000000000000000000000000000000000000003",
  unifiedPaymentVerifierV5: "0x5000000000000000000000000000000000000005",
  disputeVerifierV2: "0x2000000000000000000000000000000000000002",
};
const ODD_WRITER = "0x000000000000000000000000000000000000dEaD";
const lower = (value) => value.toLowerCase();

test("pins both networks' predecessors and governance exactly", () => {
  assert.deepEqual(UPV5_BASE_RELEASE, {
    pinnedBlock: 61639236, chainId: 8453, deployer: SIGNER, governance: SAFE,
    orchestratorRegistry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
    multiAttestationVerifier: "0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5",
    paymentVerifierRegistry: "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e",
    nullifierRegistryV2: "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB",
    unifiedPaymentVerifierV4: "0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048",
    retiredNullifierWriters: ["0xC6F4a193576C60892a47e111Bb5706c30162502B", "0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048"],
    disputeProtectionPolicyV2: "0xB49Fa38C6Bb3C8C51ddb13711BB213cDD9DB1799",
    disputeVerifier: "0x30d4947f005653637005eed991005119D9eB2f34",
    disputeAttestationVerifier: "0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5",
  });
  assert.deepEqual(UPV5_BASE_STAGING_RELEASE, {
    pinnedBlock: 61639236, chainId: 8453, deployer: SIGNER, governance: SIGNER,
    orchestratorRegistry: "0xfA6384EB6176cfEC049540526A3d2126C3666d8A",
    multiAttestationVerifier: "0x9855a39aC5975069632e91160d8712CBfF19e864",
    paymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
    nullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
    unifiedPaymentVerifierV4: "0x7Da43ba0F85cfb64733216C4A2288f80dFfe1EAb",
    disputeProtectionPolicyV2: "0x0d5a9162161d195577A3a3458524574bb462ccDc",
    disputeVerifier: "0x973578148c5Fd49b9f68B50B26066555325AC708",
    disputeAttestationVerifier: "0x9855a39aC5975069632e91160d8712CBfF19e864",
  });
  assert.equal(UPV5_BASE_RELEASE.governance, MULTI_SIG.base);
  assert.equal(UPV5_BASE_RELEASE.unifiedPaymentVerifierV4, UPV4_BASE_RELEASE.unifiedPaymentVerifierV4);
  assert.equal(UPV5_BASE_RELEASE.retiredNullifierWriters[0], UPV4_BASE_RELEASE.unifiedPaymentVerifierV3);
  for (const network of ["base", "base_staging"]) {
    const record = (name) => JSON.parse(readFileSync(resolve(ROOT, "deployments", network, `${name}.json`), "utf8")).address;
    const pins = upv5ReleasePins(network);
    for (const [field, name] of [["orchestratorRegistry", "OrchestratorRegistry"], ["multiAttestationVerifier", "MultiAttestationVerifier"],
      ["paymentVerifierRegistry", "PaymentVerifierRegistry"], ["nullifierRegistryV2", "NullifierRegistryV2"],
      ["unifiedPaymentVerifierV4", "UnifiedPaymentVerifierV4"], ["disputeProtectionPolicyV2", "DisputeProtectionPolicyV2"],
      ["disputeVerifier", "DisputeVerifier"]]) {
      assert.equal(record(name), pins[field], `${network} ${name}`);
    }
  }
});

test("UPV5 lane sources never reference the retired deployer or its key", () => {
  for (const file of ["deploy/49_deploy_unified_payment_verifier_v5_stack.ts", "deployments/upv5Cutover.ts"]) {
    assert.doesNotMatch(readFileSync(resolve(ROOT, file), "utf8"), /0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929|BASE_DEPLOY_PRIVATE_KEY/i, file);
  }
});

function stagingInput(overrides = {}) {
  const pins = upv5ReleasePins(Upv5Network.BaseStaging);
  return {
    chainId: 8453, paymentVerifierRegistry: pins.paymentVerifierRegistry, nullifierRegistryV2: pins.nullifierRegistryV2,
    disputeProtectionPolicyV2: pins.disputeProtectionPolicyV2, deployed: DEPLOYED,
    retiredWriters: [pins.unifiedPaymentVerifierV4, ODD_WRITER],
    routes: [
      { method: utils.id("venmo"), currencies: [utils.id("USD")] },
      { method: utils.id("wise"), currencies: ["EUR", "USD", "GBP"].map(utils.id) },
      { method: utils.id("mercury"), currencies: [utils.id("USD")] },
    ],
    ...overrides,
  };
}

test("cutover order: every retired writer, V3 grant, tail removals, ordered re-adds, dispute switch", () => {
  const input = stagingInput();
  const calls = buildUpv5CutoverCalls(input);
  assert.deepEqual(calls.map((call) => [call.target, call.signature, call.args]), [
    [Target.NullifierRegistryV2, Fn.RemoveWriter, [input.retiredWriters[0]]],
    [Target.NullifierRegistryV2, Fn.RemoveWriter, [ODD_WRITER]],
    [Target.NullifierRegistryV3, Fn.AddWriter, [DEPLOYED.unifiedPaymentVerifierV5]],
    [Target.PaymentVerifierRegistry, Fn.RemoveMethod, [lower(utils.id("mercury"))]],
    [Target.PaymentVerifierRegistry, Fn.RemoveMethod, [lower(utils.id("wise"))]],
    [Target.PaymentVerifierRegistry, Fn.RemoveMethod, [lower(utils.id("venmo"))]],
    [Target.PaymentVerifierRegistry, Fn.AddMethod, [lower(utils.id("venmo")), DEPLOYED.unifiedPaymentVerifierV5, [lower(utils.id("USD"))]]],
    [Target.PaymentVerifierRegistry, Fn.AddMethod, [lower(utils.id("wise")), DEPLOYED.unifiedPaymentVerifierV5, ["EUR", "USD", "GBP"].map((value) => lower(utils.id(value)))]],
    [Target.PaymentVerifierRegistry, Fn.AddMethod, [lower(utils.id("mercury")), DEPLOYED.unifiedPaymentVerifierV5, [lower(utils.id("USD"))]]],
    [Target.DisputeProtectionPolicyV2, Fn.SetDisputeVerifier, [DEPLOYED.disputeVerifierV2]],
  ]);
  assert.equal(calls.some((call) => call.to === DEPLOYED.disputeVerifierV2), false, "DisputeVerifierV2 needs no cutover call");
  assert.equal(encodeUpv5Call(calls[0]).data.slice(0, 10), utils.id("removeWritePermission(address)").slice(0, 10));
  assert.equal(buildUpv5CutoverCalls(stagingInput({ retiredWriters: [] }))[0].signature, Fn.AddWriter);
});

test("call simulation uses a raw eth_call so custom-error reverts reject", async () => {
  const { simulateUpv5Call } = require("../deployments/upv5Cutover.ts");
  const requests = [];
  const provider = { send: async (method, params) => { requests.push([method, params]); return "0x"; } };
  await simulateUpv5Call(provider, SIGNER, { to: DEPLOYED.nullifierRegistryV3, data: "0x1234" }, 255);
  assert.deepEqual(requests, [["eth_call", [{ from: SIGNER, to: DEPLOYED.nullifierRegistryV3, data: "0x1234" }, "0xff"]]]);
  provider.send = async () => { throw new Error("execution reverted: custom error 0x2aff9f6a"); };
  await assert.rejects(simulateUpv5Call(provider, SIGNER, { to: DEPLOYED.nullifierRegistryV3, data: "0x1234" }, 255), /custom error/);
});

test("cutover builder rejects zero, duplicate and conflicting inputs", () => {
  const cases = [
    [{ retiredWriters: [constants.AddressZero] }, /retiredWriters\[0\]: invalid or zero address/],
    [{ retiredWriters: [ODD_WRITER, ODD_WRITER.toLowerCase()] }, /retiredWriters: duplicate address/],
    [{ retiredWriters: [DEPLOYED.unifiedPaymentVerifierV5] }, /retiredWriters: conflicts/],
    [{ routes: [] }, /routes: empty/],
    [{ routes: [{ method: constants.HashZero, currencies: [utils.id("USD")] }] }, /routes: invalid or zero hash/],
    [{ routes: [{ method: utils.id("venmo"), currencies: [] }] }, /currencies: empty/],
    [{ routes: [{ method: utils.id("venmo"), currencies: [utils.id("USD")], label: "paypal" }] }, /label: hash mismatch/],
    [{ deployed: { ...DEPLOYED, disputeVerifierV2: DEPLOYED.nullifierRegistryV3 } }, /duplicate address/],
    [{ deployed: { ...DEPLOYED, unifiedPaymentVerifierV5: "0x12" } }, /unifiedPaymentVerifierV5: invalid/],
    [{ chainId: 0 }, /chainId: invalid/],
  ];
  for (const [overrides, error] of cases) assert.throws(() => buildUpv5CutoverCalls(stagingInput(overrides)), error);
});

function routingState(input, overrides = {}) {
  return {
    unifiedPaymentVerifierV5: DEPLOYED.unifiedPaymentVerifierV5,
    nullifierRegistryV2Writers: [...input.retiredWriters], nullifierRegistryV3Writers: [],
    routes: input.routes.map((route) => ({ method: route.method, currencies: route.currencies, verifier: upv5ReleasePins("base_staging").unifiedPaymentVerifierV4 })),
    policyDisputeVerifier: upv5ReleasePins("base_staging").disputeVerifier, ...overrides,
  };
}

test("staging resumes from the first call the chain does not reflect", () => {
  const input = stagingInput();
  const calls = buildUpv5CutoverCalls(input);
  assert.equal(pendingUpv5Calls(calls, routingState(input)).length, calls.length);
  // Writers removed, V3 granted, two of three routes removed.
  const partial = routingState(input, {
    nullifierRegistryV2Writers: [], nullifierRegistryV3Writers: [DEPLOYED.unifiedPaymentVerifierV5],
    routes: [routingState(input).routes[0]],
  });
  assert.deepEqual(pendingUpv5Calls(calls, partial).map((call) => call.description), calls.slice(5).map((call) => call.description));
  // Every route re-added on UPV5: only the dispute switch remains.
  const routed = routingState(input, {
    nullifierRegistryV2Writers: [], nullifierRegistryV3Writers: [DEPLOYED.unifiedPaymentVerifierV5],
    routes: routingState(input).routes.map((route) => ({ ...route, verifier: DEPLOYED.unifiedPaymentVerifierV5 })),
  });
  assert.deepEqual(pendingUpv5Calls(calls, routed), [calls[calls.length - 1]]);
  assert.deepEqual(pendingUpv5Calls(calls, { ...routed, policyDisputeVerifier: DEPLOYED.disputeVerifierV2 }), []);
  assert.equal(upv5CallApplied(calls[0], routingState(input, { nullifierRegistryV2Writers: [ODD_WRITER] })), true);
});

test("staging refuses state that moved outside the plan order", () => {
  const input = stagingInput();
  const calls = buildUpv5CutoverCalls(input);
  // V3 granted while NullifierRegistryV2 still has writers: two writable replay domains.
  assert.throws(() => pendingUpv5Calls(calls, routingState(input, { nullifierRegistryV3Writers: [DEPLOYED.unifiedPaymentVerifierV5] })),
    /not a prefix of the plan: call 2 .* is applied but call 0/);
  assert.throws(() => pendingUpv5Calls(calls, routingState(input, { policyDisputeVerifier: DEPLOYED.disputeVerifierV2 })),
    /not a prefix of the plan/);
});

const ABI = {
  upv4: ["function orchestratorRegistry() view returns (address)", "function nullifierRegistry() view returns (address)",
    "function attestationVerifier() view returns (address)", "function getPaymentMethods() view returns (bytes32[])"],
  disputeVerifier: ["function nullifierRegistry() view returns (address)", "function attestationVerifier() view returns (address)"],
  policy: ["function disputeVerifier() view returns (address)"],
  v3: ["function predecessor() view returns (address)", "function getWriters() view returns (address[])",
    "function owner() view returns (address)", "function transferOwnership(address)"],
  upv5: ["function orchestratorRegistry() view returns (address)", "function nullifierRegistry() view returns (address)",
    "function attestationVerifier() view returns (address)", "function owner() view returns (address)",
    "function getPaymentMethods() view returns (bytes32[])", "function DOMAIN_SEPARATOR() view returns (bytes32)",
    "function addPaymentMethod(bytes32)", "function transferOwnership(address)"],
  dv2: ["function nullifierRegistry() view returns (address)", "function attestationVerifier() view returns (address)",
    "function owner() view returns (address)", "function pendingOwner() view returns (address)",
    "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])"],
  pvr: ["function getPaymentMethods() view returns (bytes32[])", "function getVerifier(bytes32) view returns (address)"],
  writers: ["function getWriters() view returns (address[])"],
};

class MockSigner extends Signer {
  constructor(address, chain) {
    super();
    this.address = address;
    this.chain = chain;
    utils.defineReadOnly(this, "provider", chain.provider);
  }
  async getAddress() { return this.address; }
  async signMessage() { throw new Error("unused"); }
  async signTransaction() { throw new Error("unused"); }
  connect() { return this; }
  async sendTransaction(transaction) { return this.chain.send(this.address, await transaction.to, await transaction.data); }
}

function laneFixture(context, network = "base_staging") {
  const lane = require("../deploy/49_deploy_unified_payment_verifier_v5_stack.ts");
  const savedEnv = { ...process.env };
  context.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  const local = network === "localhost" || network === "hardhat";
  const pins = local ? {
    orchestratorRegistry: "0x00000000000000000000000000000000000000a1", multiAttestationVerifier: "0x00000000000000000000000000000000000000a2",
    nullifierRegistryV2: "0x00000000000000000000000000000000000000a3", unifiedPaymentVerifierV4: "0x00000000000000000000000000000000000000a4",
    disputeVerifier: "0x00000000000000000000000000000000000000a5", paymentVerifierRegistry: "0x00000000000000000000000000000000000000a6",
    deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", governance: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  } : upv5ReleasePins(network);
  const disputeAttestationVerifier = local ? "0x00000000000000000000000000000000000000d1" : pins.disputeAttestationVerifier;
  const methods = ["venmo", "paypal", "wise"].map(utils.id);
  const state = {
    chainId: local ? 31337 : 8453, block: 100, deployer: pins.deployer, writes: [], deploys: [], accounts: 0, nextAddress: 0xb0,
    codeless: new Set(),
  };
  const contracts = new Map();
  const register = (address, abi, handlers) => contracts.set(lower(address), { iface: new utils.Interface(abi), handlers });
  register(pins.unifiedPaymentVerifierV4, ABI.upv4, {
    orchestratorRegistry: () => pins.orchestratorRegistry, nullifierRegistry: () => pins.nullifierRegistryV2,
    attestationVerifier: () => pins.multiAttestationVerifier, getPaymentMethods: () => [...methods],
  });
  register(pins.disputeVerifier, ABI.disputeVerifier, {
    nullifierRegistry: () => pins.nullifierRegistryV2, attestationVerifier: () => disputeAttestationVerifier,
  });
  const policy = { disputeVerifier: pins.disputeVerifier };
  if (!local) register(pins.disputeProtectionPolicyV2, ABI.policy, { disputeVerifier: () => policy.disputeVerifier });
  const routes = { verifier: pins.unifiedPaymentVerifierV4 };
  const writerSets = { [lower(pins.nullifierRegistryV2)]: [ODD_WRITER] };
  register(pins.paymentVerifierRegistry, ABI.pvr, { getPaymentMethods: () => [...methods], getVerifier: () => routes.verifier });
  register(pins.nullifierRegistryV2, ABI.writers, { getWriters: () => writerSets[lower(pins.nullifierRegistryV2)] });
  const records = new Map(Object.entries({
    OrchestratorRegistry: pins.orchestratorRegistry, NullifierRegistryV2: pins.nullifierRegistryV2,
    MultiAttestationVerifier: pins.multiAttestationVerifier, UnifiedPaymentVerifierV4: pins.unifiedPaymentVerifierV4,
    DisputeVerifier: pins.disputeVerifier, PaymentVerifierRegistry: pins.paymentVerifierRegistry,
    ...(local ? {} : { DisputeProtectionPolicyV2: pins.disputeProtectionPolicyV2 }),
  }).map(([name, address]) => [name, { address }]));
  const onlyOwner = (stack, from) => assert.equal(lower(from), lower(stack.owner), "caller is not the owner");
  function deployContract(name, args, from) {
    const address = utils.getAddress(`0x${(state.nextAddress++).toString(16).padStart(40, "0")}`);
    if (name === "NullifierRegistryV3") {
      const stack = { owner: from, writers: [] };
      writerSets[lower(address)] = stack.writers;
      register(address, ABI.v3, {
        predecessor: () => args[0], getWriters: () => [...stack.writers], owner: () => stack.owner,
        transferOwnership: ([owner], caller) => { onlyOwner(stack, caller); stack.owner = owner; },
      });
    } else if (name === "UnifiedPaymentVerifierV5") {
      const stack = { owner: from, methods: [] };
      register(address, ABI.upv5, {
        orchestratorRegistry: () => args[0], nullifierRegistry: () => args[1], attestationVerifier: () => args[2],
        owner: () => stack.owner, getPaymentMethods: () => [...stack.methods],
        DOMAIN_SEPARATOR: () => utils._TypedDataEncoder.hashDomain({
          name: "UnifiedPaymentVerifier", version: "1", chainId: state.chainId, verifyingContract: address,
        }),
        addPaymentMethod: ([method], caller) => { onlyOwner(stack, caller); stack.methods.push(method); },
        transferOwnership: ([owner], caller) => { onlyOwner(stack, caller); stack.owner = owner; },
      });
    } else {
      assert.equal(name, "DisputeVerifierV2");
      const stack = { owner: args[0], pendingOwner: constants.AddressZero };
      register(address, ABI.dv2, {
        nullifierRegistry: () => args[1], attestationVerifier: () => args[2], owner: () => stack.owner,
        pendingOwner: () => stack.pendingOwner,
        eip712Domain: () => ["0x0f", "ZKP2P DisputeVerifier", "1", state.chainId, address, constants.HashZero, []],
      });
    }
    return address;
  }
  const chain = {
    send: async (from, to, data) => {
      assert.ok(!local || lower(from) === lower(state.deployer));
      const contract = contracts.get(lower(to));
      assert.ok(contract, `unknown target ${to}`);
      const parsed = contract.iface.parseTransaction({ data });
      contract.handlers[parsed.name](Array.from(parsed.args), from);
      state.writes.push({ to, name: parsed.name, args: Array.from(parsed.args).map(String) });
      state.block++;
      const hash = utils.id(`tx-${state.block}`);
      return { hash, wait: async () => ({ status: 1, blockNumber: state.block, transactionHash: hash, logs: [] }) };
    },
  };
  const provider = {
    _isProvider: true,
    getNetwork: async () => ({ chainId: state.chainId }),
    getBlockNumber: async () => state.block,
    getCode: async (address) => state.codeless.has(lower(address)) ? "0x" : "0x6000",
    call: async (request) => {
      const contract = contracts.get(lower(await request.to));
      assert.ok(contract, `unknown read target ${await request.to}`);
      const parsed = contract.iface.parseTransaction({ data: await request.data });
      const result = contract.handlers[parsed.name](Array.from(parsed.args));
      const outputs = contract.iface.getFunction(parsed.name).outputs;
      return contract.iface.encodeFunctionResult(parsed.name, outputs.length === 1 ? [result] : result);
    },
  };
  chain.provider = provider;
  const hre = {
    deployments: {
      getNetworkName: () => network,
      get: async (name) => { assert.ok(records.has(name), `missing record ${name}`); return records.get(name); },
      getOrNull: async (name) => records.get(name) ?? null,
      getExtendedArtifact: async () => ({ solcInputHash: "compiled", deployedBytecode: "0x6000" }),
      deploy: async (name, options) => {
        assert.equal(options.contract, name);
        assert.equal(records.has(name), false, `must never redeploy ${name}`);
        const address = deployContract(name, options.args, options.from);
        state.deploys.push({ name, args: options.args.map(String), from: options.from });
        state.block++;
        const record = { address, args: options.args, deployedBytecode: "0x6000", solcInputHash: "recorded",
          receipt: { blockNumber: state.block } };
        records.set(name, record);
        return record;
      },
    },
    getUnnamedAccounts: async () => { state.accounts++; return [state.deployer]; },
    ethers: {
      provider,
      getSigner: async (address) => { state.accounts++; return new MockSigner(address, chain); },
    },
  };
  const func = lane.createUpv5StackLane();
  return { lane, func, hre, state, pins, records, routes, policy, writerSets, contracts, methods, disputeAttestationVerifier,
    run: () => func(hre), skip: () => func.skip(hre) };
}

function authorize(f, network) {
  process.env.DEPLOY_ACTIVE_TAG = f.lane.TAG;
  process.env[f.lane.LIVE_FLAGS[network]] = "true";
}

test("lane 49 identity, tags and live flags", (context) => {
  const { lane } = laneFixture(context);
  assert.equal(lane.TAG, "49_deploy_unified_payment_verifier_v5_stack");
  assert.deepEqual(lane.default.tags, [lane.TAG, "UnifiedPaymentVerifierV5Stack"]);
  assert.equal(lane.default.dependencies, undefined);
  assert.deepEqual(lane.LIVE_FLAGS, {
    base_staging: "ENABLE_STAGING_UPV5_STACK_DEPLOYMENT", base: "ENABLE_BASE_UPV5_STACK_DEPLOYMENT",
  });
});

test("staging deploys with UPV4's live bindings, mirrors its methods and keeps the signer as owner", async (context) => {
  const f = laneFixture(context, "base_staging");
  authorize(f, "base_staging");
  assert.equal(await f.skip(), false);
  await f.run();
  const v3 = f.records.get("NullifierRegistryV3").address;
  assert.deepEqual(f.state.deploys, [
    { name: "NullifierRegistryV3", args: [f.pins.nullifierRegistryV2], from: SIGNER },
    { name: "UnifiedPaymentVerifierV5", args: [f.pins.orchestratorRegistry, v3, f.pins.multiAttestationVerifier], from: SIGNER },
    { name: "DisputeVerifierV2", args: [SIGNER, v3, utils.getAddress(f.disputeAttestationVerifier)], from: SIGNER },
  ]);
  assert.deepEqual(f.state.writes.map((write) => [write.name, write.args]), f.methods.map((method) => ["addPaymentMethod", [method]]));
  // Deploy only: no writer, route or dispute-policy change.
  assert.deepEqual(f.writerSets[lower(v3)], []);
  assert.equal(f.routes.verifier, f.pins.unifiedPaymentVerifierV4);
  assert.equal(f.policy.disputeVerifier, f.pins.disputeVerifier);
  const writes = f.state.writes.length;
  await f.run();
  assert.equal(f.state.writes.length, writes, "a completed staging run is a no-op");
});

test("Base constructs DisputeVerifierV2 owned by the Safe and transfers V3 and UPV5 to it", async (context) => {
  const f = laneFixture(context, "base");
  authorize(f, "base");
  await f.run();
  const address = (name) => f.records.get(name).address;
  assert.deepEqual(f.state.deploys[2], {
    name: "DisputeVerifierV2", args: [SAFE, address("NullifierRegistryV3"), utils.getAddress(f.disputeAttestationVerifier)], from: SIGNER,
  });
  assert.deepEqual(f.state.writes.slice(f.methods.length).map((write) => [write.to, write.name, write.args]), [
    [address("NullifierRegistryV3"), "transferOwnership", [SAFE]],
    [address("UnifiedPaymentVerifierV5"), "transferOwnership", [SAFE]],
  ]);
  const dv2 = f.contracts.get(lower(address("DisputeVerifierV2"))).handlers;
  assert.equal(dv2.owner(), SAFE);
  assert.equal(dv2.pendingOwner(), constants.AddressZero);
  const writes = f.state.writes.length;
  await f.run();
  assert.equal(f.state.writes.length, writes, "a resumed Base run after the handover sends nothing");
  // The tagged deploy path still requires the exact deploy-time binding.
  f.contracts.get(lower(address("UnifiedPaymentVerifierV5"))).handlers.attestationVerifier = () => ODD_WRITER;
  await assert.rejects(f.run(), /UPV5 attestationVerifier is/);
});

test("an interrupted Base run resumes from its records without redeploying", async (context) => {
  const f = laneFixture(context, "base");
  authorize(f, "base");
  const deploy = f.hre.deployments.deploy;
  let deploys = 0;
  f.hre.deployments.deploy = async (...args) => {
    if (++deploys === 3) throw new Error("RPC dropped");
    return deploy(...args);
  };
  await assert.rejects(f.run(), /RPC dropped/);
  delete process.env.DEPLOY_ACTIVE_TAG;
  delete process.env[f.lane.LIVE_FLAGS.base];
  await assert.rejects(f.skip(), /records incomplete/);
  authorize(f, "base");
  f.hre.deployments.deploy = deploy;
  await f.run();
  assert.deepEqual(f.state.deploys.map((entry) => entry.name), ["NullifierRegistryV3", "UnifiedPaymentVerifierV5", "DisputeVerifierV2"]);
});

test("live runs need the tag and the network flag, the pinned signer, and pinned predecessors", async (context) => {
  for (const network of ["base", "base_staging"]) {
    const untagged = laneFixture(context, network);
    assert.equal(await untagged.skip(), true, "untagged without records skips");
    assert.equal(untagged.state.accounts, 0);
    process.env[untagged.lane.LIVE_FLAGS[network]] = "true";
    await assert.rejects(untagged.skip(), /requires DEPLOY_ACTIVE_TAG/);
    delete process.env[untagged.lane.LIVE_FLAGS[network]];

    const unflagged = laneFixture(context, network);
    process.env.DEPLOY_ACTIVE_TAG = unflagged.lane.TAG;
    await assert.rejects(unflagged.run(), /requires ENABLE_/);
    assert.equal(unflagged.state.deploys.length, 0);
    delete process.env.DEPLOY_ACTIVE_TAG;
  }
  const mutations = [
    [(f) => { f.state.deployer = RETIRED; }, /retired deployer/],
    [(f) => { f.state.deployer = "0x00000000000000000000000000000000000000e1"; }, /Lane 49 deployer/],
    [(f) => { f.state.chainId = 1; }, /chainId mismatch/],
    [(f) => { f.records.set("NullifierRegistryV2", { address: ODD_WRITER }); }, /NullifierRegistryV2 record/],
    [(f) => { f.contracts.get(lower(f.pins.unifiedPaymentVerifierV4)).handlers.attestationVerifier = () => ODD_WRITER; }, /UPV4 attestationVerifier/],
    [(f) => { f.contracts.get(lower(f.pins.unifiedPaymentVerifierV4)).handlers.getPaymentMethods = () => []; }, /no payment methods/],
    [(f) => { f.policy.disputeVerifier = ODD_WRITER; }, /unknown dispute verifier/],
    [(f) => { f.contracts.get(lower(f.pins.disputeVerifier)).handlers.attestationVerifier = () => ODD_WRITER; }, /DisputeVerifier attestationVerifier/],
  ];
  for (const [mutate, error] of mutations) {
    const f = laneFixture(context, "base");
    authorize(f, "base");
    mutate(f);
    await assert.rejects(f.run(), error);
    assert.equal(f.state.deploys.length, 0);
  }
});

test("a record bound to other constructor arguments is never reused", async (context) => {
  const f = laneFixture(context, "base_staging");
  authorize(f, "base_staging");
  f.records.set("NullifierRegistryV3", { address: DEPLOYED.nullifierRegistryV3, args: [ODD_WRITER] });
  await assert.rejects(f.run(), /NullifierRegistryV3 record args mismatch/);
});

test("untagged live runs re-verify complete records read-only, tolerate legitimate changes and reject drift", async (context) => {
  const f = laneFixture(context, "base");
  authorize(f, "base");
  await f.run();
  delete process.env.DEPLOY_ACTIVE_TAG;
  delete process.env[f.lane.LIVE_FLAGS.base];
  const accounts = f.state.accounts;
  assert.equal(await f.skip(), true);
  assert.equal(f.state.accounts, accounts, "verification must not obtain an account");
  // Legitimate later changes to UPV4 or the old DisputeVerifier must not break re-verification.
  const upv4 = f.contracts.get(lower(f.pins.unifiedPaymentVerifierV4)).handlers;
  upv4.attestationVerifier = () => ODD_WRITER;
  upv4.getPaymentMethods = () => [];
  f.contracts.get(lower(f.pins.disputeVerifier)).handlers.attestationVerifier = () => ODD_WRITER;
  f.policy.disputeVerifier = ODD_WRITER;
  assert.equal(await f.skip(), true);
  // A route pointing at UPV5 for a method UPV5 does not support does break it.
  const upv5Address = f.records.get("UnifiedPaymentVerifierV5").address;
  f.routes.verifier = upv5Address;
  f.contracts.get(lower(f.pins.paymentVerifierRegistry)).handlers.getPaymentMethods = () => [...f.methods, utils.id("retired")];
  await assert.rejects(f.skip(), /UPV5 lacks payment methods: \[0x/);
  f.contracts.get(lower(f.pins.paymentVerifierRegistry)).handlers.getPaymentMethods = () => [...f.methods];
  assert.equal(await f.skip(), true);
  const upv5 = f.contracts.get(lower(upv5Address)).handlers;
  const dv2Handlers = f.contracts.get(lower(f.records.get("DisputeVerifierV2").address)).handlers;
  // A legitimate setAttestationVerifier rotation on either contract keeps routine runs passing...
  const rotated = "0x00000000000000000000000000000000000000a7";
  upv5.attestationVerifier = () => rotated;
  dv2Handlers.attestationVerifier = () => rotated;
  assert.equal(await f.skip(), true);
  // ...but the verifier must still be a deployed, nonzero contract.
  f.state.codeless.add(lower(rotated));
  await assert.rejects(f.skip(), /UPV5 attestationVerifier .* is not a deployed contract/);
  upv5.attestationVerifier = () => constants.AddressZero;
  f.state.codeless.delete(lower(rotated));
  await assert.rejects(f.skip(), /UPV5 attestationVerifier .* is not a deployed contract/);
  upv5.attestationVerifier = () => rotated;
  dv2Handlers.attestationVerifier = () => constants.AddressZero;
  await assert.rejects(f.skip(), /DisputeVerifierV2 attestationVerifier .* is not a deployed contract/);
  dv2Handlers.attestationVerifier = () => rotated;
  assert.equal(await f.skip(), true);
  const owner = upv5.owner;
  upv5.owner = () => SIGNER;
  await assert.rejects(f.skip(), /UPV5 owner/);
  upv5.owner = owner;
  const dv2 = f.contracts.get(lower(f.records.get("DisputeVerifierV2").address)).handlers;
  dv2.owner = () => SIGNER;
  await assert.rejects(f.skip(), /DisputeVerifierV2 owner/);
  dv2.owner = () => SAFE;
  dv2.pendingOwner = () => SIGNER;
  await assert.rejects(f.skip(), /DisputeVerifierV2 pendingOwner/);
  f.records.delete("DisputeVerifierV2");
  await assert.rejects(f.skip(), /records incomplete/);
});

test("local networks deploy deployer-owned and leave UPV4 routed", async (context) => {
  const f = laneFixture(context, "localhost");
  delete process.env.DEPLOY_ACTIVE_TAG;
  assert.equal(await f.skip(), false);
  await f.run();
  assert.equal(f.state.deploys.length, 3);
  assert.equal(f.routes.verifier, f.pins.unifiedPaymentVerifierV4);
  assert.equal(f.state.writes.every((write) => write.name === "addPaymentMethod"), true);
});

test("upv5RoutesActive is false before the cutover and exact after it", (context) => {
  const { lane } = laneFixture(context);
  const upv5 = DEPLOYED.unifiedPaymentVerifierV5;
  const surface = {
    routedVerifiers: [ODD_WRITER, ODD_WRITER], registryMethods: ["venmo", "wise"].map(utils.id),
    upv5Methods: ["venmo", "wise"].map(utils.id), nullifierRegistryV2Writers: [ODD_WRITER],
    nullifierRegistryV3Writers: [], legacyNullifierWriters: [],
  };
  assert.equal(lane.assertUpv5RoutesActive(surface, upv5), false);
  const active = { ...surface, routedVerifiers: [upv5, upv5], nullifierRegistryV2Writers: [], nullifierRegistryV3Writers: [upv5] };
  assert.equal(lane.assertUpv5RoutesActive(active, upv5), true);
  for (const [mutation, error] of [
    [{ routedVerifiers: [upv5, ODD_WRITER] }, /Mixed or unknown UPV5 routes/],
    [{ upv5Methods: [utils.id("venmo")] }, /UPV5 lacks routed payment methods/],
    [{ nullifierRegistryV2Writers: [ODD_WRITER] }, /NullifierRegistryV2 writers remain/],
    [{ nullifierRegistryV3Writers: [upv5, ODD_WRITER] }, /exactly UPV5/],
    [{ legacyNullifierWriters: [ODD_WRITER] }, /Legacy nullifier writers remain/],
    [{ routedVerifiers: [] }, /PVR routes are empty/],
  ]) {
    assert.throws(() => lane.assertUpv5RoutesActive({ ...active, ...mutation }, upv5), error);
  }
});
