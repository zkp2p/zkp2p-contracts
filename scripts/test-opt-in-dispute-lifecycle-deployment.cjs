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
const { execFileSync, spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { test } = require("node:test");

const lane34Module = require("../deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts");
const { PREDECESSOR_DISPUTE_STACKS } = require(
  "../deployments/predecessorDisputeStack.ts"
);
const readinessEvidence = require("../deployments/dispute-readiness-evidence.json");
const { MULTI_SIG } = require("../deployments/parameters.ts");
const {
  DEPLOY_ONLY_STEP_KINDS,
  EXPECTED_LIVE,
  LIVE_SUCCESSOR_DEPLOYMENT_NAMES,
  LOCAL_DISPUTE_DEPLOYMENT_NAMES,
  classifyDeployOnlyPrefix,
  classifyLiveDisputePhase,
  getSuccessorDeployments,
  ownershipStepState,
  requireLocalPaymentBindingReady,
} = lane34Module;
const {
  selectVerificationDeployments,
  verifyDeployments,
} = require("../tasks/etherscanVerifyWithDelay.ts");
const {
  buildDeployArguments,
  runActiveDeployment,
} = require("./deployActive.ts");
const {
  IMMUTABLE_DEPLOYMENT_LANES,
  assertImmutableDeploymentLanes,
  assertSupportedDeploymentTag,
  selectActiveDeploymentScripts,
} = require("../deployments/immutableDeploymentLanes.ts");
const {
  canonicalTransactionBytes,
  canonicalTransactionHash,
  validateSafeBatchManifest,
} = require("../deployments/safeBatchManifest.ts");
const {
  appendSimulationPostcondition,
  decodeSafeSimulationEnvelope,
  encodeMultiSendCalldata,
  packMultiSendTransactions,
  requireRuntimeHash,
  restoreHardhatModuleResolution,
  voidCallDidNotSucceed,
} = require("./simulate-dispute-opt-in-safe-batch.ts");
const {
  DISPUTE_SAFE_BATCH_PATH,
  DISPUTE_SAFE_SIDECAR_PATH,
  assertBatchMatchesManifest,
  assertSafeArtifactGitState,
} = require("./verify-dispute-opt-in-safe-batch.ts");

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

test("live dependency pins use deployed runtime hashes", () => {
  assert.deepEqual(
    {
      base: {
        whitelistPolicy: EXPECTED_LIVE.base.whitelistPolicyCodeHash,
        nullifierRegistryV2: EXPECTED_LIVE.base.nullifierRegistryV2CodeHash,
      },
      base_staging: {
        whitelistPolicy: EXPECTED_LIVE.base_staging.whitelistPolicyCodeHash,
        nullifierRegistryV2:
          EXPECTED_LIVE.base_staging.nullifierRegistryV2CodeHash,
      },
    },
    {
      base: {
        whitelistPolicy:
          "0xa3cf0fdf3835887de432cbac9c192edf6c93a8589748aa93f8294333d57024b2",
        nullifierRegistryV2:
          "0x423e2a2183ecd538864079b6268f41957028c25514d1de57bd3d0e70fa6b9bd4",
      },
      base_staging: {
        whitelistPolicy:
          "0x917965fdc75580147ad0787c86f8b2a0f0185ef6e101567b82dc1245d6eb63bc",
        nullifierRegistryV2:
          "0xd9d2f4b8bbca6fe26d7a0dfd7e0d6a6d63823ab2a1fe12971e752cf33dee72a0",
      },
    }
  );
});

test("package readiness evidence stays pinned to the immutable predecessor and lane 34 live dependencies", () => {
  for (const network of /** @type {Array<"base" | "base_staging">} */ ([
    "base",
    "base_staging",
  ])) {
    const evidence = readinessEvidence.networks[network];
    const predecessor = PREDECESSOR_DISPUTE_STACKS[network];
    const live = EXPECTED_LIVE[network];

    assert.deepEqual(evidence.recognizedPredecessorHook, predecessor.activeLifecycleHook);
    assert.deepEqual(evidence.recognizedPredecessorPolicy, {
      address: predecessor.contracts.DisputeProtectionPolicy.address,
      runtimeCodeHash: predecessor.contracts.DisputeProtectionPolicy.runtimeCodeHash,
    });
    for (const contractName of /** @type {Array<"DisputeVerifier" | "DisputeNullifierRegistry">} */ ([
      "DisputeVerifier",
      "DisputeNullifierRegistry",
    ])) {
      assert.equal(evidence.addresses[contractName], predecessor.contracts[contractName].address);
      assert.equal(
        evidence.runtimeCodeHashes[contractName],
        predecessor.contracts[contractName].runtimeCodeHash
      );
    }
    assert.equal(evidence.addresses.OrchestratorV3, live.orchestrator);
    assert.equal(evidence.runtimeCodeHashes.OrchestratorV3, live.orchestratorCodeHash);
    assert.equal(evidence.addresses.OrchestratorRegistry, live.orchestratorRegistry);
    assert.equal(
      evidence.runtimeCodeHashes.OrchestratorRegistry,
      live.orchestratorRegistryCodeHash
    );
    assert.equal(evidence.addresses.WhitelistPolicy, live.whitelistPolicy);
    assert.equal(evidence.runtimeCodeHashes.WhitelistPolicy, live.whitelistPolicyCodeHash);
    assert.equal(evidence.addresses.MultiAttestationVerifier, live.attestationVerifier);
    assert.equal(
      evidence.runtimeCodeHashes.MultiAttestationVerifier,
      live.attestationVerifierCodeHash
    );
    assert.deepEqual(evidence.governance, {
      owner: MULTI_SIG[network] || live.deployer,
      pendingOwner: "0x0000000000000000000000000000000000000000",
    });
    assert.deepEqual(evidence.attestationTrust, {
      requiredSignatures: "1",
      witnesses: live.attestationWitnesses,
    });
    assert.deepEqual(evidence.addressExpectations, {
      AddressGroupRegistry: live.addressGroupRegistry,
      EscrowRegistry: live.escrowRegistry,
      PaymentVerifierRegistry: live.paymentVerifierRegistry,
      RelayerRegistry: live.relayerRegistry,
      NullifierRegistryV2: live.nullifierRegistryV2,
      StakeToken: live.stakeToken,
    });
  }
});

test("missing successor deployment records normalize to the absent state", async () => {
  const deployments = await getSuccessorDeployments(
    /** @type {any} */ ({
      deployments: {
        getOrNull: async () => undefined,
      },
    })
  );
  assert.deepEqual(deployments, [null, null, null]);
});

test("live deployment fails closed without the network opt-in flag", async () => {
  const previous = process.env.ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT;
  const previousTag = process.env.DEPLOY_ACTIVE_TAG;
  delete process.env.ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT;
  delete process.env.DEPLOY_ACTIVE_TAG;
  try {
    await assert.rejects(
      lane34Module.default(
        /** @type {any} */ ({
          deployments: { getNetworkName: () => "base" },
        })
      ),
      /ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT=true/
    );
    assert.equal(
      await lane34Module.default.skip?.(
        /** @type {any} */ ({
          deployments: {
            getNetworkName: () => "base",
            getOrNull: async () => null,
          },
        })
      ),
      true
    );
  } finally {
    if (previous === undefined)
      delete process.env.ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT;
    else process.env.ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT = previous;
    if (previousTag === undefined) delete process.env.DEPLOY_ACTIVE_TAG;
    else process.env.DEPLOY_ACTIVE_TAG = previousTag;
  }
});

test("the deploy-only state machine accepts only a contiguous prefix", () => {
  for (const network of /** @type {Array<"base_staging" | "base">} */ ([
    "base_staging",
    "base",
  ])) {
    const empty = DEPLOY_ONLY_STEP_KINDS[network].map(() => false);
    assert.deepEqual(classifyDeployOnlyPrefix(network, empty), {
      phase: "absent",
      nextStep: 0,
    });

    for (
      let prefixLength = 1;
      prefixLength <= empty.length;
      prefixLength += 1
    ) {
      const state = empty.map((_, index) => index < prefixLength);
      const result = classifyDeployOnlyPrefix(network, state);
      assert.equal(
        result.nextStep,
        prefixLength === state.length ? null : prefixLength
      );
      assert.equal(
        result.phase,
        prefixLength === state.length ? "prepared" : "partial"
      );
    }

    const nonPrefix = [...empty];
    nonPrefix[1] = true;
    assert.throws(
      () => classifyDeployOnlyPrefix(network, nonPrefix),
      /not a contiguous prefix/
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
    DEPLOY_ONLY_STEP_KINDS.base_staging.length + 4
  );
});

test("live lifecycle and writer combinations have explicit phases", () => {
  assert.equal(
    classifyLiveDisputePhase({
      artifacts: 0,
      configured: false,
      currentHook: "predecessor",
      writers: "predecessor",
    }),
    "absent"
  );
  assert.equal(
    classifyLiveDisputePhase({
      artifacts: 2,
      configured: false,
      currentHook: "predecessor",
      writers: "predecessor",
    }),
    "partial"
  );
  assert.equal(
    classifyLiveDisputePhase({
      artifacts: 3,
      configured: false,
      currentHook: "predecessor",
      writers: "predecessor",
    }),
    "deployed"
  );
  assert.equal(
    classifyLiveDisputePhase({
      artifacts: 3,
      configured: true,
      currentHook: "predecessor",
      writers: "predecessor",
    }),
    "prepared"
  );
  assert.equal(
    classifyLiveDisputePhase({
      artifacts: 3,
      configured: true,
      currentHook: "successor",
      writers: "both",
    }),
    "active"
  );
  assert.throws(
    () =>
      classifyLiveDisputePhase({
        artifacts: 3,
        configured: true,
        currentHook: "successor",
        writers: "predecessor",
      }),
    /Invalid live dispute phase/
  );
});

test("local activation and live ownership checks fail closed on drift", () => {
  assert.throws(
    () => requireLocalPaymentBindingReady(false),
    /must be fully cut over/
  );
  assert.doesNotThrow(() => requireLocalPaymentBindingReady(true));
  const zero = "0x0000000000000000000000000000000000000000";
  const deployer = "0x0000000000000000000000000000000000000001";
  const governance = "0x0000000000000000000000000000000000000002";
  assert.equal(
    ownershipStepState(deployer, zero, deployer, governance, "vault"),
    false
  );
  assert.equal(
    ownershipStepState(deployer, governance, deployer, governance, "vault"),
    true
  );
  assert.throws(
    () =>
      ownershipStepState(governance, deployer, deployer, governance, "vault"),
    /owner or pending owner drifted/
  );
});

test("active deployment arguments always use the filtered deployment directory", () => {
  assert.deepEqual(
    buildDeployArguments(
      "base",
      "/tmp/active-deployments",
      "34_deploy_opt_in_dispute_lifecycle_stack"
    ),
    [
      "deploy",
      "--network",
      "base",
      "--tags",
      "34_deploy_opt_in_dispute_lifecycle_stack",
      "--no-compile",
      "--deploy-scripts",
      "/tmp/active-deployments",
    ]
  );
  assert.deepEqual(buildDeployArguments("base", "/tmp/active-deployments"), [
    "deploy",
    "--network",
    "base",
    "--deploy-scripts",
    "/tmp/active-deployments",
  ]);
});

test("immutable lane manifest pins the exact deployed sources", () => {
  assert.deepEqual(IMMUTABLE_DEPLOYMENT_LANES, {
    "30_deploy_v3_lifecycle_stack.ts": {
      deployedSourceSha: "3c4c1306dcce6693cf32300d8917d45c4604b84e",
      sha256:
        "97ed83a35e91167186da7a1bde9d3534e6eced436a843a0afd07c0f055bf20fa",
      activeSource:
        "deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts",
      retired: false,
      tags: [
        "30_deploy_v3_lifecycle_stack",
        "V3LifecycleStack",
        "OrchestratorV3",
      ],
    },
    "32_deploy_and_activate_dispute_lifecycle_stack.ts": {
      deployedSourceSha: "d5558c2888c9246448e1926135fd0c2cbeceb3e4",
      sha256:
        "e103f2b9eb4168504cb226a6191a05c432e313ca5b649b0cc2a3d77fb3a5d283",
      activeSource: null,
      retired: true,
      tags: [
        "32_deploy_and_activate_dispute_lifecycle_stack",
        "V3DisputeLifecycleStack",
      ],
    },
  });
});

test("active deployment selection replaces lane 30 and retires only historical lane 32", () => {
  const selected = selectActiveDeploymentScripts(process.cwd(), [
    "30_deploy_v3_lifecycle_stack.ts",
    "32_deploy_and_activate_dispute_lifecycle_stack.ts",
    "32_deploy_deposit_creation_guard.ts",
    "34_deploy_opt_in_dispute_lifecycle_stack.ts",
  ]);
  assert.deepEqual(
    selected.map(({ filename }) => filename),
    [
      "30_deploy_v3_lifecycle_stack.ts",
      "32_deploy_deposit_creation_guard.ts",
      "34_deploy_opt_in_dispute_lifecycle_stack.ts",
    ]
  );
  assert.equal(
    selected[0].sourcePath,
    resolve(
      process.cwd(),
      "deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts"
    )
  );
  assert.equal(
    selected[1].sourcePath,
    resolve(process.cwd(), "deploy/32_deploy_deposit_creation_guard.ts")
  );
});

test("retired and multi-tag deployment requests fail closed", () => {
  assert.doesNotThrow(() =>
    assertSupportedDeploymentTag("34_deploy_opt_in_dispute_lifecycle_stack")
  );
  assert.throws(
    () =>
      assertSupportedDeploymentTag(
        "32_deploy_and_activate_dispute_lifecycle_stack"
      ),
    /retired deployment tag/
  );
  assert.throws(
    () => assertSupportedDeploymentTag("V3DisputeLifecycleStack"),
    /retired deployment tag/
  );
  assert.throws(
    () => assertSupportedDeploymentTag("OrchestratorV3,V3LifecycleStack"),
    /exactly one deployment tag/
  );
});

function immutableLaneFixture() {
  const repository = mkdtempSync(join(tmpdir(), "immutable-deploy-lanes-"));
  for (const filename of Object.keys(IMMUTABLE_DEPLOYMENT_LANES)) {
    const destination = join(repository, "deploy", filename);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      readFileSync(resolve(process.cwd(), "deploy", filename))
    );
  }
  const wrapper = join(
    repository,
    "deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts"
  );
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, "export default async function () {}\n");
  writeFileSync(
    join(repository, "deploy", "32_deploy_deposit_creation_guard.ts"),
    "export default async function () {}\n"
  );
  writeFileSync(
    join(repository, "deploy", "34_deploy_opt_in_dispute_lifecycle_stack.ts"),
    "export default async function () {}\n"
  );
  return repository;
}

test("immutable lane integrity detects a one-byte mutation", () => {
  const repository = immutableLaneFixture();
  try {
    assert.doesNotThrow(() => assertImmutableDeploymentLanes(repository));
    const lane = join(repository, "deploy/30_deploy_v3_lifecycle_stack.ts");
    writeFileSync(lane, Buffer.concat([readFileSync(lane), Buffer.from(" ")]));
    assert.throws(
      () => assertImmutableDeploymentLanes(repository),
      /30_deploy_v3_lifecycle_stack\.ts.*97ed83a35e91167186da7a1bde9d3534e6eced436a843a0afd07c0f055bf20fa/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("active runner mounts one filtered lane set for tagged and untagged runs", () => {
  for (const tag of [undefined, "34_deploy_opt_in_dispute_lifecycle_stack"]) {
    let activeDirectory;
    const staleEnv = { ...process.env, DEPLOY_ACTIVE_TAG: "stale" };
    const status = runActiveDeployment("base", tag, {
      repositoryRoot: process.cwd(),
      hardhatCli: "/virtual/hardhat-cli.js",
      env: staleEnv,
      spawnSync: (_command, args, options) => {
        const deployScriptsIndex = args.indexOf("--deploy-scripts");
        assert.notEqual(deployScriptsIndex, -1);
        activeDirectory = args[deployScriptsIndex + 1];
        const filenames = readdirSync(activeDirectory);
        assert.ok(filenames.includes("30_deploy_v3_lifecycle_stack.ts"));
        assert.ok(filenames.includes("32_deploy_deposit_creation_guard.ts"));
        assert.ok(
          filenames.includes("34_deploy_opt_in_dispute_lifecycle_stack.ts")
        );
        assert.ok(
          !filenames.includes(
            "32_deploy_and_activate_dispute_lifecycle_stack.ts"
          )
        );
        assert.equal(
          readlinkSync(
            join(activeDirectory, "30_deploy_v3_lifecycle_stack.ts")
          ),
          resolve(
            process.cwd(),
            "deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts"
          )
        );
        assert.equal(options.env.DEPLOY_ACTIVE_TAG, tag || undefined);
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.ok(activeDirectory);
    assert.equal(existsSync(activeDirectory), false);
  }
});

test("active runner validates before spawn, propagates status, and always cleans up", () => {
  const invalidRepository = immutableLaneFixture();
  const invalidLane = join(
    invalidRepository,
    "deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts"
  );
  writeFileSync(
    invalidLane,
    Buffer.concat([readFileSync(invalidLane), Buffer.from(" ")])
  );
  let spawned = false;
  try {
    assert.throws(
      () =>
        runActiveDeployment("base", undefined, {
          repositoryRoot: invalidRepository,
          hardhatCli: "/virtual/hardhat-cli.js",
          spawnSync: () => {
            spawned = true;
            return { status: 0 };
          },
        }),
      /immutable deployment lane/
    );
    assert.equal(spawned, false);
  } finally {
    rmSync(invalidRepository, { recursive: true, force: true });
  }

  let failedDirectory;
  const status = runActiveDeployment("base", undefined, {
    repositoryRoot: process.cwd(),
    hardhatCli: "/virtual/hardhat-cli.js",
    spawnSync: (_command, args) => {
      failedDirectory = args[args.indexOf("--deploy-scripts") + 1];
      return { status: 7 };
    },
  });
  assert.equal(status, 7);
  assert.ok(failedDirectory);
  assert.equal(existsSync(failedDirectory), false);

  let errorDirectory;
  assert.throws(
    () =>
      runActiveDeployment("base", undefined, {
        repositoryRoot: process.cwd(),
        hardhatCli: "/virtual/hardhat-cli.js",
        spawnSync: (_command, args) => {
          errorDirectory = args[args.indexOf("--deploy-scripts") + 1];
          return { status: null, error: new Error("spawn failed") };
        },
      }),
    /spawn failed/
  );
  assert.ok(errorDirectory);
  assert.equal(existsSync(errorDirectory), false);
});

test("verification allowlist preserves requested order and rejects unknown records", () => {
  const deployments = {
    StakeVaultOptIn: { address: "0x1" },
    DisputeProtectionPolicyOptIn: { address: "0x2" },
    IntentLifecycleHookV1OptIn: { address: "0x3" },
    OrchestratorV3: { address: "0x4" },
  };
  assert.deepEqual(
    Object.keys(
      selectVerificationDeployments(deployments, [
        "StakeVaultOptIn",
        "DisputeProtectionPolicyOptIn",
        "IntentLifecycleHookV1OptIn",
      ])
    ),
    [
      "StakeVaultOptIn",
      "DisputeProtectionPolicyOptIn",
      "IntentLifecycleHookV1OptIn",
    ]
  );
  assert.throws(
    () => selectVerificationDeployments(deployments, ["Unknown"]),
    /Unknown deployment name: Unknown/
  );
});

test("verification treats already-verified responses as success", async () => {
  const results = await verifyDeployments(
    {
      run: async () => {
        throw new Error("Contract source code already verified");
      },
    },
    { StakeVaultOptIn: { address: "0x1" } },
    0,
    true
  );
  assert.deepEqual(results.skipped, ["StakeVaultOptIn"]);
  assert.deepEqual(results.failed, []);
});

test("verification fail-on-error rejects after collecting the summary", async () => {
  await assert.rejects(
    verifyDeployments(
      {
        run: async () => {
          throw new Error("explorer unavailable");
        },
      },
      { StakeVaultOptIn: { address: "0x1" } },
      0,
      true
    ),
    /1 selected contract verification\(s\) failed/
  );
});

test("staging activation exposes exactly one next monotonic call", () => {
  const states = /** @type {Array<{
    predecessorWriter: boolean;
    freshWriter: boolean;
    hook: "predecessor" | "successor" | "other";
    expected: "add-fresh-writer" | "set-fresh-hook" | "remove-predecessor-writer" | null;
  }>} */ ([
    {
      predecessorWriter: true,
      freshWriter: false,
      hook: "predecessor",
      expected: "add-fresh-writer",
    },
    {
      predecessorWriter: true,
      freshWriter: true,
      hook: "predecessor",
      expected: "set-fresh-hook",
    },
    {
      predecessorWriter: true,
      freshWriter: true,
      hook: "successor",
      expected: "remove-predecessor-writer",
    },
    {
      predecessorWriter: false,
      freshWriter: true,
      hook: "successor",
      expected: null,
    },
  ]);
  for (const state of states) {
    assert.equal(
      lane34Module.nextStagingActivationAction(state),
      state.expected
    );
  }
  assert.throws(
    () =>
      lane34Module.nextStagingActivationAction({
        predecessorWriter: false,
        freshWriter: false,
        hook: "successor",
      }),
    /Unrecognized Base staging activation state/
  );
});

test("activation confirmations and payment binding are mandatory", () => {
  assert.throws(
    () =>
      lane34Module.requireActivationPreconditions({
        activation: false,
        downstreamReady: true,
        predecessorDrained: true,
        paymentBindingReady: true,
      }),
    /activation confirmation/
  );
  assert.throws(
    () =>
      lane34Module.requireActivationPreconditions({
        activation: true,
        downstreamReady: true,
        predecessorDrained: true,
        paymentBindingReady: false,
      }),
    /payment binding/
  );
  assert.doesNotThrow(() =>
    lane34Module.requireActivationPreconditions({
      activation: true,
      downstreamReady: true,
      predecessorDrained: true,
      paymentBindingReady: true,
    })
  );
});

test("staging activation refuses a nonce race after its first preflight", () => {
  assert.doesNotThrow(() => lane34Module.requireStableStagingNonce(17, 17));
  assert.throws(
    () => lane34Module.requireStableStagingNonce(17, 18),
    /nonce changed after preflight/
  );
});

test("staging activation calldata is exact and drain is reread before writer removal", () => {
  const snapshot = {
    registry: "0x0000000000000000000000000000000000000011",
    predecessorPolicy: "0x0000000000000000000000000000000000000022",
    freshPolicy: "0x0000000000000000000000000000000000000033",
    orchestrator: "0x0000000000000000000000000000000000000044",
    freshHook: "0x0000000000000000000000000000000000000055",
  };
  const ethers = require("ethers");
  const writerInterface = new ethers.utils.Interface([
    "function addWritePermission(address)",
    "function removeWritePermission(address)",
  ]);
  const lifecycleInterface = new ethers.utils.Interface([
    "function setLifecycleHook(address)",
  ]);
  assert.deepEqual(
    lane34Module.buildStagingActivationTransaction(
      "add-fresh-writer",
      snapshot
    ),
    {
      to: snapshot.registry.toLowerCase(),
      value: "0",
      data: writerInterface
        .encodeFunctionData("addWritePermission", [snapshot.freshPolicy])
        .toLowerCase(),
      operation: 0,
    }
  );
  assert.deepEqual(
    lane34Module.buildStagingActivationTransaction("set-fresh-hook", snapshot),
    {
      to: snapshot.orchestrator.toLowerCase(),
      value: "0",
      data: lifecycleInterface
        .encodeFunctionData("setLifecycleHook", [snapshot.freshHook])
        .toLowerCase(),
      operation: 0,
    }
  );
  assert.throws(
    () =>
      lane34Module.requirePredecessorDrainedForWriterRemoval(
        "remove-predecessor-writer",
        1,
        0
      ),
    /writer removal refused/
  );
  assert.throws(
    () =>
      lane34Module.requirePredecessorDrainedForWriterRemoval(
        "remove-predecessor-writer",
        0,
        1
      ),
    /writer removal refused/
  );
  assert.doesNotThrow(() =>
    lane34Module.requirePredecessorDrainedForWriterRemoval(
      "remove-predecessor-writer",
      0,
      0
    )
  );
});

test("Base governance calls preserve the approved atomic order", () => {
  const safe = "0x0bC26FF515411396DD588Abd6Ef6846E04470227";
  const deployer = "0x0000000000000000000000000000000000000001";
  const verifier = "0x0000000000000000000000000000000000000011";
  const vault = "0x0000000000000000000000000000000000000022";
  const policy = "0x0000000000000000000000000000000000000033";
  const registry = "0x0000000000000000000000000000000000000044";
  const predecessorPolicy = "0x0000000000000000000000000000000000000055";
  const orchestrator = "0x0000000000000000000000000000000000000066";
  const predecessorHook = "0x0000000000000000000000000000000000000077";
  const freshHook = "0x0000000000000000000000000000000000000088";
  const snapshot = {
    safe,
    verifier: { address: verifier, owner: deployer, pendingOwner: safe },
    vault: { address: vault, owner: deployer, pendingOwner: safe },
    policy: { address: policy, owner: deployer, pendingOwner: safe },
    registry: { address: registry, owner: safe, writers: [predecessorPolicy] },
    predecessorPolicy,
    orchestrator: {
      address: orchestrator,
      owner: safe,
      currentHook: predecessorHook,
    },
    predecessorHook,
    freshHook,
  };
  const transactions = lane34Module.buildBaseGovernanceTransactions(snapshot);
  assert.deepEqual(
    transactions.map((transaction) => transaction.to),
    [verifier, vault, policy, registry, registry, orchestrator].map((address) =>
      address.toLowerCase()
    )
  );
  assert.deepEqual(
    transactions.map((transaction) => transaction.data.slice(0, 10)),
    [
      "0x79ba5097",
      "0x79ba5097",
      "0x79ba5097",
      "0xd6da0326",
      "0x286f9201",
      "0xbb4995af",
    ]
  );
  const safeOwnedVerifier = lane34Module.buildBaseGovernanceTransactions({
    ...snapshot,
    verifier: {
      address: verifier,
      owner: safe,
      pendingOwner: require("ethers").constants.AddressZero,
    },
  });
  assert.equal(safeOwnedVerifier.length, 5);
  assert.throws(
    () =>
      lane34Module.buildBaseGovernanceTransactions({
        ...snapshot,
        registry: {
          ...snapshot.registry,
          writers: [predecessorPolicy, policy],
        },
      }),
    /exact predecessor state/
  );
});

test("the obsolete Base lifecycle batch remains exact historical evidence", () => {
  const obsoleteBatch = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "deployments/outputs/safe-batches/superseded/base_2026-08-11T07-40-03.json"
      ),
      "utf8"
    )
  );
  const transactions = lane34Module.assertObsoleteBaseBatchShape(obsoleteBatch);
  assert.equal(transactions.length, 4);
  assert.equal(transactions[3].data.slice(0, 10), "0xbb4995af");
  assert.throws(
    () =>
      lane34Module.assertObsoleteBaseBatchShape({
        ...obsoleteBatch,
        transactions: obsoleteBatch.transactions.slice().reverse(),
      }),
    /transaction drifted/
  );
});

test("canonical Safe bytes and hash cover exact normalized transaction fields", () => {
  const transactions = [
    {
      to: "0x00000000000000000000000000000000000000aa",
      value: "0",
      data: "0xABCD",
      operation: 0,
    },
    {
      to: "0x00000000000000000000000000000000000000BB",
      value: 3,
      data: "0x",
      operation: "0",
    },
  ];
  assert.equal(
    canonicalTransactionBytes(transactions).toString("utf8"),
    '[{"to":"0x00000000000000000000000000000000000000aa","value":"0","data":"0xabcd","operation":0},{"to":"0x00000000000000000000000000000000000000bb","value":"3","data":"0x","operation":0}]'
  );
  const hash = canonicalTransactionHash(transactions);
  for (const mutation of [
    [{ ...transactions[0], to: transactions[1].to }, transactions[1]],
    [transactions[1], transactions[0]],
    [{ ...transactions[0], value: "1" }, transactions[1]],
    [{ ...transactions[0], data: "0xabce" }, transactions[1]],
    [{ ...transactions[0], operation: 1 }, transactions[1]],
  ])
    assert.notEqual(canonicalTransactionHash(mutation), hash);
});

test("Safe manifest validation rejects metadata and simulation tampering", () => {
  const transactions = [
    {
      to: "0x00000000000000000000000000000000000000aa",
      value: "0",
      data: "0xabcd",
      operation: 0,
    },
  ];
  const manifest =
    /** @type {import("../deployments/safeBatchManifest").DisputeSafeBatchManifest} */ ({
      version: 1,
      chainId: 8453,
      safe: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
      safeNonce: "7",
      sourceSha: "a".repeat(40),
      simulationBlockNumber: 123,
      simulationBlockHash: `0x${"b".repeat(64)}`,
      simulationResult: "success",
      transactions,
      transactionsSha256: canonicalTransactionHash(transactions),
    });
  assert.doesNotThrow(() => validateSafeBatchManifest(manifest, manifest));
  for (const [key, value] of [
    ["safe", "0x0000000000000000000000000000000000000001"],
    ["safeNonce", "8"],
    ["sourceSha", "c".repeat(40)],
    ["simulationBlockNumber", 124],
    ["simulationBlockHash", `0x${"d".repeat(64)}`],
    ["simulationResult", "failure"],
  ]) {
    assert.throws(
      () =>
        validateSafeBatchManifest(
          /** @type {any} */ ({ ...manifest, [key]: value }),
          manifest
        ),
      /manifest/
    );
  }
  for (const transactionsMutation of [
    [{ ...transactions[0], to: "0x00000000000000000000000000000000000000BB" }],
    [{ ...transactions[0], value: "1" }],
    [{ ...transactions[0], data: "0xabce" }],
    [{ ...transactions[0], operation: 1 }],
  ]) {
    assert.throws(
      () =>
        validateSafeBatchManifest(
          {
            ...manifest,
            transactions: transactionsMutation,
            transactionsSha256: canonicalTransactionHash(transactionsMutation),
          },
          manifest
        ),
      /manifest/
    );
  }

  const batch = {
    version: "1.0",
    chainId: "8453",
    createdAt: 123000,
    meta: {
      name: "ZKP2P opt-in dispute lifecycle activation - base",
      description:
        "Atomic ownership, writer, and OrchestratorV3 lifecycle-hook cutover",
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: manifest.safe,
      createdFromOwnerAddress: "",
    },
    transactions: transactions.map((transaction) => ({
      ...transaction,
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
  assert.doesNotThrow(() => assertBatchMatchesManifest(batch, manifest));
  assert.throws(
    () => assertBatchMatchesManifest({ ...batch, chainId: "1" }, manifest),
    /metadata/
  );
  assert.throws(
    () =>
      assertBatchMatchesManifest(
        {
          ...batch,
          transactions: [{ ...batch.transactions[0], operation: 1 }],
        },
        manifest
      ),
    /transactions/
  );
  const { operation: _operation, ...withoutOperation } = batch.transactions[0];
  assert.throws(
    () =>
      assertBatchMatchesManifest(
        { ...batch, transactions: [withoutOperation] },
        manifest
      ),
    /transaction shape/
  );
  assert.throws(
    () =>
      assertBatchMatchesManifest(
        {
          ...batch,
          transactions: [
            {
              ...batch.transactions[0],
              contractMethod: { name: "acceptOwnership" },
            },
          ],
        },
        manifest
      ),
    /transaction shape/
  );
});

test("MultiSend packing and Safe deliberate-revert decoding are exact", () => {
  const transactions = [
    {
      to: "0x00000000000000000000000000000000000000AA",
      value: "0",
      data: "0x1234",
      operation: 0,
    },
  ];
  const packed = packMultiSendTransactions(transactions);
  assert.equal(packed.length, 2 + 2 + 40 + 64 + 64 + 4);
  const calldata = encodeMultiSendCalldata(transactions);
  assert.match(calldata, /^0x8d80ff0a/);
  const simulated = appendSimulationPostcondition(
    transactions,
    "0x00000000000000000000000000000000000000BB",
    "0xaabbccdd"
  );
  assert.equal(transactions.length, 1);
  assert.equal(simulated.length, 2);
  assert.notEqual(
    canonicalTransactionHash(simulated),
    canonicalTransactionHash(transactions)
  );
  const envelope = require("ethers").utils.hexConcat([
    require("ethers").utils.hexZeroPad("0x01", 32),
    require("ethers").utils.hexZeroPad("0x02", 32),
    "0x1234",
  ]);
  assert.deepEqual(decodeSafeSimulationEnvelope(envelope), {
    success: true,
    returnData: "0x1234",
  });
  const failedEnvelope = require("ethers").utils.hexConcat([
    require("ethers").utils.hexZeroPad("0x00", 32),
    require("ethers").utils.hexZeroPad("0x02", 32),
    "0xdead",
  ]);
  assert.deepEqual(decodeSafeSimulationEnvelope(failedEnvelope), {
    success: false,
    returnData: "0xdead",
  });
  assert.throws(
    () => decodeSafeSimulationEnvelope("0x1234"),
    /simulation envelope/
  );
  const code = "0x6000";
  const runtimeHash = require("ethers").utils.keccak256(code);
  assert.doesNotThrow(() => requireRuntimeHash(code, runtimeHash, "pinned"));
  assert.throws(
    () => requireRuntimeHash(code, `0x${"0".repeat(64)}`, "pinned"),
    /runtime bytecode hash/
  );
  assert.equal(voidCallDidNotSucceed("0x", false), false);
  assert.equal(voidCallDidNotSucceed(undefined, true), true);
  assert.equal(
    voidCallDidNotSucceed(
      "0x08c379a000000000000000000000000000000000000000000000000000000000",
      false
    ),
    true
  );
});

test("Safe simulation restores package resolution before loading Hardhat", () => {
  moduleAlias.addAlias("@typechain", join(process.cwd(), "typechain"));
  assert.throws(
    () => require.resolve("@typechain/hardhat"),
    /Cannot find module/
  );
  assert.equal(typeof restoreHardhatModuleResolution, "function");
  restoreHardhatModuleResolution();
  assert.match(
    require.resolve("@typechain/hardhat"),
    /node_modules\/@typechain\/hardhat/
  );
});

test("direct Safe simulation reaches CLI validation before Hardhat loading", () => {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("ts-node/dist/bin.js"),
      "--transpile-only",
      "scripts/simulate-dispute-opt-in-safe-batch.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DISPUTE_SAFE_SIMULATION_PAYLOAD: "",
      },
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: simulate-dispute-opt-in-safe-batch/);
  assert.doesNotMatch(result.stderr, /typechain\/hardhat/);
});

test("Hardhat knows the exact Base Prague activation block", () => {
  restoreHardhatModuleResolution();
  const hardhatConfig = /** @type {any} */ (
    require("../hardhat.config.ts").default
  );
  assert.deepEqual(hardhatConfig.networks.hardhat.chains[8453], {
    hardforkHistory: {
      prague: 30_008_527,
    },
  });
});

test("Safe artifact Git modes reject dirt, unrelated descendants, and non-ancestors", () => {
  const repository = mkdtempSync(join(tmpdir(), "dispute-safe-git-"));
  /** @param {string[]} args */
  const runGit = (args) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  try {
    runGit(["init", "-q"]);
    runGit(["config", "user.email", "dispute-test@localhost"]);
    runGit(["config", "user.name", "Dispute Test"]);
    writeFileSync(join(repository, "source.txt"), "source\n");
    runGit(["add", "source.txt"]);
    runGit(["commit", "-qm", "source"]);
    const sourceSha = runGit(["rev-parse", "HEAD"]);
    assert.doesNotThrow(() =>
      assertSafeArtifactGitState(repository, sourceSha, "generation")
    );
    writeFileSync(join(repository, "dirty.txt"), "dirty\n");
    assert.throws(
      () => assertSafeArtifactGitState(repository, sourceSha, "generation"),
      /clean worktree/
    );
    rmSync(join(repository, "dirty.txt"));

    for (const path of [DISPUTE_SAFE_BATCH_PATH, DISPUTE_SAFE_SIDECAR_PATH]) {
      mkdirSync(join(repository, dirname(path)), { recursive: true });
      writeFileSync(join(repository, path), `${path}\n`);
    }
    runGit(["add", DISPUTE_SAFE_BATCH_PATH, DISPUTE_SAFE_SIDECAR_PATH]);
    runGit(["commit", "-qm", "artifacts"]);
    assert.doesNotThrow(() =>
      assertSafeArtifactGitState(repository, sourceSha, "artifact-child")
    );
    assert.throws(
      () =>
        assertSafeArtifactGitState(
          repository,
          "f".repeat(40),
          "artifact-child"
        ),
      /not an ancestor/
    );

    writeFileSync(join(repository, "unrelated.txt"), "unrelated\n");
    runGit(["add", "unrelated.txt"]);
    runGit(["commit", "-qm", "unrelated"]);
    assert.throws(
      () => assertSafeArtifactGitState(repository, sourceSha, "artifact-child"),
      /unrelated paths/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
