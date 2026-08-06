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

const RETIRED_STAGING_STAKE_VAULT = "0x224a45C65eB9A4D1dB00eD6Bfe21aD7Ec0a9b0E4";
const RETIRED_STAGING_DISPUTE_POLICY = "0xC1E16Bf824fA7cee8770Fb72F49349091D4e583B";
const RETIRED_STAGING_LIFECYCLE_HOOK = "0xE8Fe714f848fAf7ecff7960AfD0C395771C22AA1";

function setStagingPhase(phase) {
  process.env.PREPARE_STAGING_V3_DISPUTE_CUTOVER = phase === "prepare" ? "true" : "false";
  process.env.ENABLE_STAGING_V3_DISPUTE_CUTOVER = phase === "activate" ? "true" : "false";
}

async function deployContract(name, args = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  return contract;
}

async function installRuntimeCode(target, source) {
  const runtimeCode = await ethers.provider.getCode(source.address);
  await ethers.provider.send("hardhat_setCode", [target, runtimeCode]);
}

async function fixture({
  includeDisputeRegistry = true,
  retiredTotalStaked = 0,
  wireRetiringHook = true,
} = {}) {
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
  const legacyNullifierRegistry = await deployContract("NullifierRegistry");
  const nullifierRegistryV2 = await deployContract("NullifierRegistryV2", [
    legacyNullifierRegistry.address,
  ]);
  const attestationVerifier = await deployContract("SimpleAttestationVerifier", [deployer]);
  const disputeNullifierRegistry = includeDisputeRegistry
    ? await deployContract("NullifierRegistry")
    : null;

  const retiredStakeToken = await deployContract("USDCMock", [1, "USD Coin", "USDC"]);
  const retiredVaultTemplate = await deployContract("StakeVault", [
    deployer,
    retiredStakeToken.address,
    ethers.constants.AddressZero,
    2 * 24 * 60 * 60,
  ]);
  await installRuntimeCode(RETIRED_STAGING_STAKE_VAULT, retiredVaultTemplate);
  if (retiredTotalStaked !== 0) {
    const retiredVault = await ethers.getContractAt("StakeVault", RETIRED_STAGING_STAKE_VAULT);
    await (await retiredStakeToken.approve(retiredVault.address, retiredTotalStaked)).wait();
    await (await retiredVault.depositStake(retiredTotalStaked)).wait();
  }

  const retiredHookTemplate = await deployContract("IntentLifecycleHookV1", [
    orchestratorRegistry.address,
    whitelistPolicy.address,
    whitelistPolicy.address,
  ]);
  await installRuntimeCode(RETIRED_STAGING_LIFECYCLE_HOOK, retiredHookTemplate);

  const orchestrator = await deployContract("OrchestratorV3", [
    deployer,
    network.chainId,
    escrowRegistry.address,
    paymentVerifierRegistry.address,
    relayerRegistry.address,
    0,
    deployer,
  ]);
  if (wireRetiringHook) {
    await (await orchestrator.setLifecycleHook(RETIRED_STAGING_LIFECYCLE_HOOK)).wait();
  }

  if (disputeNullifierRegistry) {
    await (
      await disputeNullifierRegistry.addWritePermission(RETIRED_STAGING_DISPUTE_POLICY)
    ).wait();
  }

  const deployments = new Map([
    ["OrchestratorRegistry", { address: orchestratorRegistry.address }],
    ["WhitelistPolicy", { address: whitelistPolicy.address }],
    ["OrchestratorV3", { address: orchestrator.address }],
    ["NullifierRegistryV2", { address: nullifierRegistryV2.address }],
    ["SimpleAttestationVerifier", { address: attestationVerifier.address }],
  ]);
  if (disputeNullifierRegistry) {
    deployments.set("ChargebackNullifierRegistry", { address: disputeNullifierRegistry.address });
  }

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
    disputeNullifierRegistry,
    fakeHre: {
      deployments: deploymentApi,
      ethers,
      getUnnamedAccounts: async () => [deployer],
    },
    orchestrator,
  };
}

async function rejectLiabilities() {
  setStagingPhase("prepare");
  const state = await fixture({ retiredTotalStaked: 1 });
  await assert.rejects(
    deployDisputeStack(state.fakeHre),
    (error) => error instanceof Error
      && error.message === "Retired StakeVault still has liabilities: totalStaked=1, totalClaimable=0",
  );
  assert.deepEqual(state.deployedNames, []);
}

async function rejectMissingRegistry() {
  setStagingPhase("prepare");
  const state = await fixture({ includeDisputeRegistry: false });
  await assert.rejects(
    deployDisputeStack(state.fakeHre),
    (error) => error instanceof Error
      && error.message === "ChargebackNullifierRegistry must already exist on staging",
  );
  assert.deepEqual(state.deployedNames, []);
}

async function rejectHookMismatch() {
  setStagingPhase("prepare");
  const state = await fixture({ wireRetiringHook: false });
  await assert.rejects(
    deployDisputeStack(state.fakeHre),
    (error) => error instanceof Error
      && error.message === "OrchestratorV3 does not use the lifecycle hook retired by lane 31",
  );
  assert.deepEqual(state.deployedNames, []);
}

async function rejectMissingPhase() {
  setStagingPhase("none");
  const state = await fixture();
  await assert.rejects(
    deployDisputeStack(state.fakeHre),
    (error) => error instanceof Error
      && error.message === "Select the staging dispute preparation or activation phase",
  );
  assert.deepEqual(state.deployedNames, []);
}

async function rejectConflictingPhases() {
  process.env.PREPARE_STAGING_V3_DISPUTE_CUTOVER = "true";
  process.env.ENABLE_STAGING_V3_DISPUTE_CUTOVER = "true";
  const state = await fixture();
  await assert.rejects(
    deployDisputeStack(state.fakeHre),
    (error) => error instanceof Error
      && error.message === "Staging dispute preparation and activation must run as separate phases",
  );
  assert.deepEqual(state.deployedNames, []);
}

async function rejectActivationBeforePreparation() {
  setStagingPhase("activate");
  const state = await fixture();
  await assert.rejects(
    deployDisputeStack(state.fakeHre),
    (error) => error instanceof Error
      && error.message === "Prepare the fresh staging dispute stack before activation",
  );
  assert.deepEqual(state.deployedNames, []);
}

async function cutover() {
  setStagingPhase("prepare");
  const state = await fixture();
  await deployDisputeStack(state.fakeHre);

  assert.deepEqual(state.deployedNames, [
    "DisputeVerifier",
    "StakeVault",
    "DisputePolicy",
    "IntentLifecycleHookV1",
  ]);
  const hookDeployment = state.deployments.get("IntentLifecycleHookV1");
  assert.equal(
    (await state.orchestrator.lifecycleHook()).toLowerCase(),
    RETIRED_STAGING_LIFECYCLE_HOOK.toLowerCase(),
  );
  assert.equal(
    await state.disputeNullifierRegistry.isWriter(RETIRED_STAGING_DISPUTE_POLICY),
    true,
  );
  assert.equal(await deployDisputeStack.skip(state.fakeHre), true);

  setStagingPhase("activate");
  assert.equal(await deployDisputeStack.skip(state.fakeHre), false);
  await deployDisputeStack(state.fakeHre);
  assert.equal(
    (await state.orchestrator.lifecycleHook()).toLowerCase(),
    hookDeployment.address.toLowerCase(),
  );
  assert.equal(
    await state.disputeNullifierRegistry.isWriter(RETIRED_STAGING_DISPUTE_POLICY),
    false,
  );
  assert.equal(await deployDisputeStack.skip(state.fakeHre), true);

  await (
    await state.disputeNullifierRegistry.addWritePermission(RETIRED_STAGING_DISPUTE_POLICY)
  ).wait();
  assert.equal(await deployDisputeStack.skip(state.fakeHre), false);
}

async function run() {
  await rejectMissingPhase();
  await rejectConflictingPhases();
  await rejectActivationBeforePreparation();
  await rejectLiabilities();
  await rejectHookMismatch();
  await rejectMissingRegistry();
  await cutover();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
