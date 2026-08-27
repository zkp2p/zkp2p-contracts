#!/usr/bin/env node

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
const hre = /** @type {any} */ (require("hardhat"));
const { ethers } = hre;

const {
  buildCutoverTransactions,
  buildRotationTransactions,
  buildStagingTransaction,
  buildTrustSurface,
  classifyIntentLock,
  proveNoLivePredecessorLocks,
  reduceActivation,
} = require("../deployments/methodScopedActivation.ts");
const {
  deployActivationContract,
} = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");

const ZERO = ethers.constants.AddressZero;
const METHOD = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const USD = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
const PAYEE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
const INTENT_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("method-scoped-activation-rehearsal")
);
const LIVE_INTENT_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("method-scoped-activation-live-lock")
);
const FRESH_INTENT_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("method-scoped-activation-fresh-intent")
);
const CONTROLLER_DELAY = 2 * 24 * 60 * 60;
const RISK_WINDOW = 30 * 24 * 60 * 60;
const STAKE_AMOUNT = ethers.utils.parseUnits("500", 6);
const INTENT_AMOUNT = ethers.utils.parseUnits("50", 6);
const RELEASE_AMOUNT = ethers.utils.parseUnits("40", 6);

const foundryArtifacts = /** @type {Record<string, string>} */ ({
  OrchestratorV3SurfaceMock:
    "out/OrchestratorV3SurfaceMock.sol/OrchestratorV3SurfaceMock.json",
  DisputeMethodScopedRotationGuard:
    "out/DisputeMethodScopedRotationGuard.sol/DisputeMethodScopedRotationGuard.json",
  DisputeMethodScopedCutoverGuard:
    "out/DisputeMethodScopedCutoverGuard.sol/DisputeMethodScopedCutoverGuard.json",
  DisputeMethodScopedRotationPostcondition:
    "out/DisputeMethodScopedRotationPostcondition.sol/DisputeMethodScopedRotationPostcondition.json",
  DisputeMethodScopedCutoverPostcondition:
    "out/DisputeMethodScopedCutoverPostcondition.sol/DisputeMethodScopedCutoverPostcondition.json",
});

/** @param {string} name @param {any=} signer */
async function getContractFactory(name, signer) {
  try {
    return await ethers.getContractFactory(name, signer);
  } catch (error) {
    const path = foundryArtifacts[name];
    if (!path || !String(error).includes("HH700")) throw error;
    const artifact = JSON.parse(
      readFileSync(join(process.cwd(), path), "utf8")
    );
    return new ethers.ContractFactory(
      artifact.abi,
      artifact.bytecode.object,
      signer || (await ethers.getSigners())[0]
    );
  }
}

/** @param {string} name @param {string} address @param {any=} signer */
async function getContractAt(name, address, signer) {
  try {
    return await ethers.getContractAt(name, address, signer);
  } catch (error) {
    const path = foundryArtifacts[name];
    if (!path || !String(error).includes("HH700")) throw error;
    const artifact = JSON.parse(
      readFileSync(join(process.cwd(), path), "utf8")
    );
    return new ethers.Contract(
      address,
      artifact.abi,
      signer || ethers.provider
    );
  }
}

/** @param {string} name @param {any[]} args */
async function deployContract(name, args = []) {
  const factory = await getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  return contract;
}

/** @param {any} contract @param {any} newOwner @param {boolean} accept */
async function transferTwoStep(contract, newOwner, accept) {
  await (await contract.transferOwnership(newOwner.address)).wait();
  if (accept) await (await contract.connect(newOwner).acceptOwnership()).wait();
}

/** @param {any} value */
function asNumber(value) {
  return typeof value === "number" ? value : value.toNumber();
}

/** @param {any} state */
async function createDeposit(state) {
  await (
    await state.escrow.connect(state.depositor).createDeposit({
      token: state.token.address,
      amount: ethers.utils.parseUnits("500", 6),
      intentAmountRange: {
        min: ethers.utils.parseUnits("10", 6),
        max: ethers.utils.parseUnits("200", 6),
      },
      paymentMethods: [METHOD],
      paymentMethodData: [
        { intentGatingService: ZERO, payeeDetails: PAYEE, data: "0x" },
      ],
      currencies: [
        [
          {
            code: USD,
            minConversionRate: ethers.utils.parseEther("1"),
            oracleRateConfig: {
              adapter: ZERO,
              adapterConfig: "0x",
              spreadBps: 0,
              maxStaleness: 0,
            },
          },
        ],
      ],
      delegate: ZERO,
      intentGuardian: ZERO,
      retainOnEmpty: false,
    })
  ).wait();
}

/** @param {string} address */
async function impersonatedSigner(address) {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [
    address,
    ethers.utils.hexValue(ethers.utils.parseEther("10")),
  ]);
  return ethers.provider.getSigner(address);
}

/** @param {any} state @param {string} intentHash @param {boolean} settle */
async function openIntent(state, intentHash, settle) {
  const hookSigner = await impersonatedSigner(state.predecessorHook.address);
  try {
    await (
      await state.predecessorPolicy
        .connect(hookSigner)
        .onIntentSignaled(
          intentHash,
          state.escrow.address,
          0,
          state.taker.address,
          METHOD,
          INTENT_AMOUNT
        )
    ).wait();
    if (settle) {
      await (
        await state.predecessorPolicy
          .connect(hookSigner)
          .onIntentSettled(intentHash, RELEASE_AMOUNT, false)
      ).wait();
    }
  } finally {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [
      state.predecessorHook.address,
    ]);
  }
}

/** @param {any} state */
async function openAndSettleFreshIntent(state) {
  const hookSigner = await impersonatedSigner(state.freshHook.address);
  try {
    await (
      await state.freshPolicy
        .connect(hookSigner)
        .onIntentSignaled(
          FRESH_INTENT_HASH,
          state.escrow.address,
          0,
          state.taker.address,
          METHOD,
          INTENT_AMOUNT
        )
    ).wait();
    await (
      await state.freshPolicy
        .connect(hookSigner)
        .onIntentSettled(FRESH_INTENT_HASH, RELEASE_AMOUNT, false)
    ).wait();
  } finally {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [
      state.freshHook.address,
    ]);
  }
}

/**
 * @param {"base" | "base_staging"} network
 */
async function fixture(network) {
  const signers = await ethers.getSigners();
  const [deployer, safe, depositor, taker, witness, protocolFeeRecipient] =
    signers;
  const governance = network === "base" ? safe : deployer;

  const token = await deployContract("USDCMock", [
    ethers.utils.parseUnits("1000000000", 6),
    "USDC",
    "USDC",
  ]);
  const paymentVerifierRegistry = await deployContract(
    "PaymentVerifierRegistry"
  );
  const escrowRegistry = await deployContract("EscrowRegistry");
  const orchestratorRegistry = await deployContract("OrchestratorRegistry");
  const relayerRegistry = await deployContract("RelayerRegistry");
  const paymentVerifier = await deployContract("PaymentVerifierMock");
  await (
    await paymentVerifierRegistry.addPaymentMethod(
      METHOD,
      paymentVerifier.address,
      [USD]
    )
  ).wait();
  const escrow = await deployContract("EscrowV2", [
    deployer.address,
    1,
    orchestratorRegistry.address,
    paymentVerifierRegistry.address,
    deployer.address,
    0,
    20,
    60 * 60,
  ]);
  const groupRegistry = await deployContract("AddressGroupRegistry");
  const whitelistPolicy = await deployContract("WhitelistPolicy", [
    groupRegistry.address,
    escrowRegistry.address,
    orchestratorRegistry.address,
  ]);
  const legacyNullifierRegistry = await deployContract("NullifierRegistry");
  const nullifierRegistryV2 = await deployContract("NullifierRegistryV2", [
    legacyNullifierRegistry.address,
  ]);
  const disputeRegistry = await deployContract("NullifierRegistry");
  const attestationVerifier = await deployContract("MultiAttestationVerifier", [
    [witness.address],
    1,
  ]);
  const disputeVerifier = await deployContract("DisputeVerifier", [
    deployer.address,
    nullifierRegistryV2.address,
    attestationVerifier.address,
  ]);
  const vault = await deployContract("StakeVault", [
    deployer.address,
    token.address,
    ZERO,
    CONTROLLER_DELAY,
  ]);
  const predecessorPolicy = await deployContract("DisputeProtectionPolicy", [
    deployer.address,
    vault.address,
    disputeVerifier.address,
    disputeRegistry.address,
  ]);
  const freshPolicy = await deployContract("DisputeProtectionPolicy", [
    deployer.address,
    vault.address,
    disputeVerifier.address,
    disputeRegistry.address,
  ]);
  const predecessorHook = await deployContract("IntentLifecycleHookV1", [
    orchestratorRegistry.address,
    whitelistPolicy.address,
    predecessorPolicy.address,
  ]);
  const freshHook = await deployContract("IntentLifecycleHookV1", [
    orchestratorRegistry.address,
    whitelistPolicy.address,
    freshPolicy.address,
  ]);
  const orchestrator = await deployContract("OrchestratorV3SurfaceMock", [
    governance.address,
    escrowRegistry.address,
    paymentVerifierRegistry.address,
    relayerRegistry.address,
    protocolFeeRecipient.address,
  ]);

  await (await vault.initializeController(predecessorPolicy.address)).wait();
  await (
    await disputeRegistry.addWritePermission(predecessorPolicy.address)
  ).wait();
  await (
    await predecessorPolicy.setLifecycleHookAuthorization(
      predecessorHook.address,
      true
    )
  ).wait();
  await (
    await freshPolicy.setLifecycleHookAuthorization(freshHook.address, true)
  ).wait();
  await (await predecessorPolicy.setRiskWindow(METHOD, RISK_WINDOW)).wait();
  await (await freshPolicy.setRiskWindow(METHOD, RISK_WINDOW)).wait();
  await (
    await orchestrator
      .connect(governance)
      .setLifecycleHook(predecessorHook.address)
  ).wait();
  await (
    await orchestratorRegistry.addOrchestrator(orchestrator.address)
  ).wait();

  await (
    await token.transfer(depositor.address, ethers.utils.parseUnits("2000", 6))
  ).wait();
  await (
    await token
      .connect(depositor)
      .approve(escrow.address, ethers.constants.MaxUint256)
  ).wait();
  await (await token.transfer(taker.address, STAKE_AMOUNT)).wait();
  await (
    await token.connect(taker).approve(vault.address, STAKE_AMOUNT)
  ).wait();
  await (await vault.connect(taker).depositStake(STAKE_AMOUNT)).wait();

  const state = /** @type {any} */ ({
    network,
    deployer,
    safe,
    governance,
    depositor,
    taker,
    witness,
    protocolFeeRecipient,
    token,
    paymentVerifierRegistry,
    escrowRegistry,
    orchestratorRegistry,
    relayerRegistry,
    escrow,
    groupRegistry,
    whitelistPolicy,
    nullifierRegistryV2,
    disputeRegistry,
    attestationVerifier,
    disputeVerifier,
    vault,
    predecessorPolicy,
    freshPolicy,
    predecessorHook,
    freshHook,
    orchestrator,
  });
  await createDeposit(state);
  await openIntent(state, INTENT_HASH, true);

  if (network === "base") {
    await (await disputeRegistry.transferOwnership(safe.address)).wait();
    await (await whitelistPolicy.transferOwnership(safe.address)).wait();
    await (await attestationVerifier.transferOwnership(safe.address)).wait();
    await transferTwoStep(vault, safe, true);
    await transferTwoStep(predecessorPolicy, safe, true);
    await transferTwoStep(disputeVerifier, safe, true);
    await transferTwoStep(freshPolicy, safe, false);
  }

  const addresses = {
    safe: governance.address.toLowerCase(),
    deployer: deployer.address.toLowerCase(),
    escrow: escrow.address.toLowerCase(),
    vault: vault.address.toLowerCase(),
    predecessorPolicy: predecessorPolicy.address.toLowerCase(),
    freshPolicy: freshPolicy.address.toLowerCase(),
    predecessorHook: predecessorHook.address.toLowerCase(),
    freshHook: freshHook.address.toLowerCase(),
    registry: disputeRegistry.address.toLowerCase(),
    orchestrator: orchestrator.address.toLowerCase(),
    orchestratorRegistry: orchestratorRegistry.address.toLowerCase(),
    escrowRegistry: escrowRegistry.address.toLowerCase(),
    paymentVerifierRegistry: paymentVerifierRegistry.address.toLowerCase(),
    relayerRegistry: relayerRegistry.address.toLowerCase(),
    protocolFeeRecipient: protocolFeeRecipient.address.toLowerCase(),
    whitelistPolicy: whitelistPolicy.address.toLowerCase(),
    groupRegistry: groupRegistry.address.toLowerCase(),
    attestationVerifier: attestationVerifier.address.toLowerCase(),
    disputeVerifier: disputeVerifier.address.toLowerCase(),
    nullifierRegistryV2: nullifierRegistryV2.address.toLowerCase(),
    stakeToken: token.address.toLowerCase(),
  };
  state.expected = {
    network,
    governance: governance.address.toLowerCase(),
    deployer: deployer.address.toLowerCase(),
    addresses,
    riskWindows: { [METHOD.toLowerCase()]: RISK_WINDOW.toString() },
    witnesses: [witness.address.toLowerCase()],
    controllerChangeDelay: CONTROLLER_DELAY.toString(),
  };
  state.fakeHre = {
    ethers: {
      ...ethers,
      getContractFactory,
    },
    getUnnamedAccounts: async () => [deployer.address],
  };
  return state;
}

/** @param {any} state @returns {Promise<any>} */
async function readSnapshot(state) {
  const blockNumber = await ethers.provider.getBlockNumber();
  const block = await ethers.provider.getBlock(blockNumber);
  const intent = await state.predecessorPolicy.getDisputeProtectionIntent(
    INTENT_HASH
  );
  const lock = await state.vault.locks(INTENT_HASH);
  const status = asNumber(intent.status);
  const lockAmount = lock.amount.toString();
  const maturesAt = lock.maturesAt.toString();
  const intentState = {
    intentHash: INTENT_HASH.toLowerCase(),
    status,
    lockAmount,
    maturesAt,
    classification: classifyIntentLock(
      status,
      lockAmount,
      maturesAt,
      block.timestamp.toString()
    ),
  };
  const lockProof = proveNoLivePredecessorLocks([intentState], 0, blockNumber);
  const [
    freshOwner,
    freshPendingOwner,
    predecessorOwner,
    predecessorPendingOwner,
  ] = await Promise.all([
    state.freshPolicy.owner(),
    state.freshPolicy.pendingOwner(),
    state.predecessorPolicy.owner(),
    state.predecessorPolicy.pendingOwner(),
  ]);
  /** @param {string} value */
  const lower = (value) => value.toLowerCase();
  return {
    network: state.network,
    blockNumber,
    blockHash: block.hash.toLowerCase(),
    blockTimestamp: block.timestamp.toString(),
    freshPolicy: {
      owner: lower(freshOwner),
      pendingOwner: lower(freshPendingOwner),
      admissionsPaused: await state.freshPolicy.admissionsPaused(),
      disputeVerifier: lower(await state.freshPolicy.disputeVerifier()),
      disputeNullifierRegistry: lower(
        await state.freshPolicy.disputeNullifierRegistry()
      ),
      stakeVault: lower(await state.freshPolicy.stakeVault()),
      authorizedHooks: [lower(state.freshHook.address)],
      riskWindows: {
        [METHOD.toLowerCase()]: (
          await state.freshPolicy.getRiskWindow(METHOD)
        ).toString(),
      },
    },
    predecessorPolicy: {
      owner: lower(predecessorOwner),
      pendingOwner: lower(predecessorPendingOwner),
      admissionsPaused: await state.predecessorPolicy.admissionsPaused(),
      disputeVerifier: lower(await state.predecessorPolicy.disputeVerifier()),
      disputeNullifierRegistry: lower(
        await state.predecessorPolicy.disputeNullifierRegistry()
      ),
    },
    disputeVerifier: {
      owner: lower(await state.disputeVerifier.owner()),
      pendingOwner: lower(await state.disputeVerifier.pendingOwner()),
      attestationVerifier: lower(
        await state.disputeVerifier.attestationVerifier()
      ),
      nullifierRegistry: lower(await state.disputeVerifier.nullifierRegistry()),
    },
    vault: {
      owner: lower(await state.vault.owner()),
      pendingOwner: lower(await state.vault.pendingOwner()),
      controller: lower(await state.vault.controller()),
      pendingController: lower(await state.vault.pendingController()),
      pendingControllerValidAt: (
        await state.vault.pendingControllerValidAt()
      ).toString(),
      controllerChangeDelay: (
        await state.vault.controllerChangeDelay()
      ).toString(),
      stakeToken: lower(await state.vault.stakeToken()),
    },
    registry: {
      owner: lower(await state.disputeRegistry.owner()),
      writers: (await state.disputeRegistry.getWriters()).map(lower),
    },
    orchestrator: {
      owner: lower(await state.orchestrator.owner()),
      paused: await state.orchestrator.paused(),
      lifecycleHook: lower(await state.orchestrator.lifecycleHook()),
      escrowRegistry: lower(await state.orchestrator.escrowRegistry()),
      paymentVerifierRegistry: lower(
        await state.orchestrator.paymentVerifierRegistry()
      ),
      relayerRegistry: lower(await state.orchestrator.relayerRegistry()),
      protocolFee: (await state.orchestrator.protocolFee()).toString(),
      protocolFeeRecipient: lower(
        await state.orchestrator.protocolFeeRecipient()
      ),
      allowMultipleIntents: await state.orchestrator.allowMultipleIntents(),
      registered: await state.orchestratorRegistry.isOrchestrator(
        state.orchestrator.address
      ),
    },
    freshHook: {
      orchestratorRegistry: lower(await state.freshHook.orchestratorRegistry()),
      whitelistPolicy: lower(await state.freshHook.whitelistPolicy()),
      disputeProtectionPolicy: lower(
        await state.freshHook.disputeProtectionPolicy()
      ),
    },
    whitelistPolicy: {
      owner: lower(await state.whitelistPolicy.owner()),
      escrowRegistry: lower(await state.whitelistPolicy.escrowRegistry()),
      groupRegistry: lower(await state.whitelistPolicy.groupRegistry()),
      orchestratorRegistry: lower(
        await state.whitelistPolicy.orchestratorRegistry()
      ),
    },
    attestationVerifier: {
      owner: lower(await state.attestationVerifier.owner()),
      requiredSignatures: (
        await state.attestationVerifier.requiredSignatures()
      ).toString(),
      witnesses: (await state.attestationVerifier.witnesses()).map(lower),
    },
    lockProof,
    inventory: {
      escrow: lower(state.escrow.address),
      depositCounter: (await state.escrow.depositCounter()).toString(),
      block: blockNumber,
      tuples: [],
      violations: [],
      ok: true,
    },
  };
}

/** @param {any} state */
async function reduction(state) {
  return reduceActivation(await readSnapshot(state), state.expected);
}

/**
 * @param {any} state
 * @param {import("../deployments/methodScopedActivation").StagingAction} expectedAction
 */
async function executeStagingStep(state, expectedAction) {
  const beforeSnapshot = await readSnapshot(state);
  const before = reduceActivation(beforeSnapshot, state.expected);
  assert.equal(before.nextStagingAction, expectedAction);
  const transaction = buildStagingTransaction(
    expectedAction,
    state.expected.addresses,
    beforeSnapshot.lockProof
  );
  await (
    await state.deployer.sendTransaction({
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
    })
  ).wait();
}

/** @param {any} state */
async function executeStagingRun(state) {
  const current = await reduction(state);
  if (!current.nextStagingAction) return false;
  await executeStagingStep(state, current.nextStagingAction);
  return true;
}

/** @param {number} timestamp */
async function advanceTo(timestamp) {
  const current = (await ethers.provider.getBlock("latest")).timestamp;
  if (timestamp > current) {
    await ethers.provider.send("evm_increaseTime", [timestamp - current]);
  }
  await ethers.provider.send("evm_mine", []);
}

/** @param {any} signer @param {any[]} transactions */
async function executeTransactions(signer, transactions) {
  for (const transaction of transactions) {
    const receipt = await (
      await signer.sendTransaction({
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
      })
    ).wait();
    assert.equal(receipt.status, 1);
  }
}

test("staging rehearsal waits for controller delay and predecessor drain", async () => {
  const state = await fixture("base_staging");
  const initialSnapshot = await ethers.provider.send("evm_snapshot", []);
  try {
    await executeStagingStep(state, "pause-predecessor-admissions");
    await executeStagingStep(state, "propose-controller");

    let current = await reduction(state);
    assert.equal(
      `waiting: ${current.waiting?.reason}`,
      "waiting: controller-delay"
    );
    const validAt = asNumber(await state.vault.pendingControllerValidAt());
    await advanceTo(validAt);

    current = await reduction(state);
    assert.equal(
      `waiting: ${current.waiting?.reason}`,
      "waiting: predecessor-drain"
    );
    assert.equal(current.nextStagingAction, null, "step 4 must be refused");

    const intent = await state.predecessorPolicy.getDisputeProtectionIntent(
      INTENT_HASH
    );
    await advanceTo(asNumber(intent.releaseEligibleAt));
    await executeStagingStep(state, "release-matured-predecessor-intents");
    const beforeHookSwitch =
      /** @type {import("../deployments/methodScopedActivation").StagingAction[]} */ ([
        "accept-vault-controller",
        "add-fresh-writer",
        "set-fresh-hook",
      ]);
    for (const action of beforeHookSwitch) {
      await executeStagingStep(state, action);
    }
    await openAndSettleFreshIntent(state);
    await executeStagingStep(state, "remove-predecessor-writer");
    current = await reduction(state);
    assert.equal(current.phase, "active");
    assert.equal(current.nextStagingAction, null);
    assert.equal(current.waiting, null);
    assert.equal(await executeStagingRun(state), false);
  } finally {
    assert.equal(
      await ethers.provider.send("evm_revert", [initialSnapshot]),
      true
    );
  }
});

test("Base rehearsal executes real guarded rotation and cutover lists", async () => {
  const state = await fixture("base");
  const initialSnapshot = await ethers.provider.send("evm_snapshot", []);
  try {
    const deployed = await reduction(state);
    assert.equal(deployed.phase, "deployed");
    const trustSurface = buildTrustSurface(state.expected);
    const rotationGuardIdentity = await deployActivationContract(
      state.fakeHre,
      "DisputeMethodScopedRotationGuard",
      [trustSurface, true, state.deployer.address]
    );
    const rotationPostconditionIdentity = await deployActivationContract(
      state.fakeHre,
      "DisputeMethodScopedRotationPostcondition",
      [trustSurface, CONTROLLER_DELAY]
    );
    const rotationTransactions = buildRotationTransactions({
      addresses: state.expected.addresses,
      guard: rotationGuardIdentity.address,
      includeAcceptOwnership: true,
    });
    const rotationPostcondition = await getContractAt(
      "DisputeMethodScopedRotationPostcondition",
      rotationPostconditionIdentity.address
    );
    const postconditionData =
      rotationPostcondition.interface.encodeFunctionData(
        "assertPostconditions"
      );

    const nonce = await state.safe.getTransactionCount("pending");
    const pending = [];
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      for (const [index, transaction] of rotationTransactions.entries()) {
        pending.push(
          await state.safe.sendTransaction({
            to: transaction.to,
            value: transaction.value,
            data: transaction.data,
            nonce: nonce + index,
            gasLimit: 6_000_000,
          })
        );
      }
      pending.push(
        await state.safe.sendTransaction({
          to: rotationPostcondition.address,
          data: postconditionData,
          nonce: nonce + rotationTransactions.length,
          gasLimit: 6_000_000,
        })
      );
      await ethers.provider.send("evm_mine", []);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    const rotationReceipts = await Promise.all(
      pending.map((transaction) => transaction.wait())
    );
    assert.ok(rotationReceipts.every((receipt) => receipt.status === 1));
    assert.equal(
      new Set(rotationReceipts.map((receipt) => receipt.blockNumber)).size,
      1
    );

    const settledIntent =
      await state.predecessorPolicy.getDisputeProtectionIntent(INTENT_HASH);
    await advanceTo(
      Math.max(
        asNumber(await state.vault.pendingControllerValidAt()),
        asNumber(settledIntent.releaseEligibleAt)
      )
    );
    await (
      await state.predecessorPolicy.releaseMaturedDisputeProtectionIntent(
        INTENT_HASH
      )
    ).wait();
    const cutoverSnapshot = await readSnapshot(state);
    const cutoverReduction = reduceActivation(cutoverSnapshot, state.expected);
    assert.equal(cutoverReduction.phase, "rotation-proposed");
    assert.equal(cutoverReduction.waiting, null);

    const inventoryTuples = cutoverSnapshot.inventory.tuples.map(
      /** @param {any} tuple */
      (tuple) => ({
        escrow: tuple.escrow,
        depositId: tuple.depositId,
        paymentMethod: tuple.paymentMethod,
      })
    );
    const cutoverGuardIdentity = await deployActivationContract(
      state.fakeHre,
      "DisputeMethodScopedCutoverGuard",
      [
        trustSurface,
        cutoverSnapshot.lockProof.intents.map(
          /** @param {any} intent */ (intent) => intent.intentHash
        ),
        inventoryTuples,
        cutoverSnapshot.inventory.escrow,
        cutoverSnapshot.inventory.depositCounter,
      ]
    );
    const cutoverPostconditionIdentity = await deployActivationContract(
      state.fakeHre,
      "DisputeMethodScopedCutoverPostcondition",
      [trustSurface]
    );
    const cutoverGuard = await getContractAt(
      "DisputeMethodScopedCutoverGuard",
      cutoverGuardIdentity.address
    );

    const depositSnapshot = await ethers.provider.send("evm_snapshot", []);
    await createDeposit(state);
    await assert.rejects(() => cutoverGuard.callStatic.assertReady());
    assert.equal(
      await ethers.provider.send("evm_revert", [depositSnapshot]),
      true
    );

    const liveLockSnapshot = await ethers.provider.send("evm_snapshot", []);
    await (
      await state.predecessorPolicy
        .connect(state.safe)
        .setAdmissionsPaused(false)
    ).wait();
    await openIntent(state, LIVE_INTENT_HASH, false);
    await (
      await state.predecessorPolicy
        .connect(state.safe)
        .setAdmissionsPaused(true)
    ).wait();
    const liveLockGuardIdentity = await deployActivationContract(
      state.fakeHre,
      "DisputeMethodScopedCutoverGuard",
      [
        trustSurface,
        [INTENT_HASH, LIVE_INTENT_HASH],
        inventoryTuples,
        cutoverSnapshot.inventory.escrow,
        cutoverSnapshot.inventory.depositCounter,
      ]
    );
    const liveLockGuard = await getContractAt(
      "DisputeMethodScopedCutoverGuard",
      liveLockGuardIdentity.address
    );
    await assert.rejects(() => liveLockGuard.callStatic.assertReady());
    assert.equal(
      await ethers.provider.send("evm_revert", [liveLockSnapshot]),
      true
    );

    const cutoverTransactions = buildCutoverTransactions({
      addresses: state.expected.addresses,
      guard: cutoverGuardIdentity.address,
    });
    await executeTransactions(state.safe, cutoverTransactions);
    const cutoverPostcondition = await getContractAt(
      "DisputeMethodScopedCutoverPostcondition",
      cutoverPostconditionIdentity.address
    );
    await cutoverPostcondition
      .connect(state.safe)
      .callStatic.assertPostconditions();
    const active = await reduction(state);
    assert.equal(active.phase, "active");
  } finally {
    assert.equal(
      await ethers.provider.send("evm_revert", [initialSnapshot]),
      true
    );
  }
});
