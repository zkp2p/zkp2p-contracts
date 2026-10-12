#!/usr/bin/env node
require(require.resolve("ts-node/register/transpile-only"));
require(require.resolve("module-alias/register"));
const aliases = require(require.resolve("module-alias"));
aliases.reset();
aliases.addAlias("@utils", process.cwd() + "/utils");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { utils } = require("ethers");
const model = require("../deployments/bypassDisputeActivation.ts");
const replacement = require("../deployments/stagingBypassReplacement.ts");
const { selectActiveDeploymentScripts } = require("../deployments/immutableDeploymentLanes.ts");
const {
  classifyFreshStackActivity,
} = require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts");
const { SUPERSEDED, LIVE_FLAGS, LANE_47_TAG } = replacement;
const { LANE_45_STEP_KINDS } = require("../deployments/bypassDisputeStack.ts");
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

test("lane 47 classifies every reachable prefix and rejects gaps", () => {
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
test("lane 47 refuses Base and unflagged or conflicting tagged execution; all untagged runs skip", () => {
  const tagged = { DEPLOY_ACTIVE_TAG: LANE_47_TAG };
  for (const network of ["base", "base_staging", "localhost", "hardhat", "sepolia"]) {
    assert.equal(replacement.replacementMode(network, {}), "skip");
    assert.equal(replacement.replacementMode(network, { [LIVE_FLAGS.execute]: "true" }), "skip");
  }
  assert.throws(() => replacement.replacementMode("base", tagged), /staging-only/);
  assert.throws(() => replacement.replacementMode("base_staging", tagged), /exactly one/);
  assert.throws(
    () =>
      replacement.replacementMode("base_staging", {
        ...tagged,
        [LIVE_FLAGS.prepare]: "true",
        [LIVE_FLAGS.execute]: "true",
      }),
    /exactly one/
  );
  for (const mode of ["prepare", "execute"])
    assert.equal(
      replacement.replacementMode("base_staging", {
        ...tagged,
        [LIVE_FLAGS[/** @type {"prepare" | "execute"} */ (mode)]]: "true",
      }),
      mode
    );
  assert.equal(replacement.replacementMode("localhost", tagged), "skip");
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
      /Lane 47 stale StakeVault artifact: contracts\/interfaces\/IStakeVault.sol.*compile before retrying/
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
      /Lane 47 stale StakeVault artifact:.*compile before retrying/
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
    /Lane 47 stale DisputeProtectionPolicy artifact: contracts\/hooks\/DisputeProtectionPolicy.sol.*compile before retrying/
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
test("runner mounts lane 47 without changing immutable inventory or Base lanes", () => {
  const scripts = selectActiveDeploymentScripts(
    process.cwd(),
    readdirSync("deploy").filter((name) => name.endsWith(".ts"))
  );
  assert.ok(scripts.some((script) => script.filename === `${LANE_47_TAG}.ts`));
});

test("lane entry and skip reject unauthorized execution before any RPC access", async () => {
  const lane =
    /** @type {import("hardhat-deploy/types").DeployFunction & { skip: (hre: any) => Promise<boolean> }} */ (
      require("../deploy/47_replace_staging_bypass_stack.ts").default
    );
  const previous = {
    tag: process.env.DEPLOY_ACTIVE_TAG,
    prepare: process.env[LIVE_FLAGS.prepare],
    execute: process.env[LIVE_FLAGS.execute],
  };
  const hre = /** @type {any} */ ({
    deployments: { getNetworkName: () => "base" },
  });
  try {
    process.env.DEPLOY_ACTIVE_TAG = LANE_47_TAG;
    delete process.env[LIVE_FLAGS.prepare];
    delete process.env[LIVE_FLAGS.execute];
    await assert.rejects(lane.skip(hre), /staging-only/);
    await assert.rejects(lane(hre), /staging-only/);
    hre.deployments.getNetworkName = () => "base_staging";
    await assert.rejects(lane.skip(hre), /exactly one/);
    await assert.rejects(lane(hre), /exactly one/);
    delete process.env.DEPLOY_ACTIVE_TAG;
    assert.equal(await lane.skip(hre), true);
    await lane(hre);
  } finally {
    for (const [key, value] of Object.entries({
      DEPLOY_ACTIVE_TAG: previous.tag,
      [LIVE_FLAGS.prepare]: previous.prepare,
      [LIVE_FLAGS.execute]: previous.execute,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
test("writer-removal scanner retains its historical start block after records are overwritten", async () => {
  const { assertSupersededUnused } = require("../deploy/47_replace_staging_bypass_stack.ts");
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
    require("node:assert/strict").equal(helper.replacementMode("base_staging", {}), "skip");
  `,
    ],
    { cwd: process.cwd(), stdio: "pipe" }
  );
});
