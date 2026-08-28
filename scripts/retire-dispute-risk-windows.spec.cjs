#!/usr/bin/env node

process.env.DEPLOY_TX_DELAY_MS = "0";
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
const { BigNumber, utils } = require("ethers");

const {
  DISPUTABLE_PAYMENT_METHODS,
  MULTI_SIG,
  RETIRED_DISPUTABLE_PAYMENT_METHODS,
} = require("../deployments/parameters.ts");
const { safeBatchCollector } = require("../deployments/safeBatchCollector.ts");
const lane41 = require("../deploy/41_retire_dispute_risk_windows.ts");
const skipLane41 = /** @type {(hre: any) => Promise<boolean>} */ (
  lane41.default.skip
);

const DEPLOYER = "0x1000000000000000000000000000000000000001";
const OTHER = "0x2000000000000000000000000000000000000002";
const POLICY = "0x3000000000000000000000000000000000000003";
const RISK_WINDOW = BigNumber.from(1_209_600);
const policyInterface = new utils.Interface([
  "function setRiskWindow(bytes32,uint64)",
  "function getRiskWindow(bytes32) view returns (uint64)",
  "function owner() view returns (address)",
]);

/**
 * @param {string} network
 * @param {string[]} [accounts]
 * @param {ReturnType<typeof fakePolicy>["policy"]} [policy]
 * @param {boolean} [throwOnGetContractAt]
 */
function fakeHre(
  network,
  accounts = [DEPLOYER],
  policy = fakePolicy(DEPLOYER).policy,
  throwOnGetContractAt = false
) {
  return {
    deployments: { getNetworkName: () => network },
    ethers: {
      getSigner: async (/** @type {string} */ address) => ({ address }),
      getContractAt: async () => {
        if (throwOnGetContractAt) throw new Error("unexpected chain read");
        return policy;
      },
    },
    getUnnamedAccounts: async () => accounts,
  };
}

/**
 * @param {string} owner
 * @param {Partial<Record<string, import("ethers").BigNumberish>>} [overrides]
 */
function fakePolicy(owner, overrides = {}) {
  /** @type {Map<string, import("ethers").BigNumber>} */
  const windows = new Map();
  for (const method of ["paypal", "venmo", "cashapp"]) {
    windows.set(utils.id(method), RISK_WINDOW);
  }
  for (const [method, window] of Object.entries(overrides)) {
    windows.set(utils.id(method), BigNumber.from(window));
  }

  /** @type {Array<{ hash: string; window: import("ethers").BigNumber }>} */
  const setterCalls = [];
  const policy = {
    address: POLICY,
    interface: policyInterface,
    getRiskWindow: async (/** @type {string} */ hash) =>
      windows.get(hash) ?? BigNumber.from(0),
    owner: async () => owner,
    connect: () => ({
      setRiskWindow: async (
        /** @type {string} */ hash,
        /** @type {import("ethers").BigNumberish} */ window
      ) => {
        const value = BigNumber.from(window);
        setterCalls.push({ hash, window: value });
        windows.set(hash, value);
        return { wait: async () => undefined };
      },
    }),
  };

  return {
    policy,
    setterCalls,
    window: (/** @type {string} */ method) =>
      windows.get(utils.id(method)) ?? BigNumber.from(0),
  };
}

test("exports its identity", () => {
  assert.deepEqual(lane41.default.tags, [
    "41_retire_dispute_risk_windows",
    "DisputeRiskWindowRetirement",
  ]);
  assert.deepEqual(lane41.default.dependencies, [
    "39_deploy_method_scoped_vault_stack",
  ]);
  assert.deepEqual(RETIRED_DISPUTABLE_PAYMENT_METHODS, ["cashapp"]);
  // Main already excludes the retired methods; the lane must never target a disputable one.
  assert.deepEqual(DISPUTABLE_PAYMENT_METHODS, ["paypal", "venmo"]);
  for (const method of RETIRED_DISPUTABLE_PAYMENT_METHODS) {
    assert.ok(!DISPUTABLE_PAYMENT_METHODS.includes(method), method);
  }
});

test("retires only the retired window when a local account owns the policy", async () => {
  const state = fakePolicy(DEPLOYER);
  const queuedBefore = safeBatchCollector.count();

  await lane41.retireDisputeRiskWindows(
    /** @type {any} */ (fakeHre("hardhat", [DEPLOYER], state.policy)),
    /** @type {any} */ (state.policy)
  );

  assert.equal(state.window("cashapp").toString(), "0");
  assert.equal(state.window("paypal").toString(), RISK_WINDOW.toString());
  assert.equal(state.window("venmo").toString(), RISK_WINDOW.toString());
  assert.equal(state.setterCalls.length, 1);
  assert.equal(state.setterCalls[0].hash, utils.id("cashapp"));
  assert.equal(state.setterCalls[0].window.toString(), "0");
  assert.equal(safeBatchCollector.count(), queuedBefore);
});

test("queues exactly one Safe call when governance owns the policy", async () => {
  const state = fakePolicy(MULTI_SIG.base);
  const queuedBefore = safeBatchCollector.count();

  await lane41.retireDisputeRiskWindows(
    /** @type {any} */ (fakeHre("base", [DEPLOYER], state.policy)),
    /** @type {any} */ (state.policy)
  );

  const queued = safeBatchCollector.getTransactionsSince(queuedBefore);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].to, POLICY);
  assert.equal(
    queued[0].data,
    policyInterface.encodeFunctionData("setRiskWindow", [utils.id("cashapp"), 0])
  );
  assert.equal(state.setterCalls.length, 0);
  assert.equal(state.window("cashapp").toString(), RISK_WINDOW.toString());
  assert.equal(state.window("paypal").toString(), RISK_WINDOW.toString());
  assert.equal(state.window("venmo").toString(), RISK_WINDOW.toString());
});

test("does nothing when the retired windows are already zero", async () => {
  const state = fakePolicy(OTHER, { cashapp: 0 });
  const queuedBefore = safeBatchCollector.count();

  await lane41.retireDisputeRiskWindows(
    /** @type {any} */ (fakeHre("hardhat", [DEPLOYER], state.policy)),
    /** @type {any} */ (state.policy)
  );

  assert.equal(safeBatchCollector.count(), queuedBefore);
  assert.equal(state.setterCalls.length, 0);
  assert.equal(state.window("cashapp").toString(), "0");
  assert.equal(state.window("paypal").toString(), RISK_WINDOW.toString());
  assert.equal(state.window("venmo").toString(), RISK_WINDOW.toString());
});

test("rejects an unexpected policy owner", async () => {
  const state = fakePolicy(OTHER);
  const queuedBefore = safeBatchCollector.count();

  await assert.rejects(
    lane41.retireDisputeRiskWindows(
      /** @type {any} */ (fakeHre("hardhat", [DEPLOYER], state.policy)),
      /** @type {any} */ (state.policy)
    ),
    /owner mismatch/
  );
  assert.equal(safeBatchCollector.count(), queuedBefore);
  assert.equal(state.setterCalls.length, 0);
  assert.equal(state.window("cashapp").toString(), RISK_WINDOW.toString());
  assert.equal(state.window("paypal").toString(), RISK_WINDOW.toString());
  assert.equal(state.window("venmo").toString(), RISK_WINDOW.toString());
});

test("rejects retired methods that are not active on the network", () => {
  assert.throws(
    () => lane41.assertRetiredMethodsActive("base", ["mercury"]),
    /not active on base/
  );
  assert.doesNotThrow(() =>
    lane41.assertRetiredMethodsActive("base_staging", ["mercury"])
  );
  assert.throws(
    () => lane41.assertRetiredMethodsActive("base", []),
    /must not be empty/
  );
});

test("skips untagged live runs before reading the chain and gates tagged runs on live state", async () => {
  const previousTag = process.env.DEPLOY_ACTIVE_TAG;
  try {
    delete process.env.DEPLOY_ACTIVE_TAG;
    assert.equal(
      await skipLane41(
        /** @type {any} */ (fakeHre("base", [DEPLOYER], undefined, true))
      ),
      true
    );

    process.env.DEPLOY_ACTIVE_TAG = lane41.TAG;
    const state = fakePolicy(MULTI_SIG.base);
    assert.equal(
      await skipLane41(
        /** @type {any} */ (fakeHre("base", [DEPLOYER], state.policy))
      ),
      false
    );
    const cleared = fakePolicy(MULTI_SIG.base, { cashapp: 0 });
    assert.equal(
      await skipLane41(
        /** @type {any} */ (fakeHre("base", [DEPLOYER], cleared.policy))
      ),
      true
    );
  } finally {
    if (previousTag === undefined) delete process.env.DEPLOY_ACTIVE_TAG;
    else process.env.DEPLOY_ACTIVE_TAG = previousTag;
  }
});

test("deploy_summary writes the Safe batch for the lane tag", () => {
  const deploySummary = require("../deploy/deploy_summary.ts");
  const tags = /** @type {string[]} */ (deploySummary.default.tags);
  assert.ok(tags.includes(lane41.TAG));
  assert.ok(
    tags.includes("DisputeRiskWindowRetirement")
  );
});
