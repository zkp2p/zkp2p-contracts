#!/usr/bin/env node

process.env.DEPLOY_TX_DELAY_MS = "0";
process.env.ALCHEMY_API_KEY ||= "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY ||=
  "1111111111111111111111111111111111111111111111111111111111111111";
process.env.TESTNET_DEPLOY_PRIVATE_KEY ||=
  "2222222222222222222222222222222222222222222222222222222222222222";

require("ts-node/register/transpile-only");
require("module-alias/register");

const moduleAlias = require("module-alias");
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

console.log = () => {};

const hre = require("hardhat");
const { ethers } = hre;
const deployGroupsStack = require("../deploy/30_deploy_v3_lifecycle_stack.ts").default;
const { MULTI_SIG, ORCHESTRATOR_V3_PROTOCOL_FEE, ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT } = require(
  "../deployments/parameters.ts",
);
const { safeBatchCollector } = require("../deployments/safeBatchCollector.ts");

const scenario = process.argv[2];

async function deployContract(name, args = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  return contract;
}

async function fixture() {
  const [deployerSigner] = await ethers.getSigners();
  const deployer = deployerSigner.address;
  const safe = MULTI_SIG.base;
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

  await (await whitelistPolicy.transferOwnership(safe)).wait();
  await (await orchestratorRegistry.transferOwnership(safe)).wait();

  const deployments = new Map([
    ["AddressGroupRegistry", { address: addressGroupRegistry.address }],
    ["EscrowRegistry", { address: escrowRegistry.address }],
    ["OrchestratorRegistry", { address: orchestratorRegistry.address }],
    ["PaymentVerifierRegistry", { address: paymentVerifierRegistry.address }],
    ["RelayerRegistry", { address: relayerRegistry.address }],
    ["WhitelistPolicy", { address: whitelistPolicy.address }],
  ]);

  const deploymentApi = {
    getNetworkName: () => "base",
    get: async (name) => {
      const deployment = deployments.get(name);
      if (!deployment) throw new Error(`Missing deployment: ${name}`);
      return deployment;
    },
    getOrNull: async (name) => deployments.get(name) || null,
    deploy: async (name, options) => {
      const existing = deployments.get(name);
      if (existing) return { ...existing, newlyDeployed: false };
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
      const response = await deployerSigner.sendTransaction({ to: transaction.to, data: transaction.data });
      await response.wait();
      return { transactionHash: response.hash };
    },
  };

  const fakeHre = {
    deployments: deploymentApi,
    ethers,
    getUnnamedAccounts: async () => [deployer],
  };

  return { deployer, deployments, fakeHre, network, orchestratorRegistry, safe };
}

async function addMismatchedArtifacts(state) {
  const hook = await deployContract("WhitelistLifecycleHook", [
    (await state.fakeHre.deployments.get("OrchestratorRegistry")).address,
    (await state.fakeHre.deployments.get("WhitelistPolicy")).address,
  ]);
  const orchestrator = await deployContract("OrchestratorV3", [
    state.deployer,
    state.network.chainId,
    (await state.fakeHre.deployments.get("EscrowRegistry")).address,
    (await state.fakeHre.deployments.get("PaymentVerifierRegistry")).address,
    (await state.fakeHre.deployments.get("RelayerRegistry")).address,
    ORCHESTRATOR_V3_PROTOCOL_FEE.base.add(1),
    ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT.base,
  ]);
  await (await orchestrator.setLifecycleHook(hook.address)).wait();
  await (await orchestrator.transferOwnership(state.safe)).wait();
  state.deployments.set("WhitelistLifecycleHook", { address: hook.address });
  state.deployments.set("OrchestratorV3", { address: orchestrator.address });
}

async function run() {
  const state = await fixture();

  if (scenario === "prepare-resume") {
    await deployGroupsStack(state.fakeHre);
    const orchestrator = await state.fakeHre.deployments.get("OrchestratorV3");
    const addData = state.orchestratorRegistry.interface.encodeFunctionData("addOrchestrator", [
      orchestrator.address,
    ]);
    let passed = safeBatchCollector.count() === 1
      && safeBatchCollector.hasQueued(state.orchestratorRegistry.address, addData)
      && !(await state.orchestratorRegistry.isOrchestrator(orchestrator.address));
    await deployGroupsStack(state.fakeHre);
    passed = passed && safeBatchCollector.count() === 1;
    process.stdout.write(passed ? "0x01" : "0x00");
    return;
  }

  if (scenario === "reject-mismatch") {
    await addMismatchedArtifacts(state);
    let rejected = false;
    try {
      await deployGroupsStack(state.fakeHre);
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("protocol fee mismatch");
    }
    process.stdout.write(rejected && safeBatchCollector.count() === 0 ? "0x01" : "0x00");
    return;
  }

  throw new Error(`Unknown V3 groups deployment scenario: ${scenario}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
