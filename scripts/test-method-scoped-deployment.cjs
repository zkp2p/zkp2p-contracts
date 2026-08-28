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
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const hardhat = require("hardhat");
const { ethers } = hardhat;
const { ethers: ethersLibrary } = require("ethers");
const lane34Module = require("../deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts");
const lane31Module = require("../deploy/31_deploy_v3_payment_binding_stack.ts");
const lane36Module = require("../deploy/36_deploy_method_scoped_whitelist_policy.ts");
const lane37Module = require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts");
const {
  ACTIVE_PAYMENT_METHODS,
  BASE_STAGING_ACTIVE_PAYMENT_METHODS,
  MULTI_SIG,
} = require("../deployments/parameters.ts");
const {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
  deploymentCodeMatchesRecord,
} = require("../deployments/canonicalDeployment.ts");
const {
  IMMUTABLE_DEPLOYMENT_LANES,
  assertImmutableDeploymentLanes,
  assertSupportedDeploymentTag,
  selectActiveDeploymentScripts,
} = require("../deployments/immutableDeploymentLanes.ts");
const {
  METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS,
  PREDECESSOR_DISPUTE_STACKS,
  assertHistoricalDisputeStack,
} = require("../deployments/predecessorDisputeStack.ts");
const activeDisputeManifest = require("../deployments/active-dispute-stack.json");
const {
  resolveActiveDisputeAliases,
} = require("../deployments/activeDisputeStack.cjs");
const packageJson = require("../package.json");

const repositoryRoot = resolve(__dirname, "..");
const zeroAddress = ethers.constants.AddressZero;
const skipLane36 = lane36Module.default.skip;
const skipLane37 = lane37Module.default.skip;
if (!skipLane36 || !skipLane37) {
  throw new Error("Method-scoped deployment lanes must define skip functions");
}

test("deployment record matching accepts identical bytecode", () => {
  assert.equal(deploymentCodeMatchesRecord("0x60016002", "0x60016002"), true);
});

test("deployment record matching accepts values in zero placeholder slots", () => {
  const recordBytes = Buffer.alloc(100, 0x60);
  const offsets = [1, 34, 67];
  for (const offset of offsets) recordBytes.fill(0, offset, offset + 32);
  const chainBytes = Buffer.from(recordBytes);
  chainBytes.fill(0x11, offsets[0], offsets[0] + 32);
  Buffer.from("1234567890abcdef1234567890abcdef12345678", "hex").copy(
    chainBytes,
    offsets[1] + 12
  );
  assert.ok(
    chainBytes.subarray(offsets[1], offsets[1] + 12).equals(Buffer.alloc(12))
  );
  chainBytes.fill(0x33, offsets[2], offsets[2] + 32);

  assert.equal(
    deploymentCodeMatchesRecord(
      `0x${recordBytes.toString("hex")}`,
      `0x${chainBytes.toString("hex")}`
    ),
    true
  );
});

test("deployment record matching rejects drift at a nonzero record byte", () => {
  assert.equal(deploymentCodeMatchesRecord("0x60016002", "0x60026002"), false);
});

test("deployment record matching rejects longer chain bytecode", () => {
  assert.equal(deploymentCodeMatchesRecord("0x6001", "0x600100"), false);
});

test("deployment record matching rejects chain bytecode shorter by one byte", () => {
  assert.equal(deploymentCodeMatchesRecord("0x600100", "0x6001"), false);
});

test("executed Base hook record matches chain code across build hashes", async () => {
  const deployment = /** @type {any} */ (
    require("../deployments/base/IntentLifecycleHookV1OptIn.json")
  );
  const artifact = await hardhat.deployments.getExtendedArtifact(
    "IntentLifecycleHookV1"
  );
  assert.notEqual(deployment.solcInputHash, artifact.solcInputHash);

  const immutableReferences = artifact.evm.deployedBytecode.immutableReferences;
  const referencesByArgument = Object.values(immutableReferences);
  assert.equal(referencesByArgument.length, deployment.args.length);
  assert.deepEqual(
    referencesByArgument.map((references) => references.length),
    [4, 2, 4]
  );
  const currentReferences = referencesByArgument
    .flatMap((references, argumentIndex) =>
      references.map(
        (/** @type {{ start: number; length: number }} */ reference) => ({
          ...reference,
          argumentIndex,
        })
      )
    )
    .sort((left, right) => left.start - right.start);
  assert.equal(currentReferences.length, 10);
  assert.ok(currentReferences.every(({ length }) => length === 32));

  const recordHex = deployment.deployedBytecode.slice(2);
  const recordOffsets = [];
  for (let start = 0; start <= recordHex.length - 64; start += 2) {
    if (recordHex.slice(start, start + 64) === "0".repeat(64)) {
      recordOffsets.push(start / 2);
    }
  }
  assert.equal(recordOffsets.length, currentReferences.length);

  let chainHex = recordHex;
  for (const [index, offset] of recordOffsets.entries()) {
    const argument = deployment.args[currentReferences[index].argumentIndex]
      .slice(2)
      .toLowerCase()
      .padStart(64, "0");
    const start = offset * 2;
    chainHex = `${chainHex.slice(0, start)}${argument}${chainHex.slice(
      start + 64
    )}`;
  }
  const chainCode = `0x${chainHex}`;
  const hre = /** @type {any} */ ({
    deployments: { getExtendedArtifact: async () => artifact },
    ethers: { provider: { getCode: async () => chainCode } },
  });

  await assertDeploymentMatchesChain(
    hre,
    deployment,
    "IntentLifecycleHookV1OptIn",
    "IntentLifecycleHookV1"
  );

  const driftedChainCode = `0x61${chainHex.slice(2)}`;
  await assert.rejects(
    assertDeploymentMatchesChain(
      {
        ...hre,
        ethers: {
          provider: { getCode: async () => driftedChainCode },
        },
      },
      deployment,
      "IntentLifecycleHookV1OptIn",
      "IntentLifecycleHookV1"
    ),
    /IntentLifecycleHookV1OptIn on-chain code does not match its deployment record/
  );
  await assert.rejects(
    assertCanonicalDeployment(
      hre,
      deployment,
      "IntentLifecycleHookV1OptIn",
      "IntentLifecycleHookV1"
    ),
    /lacks canonical deployment evidence/
  );
});

test("deployment record matching does not depend on the current solc input", async () => {
  const artifact = {
    solcInputHash: "current-input",
    deployedBytecode: "0x60016002",
    evm: { deployedBytecode: { immutableReferences: {} } },
  };
  const deployment = {
    abi: [],
    address: "0x0000000000000000000000000000000000000001",
    solcInputHash: "executed-input",
    deployedBytecode: "0x60036004",
  };
  const hre = /** @type {any} */ ({
    deployments: { getExtendedArtifact: async () => artifact },
    ethers: { provider: { getCode: async () => deployment.deployedBytecode } },
  });

  await assertDeploymentMatchesChain(hre, deployment, "Policy", "Policy");
  await assert.rejects(
    assertCanonicalDeployment(hre, deployment, "Policy", "Policy"),
    /lacks canonical deployment evidence/
  );
});

test("deployment record matching rejects chain bytecode drift", async () => {
  const artifact = {
    solcInputHash: "current-input",
    deployedBytecode: "0x60016002",
    evm: { deployedBytecode: { immutableReferences: {} } },
  };
  const deployment = {
    abi: [],
    address: "0x0000000000000000000000000000000000000001",
    solcInputHash: "executed-input",
    deployedBytecode: "0x60036004",
  };
  const hre = /** @type {any} */ ({
    deployments: { getExtendedArtifact: async () => artifact },
    ethers: { provider: { getCode: async () => "0x60056006" } },
  });

  await assert.rejects(
    assertDeploymentMatchesChain(hre, deployment, "Policy", "Policy"),
    /Policy on-chain code does not match its deployment record/
  );
  await assert.rejects(
    assertCanonicalDeployment(hre, deployment, "Policy", "Policy"),
    /Policy on-chain code does not match its deployment record/
  );
});

test("canonical deployment matching ignores current immutable regions", async () => {
  const artifact = {
    solcInputHash: "shared-input",
    deployedBytecode: "0x6001aa02",
    evm: {
      deployedBytecode: {
        immutableReferences: { value: [{ start: 2, length: 1 }] },
      },
    },
  };
  const deployment = {
    abi: [],
    address: "0x0000000000000000000000000000000000000001",
    solcInputHash: artifact.solcInputHash,
    deployedBytecode: "0x6001bb02",
  };
  const hre = /** @type {any} */ ({
    deployments: { getExtendedArtifact: async () => artifact },
    ethers: { provider: { getCode: async () => "0x6001cc02" } },
  });

  await assertDeploymentMatchesChain(hre, deployment, "Policy", "Policy");
  await assertCanonicalDeployment(hre, deployment, "Policy", "Policy");
});

/** @param {string} path */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** @param {string} filename */
function immutableFixture(filename) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "method-scoped-lanes-"));
  const fixtureDeploy = join(fixtureRoot, "deploy");
  mkdirSync(fixtureDeploy);
  for (const immutableFilename of Object.keys(IMMUTABLE_DEPLOYMENT_LANES)) {
    const source = readFileSync(
      join(repositoryRoot, "deploy", immutableFilename)
    );
    writeFileSync(join(fixtureDeploy, immutableFilename), source);
  }
  const target = join(fixtureDeploy, filename);
  const source = readFileSync(target);
  source[0] ^= 1;
  writeFileSync(target, source);
  return fixtureRoot;
}

/**
 * @param {Record<string, string | undefined>} values
 * @param {() => Promise<void>} callback
 */
async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]])
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** @param {string} network */
function emptyDeploymentHre(network) {
  return /** @type {any} */ ({
    deployments: {
      getNetworkName: () => network,
      getOrNull: async () => null,
    },
  });
}

test("immutable deployment lanes match their exact pinned source digests", () => {
  const lane29 = IMMUTABLE_DEPLOYMENT_LANES["29_deploy_whitelist_policy.ts"];
  const lane34 =
    IMMUTABLE_DEPLOYMENT_LANES["34_deploy_opt_in_dispute_lifecycle_stack.ts"];
  const lane36 =
    IMMUTABLE_DEPLOYMENT_LANES["36_deploy_method_scoped_whitelist_policy.ts"];
  const lane37 =
    IMMUTABLE_DEPLOYMENT_LANES[
      "37_deploy_method_scoped_dispute_lifecycle_stack.ts"
    ];
  const lane38 =
    IMMUTABLE_DEPLOYMENT_LANES[
      "38_activate_method_scoped_dispute_lifecycle_stack.ts"
    ];
  const lane39 =
    IMMUTABLE_DEPLOYMENT_LANES["39_deploy_method_scoped_vault_stack.ts"];
  const lane40 =
    IMMUTABLE_DEPLOYMENT_LANES["40_activate_method_scoped_vault_stack.ts"];
  assert.deepEqual(
    {
      sha256: lane29.sha256,
      actual: sha256(
        join(repositoryRoot, "deploy", "29_deploy_whitelist_policy.ts")
      ),
      retired: lane29.retired,
    },
    {
      sha256:
        "95ee7660bdb069e1d31ea0e843f557b05f2ea76697766fec0d2146f8ec44d842",
      actual:
        "95ee7660bdb069e1d31ea0e843f557b05f2ea76697766fec0d2146f8ec44d842",
      retired: false,
    }
  );
  assert.deepEqual(
    {
      sha256: lane34.sha256,
      actual: sha256(
        join(
          repositoryRoot,
          "deploy",
          "34_deploy_opt_in_dispute_lifecycle_stack.ts"
        )
      ),
      activeSource: lane34.activeSource,
      retired: lane34.retired,
    },
    {
      sha256:
        "82562509fdf6acbf64c1fe6e1b7a39ff8d08ef324a680231e5b7b6a64243ba17",
      actual:
        "82562509fdf6acbf64c1fe6e1b7a39ff8d08ef324a680231e5b7b6a64243ba17",
      activeSource: null,
      retired: true,
    }
  );
  assert.deepEqual(
    {
      sha256: lane36.sha256,
      actual: sha256(
        join(
          repositoryRoot,
          "deploy",
          "36_deploy_method_scoped_whitelist_policy.ts"
        )
      ),
      activeSource: lane36.activeSource,
      retired: lane36.retired,
    },
    {
      sha256:
        "3bc01ba3e308a2d9cbaa58a95a7094c5ed2116df103ff6fbb997962cc9240fde",
      actual:
        "3bc01ba3e308a2d9cbaa58a95a7094c5ed2116df103ff6fbb997962cc9240fde",
      activeSource: undefined,
      retired: false,
    }
  );
  assert.deepEqual(
    {
      sha256: lane37.sha256,
      actual: sha256(
        join(
          repositoryRoot,
          "deploy",
          "37_deploy_method_scoped_dispute_lifecycle_stack.ts"
        )
      ),
      activeSource: lane37.activeSource,
      retired: lane37.retired,
    },
    {
      sha256:
        "fb19ffe1724d34d95097bddc28d0068218e06346ff1e5ea5c4a6aedd7d8a40c6",
      actual:
        "fb19ffe1724d34d95097bddc28d0068218e06346ff1e5ea5c4a6aedd7d8a40c6",
      activeSource: null,
      retired: true,
    }
  );
  assert.deepEqual(
    {
      deployedSourceSha: lane38.deployedSourceSha,
      sha256: lane38.sha256,
      actual: sha256(
        join(
          repositoryRoot,
          "deploy",
          "38_activate_method_scoped_dispute_lifecycle_stack.ts"
        )
      ),
      activeSource: lane38.activeSource,
      retired: lane38.retired,
    },
    {
      deployedSourceSha: "98856d1dada04463e650a13fb990dd67a1299bf0",
      sha256:
        "b278fd5d334301ca965fe603720f7e9fba1029f5e4af9e642e0e3befc46aef2e",
      actual:
        "b278fd5d334301ca965fe603720f7e9fba1029f5e4af9e642e0e3befc46aef2e",
      activeSource: null,
      retired: true,
    }
  );
  assert.deepEqual(
    {
      deployedSourceSha: lane39.deployedSourceSha,
      sha256: lane39.sha256,
      actual: sha256(
        join(repositoryRoot, "deploy", "39_deploy_method_scoped_vault_stack.ts")
      ),
      activeSource: lane39.activeSource,
      retired: lane39.retired,
      tags: lane39.tags,
    },
    {
      deployedSourceSha: "ddb849496af0aead7caf32d645b03be9ec5e724b",
      sha256:
        "bb6357508883202604fef7adb28656b781b84d3cec9f3afb2fb20162419845cc",
      actual:
        "bb6357508883202604fef7adb28656b781b84d3cec9f3afb2fb20162419845cc",
      activeSource: undefined,
      retired: false,
      tags: [
        "39_deploy_method_scoped_vault_stack",
        "V3DisputeMethodScopedVaultStack",
      ],
    }
  );
  assert.deepEqual(
    {
      deployedSourceSha: lane40.deployedSourceSha,
      sha256: lane40.sha256,
      actual: sha256(
        join(
          repositoryRoot,
          "deploy",
          "40_activate_method_scoped_vault_stack.ts"
        )
      ),
      activeSource: lane40.activeSource,
      retired: lane40.retired,
      tags: lane40.tags,
    },
    {
      deployedSourceSha: "71113f2c16562140d110abd4ff5b696f4069975a",
      sha256:
        "6816bcd307d36b7cb2df19663f8dba843fb4e8e376652d71f355fb9707ade253",
      actual:
        "6816bcd307d36b7cb2df19663f8dba843fb4e8e376652d71f355fb9707ade253",
      activeSource: undefined,
      retired: false,
      tags: [
        "40_activate_method_scoped_vault_stack",
        "V3DisputeMethodScopedVaultActivation",
      ],
    }
  );
  assertImmutableDeploymentLanes(repositoryRoot);
});

for (const filename of Object.keys(IMMUTABLE_DEPLOYMENT_LANES)) {
  test(`immutable lane validation names a mutated ${filename}`, () => {
    const fixtureRoot = immutableFixture(filename);
    try {
      assert.throws(
        () => assertImmutableDeploymentLanes(fixtureRoot),
        new RegExp(`Invalid immutable deployment lane ${filename}`)
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
}

test("active selection mounts successor lanes and excludes retired history", () => {
  const filenames = readdirSync(join(repositoryRoot, "deploy"));
  const selected = selectActiveDeploymentScripts(repositoryRoot, filenames);
  const byName = new Map(
    selected.map((entry) => [entry.filename, entry.sourcePath])
  );
  assert.equal(
    byName.get("29_deploy_whitelist_policy.ts"),
    join(repositoryRoot, "deploy", "29_deploy_whitelist_policy.ts")
  );
  assert.equal(
    byName.get("30_deploy_v3_lifecycle_stack.ts"),
    join(
      repositoryRoot,
      "deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts"
    )
  );
  for (const filename of [
    "36_deploy_method_scoped_whitelist_policy.ts",
    "32_deploy_deposit_creation_guard.ts",
  ]) {
    assert.equal(
      byName.get(filename),
      join(repositoryRoot, "deploy", filename)
    );
  }
  for (const filename of [
    "32_deploy_and_activate_dispute_lifecycle_stack.ts",
    "34_deploy_opt_in_dispute_lifecycle_stack.ts",
    "37_deploy_method_scoped_dispute_lifecycle_stack.ts",
    "38_activate_method_scoped_dispute_lifecycle_stack.ts",
  ]) {
    assert.equal(byName.has(filename), false, filename);
  }
  assert.equal(
    byName.get("39_deploy_method_scoped_vault_stack.ts"),
    join(repositoryRoot, "deploy", "39_deploy_method_scoped_vault_stack.ts")
  );
});

test("deployment tags reject retired history through lane 38 but accept lane 39", () => {
  for (const tag of [
    "32_deploy_and_activate_dispute_lifecycle_stack",
    "V3DisputeLifecycleStack",
    "34_deploy_opt_in_dispute_lifecycle_stack",
    "V3DisputeOptInStack",
    "37_deploy_method_scoped_dispute_lifecycle_stack",
    "V3DisputeMethodScopedStack",
    "38_activate_method_scoped_dispute_lifecycle_stack",
    "V3DisputeMethodScopedActivation",
  ]) {
    assert.throws(() => assertSupportedDeploymentTag(tag), /Refusing retired/);
  }
  assert.throws(
    () =>
      assertSupportedDeploymentTag(
        "36_deploy_method_scoped_whitelist_policy,37_deploy_method_scoped_dispute_lifecycle_stack"
      ),
    /exactly one deployment tag/
  );
  assert.doesNotThrow(() =>
    assertSupportedDeploymentTag("36_deploy_method_scoped_whitelist_policy")
  );
  assert.doesNotThrow(() =>
    assertSupportedDeploymentTag("MethodScopedWhitelistPolicy")
  );
  assert.doesNotThrow(() =>
    assertSupportedDeploymentTag("39_deploy_method_scoped_vault_stack")
  );
});

test("lane 37 localhost wrapper is deleted after retirement", () => {
  const wrapperPath = join(
    repositoryRoot,
    "deployments/activeDeploymentLanes/37_deploy_method_scoped_dispute_lifecycle_stack.ts"
  );
  assert.equal(existsSync(wrapperPath), false);
});

test("lane 36 exports the method-scoped whitelist identity", () => {
  assert.equal(
    lane36Module.METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME,
    "WhitelistPolicyMethodScoped"
  );
  assert.deepEqual(lane36Module.ARTIFACT_NAMES, {
    WhitelistPolicyMethodScoped: "WhitelistPolicy",
  });
  assert.deepEqual(lane36Module.default.tags, [
    "36_deploy_method_scoped_whitelist_policy",
    "MethodScopedWhitelistPolicy",
  ]);
  assert.deepEqual(lane36Module.default.dependencies, []);
  assert.deepEqual(
    [...lane36Module.SUPPORTED_NETWORKS],
    ["localhost", "hardhat", "base_staging", "base"]
  );
});

test("lane 36 skips unsupported and unflagged live runs but tagged runs fail", async () => {
  assert.equal(await skipLane36(emptyDeploymentHre("sepolia")), true);
  for (const network of /** @type {Array<"base" | "base_staging">} */ ([
    "base",
    "base_staging",
  ])) {
    const flag =
      network === "base"
        ? "ENABLE_BASE_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT"
        : "ENABLE_STAGING_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT";
    await withEnvironment(
      { [flag]: undefined, DEPLOY_ACTIVE_TAG: undefined },
      async () => {
        const hre = emptyDeploymentHre(network);
        assert.equal(await skipLane36(hre), true);
        await assert.rejects(
          lane36Module.default(hre),
          new RegExp(`${flag}=true`)
        );
      }
    );
    await withEnvironment(
      {
        [flag]: undefined,
        DEPLOY_ACTIVE_TAG: "36_deploy_method_scoped_whitelist_policy",
      },
      async () => {
        await assert.rejects(
          skipLane36(emptyDeploymentHre(network)),
          new RegExp(`${flag}=true`)
        );
      }
    );
  }
});

async function withLane36ExistingPolicy(
  /** @type {{ getOwner: () => string; isOrchestrator: (address: string) => Promise<boolean> }} */ options,
  /** @type {(context: { fakeHre: any; orchestratorV2: string; orchestratorV3: string }) => Promise<void>} */ assertion
) {
  const network = "base";
  const expected = lane36Module.EXPECTED_LIVE[network];
  const policyAddress = "0x0000000000000000000000000000000000000100";
  const orchestratorV2 = "0x0000000000000000000000000000000000000200";
  const orchestratorV3 = "0x0000000000000000000000000000000000000250";
  const escrowV2 = "0x0000000000000000000000000000000000000300";
  const artifact = await require("hardhat").deployments.getExtendedArtifact(
    "WhitelistPolicy"
  );
  const existing = {
    address: policyAddress,
    deployedBytecode: artifact.deployedBytecode,
    solcInputHash: "executed-input",
  };
  const dependencies = new Map([
    ["AddressGroupRegistry", { address: expected.addressGroupRegistry }],
    ["EscrowRegistry", { address: expected.escrowRegistry }],
    ["OrchestratorRegistry", { address: expected.orchestratorRegistry }],
    ["OrchestratorV2", { address: orchestratorV2 }],
    ["OrchestratorV3", { address: orchestratorV3 }],
    ["EscrowV2", { address: escrowV2 }],
  ]);
  const fakeHre = /** @type {any} */ ({
    deployments: {
      getNetworkName: () => network,
      getOrNull: async () => existing,
      /** @param {string} name */
      get: async (name) => dependencies.get(name),
      getExtendedArtifact: async () => artifact,
    },
    ethers: {
      provider: {
        getCode: async () => artifact.deployedBytecode,
      },
    },
    getUnnamedAccounts: async () => [expected.deployer],
  });
  const originalGetContractAt = ethers.getContractAt;
  /** @type {any} */ (ethers).getContractAt = async (
    /** @type {string} */ name
  ) => {
    if (name === "OrchestratorRegistry") {
      return { isOrchestrator: options.isOrchestrator };
    }
    if (name === "EscrowRegistry") {
      return { isWhitelistedEscrow: async () => true };
    }
    if (name === "WhitelistPolicy") {
      return {
        groupRegistry: async () => expected.addressGroupRegistry,
        escrowRegistry: async () => expected.escrowRegistry,
        orchestratorRegistry: async () => expected.orchestratorRegistry,
        owner: async () => options.getOwner(),
      };
    }
    throw new Error(`Unexpected contract ${name}`);
  };
  try {
    await assertion({ fakeHre, orchestratorV2, orchestratorV3 });
  } finally {
    /** @type {any} */ (ethers).getContractAt = originalGetContractAt;
  }
}

test("lane 36 resumes only an incomplete deployer-to-governance handover", async () => {
  const expected = lane36Module.EXPECTED_LIVE.base;
  const stranger = "0x0000000000000000000000000000000000000400";
  let owner = expected.deployer;
  await withLane36ExistingPolicy(
    {
      getOwner: () => owner,
      isOrchestrator: async () => true,
    },
    async ({ fakeHre }) => {
      assert.equal(await skipLane36(fakeHre), false);
      owner = expected.governance;
      assert.equal(await skipLane36(fakeHre), true);
      owner = stranger;
      await assert.rejects(skipLane36(fakeHre), /owner drifted/);
    }
  );
});

test("lane 36 accepts registered OrchestratorV3 when OrchestratorV2 is unregistered", async () => {
  await withLane36ExistingPolicy(
    {
      getOwner: () => lane36Module.EXPECTED_LIVE.base.governance,
      isOrchestrator: async (address) =>
        address === "0x0000000000000000000000000000000000000250",
    },
    async ({ fakeHre, orchestratorV2, orchestratorV3 }) => {
      const registry = await ethers.getContractAt(
        "OrchestratorRegistry",
        lane36Module.EXPECTED_LIVE.base.orchestratorRegistry
      );
      assert.equal(await registry.isOrchestrator(orchestratorV2), false);
      assert.equal(await registry.isOrchestrator(orchestratorV3), true);
      assert.equal(await skipLane36(fakeHre), true);
    }
  );
});

test("lane 36 rejects an unregistered OrchestratorV3", async () => {
  await withLane36ExistingPolicy(
    {
      getOwner: () => lane36Module.EXPECTED_LIVE.base.governance,
      isOrchestrator: async () => false,
    },
    async ({ fakeHre }) => {
      await assert.rejects(
        skipLane36(fakeHre),
        /OrchestratorV3 must already be registered/
      );
    }
  );
});

test("lane 36 and lane 37 share every common live dependency pin", () => {
  for (const network of /** @type {Array<"base" | "base_staging">} */ ([
    "base",
    "base_staging",
  ])) {
    for (const field of /** @type {Array<"deployer" | "orchestratorRegistry" | "escrowRegistry" | "addressGroupRegistry">} */ ([
      "deployer",
      "orchestratorRegistry",
      "escrowRegistry",
      "addressGroupRegistry",
    ])) {
      assert.equal(
        lane36Module.EXPECTED_LIVE[network][field],
        lane37Module.EXPECTED_LIVE[network][field],
        `${network}.${field}`
      );
    }
  }
});

/** @param {"base" | "base_staging"} network @param {boolean} allowMultipleIntents */
function orchestratorGovernanceFixture(network, allowMultipleIntents) {
  const expected = lane37Module.EXPECTED_LIVE[network];
  const governance = MULTI_SIG[network] || expected.deployer;
  return {
    governance,
    expected,
    orchestrator: {
      owner: async () => governance,
      paused: async () => false,
      chainId: async () => ethers.BigNumber.from(8453),
      escrowRegistry: async () => expected.escrowRegistry,
      paymentVerifierRegistry: async () => expected.paymentVerifierRegistry,
      relayerRegistry: async () => expected.relayerRegistry,
      protocolFee: async () => ethers.constants.Zero,
      protocolFeeRecipient: async () => expected.protocolFeeRecipient,
      allowMultipleIntents: async () => allowMultipleIntents,
    },
  };
}

test("lane 37 accepts Base with allowMultipleIntents enabled", async () => {
  const { orchestrator, governance, expected } = orchestratorGovernanceFixture(
    "base",
    true
  );
  await assert.doesNotReject(
    lane37Module.assertOrchestratorGovernanceState(
      orchestrator,
      governance,
      expected
    )
  );
});

test("lane 37 rejects enabled allowMultipleIntents on Base staging", async () => {
  const { orchestrator, governance, expected } = orchestratorGovernanceFixture(
    "base_staging",
    true
  );
  await assert.rejects(
    lane37Module.assertOrchestratorGovernanceState(
      orchestrator,
      governance,
      expected
    ),
    /OrchestratorV3 governance state drifted/
  );
});

test("lane 37 exports the method-scoped dispute stack identity", () => {
  assert.deepEqual(lane37Module.LOCAL_DISPUTE_DEPLOYMENT_NAMES, [
    "DisputeNullifierRegistry",
    "DisputeVerifier",
    "StakeVaultMethodScoped",
    "DisputeProtectionPolicyMethodScoped",
    "IntentLifecycleHookV1MethodScoped",
  ]);
  assert.deepEqual(lane37Module.LIVE_SUCCESSOR_DEPLOYMENT_NAMES, [
    "DisputeProtectionPolicyMethodScoped",
    "IntentLifecycleHookV1MethodScoped",
  ]);
  assert.equal(
    lane37Module.LIVE_SUCCESSOR_DEPLOYMENT_NAMES.includes(
      "StakeVaultMethodScoped"
    ),
    false
  );
  assert.deepEqual(lane37Module.ARTIFACT_NAMES, {
    DisputeNullifierRegistry: "NullifierRegistry",
    DisputeVerifier: "DisputeVerifier",
    StakeVaultMethodScoped: "StakeVault",
    DisputeProtectionPolicyMethodScoped: "DisputeProtectionPolicy",
    IntentLifecycleHookV1MethodScoped: "IntentLifecycleHookV1",
  });
  assert.deepEqual(lane37Module.default.tags, [
    "37_deploy_method_scoped_dispute_lifecycle_stack",
    "V3DisputeMethodScopedStack",
  ]);
  assert.deepEqual(lane37Module.default.dependencies, []);
});

test("lane 37 checks risk windows against each network's active methods", () => {
  assert.deepEqual(
    lane37Module.getRiskWindowPaymentMethods("base_staging"),
    BASE_STAGING_ACTIVE_PAYMENT_METHODS
  );
  assert.deepEqual(
    lane37Module.getRiskWindowPaymentMethods("base"),
    ACTIVE_PAYMENT_METHODS
  );
  assert.deepEqual(
    lane37Module.getRiskWindowPaymentMethods("hardhat"),
    ACTIVE_PAYMENT_METHODS
  );
});

test("lane 37 skips unsupported and unflagged live runs but tagged runs fail", async () => {
  assert.equal(await skipLane37(emptyDeploymentHre("sepolia")), true);
  for (const network of /** @type {Array<"base" | "base_staging">} */ ([
    "base",
    "base_staging",
  ])) {
    const flag =
      network === "base"
        ? "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_DEPLOYMENT"
        : "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_DEPLOYMENT";
    await withEnvironment(
      { [flag]: undefined, DEPLOY_ACTIVE_TAG: undefined },
      async () => {
        const hre = emptyDeploymentHre(network);
        assert.equal(await skipLane37(hre), true);
        await assert.rejects(
          lane37Module.default(hre),
          new RegExp(`${flag}=true`)
        );
      }
    );
    await withEnvironment(
      {
        [flag]: undefined,
        DEPLOY_ACTIVE_TAG: "37_deploy_method_scoped_dispute_lifecycle_stack",
      },
      async () => {
        await assert.rejects(
          skipLane37(emptyDeploymentHre(network)),
          new RegExp(`${flag}=true`)
        );
      }
    );
  }
});

test("lane 37 deploy-only steps are ordered contiguous prefixes", () => {
  const common = [
    "deploy-policy",
    "deploy-hook",
    "authorize-hook",
    "set-risk-window:paypal",
    "set-risk-window:venmo",
  ];
  assert.deepEqual(lane37Module.DEPLOY_ONLY_STEP_KINDS.base_staging, common);
  assert.deepEqual(lane37Module.DEPLOY_ONLY_STEP_KINDS.base, [
    ...common,
    "transfer-policy-owner",
  ]);
  assert.equal(
    Object.values(lane37Module.DEPLOY_ONLY_STEP_KINDS)
      .flat()
      .some((step) =>
        [
          "deploy-vault",
          "initialize-controller",
          "transfer-vault-owner",
        ].includes(step)
      ),
    false
  );
  for (const network of /** @type {Array<"base_staging" | "base">} */ ([
    "base_staging",
    "base",
  ])) {
    const steps = lane37Module.DEPLOY_ONLY_STEP_KINDS[network];
    assert.deepEqual(
      lane37Module.classifyDeployOnlyPrefix(
        network,
        steps.map(() => false)
      ),
      {
        phase: "absent",
        nextStep: 0,
      }
    );
    assert.deepEqual(
      lane37Module.classifyDeployOnlyPrefix(
        network,
        steps.map((_, index) => index < 2)
      ),
      { phase: "partial", nextStep: 2 }
    );
    assert.deepEqual(
      lane37Module.classifyDeployOnlyPrefix(
        network,
        steps.map(() => true)
      ),
      {
        phase: "prepared",
        nextStep: null,
      }
    );
    assert.throws(
      () =>
        lane37Module.classifyDeployOnlyPrefix(
          network,
          steps.map((_, index) => index === 1)
        ),
      /not a contiguous prefix/
    );
    assert.throws(
      () => lane37Module.classifyDeployOnlyPrefix(network, []),
      /state length mismatch/
    );
  }
});

test("lane 37 ownership states distinguish complete, pending, absent, and drift", () => {
  const deployer = "0x0000000000000000000000000000000000000001";
  const governance = "0x0000000000000000000000000000000000000002";
  assert.equal(
    lane37Module.ownershipStepState(
      governance,
      zeroAddress,
      deployer,
      governance,
      "policy"
    ),
    true
  );
  assert.equal(
    lane37Module.ownershipStepState(
      deployer,
      governance,
      deployer,
      governance,
      "policy"
    ),
    true
  );
  assert.equal(
    lane37Module.ownershipStepState(
      deployer,
      zeroAddress,
      deployer,
      governance,
      "policy"
    ),
    false
  );
  assert.throws(
    () =>
      lane37Module.ownershipStepState(
        "0x0000000000000000000000000000000000000003",
        zeroAddress,
        deployer,
        governance,
        "policy"
      ),
    /policy owner or pending owner drifted/
  );
});

test("lane 37 local readiness and live successor records fail closed", async () => {
  assert.throws(
    () => lane37Module.requireLocalPaymentBindingReady(false),
    /must be fully cut over/
  );

  const policyArtifact =
    await require("hardhat").deployments.getExtendedArtifact(
      "DisputeProtectionPolicy"
    );
  const hookArtifact = await require("hardhat").deployments.getExtendedArtifact(
    "IntentLifecycleHookV1"
  );
  const policy = {
    address: "0x0000000000000000000000000000000000000001",
    deployedBytecode: policyArtifact.deployedBytecode,
    solcInputHash: policyArtifact.solcInputHash,
  };
  const hook = {
    address: "0x0000000000000000000000000000000000000002",
    deployedBytecode: hookArtifact.deployedBytecode,
    solcInputHash: hookArtifact.solcInputHash,
  };
  const records = new Map([["IntentLifecycleHookV1MethodScoped", hook]]);
  const fakeHre = /** @type {any} */ ({
    deployments: {
      getNetworkName: () => "base",
      /** @param {string} name */
      getOrNull: async (name) => records.get(name) || null,
      /** @param {string} name */
      getExtendedArtifact: async (name) => {
        if (name === "DisputeProtectionPolicy") return policyArtifact;
        if (name === "IntentLifecycleHookV1") return hookArtifact;
        throw new Error(`Unexpected artifact ${name}`);
      },
    },
    ethers: {
      provider: {
        /** @param {string} address */
        getCode: async (address) => {
          if (address === policy.address) return policy.deployedBytecode;
          if (address === hook.address) return hook.deployedBytecode;
          return "0x";
        },
      },
    },
  });
  await assert.rejects(
    lane37Module.getSuccessorDeployments(fakeHre),
    /not a contiguous prefix/
  );

  records.clear();
  policy.solcInputHash = "executed-input";
  records.set("DisputeProtectionPolicyMethodScoped", policy);
  await assert.rejects(
    lane37Module.getSuccessorDeployments(fakeHre),
    /lacks canonical deployment evidence/
  );
  policy.solcInputHash = policyArtifact.solcInputHash;
  assert.deepEqual(await lane37Module.getSuccessorDeployments(fakeHre), [
    policy,
    null,
  ]);
  policy.solcInputHash = "executed-policy-input";
  hook.solcInputHash = "executed-hook-input";
  records.set("IntentLifecycleHookV1MethodScoped", hook);
  assert.deepEqual(await lane37Module.getSuccessorDeployments(fakeHre), [
    policy,
    hook,
  ]);
});

test("lane 37 local deployment requires the lane 36 policy record", async () => {
  const originalPaymentBindingCutoverReady =
    lane31Module.paymentBindingCutoverReady;
  lane31Module.paymentBindingCutoverReady = async () => true;
  try {
    await assert.rejects(
      lane37Module.default(
        /** @type {any} */ ({
          deployments: {
            getNetworkName: () => "hardhat",
            /** @param {string} name */
            get: async (name) => ({ address: `${name}-address` }),
            getOrNull: async () => null,
          },
          getUnnamedAccounts: async () => [
            "0x0000000000000000000000000000000000000001",
          ],
        })
      ),
      /WhitelistPolicyMethodScoped record missing; run lane 36 first/
    );
  } finally {
    lane31Module.paymentBindingCutoverReady =
      originalPaymentBindingCutoverReady;
  }
});

test("lane 37 reuses every shared lane 34 live pin without a whitelist pin", () => {
  for (const network of /** @type {Array<"base" | "base_staging">} */ ([
    "base",
    "base_staging",
  ])) {
    assert.equal(
      "whitelistPolicy" in lane37Module.EXPECTED_LIVE[network],
      false
    );
    for (const [field, value] of Object.entries(
      lane37Module.EXPECTED_LIVE[network]
    )) {
      if (field === "allowMultipleIntents") continue;
      assert.deepEqual(
        value,
        /** @type {Record<string, unknown>} */ (
          lane34Module.EXPECTED_LIVE[network]
        )[field],
        `${network}.${field}`
      );
    }
    assert.equal(
      lane37Module.EXPECTED_LIVE[network].allowMultipleIntents,
      network === "base"
    );
  }
});

test("the lane 37 predecessor map pins the Base OptIn stack exactly", () => {
  const base = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS.base;
  assert.deepEqual(base.activeLifecycleHook, {
    address: "0x71467dCac3B50eeED5A485aC6a70f27B1EAC1970",
    runtimeCodeHash:
      "0x35789014e608a248f3244b61210fa259fee3566c33f50fd0e3fa1f5ae22e370b",
  });
  assert.deepEqual(
    Object.fromEntries(
      ["StakeVault", "DisputeProtectionPolicy", "IntentLifecycleHookV1"].map(
        (name) => [name, base.contracts[name]]
      )
    ),
    {
      StakeVault: {
        deploymentName: "StakeVaultOptIn",
        address: "0x4d16F4a9946CfC76b1c1A4B63aa9D94cdA2dbCEB",
        deploymentBytecodeHash:
          "0x3ceac244f2d721614975457b041e95f661feba8ef6bbfc73c23b55aaac27d3e6",
        runtimeCodeHash:
          "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
      },
      DisputeProtectionPolicy: {
        deploymentName: "DisputeProtectionPolicyOptIn",
        address: "0xcEc48F7242eDBf02875BB4629115Bd927e1287aA",
        deploymentBytecodeHash:
          "0xe4600241bce095f1a8789d46efb639b2d8c681a423a836c66173274b5284a788",
        runtimeCodeHash:
          "0x9c4be279da216021183638eaef79ebf98db248472685e9ecd0de3f24a513a641",
      },
      IntentLifecycleHookV1: {
        deploymentName: "IntentLifecycleHookV1OptIn",
        address: "0x71467dCac3B50eeED5A485aC6a70f27B1EAC1970",
        deploymentBytecodeHash:
          "0xd379478c4798979d09db6bef1dbf626739cd50ffe6469732f6e182ecb7cea7db",
        runtimeCodeHash:
          "0x35789014e608a248f3244b61210fa259fee3566c33f50fd0e3fa1f5ae22e370b",
      },
    }
  );
  assert.strictEqual(
    METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS.base_staging,
    PREDECESSOR_DISPUTE_STACKS.base_staging
  );
  for (const name of /** @type {Array<"DisputeVerifier" | "DisputeNullifierRegistry">} */ ([
    "DisputeVerifier",
    "DisputeNullifierRegistry",
  ])) {
    assert.strictEqual(
      base.contracts[name],
      PREDECESSOR_DISPUTE_STACKS.base.contracts[name]
    );
  }
});

test("Base OptIn deployment bytecode hashes match the checked-in artifacts", () => {
  const base = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS.base;
  for (const [
    name,
    artifactName,
  ] of /** @type {Array<["StakeVault" | "DisputeProtectionPolicy" | "IntentLifecycleHookV1", string]>} */ ([
    ["StakeVault", "StakeVaultOptIn"],
    ["DisputeProtectionPolicy", "DisputeProtectionPolicyOptIn"],
    ["IntentLifecycleHookV1", "IntentLifecycleHookV1OptIn"],
  ])) {
    const deployment = require(`../deployments/base/${artifactName}.json`);
    assert.equal(
      ethers.utils.keccak256(deployment.deployedBytecode),
      base.contracts[name].deploymentBytecodeHash
    );
  }
});

test("historical validation resolves the OptIn deployment record names", async () => {
  /** @type {string[]} */
  const requested = [];
  const keccak256Descriptor = Object.getOwnPropertyDescriptor(
    ethersLibrary.utils,
    "keccak256"
  );
  const originalKeccak256 = ethersLibrary.utils.keccak256;
  /** @type {Map<string, string>} */
  const runtimeByAddress = new Map();
  /** @type {Map<string, any>} */
  const deploymentByName = new Map();
  let runtimeIndex = 10;
  for (const [canonicalName, expected] of Object.entries(
    METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS.base.contracts
  )) {
    const deploymentName = expected.deploymentName || canonicalName;
    const deployment = require(`../deployments/base/${deploymentName}.json`);
    deploymentByName.set(deploymentName, deployment);
    runtimeByAddress.set(
      expected.address.toLowerCase(),
      `0x${runtimeIndex.toString(16)}`
    );
    runtimeIndex += 1;
  }
  Object.defineProperty(ethersLibrary.utils, "keccak256", {
    configurable: true,
    /** @param {import("ethers").BytesLike} value */
    value: (value) => {
      for (const [address, runtime] of runtimeByAddress) {
        if (value === runtime) {
          const expected = Object.values(
            METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS.base.contracts
          ).find((entry) => entry.address.toLowerCase() === address);
          assert.ok(expected);
          return expected.runtimeCodeHash;
        }
      }
      return originalKeccak256(value);
    },
  });
  assert.ok(keccak256Descriptor);
  try {
    await assertHistoricalDisputeStack(
      /** @type {any} */ ({
        deployments: {
          getNetworkName: () => "base",
          /** @param {string} name */
          get: async (name) => {
            requested.push(name);
            const deployment = deploymentByName.get(name);
            if (!deployment) throw new Error(`Missing deployment ${name}`);
            return deployment;
          },
        },
        ethers: {
          provider: {
            /** @param {string} address */
            getCode: async (address) =>
              runtimeByAddress.get(address.toLowerCase()),
          },
        },
      }),
      METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS
    );
  } finally {
    Object.defineProperty(
      ethersLibrary.utils,
      "keccak256",
      keccak256Descriptor
    );
  }
  assert.deepEqual(requested.slice(0, 3), [
    "StakeVaultOptIn",
    "DisputeProtectionPolicyOptIn",
    "IntentLifecycleHookV1OptIn",
  ]);
});

test("active dispute manifest selects the dedicated-vault stack on every network", () => {
  for (const network of /** @type {Array<"base" | "base_staging">} */ ([
    "base",
    "base_staging",
  ])) {
    assert.deepEqual(Object.values(activeDisputeManifest.networks[network]), [
      "StakeVaultMethodScoped",
      "DisputeProtectionPolicyMethodScopedStaked",
      "IntentLifecycleHookV1MethodScopedStaked",
      "WhitelistPolicyMethodScoped",
    ]);
  }
  for (const network of /** @type {Array<"localhost" | "hardhat">} */ ([
    "localhost",
    "hardhat",
  ])) {
    assert.deepEqual(Object.values(activeDisputeManifest.networks[network]), [
      "StakeVaultMethodScoped",
      "DisputeProtectionPolicyMethodScopedStaked",
      "IntentLifecycleHookV1MethodScopedStaked",
      "WhitelistPolicyMethodScoped",
    ]);
  }
  const resolved = resolveActiveDisputeAliases("hardhat", {
    StakeVaultMethodScoped: { address: "vault" },
    DisputeProtectionPolicyMethodScopedStaked: { address: "policy" },
    IntentLifecycleHookV1MethodScopedStaked: { address: "hook" },
    WhitelistPolicyMethodScoped: { address: "whitelist" },
  });
  assert.equal(
    Object.keys(resolved).some(
      (name) => name.endsWith("OptIn") || name.includes("MethodScoped")
    ),
    false
  );
});

test("summary and package wiring expose only the current deployment lanes", () => {
  const summary = readFileSync(
    join(repositoryRoot, "deploy/deploy_summary.ts"),
    "utf8"
  );
  for (const tag of [
    "36_deploy_method_scoped_whitelist_policy",
    "MethodScopedWhitelistPolicy",
    "37_deploy_method_scoped_dispute_lifecycle_stack",
    "V3DisputeMethodScopedStack",
  ]) {
    assert.match(summary, new RegExp(`"${tag}"`));
  }
  for (const script of [
    "deploy:method-scoped-policy:base_staging",
    "deploy:method-scoped-policy:base",
    "verify:method-scoped:base_staging",
    "verify:method-scoped:base",
  ]) {
    assert.equal(
      typeof (
        /** @type {Record<string, string>} */ (packageJson.scripts)[script]
      ),
      "string",
      script
    );
  }
  for (const script of [
    "deploy:dispute-method-scoped:base_staging",
    "deploy:dispute-method-scoped:base",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(packageJson.scripts, script),
      false,
      `${script} must be removed`
    );
  }
  assert.equal(
    Object.keys(packageJson.scripts).some((name) =>
      name.startsWith("deploy:dispute-opt-in:")
    ),
    false
  );
  const scripts = /** @type {Record<string, string>} */ (packageJson.scripts);
  for (const network of ["base_staging", "base"]) {
    assert.match(
      scripts[`verify:method-scoped:${network}`],
      /--contracts WhitelistPolicyMethodScoped,DisputeProtectionPolicyMethodScoped,IntentLifecycleHookV1MethodScoped /
    );
    assert.doesNotMatch(
      scripts[`verify:method-scoped:${network}`],
      /StakeVaultMethodScoped/
    );
    assert.match(
      scripts[`deploy:dispute-method-scoped-vault:${network}`],
      new RegExp(`${network} 39_deploy_method_scoped_vault_stack$`)
    );
    assert.match(
      scripts[`verify:method-scoped-vault:${network}`],
      /--contracts StakeVaultMethodScoped,DisputeProtectionPolicyMethodScopedStaked,IntentLifecycleHookV1MethodScopedStaked --fail-on-error$/
    );
  }
  assert.equal(
    Object.keys(scripts).some((name) =>
      name.startsWith("deploy:dispute-method-scoped-activation:")
    ),
    false
  );
  assert.equal(
    scripts["test:method-scoped-vault-deployment"],
    "node scripts/test-method-scoped-vault-deployment.cjs"
  );
});

/**
 * @param {string} name
 * @param {number} blockNumber
 * @param {number} logIndex
 * @param {string} [transactionHash]
 */
function freshEvent(
  name,
  blockNumber,
  logIndex,
  transactionHash = "0x" + "ab".repeat(32)
) {
  return { name, blockNumber, transactionIndex: 0, logIndex, transactionHash };
}

test("fresh-policy classifier allows configuration events", () => {
  assert.doesNotThrow(() =>
    lane37Module.classifyFreshStackActivity({
      policyEvents: [freshEvent("DisputeProtectionEnabledUpdated", 120, 0)],
    })
  );
});

test("fresh-policy classifier rejects every lifecycle event", () => {
  for (const name of lane37Module.FORBIDDEN_POLICY_LIFECYCLE_EVENTS) {
    assert.throws(
      () =>
        lane37Module.classifyFreshStackActivity({
          policyEvents: [freshEvent(name, 150, 0)],
        }),
      new RegExp(name)
    );
  }
});

test("fresh-policy event lists partition the policy ABI exactly once", () => {
  const artifactEvents =
    /** @type {{ abi: Array<{ type: string, name: string }> }} */ (
      JSON.parse(
        readFileSync(
          join(
            repositoryRoot,
            "artifacts",
            "contracts",
            "hooks",
            "DisputeProtectionPolicy.sol",
            "DisputeProtectionPolicy.json"
          ),
          "utf8"
        )
      )
    ).abi
      .filter((entry) => entry.type === "event")
      .map((entry) => entry.name)
      .sort();
  const policyLists = [
    lane37Module.ALLOWED_POLICY_CONFIGURATION_EVENTS,
    lane37Module.EXPECTED_POLICY_GOVERNANCE_EVENTS,
    lane37Module.FORBIDDEN_POLICY_LIFECYCLE_EVENTS,
  ];
  const classified = policyLists.flat();
  assert.equal(
    new Set(classified).size,
    classified.length,
    "policy lists overlap"
  );
  assert.deepEqual(
    [...classified].sort(),
    artifactEvents,
    "policy ABI events are not all classified"
  );
  assert.deepEqual(
    [...lane37Module.ALLOWED_POLICY_CONFIGURATION_EVENTS],
    ["DisputeProtectionEnabledUpdated"]
  );
  assert.deepEqual(
    [...lane37Module.FORBIDDEN_POLICY_LIFECYCLE_EVENTS],
    [
      "DisputeProtectionIntentOpened",
      "DisputeProtectionIntentCancelled",
      "DisputeProtectionIntentSettled",
      "DisputeProtectionIntentReleased",
      "DisputeResolved",
    ]
  );
});

test("fresh-policy classifier allows every governance event", () => {
  for (const name of lane37Module.EXPECTED_POLICY_GOVERNANCE_EVENTS) {
    assert.doesNotThrow(() =>
      lane37Module.classifyFreshStackActivity({
        policyEvents: [freshEvent(name, 100, 0)],
      })
    );
  }
});

test("fresh-policy classifier fails closed on an unclassified event", () => {
  assert.throws(
    () =>
      lane37Module.classifyFreshStackActivity({
        policyEvents: [freshEvent("SomeFutureEvent", 101, 0)],
      }),
    /unclassified.*SomeFutureEvent/
  );
});

test("decodeFreshStackLogs maps raw logs to named events and rejects unknown topics", () => {
  const policyInterface = new ethersLibrary.utils.Interface(
    JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          "artifacts",
          "contracts",
          "hooks",
          "DisputeProtectionPolicy.sol",
          "DisputeProtectionPolicy.json"
        ),
        "utf8"
      )
    ).abi
  );
  const configurationTopic = policyInterface.getEventTopic(
    "DisputeProtectionEnabledUpdated"
  );
  /**
   * @param {string} topic
   * @param {number} blockNumber
   * @param {number} transactionIndex
   * @param {number} logIndex
   * @param {string} transactionHash
   */
  const rawLog = (
    topic,
    blockNumber,
    transactionIndex,
    logIndex,
    transactionHash
  ) => ({
    address: "0x" + "11".repeat(20),
    topics: [topic],
    data: "0x",
    blockNumber,
    transactionIndex,
    logIndex,
    transactionHash,
    blockHash: "0x" + "22".repeat(32),
    removed: false,
  });
  const decoded = lane37Module.decodeFreshStackLogs(
    policyInterface,
    [rawLog(configurationTopic, 7, 3, 5, "0x" + "ee".repeat(32))],
    "DisputeProtectionPolicyMethodScoped"
  );
  assert.deepEqual(decoded, [
    {
      name: "DisputeProtectionEnabledUpdated",
      blockNumber: 7,
      transactionIndex: 3,
      logIndex: 5,
      transactionHash: "0x" + "ee".repeat(32),
    },
  ]);
  assert.throws(
    () =>
      lane37Module.decodeFreshStackLogs(
        policyInterface,
        [rawLog("0x" + "ff".repeat(32), 7, 0, 0, "0x" + "ee".repeat(32))],
        "DisputeProtectionPolicyMethodScoped"
      ),
    /DisputeProtectionPolicyMethodScoped emitted a log this ABI cannot decode/
  );
});
