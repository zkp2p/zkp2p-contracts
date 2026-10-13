#!/usr/bin/env node
// @ts-check

const startupKeys = [
  "DEPLOY_TX_DELAY_MS",
  "ALCHEMY_API_KEY",
  "BASE_DEPLOY_PRIVATE_KEY",
  "TESTNET_DEPLOY_PRIVATE_KEY",
];
const startupEnvironment = startupKeys.map((key) => process.env[key]);

/** @param {string} key @param {string | undefined} value */
function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function loadRuntime() {
  try {
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
    return {
      hardhat: require("hardhat"),
      lane31: require("../deploy/31_deploy_v3_payment_binding_stack.ts"),
      lane45: require("../deploy/45_deploy_bypass_dispute_stack.ts"),
      lane46: require("../deploy/46_activate_bypass_dispute_stack.ts"),
    };
  } finally {
    startupKeys.forEach((key, index) =>
      restoreEnvironment(key, startupEnvironment[index])
    );
  }
}

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { hardhat, lane31, lane45, lane46 } = loadRuntime();
const { ethers } = hardhat;
const { BigNumber } = require("ethers");
const {
  BYPASS_DEPLOYMENT_NAMES,
  BYPASS_ARTIFACT_NAMES,
  BYPASS_EXPECTED_LIVE,
  BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  expectedPaymentMethodCurrencies,
} = require("../deployments/bypassDisputeStack.ts");
const {
  ACTIVE_PAYMENT_METHODS,
  RETIRED_DISPUTABLE_PAYMENT_METHODS,
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  MULTI_SIG,
  getActivePaymentMethods,
} = require("../deployments/parameters.ts");
const deployLane45 = /** @type {(hre: any) => Promise<void>} */ (
  lane45.default
);
const skipLane45 = /** @type {(hre: any) => Promise<boolean>} */ (
  lane45.default.skip
);
const activateLane46 = /** @type {(hre: any) => Promise<void>} */ (
  lane46.default
);

/** @param {string} name */
const hash = (name) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));

/** @param {Record<string, string | undefined>} values @param {() => Promise<void>} run */
async function withEnvironment(values, run) {
  const previous = Object.keys(values).map((key) => process.env[key]);
  try {
    for (const [key, value] of Object.entries(values))
      restoreEnvironment(key, value);
    await run();
  } finally {
    Object.keys(values).forEach((key, index) =>
      restoreEnvironment(key, previous[index])
    );
  }
}

test("lane 45 exports its bypass identity, live flags, and zero controller delay", () => {
  assert.deepEqual(BYPASS_DEPLOYMENT_NAMES, [
    "StakeVaultBypass",
    "DisputeProtectionPolicyBypass",
    "IntentLifecycleHookV1Bypass",
    "UnifiedPaymentVerifierV4",
  ]);
  assert.deepEqual(BYPASS_ARTIFACT_NAMES, {
    StakeVaultBypass: "StakeVault",
    DisputeProtectionPolicyBypass: "DisputeProtectionPolicy",
    IntentLifecycleHookV1Bypass: "IntentLifecycleHookV1",
    UnifiedPaymentVerifierV4: "UnifiedPaymentVerifierV4",
  });
  assert.deepEqual(lane45.default.tags, [
    "45_deploy_bypass_dispute_stack",
    "V3DisputeBypassStack",
  ]);
  assert.deepEqual(lane45.default.dependencies, []);
  assert.deepEqual(lane45.LIVE_FLAGS, {
    base_staging: "ENABLE_STAGING_V3_DISPUTE_BYPASS_STACK_DEPLOYMENT",
    base: "ENABLE_BASE_V3_DISPUTE_BYPASS_STACK_DEPLOYMENT",
  });
  assert.equal(BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY, 0);
});

test("lane 45 pins exact live step order and classifies only contiguous prefixes", () => {
  assert.deepEqual(lane45.LANE_45_STEP_KINDS.base_staging, [
    "deploy-vault",
    "deploy-policy",
    "initialize-controller",
    "deploy-hook",
    "authorize-hook",
    "set-risk-window:paypal",
    "set-risk-window:venmo",
    "deploy-verifier",
    "add-verifier-method:zelle",
    "add-verifier-method:monzo",
    "add-verifier-method:alipay",
    "add-verifier-method:chime",
    "add-verifier-method:venmo",
    "add-verifier-method:revolut",
    "add-verifier-method:cashapp",
    "add-verifier-method:wise",
    "add-verifier-method:mercadopago",
    "add-verifier-method:paypal",
    "add-verifier-method:monobank",
    "add-verifier-method:mercury",
    "add-verifier-method:upi",
    "add-verifier-method:xmoney",
  ]);
  assert.deepEqual(lane45.LANE_45_STEP_KINDS.base, [
    "deploy-vault",
    "deploy-policy",
    "initialize-controller",
    "deploy-hook",
    "authorize-hook",
    "set-risk-window:paypal",
    "set-risk-window:venmo",
    "deploy-verifier",
    "add-verifier-method:alipay",
    "add-verifier-method:chime",
    "add-verifier-method:venmo",
    "add-verifier-method:revolut",
    "add-verifier-method:cashapp",
    "add-verifier-method:wise",
    "add-verifier-method:mercadopago",
    "add-verifier-method:zelle",
    "add-verifier-method:monzo",
    "add-verifier-method:paypal",
    "add-verifier-method:upi",
    "add-verifier-method:xmoney",
    "add-verifier-method:monobank",
    "transfer-vault-owner",
    "transfer-policy-owner",
    "transfer-verifier-owner",
  ]);
  for (const network of /** @type {const} */ (["base_staging", "base"])) {
    const steps = lane45.LANE_45_STEP_KINDS[network];
    assert.deepEqual(
      lane45.classifyLane45Prefix(
        network,
        steps.map(() => false)
      ),
      { phase: "absent", nextStep: 0 }
    );
    assert.deepEqual(
      lane45.classifyLane45Prefix(
        network,
        steps.map((/** @type {string} */ _, /** @type {number} */ i) => i < 4)
      ),
      { phase: "partial", nextStep: 4 }
    );
    assert.deepEqual(
      lane45.classifyLane45Prefix(
        network,
        steps.map(() => true)
      ),
      { phase: "prepared", nextStep: null }
    );
    assert.throws(
      () =>
        lane45.classifyLane45Prefix(
          network,
          steps.map(
            (/** @type {string} */ _, /** @type {number} */ i) => i === 1
          )
        ),
      /not a contiguous prefix/
    );
    assert.throws(
      () => lane45.classifyLane45Prefix(network, []),
      /length mismatch/
    );
    assert.throws(
      () =>
        lane45.classifyLane45Prefix(network, [
          ...steps.map(() => false),
          false,
        ]),
      /length mismatch/
    );
  }
});

test("lane 45 pins live catalogs, currencies, risk windows, and governance", () => {
  assert.deepEqual(
    BYPASS_EXPECTED_LIVE.base.paymentMethods,
    getActivePaymentMethods("base")
  );
  assert.deepEqual(
    BYPASS_EXPECTED_LIVE.base_staging.paymentMethods,
    lane31.RATIFIED_PAYMENT_METHOD_ORDER.base_staging
  );
  assert.equal(BYPASS_EXPECTED_LIVE.base.governance, MULTI_SIG.base);
  assert.equal(
    BYPASS_EXPECTED_LIVE.base_staging.governance,
    BYPASS_EXPECTED_LIVE.base_staging.deployer
  );
  for (const network of /** @type {const} */ (["base", "base_staging"])) {
    const pins = BYPASS_EXPECTED_LIVE[network];
    assert.deepEqual(pins.riskWindows, { paypal: "1209600", venmo: "1209600" });
    for (const method of pins.paymentMethods) {
      const currencies = expectedPaymentMethodCurrencies(method);
      assert.ok(currencies.length > 0, method);
      assert.deepEqual(
        currencies,
        lane31.RATIFIED_PAYMENT_METHOD_CURRENCIES[method]
      );
    }
  }
});

/** @param {string} network */
function emptyHre(network) {
  return {
    deployments: { getNetworkName: () => network, getOrNull: async () => null },
  };
}

test("lane 45 skips unsupported and untagged live runs but admits local runs", async () => {
  assert.equal(await skipLane45(emptyHre("sepolia")), true);
  for (const network of ["localhost", "hardhat"])
    assert.equal(await skipLane45(emptyHre(network)), false);
  for (const network of /** @type {const} */ (["base_staging", "base"])) {
    for (const flagValue of [undefined, "true"]) {
      await withEnvironment(
        {
          DEPLOY_ACTIVE_TAG: undefined,
          [lane45.LIVE_FLAGS[network]]: flagValue,
        },
        async () => {
          assert.equal(await skipLane45(emptyHre(network)), true);
        }
      );
    }
  }
});

test("lane 45 tagged and direct live runs require the network-specific flag", async () => {
  for (const network of /** @type {const} */ (["base_staging", "base"])) {
    const flag = lane45.LIVE_FLAGS[network];
    await withEnvironment(
      {
        DEPLOY_ACTIVE_TAG: "45_deploy_bypass_dispute_stack",
        [flag]: undefined,
      },
      async () => {
        await assert.rejects(skipLane45(emptyHre(network)), new RegExp(flag));
        await assert.rejects(deployLane45(emptyHre(network)), new RegExp(flag));
      }
    );
    await withEnvironment(
      { DEPLOY_ACTIVE_TAG: undefined, [flag]: undefined },
      async () => {
        await assert.rejects(deployLane45(emptyHre(network)), new RegExp(flag));
      }
    );
  }
});

test("lane 45 live preparation never changes writers, routes, or the active hook", () => {
  const source = readFileSync(
    join(process.cwd(), "deploy/45_deploy_bypass_dispute_stack.ts"),
    "utf8"
  );
  const start = source.indexOf("async function deployLiveBypassStack");
  const end = source.indexOf("async function deployFresh", start);
  assert.ok(start >= 0 && end > start);
  const livePath = source.slice(start, end);
  assert.doesNotMatch(
    livePath,
    /\.addWritePermission\(|\.removeWritePermission\(|\.setLifecycleHook\(|removePaymentMethod\(|registry\.addPaymentMethod\(/
  );
  assert.ok(livePath.includes("verifier.addPaymentMethod("));
  assert.equal(
    (livePath.match(/\.transferOwnership\(context\.governance\)/g) || [])
      .length,
    3
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
  const [deployerSigner, extraWriter] = await ethers.getSigners();
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
        abi: artifact.abi,
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
  /** @param {string} name @param {string} [artifact] @param {unknown[]} [args] */
  async function deployRecord(name, artifact = name, args = []) {
    const record = await deploymentApi.deploy(name, {
      contract: artifact,
      args,
    });
    return ethers.getContractAt(artifact, record.address);
  }
  const groups = await deployRecord("AddressGroupRegistry");
  const escrows = await deployRecord("EscrowRegistry");
  const orchestrators = await deployRecord("OrchestratorRegistry");
  const registry = await deployRecord("PaymentVerifierRegistry");
  const relayers = await deployRecord("RelayerRegistry");
  const legacy = await deployRecord("NullifierRegistry");
  const usdc = await deployRecord("USDCMock", "USDCMock", [
    1_000_000,
    "USDC",
    "USDC",
  ]);
  const nrv2 = await deployRecord(
    "NullifierRegistryV2",
    "NullifierRegistryV2",
    [legacy.address]
  );
  const simple = await deployRecord(
    "SimpleAttestationVerifier",
    "SimpleAttestationVerifier",
    [deployer]
  );
  const upv3 = await deployRecord(
    "UnifiedPaymentVerifierV3",
    "UnifiedPaymentVerifierV3",
    [orchestrators.address, nrv2.address, simple.address]
  );
  const catalog = [
    { method: hash("venmo"), currencies: [hash("USD")] },
    {
      method: hash("paypal"),
      currencies: [hash("USD"), hash("EUR"), hash("GBP")],
    },
    { method: hash("zelle"), currencies: [hash("USD")] },
  ];
  for (const row of catalog) {
    await (await upv3.addPaymentMethod(row.method)).wait();
    await (
      await registry.addPaymentMethod(row.method, upv3.address, row.currencies)
    ).wait();
  }
  await (await nrv2.addWritePermission(upv3.address)).wait();
  await deployRecord("EscrowV2", "EscrowV2", [
    deployer,
    31337,
    orchestrators.address,
    registry.address,
    deployer,
    0,
    10,
    86400,
  ]);
  const orchestrator = await deployRecord("OrchestratorV3", "OrchestratorV3", [
    deployer,
    31337,
    escrows.address,
    registry.address,
    relayers.address,
    0,
    deployer,
  ]);
  await (await orchestrators.addOrchestrator(orchestrator.address)).wait();
  const whitelist = await deployRecord(
    "WhitelistPolicyMethodScoped",
    "WhitelistPolicy",
    [groups.address, escrows.address, orchestrators.address]
  );
  const disputeRegistry = await deployRecord(
    "DisputeNullifierRegistry",
    "NullifierRegistry"
  );
  const disputeVerifier = await deployRecord(
    "DisputeVerifier",
    "DisputeVerifier",
    [deployer, nrv2.address, simple.address]
  );
  const predecessorVault = await deployRecord(
    "StakeVaultMethodScoped",
    "StakeVault",
    [deployer, usdc.address, ethers.constants.AddressZero, 172800]
  );
  const predecessorPolicy = await deployRecord(
    "DisputeProtectionPolicyMethodScopedStaked",
    "DisputeProtectionPolicy",
    [
      deployer,
      predecessorVault.address,
      disputeVerifier.address,
      disputeRegistry.address,
    ]
  );
  const predecessorHook = await deployRecord(
    "IntentLifecycleHookV1MethodScopedStaked",
    "IntentLifecycleHookV1",
    [orchestrators.address, whitelist.address, predecessorPolicy.address]
  );
  await (
    await predecessorVault.initializeController(predecessorPolicy.address)
  ).wait();
  await (
    await disputeRegistry.addWritePermission(predecessorPolicy.address)
  ).wait();
  await (
    await predecessorPolicy.setLifecycleHookAuthorization(
      predecessorHook.address,
      true
    )
  ).wait();
  for (const method of ["paypal", "venmo"]) {
    await (
      await predecessorPolicy.setRiskWindow(
        hash(method),
        DISPUTE_RISK_WINDOW.hardhat
      )
    ).wait();
  }
  await (await orchestrator.setLifecycleHook(predecessorHook.address)).wait();
  return {
    deployer,
    extraWriter,
    deployRecord,
    usdc,
    fakeHre,
    records,
    deployCalls: () => deployCalls,
    registry,
    nrv2,
    upv3,
    disputeRegistry,
    orchestrator,
    predecessorPolicy,
    predecessorHook,
    catalog,
  };
}

/** @param {Awaited<ReturnType<typeof localhostFixture>>} state */
async function routingSnapshot(state) {
  const methods = /** @type {string[]} */ (
    await state.registry.getPaymentMethods()
  );
  return {
    nullifierWriters: await state.nrv2.getWriters(),
    disputeWriters: await state.disputeRegistry.getWriters(),
    hook: await state.orchestrator.lifecycleHook(),
    routes: await Promise.all(
      methods.map(async (method) => ({
        method,
        verifier: await state.registry.getVerifier(method),
        currencies: await state.registry.getCurrencies(method),
      }))
    ),
  };
}

/** @param {Awaited<ReturnType<typeof localhostFixture>>} state @param {string} verifier @param {string[]} writers @param {string} hook */
function expectedRouting(state, verifier, writers, hook) {
  return {
    nullifierWriters: [verifier],
    disputeWriters: writers,
    hook,
    routes: state.catalog.map((row) => ({ ...row, verifier })),
  };
}

test("local lane 45 recovers a vault with preexisting stake", async () => {
  const state = await localhostFixture();
  const vault = await state.deployRecord("StakeVaultBypass", "StakeVault", [
    state.deployer,
    state.usdc.address,
    ethers.constants.AddressZero,
    0,
  ]);
  const amount = 100;
  await (await state.usdc.transfer(state.extraWriter.address, amount)).wait();
  await (
    await state.usdc.connect(state.extraWriter).approve(vault.address, amount)
  ).wait();
  await (await vault.connect(state.extraWriter).depositStake(amount)).wait();
  const totalStaked = await vault.totalStaked();

  await deployLane45(state.fakeHre);

  assert.equal(
    await vault.controller(),
    state.records.get("DisputeProtectionPolicyBypass").address
  );
  assert.equal(await vault.pendingController(), ethers.constants.AddressZero);
  assert.equal((await vault.pendingControllerValidAt()).toString(), "0");
  assert.equal((await vault.totalStaked()).toString(), totalStaked.toString());
});

test("local lane 45 prepares without activation and lane 46 activates idempotently in-process", async () => {
  const state = await localhostFixture();
  const before = await routingSnapshot(state);
  assert.deepEqual(
    before,
    expectedRouting(
      state,
      state.upv3.address,
      [state.predecessorPolicy.address],
      state.predecessorHook.address
    )
  );
  const initialCalls = state.deployCalls();
  await deployLane45(state.fakeHre);
  for (const name of BYPASS_DEPLOYMENT_NAMES)
    assert.ok(state.records.get(name), name);
  const requiredAbiFunctions = /** @type {Array<[string, string[]]>} */ ([
    ["DisputeProtectionPolicyBypass", ["validatePayment", "setIntentNoStake"]],
    ["UnifiedPaymentVerifierV4", ["addPaymentMethod", "DOMAIN_SEPARATOR"]],
  ]);
  for (const [recordName, functionNames] of requiredAbiFunctions) {
    const abi = state.records.get(recordName).abi;
    for (const functionName of functionNames) {
      assert.ok(
        abi.some(
          (/** @type {{ type: string, name?: string }} */ entry) =>
            entry.type === "function" && entry.name === functionName
        ),
        `${recordName} ABI is missing ${functionName}`
      );
    }
  }
  assert.equal(state.deployCalls(), initialCalls + 4);
  const vault = await ethers.getContractAt(
    "StakeVault",
    state.records.get("StakeVaultBypass").address
  );
  const policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    state.records.get("DisputeProtectionPolicyBypass").address
  );
  const hook = state.records.get("IntentLifecycleHookV1Bypass").address;
  const upv4 = await ethers.getContractAt(
    "UnifiedPaymentVerifierV4",
    state.records.get("UnifiedPaymentVerifierV4").address
  );
  assert.equal(
    BigNumber.from(await vault.controllerChangeDelay()).toString(),
    "0"
  );
  assert.equal(await vault.controller(), policy.address);
  assert.equal(await policy.isLifecycleHookAuthorized(hook), true);
  const checkedMethods = new Set([
    ...ACTIVE_PAYMENT_METHODS,
    ...RETIRED_DISPUTABLE_PAYMENT_METHODS,
    ...DISPUTABLE_PAYMENT_METHODS,
    "zelle",
    "cashapp",
  ]);
  for (const method of checkedMethods) {
    const expected = ["paypal", "venmo"].includes(method)
      ? BigNumber.from(DISPUTE_RISK_WINDOW.hardhat).toString()
      : "0";
    assert.equal(
      BigNumber.from(
        await state.predecessorPolicy.getRiskWindow(hash(method))
      ).toString(),
      expected,
      `predecessor ${method}`
    );
    assert.equal(
      BigNumber.from(await policy.getRiskWindow(hash(method))).toString(),
      expected,
      `fresh ${method}`
    );
  }
  assert.deepEqual(
    await upv4.getPaymentMethods(),
    state.catalog.map((row) => row.method)
  );
  assert.deepEqual(await routingSnapshot(state), before);
  const preparedCalls = state.deployCalls();
  await deployLane45(state.fakeHre);
  assert.equal(state.deployCalls(), preparedCalls);
  assert.deepEqual(await routingSnapshot(state), before);
  await activateLane46(state.fakeHre);
  const activated = expectedRouting(
    state,
    upv4.address,
    [state.predecessorPolicy.address, policy.address],
    hook
  );
  assert.deepEqual(await routingSnapshot(state), activated);
  const nonce = await ethers.provider.getTransactionCount(state.deployer);
  await activateLane46(state.fakeHre);
  assert.equal(
    await ethers.provider.getTransactionCount(state.deployer),
    nonce
  );
  assert.equal(state.deployCalls(), preparedCalls);
  assert.deepEqual(await routingSnapshot(state), activated);
});

test("local lane 46 rejects an extra nullifier writer without changing state", async () => {
  const state = await localhostFixture();
  await deployLane45(state.fakeHre);
  await (await state.nrv2.addWritePermission(state.extraWriter.address)).wait();
  const before = await routingSnapshot(state);
  const nonce = await ethers.provider.getTransactionCount(state.deployer);
  const calls = state.deployCalls();
  await assert.rejects(activateLane46(state.fakeHre), /unrecognized/);
  assert.equal(
    await ethers.provider.getTransactionCount(state.deployer),
    nonce
  );
  assert.equal(state.deployCalls(), calls);
  assert.deepEqual(await routingSnapshot(state), before);
});
