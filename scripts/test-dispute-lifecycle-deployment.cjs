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
const deployPaymentBinding =
  require("../deploy/31_deploy_v3_payment_binding_stack.ts").default;
const deployAndActivateDispute =
  require("../deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts").default;
const {
  ACTIVE_PAYMENT_METHODS,
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  MULTI_SIG,
} = require("../deployments/parameters.ts");
const { safeBatchCollector } = require("../deployments/safeBatchCollector.ts");

function setFlags({ paymentBinding = false, dispute = false } = {}) {
  process.env.ENABLE_STAGING_V3_PAYMENT_BINDING_CUTOVER = paymentBinding
    ? "true"
    : "false";
  process.env.ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT = dispute ? "true" : "false";
}

function paymentMethodHash(name) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
}

async function deployContract(name, args = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  return contract;
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
        [paymentMethodHash("USD")]
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
    deploy: async (name, options) => {
      const existing = deployments.get(name);
      if (existing) return { ...existing, newlyDeployed: false };
      deployedNames.push(name);
      const contract = await deployContract(
        options.contract || name,
        options.args || []
      );
      const deployment = {
        address: contract.address,
        args: options.args || [],
        newlyDeployed: true,
        transactionHash: contract.deployTransaction.hash,
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
  await paymentBindingDeploysFreshOnHardhat();
  await paymentBindingRejectsPartialArtifacts();
  await combinedStagingDeploymentRequiresExplicitFlag();
  await disputeDeploymentRejectsMissingPaymentCutover();
  await combinedDeploymentActivatesOnlyThreeMethods();
  obsoleteActivationLaneIsRemoved();
  await paymentBindingPreparesAtomicSafeCutover();
  await disputeDeploymentPreparesFourSafeCalls();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
