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
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
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
const { buildDeployArguments } = require("./deployActive.ts");
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

test("tag-scoped deployment runs lane 34 without dependencies", () => {
  assert.deepEqual(
    buildDeployArguments("base", "34_deploy_opt_in_dispute_lifecycle_stack"),
    [
      "deploy",
      "--network",
      "base",
      "--tags",
      "34_deploy_opt_in_dispute_lifecycle_stack",
      "--no-compile",
    ]
  );
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
        "deployments/outputs/safe-batches/base_2026-08-11T07-40-03.json"
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
