#!/usr/bin/env node
require(require.resolve("ts-node/register/transpile-only"));
require(require.resolve("module-alias/register"));
const aliases = require(require.resolve("module-alias"));
aliases.reset();
aliases.addAlias("@utils", process.cwd() + "/utils");
const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { utils } = require("ethers");
const model = require("../deployments/bypassDisputeActivation.ts");
const replacement = require("../deployments/stagingBypassReplacement.ts");
const { selectActiveDeploymentScripts } = require("../deployments/immutableDeploymentLanes.ts");
const {
  classifyFreshStackActivity,
} = require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts");
const { SUPERSEDED } = replacement;
const { LANE_45_STEP_KINDS, BYPASS_RECORDED_DEPLOYMENTS } = require("../deployments/bypassDisputeStack.ts");
const recordedStaging = BYPASS_RECORDED_DEPLOYMENTS.base_staging;
assert.ok(recordedStaging);
// Replacement cases model the abandoned epoch even after the real recording PR.
// Individual post-recording cases replace these fixture pins with fresh addresses.
beforeEach(() => {
  BYPASS_RECORDED_DEPLOYMENTS.base_staging = {
    ...recordedStaging,
    StakeVaultBypass: { ...recordedStaging.StakeVaultBypass, address: SUPERSEDED.StakeVaultBypass },
    DisputeProtectionPolicyBypass: { ...recordedStaging.DisputeProtectionPolicyBypass, address: SUPERSEDED.DisputeProtectionPolicyBypass },
    IntentLifecycleHookV1Bypass: { ...recordedStaging.IntentLifecycleHookV1Bypass, address: SUPERSEDED.IntentLifecycleHookV1Bypass },
  };
});
afterEach(() => { BYPASS_RECORDED_DEPLOYMENTS.base_staging = recordedStaging; });
const STEPS = replacement.replacementSteps(LANE_45_STEP_KINDS.base_staging);
/** @param {number} value */
const address = (value) => `0x${value.toString(16).padStart(40, "0")}`;
/** @param {number} value */
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const ZERO = address(0);
/** @typedef {import("../deployments/bypassDisputeActivation").BypassExpectedActivationState} Expected */
/** @typedef {import("../deployments/bypassDisputeActivation").BypassActivationSnapshot} Snapshot */
/** @param {"base" | "base_staging"} [network] @returns {Expected} */
function expected(network = "base") {
  const addresses = {
    safe: address(1),
    deployer: address(2),
    escrow: address(3),
    freshVault: address(4),
    freshPolicy: address(5),
    freshHook: address(6),
    verifier: address(7),
    retiredVerifier: address(8),
    predecessorVault: address(9),
    predecessorPolicy: address(10),
    predecessorHook: address(11),
    disputeRegistry: address(12),
    nullifierRegistryV2: address(13),
    paymentVerifierRegistry: address(14),
    orchestrator: address(15),
    orchestratorRegistry: address(16),
    escrowRegistry: address(17),
    relayerRegistry: address(18),
    protocolFeeRecipient: address(19),
    whitelistPolicy: address(20),
    groupRegistry: address(21),
    attestationVerifier: address(22),
    disputeVerifier: address(23),
    stakeToken: address(24),
  };
  return {
    network,
    addresses,
    governance: network === "base" ? addresses.safe : addresses.deployer,
    deployer: addresses.deployer,
    allowedWhitelistPolicyOwners: [addresses.deployer, addresses.safe],
    witnesses: [address(30), address(31)],
    allowMultipleIntents: true,
    protocolFee: "0",
    paymentMethods: [
      { paymentMethod: hash(103), currencies: [hash(203), hash(201)] },
      { paymentMethod: hash(101), currencies: [hash(204)] },
      {
        paymentMethod: hash(102),
        currencies: [hash(206), hash(205), hash(207)],
      },
    ],
    riskWindows: {
      [hash(103)]: "86400",
      [hash(101)]: "172800",
      [hash(102)]: "0",
      [hash(99)]: "0",
    },
  };
}

/** @param {Expected} wanted @param {number} [k] @returns {Snapshot} */
function snapshot(wanted, k = 0) {
  const a = wanted.addresses;
  const row = model.bypassRowStateAfter(wanted, k);
  const owner = wanted.governance;
  const ownership =
    wanted.network === "base"
      ? k === 2 * wanted.paymentMethods.length + 4
        ? { owner: a.safe, pendingOwner: ZERO }
        : { owner: wanted.deployer, pendingOwner: a.safe }
      : { owner: wanted.deployer, pendingOwner: ZERO };
  return {
    network: wanted.network,
    blockNumber: "100",
    blockHash: hash(1000),
    blockTimestamp: "10000",
    freshVault: {
      ...ownership,
      controller: a.freshPolicy,
      pendingController: ZERO,
      pendingControllerValidAt: "0",
      controllerChangeDelay: "0",
      stakeToken: a.stakeToken,
    },
    freshPolicy: {
      ...ownership,
      admissionsPaused: false,
      stakeVault: a.freshVault,
      disputeVerifier: a.disputeVerifier,
      disputeNullifierRegistry: a.disputeRegistry,
      authorizedHooks: [a.freshHook],
      riskWindows: { ...wanted.riskWindows },
    },
    freshHook: {
      orchestratorRegistry: a.orchestratorRegistry,
      whitelistPolicy: a.whitelistPolicy,
      disputeProtectionPolicy: a.freshPolicy,
    },
    verifier: {
      owner,
      orchestratorRegistry: a.orchestratorRegistry,
      nullifierRegistry: a.nullifierRegistryV2,
      attestationVerifier: a.attestationVerifier,
      paymentMethods: wanted.paymentMethods.map((method) => method.paymentMethod),
    },
    retiredVerifier: {
      owner,
      paymentMethods: wanted.paymentMethods.map((method) => method.paymentMethod),
    },
    predecessorVault: {
      owner,
      controller: a.predecessorPolicy,
      pendingController: ZERO,
    },
    predecessorPolicy: {
      owner,
      pendingOwner: ZERO,
      stakeVault: a.predecessorVault,
      disputeVerifier: a.disputeVerifier,
      disputeNullifierRegistry: a.disputeRegistry,
      predecessorHookAuthorized: true,
    },
    predecessorHook: {
      orchestratorRegistry: a.orchestratorRegistry,
      whitelistPolicy: a.whitelistPolicy,
      disputeProtectionPolicy: a.predecessorPolicy,
    },
    disputeRegistry: { owner, writers: row.disputeWriters },
    nullifierRegistryV2: { owner, writers: row.nrv2Writers },
    paymentVerifierRegistry: { owner, methods: row.registry },
    orchestrator: {
      owner,
      paused: false,
      lifecycleHook: row.hook,
      escrowRegistry: a.escrowRegistry,
      paymentVerifierRegistry: a.paymentVerifierRegistry,
      relayerRegistry: a.relayerRegistry,
      protocolFee: wanted.protocolFee,
      protocolFeeRecipient: a.protocolFeeRecipient,
      allowMultipleIntents: wanted.allowMultipleIntents,
      registered: true,
    },
    whitelistPolicy: {
      owner: wanted.deployer,
      escrowRegistry: a.escrowRegistry,
      groupRegistry: a.groupRegistry,
      orchestratorRegistry: a.orchestratorRegistry,
    },
    attestationVerifier: {
      owner,
      requiredSignatures: "1",
      witnesses: [...wanted.witnesses],
    },
    disputeVerifier: {
      owner,
      pendingOwner: ZERO,
      attestationVerifier: a.attestationVerifier,
      nullifierRegistry: a.nullifierRegistryV2,
    },
    inventory: {
      escrow: a.escrow,
      block: "100",
      tuples: [],
      violations: [],
      ok: true,
    },
  };
}

test("replacement classifies every reachable prefix and rejects gaps", () => {
  assert.deepEqual(STEPS, [
    "deploy-vault",
    "deploy-policy",
    "initialize-controller",
    "deploy-hook",
    "authorize-hook",
    "set-risk-window:paypal",
    "set-risk-window:venmo",
    "add-policy-writer",
    "set-lifecycle-hook",
    "remove-superseded-writer",
  ]);
  for (let count = 0; count <= STEPS.length; count++) {
    const completed = STEPS.map((_, index) => index < count);
    assert.equal(
      replacement.classifyReplacement(completed, STEPS),
      count === STEPS.length ? null : count
    );
    if (count < STEPS.length - 1) {
      completed[count + 1] = true;
      assert.throws(() => replacement.classifyReplacement(completed, STEPS), /contiguous prefix/);
    }
  }
  assert.throws(() => replacement.classifyReplacement([], STEPS), /length/);
});
test("recording all three fresh pins retires replacement routing; partial recording fails closed", () => {
  const old = Object.fromEntries(Object.entries(SUPERSEDED).map(([name, address]) => [name, { address }]));
  assert.equal(replacement.replacementRecordingPending(old), true);
  const fresh = Object.fromEntries(Object.keys(SUPERSEDED).map((name, index) => [name, { address: address(100 + index) }]));
  assert.equal(replacement.replacementRecordingPending(fresh), false);
  assert.throws(() => replacement.replacementRecordingPending(undefined), /Missing/);
  assert.throws(() => replacement.replacementRecordingPending({ ...old, StakeVaultBypass: fresh.StakeVaultBypass }), /Partially/);
});
test("superseded records remain undeployed and only other addresses are replacements", () => {
  for (const name of /** @type {Array<keyof typeof SUPERSEDED>} */ (Object.keys(SUPERSEDED))) {
    assert.equal(replacement.isReplacement(name), false);
    assert.equal(replacement.isReplacement(name, SUPERSEDED[name].toLowerCase()), false);
    assert.equal(replacement.isReplacement(name, address(999)), true);
  }
});
test("stale executable builds, including metadata-only differences, are refused", () => {
  assert.throws(
    () => replacement.assertPolicyBuildChanged("0x60006001a10001", "0x60006001b10001"),
    /stale/
  );
  assert.throws(
    () => replacement.assertPolicyBuildChanged("0x60000000a10001", "0x60001234a10001"),
    /stale/
  );
  replacement.assertPolicyBuildChanged("0x60006002a10001", "0x60006001b10001");
});
test("artifact source hashes match case-insensitively and ignore package sources", () => {
  const metadata = JSON.stringify({
    sources: {
      "contracts/StakeVault.sol": { keccak256: "0xABCD" },
      "contracts/interfaces/IStakeVault.sol": { keccak256: "0x1234" },
      "@openzeppelin/contracts/access/Ownable.sol": { keccak256: "wrong" },
    },
  });
  replacement.assertArtifactSourcesCurrent("StakeVault", metadata, (name) => {
    assert.ok(name.startsWith("contracts/"));
    return name === "contracts/StakeVault.sol" ? "0xabcd" : "0x1234";
  });
});
test("changed and missing project sources name the stale artifact and source", () => {
  const metadata = JSON.stringify({
    sources: {
      "contracts/StakeVault.sol": { keccak256: hash(1) },
      "contracts/interfaces/IStakeVault.sol": { keccak256: hash(2) },
    },
  });
  for (const actual of [hash(3), undefined]) {
    assert.throws(
      () =>
        replacement.assertArtifactSourcesCurrent("StakeVault", metadata, (name) =>
          name === "contracts/StakeVault.sol" ? hash(1) : actual
        ),
      /Staging bypass replacement stale StakeVault artifact: contracts\/interfaces\/IStakeVault.sol.*compile before retrying/
    );
  }
});
test("invalid artifact metadata and missing project sources fail closed", () => {
  for (const metadata of [
    undefined,
    {},
    "{",
    "null",
    "[]",
    "{}",
    '{"sources":null}',
    '{"sources":[]}',
    '{"sources":{}}',
    '{"sources":{"@openzeppelin/contracts/access/Ownable.sol":{}}}',
    '{"sources":{"contracts/StakeVault.sol":null}}',
    '{"sources":{"contracts/StakeVault.sol":{}}}',
  ]) {
    assert.throws(
      () => replacement.assertArtifactSourcesCurrent("StakeVault", metadata, () => undefined),
      /Staging bypass replacement stale StakeVault artifact:.*compile before retrying/
    );
  }
});
test("real trio artifacts match this checkout's project sources", async () => {
  const hre = require("hardhat");
  assert.equal(hre.network.name, "hardhat");
  for (const name of ["StakeVault", "DisputeProtectionPolicy", "IntentLifecycleHookV1"]) {
    const artifact = await hre.deployments.getExtendedArtifact(name);
    replacement.assertArtifactSourcesCurrent(name, artifact.metadata, (sourceName) => {
      const filename = join(hre.config.paths.root, sourceName);
      return existsSync(filename) ? utils.keccak256(readFileSync(filename)) : undefined;
    });
  }
});
test("August predecessor metadata is a stale DisputeProtectionPolicy artifact", () => {
  const { metadata } = require("../deployments/base_staging/DisputeProtectionPolicyMethodScopedStaked.json");
  assert.throws(
    () =>
      replacement.assertArtifactSourcesCurrent("DisputeProtectionPolicy", metadata, (name) => {
        const filename = join(process.cwd(), name);
        return existsSync(filename) ? utils.keccak256(readFileSync(filename)) : undefined;
      }),
    /Staging bypass replacement stale DisputeProtectionPolicy artifact: contracts\/hooks\/DisputeProtectionPolicy.sol.*compile before retrying/
  );
});
test("mounted hook accepts superseded or replacement and rejects any third hook", () => {
  replacement.assertMountedHook(SUPERSEDED.IntentLifecycleHookV1Bypass);
  replacement.assertMountedHook(address(99), address(99));
  assert.throws(() => replacement.assertMountedHook(address(98), address(99)), /neither/);
});
test("superseded policy lifecycle activity blocks removal using the existing scanner", () => {
  classifyFreshStackActivity({ policyEvents: [] });
  for (const name of [
    "DisputeProtectionIntentOpened",
    "DisputeProtectionIntentCancelled",
    "DisputeProtectionIntentSettled",
    "DisputeProtectionIntentReleased",
    "DisputeResolved",
    "DisputeProtectionIntentStakeModeChanged",
  ]) {
    assert.throws(
      () =>
        classifyFreshStackActivity({
          policyEvents: [
            {
              name,
              blockNumber: replacement.SUPERSEDED_POLICY_BLOCK,
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: hash(1),
            },
          ],
        }),
      /activity|unclassified/
    );
  }
});
test("swap-and-pop retains August first and produces the lane-46 active row for new records", () => {
  const wanted = expected("base_staging");
  const a = wanted.addresses;
  const before = replacement.replacementWriters(a.predecessorPolicy, a.freshPolicy, true, false);
  assert.deepEqual(before, [
    a.predecessorPolicy,
    SUPERSEDED.DisputeProtectionPolicyBypass,
    a.freshPolicy,
  ]);
  before[1] = before[before.length - 1];
  before.pop();
  const after = replacement.replacementWriters(a.predecessorPolicy, a.freshPolicy, true, true);
  assert.deepEqual(before, after);
  const state = snapshot(wanted, 2 * wanted.paymentMethods.length + 4);
  state.disputeRegistry.writers = after;
  replacement.assertReplacementActive(state, wanted);
  state.disputeRegistry.writers.reverse();
  assert.throws(() => replacement.assertReplacementActive(state, wanted), /not lane-46 active/);
});
test("runner mounts only numbered lanes and never the shared replacement executor", () => {
  const scripts = selectActiveDeploymentScripts(
    process.cwd(),
    readdirSync("deploy").filter((name) => name.endsWith(".ts"))
  );
  assert.ok(scripts.some((script) => script.filename === "45_deploy_bypass_dispute_stack.ts"));
  assert.ok(scripts.some((script) => script.filename === "46_activate_bypass_dispute_stack.ts"));
  assert.ok(!scripts.some((script) => script.filename.includes("Replacement")));
  assert.ok(!readdirSync("deploy").some((name) => name.startsWith("47_")));
});

test("writer-removal scanner retains its historical start block after records are overwritten", async () => {
  const { assertSupersededUnused } = require("../deployments/stagingBypassReplacementExecution.ts");
  const { utils } = require("ethers");
  const artifact = require("../artifacts/contracts/hooks/DisputeProtectionPolicy.sol/DisputeProtectionPolicy.json");
  const iface = new utils.Interface(artifact.abi);
  const block = replacement.SUPERSEDED_POLICY_BLOCK;
  let activity = false;
  const hre = /** @type {any} */ ({
    deployments: { getExtendedArtifact: async () => artifact },
    ethers: {
      provider: {
        getLogs: async (/** @type {any} */ filter) => {
          assert.equal(filter.address, SUPERSEDED.DisputeProtectionPolicyBypass);
          assert.equal(filter.fromBlock, block);
          assert.equal(filter.toBlock, block);
          return activity
            ? [
                {
                  topics: [iface.getEventTopic("DisputeProtectionIntentOpened")],
                  blockNumber: block,
                  transactionIndex: 0,
                  logIndex: 0,
                  transactionHash: hash(77),
                },
              ]
            : [];
        },
      },
    },
  });
  await assertSupersededUnused(hre, block);
  activity = true;
  await assert.rejects(
    assertSupersededUnused(hre, block),
    /refuses to remove superseded writer.*lifecycle activity/
  );
});

test("pure replacement helper loads without Hardhat", () => {
  const { execFileSync } = require("node:child_process");
  execFileSync(
    process.execPath,
    [
      "-e",
      `
    require("ts-node/register/transpile-only");
    const Module = require("node:module");
    const original = Module._load;
    Module._load = function(name, ...args) {
      if (name === "hardhat" || name.startsWith("hardhat/")) throw new Error("Hardhat imported by pure helper");
      return original.call(this, name, ...args);
    };
    const helper = require("./deployments/stagingBypassReplacement.ts");
    require("node:assert/strict").equal(helper.isReplacement("StakeVaultBypass"), false);
  `,
    ],
    { cwd: process.cwd(), stdio: "pipe" }
  );
});

/** @param {Record<string, string | undefined>} values @param {() => Promise<void>} run */
async function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const lane45 = require("../deploy/45_deploy_bypass_dispute_stack.ts");
const lane46 = require("../deploy/46_activate_bypass_dispute_stack.ts");
const skip45 = /** @type {(hre: any) => Promise<boolean>} */ (lane45.default.skip);
const skip46 = /** @type {(hre: any) => Promise<boolean>} */ (lane46.default.skip);
const executor = require("../deployments/stagingBypassReplacementExecution.ts");
const stagingFlags = {
  DEPLOY_ACTIVE_TAG: lane46.TAG,
  [lane46.FLAGS.stagingPrepare]: undefined,
  [lane46.FLAGS.stagingExecute]: undefined,
  [lane46.FLAGS.baseCutoverPrepare]: undefined,
  [lane46.FLAGS.confirmActivation("base_staging")]: "true",
  [lane46.FLAGS.confirmDownstreamReady("base_staging")]: "true",
};

test("replacement entry rejects every non-staging network before RPC", async () => {
  for (const network of ["base", "localhost", "hardhat", "sepolia"]) {
    const hre = /** @type {any} */ ({ deployments: { getNetworkName: () => network } });
    assert.throws(() => executor.stagingReplacementRecordingPending(hre), /requires base_staging/);
    await assert.rejects(executor.runStagingBypassReplacement(hre, 45, "execute"), /requires base_staging/);
    await assert.rejects(executor.runStagingBypassReplacement(hre, 46, "prepare"), /requires base_staging/);
  }
});

test("tagged staging lane 45 intercepts abandoned records before the ordinary prepared loader", async (t) => {
  /** @type {unknown[][]} */
  const calls = [];
  t.mock.method(executor, "runStagingBypassReplacement", async (/** @type {unknown[]} */ ...args) => { calls.push(args.slice(1)); });
  const hre = /** @type {any} */ ({
    deployments: {
      getNetworkName: () => "base_staging",
      getOrNull: async (/** @type {keyof typeof SUPERSEDED} */ name) => ({ address: SUPERSEDED[name] || address(999) }),
    },
  });
  const flag = lane45.LIVE_FLAGS.base_staging;
  await withEnvironment({ DEPLOY_ACTIVE_TAG: "45_deploy_bypass_dispute_stack", [flag]: undefined }, async () => {
    await assert.rejects(skip45(hre), new RegExp(flag));
    await assert.rejects(lane45.default(hre), new RegExp(flag));
  });
  await withEnvironment({ DEPLOY_ACTIVE_TAG: "45_deploy_bypass_dispute_stack", [flag]: "true" }, async () => {
    assert.equal(await skip45(hre), false);
    assert.equal(await lane45.bypassDisputeStackPrepared(hre), false);
    await lane45.default(hre);
    assert.deepEqual(calls, [[45, "execute"]]);
  });
});

test("lane 46 preserves ordinary mode and confirmation validation before replacement dispatch", async (t) => {
  /** @type {unknown[][]} */
  const calls = [];
  t.mock.method(executor, "runStagingBypassReplacement", async (/** @type {unknown[]} */ ...args) => { calls.push(args.slice(1)); });
  const hre = /** @type {any} */ ({ deployments: { getNetworkName: () => "base_staging" } });
  await withEnvironment(stagingFlags, async () => {
    await assert.rejects(lane46.default(hre), /exactly one/);
    assert.equal(await skip46(hre), true);
  });
  await withEnvironment({ ...stagingFlags, [lane46.FLAGS.stagingPrepare]: "true", [lane46.FLAGS.stagingExecute]: "true" }, async () => {
    await assert.rejects(lane46.default(hre), /exactly one/);
    await assert.rejects(skip46(hre), /exactly one/);
  });
  for (const mode of ["prepare", "execute"]) {
    const flag = mode === "prepare" ? lane46.FLAGS.stagingPrepare : lane46.FLAGS.stagingExecute;
    for (const confirmation of [lane46.FLAGS.confirmActivation("base_staging"), lane46.FLAGS.confirmDownstreamReady("base_staging")]) {
      await withEnvironment({ ...stagingFlags, [flag]: "true", [confirmation]: undefined }, async () => {
        await assert.rejects(lane46.default(hre), new RegExp(confirmation));
      });
    }
    await withEnvironment({ ...stagingFlags, [flag]: "true" }, async () => {
      assert.equal(await skip46(hre), false);
      await lane46.default(hre);
    });
  }
  assert.deepEqual(calls, [[46, "prepare"], [46, "execute"]]);
});

test("Base lane entries and prepared checks never load the replacement module", async (t) => {
  const Module = /** @type {any} */ (require("node:module"));
  const original = Module._load;
  t.mock.method(Module, "_load", function (/** @type {string} */ name, /** @type {unknown[]} */ ...args) {
    assert.ok(!name.includes("stagingBypassReplacement"), "Base reached replacement module");
    return original.call(Module, name, ...args);
  });
  // Stop at the first ordinary I/O boundary; a replacement dispatch must not precede it.
  const ordinary = new Error("ordinary Base I/O");
  const hre = /** @type {any} */ ({
    deployments: { getNetworkName: () => "base", getOrNull: async () => { throw ordinary; } },
    getUnnamedAccounts: async () => { throw ordinary; },
    ethers: { provider: { getNetwork: async () => { throw ordinary; }, getBlockNumber: async () => { throw ordinary; } } },
  });
  await withEnvironment({ ...stagingFlags, DEPLOY_ACTIVE_TAG: "45_deploy_bypass_dispute_stack", [lane45.LIVE_FLAGS.base]: "true" }, async () => {
    await assert.rejects(skip45(hre), (error) => error === ordinary);
    await assert.rejects(lane45.bypassDisputeStackPrepared(hre), (error) => error === ordinary);
    await assert.rejects(lane45.default(hre), (error) => error === ordinary);
  });
  await withEnvironment({
    ...stagingFlags,
    [lane46.FLAGS.baseCutoverPrepare]: "true",
    [lane46.FLAGS.confirmActivation("base")]: "true",
    [lane46.FLAGS.confirmDownstreamReady("base")]: "true",
    [lane46.FLAGS.releaseReadySha]: undefined,
  }, async () => {
    assert.equal(await skip46(hre), false);
    await assert.rejects(lane46.default(hre), /exact CONFIRM_BASE_V3_DISPUTE_BYPASS_RELEASE_READY_SHA/);
  });
});

/** Load the real executor loop with isolated state/transaction I/O doubles. This keeps
 * test injection out of production's API; the prefix reducer and contract fixture test
 * state validity separately, while these cases verify which lane can send each step.
 * @param {number} initial
 */
function executorLoop(initial) {
  const { transpileModule, ModuleKind, ScriptTarget } = require("typescript");
  const { createRequire } = require("node:module");
  const { runInNewContext } = require("node:vm");
  const filename = join(process.cwd(), "deployments/stagingBypassReplacementExecution.ts");
  const compiled = transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 } }).outputText;
  const wanted = expected("base_staging");
  const complete = snapshot(wanted, 2 * wanted.paymentMethods.length + 4);
  let next = initial;
  let reads = 0;
  let nonce = 100;
  let scans = 0;
  let refuse = false;
  /** @type {number[]} */
  const sent = [];
  /** @type {string[]} */
  const printed = [];
  const exports = /** @type {any} */ ({});
  const io = {
    read: async () => { reads++; return { next: next === STEPS.length ? null : next, block: 100 }; },
    send: async (/** @type {any} */ _hre, /** @type {{ next: number }} */ state, /** @type {number} */ actualNonce) => {
      assert.equal(state.next, next);
      assert.equal(actualNonce, nonce);
      if (next === STEPS.length - 1 && refuse) throw new Error("refuses to remove superseded writer");
      sent.push(next++);
      nonce++;
    },
    scan: async () => { scans++; if (refuse) throw new Error("refuses to remove superseded writer"); },
    snapshot: async () => complete,
    context: async () => ({ expected: wanted }),
  };
  runInNewContext(compiled + `\nreadReplacementState = io.read; executeStep = io.send;
    assertSupersededUnused = io.scan; finalSnapshot = io.snapshot; finalContext = io.context;`, {
    require: createRequire(filename), exports, io,
    console: { log: (/** @type {string} */ text) => printed.push(text) },
  });
  const hre = {
    deployments: { getNetworkName: () => "base_staging" },
    ethers: { provider: { getTransactionCount: async () => nonce } },
  };
  return { sent, printed, complete, get reads() { return reads; }, get scans() { return scans; },
    refuse: () => { refuse = true; },
    run: (/** @type {45 | 46} */ lane, /** @type {"prepare" | "execute"} */ mode) => exports.runStagingBypassReplacement(hre, lane, mode),
  };
}

test("lane 45 stops at the deploy-only boundary; lane 46 resumes all activation steps and verifies active", async () => {
  const loop = executorLoop(0);
  await loop.run(45, "execute");
  assert.deepEqual(loop.sent, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(loop.reads, 8);
  assert.ok(loop.printed.some((text) => text.includes("run lane 46 next")));
  await loop.run(46, "execute");
  assert.deepEqual(loop.sent, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(loop.reads, 12);
  assert.ok(loop.printed.some((text) => text.includes("replacement active")));
  const before = loop.sent.length;
  await loop.run(46, "prepare");
  await loop.run(45, "execute");
  assert.equal(loop.sent.length, before);
});

test("every prefix resumes in its lane; prepare prints both lanes and sends nothing", async () => {
  for (let prefix = 0; prefix <= STEPS.length; prefix++) {
    const loop = executorLoop(prefix);
    await loop.run(46, "prepare");
    assert.deepEqual(loop.sent, []);
    assert.equal(loop.reads, 1);
    if (prefix < STEPS.length) {
      assert.ok(loop.printed[0].endsWith(STEPS.slice(prefix).join(" -> ")));
      assert.equal(loop.scans, 1);
    }
    if (prefix < 7) {
      await assert.rejects(loop.run(46, "execute"), /run lane 45 first/);
      assert.deepEqual(loop.sent, []);
      await loop.run(45, "execute");
      assert.deepEqual(loop.sent, Array.from({ length: 7 - prefix }, (_, index) => prefix + index));
    } else {
      await loop.run(45, "execute");
      assert.deepEqual(loop.sent, []);
      await loop.run(46, "execute");
      assert.deepEqual(loop.sent, Array.from({ length: STEPS.length - prefix }, (_, index) => prefix + index));
    }
  }
});

test("activity refusal retains the writer after the hook switch, and prepare reports refusal without sending", async () => {
  const loop = executorLoop(7);
  loop.refuse();
  await assert.rejects(loop.run(46, "prepare"), /refuses/);
  assert.deepEqual(loop.sent, []);
  await assert.rejects(loop.run(46, "execute"), /refuses/);
  assert.deepEqual(loop.sent, [7, 8]);
  await assert.rejects(loop.run(46, "execute"), /refuses/);
  assert.deepEqual(loop.sent, [7, 8]);
});

test("post-run prepare fails unless the fresh trio and unchanged predecessor reduce to exactly active", async () => {
  const loop = executorLoop(STEPS.length);
  loop.complete.orchestrator.lifecycleHook = SUPERSEDED.IntentLifecycleHookV1Bypass;
  await assert.rejects(loop.run(46, "prepare"), /not lane-46 active/);
  assert.deepEqual(loop.sent, []);
});

test("after recording, lane 46 prepare uses ordinary active verification without replacement I/O", async (t) => {
  const { BYPASS_RECORDED_DEPLOYMENTS } = require("../deployments/bypassDisputeStack.ts");
  const originalPins = BYPASS_RECORDED_DEPLOYMENTS.base_staging;
  assert.ok(originalPins);
  const wanted = expected("base_staging");
  const complete = snapshot(wanted, 2 * wanted.paymentMethods.length + 4);
  t.mock.method(executor, "runStagingBypassReplacement", async () => {
    assert.fail("Recorded staging must not enter replacement execution or verification");
  });
  const { transpileModule, ModuleKind, ScriptTarget } = require("typescript");
  const { createRequire } = require("node:module");
  const { runInNewContext } = require("node:vm");
  const filename = join(process.cwd(), "deploy/46_activate_bypass_dispute_stack.ts");
  const compiled = transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
  }).outputText;
  const exports = /** @type {any} */ ({});
  /** @type {string[]} */
  const printed = [];
  let reads = 0;
  // Stub only ordinary chain reads, leaving dispatch, reduction and active reporting intact.
  const io = {
    snapshot: async () => { reads++; return complete; },
    expected: () => wanted,
  };
  runInNewContext(compiled + `\nassertBypassActivationSharedState = io.snapshot;
    expectedBypassActivationState = io.expected;`, {
    require: createRequire(filename), exports, io, process,
    console: { log: (/** @type {string} */ text) => printed.push(text) },
  });
  try {
    BYPASS_RECORDED_DEPLOYMENTS.base_staging = {
      ...originalPins,
      StakeVaultBypass: { address: wanted.addresses.freshVault, runtimeCodeHash: hash(4) },
      DisputeProtectionPolicyBypass: { address: wanted.addresses.freshPolicy, runtimeCodeHash: hash(5) },
      IntentLifecycleHookV1Bypass: { address: wanted.addresses.freshHook, runtimeCodeHash: hash(6) },
    };
    const hre = /** @type {any} */ ({
      deployments: { getNetworkName: () => "base_staging" },
      ethers: { provider: { getBlockNumber: async () => 100 } },
    });
    assert.equal(executor.stagingReplacementRecordingPending(hre), false);
    await withEnvironment({ ...stagingFlags, [lane46.FLAGS.stagingPrepare]: "true" }, async () => {
      await exports.default(hre);
    });
    assert.equal(reads, 1);
    assert.ok(printed[0].includes("base_staging bypass dispute activation is active"));
    assert.deepEqual(JSON.parse(printed[1]), complete);
  } finally {
    BYPASS_RECORDED_DEPLOYMENTS.base_staging = originalPins;
  }
});
