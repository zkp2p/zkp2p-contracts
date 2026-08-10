#!/usr/bin/env node

process.env.DEPLOY_TX_DELAY_MS = "0";
process.env.ALCHEMY_API_KEY = "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
process.env.TESTNET_DEPLOY_PRIVATE_KEY =
  "2222222222222222222222222222222222222222222222222222222222222222";

require("ts-node/register/transpile-only");
require("module-alias/register");

const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const dotenv = require("dotenv");
const moduleAlias = require("module-alias");

dotenv.config = () => ({ parsed: {} });
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

console.log = () => {};

const hre = require("hardhat");
const { ethers } = hre;
const paymentBindingModule = require("../deploy/31_deploy_v3_payment_binding_stack.ts");
const deployPaymentBinding = paymentBindingModule.default;
const {
  RATIFIED_PAYMENT_METHOD_CURRENCIES,
  RATIFIED_PAYMENT_METHOD_ORDER,
  assertPaymentBindingChainId,
} = paymentBindingModule;
const deployAndActivateDispute =
  require("../deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts").default;
const {
  EXPECTED_NETWORK_DEPENDENCIES,
  EXPECTED_ORCHESTRATOR,
  assertFreshStackUnusedBeforeActivation,
  assertLifecycleHookPhase,
  assertStagingRetiredDepositSettingEvidence,
  disputeStackReady,
  stagingDisputeActivationRequested,
} = require("../deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts");
const deploySummary = require("../deploy/deploy_summary.ts").default;
const {
  ACTIVE_PAYMENT_METHODS,
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  MULTI_SIG,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
} = require("../deployments/parameters.ts");
const { safeBatchCollector } = require("../deployments/safeBatchCollector.ts");

function setFlags({
  paymentBinding = false,
  dispute = false,
  activation = false,
  downstreamReady = false,
  predecessorDrained = false,
} = {}) {
  process.env.ENABLE_STAGING_V3_PAYMENT_BINDING_CUTOVER = paymentBinding
    ? "true"
    : "false";
  process.env.ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT = dispute ? "true" : "false";
  process.env.ENABLE_STAGING_V3_DISPUTE_ACTIVATION = activation
    ? "true"
    : "false";
  process.env.CONFIRM_STAGING_V3_DISPUTE_DOWNSTREAM_READY = downstreamReady
    ? "true"
    : "false";
  process.env.CONFIRM_STAGING_V3_DISPUTE_PREDECESSOR_DRAINED =
    predecessorDrained ? "true" : "false";
}

function paymentMethodHash(name) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
}

const EXPECTED_BASE_CURRENCIES = {
  alipay: ["CNY"],
  chime: ["USD"],
  venmo: ["USD"],
  revolut: [
    "USD",
    "EUR",
    "GBP",
    "SGD",
    "NZD",
    "AUD",
    "CAD",
    "JPY",
    "HKD",
    "MXN",
    "SAR",
    "AED",
    "THB",
    "TRY",
    "PLN",
    "CHF",
    "ZAR",
    "CNY",
    "CZK",
    "DKK",
    "HUF",
    "NOK",
    "RON",
    "SEK",
  ],
  cashapp: ["USD"],
  wise: [
    "USD",
    "CNY",
    "EUR",
    "GBP",
    "AUD",
    "NZD",
    "CAD",
    "AED",
    "CHF",
    "ZAR",
    "SGD",
    "ILS",
    "HKD",
    "JPY",
    "PLN",
    "TRY",
    "IDR",
    "KES",
    "MYR",
    "MXN",
    "THB",
    "VND",
    "UGX",
    "CZK",
    "DKK",
    "HUF",
    "INR",
    "NOK",
    "PHP",
    "RON",
    "SEK",
  ],
  mercadopago: ["ARS"],
  zelle: ["USD"],
  monzo: ["GBP"],
  paypal: ["USD", "EUR", "GBP", "SGD", "NZD", "AUD", "CAD"],
};

function ratifiedCurrencySnapshotIsExact() {
  assert.deepEqual(
    RATIFIED_PAYMENT_METHOD_CURRENCIES,
    EXPECTED_BASE_CURRENCIES
  );
  assert.deepEqual(RATIFIED_PAYMENT_METHOD_ORDER.base, [
    "alipay",
    "chime",
    "venmo",
    "revolut",
    "cashapp",
    "wise",
    "mercadopago",
    "zelle",
    "monzo",
    "paypal",
  ]);
  assert.deepEqual(ACTIVE_PAYMENT_METHODS, RATIFIED_PAYMENT_METHOD_ORDER.base);
}

async function deployContract(name, args = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  return contract;
}

async function deploymentEvidence(contract, artifactName, args = []) {
  const receipt = await ethers.provider.getTransactionReceipt(
    contract.deployTransaction.hash
  );
  const artifact = await hre.deployments.getExtendedArtifact(artifactName);
  return {
    address: contract.address,
    args,
    transactionHash: contract.deployTransaction.hash,
    receipt,
    deployedBytecode: await ethers.provider.getCode(contract.address),
    solcInputHash: artifact.solcInputHash,
  };
}

async function freshStackEvidence(state) {
  const deploymentNames = [
    "DisputeNullifierRegistry",
    "DisputeVerifier",
    "StakeVault",
    "DisputeProtectionPolicy",
    "IntentLifecycleHookV1",
  ];
  return {
    deployments: Object.fromEntries(
      deploymentNames.map((name) => [name, state.deployments.get(name)])
    ),
    contracts: {
      disputeNullifierRegistry: await ethers.getContractAt(
        "NullifierRegistry",
        state.deployments.get("DisputeNullifierRegistry").address
      ),
      disputeProtectionPolicy: await ethers.getContractAt(
        "DisputeProtectionPolicy",
        state.deployments.get("DisputeProtectionPolicy").address
      ),
      vault: await ethers.getContractAt(
        "StakeVault",
        state.deployments.get("StakeVault").address
      ),
    },
  };
}

async function fixture({
  networkName = "hardhat",
  includePaymentBinding = true,
} = {}) {
  await ethers.provider.send("hardhat_reset", []);

  const [deployerSigner] = await ethers.getSigners();
  const deployer = deployerSigner.address;
  const network = await ethers.provider.getNetwork();

  const addressGroupRegistry = await deployContract("AddressGroupRegistry");
  const escrowRegistry = await deployContract("EscrowRegistry");
  const orchestratorRegistry = await deployContract("OrchestratorRegistry");
  const paymentVerifierRegistry = await deployContract(
    "PaymentVerifierRegistry"
  );
  const usdc = await deployContract("USDCMock", [
    1_000_000_000,
    "USDC",
    "USDC",
  ]);
  const relayerRegistry = await deployContract("RelayerRegistry");
  const whitelistPolicy = await deployContract("WhitelistPolicy", [
    addressGroupRegistry.address,
    escrowRegistry.address,
    orchestratorRegistry.address,
  ]);
  const whitelistHook = await deployContract("WhitelistLifecycleHook", [
    orchestratorRegistry.address,
    whitelistPolicy.address,
  ]);
  const legacyNullifierRegistry = await deployContract("NullifierRegistry");
  const attestationVerifier = await deployContract(
    "SimpleAttestationVerifier",
    [deployer]
  );
  const legacyUnifiedPaymentVerifier = await deployContract(
    "UnifiedPaymentVerifier",
    [
      orchestratorRegistry.address,
      legacyNullifierRegistry.address,
      attestationVerifier.address,
    ]
  );
  const unifiedPaymentVerifierV2 = await deployContract(
    "UnifiedPaymentVerifier",
    [
      orchestratorRegistry.address,
      legacyNullifierRegistry.address,
      attestationVerifier.address,
    ]
  );
  for (const methodName of ACTIVE_PAYMENT_METHODS) {
    const method = paymentMethodHash(methodName);
    await (await unifiedPaymentVerifierV2.addPaymentMethod(method)).wait();
    await (
      await paymentVerifierRegistry.addPaymentMethod(
        method,
        unifiedPaymentVerifierV2.address,
        RATIFIED_PAYMENT_METHOD_CURRENCIES[methodName].map(paymentMethodHash)
      )
    ).wait();
  }
  await (
    await legacyNullifierRegistry.addWritePermission(
      legacyUnifiedPaymentVerifier.address
    )
  ).wait();
  await (
    await legacyNullifierRegistry.addWritePermission(
      unifiedPaymentVerifierV2.address
    )
  ).wait();
  const orchestrator = await deployContract("OrchestratorV3", [
    deployer,
    network.chainId,
    escrowRegistry.address,
    paymentVerifierRegistry.address,
    relayerRegistry.address,
    0,
    deployer,
  ]);
  await (await orchestrator.setLifecycleHook(whitelistHook.address)).wait();

  const deployments = new Map([
    ["AddressGroupRegistry", { address: addressGroupRegistry.address }],
    ["EscrowRegistry", { address: escrowRegistry.address }],
    ["OrchestratorRegistry", { address: orchestratorRegistry.address }],
    ["PaymentVerifierRegistry", { address: paymentVerifierRegistry.address }],
    ["USDCMock", { address: usdc.address }],
    ["RelayerRegistry", { address: relayerRegistry.address }],
    ["WhitelistPolicy", { address: whitelistPolicy.address }],
    ["WhitelistLifecycleHook", { address: whitelistHook.address }],
    ["OrchestratorV3", { address: orchestrator.address }],
    ["NullifierRegistry", { address: legacyNullifierRegistry.address }],
    [
      "UnifiedPaymentVerifier",
      { address: legacyUnifiedPaymentVerifier.address },
    ],
    ["UnifiedPaymentVerifierV2", { address: unifiedPaymentVerifierV2.address }],
    ["SimpleAttestationVerifier", { address: attestationVerifier.address }],
  ]);
  if (includePaymentBinding) {
    const nullifierRegistryV2 = await deployContract("NullifierRegistryV2", [
      legacyNullifierRegistry.address,
    ]);
    const unifiedPaymentVerifierV3 = await deployContract(
      "UnifiedPaymentVerifierV3",
      [
        orchestratorRegistry.address,
        nullifierRegistryV2.address,
        attestationVerifier.address,
      ]
    );
    for (const methodName of ACTIVE_PAYMENT_METHODS) {
      await (
        await unifiedPaymentVerifierV3.addPaymentMethod(
          paymentMethodHash(methodName)
        )
      ).wait();
    }
    await (
      await nullifierRegistryV2.addWritePermission(
        unifiedPaymentVerifierV3.address
      )
    ).wait();
    deployments.set("NullifierRegistryV2", {
      address: nullifierRegistryV2.address,
    });
    deployments.set("UnifiedPaymentVerifierV3", {
      address: unifiedPaymentVerifierV3.address,
    });
  }

  const deployedNames = [];
  const deploymentApi = {
    getNetworkName: () => networkName,
    get: async (name) => {
      const deployment = deployments.get(name);
      if (!deployment) throw new Error(`Missing deployment: ${name}`);
      return deployment;
    },
    getOrNull: async (name) => deployments.get(name),
    getExtendedArtifact: async (name) =>
      hre.deployments.getExtendedArtifact(name),
    deploy: async (name, options) => {
      const existing = deployments.get(name);
      if (existing) return { ...existing, newlyDeployed: false };
      deployedNames.push(name);
      const contract = await deployContract(
        options.contract || name,
        options.args || []
      );
      const deployment = {
        ...(await deploymentEvidence(
          contract,
          options.contract || name,
          options.args || []
        )),
        newlyDeployed: true,
      };
      deployments.set(name, deployment);
      return deployment;
    },
    rawTx: async (transaction) => {
      const response = await deployerSigner.sendTransaction({
        to: transaction.to,
        data: transaction.data,
      });
      return { transactionHash: response.hash };
    },
  };

  return {
    deployedNames,
    deployments,
    fakeHre: {
      deployments: deploymentApi,
      ethers,
      getUnnamedAccounts: async () => [deployer],
    },
    initialHook: whitelistHook.address,
    orchestrator,
  };
}

async function paymentBindingDeploysFreshOnHardhat() {
  setFlags();
  const state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  assert.equal(await deployPaymentBinding.skip(state.fakeHre), false);
  await deployPaymentBinding(state.fakeHre);
  assert.deepEqual(state.deployedNames, [
    "NullifierRegistryV2",
    "UnifiedPaymentVerifierV3",
  ]);

  const registryDeployment = state.deployments.get("NullifierRegistryV2");
  const verifierDeployment = state.deployments.get("UnifiedPaymentVerifierV3");
  const registry = await ethers.getContractAt(
    "NullifierRegistryV2",
    registryDeployment.address
  );
  const legacyRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    state.deployments.get("NullifierRegistry").address
  );
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    state.deployments.get("PaymentVerifierRegistry").address
  );
  const verifier = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3",
    verifierDeployment.address
  );
  assert.deepEqual(
    (await registry.getWriters()).map((address) => address.toLowerCase()),
    [verifier.address.toLowerCase()]
  );
  assert.equal(
    (await verifier.getPaymentMethods()).length,
    ACTIVE_PAYMENT_METHODS.length
  );
  assert.deepEqual(await legacyRegistry.getWriters(), []);
  for (const methodName of ACTIVE_PAYMENT_METHODS) {
    assert.equal(
      (
        await paymentVerifierRegistry.getVerifier(paymentMethodHash(methodName))
      ).toLowerCase(),
      verifier.address.toLowerCase()
    );
  }
  assert.equal(await deployPaymentBinding.skip(state.fakeHre), true);
}

async function paymentBindingRejectsPartialArtifacts() {
  setFlags();
  const state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  state.deployments.set("NullifierRegistryV2", {
    address: state.deployments.get("NullifierRegistry").address,
  });
  await assert.rejects(
    deployPaymentBinding.skip(state.fakeHre),
    /NullifierRegistryV2 and UnifiedPaymentVerifierV3 artifacts must both exist or both be absent/
  );
}

async function paymentBindingRejectsRoutesWithoutWriterCleanup() {
  setFlags();
  const state = await fixture();
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    state.deployments.get("PaymentVerifierRegistry").address
  );
  const unifiedPaymentVerifierV3 = state.deployments.get(
    "UnifiedPaymentVerifierV3"
  ).address;
  const methods = await paymentVerifierRegistry.getPaymentMethods();
  const currencies = await Promise.all(
    methods.map((method) => paymentVerifierRegistry.getCurrencies(method))
  );
  for (const method of [...methods].reverse()) {
    await (await paymentVerifierRegistry.removePaymentMethod(method)).wait();
  }
  for (let index = 0; index < methods.length; index += 1) {
    await (
      await paymentVerifierRegistry.addPaymentMethod(
        methods[index],
        unifiedPaymentVerifierV3,
        currencies[index]
      )
    ).wait();
  }

  await assert.rejects(
    deployPaymentBinding(state.fakeHre),
    /retired legacy writers remain/
  );
}

async function combinedStagingDeploymentRequiresExplicitFlag() {
  setFlags();
  const state = await fixture({ networkName: "base_staging" });
  assert.equal(await deployAndActivateDispute.skip(state.fakeHre), true);
  assert.deepEqual(state.deployedNames, []);
}

async function disputeDeploymentRejectsMissingPaymentCutover() {
  setFlags();
  const state = await fixture({ networkName: "hardhat" });
  await assert.rejects(
    deployAndActivateDispute(state.fakeHre),
    /V3 payment binding must be fully cut over/
  );
}

async function disputeDeploymentRejectsOrchestratorDriftBeforeDeploying() {
  setFlags();
  const state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  state.deployedNames.length = 0;
  const [deployer] = await ethers.getSigners();
  const orchestratorRegistry = await ethers.getContractAt(
    "OrchestratorRegistry",
    state.deployments.get("OrchestratorRegistry").address
  );
  await (
    await orchestratorRegistry.addOrchestrator(state.orchestrator.address)
  ).wait();
  const chain = await ethers.provider.getNetwork();
  EXPECTED_NETWORK_DEPENDENCIES.hardhat = {
    deployer: deployer.address,
    orchestratorRegistry: orchestratorRegistry.address,
    escrowRegistry: state.deployments.get("EscrowRegistry").address,
    paymentVerifierRegistry: state.deployments.get("PaymentVerifierRegistry")
      .address,
    relayerRegistry: state.deployments.get("RelayerRegistry").address,
    whitelistPolicy: state.deployments.get("WhitelistPolicy").address,
    addressGroupRegistry: state.deployments.get("AddressGroupRegistry").address,
    nullifierRegistryV2: state.deployments.get("NullifierRegistryV2").address,
    stakeToken: state.deployments.get("USDCMock").address,
    controllerChangeDelay: STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  };
  EXPECTED_ORCHESTRATOR.hardhat = {
    address: state.orchestrator.address,
    runtimeCodeHash: ethers.utils.keccak256(
      await ethers.provider.getCode(state.orchestrator.address)
    ),
    predecessorHook: state.initialHook,
    predecessorHookCodeHash: ethers.utils.keccak256(
      await ethers.provider.getCode(state.initialHook)
    ),
    protocolFeeRecipient: deployer.address,
    chainId: chain.chainId,
  };
  try {
    await (await state.orchestrator.setProtocolFee(1)).wait();
    await assert.rejects(
      deployAndActivateDispute(state.fakeHre),
      /OrchestratorV3 mutable configuration mismatch/
    );
    assert.deepEqual(state.deployedNames, []);
  } finally {
    delete EXPECTED_NETWORK_DEPENDENCIES.hardhat;
    delete EXPECTED_ORCHESTRATOR.hardhat;
  }
}

function stagingActivationRequiresPriorDeploymentAndConfirmations() {
  const predecessor = "0x0000000000000000000000000000000000000001";
  const fresh = "0x0000000000000000000000000000000000000002";
  assert.doesNotThrow(() =>
    assertLifecycleHookPhase(predecessor, predecessor, fresh, "prepared")
  );
  assert.throws(
    () => assertLifecycleHookPhase(fresh, predecessor, fresh, "prepared"),
    /expected prepared phase/
  );
  assert.doesNotThrow(() =>
    assertLifecycleHookPhase(fresh, predecessor, fresh, "ready")
  );

  setFlags();
  assert.equal(stagingDisputeActivationRequested(false), false);

  setFlags({ activation: true });
  assert.throws(
    () => stagingDisputeActivationRequested(false),
    /requires a prior completed deploy-only run/
  );
  assert.throws(
    () => stagingDisputeActivationRequested(true),
    /DOWNSTREAM_READY/
  );

  setFlags({ activation: true, downstreamReady: true });
  assert.throws(
    () => stagingDisputeActivationRequested(true),
    /PREDECESSOR_DRAINED/
  );

  setFlags({
    activation: true,
    downstreamReady: true,
    predecessorDrained: true,
  });
  assert.equal(stagingDisputeActivationRequested(true), true);
  setFlags();
}

function taggedDeploymentsPersistSafeBatches() {
  assert.equal(deploySummary.runAtTheEnd, true);
  assert.deepEqual(deploySummary.tags, [
    "V3PaymentBindingStack",
    "V3DisputeLifecycleStack",
  ]);
}

function paymentBindingPinsBaseChainId() {
  assert.doesNotThrow(() => assertPaymentBindingChainId(8453, 8453));
  assert.throws(
    () => assertPaymentBindingChainId(31337, 8453),
    /does not match expected chain ID/
  );
}

function stagingRetiredDepositSettingRequiresExactTombstone() {
  const logs = [
    {
      escrow: "0x77e8f808FE201075e0bD651CD46fdF239fc83265",
      depositId: 87,
      isEnabled: true,
      blockNumber: 49_612_788,
      transactionHash:
        "0xb2f56cd2d74fdc660132c5e13966302a7a4f67d94945fa908b132c63f00019ff",
    },
    {
      escrow: "0x77e8f808FE201075e0bD651CD46fdF239fc83265",
      depositId: 87,
      isEnabled: false,
      blockNumber: 49_612_804,
      transactionHash:
        "0x455c91175c36ec8c9d616e7b2977f5d39130d3559e76aeca8881ce07dd491649",
    },
  ];
  const tombstone = {
    canonicalEscrow: "0x77e8f808FE201075e0bD651CD46fdF239fc83265",
    allZeroDeposit: true,
    depositCounterGreater: true,
    paymentMethodsEmpty: true,
    intentHashesEmpty: true,
    closedBlockNumber: 49_612_806,
    closedTransactionHash:
      "0xbd5a4ce4c32de20a1cb0f8fb2f29a56de6aca99c8377ad0afd13d0b0433937dc",
  };
  assert.doesNotThrow(() =>
    assertStagingRetiredDepositSettingEvidence(logs, tombstone)
  );
  assert.throws(
    () =>
      assertStagingRetiredDepositSettingEvidence(logs, {
        ...tombstone,
        allZeroDeposit: false,
      }),
    /live or nonempty deposit/
  );
  assert.throws(
    () =>
      assertStagingRetiredDepositSettingEvidence(
        [...logs, { ...logs[1], blockNumber: 49_612_805 }],
        tombstone
      ),
    /setting history drifted/
  );
}

async function disputeDeploymentResumesPartialArtifacts() {
  setFlags();
  const state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  state.deployedNames.length = 0;

  const partialRegistry = await deployContract("NullifierRegistry");
  state.deployments.set(
    "DisputeNullifierRegistry",
    await deploymentEvidence(partialRegistry, "NullifierRegistry")
  );
  await deployAndActivateDispute(state.fakeHre);
  assert.equal(
    state.deployments.get("DisputeNullifierRegistry").address.toLowerCase(),
    partialRegistry.address.toLowerCase()
  );
  assert.deepEqual(state.deployedNames, [
    "DisputeVerifier",
    "StakeVault",
    "DisputeProtectionPolicy",
    "IntentLifecycleHookV1",
  ]);
  assert.equal(await deployAndActivateDispute.skip(state.fakeHre), true);
}

async function disputeDeploymentRejectsNonPrefixArtifactsBeforeDeploying() {
  setFlags();
  const state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  state.deployedNames.length = 0;
  const [deployer] = await ethers.getSigners();
  const vault = await deployContract("StakeVault", [
    deployer.address,
    state.deployments.get("USDCMock").address,
    ethers.constants.AddressZero,
    STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  ]);
  state.deployments.set(
    "StakeVault",
    await deploymentEvidence(vault, "StakeVault", [
      deployer.address,
      state.deployments.get("USDCMock").address,
      ethers.constants.AddressZero,
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ])
  );

  await assert.rejects(
    deployAndActivateDispute(state.fakeHre),
    /not a contiguous recognized prefix/
  );
  assert.deepEqual(state.deployedNames, []);
}

async function disputeReadinessRejectsHiddenMutableState() {
  setFlags();
  let state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  await deployAndActivateDispute(state.fakeHre);
  let [, attacker] = await ethers.getSigners();
  let vault = await ethers.getContractAt(
    "StakeVault",
    state.deployments.get("StakeVault").address
  );
  await (await vault.proposeController(attacker.address)).wait();
  await assert.rejects(
    disputeStackReady(state.fakeHre),
    /StakeVault controller mismatch/
  );

  state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  await deployAndActivateDispute(state.fakeHre);
  let policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    state.deployments.get("DisputeProtectionPolicy").address
  );
  await (await policy.setAdmissionsPaused(true)).wait();
  await assert.rejects(
    disputeStackReady(state.fakeHre),
    /DisputeProtectionPolicy vault mismatch/
  );

  state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  await deployAndActivateDispute(state.fakeHre);
  policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    state.deployments.get("DisputeProtectionPolicy").address
  );
  await (
    await policy.setLifecycleHookAuthorization(state.initialHook, true)
  ).wait();
  await assert.rejects(
    disputeStackReady(state.fakeHre),
    /unexpected authorized hook/
  );

  state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  await deployAndActivateDispute(state.fakeHre);
  [, attacker] = await ethers.getSigners();
  policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    state.deployments.get("DisputeProtectionPolicy").address
  );
  await (await policy.transferOwnership(attacker.address)).wait();
  await assert.rejects(
    disputeStackReady(state.fakeHre),
    /pending ownership takeover/
  );
}

async function disputeActivationRejectsPreexistingVaultActivity() {
  setFlags();
  let state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  await deployAndActivateDispute(state.fakeHre);
  const stakeToken = await ethers.getContractAt(
    "USDCMock",
    state.deployments.get("USDCMock").address
  );
  const vault = await ethers.getContractAt(
    "StakeVault",
    state.deployments.get("StakeVault").address
  );
  await (await stakeToken.approve(vault.address, 1)).wait();
  await (await vault.depositStake(1)).wait();
  let evidence = await freshStackEvidence(state);
  await assert.rejects(
    assertFreshStackUnusedBeforeActivation(
      state.fakeHre,
      evidence.deployments,
      evidence.contracts
    ),
    /pre-activation financial activity/
  );
  await assert.rejects(
    deployAndActivateDispute(state.fakeHre),
    /pre-activation financial activity/
  );

  state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  await deployAndActivateDispute(state.fakeHre);
  const [, taker] = await ethers.getSigners();
  const freshVault = await ethers.getContractAt(
    "StakeVault",
    state.deployments.get("StakeVault").address
  );
  await (await freshVault.setTakerAuthorization(taker.address, true)).wait();
  evidence = await freshStackEvidence(state);
  await assert.rejects(
    assertFreshStackUnusedBeforeActivation(
      state.fakeHre,
      evidence.deployments,
      evidence.contracts
    ),
    /pre-activation financial activity/
  );
  await assert.rejects(
    deployAndActivateDispute(state.fakeHre),
    /pre-activation financial activity/
  );
}

async function combinedDeploymentActivatesOnlyThreeMethods() {
  setFlags();
  const state = await fixture({
    networkName: "hardhat",
    includePaymentBinding: false,
  });
  await deployPaymentBinding(state.fakeHre);
  state.deployedNames.length = 0;
  assert.equal(await deployAndActivateDispute.skip(state.fakeHre), false);
  await deployAndActivateDispute(state.fakeHre);

  assert.deepEqual(state.deployedNames, [
    "DisputeNullifierRegistry",
    "DisputeVerifier",
    "StakeVault",
    "DisputeProtectionPolicy",
    "IntentLifecycleHookV1",
  ]);
  const hook = state.deployments.get("IntentLifecycleHookV1");
  assert.equal(
    (await state.orchestrator.lifecycleHook()).toLowerCase(),
    hook.address.toLowerCase()
  );

  const policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    state.deployments.get("DisputeProtectionPolicy").address
  );
  const disputable = new Set(DISPUTABLE_PAYMENT_METHODS);
  assert.deepEqual([...disputable].sort(), ["cashapp", "paypal", "venmo"]);
  for (const methodName of ACTIVE_PAYMENT_METHODS) {
    const riskWindow = await policy.getRiskWindow(
      paymentMethodHash(methodName)
    );
    const expected = disputable.has(methodName)
      ? DISPUTE_RISK_WINDOW.hardhat
      : 0;
    assert.equal(riskWindow.toString(), expected.toString(), methodName);
  }
  assert.equal(await deployAndActivateDispute.skip(state.fakeHre), true);

  const deployedCount = state.deployedNames.length;
  await deployAndActivateDispute(state.fakeHre);
  assert.equal(state.deployedNames.length, deployedCount);
}

async function paymentBindingPreparesAtomicSafeCutover() {
  setFlags();
  const originalGovernance = MULTI_SIG.hardhat;
  const [, governanceSigner] = await ethers.getSigners();
  MULTI_SIG.hardhat = governanceSigner.address;
  try {
    const state = await fixture({
      networkName: "hardhat",
      includePaymentBinding: false,
    });
    const paymentVerifierRegistry = await ethers.getContractAt(
      "PaymentVerifierRegistry",
      state.deployments.get("PaymentVerifierRegistry").address
    );
    const legacyNullifierRegistry = await ethers.getContractAt(
      "NullifierRegistry",
      state.deployments.get("NullifierRegistry").address
    );
    await (
      await paymentVerifierRegistry.transferOwnership(governanceSigner.address)
    ).wait();
    await (
      await legacyNullifierRegistry.transferOwnership(governanceSigner.address)
    ).wait();

    const queuedBefore = safeBatchCollector.count();
    await deployPaymentBinding(state.fakeHre);
    assert.equal(safeBatchCollector.count() - queuedBefore, 22);
    const queued = safeBatchCollector.getTransactionsSince(queuedBefore);
    const expectedMethods = ACTIVE_PAYMENT_METHODS.map(paymentMethodHash);
    const paymentVerifierRegistryAddress = state.deployments.get(
      "PaymentVerifierRegistry"
    ).address;
    const legacyNullifierRegistryAddress =
      state.deployments.get("NullifierRegistry").address;
    const unifiedPaymentVerifierV3Address = state.deployments.get(
      "UnifiedPaymentVerifierV3"
    ).address;

    for (let index = 0; index < expectedMethods.length; index += 1) {
      assert.equal(
        queued[index].to.toLowerCase(),
        paymentVerifierRegistryAddress.toLowerCase()
      );
      const [removedMethod] =
        paymentVerifierRegistry.interface.decodeFunctionData(
          "removePaymentMethod",
          queued[index].data
        );
      assert.equal(
        removedMethod.toLowerCase(),
        expectedMethods[expectedMethods.length - index - 1].toLowerCase()
      );
    }
    for (let index = 0; index < expectedMethods.length; index += 1) {
      const transaction = queued[expectedMethods.length + index];
      assert.equal(
        transaction.to.toLowerCase(),
        paymentVerifierRegistryAddress.toLowerCase()
      );
      const [method, verifier, currencies] =
        paymentVerifierRegistry.interface.decodeFunctionData(
          "addPaymentMethod",
          transaction.data
        );
      assert.equal(method.toLowerCase(), expectedMethods[index].toLowerCase());
      assert.equal(
        verifier.toLowerCase(),
        unifiedPaymentVerifierV3Address.toLowerCase()
      );
      assert.deepEqual(
        currencies.map((currency) => currency.toLowerCase()),
        EXPECTED_BASE_CURRENCIES[ACTIVE_PAYMENT_METHODS[index]]
          .map(paymentMethodHash)
          .map((currency) => currency.toLowerCase())
      );
    }
    const expectedRetiredWriters = [
      state.deployments.get("UnifiedPaymentVerifier").address,
      state.deployments.get("UnifiedPaymentVerifierV2").address,
    ];
    for (let index = 0; index < expectedRetiredWriters.length; index += 1) {
      const transaction = queued[expectedMethods.length * 2 + index];
      assert.equal(
        transaction.to.toLowerCase(),
        legacyNullifierRegistryAddress.toLowerCase()
      );
      const [writer] = legacyNullifierRegistry.interface.decodeFunctionData(
        "removeWritePermission",
        transaction.data
      );
      assert.equal(
        writer.toLowerCase(),
        expectedRetiredWriters[index].toLowerCase()
      );
    }
    assert.notEqual(
      (
        await paymentVerifierRegistry.getVerifier(
          paymentMethodHash(ACTIVE_PAYMENT_METHODS[0])
        )
      ).toLowerCase(),
      state.deployments.get("UnifiedPaymentVerifierV3").address.toLowerCase()
    );
  } finally {
    MULTI_SIG.hardhat = originalGovernance;
  }
}

async function disputeDeploymentPreparesFourSafeCalls() {
  setFlags();
  const originalGovernance = MULTI_SIG.hardhat;
  const [, governanceSigner] = await ethers.getSigners();
  try {
    const state = await fixture({
      networkName: "hardhat",
      includePaymentBinding: false,
    });
    await deployPaymentBinding(state.fakeHre);
    const governedContracts = [
      ["PaymentVerifierRegistry", "PaymentVerifierRegistry"],
      ["NullifierRegistry", "NullifierRegistry"],
      ["NullifierRegistryV2", "NullifierRegistryV2"],
      ["UnifiedPaymentVerifierV3", "UnifiedPaymentVerifierV3"],
      ["OrchestratorV3", "OrchestratorV3"],
    ];
    for (const [deploymentName, contractName] of governedContracts) {
      const contract = await ethers.getContractAt(
        contractName,
        state.deployments.get(deploymentName).address
      );
      await (await contract.transferOwnership(governanceSigner.address)).wait();
    }
    MULTI_SIG.hardhat = governanceSigner.address;

    const queuedBefore = safeBatchCollector.count();
    await deployAndActivateDispute(state.fakeHre);
    assert.equal(safeBatchCollector.count() - queuedBefore, 4);
    const queued = safeBatchCollector.getTransactionsSince(queuedBefore);
    const twoStepDeployments = [
      "DisputeVerifier",
      "StakeVault",
      "DisputeProtectionPolicy",
    ];
    for (let index = 0; index < twoStepDeployments.length; index += 1) {
      assert.equal(
        queued[index].to.toLowerCase(),
        state.deployments.get(twoStepDeployments[index]).address.toLowerCase()
      );
      assert.equal(queued[index].data.toLowerCase(), "0x79ba5097");
    }
    assert.equal(
      queued[3].to.toLowerCase(),
      state.orchestrator.address.toLowerCase()
    );
    const [newHook] = state.orchestrator.interface.decodeFunctionData(
      "setLifecycleHook",
      queued[3].data
    );
    assert.equal(
      newHook.toLowerCase(),
      state.deployments.get("IntentLifecycleHookV1").address.toLowerCase()
    );

    const disputeVerifier = await ethers.getContractAt(
      "DisputeVerifier",
      state.deployments.get("DisputeVerifier").address
    );
    assert.equal(
      (await disputeVerifier.pendingOwner()).toLowerCase(),
      governanceSigner.address.toLowerCase()
    );
    assert.equal(
      (await state.orchestrator.lifecycleHook()).toLowerCase(),
      state.initialHook.toLowerCase()
    );
  } finally {
    MULTI_SIG.hardhat = originalGovernance;
  }
}

function obsoleteActivationLaneIsRemoved() {
  assert.equal(
    existsSync("deploy/32_activate_dispute_lifecycle_stack.ts"),
    false
  );
  assert.deepEqual(deployPaymentBinding.dependencies || [], []);
  assert.deepEqual(deployAndActivateDispute.dependencies, [
    "V3PaymentBindingStack",
  ]);
}

async function run() {
  ratifiedCurrencySnapshotIsExact();
  await paymentBindingDeploysFreshOnHardhat();
  await paymentBindingRejectsPartialArtifacts();
  await paymentBindingRejectsRoutesWithoutWriterCleanup();
  await combinedStagingDeploymentRequiresExplicitFlag();
  await disputeDeploymentRejectsMissingPaymentCutover();
  await disputeDeploymentRejectsOrchestratorDriftBeforeDeploying();
  stagingActivationRequiresPriorDeploymentAndConfirmations();
  taggedDeploymentsPersistSafeBatches();
  paymentBindingPinsBaseChainId();
  stagingRetiredDepositSettingRequiresExactTombstone();
  await disputeDeploymentResumesPartialArtifacts();
  await disputeDeploymentRejectsNonPrefixArtifactsBeforeDeploying();
  await disputeReadinessRejectsHiddenMutableState();
  await disputeActivationRejectsPreexistingVaultActivity();
  await combinedDeploymentActivatesOnlyThreeMethods();
  obsoleteActivationLaneIsRemoved();
  await paymentBindingPreparesAtomicSafeCutover();
  await disputeDeploymentPreparesFourSafeCalls();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
