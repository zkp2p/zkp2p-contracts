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
const dotenv = require("dotenv");
const moduleAlias = require("module-alias");

dotenv.config = () => ({ parsed: {} });
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

console.log = () => {};

const hre = require("hardhat");
const { ethers } = hre;
const deployDisputeStack = require("../deploy/31_deploy_dispute_lifecycle_stack.ts").default;
const activateDisputeStack = require("../deploy/32_activate_dispute_lifecycle_stack.ts").default;

function setStagingFlags({ deploy = false, activate = false } = {}) {
  process.env.ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT = deploy ? "true" : "false";
  process.env.ENABLE_STAGING_V3_DISPUTE_ACTIVATION = activate ? "true" : "false";
}

async function deployContract(name, args = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  return contract;
}

async function fixture() {
  await ethers.provider.send("hardhat_reset", []);

  const [deployerSigner] = await ethers.getSigners();
  const deployer = deployerSigner.address;
  const network = await ethers.provider.getNetwork();

  const addressGroupRegistry = await deployContract("AddressGroupRegistry");
  const escrowRegistry = await deployContract("EscrowRegistry");
  const orchestratorRegistry = await deployContract("OrchestratorRegistry");
  const paymentVerifierRegistry = await deployContract("PaymentVerifierRegistry");
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
  const nullifierRegistryV2 = await deployContract("NullifierRegistryV2", [
    legacyNullifierRegistry.address,
  ]);
  const attestationVerifier = await deployContract("SimpleAttestationVerifier", [deployer]);
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
    ["OrchestratorRegistry", { address: orchestratorRegistry.address }],
    ["WhitelistPolicy", { address: whitelistPolicy.address }],
    ["WhitelistLifecycleHook", { address: whitelistHook.address }],
    ["OrchestratorV3", { address: orchestrator.address }],
    ["NullifierRegistryV2", { address: nullifierRegistryV2.address }],
    ["SimpleAttestationVerifier", { address: attestationVerifier.address }],
  ]);
  const deployedNames = [];
  const deploymentApi = {
    getNetworkName: () => "base_staging",
    get: async (name) => {
      const deployment = deployments.get(name);
      if (!deployment) throw new Error(`Missing deployment: ${name}`);
      return deployment;
    },
    getOrNull: async (name) => deployments.get(name) || null,
    deploy: async (name, options) => {
      const existing = deployments.get(name);
      if (existing) return { ...existing, newlyDeployed: false };
      deployedNames.push(name);
      const contract = await deployContract(options.contract || name, options.args || []);
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

async function deploymentRequiresExplicitStagingFlag() {
  setStagingFlags();
  const state = await fixture();
  assert.equal(await deployDisputeStack.skip(state.fakeHre), true);
  assert.deepEqual(state.deployedNames, []);
}

async function activationRejectsMissingStack() {
  setStagingFlags({ activate: true });
  const state = await fixture();
  assert.equal(await activateDisputeStack.skip(state.fakeHre), false);
  await assert.rejects(
    activateDisputeStack(state.fakeHre),
    (error) => error instanceof Error
      && error.message === "Deploy and verify the fresh dispute lifecycle stack before activation",
  );
  assert.deepEqual(state.deployedNames, []);
}

async function deployThenActivate() {
  setStagingFlags({ deploy: true });
  const state = await fixture();
  assert.equal(await deployDisputeStack.skip(state.fakeHre), false);
  await deployDisputeStack(state.fakeHre);

  assert.deepEqual(state.deployedNames, [
    "DisputeNullifierRegistry",
    "DisputeVerifier",
    "StakeVault",
    "DisputeProtectionPolicy",
    "IntentLifecycleHookV1",
  ]);
  assert.equal(
    (await state.orchestrator.lifecycleHook()).toLowerCase(),
    state.initialHook.toLowerCase(),
  );

  const disputeProtectionPolicyDeployment = state.deployments.get("DisputeProtectionPolicy");
  const registryDeployment = state.deployments.get("DisputeNullifierRegistry");
  const disputeNullifierRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    registryDeployment.address,
  );
  assert.equal(
    await disputeNullifierRegistry.isWriter(disputeProtectionPolicyDeployment.address),
    true,
  );
  assert.equal(await deployDisputeStack.skip(state.fakeHre), true);

  setStagingFlags();
  assert.equal(await activateDisputeStack.skip(state.fakeHre), true);
  setStagingFlags({ activate: true });
  assert.equal(await activateDisputeStack.skip(state.fakeHre), false);
  await activateDisputeStack(state.fakeHre);

  const hookDeployment = state.deployments.get("IntentLifecycleHookV1");
  assert.equal(
    (await state.orchestrator.lifecycleHook()).toLowerCase(),
    hookDeployment.address.toLowerCase(),
  );
  assert.equal(await activateDisputeStack.skip(state.fakeHre), true);

  const deployedCount = state.deployedNames.length;
  await deployDisputeStack(state.fakeHre);
  assert.equal(state.deployedNames.length, deployedCount);
}

async function run() {
  await deploymentRequiresExplicitStagingFlag();
  await activationRejectsMissingStack();
  await deployThenActivate();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
