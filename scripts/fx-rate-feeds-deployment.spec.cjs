#!/usr/bin/env node
process.env.DEPLOY_TX_DELAY_MS = "0";
process.env.ALCHEMY_API_KEY ||= "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY ||= "1".repeat(64);
process.env.TESTNET_DEPLOY_PRIVATE_KEY ||= "2".repeat(64);
require(require.resolve("ts-node/register/transpile-only"));
require(require.resolve("module-alias/register"));
const moduleAlias = require(require.resolve("module-alias"));
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");
const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { BigNumber, utils, constants } = require("ethers");
const { FX_RATE_FEEDS, FX_RATE_UPDATER, MULTI_SIG } = require("../deployments/parameters.ts");
const lane = require("../deploy/44_deploy_fx_rate_feeds.ts");
const DEPLOYER = "0x1000000000000000000000000000000000000001";
const UPDATER = "0x2000000000000000000000000000000000000002";
const OTHER = "0x3000000000000000000000000000000000000003";
const names = ["FxRateStore", "FxRateFeedInrUsd", "FxRateFeedCnyUsd"];
const savedEnv = { ...process.env };
const savedUpdater = FX_RATE_UPDATER.base;
beforeEach(() => {
  FX_RATE_UPDATER.base = UPDATER;
  process.env[lane.LIVE_FLAG] = "true";
  process.env.FX_RATE_SEED_INR_USD = "1050000";
  process.env.FX_RATE_SEED_CNY_USD = "15000000";
});
afterEach(() => {
  FX_RATE_UPDATER.base = savedUpdater;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

/** @param {string} [network] */
function fixture(network = "base") {
  /** @type {string[]} */
  const calls = [];
  /** @type {Map<string, any>} */
  const records = new Map();
  /** @type {Map<string, any>} */
  const contracts = new Map();
  /** @type {Map<string, any>} */
  const configs = new Map();
  /** @type {Map<string, any>} */
  const rounds = new Map();
  const missingCode = new Set();
  let stopAfter = Infinity;
  /** @param {string} action */
  async function write(action) {
    calls.push(action);
    if (calls.length === stopAfter) throw new Error("interrupted");
    return { wait: async () => undefined };
  }
  /** @param {string} name @param {any} options */
  async function deploy(name, options) {
    assert.ok(!records.has(name), `deploy called for existing ${name}`);
    assert.equal(options.from, DEPLOYER);
    const address = utils.getAddress("0x" + (names.indexOf(name) + 10).toString(16).padStart(40, "0"));
    const state = { owner: DEPLOYER, updater: options.args[0], source: options.args[0], sourceFeedId: options.args[1], description: options.args[2] };
    const contract = {
      address, state,
      owner: async () => state.owner,
      updater: async () => state.updater,
      source: async () => state.source,
      sourceFeedId: async () => state.sourceFeedId,
      description: async () => state.description,
      transferOwnership: async (/** @type {string} */ owner) => {
        assert.equal(state.owner, DEPLOYER);
        state.owner = owner;
        return write(`transfer:${name}:${owner}`);
      },
      getFeedConfig: async (/** @type {string} */ id) => configs.get(id) ?? { registered: false, locked: false, minAnswer: BigNumber.from(0), maxAnswer: BigNumber.from(0) },
      latestRoundData: async (/** @type {string} */ id) => rounds.get(id) ?? { answer: BigNumber.from(0), updatedAt: BigNumber.from(0) },
      addFeed: async (/** @type {string} */ id, /** @type {number} */ min, /** @type {number} */ max) => {
        assert.equal(state.owner, DEPLOYER);
        configs.set(id, { registered: true, locked: true, minAnswer: BigNumber.from(min), maxAnswer: BigNumber.from(max) });
        return write(`add:${id}:${min}:${max}`);
      },
      seedFeed: async (/** @type {string} */ id, /** @type {number} */ seed) => {
        assert.equal(state.owner, DEPLOYER);
        configs.get(id).locked = false;
        rounds.set(id, { answer: BigNumber.from(seed), updatedAt: BigNumber.from(100) });
        return write(`seed:${id}:${seed}`);
      },
    };
    assert.equal(options.contract ?? name, name === names[0] ? "FxRateStore" : "FxRateFeed");
    records.set(name, { address });
    contracts.set(name, contract);
    await write(`deploy:${name}:${JSON.stringify(options.args)}`);
    return { address };
  }
  const hre = {
    deployments: { getNetworkName: () => network, getOrNull: async (/** @type {string} */ name) => records.get(name) ?? null, deploy },
    getUnnamedAccounts: async () => [DEPLOYER, UPDATER],
    ethers: {
      getSigner: async () => ({ address: DEPLOYER }),
      provider: { getCode: async (/** @type {string} */ address) => missingCode.has(address) ? "0x" : "0x1234" },
      getContractAt: async (/** @type {string} */ _type, /** @type {string} */ address) => {
        const contract = [...contracts.values()].find((value) => value.address === address);
        assert.ok(contract, `missing contract ${address}`);
        return contract;
      },
    },
  };
  return { hre, calls, records, contracts, configs, rounds, missingCode,
    stopAt: (/** @type {number} */ count) => { stopAfter = count; },
    run: () => lane.deployFxRateFeeds(/** @type {any} */ (hre)),
  };
}

/** @param {string} network */
function expectedCalls(network) {
  const store = utils.getAddress("0x" + "a".padStart(40, "0"));
  return [
    `deploy:FxRateStore:${JSON.stringify([UPDATER])}`,
    ...FX_RATE_FEEDS.map((feed) => `add:${utils.id(feed.pair)}:${feed.minAnswer}:${feed.maxAnswer}`),
    ...FX_RATE_FEEDS.map((feed) => `seed:${utils.id(feed.pair)}:${network === "base" ? process.env[feed.seedEnv] : feed.localSeed}`),
    ...FX_RATE_FEEDS.map((feed) => `deploy:${feed.deploymentName}:${JSON.stringify([store, utils.id(feed.pair), feed.description])}`),
    ...(network === "base" ? names.map((name) => `transfer:${name}:${MULTI_SIG.base}`) : []),
  ];
}

test("exports its identity", () => {
  assert.equal(lane.TAG, "44_deploy_fx_rate_feeds");
  assert.equal(lane.LIVE_FLAG, "ENABLE_BASE_FX_RATE_FEEDS_DEPLOYMENT");
  assert.equal(lane.STORE_DEPLOYMENT_NAME, "FxRateStore");
  assert.deepEqual(lane.default.tags, [lane.TAG, "FxRateFeeds"]);
  assert.equal(lane.default.dependencies, undefined);
  assert.deepEqual(FX_RATE_FEEDS, [
    { pair: "INR/USD", deploymentName: names[1], description: "INR / USD", seedEnv: "FX_RATE_SEED_INR_USD", minAnswer: 800000, maxAnswer: 1400000, localSeed: 1041667 },
    { pair: "CNY/USD", deploymentName: names[2], description: "CNY / USD", seedEnv: "FX_RATE_SEED_CNY_USD", minAnswer: 10000000, maxAnswer: 20000000, localSeed: 14880952 },
  ]);
  assert.equal(lane.feedId("INR/USD"), utils.id("INR/USD"));
});
test("skip matrix", async () => {
  for (const tag of [undefined, "unrelated", lane.TAG]) {
    if (tag === undefined) delete process.env.DEPLOY_ACTIVE_TAG;
    else process.env.DEPLOY_ACTIVE_TAG = tag;
    for (const network of ["base_staging", "base", "localhost", "hardhat", "sepolia"]) {
      const expected = network === "base" ? tag !== lane.TAG : !["localhost", "hardhat"].includes(network);
      assert.equal(await (/** @type {(hre: any) => Promise<boolean>} */ (lane.default.skip))(/** @type {any} */ (fixture(network).hre)), expected);
    }
  }
});
test("base requires the live flag before any write", async () => {
  for (const value of [undefined, "false", "TRUE"]) {
    if (value === undefined) delete process.env[lane.LIVE_FLAG];
    else process.env[lane.LIVE_FLAG] = value;
    const state = fixture();
    await assert.rejects(state.run(), /ENABLE_BASE_FX_RATE_FEEDS_DEPLOYMENT=true required/);
    assert.deepEqual(state.calls, []);
  }
});
test("base resolves the committed updater parameter", () => {
  FX_RATE_UPDATER.base = savedUpdater;
  assert.equal(FX_RATE_UPDATER.base, "0x81630fb1ab2A7Eab137888b9746b66889f78F091");
  assert.equal(lane.resolveUpdater("base", []), FX_RATE_UPDATER.base);
});
test("base requires a valid nonzero updater parameter", () => {
  for (const value of ["", "invalid", constants.AddressZero]) {
    FX_RATE_UPDATER.base = value;
    assert.throws(() => lane.resolveUpdater("base", []), /FX_RATE_UPDATER.base is not set/);
  }
  FX_RATE_UPDATER.base = UPDATER;
  assert.equal(lane.resolveUpdater("base", []), UPDATER);
  for (const network of ["localhost", "hardhat"]) {
    assert.equal(lane.resolveUpdater(network, [DEPLOYER, UPDATER]), UPDATER);
    assert.throws(() => lane.resolveUpdater(network, [DEPLOYER]), /accounts\[1\]/);
    assert.equal(lane.resolveGovernance(network, DEPLOYER), DEPLOYER);
  }
  assert.throws(() => lane.resolveUpdater("sepolia", []), /network/);
  assert.equal(lane.resolveGovernance("base", DEPLOYER), MULTI_SIG.base);
});
test("seed parsing", () => {
  for (const feed of FX_RATE_FEEDS) {
    for (const value of [undefined, "", "1.5", "abc", "1e6", "0x100000", " 1041667", "1041667\n", "-1", String(feed.minAnswer - 1), String(feed.maxAnswer + 1)]) {
      assert.throws(() => lane.parseSeed("base", feed, { [feed.seedEnv]: value }), new RegExp(feed.seedEnv));
    }
    for (const value of [feed.minAnswer, feed.maxAnswer, feed.localSeed]) {
      assert.equal(lane.parseSeed("base", feed, { [feed.seedEnv]: String(value) }), value);
    }
    for (const network of ["localhost", "hardhat"]) assert.equal(lane.parseSeed(network, feed, {}), feed.localSeed);
  }
  assert.equal(lane.parseSeed("base", FX_RATE_FEEDS[0], { FX_RATE_SEED_INR_USD: "1041667" }), 1041667);
});
for (const network of ["localhost", "hardhat", "base"]) {
  test(`fresh ${network} run`, async () => {
    const state = fixture(network);
    await state.run();
    assert.deepEqual(state.calls, expectedCalls(network));
    for (const contract of state.contracts.values()) assert.equal(await contract.owner(), network === "base" ? MULTI_SIG.base : DEPLOYER);
  });
}
const boundaries = ["store deployed only", "one feed added", "both added", "one seeded", "both seeded", "one facade deployed", "both deployed", "store transferred only", "store + INR feed transferred"];
for (const [index, boundary] of boundaries.entries()) {
  test(`resume after ${boundary}`, async () => {
    const state = fixture();
    const expected = expectedCalls("base");
    state.stopAt(index + 1);
    await assert.rejects(state.run(), /interrupted/);
    assert.deepEqual(state.calls, expected.slice(0, index + 1));
    state.calls.length = 0;
    state.stopAt(Infinity);
    await state.run();
    assert.deepEqual(state.calls, expected.slice(index + 1));
  });
}
test("verification-only after transfer needs no seeds and performs zero writes", async () => {
  const state = fixture();
  await state.run();
  state.calls.length = 0;
  delete process.env.FX_RATE_SEED_INR_USD;
  delete process.env.FX_RATE_SEED_CNY_USD;
  await state.run();
  assert.deepEqual(state.calls, []);
});
test("preflight rejects invalid second seed before any write", async () => {
  process.env.FX_RATE_SEED_CNY_USD = "bad";
  const state = fixture();
  await assert.rejects(state.run(), /FX_RATE_SEED_CNY_USD/);
  assert.deepEqual(state.calls, []);
});

/** @type {Array<[string, (state: ReturnType<typeof fixture>) => void, RegExp]>} */
const mismatches = [
  ["updater", (state) => { state.contracts.get(names[0]).state.updater = OTHER; }, /updater drift/],
  ["store runtime", (state) => { state.missingCode.add(state.records.get(names[0]).address); }, /runtime/],
  ["limits", (state) => { state.configs.get(utils.id("CNY/USD")).minAnswer = BigNumber.from(1); }, /limits/],
  ["source", (state) => { state.contracts.get(names[2]).state.source = OTHER; }, /source/],
  ["sourceFeedId", (state) => { state.contracts.get(names[2]).state.sourceFeedId = utils.id("other"); }, /sourceFeedId/],
  ["description", (state) => { state.contracts.get(names[2]).state.description = "wrong"; }, /description/],
  ["facade runtime", (state) => { state.missingCode.add(state.records.get(names[2]).address); }, /runtime/],
  ["store owner", (state) => { state.contracts.get(names[0]).state.owner = OTHER; }, /owner/],
  ["facade owner", (state) => { state.contracts.get(names[2]).state.owner = OTHER; }, /owner/],
  ["locked Safe-owned feed", (state) => { state.configs.get(utils.id("CNY/USD")).locked = true; state.contracts.get(names[0]).state.owner = MULTI_SIG.base; }, /feed locked and deployer is not owner.*Safe must seed/],
  ["unregistered Safe-owned feed", (state) => { state.configs.delete(utils.id("CNY/USD")); state.contracts.get(names[0]).state.owner = MULTI_SIG.base; }, /not owner/],
  ["zero answer", (state) => { state.rounds.get(utils.id("CNY/USD")).answer = BigNumber.from(0); }, /feed unlocked without a round/],
  ["zero updatedAt", (state) => { state.rounds.get(utils.id("CNY/USD")).updatedAt = BigNumber.from(0); }, /feed unlocked without a round/],
];
for (const [label, corrupt, error] of mismatches) {
  test(`preflight rejects ${label} with zero writes`, async () => {
    const state = fixture();
    state.stopAt(7);
    await assert.rejects(state.run(), /interrupted/);
    state.stopAt(Infinity);
    state.calls.length = 0;
    corrupt(state);
    await assert.rejects(state.run(), error);
    assert.deepEqual(state.calls, []);
  });
}

test("ownership resumes independently when a facade was transferred first", async () => {
  const state = fixture();
  state.stopAt(7);
  await assert.rejects(state.run(), /interrupted/);
  state.contracts.get(names[2]).state.owner = MULTI_SIG.base;
  state.calls.length = 0;
  state.stopAt(Infinity);
  await state.run();
  assert.deepEqual(state.calls, expectedCalls("base").slice(7, 9));
});

test("resume parses seeds only for feeds still requiring a seed", async () => {
  const state = fixture();
  state.stopAt(4);
  await assert.rejects(state.run(), /interrupted/);
  state.calls.length = 0;
  state.stopAt(Infinity);
  delete process.env.FX_RATE_SEED_INR_USD;
  await state.run();
  assert.deepEqual(state.calls, expectedCalls("base").slice(4));
});
