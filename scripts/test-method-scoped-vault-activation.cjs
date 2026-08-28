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
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { utils } = require("ethers");

/** @param {number} value */
const address = (value) => `0x${value.toString(16).padStart(40, "0")}`;
/** @param {number} value */
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const ZERO = address(0);

/** @param {string} prefix */
function temporaryGitRepository(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "tracked"), "base\n");
  execFileSync("git", ["add", "tracked"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Vault Activation",
      "-c",
      "user.email=vault-activation@example.invalid",
      "commit",
      "-qm",
      "base",
    ],
    { cwd: root }
  );
  return {
    root,
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  };
}

/** @param {{ root: string }} repository @param {string[]} paths */
function commitRepositoryPaths(repository, paths) {
  for (const path of paths) {
    mkdirSync(dirname(join(repository.root, path)), { recursive: true });
    writeFileSync(join(repository.root, path), `${path}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: repository.root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Vault Activation",
      "-c",
      "user.email=vault-activation@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: repository.root }
  );
}

test("vault artifact-child verification permits unrelated changes", () => {
  const {
    assertActivationArtifactGitState,
  } = require("./verify-method-scoped-safe-batch.ts");
  const repository = temporaryGitRepository("vault-activation-unrelated-");
  commitRepositoryPaths(repository, [
    "README.md",
    "deployments/outputs/safe-batches/base_optin_writer_removal.json",
    ".github/workflows/x.yml",
  ]);
  assert.doesNotThrow(() =>
    assertActivationArtifactGitState(
      repository.root,
      repository.sourceSha,
      "artifact-child"
    )
  );
});

test("vault artifact-child verification rejects protected changes", () => {
  const {
    assertActivationArtifactGitState,
  } = require("./verify-method-scoped-safe-batch.ts");
  for (const protectedPath of [
    "deploy/40_activate_method_scoped_vault_stack.ts",
    "contracts/mocks/VaultProtected.sol",
    "scripts/verify-method-scoped-safe-batch.ts",
    "deployments/base/StakeVaultMethodScoped.json",
  ]) {
    const repository = temporaryGitRepository("vault-activation-protected-");
    commitRepositoryPaths(repository, [protectedPath]);
    assert.throws(
      () =>
        assertActivationArtifactGitState(
          repository.root,
          repository.sourceSha,
          "artifact-child"
        ),
      new RegExp(protectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  }
});

const vaultAddresses = {
  safe: address(1),
  deployer: address(2),
  escrow: address(3),
  predecessorVault: address(4),
  freshVault: address(5),
  predecessorPolicy: address(6),
  freshPolicy: address(7),
  predecessorHook: address(8),
  freshHook: address(9),
  registry: address(10),
  orchestrator: address(11),
  orchestratorRegistry: address(12),
  escrowRegistry: address(13),
  paymentVerifierRegistry: address(14),
  relayerRegistry: address(15),
  protocolFeeRecipient: address(16),
  whitelistPolicy: address(17),
  groupRegistry: address(18),
  attestationVerifier: address(19),
  disputeVerifier: address(20),
  nullifierRegistryV2: address(21),
  stakeToken: address(22),
};

/** @returns {import("../deployments/vaultMethodScopedActivation").VaultExpectedActivationState} */
function expected() {
  return {
    network: "base",
    governance: vaultAddresses.safe,
    deployer: vaultAddresses.deployer,
    addresses: vaultAddresses,
    riskWindows: { [hash(100)]: "86400" },
    witnesses: [address(30)],
    controllerChangeDelay: "172800",
    allowMultipleIntents: true,
    predecessorVaultPendingController: ZERO,
    predecessorAdmissionsPaused: false,
  };
}

/** @returns {import("../deployments/vaultMethodScopedActivation").VaultActivationSnapshot} */
function snapshot() {
  const wanted = expected();
  return {
    network: "base",
    blockNumber: 100,
    blockHash: hash(100),
    blockTimestamp: "1000",
    freshPolicy: {
      owner: vaultAddresses.deployer,
      pendingOwner: vaultAddresses.safe,
      admissionsPaused: false,
      disputeVerifier: vaultAddresses.disputeVerifier,
      disputeNullifierRegistry: vaultAddresses.registry,
      stakeVault: vaultAddresses.freshVault,
      authorizedHooks: [vaultAddresses.freshHook],
      riskWindows: { ...wanted.riskWindows },
    },
    predecessorPolicy: {
      owner: vaultAddresses.safe,
      pendingOwner: ZERO,
      admissionsPaused: false,
      disputeVerifier: vaultAddresses.disputeVerifier,
      disputeNullifierRegistry: vaultAddresses.registry,
      stakeVault: vaultAddresses.predecessorVault,
    },
    disputeVerifier: {
      owner: vaultAddresses.safe,
      pendingOwner: ZERO,
      attestationVerifier: vaultAddresses.attestationVerifier,
      nullifierRegistry: vaultAddresses.nullifierRegistryV2,
    },
    freshVault: {
      owner: vaultAddresses.deployer,
      pendingOwner: vaultAddresses.safe,
      controller: vaultAddresses.freshPolicy,
      pendingController: ZERO,
      pendingControllerValidAt: "0",
      controllerChangeDelay: "172800",
      stakeToken: vaultAddresses.stakeToken,
    },
    predecessorVault: { pendingController: ZERO },
    registry: {
      owner: vaultAddresses.safe,
      writers: [vaultAddresses.predecessorPolicy],
    },
    orchestrator: {
      owner: vaultAddresses.safe,
      paused: false,
      lifecycleHook: vaultAddresses.predecessorHook,
      escrowRegistry: vaultAddresses.escrowRegistry,
      paymentVerifierRegistry: vaultAddresses.paymentVerifierRegistry,
      relayerRegistry: vaultAddresses.relayerRegistry,
      protocolFee: "0",
      protocolFeeRecipient: vaultAddresses.protocolFeeRecipient,
      allowMultipleIntents: true,
      registered: true,
    },
    freshHook: {
      orchestratorRegistry: vaultAddresses.orchestratorRegistry,
      whitelistPolicy: vaultAddresses.whitelistPolicy,
      disputeProtectionPolicy: vaultAddresses.freshPolicy,
    },
    whitelistPolicy: {
      owner: vaultAddresses.safe,
      escrowRegistry: vaultAddresses.escrowRegistry,
      groupRegistry: vaultAddresses.groupRegistry,
      orchestratorRegistry: vaultAddresses.orchestratorRegistry,
    },
    attestationVerifier: {
      owner: vaultAddresses.safe,
      requiredSignatures: "1",
      witnesses: [...wanted.witnesses],
    },
    lockProof: {
      fromBlock: 1,
      toBlock: 100,
      intents: [],
      releasable: [],
      blocking: [],
      earliestMaturity: null,
      ok: true,
    },
    inventory: {
      escrow: vaultAddresses.escrow,
      depositCounter: "0",
      block: 100,
      tuples: [],
      violations: [],
      ok: true,
    },
  };
}

const ACTION_ENV = [
  "PREPARE_STAGING_V3_DISPUTE_METHOD_SCOPED_VAULT_ACTIVATION",
  "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_VAULT_ACTIVATION",
  "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_CUTOVER_PREPARATION",
  "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_WRITER_REMOVAL_PREPARATION",
  "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_RELEASE_MATURED",
];

/** @param {string} network */
function fakeHre(network) {
  return {
    deployments: {
      getNetworkName: () => network,
      getOrNull: () => {
        throw new Error("untagged lane read chain state");
      },
    },
    ethers: {
      provider: {
        getBlockNumber: () => {
          throw new Error("untagged lane read chain state");
        },
      },
    },
  };
}

/** @param {() => Promise<void> | void} run */
function withCleanLaneEnv(run) {
  const names = ["DEPLOY_ACTIVE_TAG", ...ACTION_ENV];
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  );
  names.forEach((name) => delete process.env[name]);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
}

test("lane 40 exposes the dedicated-vault activation identity", () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const exports = /** @type {Record<string, unknown>} */ (lane);
  assert.equal(lane.TAG, "40_activate_method_scoped_vault_stack");
  assert.deepEqual(lane.default.tags, [
    lane.TAG,
    "V3DisputeMethodScopedVaultActivation",
  ]);
  assert.deepEqual(lane.default.dependencies, []);
  assert.deepEqual([...lane.SUPPORTED_NETWORKS], ["base_staging", "base"]);
  for (const name of [
    "loadVaultActivationContext",
    "expectedVaultActivationState",
    "readVaultActivationSnapshot",
    "runPinnedSimulation",
  ]) {
    assert.equal(typeof exports[name], "function", `${name} export`);
  }
});

test("lane 40 context binds fresh records and the staging predecessor transition pins", async () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const {
    METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS,
  } = require("../deployments/predecessorDisputeStack.ts");
  const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS.base_staging;
  const records = {
    EscrowV2: { address: address(100), receipt: { blockNumber: 1 } },
    WhitelistPolicyMethodScoped: {
      address: address(101),
      receipt: { blockNumber: 1 },
    },
    StakeVaultMethodScoped: {
      address: address(102),
      receipt: { blockNumber: 1 },
    },
    DisputeProtectionPolicyMethodScopedStaked: {
      address: address(103),
      receipt: { blockNumber: 1 },
    },
    IntentLifecycleHookV1MethodScopedStaked: {
      address: address(104),
      receipt: { blockNumber: 1 },
    },
    StakeVault: {
      address: predecessor.contracts.StakeVault.address,
      receipt: { blockNumber: 1 },
    },
    DisputeProtectionPolicy: {
      address: predecessor.contracts.DisputeProtectionPolicy.address,
      receipt: { blockNumber: 1 },
    },
  };
  const hre = /** @type {any} */ ({
    getUnnamedAccounts: async () => [
      "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    ],
    deployments: {
      /** @param {keyof typeof records} name */
      getOrNull: async (name) => records[name] || null,
    },
    ethers: { utils, constants: { AddressZero: ZERO } },
  });
  await lane.loadVaultActivationContext(hre, "base_staging");
  const wanted = lane.expectedVaultActivationState("base_staging");
  assert.equal(wanted.addresses.freshVault, address(102));
  assert.equal(
    wanted.addresses.predecessorVault.toLowerCase(),
    predecessor.contracts.StakeVault.address.toLowerCase()
  );
  assert.equal(
    wanted.predecessorVaultPendingController,
    "0x0173caa95ecfc1c314c26766fb037d44cc71b42d"
  );
  assert.equal(wanted.predecessorAdmissionsPaused, true);
});

test("untagged lane 40 skips before chain reads on every network", async () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const laneFunction = /** @type {any} */ (lane.default);
  await withCleanLaneEnv(async () => {
    for (const network of [
      "localhost",
      "hardhat",
      "base_staging",
      "base",
      "sepolia",
    ]) {
      assert.equal(await laneFunction.skip(fakeHre(network)), true, network);
    }
  });
});

test("lane 40 flags require the exact tag before every chain read", async () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const laneFunction = /** @type {any} */ (lane.default);
  await withCleanLaneEnv(async () => {
    for (const flag of ACTION_ENV) {
      process.env[flag] = "true";
      await assert.rejects(
        () => laneFunction.skip(fakeHre("base")),
        /Lane 40 flags require DEPLOY_ACTIVE_TAG=40_activate_method_scoped_vault_stack/
      );
      delete process.env[flag];
    }
  });
});

test("tagged lane 40 rejects local networks and invalid action selections", async () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const laneFunction = /** @type {any} */ (lane.default);
  await withCleanLaneEnv(async () => {
    process.env.DEPLOY_ACTIVE_TAG = lane.TAG;
    await assert.rejects(
      () => laneFunction.skip(fakeHre("localhost")),
      /no predecessor stack on local networks/
    );
    process.env[lane.FLAGS.stagingPrepare] = "true";
    process.env[lane.FLAGS.stagingExecute] = "true";
    await assert.rejects(
      () => laneFunction.skip(fakeHre("base_staging")),
      /Set exactly one of/
    );
    delete process.env[lane.FLAGS.stagingPrepare];
    delete process.env[lane.FLAGS.stagingExecute];
    process.env[lane.FLAGS.baseCutoverPrepare] = "true";
    process.env[lane.FLAGS.baseWriterRemovalPrepare] = "true";
    await assert.rejects(
      () => laneFunction.skip(fakeHre("base")),
      /Select exactly one Base lane-40 action flag/
    );
  });
});

test("Base lane-40 phase gates permit only deployed cutover and drained active writer removal", () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const deployed = snapshot();
  assert.equal(
    lane.assertBaseVaultActionPhase("vault-cutover", deployed, expected()),
    true
  );
  assert.throws(
    () =>
      lane.assertBaseVaultActionPhase(
        "vault-writer-removal",
        deployed,
        expected()
      ),
    /requires active/
  );
  const active = snapshot();
  active.freshVault.owner = vaultAddresses.safe;
  active.freshVault.pendingOwner = ZERO;
  active.freshPolicy.owner = vaultAddresses.safe;
  active.freshPolicy.pendingOwner = ZERO;
  active.registry.writers = [
    vaultAddresses.predecessorPolicy,
    vaultAddresses.freshPolicy,
  ];
  active.orchestrator.lifecycleHook = vaultAddresses.freshHook;
  assert.equal(
    lane.assertBaseVaultActionPhase("vault-writer-removal", active, expected()),
    true
  );
  active.lockProof.ok = false;
  active.lockProof.blocking = [hash(900)];
  assert.throws(
    () =>
      lane.assertBaseVaultActionPhase(
        "vault-writer-removal",
        active,
        expected()
      ),
    /with no waiting condition/
  );
});

test("active and writer-removed Base reruns are successful no-ops", () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const active = snapshot();
  active.registry.writers = [
    vaultAddresses.predecessorPolicy,
    vaultAddresses.freshPolicy,
  ];
  active.orchestrator.lifecycleHook = vaultAddresses.freshHook;
  assert.equal(
    lane.assertBaseVaultActionPhase("vault-cutover", active, expected()),
    false
  );
  const removed = snapshot();
  removed.registry.writers = [vaultAddresses.freshPolicy];
  removed.orchestrator.lifecycleHook = vaultAddresses.freshHook;
  assert.equal(
    lane.assertBaseVaultActionPhase(
      "vault-writer-removal",
      removed,
      expected()
    ),
    false
  );
});

test("release-matured calldata contains only the supplied releasable hashes", () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const releasable = [hash(501), hash(503)];
  const transaction = lane.buildVaultReleaseMaturedTransaction(
    vaultAddresses.predecessorPolicy,
    releasable,
    utils.Interface
  );
  const iface = new utils.Interface([
    "function releaseMaturedDisputeProtectionIntents(bytes32[] intentHashes)",
  ]);
  assert.equal(transaction.to, vaultAddresses.predecessorPolicy);
  assert.deepEqual(
    iface.decodeFunctionData(
      "releaseMaturedDisputeProtectionIntents",
      transaction.data
    )[0],
    releasable
  );
});

test("staging advance accepts exactly one dedicated-vault action", () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  lane.assertVaultStagingAdvance(
    {
      phase: "deployed",
      nextStagingAction: "add-fresh-writer",
      waiting: null,
      violations: [],
    },
    {
      phase: "cutover-pending",
      nextStagingAction: "set-fresh-hook",
      waiting: null,
      violations: [],
    }
  );
  assert.throws(
    () =>
      lane.assertVaultStagingAdvance(
        {
          phase: "deployed",
          nextStagingAction: "add-fresh-writer",
          waiting: null,
          violations: [],
        },
        {
          phase: "active",
          nextStagingAction: "remove-predecessor-writer",
          waiting: null,
          violations: [],
        }
      ),
    /exactly one step/
  );
});
