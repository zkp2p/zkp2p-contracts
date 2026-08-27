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
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const hardhat = require("hardhat");
const { ethers } = hardhat;
const lane31 = require("../deploy/31_deploy_v3_payment_binding_stack.ts");
const {
  ACTIVE_PAYMENT_METHODS,
  BASE_STAGING_ACTIVE_PAYMENT_METHODS,
  DISPUTABLE_PAYMENT_METHODS,
} = require("../deployments/parameters.ts");
const lane39 = require("../deploy/39_deploy_method_scoped_vault_stack.ts");
const deployLane39 = /** @type {(hre: any) => Promise<void>} */ (
  lane39.default
);
const skipLane39 = /** @type {(hre: any) => Promise<boolean>} */ (
  lane39.default.skip
);

const zeroAddress = "0x0000000000000000000000000000000000000000";
const stagingPendingController = "0x0173CaA95ecfC1c314C26766FB037d44cc71B42d";

test("lane 39 exports its dedicated-vault identity and has no dependencies", () => {
  assert.deepEqual(lane39.LIVE_SUCCESSOR_DEPLOYMENT_NAMES, [
    "StakeVaultMethodScoped",
    "DisputeProtectionPolicyMethodScopedStaked",
    "IntentLifecycleHookV1MethodScopedStaked",
  ]);
  assert.deepEqual(lane39.ARTIFACT_NAMES, {
    StakeVaultMethodScoped: "StakeVault",
    DisputeProtectionPolicyMethodScopedStaked: "DisputeProtectionPolicy",
    IntentLifecycleHookV1MethodScopedStaked: "IntentLifecycleHookV1",
  });
  assert.deepEqual(lane39.default.tags, [
    "39_deploy_method_scoped_vault_stack",
    "V3DisputeMethodScopedVaultStack",
  ]);
  assert.deepEqual(lane39.default.dependencies, []);
});

test("lane 39 orders every live operation as a resumable prefix", () => {
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
  assert.deepEqual(lane39.DEPLOY_ONLY_STEP_KINDS.base_staging, common);
  assert.deepEqual(lane39.DEPLOY_ONLY_STEP_KINDS.base, [
    ...common,
    "transfer-vault-owner",
    "transfer-policy-owner",
  ]);

  for (const network of /** @type {Array<"base_staging" | "base">} */ ([
    "base_staging",
    "base",
  ])) {
    const steps = lane39.DEPLOY_ONLY_STEP_KINDS[network];
    assert.deepEqual(
      lane39.classifyDeployOnlyPrefix(
        network,
        steps.map(() => false)
      ),
      { phase: "absent", nextStep: 0 }
    );
    assert.deepEqual(
      lane39.classifyDeployOnlyPrefix(
        network,
        steps.map(
          (/** @type {string} */ _, /** @type {number} */ index) => index < 4
        )
      ),
      { phase: "partial", nextStep: 4 }
    );
    assert.deepEqual(
      lane39.classifyDeployOnlyPrefix(
        network,
        steps.map(() => true)
      ),
      { phase: "prepared", nextStep: null }
    );
    assert.throws(
      () =>
        lane39.classifyDeployOnlyPrefix(
          network,
          steps.map(
            (/** @type {string} */ _, /** @type {number} */ index) =>
              index === 1
          )
        ),
      /not a contiguous prefix/
    );
  }
});

test("lane 39 pins the exact predecessor-vault state left by lane 38", () => {
  assert.doesNotThrow(() =>
    lane39.assertPredecessorVaultTransitionState("base", zeroAddress, 0, false)
  );
  assert.throws(
    () =>
      lane39.assertPredecessorVaultTransitionState(
        "base",
        stagingPendingController,
        1,
        false
      ),
    /pending controller/
  );
  assert.doesNotThrow(() =>
    lane39.assertPredecessorVaultTransitionState(
      "base_staging",
      stagingPendingController,
      1,
      true
    )
  );
  assert.throws(
    () =>
      lane39.assertPredecessorVaultTransitionState(
        "base_staging",
        "0x0000000000000000000000000000000000000001",
        1,
        true
      ),
    /pending controller/
  );
  assert.throws(
    () =>
      lane39.assertPredecessorVaultTransitionState(
        "base_staging",
        stagingPendingController,
        1,
        false
      ),
    /admissions must remain paused/
  );
});

test("lane 39 configures only paypal, venmo, and cashapp risk windows", () => {
  assert.deepEqual(DISPUTABLE_PAYMENT_METHODS, ["paypal", "venmo", "cashapp"]);
  assert.deepEqual(
    lane39.getRiskWindowPaymentMethods("base"),
    ACTIVE_PAYMENT_METHODS
  );
  assert.deepEqual(
    lane39.getRiskWindowPaymentMethods("base_staging"),
    BASE_STAGING_ACTIVE_PAYMENT_METHODS
  );
  assert.deepEqual(
    lane39.getRiskWindowPaymentMethods("hardhat"),
    ACTIVE_PAYMENT_METHODS
  );
});

test("lane 39 skips unsupported and untagged empty live runs", async () => {
  const fakeHre = {
    deployments: {
      network: "sepolia",
      getNetworkName() {
        return this.network;
      },
      getOrNull: async () => null,
    },
  };
  assert.equal(await skipLane39(fakeHre), true);

  for (const network of ["base_staging", "base"]) {
    fakeHre.deployments.network = network;
    const flag =
      network === "base"
        ? "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT"
        : "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT";
    delete process.env[flag];
    delete process.env.DEPLOY_ACTIVE_TAG;
    assert.equal(await skipLane39(fakeHre), true);
    process.env[flag] = "true";
    assert.equal(await skipLane39(fakeHre), true);
    delete process.env[flag];
  }
});

test("lane 39 tagged live runs require the network-specific opt-in", async () => {
  const previousTag = process.env.DEPLOY_ACTIVE_TAG;
  process.env.DEPLOY_ACTIVE_TAG = "39_deploy_method_scoped_vault_stack";
  try {
    for (const [network, flag] of [
      [
        "base_staging",
        "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT",
      ],
      ["base", "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT"],
    ]) {
      const previousFlag = process.env[flag];
      delete process.env[flag];
      const fakeHre = {
        deployments: {
          getNetworkName: () => network,
          getOrNull: async () => null,
        },
      };
      await assert.rejects(skipLane39(fakeHre), new RegExp(flag));
      await assert.rejects(deployLane39(fakeHre), new RegExp(flag));
      if (previousFlag === undefined) delete process.env[flag];
      else process.env[flag] = previousFlag;
    }
  } finally {
    if (previousTag === undefined) delete process.env.DEPLOY_ACTIVE_TAG;
    else process.env.DEPLOY_ACTIVE_TAG = previousTag;
  }
});

test("lane 39 live path never mutates the writer set or active hook", () => {
  const source = readFileSync(
    join(process.cwd(), "deploy/39_deploy_method_scoped_vault_stack.ts"),
    "utf8"
  );
  const livePath = source.slice(
    source.indexOf("async function deployLiveSuccessor"),
    source.indexOf("async function deployFresh")
  );
  assert.doesNotMatch(livePath, /\.addWritePermission\(|\.setLifecycleHook\(/);
  assert.match(livePath, /transfer-vault-owner/);
  assert.match(
    livePath,
    /state\.contracts\.vault\.transferOwnership\(governance\)/
  );
  assert.match(livePath, /transfer-policy-owner/);
  assert.match(
    livePath,
    /state\.contracts\.policy\.transferOwnership\(governance\)/
  );
});

/** @param {string} name @param {unknown[]} [args] */
async function deployContract(name, args = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  return contract;
}

async function localhostFixture() {
  await hardhat.network.provider.send("hardhat_reset");
  const [deployerSigner] = await ethers.getSigners();
  const deployer = deployerSigner.address;
  /** @type {Map<string, any>} */
  const records = new Map();
  let deployCalls = 0;

  const deploymentApi = {
    getNetworkName: () => "hardhat",
    /** @param {string} name */
    get: async (name) => {
      const record = records.get(name);
      if (!record) throw new Error(`Missing deployment ${name}`);
      return record;
    },
    /** @param {string} name */
    getOrNull: async (name) => records.get(name) || null,
    getExtendedArtifact: hardhat.deployments.getExtendedArtifact.bind(
      hardhat.deployments
    ),
    /** @param {string} name @param {{contract?: string, args?: unknown[]}} options */
    deploy: async (name, options) => {
      const existing = records.get(name);
      if (existing) return { ...existing, newlyDeployed: false };
      deployCalls += 1;
      const artifactName = options.contract || name;
      const contract = await deployContract(artifactName, options.args || []);
      const receipt = await contract.deployTransaction.wait();
      const artifact = await hardhat.deployments.getExtendedArtifact(
        artifactName
      );
      const record = {
        address: contract.address,
        args: options.args || [],
        deployedBytecode: await ethers.provider.getCode(contract.address),
        solcInputHash: artifact.solcInputHash,
        receipt: { blockNumber: receipt.blockNumber },
        transactionHash: contract.deployTransaction.hash,
        newlyDeployed: true,
      };
      records.set(name, record);
      return record;
    },
  };
  const fakeHre = /** @type {any} */ ({
    deployments: deploymentApi,
    ethers,
    getUnnamedAccounts: async () => [deployer],
  });

  /** @param {string} name @param {string} contract @param {unknown[]} [args] */
  const deployRecord = async (name, contract, args = []) => {
    await deploymentApi.deploy(name, { contract, args });
  };
  await deployRecord("AddressGroupRegistry", "AddressGroupRegistry");
  await deployRecord("EscrowRegistry", "EscrowRegistry");
  await deployRecord("OrchestratorRegistry", "OrchestratorRegistry");
  await deployRecord("PaymentVerifierRegistry", "PaymentVerifierRegistry");
  await deployRecord("RelayerRegistry", "RelayerRegistry");
  await deployRecord("NullifierRegistry", "NullifierRegistry");
  await deployRecord("USDCMock", "USDCMock", [1_000_000, "USDC", "USDC"]);
  const legacyRegistry = await deploymentApi.get("NullifierRegistry");
  await deployRecord("NullifierRegistryV2", "NullifierRegistryV2", [
    legacyRegistry.address,
  ]);
  await deployRecord("SimpleAttestationVerifier", "SimpleAttestationVerifier", [
    deployer,
  ]);
  const addressGroupRegistry = await deploymentApi.get("AddressGroupRegistry");
  const escrowRegistry = await deploymentApi.get("EscrowRegistry");
  const orchestratorRegistry = await deploymentApi.get("OrchestratorRegistry");
  const paymentVerifierRegistry = await deploymentApi.get(
    "PaymentVerifierRegistry"
  );
  const relayerRegistry = await deploymentApi.get("RelayerRegistry");
  await deployRecord("WhitelistPolicyMethodScoped", "WhitelistPolicy", [
    addressGroupRegistry.address,
    escrowRegistry.address,
    orchestratorRegistry.address,
  ]);
  await deployRecord("OrchestratorV3", "OrchestratorV3", [
    deployer,
    31337,
    escrowRegistry.address,
    paymentVerifierRegistry.address,
    relayerRegistry.address,
    0,
    deployer,
  ]);

  return {
    deployer,
    fakeHre,
    records,
    deployCalls: () => deployCalls,
  };
}

test("lane 39 deploys and activates the dedicated-vault topology in-process", async () => {
  const originalPaymentBindingCutoverReady = lane31.paymentBindingCutoverReady;
  lane31.paymentBindingCutoverReady = async () => true;
  try {
    const state = await localhostFixture();
    await deployLane39(state.fakeHre);

    const vaultRecord = state.records.get("StakeVaultMethodScoped");
    const policyRecord = state.records.get(
      "DisputeProtectionPolicyMethodScopedStaked"
    );
    const hookRecord = state.records.get(
      "IntentLifecycleHookV1MethodScopedStaked"
    );
    assert.ok(vaultRecord);
    assert.ok(policyRecord);
    assert.ok(hookRecord);

    const vault = await ethers.getContractAt("StakeVault", vaultRecord.address);
    const policy = await ethers.getContractAt(
      "DisputeProtectionPolicy",
      policyRecord.address
    );
    const registry = await ethers.getContractAt(
      "NullifierRegistry",
      state.records.get("DisputeNullifierRegistry").address
    );
    const orchestrator = await ethers.getContractAt(
      "OrchestratorV3",
      state.records.get("OrchestratorV3").address
    );
    assert.equal(await vault.controller(), policy.address);
    assert.equal(await vault.owner(), state.deployer);
    assert.equal(await vault.pendingOwner(), zeroAddress);
    assert.equal(await policy.owner(), state.deployer);
    assert.equal(
      await policy.isLifecycleHookAuthorized(hookRecord.address),
      true
    );
    assert.equal(await orchestrator.lifecycleHook(), hookRecord.address);
    assert.deepEqual(await registry.getWriters(), [policy.address]);

    const disputableMethods = new Set(DISPUTABLE_PAYMENT_METHODS);
    for (const method of ACTIVE_PAYMENT_METHODS) {
      const methodHash = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(method)
      );
      const actual = await policy.getRiskWindow(methodHash);
      assert.equal(
        actual.isZero(),
        !disputableMethods.has(method),
        `risk window ${method}`
      );
    }

    const callsAfterFirstRun = state.deployCalls();
    await deployLane39(state.fakeHre);
    assert.equal(state.deployCalls(), callsAfterFirstRun);

    const originalHash = vaultRecord.solcInputHash;
    vaultRecord.solcInputHash = "mismatched-build";
    await assert.rejects(
      deployLane39(state.fakeHre),
      /StakeVaultMethodScoped lacks canonical deployment evidence/
    );
    vaultRecord.solcInputHash = originalHash;
  } finally {
    lane31.paymentBindingCutoverReady = originalPaymentBindingCutoverReady;
  }
});
