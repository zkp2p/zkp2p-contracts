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
const deployCorrectedPolicyModule = require("../deploy/32_deploy_corrected_whitelist_policy.ts");
const deployCorrectedPolicy = deployCorrectedPolicyModule.default;
const { CORRECTED_WHITELIST_POLICY_DEPLOYMENT } = deployCorrectedPolicyModule;
const { MULTI_SIG } = require("../deployments/parameters.ts");

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

  const addressGroupRegistry = await deployContract("AddressGroupRegistry");
  const escrowRegistry = await deployContract("EscrowRegistry");
  const orchestratorRegistry = await deployContract("OrchestratorRegistry");
  const currentPolicy = await deployContract("WhitelistPolicy", [
    addressGroupRegistry.address,
    escrowRegistry.address,
    orchestratorRegistry.address,
  ]);
  await (await currentPolicy.transferOwnership(safe)).wait();

  const deployments = new Map([
    ["AddressGroupRegistry", { address: addressGroupRegistry.address }],
    ["EscrowRegistry", { address: escrowRegistry.address }],
    ["OrchestratorRegistry", { address: orchestratorRegistry.address }],
    ["WhitelistPolicy", { address: currentPolicy.address }],
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
  };
  const fakeHre = {
    deployments: deploymentApi,
    ethers,
    getChainId: async () => "8453",
    getUnnamedAccounts: async () => [deployer],
  };
  return { currentPolicy, deployer, deployments, fakeHre, safe };
}

async function run() {
  const state = await fixture();

  if (scenario === "prepare-resume") {
    delete process.env.ENABLE_BASE_CORRECTED_WHITELIST_DEPLOYMENT;
    let passed = await deployCorrectedPolicy.skip(state.fakeHre);
    process.env.ENABLE_BASE_CORRECTED_WHITELIST_DEPLOYMENT = "true";
    passed = passed && !(await deployCorrectedPolicy.skip(state.fakeHre));

    await deployCorrectedPolicy(state.fakeHre);
    const replacementDeployment = await state.fakeHre.deployments.get(
      CORRECTED_WHITELIST_POLICY_DEPLOYMENT,
    );
    const replacement = await ethers.getContractAt("WhitelistPolicy", replacementDeployment.address);
    passed = passed
      && replacementDeployment.address.toLowerCase() !== state.currentPolicy.address.toLowerCase()
      && (await replacement.owner()).toLowerCase() === state.deployer.toLowerCase()
      && (await state.currentPolicy.owner()).toLowerCase() === state.safe.toLowerCase()
      && await deployCorrectedPolicy.skip(state.fakeHre);

    await deployCorrectedPolicy(state.fakeHre);
    passed = passed && (await replacement.owner()).toLowerCase() === state.deployer.toLowerCase();
    process.stdout.write(passed ? "0x01" : "0x00");
    return;
  }

  if (scenario === "reject-transferred") {
    await deployCorrectedPolicy(state.fakeHre);
    const replacementDeployment = await state.fakeHre.deployments.get(
      CORRECTED_WHITELIST_POLICY_DEPLOYMENT,
    );
    const replacement = await ethers.getContractAt("WhitelistPolicy", replacementDeployment.address);
    await (await replacement.transferOwnership(state.safe)).wait();

    let rejected = false;
    try {
      await deployCorrectedPolicy(state.fakeHre);
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("owner must remain the deployer");
    }
    process.stdout.write(rejected ? "0x01" : "0x00");
    return;
  }

  if (scenario === "reject-chain") {
    state.fakeHre.getChainId = async () => "1";
    let rejected = false;
    try {
      await deployCorrectedPolicy(state.fakeHre);
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("requires Base chain 8453");
    }
    process.stdout.write(rejected ? "0x01" : "0x00");
    return;
  }

  throw new Error(`Unknown corrected whitelist deployment scenario: ${scenario}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
