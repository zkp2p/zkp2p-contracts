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

const lane34Module = require("../deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts");
const {
  DEPLOY_ONLY_STEP_KINDS,
  LIVE_SUCCESSOR_DEPLOYMENT_NAMES,
  LOCAL_DISPUTE_DEPLOYMENT_NAMES,
  classifyDeployOnlyPrefix,
  classifyLiveDisputePhase,
  ownershipStepState,
  requireLocalPaymentBindingReady,
} = lane34Module;
const {
  selectVerificationDeployments,
  verifyDeployments,
} = require("../tasks/etherscanVerifyWithDelay.ts");
const {
  buildDeployArguments,
} = require("./deployActive.ts");

test("lane 34 owns the exact local and live deployment records", () => {
  assert.deepEqual(LOCAL_DISPUTE_DEPLOYMENT_NAMES, [
    "DisputeNullifierRegistry",
    "DisputeVerifier",
    "StakeVaultOptIn",
    "DisputeProtectionPolicyOptIn",
    "IntentLifecycleHookV1OptIn",
  ]);
  assert.deepEqual(LIVE_SUCCESSOR_DEPLOYMENT_NAMES, [
    "StakeVaultOptIn",
    "DisputeProtectionPolicyOptIn",
    "IntentLifecycleHookV1OptIn",
  ]);
  assert.deepEqual(lane34Module.default.dependencies, []);
});

test("live deployment fails closed without the network opt-in flag", async () => {
  const previous = process.env.ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT;
  const previousTag = process.env.DEPLOY_ACTIVE_TAG;
  delete process.env.ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT;
  delete process.env.DEPLOY_ACTIVE_TAG;
  try {
    await assert.rejects(
      lane34Module.default(/** @type {any} */ ({
        deployments: { getNetworkName: () => "base" },
      })),
      /ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT=true/,
    );
    assert.equal(await lane34Module.default.skip?.(/** @type {any} */ ({
      deployments: {
        getNetworkName: () => "base",
        getOrNull: async () => null,
      },
    })), true);
  } finally {
    if (previous === undefined) delete process.env.ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT;
    else process.env.ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT = previous;
    if (previousTag === undefined) delete process.env.DEPLOY_ACTIVE_TAG;
    else process.env.DEPLOY_ACTIVE_TAG = previousTag;
  }
});

test("the deploy-only state machine accepts only a contiguous prefix", () => {
  for (const network of /** @type {Array<"base_staging" | "base">} */ (["base_staging", "base"])) {
    const empty = DEPLOY_ONLY_STEP_KINDS[network].map(() => false);
    assert.deepEqual(classifyDeployOnlyPrefix(network, empty), {
      phase: "absent",
      nextStep: 0,
    });

    for (let prefixLength = 1; prefixLength <= empty.length; prefixLength += 1) {
      const state = empty.map((_, index) => index < prefixLength);
      const result = classifyDeployOnlyPrefix(network, state);
      assert.equal(result.nextStep, prefixLength === state.length ? null : prefixLength);
      assert.equal(result.phase, prefixLength === state.length ? "prepared" : "partial");
    }

    const nonPrefix = [...empty];
    nonPrefix[1] = true;
    assert.throws(
      () => classifyDeployOnlyPrefix(network, nonPrefix),
      /not a contiguous prefix/,
    );
  }
});

test("Base extends staging with ownership initiation and both predecessor cancellations", () => {
  assert.deepEqual(DEPLOY_ONLY_STEP_KINDS.base.slice(-4), [
    "transfer-vault-owner",
    "transfer-policy-owner",
    "cancel-predecessor-vault-owner",
    "cancel-predecessor-policy-owner",
  ]);
  assert.equal(
    DEPLOY_ONLY_STEP_KINDS.base.length,
    DEPLOY_ONLY_STEP_KINDS.base_staging.length + 4,
  );
});

test("live lifecycle and writer combinations have explicit phases", () => {
  assert.equal(classifyLiveDisputePhase({ artifacts: 0, configured: false,
    currentHook: "predecessor", writers: "predecessor" }), "absent");
  assert.equal(classifyLiveDisputePhase({ artifacts: 2, configured: false,
    currentHook: "predecessor", writers: "predecessor" }), "partial");
  assert.equal(classifyLiveDisputePhase({ artifacts: 3, configured: false,
    currentHook: "predecessor", writers: "predecessor" }), "deployed");
  assert.equal(classifyLiveDisputePhase({ artifacts: 3, configured: true,
    currentHook: "predecessor", writers: "predecessor" }), "prepared");
  assert.equal(classifyLiveDisputePhase({ artifacts: 3, configured: true,
    currentHook: "successor", writers: "both" }), "active");
  assert.throws(() => classifyLiveDisputePhase({ artifacts: 3, configured: true,
    currentHook: "successor", writers: "predecessor" }), /Invalid live dispute phase/);
});

test("local activation and live ownership checks fail closed on drift", () => {
  assert.throws(() => requireLocalPaymentBindingReady(false), /must be fully cut over/);
  assert.doesNotThrow(() => requireLocalPaymentBindingReady(true));
  const zero = "0x0000000000000000000000000000000000000000";
  const deployer = "0x0000000000000000000000000000000000000001";
  const governance = "0x0000000000000000000000000000000000000002";
  assert.equal(ownershipStepState(deployer, zero, deployer, governance, "vault"), false);
  assert.equal(ownershipStepState(deployer, governance, deployer, governance, "vault"), true);
  assert.throws(
    () => ownershipStepState(governance, deployer, deployer, governance, "vault"),
    /owner or pending owner drifted/,
  );
});

test("tag-scoped deployment runs lane 34 without dependencies", () => {
  assert.deepEqual(buildDeployArguments("base", "34_deploy_opt_in_dispute_lifecycle_stack"), [
    "deploy",
    "--network",
    "base",
    "--tags",
    "34_deploy_opt_in_dispute_lifecycle_stack",
    "--no-compile",
  ]);
});

test("verification allowlist preserves requested order and rejects unknown records", () => {
  const deployments = {
    StakeVaultOptIn: { address: "0x1" },
    DisputeProtectionPolicyOptIn: { address: "0x2" },
    IntentLifecycleHookV1OptIn: { address: "0x3" },
    OrchestratorV3: { address: "0x4" },
  };
  assert.deepEqual(
    Object.keys(selectVerificationDeployments(deployments, [
      "StakeVaultOptIn",
      "DisputeProtectionPolicyOptIn",
      "IntentLifecycleHookV1OptIn",
    ])),
    [
      "StakeVaultOptIn",
      "DisputeProtectionPolicyOptIn",
      "IntentLifecycleHookV1OptIn",
    ],
  );
  assert.throws(
    () => selectVerificationDeployments(deployments, ["Unknown"]),
    /Unknown deployment name: Unknown/,
  );
});

test("verification treats already-verified responses as success", async () => {
  const results = await verifyDeployments(
    { run: async () => { throw new Error("Contract source code already verified"); } },
    { StakeVaultOptIn: { address: "0x1" } },
    0,
    true,
  );
  assert.deepEqual(results.skipped, ["StakeVaultOptIn"]);
  assert.deepEqual(results.failed, []);
});

test("verification fail-on-error rejects after collecting the summary", async () => {
  await assert.rejects(
    verifyDeployments(
      { run: async () => { throw new Error("explorer unavailable"); } },
      { StakeVaultOptIn: { address: "0x1" } },
      0,
      true,
    ),
    /1 selected contract verification\(s\) failed/,
  );
});
