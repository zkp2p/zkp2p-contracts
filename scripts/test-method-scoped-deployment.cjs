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

const { ethers } = require("hardhat");
const { ethers: ethersLibrary } = require("ethers");
const lane34Module = require("../deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts");
const lane31Module = require("../deploy/31_deploy_v3_payment_binding_stack.ts");
const lane36Module = require("../deploy/36_deploy_method_scoped_whitelist_policy.ts");
const lane37Module = require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts");
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

test("immutable lanes 29 and 34 match their exact pinned source digests", () => {
  const lane29 = IMMUTABLE_DEPLOYMENT_LANES["29_deploy_whitelist_policy.ts"];
  const lane34 =
    IMMUTABLE_DEPLOYMENT_LANES["34_deploy_opt_in_dispute_lifecycle_stack.ts"];
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
  assertImmutableDeploymentLanes(repositoryRoot);
});

for (const filename of [
  "29_deploy_whitelist_policy.ts",
  "34_deploy_opt_in_dispute_lifecycle_stack.ts",
]) {
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
    "37_deploy_method_scoped_dispute_lifecycle_stack.ts",
    "32_deploy_deposit_creation_guard.ts",
  ]) {
    assert.equal(
      byName.get(filename),
      join(repositoryRoot, "deploy", filename)
    );
  }
  assert.equal(
    byName.has("32_deploy_and_activate_dispute_lifecycle_stack.ts"),
    false
  );
  assert.equal(
    byName.has("34_deploy_opt_in_dispute_lifecycle_stack.ts"),
    false
  );
});

test("deployment tags reject retired history and accept lanes 36 and 37", () => {
  for (const tag of [
    "32_deploy_and_activate_dispute_lifecycle_stack",
    "V3DisputeLifecycleStack",
    "34_deploy_opt_in_dispute_lifecycle_stack",
    "V3DisputeOptInStack",
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
    assertSupportedDeploymentTag(
      "37_deploy_method_scoped_dispute_lifecycle_stack"
    )
  );
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

test("lane 37 exports the method-scoped dispute stack identity", () => {
  assert.deepEqual(lane37Module.LOCAL_DISPUTE_DEPLOYMENT_NAMES, [
    "DisputeNullifierRegistry",
    "DisputeVerifier",
    "StakeVaultMethodScoped",
    "DisputeProtectionPolicyMethodScoped",
    "IntentLifecycleHookV1MethodScoped",
  ]);
  assert.deepEqual(lane37Module.LIVE_SUCCESSOR_DEPLOYMENT_NAMES, [
    "StakeVaultMethodScoped",
    "DisputeProtectionPolicyMethodScoped",
    "IntentLifecycleHookV1MethodScoped",
  ]);
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
    "deploy-vault",
    "deploy-policy",
    "deploy-hook",
    "initialize-controller",
    "authorize-hook",
    "set-risk-window:paypal",
    "set-risk-window:venmo",
    "set-risk-window:cashapp",
  ];
  assert.deepEqual(lane37Module.DEPLOY_ONLY_STEP_KINDS.base_staging, common);
  assert.deepEqual(lane37Module.DEPLOY_ONLY_STEP_KINDS.base, [
    ...common,
    "transfer-vault-owner",
    "transfer-policy-owner",
  ]);
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

test("lane 37 local readiness and successor records fail closed", async () => {
  assert.throws(
    () => lane37Module.requireLocalPaymentBindingReady(false),
    /must be fully cut over/
  );
  const records = new Map([
    [
      "DisputeProtectionPolicyMethodScoped",
      { address: "0x0000000000000000000000000000000000000001" },
    ],
  ]);
  await assert.rejects(
    lane37Module.getSuccessorDeployments(
      /** @type {any} */ ({
        deployments: {
          /** @param {string} name */
          getOrNull: async (name) => records.get(name) || null,
        },
      })
    ),
    /not a contiguous prefix/
  );
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
      assert.deepEqual(
        value,
        /** @type {Record<string, unknown>} */ (
          lane34Module.EXPECTED_LIVE[network]
        )[field],
        `${network}.${field}`
      );
    }
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

test("active dispute manifest selects OptIn live and MethodScoped locally", () => {
  for (const network of /** @type {Array<"base" | "base_staging">} */ ([
    "base",
    "base_staging",
  ])) {
    assert.deepEqual(Object.values(activeDisputeManifest.networks[network]), [
      "StakeVaultOptIn",
      "DisputeProtectionPolicyOptIn",
      "IntentLifecycleHookV1OptIn",
    ]);
  }
  for (const network of /** @type {Array<"localhost" | "hardhat">} */ ([
    "localhost",
    "hardhat",
  ])) {
    assert.deepEqual(Object.values(activeDisputeManifest.networks[network]), [
      "StakeVaultMethodScoped",
      "DisputeProtectionPolicyMethodScoped",
      "IntentLifecycleHookV1MethodScoped",
    ]);
  }
  const resolved = resolveActiveDisputeAliases("hardhat", {
    StakeVaultMethodScoped: { address: "vault" },
    DisputeProtectionPolicyMethodScoped: { address: "policy" },
    IntentLifecycleHookV1MethodScoped: { address: "hook" },
  });
  assert.equal(
    Object.keys(resolved).some(
      (name) => name.endsWith("OptIn") || name.endsWith("MethodScoped")
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
    "deploy:dispute-method-scoped:base_staging",
    "deploy:dispute-method-scoped:base",
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
  assert.equal(
    Object.keys(packageJson.scripts).some((name) =>
      name.startsWith("deploy:dispute-opt-in:")
    ),
    false
  );
});
