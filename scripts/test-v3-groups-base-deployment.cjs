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

console.log = () => {};

const hre = /** @type {any} */ (require("hardhat"));
const { ethers } = hre;
const groupsDeploymentModule = require("../deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts");
const deployGroupsStack = groupsDeploymentModule.default;
if (!deployGroupsStack.skip)
  throw new Error("V3 groups wrapper must define skip");
const skipGroupsStack = deployGroupsStack.skip;
const {
  guardManagedDisputeLifecycleHook,
  validateManagedDisputeHookSnapshot,
} = require("../deployments/managedDisputeLifecycleHook.ts");
const {
  PREDECESSOR_DISPUTE_STACKS,
} = require("../deployments/predecessorDisputeStack.ts");
const {
  MULTI_SIG,
  ORCHESTRATOR_V3_PROTOCOL_FEE,
  ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT,
} = require("../deployments/parameters.ts");
const { safeBatchCollector } = require("../deployments/safeBatchCollector.ts");

const scenario = process.argv[2];

/** @param {string} name @param {any[]} args */
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
  const paymentVerifierRegistry = await deployContract(
    "PaymentVerifierRegistry"
  );
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
    /** @param {string} name */
    get: async (name) => {
      const deployment = deployments.get(name);
      if (!deployment) throw new Error(`Missing deployment: ${name}`);
      return deployment;
    },
    /** @param {string} name */
    getOrNull: async (name) => deployments.get(name) || null,
    /** @param {string} name @param {any} options */
    deploy: async (name, options) => {
      const existing = deployments.get(name);
      if (existing) return { ...existing, newlyDeployed: false };
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
    /** @param {{to: string, data: string}} transaction */
    rawTx: async (transaction) => {
      const response = await deployerSigner.sendTransaction({
        to: transaction.to,
        data: transaction.data,
      });
      await response.wait();
      return { transactionHash: response.hash };
    },
  };

  const fakeHre = /** @type {any} */ ({
    deployments: deploymentApi,
    ethers,
    getUnnamedAccounts: async () => [deployer],
  });

  return {
    deployer,
    deployments,
    fakeHre,
    network,
    orchestratorRegistry,
    safe,
  };
}

/** @param {any} state */
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

/**
 * @param {any} state
 * @param {"base" | "base_staging" | "localhost" | "hardhat"} networkName
 * @param {{ kind: "predecessor" | "successor" | "unknown", missingRuntime?: boolean, successorBytecode?: boolean, wrongRegistry?: boolean, wrongPolicy?: boolean }} options
 */
async function installManagedHookState(state, networkName, options) {
  state.fakeHre.deployments.getNetworkName = () => networkName;
  const orchestratorRegistry = await state.fakeHre.deployments.get(
    "OrchestratorRegistry"
  );
  const whitelistPolicy = await state.fakeHre.deployments.get(
    "WhitelistPolicy"
  );
  const wrongAddress = (await state.fakeHre.deployments.get("EscrowRegistry"))
    .address;
  const hook = await deployContract("WhitelistLifecycleHook", [
    options.wrongRegistry ? wrongAddress : orchestratorRegistry.address,
    options.wrongPolicy ? wrongAddress : whitelistPolicy.address,
  ]);
  const currentHook = hook.address;
  const orchestrator = await deployContract("OrchestratorV3", [
    state.deployer,
    state.network.chainId,
    (await state.fakeHre.deployments.get("EscrowRegistry")).address,
    (await state.fakeHre.deployments.get("PaymentVerifierRegistry")).address,
    (await state.fakeHre.deployments.get("RelayerRegistry")).address,
    ORCHESTRATOR_V3_PROTOCOL_FEE.base,
    ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT.base,
  ]);
  await (await orchestrator.setLifecycleHook(currentHook)).wait();
  if (options.missingRuntime) {
    await ethers.provider.send("hardhat_setCode", [currentHook, "0x"]);
  }
  state.deployments.set("OrchestratorV3", { address: orchestrator.address });

  const predecessor =
    PREDECESSOR_DISPUTE_STACKS[networkName]?.activeLifecycleHook;
  const originalPredecessor = predecessor ? { ...predecessor } : undefined;
  if (options.kind === "predecessor") {
    if (!predecessor)
      throw new Error(`No predecessor evidence for ${networkName}`);
    predecessor.address = currentHook;
    predecessor.runtimeCodeHash = options.missingRuntime
      ? ethers.utils.keccak256("0x01")
      : ethers.utils.keccak256(await ethers.provider.getCode(currentHook));
  }
  if (options.kind === "successor") {
    /** @type {{ address: string, deployedBytecode?: string }} */
    const successor = { address: currentHook };
    if (options.successorBytecode !== false) {
      successor.deployedBytecode = await ethers.provider.getCode(currentHook);
    }
    state.deployments.set("IntentLifecycleHookV1OptIn", successor);
  }
  return {
    currentHook,
    restore: () => {
      if (predecessor && originalPredecessor) {
        predecessor.address = originalPredecessor.address;
        predecessor.runtimeCodeHash = originalPredecessor.runtimeCodeHash;
      }
    },
  };
}

async function run() {
  if (scenario === "managed-hook-guard") {
    const predecessor = "0x0000000000000000000000000000000000000001";
    const successor = "0x0000000000000000000000000000000000000002";
    const registry = "0x0000000000000000000000000000000000000003";
    const policy = "0x0000000000000000000000000000000000000004";
    const predecessorHash = ethers.utils.keccak256("0x01");
    const successorHash = ethers.utils.keccak256("0x02");
    /** @param {string} currentHook @param {string} actualRuntimeCodeHash */
    const snapshot = (
      currentHook,
      actualRuntimeCodeHash = predecessorHash
    ) => ({
      currentHook,
      predecessor: { address: predecessor, runtimeCodeHash: predecessorHash },
      successor: { address: successor, runtimeCodeHash: successorHash },
      actualRuntimeCodeHash,
      actualOrchestratorRegistry: registry,
      expectedOrchestratorRegistry: registry,
      actualWhitelistPolicy: policy,
      expectedWhitelistPolicy: policy,
    });
    let passed = validateManagedDisputeHookSnapshot(snapshot(predecessor));
    passed =
      passed &&
      validateManagedDisputeHookSnapshot(snapshot(successor, successorHash));
    try {
      validateManagedDisputeHookSnapshot({
        ...snapshot(predecessor),
        actualWhitelistPolicy: successor,
      });
      passed = false;
    } catch (error) {
      passed =
        passed &&
        error instanceof Error &&
        error.message.includes("whitelist policy mismatch");
    }
    try {
      validateManagedDisputeHookSnapshot(snapshot(predecessor, successorHash));
      passed = false;
    } catch (error) {
      passed =
        passed &&
        error instanceof Error &&
        error.message.includes("runtime bytecode mismatch");
    }
    process.stdout.write(passed ? "0x01" : "0x00");
    return;
  }

  if (scenario === "managed-hook-no-rollback") {
    let passed = true;
    for (const networkName of /** @type {Array<"base" | "base_staging">} */ ([
      "base",
      "base_staging",
    ])) {
      for (const kind of /** @type {Array<"predecessor" | "successor">} */ ([
        "predecessor",
        "successor",
      ])) {
        const state = await fixture();
        const managed = await installManagedHookState(state, networkName, {
          kind,
        });
        const flag =
          networkName === "base"
            ? "ENABLE_BASE_V3_GROUPS_CUTOVER"
            : "ENABLE_STAGING_V3_GROUPS_CUTOVER";
        const previousFlag = process.env[flag];
        process.env[flag] = "true";
        try {
          await deployGroupsStack(state.fakeHre);
          const orchestrator = await ethers.getContractAt(
            "OrchestratorV3",
            (
              await state.fakeHre.deployments.get("OrchestratorV3")
            ).address
          );
          passed =
            passed &&
            (await orchestrator.lifecycleHook()).toLowerCase() ===
              managed.currentHook.toLowerCase() &&
            (await skipGroupsStack(state.fakeHre)) === true;
        } finally {
          managed.restore();
          if (previousFlag === undefined) delete process.env[flag];
          else process.env[flag] = previousFlag;
        }
      }
    }

    for (const networkName of /** @type {Array<"localhost" | "hardhat">} */ ([
      "localhost",
      "hardhat",
    ])) {
      const state = await fixture();
      const managed = await installManagedHookState(state, networkName, {
        kind: "successor",
      });
      try {
        passed =
          passed &&
          (await guardManagedDisputeLifecycleHook(state.fakeHre)) === true &&
          (await skipGroupsStack(state.fakeHre)) === true;
      } finally {
        managed.restore();
      }
    }

    const missingEvidenceState = await fixture();
    const missingEvidence = await installManagedHookState(
      missingEvidenceState,
      "base",
      { kind: "successor", successorBytecode: false }
    );
    try {
      await guardManagedDisputeLifecycleHook(missingEvidenceState.fakeHre);
      passed = false;
    } catch (error) {
      passed =
        passed &&
        error instanceof Error &&
        error.message.includes("lacks deployment bytecode evidence");
    } finally {
      missingEvidence.restore();
    }

    const missingRuntimeState = await fixture();
    const missingRuntime = await installManagedHookState(
      missingRuntimeState,
      "base_staging",
      { kind: "predecessor", missingRuntime: true }
    );
    try {
      await guardManagedDisputeLifecycleHook(missingRuntimeState.fakeHre);
      passed = false;
    } catch (error) {
      passed =
        passed &&
        error instanceof Error &&
        error.message.includes("has no bytecode");
    } finally {
      missingRuntime.restore();
    }

    for (const mismatch of ["wrongRegistry", "wrongPolicy"]) {
      const mismatchState = await fixture();
      const managed = await installManagedHookState(mismatchState, "base", {
        kind: "successor",
        [mismatch]: true,
      });
      try {
        await guardManagedDisputeLifecycleHook(mismatchState.fakeHre);
        passed = false;
      } catch (error) {
        const expected =
          mismatch === "wrongRegistry"
            ? "registry mismatch"
            : "whitelist policy mismatch";
        passed =
          passed && error instanceof Error && error.message.includes(expected);
      } finally {
        managed.restore();
      }
    }

    const unknownState = await fixture();
    const unknown = await installManagedHookState(unknownState, "base", {
      kind: "unknown",
    });
    const previousCutover = process.env.ENABLE_BASE_V3_GROUPS_CUTOVER;
    process.env.ENABLE_BASE_V3_GROUPS_CUTOVER = "true";
    try {
      passed =
        passed &&
        (await guardManagedDisputeLifecycleHook(unknownState.fakeHre)) ===
          false &&
        (await skipGroupsStack(unknownState.fakeHre)) === false;
    } finally {
      unknown.restore();
      if (previousCutover === undefined)
        delete process.env.ENABLE_BASE_V3_GROUPS_CUTOVER;
      else process.env.ENABLE_BASE_V3_GROUPS_CUTOVER = previousCutover;
    }

    if (!passed) {
      throw new Error("Managed lifecycle hook rollback regression failed");
    }
    process.stdout.write("0x01");
    return;
  }

  const state = await fixture();

  if (scenario === "prepare-resume") {
    await deployGroupsStack(state.fakeHre);
    const orchestrator = await state.fakeHre.deployments.get("OrchestratorV3");
    const addData = state.orchestratorRegistry.interface.encodeFunctionData(
      "addOrchestrator",
      [orchestrator.address]
    );
    let passed =
      safeBatchCollector.count() === 1 &&
      safeBatchCollector.hasQueued(
        state.orchestratorRegistry.address,
        addData
      ) &&
      !(await state.orchestratorRegistry.isOrchestrator(orchestrator.address));
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
      rejected =
        error instanceof Error &&
        error.message.includes("protocol fee mismatch");
    }
    process.stdout.write(
      rejected && safeBatchCollector.count() === 0 ? "0x01" : "0x00"
    );
    return;
  }

  throw new Error(`Unknown V3 groups deployment scenario: ${scenario}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
