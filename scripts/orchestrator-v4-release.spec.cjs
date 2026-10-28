require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const hre = require("hardhat");
const { ContractFactory, VoidSigner, Wallet, utils, constants } = require("ethers");
const { inspect, assertFreshDeploymentPreflight, assertBaseline, validateConfig, TransactionJournal, deploySuite, activate, verifySuite, activationTransactions, DRAIN_QUERY, recordDrainEvidence, assertPrivateDepositsPreserved } = require("./deploy-orchestrator-v4.ts");

// Public Hardhat fixture account. Never load a service or production signer in these tests.
const wallet = Wallet.fromMnemonic("test test test test test test test test test test test junk").connect(hre.ethers.provider);
const other = Wallet.fromMnemonic("test test test test test test test test test test test junk", "m/44'/60'/0'/0/1").address;

async function drainEvidence() {
  const block = await hre.ethers.provider.getBlockNumber();
  return { pausedAtBlock: block, query: DRAIN_QUERY, response: { data: { Intent: [], chain_metadata: [{ latest_processed_block: block }] } }, legacySignals: { Orchestrator: [], OrchestratorV4Historical20261016: [] } };
}

async function createPrivateDeposit(f, retainOnEmpty = true) {
  const token = f.deployed.USDCMock, escrow = f.deployed.EscrowV2;
  const method = f.config.paymentMethods[0].method, id = (await escrow.depositCounter()).toString();
  await (await token.approve(escrow.address, 100)).wait();
  await (await escrow.createDeposit({
    token: token.address, amount: 100, intentAmountRange: { min: 1, max: 100 }, paymentMethods: [method],
    paymentMethodData: [{ intentGatingService: constants.AddressZero, payeeDetails: utils.id("fixture payee"), data: "0x" }],
    currencies: [[{ code: utils.id("USD"), minConversionRate: utils.parseEther("1"), oracleRateConfig: { adapter: constants.AddressZero, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0 } }]],
    delegate: constants.AddressZero, intentGuardian: other, retainOnEmpty,
  })).wait();
  await (await f.deployed.PredecessorWhitelistPolicy.setEnabled(escrow.address, id, method, true)).wait();
  return { escrow: escrow.address, depositId: id, paymentMethod: method };
}

async function fixture() {
  await hre.network.provider.send("hardhat_reset");
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const deployed = {};
  async function deploy(name, args = [], alias = name) {
    const contract = await (await hre.ethers.getContractFactory(name, wallet)).deploy(...args);
    await contract.deployed(); deployed[alias] = contract; return contract;
  }
  const token = await deploy("USDCMock", ["1000000000000", "Fixture USD", "FUSD"]);
  const er = await deploy("EscrowRegistry"), or = await deploy("OrchestratorRegistry"), pvr = await deploy("PaymentVerifierRegistry"), rr = await deploy("RelayerRegistry");
  const legacy = await deploy("NullifierRegistry"), nr = await deploy("NullifierRegistryV2", [legacy.address]);
  const dnr = await deploy("NullifierRegistry", [], "DisputeNullifierRegistry");
  const av = await deploy("MultiAttestationVerifier", [[other], 1]);
  const dv = await deploy("DisputeVerifier", [wallet.address, nr.address, av.address]);
  const uv = await deploy("UnifiedPaymentVerifierV3", [or.address, nr.address, av.address]);
  const escrow = await deploy("EscrowV2", [wallet.address, chainId, or.address, pvr.address, rr.address, 1, 100, 3600]);
  const o3 = await deploy("OrchestratorV3", [wallet.address, chainId, er.address, pvr.address, rr.address, 0, wallet.address]);
  const hooks = await deploy("PostIntentHookRegistry");
  const o1 = await deploy("Orchestrator", [wallet.address, chainId, er.address, pvr.address, hooks.address, rr.address, 0, wallet.address]);
  await (await o1.pauseOrchestrator()).wait();
  const groups = await deploy("AddressGroupRegistry"), whitelist = await deploy("WhitelistPolicy", [groups.address, er.address, or.address]);
  const historical = require("../deployments/base_staging/OrchestratorV4Historical20261016.json");
  const oldO4 = await new ContractFactory(historical.abi, historical.bytecode, wallet).deploy(wallet.address, chainId, er.address, pvr.address, rr.address, 0, wallet.address, whitelist.address);
  await oldO4.deployed(); await (await oldO4.pauseOrchestrator()).wait();
  deployed.OrchestratorV4Historical20261016 = oldO4;
  const hook = await deploy("WhitelistLifecycleHook", [or.address, whitelist.address]);
  await (await er.addEscrow(escrow.address)).wait(); await (await or.addOrchestrator(o3.address)).wait();
  await (await o3.setLifecycleHook(hook.address)).wait();
  await (await nr.addWritePermission(uv.address)).wait(); await (await dnr.addWritePermission(dv.address)).wait();
  const paymentMethods = ["paypal", "venmo", "zelle"].map((method) => ({ method: utils.id(method), currencies: [utils.id("USD"), utils.id("EUR")] }));
  for (const { method, currencies } of paymentMethods) {
    await (await uv.addPaymentMethod(method)).wait(); await (await pvr.addPaymentMethod(method, uv.address, currencies)).wait();
  }
  deployed.PredecessorWhitelistPolicy = whitelist;
  const existing = {};
  for (const name of ["EscrowV2", "EscrowRegistry", "OrchestratorRegistry", "PaymentVerifierRegistry", "RelayerRegistry", "NullifierRegistryV2", "DisputeNullifierRegistry", "DisputeVerifier", "MultiAttestationVerifier", "OrchestratorV3", "UnifiedPaymentVerifierV3", "Orchestrator", "OrchestratorV4Historical20261016", "PredecessorWhitelistPolicy"]) {
    const contract = deployed[name], receipt = await contract.deployTransaction.wait();
    existing[name] = { address: contract.address, artifact: name === "PredecessorWhitelistPolicy" ? "WhitelistPolicy" : name === "DisputeNullifierRegistry" ? "NullifierRegistry" : name === "OrchestratorV4Historical20261016" ? "OrchestratorV4" : name, runtimeCodeHash: utils.keccak256(await hre.ethers.provider.getCode(contract.address)), deploymentTransaction: receipt.transactionHash, deploymentBlock: receipt.blockNumber };
  }
  const config = { version: 1, environment: "base_staging", chainId, signer: wallet.address, governance: wallet.address, gatingService: other, existing, stakeToken: token.address, protocolFee: "0", protocolFeeRecipient: wallet.address, allowMultipleIntents: false, predecessorHook: hook.address, paymentMethods, retainedDisputeWriters: [dv.address], attestationWitnesses: [other], attestationThreshold: "1", baselineBlock: await hre.ethers.provider.getBlockNumber(), legacyWhitelistCheckpoint: { indexedBlock: await hre.ethers.provider.getBlockNumber(), enabled: [] }, legacyDrainCheckpoints: ["Orchestrator", "OrchestratorV4Historical20261016"].map((contract) => ({ contract, intentCounter: "0", indexedBlock: existing[contract].deploymentBlock })) };
  const directory = mkdtempSync(join(tmpdir(), "o4-release-test-"));
  hre.config.paths.deployments = join(directory, "deployments");
  const path = join(directory, "manifest.json");
  const manifest = { version: 1, sourceCommit: "0".repeat(40), configurationHash: "fixture", configuration: config, baseline: await inspect(hre, config), transactions: [], activationDrainEvidence: null, contracts: {}, verification: {}, governanceTransactions: [] };
  const journal = new TransactionJournal(path, manifest, wallet);
  await recordDrainEvidence(hre, journal, await drainEvidence());
  return { config, deployed, directory, path, manifest, journal };
}

test("fresh inspect and deployment share baseline and pending-nonce rejection", async () => {
  const f = await fixture();
  try {
    const snapshot = await inspect(hre, f.config);
    assert.doesNotThrow(() => assertFreshDeploymentPreflight(f.config, snapshot));
    assert.throws(() => assertFreshDeploymentPreflight(f.config, { ...snapshot, signer: { ...snapshot.signer, pendingNonce: snapshot.signer.nonce + 1 } }), /Signer has pending transactions/);
    assert.throws(() => assertFreshDeploymentPreflight(f.config, { ...snapshot, predecessor: { ...snapshot.predecessor, lifecycleHook: constants.AddressZero } }), /O3 registration, pause or lifecycle hook changed/);
    assert.throws(() => assertFreshDeploymentPreflight(f.config, { ...snapshot, nullifierWriters: [other] }), /Unexpected payment nullifier writer/);
    assert.throws(() => assertFreshDeploymentPreflight({ ...f.config, environment: "base" }, { ...snapshot, requiredOwnershipChanges: [{ name: "OrchestratorRegistry", owner: other, requiredOwner: wallet.address }] }), /Activation ownership missing/);
    assert.equal(await wallet.getTransactionCount(), snapshot.signer.nonce);
    assert.equal(f.manifest.transactions.length, 0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("RPC and signer pins fail before the first deployment", async () => {
  const f = await fixture();
  try {
    const nonce = await wallet.getTransactionCount();
    const chainId = f.config.chainId; f.config.chainId = 8453;
    await assert.rejects(deploySuite(hre, f.journal), /RPC chain ID/);
    f.config.chainId = chainId;
    assert.equal(await wallet.getTransactionCount(), nonce); assert.equal(f.manifest.transactions.length, 0);
    await assert.rejects(deploySuite(hre, new TransactionJournal(f.path, f.manifest, Wallet.createRandom().connect(hre.ethers.provider))), /Signer differs/);
    assert.throws(() => validateConfig({ ...f.config, signer: null }), /Invalid configured signer/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("eight-contract deployment resumes without duplicate addresses or transactions and activates in preserved order", async () => {
  const f = await fixture();
  try {
    await deploySuite(hre, f.journal);
    const addresses = Object.values(f.manifest.contracts).map((record) => record.address);
    assert.equal(addresses.length, 8); assert.equal(new Set(addresses).size, 8);
    assert.equal(await f.deployed.OrchestratorRegistry.isOrchestrator(f.manifest.contracts.OrchestratorV4.address), false);
    const nonce = await wallet.getTransactionCount();
    const restored = new TransactionJournal(f.path, JSON.parse(readFileSync(f.path)), wallet);
    await deploySuite(hre, restored); assert.equal(await wallet.getTransactionCount(), nonce);
    await (await f.deployed.Orchestrator.unpauseOrchestrator()).wait();
    const beforeRejectedActivation = await wallet.getTransactionCount();
    await assert.rejects(activate(hre, restored), /Orchestrator must be paused/);
    assert.equal(await wallet.getTransactionCount(), beforeRejectedActivation);
    await (await f.deployed.Orchestrator.pauseOrchestrator()).wait();
    restored.manifest.configuration.legacyDrainCheckpoints[0].intentCounter = "1";
    await assert.rejects(activate(hre, restored), /Orchestrator intent counter changed/);
    restored.manifest.configuration.legacyDrainCheckpoints[0].intentCounter = "0";
    await (await f.deployed.OrchestratorV4Historical20261016.unpauseOrchestrator()).wait();
    const beforeOldO4Rejection = await wallet.getTransactionCount();
    await assert.rejects(activate(hre, restored), /OrchestratorV4Historical20261016 must be paused/);
    assert.equal(await wallet.getTransactionCount(), beforeOldO4Rejection);
    await (await f.deployed.OrchestratorV4Historical20261016.pauseOrchestrator()).wait();
    await assert.rejects(activate(hre, restored), /was unpaused after the drain observation/);
    await recordDrainEvidence(hre, restored, await drainEvidence());
    await activate(hre, restored);
    const savedEvidence = restored.manifest.activationDrainEvidence;
    restored.manifest.activationDrainEvidence = null;
    await assert.rejects(verifySuite(hre, restored, true), /Post-pause indexer drain evidence is required/);
    restored.manifest.activationDrainEvidence = savedEvidence;
    assert.deepEqual(await f.deployed.PaymentVerifierRegistry.getPaymentMethods(), f.config.paymentMethods.map((x) => x.method));
    assert.deepEqual(await f.deployed.NullifierRegistryV2.getWriters(), [restored.manifest.contracts.UnifiedPaymentVerifierV4.address]);
    assert.deepEqual(await f.deployed.DisputeNullifierRegistry.getWriters(), [...f.config.retainedDisputeWriters, restored.manifest.contracts.DisputeProtectionPolicyV2.address]);
    assert.equal(await f.deployed.OrchestratorV3.lifecycleHook(), f.config.predecessorHook);
    const finalNonce = await wallet.getTransactionCount();
    await activate(hre, restored); assert.equal(await wallet.getTransactionCount(), finalNonce);
    const inputManifest = readFileSync(f.path, "utf8");
    await verifySuite(hre, new TransactionJournal(`${f.path}.verification`, JSON.parse(inputManifest), new VoidSigner(wallet.address, hre.ethers.provider)), true);
    assert.equal(readFileSync(f.path, "utf8"), inputManifest);
    assert.equal(JSON.parse(readFileSync(`${f.path}.verification`)).verification.active, true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("a mined deployment interrupted before receipt persistence resumes its exact signed transaction", async () => {
  const f = await fixture();
  try {
    class InterruptJournal extends TransactionJournal {
      async execute(step, request) {
        const result = await super.execute(step, request);
        if (step === "deploy:AddressGroupRegistryV4") {
          // Reconstruct the crash window: the chain mined it but the manifest still lacks the receipt.
          result.receipt = null; this.save(); throw new Error("injected process interruption");
        }
        return result;
      }
    }
    await assert.rejects(deploySuite(hre, new InterruptJournal(f.path, f.manifest, wallet)), /injected process interruption/);
    const interrupted = f.manifest.transactions.find((tx) => tx.step === "deploy:AddressGroupRegistryV4");
    const hash = interrupted.hash;
    await deploySuite(hre, new TransactionJournal(f.path, JSON.parse(readFileSync(f.path)), wallet));
    const completed = JSON.parse(readFileSync(f.path));
    assert.equal(completed.contracts.AddressGroupRegistryV4.transactionHash, hash);
    assert.equal(completed.transactions.filter((tx) => tx.step === "deploy:AddressGroupRegistryV4").length, 1);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("partial registry activation resumes after reverse removal and rejects unrelated drift", async () => {
  const f = await fixture();
  try {
    await deploySuite(hre, f.journal);
    const actions = await activationTransactions(hre, f.manifest);
    for (const action of actions.slice(0, 3)) await f.journal.execute(action.step, action);
    assert.equal((await f.deployed.PaymentVerifierRegistry.getPaymentMethods()).length, 2);
    await activate(hre, new TransactionJournal(f.path, JSON.parse(readFileSync(f.path)), wallet));
    await (await f.deployed.NullifierRegistryV2.addWritePermission(other)).wait();
    const nonce = await wallet.getTransactionCount();
    await assert.rejects(activate(hre, new TransactionJournal(f.path, JSON.parse(readFileSync(f.path)), wallet)), /Payment writers differ/);
    assert.equal(await wallet.getTransactionCount(), nonce);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("an interruption before broadcast reuses the saved signed bytes and nonce", async () => {
  const f = await fixture();
  try {
    const provider = new Proxy(hre.ethers.provider, {
      get(target, property) {
        if (property === "sendTransaction") return async () => { throw new Error("injected transport failure"); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const nonce = await wallet.getTransactionCount();
    const request = { to: other, data: "0x", value: "1" };
    const interrupted = new TransactionJournal(f.path, f.manifest, wallet.connect(provider));
    await assert.rejects(interrupted.execute("fixture-transfer", request), /injected transport failure/);
    assert.equal(await wallet.getTransactionCount(), nonce);
    const pending = JSON.parse(readFileSync(`${f.path}.pending`));
    const originalHash = pending.hash;
    const signed = utils.parseTransaction(pending.raw), block = await hre.ethers.provider.getBlock("latest");
    const priority = hre.ethers.BigNumber.from(await hre.ethers.provider.send("eth_maxPriorityFeePerGas", []));
    assert.equal(signed.type, 2);
    assert.equal(signed.maxPriorityFeePerGas.toString(), priority.toString());
    assert.equal(signed.maxFeePerGas.toString(), block.baseFeePerGas.mul(2).add(priority).toString());
    const restored = new TransactionJournal(f.path, JSON.parse(readFileSync(f.path)), wallet);
    const completed = await restored.execute("fixture-transfer", request);
    assert.equal(completed.hash, originalHash); assert.equal(await wallet.getTransactionCount(), nonce + 1);
    await assert.rejects(restored.execute("fixture-transfer", { ...request, value: "2" }), /Resumed transaction differs/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("production configuration prepares ownership and unsigned Safe calls; direct activation is rejected", async () => {
  const f = await fixture();
  try {
    f.config.environment = "base"; f.config.governance = other;
    for (const name of ["OrchestratorRegistry", "PaymentVerifierRegistry", "NullifierRegistryV2", "DisputeNullifierRegistry"]) await (await f.deployed[name].transferOwnership(other)).wait();
    assertBaseline(f.config, await inspect(hre, f.config));
    await deploySuite(hre, f.journal);
    const actions = await activationTransactions(hre, f.manifest);
    assert.deepEqual(actions.slice(0, 2).map((x) => x.step), ["accept:StakeVaultV2", "accept:DisputeProtectionPolicyV2"]);
    assert.equal(actions.at(-1).step, "register-orchestrator");
    const o4 = await hre.ethers.getContractAt("OrchestratorV4", f.manifest.contracts.OrchestratorV4.address);
    assert.equal(await o4.owner(), other);
    assert.equal(await o4.signalPolicy(), f.manifest.contracts.IntentSignalPolicy.address);
    const vault = await hre.ethers.getContractAt("StakeVaultV2", f.manifest.contracts.StakeVaultV2.address);
    assert.equal(await vault.owner(), wallet.address); assert.equal(await vault.pendingOwner(), other);
    await assert.rejects(activate(hre, f.journal), /staging-only/);
    assert.equal(await f.deployed.OrchestratorRegistry.isOrchestrator(o4.address), false);
    assert.notEqual(f.manifest.contracts.WhitelistPolicyV2.address, constants.AddressZero);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});


test("pending activation refuses external registry drift before rebroadcasting its signed bytes", async () => {
  const f = await fixture();
  try {
    await deploySuite(hre, f.journal);
    const failedProvider = new Proxy(hre.ethers.provider, {
      get(target, property) {
        if (property === "sendTransaction") return async () => { throw new Error("injected transport failure"); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const nonce = await wallet.getTransactionCount();
    await assert.rejects(activate(hre, new TransactionJournal(f.path, f.manifest, wallet.connect(failedProvider))), /injected transport failure/);
    const pendingHash = JSON.parse(readFileSync(`${f.path}.pending`)).hash;
    // Simulate another authority's ownership change without consuming the deployment signer's pending nonce.
    await hre.network.provider.send("hardhat_setStorageAt", [f.deployed.OrchestratorRegistry.address, "0x0", utils.hexZeroPad(other, 32)]);
    assert.equal(await f.deployed.OrchestratorRegistry.owner(), other);
    let sends = 0;
    const observedProvider = new Proxy(hre.ethers.provider, {
      get(target, property) {
        if (property === "sendTransaction") return async (...args) => { sends++; return target.sendTransaction(...args); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(activate(hre, new TransactionJournal(f.path, JSON.parse(readFileSync(f.path)), wallet.connect(observedProvider))), /Activation ownership missing: OrchestratorRegistry/);
    assert.equal(sends, 0); assert.equal(await wallet.getTransactionCount(), nonce);
    assert.equal(JSON.parse(readFileSync(`${f.path}.pending`)).hash, pendingHash);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("activation requires complete indexed evidence caught up after the predecessors were paused", async () => {
  const f = await fixture();
  try {
    await deploySuite(hre, f.journal);
    const nonce = await wallet.getTransactionCount();
    f.manifest.activationDrainEvidence = null;
    await assert.rejects(activate(hre, f.journal), /Post-pause indexer drain evidence is required/);
    const stale = await drainEvidence();
    stale.response.data.chain_metadata[0].latest_processed_block = stale.pausedAtBlock - 1;
    await assert.rejects(recordDrainEvidence(hre, f.journal, stale), /predates the pause observation/);
    const beforePause = await drainEvidence();
    beforePause.pausedAtBlock = f.config.existing.Orchestrator.deploymentBlock;
    await assert.rejects(recordDrainEvidence(hre, f.journal, beforePause), /was not paused at the drain observation/);
    const openIntent = await drainEvidence();
    openIntent.response.data.Intent.push({ intentHash: utils.id("unsettled legacy intent"), orchestratorAddress: f.deployed.Orchestrator.address, status: "SIGNALED" });
    await assert.rejects(recordDrainEvidence(hre, f.journal, openIntent), /Retired orchestrator still has a signaled intent/);
    assert.equal(await wallet.getTransactionCount(), nonce);
    await recordDrainEvidence(hre, f.journal, await drainEvidence());
    assert.equal(f.manifest.activationDrainEvidence.query, DRAIN_QUERY);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});


test("private-deposit activation covers retained empty liquidity and later events, but excludes deleted deposits", async () => {
  const f = await fixture();
  try {
    const empty = await createPrivateDeposit(f), deleted = await createPrivateDeposit(f, false);
    await (await f.deployed.EscrowV2.withdrawDeposit(empty.depositId)).wait();
    await (await f.deployed.EscrowV2.withdrawDeposit(deleted.depositId)).wait();
    f.config.legacyWhitelistCheckpoint = { indexedBlock: await hre.ethers.provider.getBlockNumber(), enabled: [empty, deleted] };
    const funded = await createPrivateDeposit(f);
    await deploySuite(hre, f.journal);
    const nonce = await wallet.getTransactionCount();
    await assert.rejects(activate(hre, f.journal), /depositors to enable WhitelistPolicyV2: 0x[\da-fA-F]+:0, 0x[\da-fA-F]+:2/);
    assert.equal(await wallet.getTransactionCount(), nonce);
    assert.equal(await f.deployed.DisputeNullifierRegistry.isWriter(f.manifest.contracts.DisputeProtectionPolicyV2.address), false);
    const whitelist = await hre.ethers.getContractAt("WhitelistPolicyV2", f.manifest.contracts.WhitelistPolicyV2.address, wallet);
    await (await whitelist.setEnabled(f.deployed.EscrowV2.address, empty.depositId, true)).wait();
    await assert.rejects(assertPrivateDepositsPreserved(hre, f.journal), /depositors to enable WhitelistPolicyV2: 0x[\da-fA-F]+:2/);
    await (await whitelist.setEnabled(f.deployed.EscrowV2.address, funded.depositId, true)).wait();
    await assertPrivateDepositsPreserved(hre, f.journal);
    assert.deepEqual(f.manifest.verification.privateDeposits.requiredDeposits.map((row) => row.depositId), ["0", "2"]);
    assert.deepEqual(f.manifest.verification.privateDeposits.deletedDeposits.map((row) => row.depositId), ["1"]);
    // Enabling the new policy with no groups/takers makes existing private rows inaccessible through O4.
    assert.equal(await whitelist.isWhitelisted(f.deployed.EscrowV2.address, funded.depositId, other, constants.HashZero), false);
    await activate(hre, f.journal);
    assert.equal(await f.deployed.PredecessorWhitelistPolicy.enabled(f.deployed.EscrowV2.address, funded.depositId, funded.paymentMethod), true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("a private deposit on another registered escrow introduced during cutover blocks registration", async () => {
  const f = await fixture();
  try {
    await deploySuite(hre, f.journal);
    const secondEscrow = await (await hre.ethers.getContractFactory("EscrowV2", wallet)).deploy(wallet.address, f.config.chainId, f.deployed.OrchestratorRegistry.address, f.deployed.PaymentVerifierRegistry.address, f.deployed.RelayerRegistry.address, 1, 100, 3600);
    await secondEscrow.deployed();
    await (await f.deployed.EscrowRegistry.addEscrow(secondEscrow.address)).wait();
    class IntroducePrivateDepositJournal extends TransactionJournal {
      async execute(step, request) {
        const result = await super.execute(step, request);
        if (step === "authorize-policy-writer") await createPrivateDeposit({ ...f, deployed: { ...f.deployed, EscrowV2: secondEscrow } });
        return result;
      }
    }
    await assert.rejects(activate(hre, new IntroducePrivateDepositJournal(f.path, f.manifest, wallet)), /depositors to enable WhitelistPolicyV2: 0x[\da-fA-F]+:0/);
    assert.equal(await f.deployed.OrchestratorRegistry.isOrchestrator(f.manifest.contracts.OrchestratorV4.address), false);
    assert.equal(f.manifest.transactions.some((tx) => tx.step === "register-orchestrator"), false);
    const whitelist = await hre.ethers.getContractAt("WhitelistPolicyV2", f.manifest.contracts.WhitelistPolicyV2.address, wallet);
    await (await whitelist.setEnabled(secondEscrow.address, 0, true)).wait();
    await activate(hre, new TransactionJournal(f.path, JSON.parse(readFileSync(f.path)), wallet));
    assert.equal(await f.deployed.OrchestratorRegistry.isOrchestrator(f.manifest.contracts.OrchestratorV4.address), true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("staging acknowledgement discovers all private deposits and records the exact public exception through activation and verification", async () => {
  const f = await fixture();
  try {
    const empty = await createPrivateDeposit(f), deleted = await createPrivateDeposit(f, false);
    await (await f.deployed.EscrowV2.withdrawDeposit(empty.depositId)).wait();
    await (await f.deployed.EscrowV2.withdrawDeposit(deleted.depositId)).wait();
    f.config.legacyWhitelistCheckpoint = { indexedBlock: await hre.ethers.provider.getBlockNumber(), enabled: [empty, deleted] };
    const later = await createPrivateDeposit(f), preserved = await createPrivateDeposit(f);
    await deploySuite(hre, f.journal);
    const whitelist = await hre.ethers.getContractAt("WhitelistPolicyV2", f.manifest.contracts.WhitelistPolicyV2.address, wallet);
    await (await whitelist.setEnabled(preserved.escrow, preserved.depositId, true)).wait();
    const nonce = await wallet.getTransactionCount(), block = await hre.ethers.provider.getBlockNumber();
    await assert.rejects(activate(hre, f.journal), /depositors to enable WhitelistPolicyV2/);
    for (const input of ["", "true", "02", " 2", "-2", "0"]) await assert.rejects(activate(hre, f.journal, input), /exact positive decimal count/);
    await assert.rejects(activate(hre, f.journal, "3"), /count mismatch: discovered 2/);
    assert.equal(f.manifest.stagingPublicPrivateDepositAcceptances, undefined);
    assert.equal(await wallet.getTransactionCount(), nonce);
    await activate(hre, f.journal, "2");
    const saved = JSON.parse(readFileSync(f.path));
    const expected = [empty, later].map(({ escrow, depositId }) => ({ escrow, depositId }));
    assert.equal(saved.stagingPublicPrivateDepositAcceptances.length, 2);
    assert.equal(saved.stagingPublicPrivateDepositAcceptances[0].checkedAtBlock, block);
    assert.equal(saved.stagingPublicPrivateDepositAcceptances[1].checkedAtBlock, saved.transactions.find((tx) => tx.step === "retire-payment-writer").receipt.blockNumber);
    for (const acceptance of saved.stagingPublicPrivateDepositAcceptances) {
      assert.equal(acceptance.acknowledgement, "2");
      assert.equal(acceptance.predecessorPolicy, f.deployed.PredecessorWhitelistPolicy.address);
      assert.equal(acceptance.whitelistPolicy, whitelist.address);
      assert.deepEqual(acceptance.acceptedDeposits, expected);
    }
    assert.deepEqual(saved.verification.privateDeposits.acceptedPublicDeposits, expected);
    assert.deepEqual(saved.verification.privateDeposits.deletedDeposits, [{ escrow: deleted.escrow, depositId: deleted.depositId }]);
    assert.equal(saved.verification.active, true);
    const readonly = new TransactionJournal(`${f.path}.verification`, saved, new VoidSigner(wallet.address, hre.ethers.provider));
    await verifySuite(hre, readonly, true);
    assert.deepEqual(saved.stagingPublicPrivateDepositAcceptances, f.manifest.stagingPublicPrivateDepositAcceptances);
    const finalNonce = await wallet.getTransactionCount();
    // Saved evidence authorizes read-only verification, never another activation invocation.
    await assert.rejects(activate(hre, f.journal), /depositors to enable WhitelistPolicyV2/);
    assert.equal(await wallet.getTransactionCount(), finalNonce);
    // Enabling one accepted deposit later is fine; a newly private deposit is never silently accepted.
    await (await whitelist.setEnabled(empty.escrow, empty.depositId, true)).wait();
    await verifySuite(hre, readonly, true);
    await createPrivateDeposit(f);
    await assert.rejects(verifySuite(hre, readonly, true), /depositors to enable WhitelistPolicyV2/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("staging acknowledgement cannot bypass ownership, drain, registry prefix, or new private deposits during activation", async () => {
  const f = await fixture();
  try {
    await createPrivateDeposit(f);
    await deploySuite(hre, f.journal);
    const nonce = await wallet.getTransactionCount(), evidence = f.manifest.activationDrainEvidence;
    f.manifest.activationDrainEvidence = null;
    await assert.rejects(activate(hre, f.journal, "1"), /Post-pause indexer drain evidence is required/);
    f.manifest.activationDrainEvidence = evidence;
    await hre.network.provider.send("hardhat_setStorageAt", [f.deployed.OrchestratorRegistry.address, "0x0", utils.hexZeroPad(other, 32)]);
    await assert.rejects(activate(hre, f.journal, "1"), /Activation ownership missing/);
    await hre.network.provider.send("hardhat_setStorageAt", [f.deployed.OrchestratorRegistry.address, "0x0", utils.hexZeroPad(wallet.address, 32)]);
    assert.equal(await wallet.getTransactionCount(), nonce);
    class IntroducePrivateDepositJournal extends TransactionJournal {
      async execute(step, request) {
        const result = await super.execute(step, request);
        if (step === "authorize-policy-writer") await createPrivateDeposit(f);
        return result;
      }
    }
    await assert.rejects(activate(hre, new IntroducePrivateDepositJournal(f.path, f.manifest, wallet), "1"), /count mismatch: discovered 2/);
    assert.equal(f.manifest.transactions.some((tx) => tx.step === "register-orchestrator"), false);
    assert.equal(f.manifest.stagingPublicPrivateDepositAcceptances.length, 1);
    await (await f.deployed.NullifierRegistryV2.addWritePermission(other)).wait();
    const beforeResume = await wallet.getTransactionCount();
    await assert.rejects(activate(hre, f.journal, "2"), /Payment writers differ/);
    assert.equal(await wallet.getTransactionCount(), beforeResume);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("base refuses public private-deposit acknowledgement and recorded staging exceptions", async () => {
  const f = await fixture();
  try {
    f.config.environment = "base";
    const nonce = await wallet.getTransactionCount();
    await assert.rejects(activate(hre, f.journal, "1"), /staging-only; forbidden on base/);
    await assert.rejects(assertPrivateDepositsPreserved(hre, f.journal, { acknowledgement: "1" }), /staging-only; forbidden on base/);
    f.manifest.stagingPublicPrivateDepositAcceptances = [{ acknowledgement: "1" }];
    await assert.rejects(assertPrivateDepositsPreserved(hre, f.journal, { verifyRecordedAcceptance: true }), /staging-only; forbidden on base/);
    assert.equal(await wallet.getTransactionCount(), nonce);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("CLI refuses acknowledgement on base or outside activate before loading Hardhat or a signer", () => {
  for (const [environment, action, error] of [["base", "activate", /staging-only; forbidden on base/], ["base", "prepare-governance", /staging-only; forbidden on base/], ["base_staging", "record-drain", /only accepted by activate/]]) {
    const result = spawnSync(process.execPath, ["-r", "ts-node/register/transpile-only", "scripts/deploy-orchestrator-v4.ts", environment, action], {
      encoding: "utf8", env: { ...process.env, HARDHAT_CONFIG: "nonexistent-config-to-prove-early-refusal.ts", O4_STAGING_ACCEPT_PUBLIC_PRIVATE_DEPOSITS: "1" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
});


test("staging can deploy an inactive suite while registry ownership is pending, but cannot activate it", async () => {
  const f = await fixture();
  try {
    for (const name of ["OrchestratorRegistry", "PaymentVerifierRegistry", "NullifierRegistryV2", "DisputeNullifierRegistry"]) await (await f.deployed[name].transferOwnership(other)).wait();
    const before = await inspect(hre, f.config);
    assert.equal(before.requiredOwnershipChanges.length, 4);
    await deploySuite(hre, f.journal);
    assert.equal(Object.keys(f.manifest.contracts).length, 8);
    const after = await inspect(hre, f.config);
    assert.deepEqual(after.requiredOwnershipChanges, before.requiredOwnershipChanges);
    assert.deepEqual(after.paymentMethods, before.paymentMethods);
    assert.deepEqual(after.nullifierWriters, before.nullifierWriters);
    assert.deepEqual(after.disputeWriters, before.disputeWriters);
    assert.equal(f.manifest.verification.active, false);
    assert.equal(f.manifest.verification.governance, false);
    assert.equal(f.manifest.verification.pendingRegistryOwnership.length, 4);
    assert.equal(await f.deployed.OrchestratorRegistry.isOrchestrator(f.manifest.contracts.OrchestratorV4.address), false);
    const nonce = await wallet.getTransactionCount();
    await assert.rejects(activate(hre, f.journal), /Activation ownership missing/);
    assert.equal(await wallet.getTransactionCount(), nonce);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});


test("unavailable or inconsistent priority fee quotes reject before signing without a fallback", async () => {
  const f = await fixture();
  try {
    const nonce = await wallet.getTransactionCount();
    for (const unavailable of [true, false]) {
      const provider = new Proxy(hre.ethers.provider, {
        get(target, property) {
          if (property === "send") return async (method, params) => {
            if (method === "eth_maxPriorityFeePerGas") {
              if (unavailable) throw new Error("unavailable priority quote");
              return utils.hexValue(utils.parseUnits("1000", "gwei"));
            }
            return target.send(method, params);
          };
          const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await assert.rejects(new TransactionJournal(f.path, f.manifest, wallet.connect(provider)).execute("fee-probe", { to: other, data: "0x", value: "1" }), unavailable ? /unavailable priority quote/ : /RPC priority fee exceeds/);
      assert.equal(f.manifest.transactions.length, 0);
      assert.equal(existsSync(`${f.path}.pending`), false);
      assert.equal(await wallet.getTransactionCount(), nonce);
    }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
