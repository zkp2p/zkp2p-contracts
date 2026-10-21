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
      lane45: require("../deploy/45_deploy_orchestrator_v4_stack.ts"),
      lane46: require("../deploy/46_activate_orchestrator_v4_stack.ts"),
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
  O4_DEPLOYMENT_NAMES,
  O4_ARTIFACT_NAMES,
  O4_EXPECTED_LIVE,
  expectedPaymentMethodCurrencies,
} = require("../deployments/orchestratorV4Stack.ts");
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

test("lane 45 exports its O4 stack identity, tags, and live flags", () => {
  assert.deepEqual(O4_DEPLOYMENT_NAMES, [
    "StakeVaultV2",
    "AddressGroupRegistryV4",
    "WhitelistPolicyV2",
    "DisputeProtectionPolicyV2",
    "UnifiedPaymentVerifierV4",
    "OrchestratorV4",
    "ProtocolViewerV4",
  ]);
  assert.deepEqual(O4_ARTIFACT_NAMES, {
    StakeVaultV2: "StakeVaultV2",
    AddressGroupRegistryV4: "AddressGroupRegistry",
    WhitelistPolicyV2: "WhitelistPolicyV2",
    DisputeProtectionPolicyV2: "DisputeProtectionPolicyV2",
    UnifiedPaymentVerifierV4: "UnifiedPaymentVerifierV4",
    OrchestratorV4: "OrchestratorV4",
    ProtocolViewerV4: "ProtocolViewerV4",
  });
  assert.deepEqual(lane45.default.tags, [
    "45_deploy_orchestrator_v4_stack",
    "OrchestratorV4Stack",
  ]);
  assert.deepEqual(lane45.default.dependencies, []);
  assert.deepEqual(lane45.LIVE_FLAGS, {
    base_staging: "ENABLE_STAGING_ORCHESTRATOR_V4_STACK_DEPLOYMENT",
    base: "ENABLE_BASE_ORCHESTRATOR_V4_STACK_DEPLOYMENT",
  });
});

test("lane 45 pins exact live step order and classifies only contiguous prefixes", () => {
  assert.deepEqual(lane45.LANE_45_STEP_KINDS.base_staging, [
    "deploy-vault",
    "deploy-group-registry",
    "deploy-whitelist",
    "deploy-policy",
    "authorize-controller",
    "deploy-verifier",
    "add-verifier-method:upi",
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
    "add-verifier-method:xmoney",
    "deploy-orchestrator",
    "set-orchestrator-policy",
    "deploy-viewer",
  ]);
  assert.deepEqual(lane45.LANE_45_STEP_KINDS.base, [
    "deploy-vault",
    "deploy-group-registry",
    "deploy-whitelist",
    "deploy-policy",
    "authorize-controller",
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
    "deploy-orchestrator",
    "set-orchestrator-policy",
    "set-allow-multiple-intents",
    "deploy-viewer",
    "transfer-vault-owner",
    "transfer-policy-owner",
    "transfer-verifier-owner",
    "transfer-orchestrator-owner",
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
  const base = O4_EXPECTED_LIVE.base;
  const staging = O4_EXPECTED_LIVE.base_staging;
  assert.deepEqual(base.retainedDisputeWriters, [
    base.predecessorPolicy.address,
  ]);
  assert.equal(base.allowMultipleIntents, true);
  // Staging keeps the retired relayer-bypass and first-O4 policies as dispute writers.
  assert.deepEqual(staging.retainedDisputeWriters, [
    staging.predecessorPolicy.address,
    "0x1a9C442E3Ae99fB08313242fCdA601431027B39C",
    "0x9dfB75e0ef06Bf757176c5bE3C9537c6ccdB5215",
  ]);
  assert.equal(staging.allowMultipleIntents, false);
  assert.deepEqual(
    O4_EXPECTED_LIVE.base.paymentMethods,
    getActivePaymentMethods("base")
  );
  assert.deepEqual(
    [...O4_EXPECTED_LIVE.base_staging.paymentMethods].sort(),
    [...lane31.RATIFIED_PAYMENT_METHOD_ORDER.base_staging].sort()
  );
  assert.deepEqual(
    [...O4_EXPECTED_LIVE.base_staging.paymentMethods].sort(),
    [...getActivePaymentMethods("base_staging")].sort()
  );
  assert.equal(O4_EXPECTED_LIVE.base.governance, MULTI_SIG.base);
  assert.equal(
    O4_EXPECTED_LIVE.base_staging.governance,
    O4_EXPECTED_LIVE.base_staging.deployer
  );
  for (const network of /** @type {const} */ (["base", "base_staging"])) {
    const pins = O4_EXPECTED_LIVE[network];
    assert.deepEqual(pins.predecessorRiskWindows, { paypal: "1209600", venmo: "1209600" });
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

test("lane 45 live pins match the committed dispute evidence and records", () => {
  for (const network of /** @type {const} */ (["base", "base_staging"])) {
    const pins = O4_EXPECTED_LIVE[network];
    /** @type {{ addresses: Record<string, string>; runtimeCodeHashes: Record<string, string> }} */
    const evidence = require("../deployments/dispute-stack-evidence.json")
      .networks[network];
    /** @type {Array<[string, { address: string; runtimeCodeHash: string }]>} */
    const evidencePins = [
      ["StakeVault", pins.predecessorVault],
      ["DisputeProtectionPolicy", pins.predecessorPolicy],
      ["IntentLifecycleHookV1", pins.predecessorHook],
      ["WhitelistPolicy", pins.whitelistPolicy],
      ["DisputeVerifier", pins.disputeVerifier],
      ["DisputeNullifierRegistry", pins.disputeNullifierRegistry],
    ];
    for (const [name, pin] of evidencePins) {
      assert.equal(evidence.addresses[name], pin.address, `${network} ${name}`);
      assert.equal(
        evidence.runtimeCodeHashes[name],
        pin.runtimeCodeHash,
        `${network} ${name}`
      );
    }
    for (const [name, address] of [
      ["UnifiedPaymentVerifierV3", pins.unifiedPaymentVerifierV3.address],
      ["PaymentVerifierRegistry", pins.paymentVerifierRegistry.address],
      ["EscrowV2", pins.escrow],
    ])
      assert.equal(
        require(`../deployments/${network}/${name}.json`).address,
        address,
        `${network} ${name}`
      );
    assert.deepEqual(
      require("../deployments/active-dispute-stack.json").networks[network],
      {
        StakeVault: "StakeVaultMethodScoped",
        DisputeProtectionPolicy: "DisputeProtectionPolicyMethodScopedStaked",
        IntentLifecycleHookV1: "IntentLifecycleHookV1MethodScopedStaked",
        WhitelistPolicy: "WhitelistPolicyMethodScoped",
      }
    );
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
        DEPLOY_ACTIVE_TAG: "45_deploy_orchestrator_v4_stack",
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

test("lane 45 live preparation never changes writers, routes, O3's hook, or registrations", () => {
  const source = readFileSync(
    join(process.cwd(), "deploy/45_deploy_orchestrator_v4_stack.ts"),
    "utf8"
  );
  const start = source.indexOf("async function deployLiveO4Stack");
  const end = source.indexOf("async function deployFresh", start);
  assert.ok(start >= 0 && end > start);
  const livePath = source.slice(start, end);
  assert.doesNotMatch(
    livePath,
    /\.addWritePermission\(|\.removeWritePermission\(|orchestratorV3\.setLifecycleHook\(|removePaymentMethod\(|registry\.addPaymentMethod\(/
  );
  assert.ok(livePath.includes("verifier.addPaymentMethod("));
  assert.equal(
    (livePath.match(/\.transferOwnership\(context\.governance\)/g) || [])
      .length,
    4
  );
  assert.doesNotMatch(source, /\.addOrchestrator\(|setOrchestratorAuthorization/);
  assert.doesNotMatch(source, /orchestratorV3\.setLifecycleHook\(/);
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
    getOrNull: async (/** @type {string} */ name) => records.get(name) || null,
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
    orchestrators,
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

test("local lane 45 gives O4 a fresh whitelist on a fresh group registry", async () => {
  const state = await localhostFixture();
  await deployLane45(state.fakeHre);
  const old = await ethers.getContractAt("WhitelistPolicy", state.records.get("WhitelistPolicyMethodScoped").address);
  const o4 = await ethers.getContractAt("OrchestratorV4", state.records.get("OrchestratorV4").address);
  const policy = await ethers.getContractAt("DisputeProtectionPolicyV2", state.records.get("DisputeProtectionPolicyV2").address);
  assert.notEqual(await o4.whitelistPolicy(), old.address);
  const fresh = await ethers.getContractAt("WhitelistPolicyV2", state.records.get("WhitelistPolicyV2").address);
  assert.equal(await o4.whitelistPolicy(), fresh.address);
  assert.equal(await policy.orchestratorRegistry(), state.orchestrators.address);
  const groupRegistry = state.records.get("AddressGroupRegistryV4").address;
  assert.equal(await fresh.groupRegistry(), groupRegistry);
  assert.notEqual(await old.groupRegistry(), groupRegistry);
  assert.equal(await state.predecessorHook.whitelistPolicy(), old.address);
});

test("lane 45 validates recorded whitelist constructor dependencies against pins and chain", async () => {
  for (const network of ["base", "base_staging"]) {
    const record = require(`../deployments/${network}/WhitelistPolicyMethodScoped.json`);
    const fields = ["groupRegistry", "escrowRegistry", "orchestratorRegistry"];
    const values = Object.fromEntries(fields.map((field, index) => [field, record.args[index]]));
    const hre = /** @type {any} */ ({
      deployments: { get: async () => record, getNetworkName: () => network },
      ethers: { getContractAt: async () => Object.fromEntries(fields.map((field) => [field, async () => values[field]])) },
    });
    const result = await lane45.readWhitelistDependencies(hre);
    assert.equal(result.groupRegistry, record.args[0]);
    for (const field of fields) {
      const original = values[field];
      values[field] = ethers.constants.AddressZero;
      await assert.rejects(lane45.readWhitelistDependencies(hre), new RegExp(`${field} constructor dependency drifted`));
      values[field] = original;
    }
    hre.deployments.get = async () => ({ ...record, args: record.args.slice(1) });
    await assert.rejects(lane45.readWhitelistDependencies(hre), /constructor args are invalid/);
    const wrong = [ethers.constants.AddressZero, ...record.args.slice(1)];
    values.groupRegistry = wrong[0];
    hre.deployments.get = async () => ({ ...record, args: wrong });
    await assert.rejects(lane45.readWhitelistDependencies(hre), /groupRegistry constructor dependency drifted/);
  }
});

test("local lane 45 rejects a fresh whitelist on another group registry on resume", async () => {
  const state = await localhostFixture();
  await deployLane45(state.fakeHre);
  const otherRegistry = await deployContract("AddressGroupRegistry");
  state.records.delete("WhitelistPolicyV2");
  await state.deployRecord("WhitelistPolicyV2", "WhitelistPolicyV2", [otherRegistry.address]);
  await assert.rejects(deployLane45(state.fakeHre), /Fresh WhitelistPolicyV2 groupRegistry drifted/);
});

test("local lane 45 authorizes its policy despite preexisting stake", async () => {
  const state = await localhostFixture();
  const vault = await state.deployRecord("StakeVaultV2", "StakeVaultV2", [
    state.deployer,
    state.usdc.address,
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
    await vault.isController(state.records.get("DisputeProtectionPolicyV2").address),
    true
  );
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
  for (const name of O4_DEPLOYMENT_NAMES)
    assert.ok(state.records.get(name), name);
  const requiredAbiFunctions = /** @type {Array<[string, string[]]>} */ ([
    ["DisputeProtectionPolicyV2", ["settleIntent", "onDeferredPayoutFunded", "release", "getProtection", "submitDispute", "orchestratorRegistry"]],
    ["StakeVaultV2", ["withdrawStakeTo", "payOutLock", "isController", "setController", "lockController"]],
    ["OrchestratorV4", ["supportsInterface", "setSettlementPolicy", "extendIntent"]],
    ["UnifiedPaymentVerifierV4", ["addPaymentMethod", "DOMAIN_SEPARATOR"]],
    ["WhitelistPolicyV2", ["isWhitelisted", "setEnabled", "setGroups", "setTakers"]],
    ["ProtocolViewerV4", ["getIntentV4", "getIntentsV4", "getAccountIntentsV4"]],
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
  /** @type {Array<[string, string[]]>} */
  const removedAbiEntries = [
    ["DisputeProtectionPolicyV2", [
      "claimFor", "isDepositOptedOutForRelayerBypass", "setDepositOptOutForRelayerBypass",
      "DepositOptOutForRelayerBypassUpdated", "setOrchestratorAuthorization", "isOrchestratorAuthorized",
      "OrchestratorAuthorizationUpdated", "whitelistPolicy", "relayerRegistry", "supportsInterface",
      "getDisputeProtectionIntent", "DisputeProtectionIntentSettled", "DeferredPayoutClaimed",
    ]],
    ["StakeVaultV2", ["payOutStake", "StakePaidOut", "increaseLock", "resizeLock", "isLockMature"]],
    ["OrchestratorV4", [
      "setDepositPreIntentHook", "getDepositPreIntentHook", "getIntentSettlementPolicy",
      "IntentSettlementPolicySnapshotted",
    ]],
    ["WhitelistPolicyV2", ["owner", "bootstrapDeposits", "configureDeposit"]],
  ];
  for (const [recordName, names] of removedAbiEntries) {
    const abi = state.records.get(recordName).abi;
    for (const name of names)
      assert.equal(
        abi.some((/** @type {{ name?: string }} */ entry) => entry.name === name),
        false,
        `${recordName} ABI still has ${name}`
      );
  }
  assert.equal(state.deployCalls(), initialCalls + 7);
  const vault = await ethers.getContractAt(
    "StakeVaultV2",
    state.records.get("StakeVaultV2").address
  );
  const policy = await ethers.getContractAt(
    "DisputeProtectionPolicyV2",
    state.records.get("DisputeProtectionPolicyV2").address
  );
  const o4Address = state.records.get("OrchestratorV4").address;
  const upv4 = await ethers.getContractAt(
    "UnifiedPaymentVerifierV4",
    state.records.get("UnifiedPaymentVerifierV4").address
  );
  assert.equal(await vault.isController(policy.address), true);
  assert.equal(await policy.orchestratorRegistry(), state.orchestrators.address);
  assert.equal(await state.orchestrators.isOrchestrator(o4Address), false);
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
  const policyAbi = state.records.get("DisputeProtectionPolicyV2").abi;
  for (const name of [
    "validatePayment", "setIntentNoStake", "paymentMethodRiskWindow",
    "setRiskWindow", "getRiskWindow", "RiskWindowUpdated",
    "admissionsPaused", "setAdmissionsPaused", "AdmissionsPausedUpdated",
    "DeferredPayoutFunded",
  ])
    assert.equal(
      policyAbi.some(
        (/** @type {{name?: string}} */ entry) => entry.name === name
      ),
      false
    );
  const protection = policyAbi.find((/** @type {{name?: string}} */ entry) => entry.name === "getProtection")
    .outputs[0].components;
  assert.deepEqual(protection.map((/** @type {{name: string, type: string}} */ entry) => [entry.name, entry.type]), [
    ["depositor", "address"], ["deferredPayout", "bool"], ["paymentMethod", "bytes32"],
  ]);
  const openedEvent = policyAbi.find((/** @type {{name?: string}} */ entry) => entry.name === "ProtectionOpened");
  assert.deepEqual(openedEvent.inputs.map((/** @type {{name: string, type: string}} */ entry) => [entry.name, entry.type]), [
    ["intentHash", "bytes32"], ["depositor", "address"],
  ]);
  const verificationOutputs = state.records
    .get("UnifiedPaymentVerifierV4")
    .abi.find(
      (/** @type {{name?: string}} */ entry) => entry.name === "verifyPayment"
    ).outputs;
  assert.deepEqual(
    verificationOutputs.map(
      (/** @type {{name: string, type: string}} */ entry) => [entry.name, entry.type]
    ),
    [["result", "tuple"], ["settlementData", "bytes"]]
  );
  assert.deepEqual(
    verificationOutputs[0].components.map(
      (/** @type {{name: string, type: string}} */ entry) => [entry.name, entry.type]
    ),
    [
      ["success", "bool"],
      ["intentHash", "bytes32"],
      ["releaseAmount", "uint256"],
      ["attestedReleaseAmount", "uint256"],
      ["payment", "tuple"],
      ["intent", "tuple"],
    ]
  );
  const settlementContext = state.records
    .get("DisputeProtectionPolicyV2")
    .abi.find(
      (/** @type {{name?: string}} */ entry) => entry.name === "settleIntent"
    ).inputs[0].components;
  assert.deepEqual(
    settlementContext.map(
      (/** @type {{name: string, type: string}} */ entry) => [entry.name, entry.type]
    ),
    [
      ["intentHash", "bytes32"],
      ["token", "address"],
      ["taker", "address"],
      ["recipient", "address"],
      ["depositor", "address"],
      ["paymentMethod", "bytes32"],
      ["releaseAmount", "uint256"],
      ["netAmount", "uint256"],
      ["settlementData", "bytes"],
    ]
  );
  const policyInterface = new ethers.utils.Interface(policyAbi);
  for (const name of ["onIntentSignaled", "onIntentCancelled", "onIntentSettled", "conditionsHashOf"])
    assert.equal(Object.values(policyInterface.functions).some((entry) => entry.name === name), false);
  const o4Abi = state.records.get("OrchestratorV4").abi;
  const v3Abi = state.records.get("OrchestratorV3").abi;
  /** @param {any[]} abi */
  const signalFields = (abi) => new ethers.utils.Interface(abi)
    .getFunction("signalIntent").inputs[0].components.map(
      (/** @type {{name: string, type: string}} */ entry) => [entry.name, entry.type]
    );
  assert.deepEqual(signalFields(o4Abi), [
    ...signalFields(v3Abi).filter(
      ([name]) => !["postIntentHook", "preIntentHookData", "data"].includes(name)
    ),
    ["payerCommitment", "bytes"],
    ["groupId", "bytes32"],
  ]);
  /** @param {any[]} abi */
  const intentFields = (abi) => {
    const outputs = new ethers.utils.Interface(abi).getFunction("getIntent").outputs;
    assert.ok(outputs);
    return outputs[0].components.map(
      (/** @type {{name: string, type: string}} */ entry) => [entry.name, entry.type]
    );
  };
  assert.deepEqual(intentFields(o4Abi), [
    ...intentFields(v3Abi).filter(([name]) => !["postIntentHook", "data"].includes(name)),
    ["payerCommitment", "bytes"],
    ["takerWhitelisted", "bool"],
    ["arbitrator", "address"],
  ]);
  const o4Interface = new ethers.utils.Interface(o4Abi);
  /** @param {{ name: string, type: string }[]} inputs */
  const fields = (inputs) => inputs.map((entry) => [entry.name, entry.type]);
  assert.deepEqual(fields(o4Interface.getFunction("releaseFundsToPayer").inputs), [
    ["_intentHash", "bytes32"], ["_releaseAmount", "uint256"],
  ]);
  assert.deepEqual(fields(o4Interface.getEvent("IntentFulfilled").inputs), [
    ["intentHash", "bytes32"], ["fundsTransferredTo", "address"], ["amount", "uint256"], ["releasedBy", "address"],
  ]);
  assert.equal(o4Abi.some(
    (/** @type {{name?: string}} */ entry) => /conditions/i.test(entry.name || "")
  ), false);
  await activateLane46(state.fakeHre);
  const o4 = await ethers.getContractAt(
    "OrchestratorV4",
    state.records.get("OrchestratorV4").address
  );
  assert.equal(await state.orchestrators.isOrchestrator(o4.address), true);
  assert.equal(await o4.settlementPolicy(), policy.address);
  await assertO4Config(state, o4);
  const activated = expectedRouting(
    state,
    upv4.address,
    [state.predecessorPolicy.address, policy.address],
    state.predecessorHook.address
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

test("recorded O4 records use address and runtime pins across build caches", async () => {
  const {
    O4_RECORDED_DEPLOYMENTS,
    assertO4DeploymentRecord,
  } = require("../deployments/orchestratorV4Stack.ts");
  const pins = Object.fromEntries(
    O4_DEPLOYMENT_NAMES.map((name, i) => [
      name,
      {
        address: ethers.utils.getAddress(
          `0x${(i + 1).toString(16).padStart(40, "0")}`
        ),
        runtimeCodeHash: ethers.utils.keccak256("0x6000"),
      },
    ])
  );
  const original = O4_RECORDED_DEPLOYMENTS.base_staging;
  O4_RECORDED_DEPLOYMENTS.base_staging =
    /** @type {NonNullable<typeof O4_RECORDED_DEPLOYMENTS.base_staging>} */ (
      pins
    );
  try {
    for (const name of O4_DEPLOYMENT_NAMES) {
      const pin = pins[name];
      const previousHash = pin.runtimeCodeHash;
      const record = {
        address: pin.address,
        abi: [],
        deployedBytecode: "0x6000",
        solcInputHash: "deploying-cache",
      };
      /** @type {Array<string | number | undefined>} */
      const blocks = [];
      const fake = /** @type {any} */ ({
        deployments: {
          /** @param {string} artifact */
          getExtendedArtifact: async (artifact) => {
            assert.equal(artifact, O4_ARTIFACT_NAMES[name]);
            return { deployedBytecode: "0x6000", solcInputHash: "clean-cache" };
          },
        },
        ethers: {
          provider: {
            /** @param {string} address @param {string | number} [block] */
            getCode: async (address, block) => {
              assert.equal(address, record.address);
              blocks.push(block);
              return "0x6000";
            },
          },
        },
      });
      try {
        pin.runtimeCodeHash = ethers.utils.keccak256("0x6000");
        await assertO4DeploymentRecord(
          fake,
          "base_staging",
          name,
          record,
          123
        );
        assert.ok(blocks.length > 0 && blocks.every((block) => block === 123));
        record.address = ethers.constants.AddressZero;
        await assert.rejects(
          assertO4DeploymentRecord(fake, "base_staging", name, record),
          /deployment address mismatch/
        );
        record.address = pin.address;
        pin.runtimeCodeHash = ethers.utils.keccak256("0x6001");
        await assert.rejects(
          assertO4DeploymentRecord(fake, "base_staging", name, record),
          /runtime bytecode hash mismatch/
        );
        for (const network of ["base", "hardhat"])
          await assert.rejects(
            assertO4DeploymentRecord(fake, network, name, record),
            /lacks canonical deployment evidence/
          );
      } finally {
        pin.runtimeCodeHash = previousHash;
      }
    }
  } finally {
    if (original === undefined) delete O4_RECORDED_DEPLOYMENTS.base_staging;
    else O4_RECORDED_DEPLOYMENTS.base_staging = original;
  }
});

/** @param {Awaited<ReturnType<typeof localhostFixture>>} state @param {import("ethers").Contract} o4 */
async function assertO4Config(state, o4) {
  for (const field of [
    "escrowRegistry",
    "paymentVerifierRegistry",
    "relayerRegistry",
    "protocolFeeRecipient",
    "allowMultipleIntents",
  ])
    assert.equal(await o4[field](), await state.orchestrator[field](), field);
  for (const field of ["chainId", "protocolFee"])
    assert.equal(
      (await o4[field]()).toString(),
      (await state.orchestrator[field]()).toString(),
      field
    );
}

test("local lane 45 prepares seven inert records and mirrors O3 config", async () => {
  for (const multiple of [false, true]) {
    const state = await localhostFixture();
    await (await state.orchestrator.setAllowMultipleIntents(multiple)).wait();
    const before = await routingSnapshot(state);
    const calls = state.deployCalls();
    await deployLane45(state.fakeHre);
    assert.equal(state.deployCalls(), calls + 7);
    const o4 = await ethers.getContractAt(
      "OrchestratorV4",
      state.records.get("OrchestratorV4").address
    );
    await assertO4Config(state, o4);
    assert.equal(
      await o4.settlementPolicy(),
      state.records.get("DisputeProtectionPolicyV2").address
    );
    assert.equal(await state.orchestrators.isOrchestrator(o4.address), false);
    assert.deepEqual(await routingSnapshot(state), before);
    const nonce = await ethers.provider.getTransactionCount(state.deployer);
    await deployLane45(state.fakeHre);
    assert.equal(
      await ethers.provider.getTransactionCount(state.deployer),
      nonce
    );
  }
});

test("lane 45 never registers OrchestratorV4", async () => {
  const state = await localhostFixture();
  await deployLane45(state.fakeHre);
  await (
    await state.orchestrators.addOrchestrator(
      state.records.get("OrchestratorV4").address
    )
  ).wait();
  await assert.rejects(
    deployLane45(state.fakeHre),
    /OrchestratorV4 registered before lane 46/
  );
});

test("local lane 45 rejects an O4 whose fee recipient differs from O3", async () => {
  const state = await localhostFixture();
  await deployLane45(state.fakeHre);
  const o4 = await ethers.getContractAt(
    "OrchestratorV4",
    state.records.get("OrchestratorV4").address
  );
  await (await o4.setProtocolFeeRecipient(state.extraWriter.address)).wait();
  await assert.rejects(
    deployLane45(state.fakeHre),
    /Fresh OrchestratorV4 .* drifted/
  );
});

test("lane 45 rejects policy lifecycle activity before cutover and removed events", () => {
  /** @param {string} name */
  const event = (name) => ({
    name,
    transactionHash: "0xtest",
    blockNumber: 0,
    transactionIndex: 0,
    logIndex: 0,
  });
  for (const name of ["ProtectionOpened", "ProtectionReleased", "DisputeResolved"]) {
    assert.throws(
      () => lane45.classifyO4PolicyActivity([event(name)], true),
      /lifecycle activity/
    );
    lane45.classifyO4PolicyActivity([event(name)], false);
  }
  for (const name of ["DisputeVerifierUpdated", "OwnershipTransferStarted", "OwnershipTransferred"])
    lane45.classifyO4PolicyActivity([event(name)], true);
  for (const removed of [
    "DisputeProtectionIntentSettled",
    "DeferredPayoutClaimed",
    "OrchestratorAuthorizationUpdated",
    "DepositOptOutForRelayerBypassUpdated",
  ]) {
    for (const beforeCutover of [true, false])
      assert.throws(
        () => lane45.classifyO4PolicyActivity([event(removed)], beforeCutover),
        /unclassified event/
      );
  }
});

test("lane 45 reads an empty record set and rejects a non-contiguous prefix", async () => {
  /** @type {Map<string, any>} */
  const records = new Map();
  const hre = /** @type {any} */ ({
    deployments: {
      getOrNull: async (/** @type {string} */ name) => records.get(name),
    },
  });
  const context = /** @type {any} */ ({ network: "base_staging" });
  const state = await lane45.readFreshState(hre, context);
  assert.deepEqual(state.deployments, [null, null, null, null, null, null, null]);
  assert.deepEqual(state.contracts, {});
  assert.deepEqual(state.completed, {
    "deploy-vault": false,
    "deploy-group-registry": false,
    "deploy-whitelist": false,
    "deploy-policy": false,
    "deploy-verifier": false,
    "deploy-orchestrator": false,
    "deploy-viewer": false,
  });
  records.set("OrchestratorV4", { address: ethers.constants.AddressZero });
  await assert.rejects(
    lane45.readFreshState(hre, context),
    /O4 deployment artifacts are not a contiguous prefix/
  );
});

test("local lane 45 prepared check verifies the complete inert stack", async () => {
  const state = await localhostFixture();
  assert.equal(await lane45.orchestratorV4StackPrepared(state.fakeHre), false);
  await deployLane45(state.fakeHre);
  assert.equal(await lane45.orchestratorV4StackPrepared(state.fakeHre), true);
});

test("lane 45 live step handlers only configure the fresh stack on Base and staging", async () => {
  for (const network of /** @type {const} */ (["base", "base_staging"])) {
    const pins = O4_EXPECTED_LIVE[network];
    const {
      EXPECTED_LIVE,
    } = require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts");
    const expected = EXPECTED_LIVE[network];
    /** @type {Array<[string, unknown[]]>} */
    const writes = [];
    /** @param {string} name */
    const transaction =
      (name) =>
      async (/** @type {unknown[]} */ ...args) => {
        writes.push([name, args]);
        return { wait: async () => {} };
      };
    /** @type {Map<string, any>} */
    const records = new Map();
    const addresses = Object.fromEntries(
      O4_DEPLOYMENT_NAMES.map((name, i) => [
        name,
        ethers.utils.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
      ])
    );
    /** @type {any} */
    const hre = {
      deployments: {
        getOrNull: async (/** @type {string} */ name) =>
          records.get(name) || null,
        deploy: async (
          /** @type {string} */ name,
          /** @type {any} */ options
        ) => {
          const record = {
            address: addresses[name],
            newlyDeployed: true,
            ...options,
          };
          records.set(name, record);
          return record;
        },
      },
    };
    /** @type {any} */
    const context = {
      network,
      deployer: pins.deployer,
      governance: pins.governance,
      stakeToken: pins.stakeToken,
      disputeVerifier: pins.disputeVerifier.address,
      disputeNullifierRegistry: pins.disputeNullifierRegistry.address,
      orchestratorRegistry: expected.orchestratorRegistry,
      nullifierRegistryV2: expected.nullifierRegistryV2,
      attestationVerifier: expected.attestationVerifier,
      chainId: 8453,
      escrowRegistry: expected.escrowRegistry,
      paymentVerifierRegistry: expected.paymentVerifierRegistry,
      relayerRegistry: expected.relayerRegistry,
      protocolFee: "0",
      protocolFeeRecipient: expected.protocolFeeRecipient,
    };
    /** @type {any} */
    const state = {
      contracts: {
        groupRegistry: { address: addresses.AddressGroupRegistryV4 },
        whitelist: { address: addresses.WhitelistPolicyV2 },
        vault: {
          address: addresses.StakeVaultV2,
          isController: async () => false,
          setController: transaction("vault.setController"),
          transferOwnership: transaction("vault.transferOwnership"),
        },
        policy: {
          address: addresses.DisputeProtectionPolicyV2,
          transferOwnership: transaction("policy.transferOwnership"),
        },
        verifier: {
          addPaymentMethod: transaction("verifier.addPaymentMethod"),
          transferOwnership: transaction("verifier.transferOwnership"),
        },
        orchestrator: {
          address: addresses.OrchestratorV4,
          setSettlementPolicy: transaction("O4.setSettlementPolicy"),
          setAllowMultipleIntents: transaction("O4.setAllowMultipleIntents"),
          transferOwnership: transaction("O4.transferOwnership"),
        },
      },
    };
    for (const step of lane45.LANE_45_STEP_KINDS[network])
      await lane45.executeLane45Step(hre, context, state, step);
    assert.deepEqual([...records.keys()], O4_DEPLOYMENT_NAMES);
    assert.equal(records.get("WhitelistPolicyV2").contract, "WhitelistPolicyV2");
    assert.deepEqual(records.get("ProtocolViewerV4").args, []);
    assert.equal(records.get("AddressGroupRegistryV4").contract, "AddressGroupRegistry");
    assert.deepEqual(records.get("AddressGroupRegistryV4").args, []);
    assert.deepEqual(records.get("WhitelistPolicyV2").args, [addresses.AddressGroupRegistryV4]);
    assert.equal(records.get("StakeVaultV2").contract, "StakeVaultV2");
    assert.deepEqual(records.get("StakeVaultV2").args, [
      pins.deployer,
      pins.stakeToken,
    ]);
    assert.deepEqual(writes.filter(([name]) => name === "vault.setController"), [
      ["vault.setController", [addresses.DisputeProtectionPolicyV2, true]],
    ]);
    assert.deepEqual(records.get("DisputeProtectionPolicyV2").args, [
      pins.deployer,
      addresses.StakeVaultV2,
      pins.disputeVerifier.address,
      pins.disputeNullifierRegistry.address,
      expected.orchestratorRegistry,
    ]);
    assert.deepEqual(records.get("UnifiedPaymentVerifierV4").args, [
      expected.orchestratorRegistry,
      expected.nullifierRegistryV2,
      expected.attestationVerifier,
    ]);
    assert.deepEqual(records.get("OrchestratorV4").args, [
      pins.deployer,
      8453,
      expected.escrowRegistry,
      expected.paymentVerifierRegistry,
      expected.relayerRegistry,
      "0",
      expected.protocolFeeRecipient,
      addresses.WhitelistPolicyV2,
    ]);
    assert.equal(
      writes.filter(([name]) => name.endsWith("transferOwnership")).length,
      network === "base" ? 4 : 0
    );
    assert.deepEqual(
      writes.filter(([name]) => name === "O4.setAllowMultipleIntents"),
      network === "base" ? [["O4.setAllowMultipleIntents", [true]]] : []
    );
    assert.deepEqual(
      writes.filter(([name]) => name.endsWith("setSettlementPolicy")),
      [["O4.setSettlementPolicy", [addresses.DisputeProtectionPolicyV2]]]
    );
    assert.ok(
      writes.every(([name]) => /^(vault|policy|verifier|O4)\./.test(name))
    );
  }
});
