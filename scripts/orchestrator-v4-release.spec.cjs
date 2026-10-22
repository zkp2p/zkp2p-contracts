require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const hre = require("hardhat");
const { Wallet, utils, constants } = require("ethers");
const { inspect, assertBaseline, validateConfig, TransactionJournal, deploySuite, activate, verifySuite, activationTransactions } = require("./deploy-orchestrator-v4.ts");

// Public Hardhat fixture account. Never load a service or production signer in these tests.
const wallet = Wallet.fromMnemonic("test test test test test test test test test test test junk").connect(hre.ethers.provider);
const other = Wallet.fromMnemonic("test test test test test test test test test test test junk", "m/44'/60'/0'/0/1").address;

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
  const groups = await deploy("AddressGroupRegistry"), whitelist = await deploy("WhitelistPolicy", [groups.address, er.address, or.address]);
  const hook = await deploy("WhitelistLifecycleHook", [or.address, whitelist.address]);
  await (await er.addEscrow(escrow.address)).wait(); await (await or.addOrchestrator(o3.address)).wait();
  await (await o3.setLifecycleHook(hook.address)).wait();
  await (await nr.addWritePermission(uv.address)).wait(); await (await dnr.addWritePermission(dv.address)).wait();
  const paymentMethods = ["paypal", "venmo", "zelle"].map((method) => ({ method: utils.id(method), currencies: [utils.id("USD"), utils.id("EUR")] }));
  for (const { method, currencies } of paymentMethods) {
    await (await uv.addPaymentMethod(method)).wait(); await (await pvr.addPaymentMethod(method, uv.address, currencies)).wait();
  }
  const existing = {};
  for (const name of ["EscrowV2", "EscrowRegistry", "OrchestratorRegistry", "PaymentVerifierRegistry", "RelayerRegistry", "NullifierRegistryV2", "DisputeNullifierRegistry", "DisputeVerifier", "MultiAttestationVerifier", "OrchestratorV3", "UnifiedPaymentVerifierV3"]) {
    const contract = deployed[name], receipt = await contract.deployTransaction.wait();
    existing[name] = { address: contract.address, artifact: name === "DisputeNullifierRegistry" ? "NullifierRegistry" : name, runtimeCodeHash: utils.keccak256(await hre.ethers.provider.getCode(contract.address)), deploymentTransaction: receipt.transactionHash, deploymentBlock: receipt.blockNumber };
  }
  const config = { version: 1, environment: "base_staging", chainId, signer: wallet.address, governance: wallet.address, existing, stakeToken: token.address, protocolFee: "0", protocolFeeRecipient: wallet.address, allowMultipleIntents: false, predecessorHook: hook.address, paymentMethods, retainedDisputeWriters: [dv.address], attestationWitnesses: [other], attestationThreshold: "1", baselineBlock: await hre.ethers.provider.getBlockNumber() };
  const directory = mkdtempSync(join(tmpdir(), "o4-release-test-"));
  hre.config.paths.deployments = join(directory, "deployments");
  const path = join(directory, "manifest.json");
  const manifest = { version: 1, sourceCommit: "0".repeat(40), configurationHash: "fixture", configuration: config, baseline: await inspect(hre, config), transactions: [], contracts: {}, verification: {}, governanceTransactions: [] };
  return { config, deployed, directory, path, manifest, journal: new TransactionJournal(path, manifest, wallet) };
}

test("ownership preflight rejects before the first deployment; RPC and signer pins also fail closed", async () => {
  const f = await fixture();
  try {
    await (await f.deployed.OrchestratorRegistry.transferOwnership(other)).wait();
    const nonce = await wallet.getTransactionCount();
    await assert.rejects(deploySuite(hre, f.journal), /Activation ownership missing: OrchestratorRegistry/);
    assert.equal(await wallet.getTransactionCount(), nonce); assert.equal(f.manifest.transactions.length, 0);
    await assert.rejects(inspect(hre, { ...f.config, chainId: 8453 }), /RPC chain ID/);
    await assert.rejects(deploySuite(hre, new TransactionJournal(f.path, f.manifest, Wallet.createRandom().connect(hre.ethers.provider))), /Signer differs/);
    assert.throws(() => validateConfig({ ...f.config, signer: null }), /Invalid configured signer/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("seven-contract deployment resumes without duplicate addresses or transactions and activates in preserved order", async () => {
  const f = await fixture();
  try {
    await deploySuite(hre, f.journal);
    const addresses = Object.values(f.manifest.contracts).map((record) => record.address);
    assert.equal(addresses.length, 7); assert.equal(new Set(addresses).size, 7);
    assert.equal(await f.deployed.OrchestratorRegistry.isOrchestrator(f.manifest.contracts.OrchestratorV4.address), false);
    const nonce = await wallet.getTransactionCount();
    const restored = new TransactionJournal(f.path, JSON.parse(readFileSync(f.path)), wallet);
    await deploySuite(hre, restored); assert.equal(await wallet.getTransactionCount(), nonce);
    await activate(hre, restored);
    assert.deepEqual(await f.deployed.PaymentVerifierRegistry.getPaymentMethods(), f.config.paymentMethods.map((x) => x.method));
    assert.deepEqual(await f.deployed.NullifierRegistryV2.getWriters(), [restored.manifest.contracts.UnifiedPaymentVerifierV4.address]);
    assert.deepEqual(await f.deployed.DisputeNullifierRegistry.getWriters(), [...f.config.retainedDisputeWriters, restored.manifest.contracts.DisputeProtectionPolicyV2.address]);
    assert.equal(await f.deployed.OrchestratorV3.lifecycleHook(), f.config.predecessorHook);
    const finalNonce = await wallet.getTransactionCount();
    await activate(hre, restored); assert.equal(await wallet.getTransactionCount(), finalNonce);
    await verifySuite(hre, restored, true);
    assert.equal(restored.manifest.verification.active, true);
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
    const originalHash = JSON.parse(readFileSync(`${f.path}.pending`)).hash;
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
    const vault = await hre.ethers.getContractAt("StakeVaultV2", f.manifest.contracts.StakeVaultV2.address);
    assert.equal(await vault.owner(), wallet.address); assert.equal(await vault.pendingOwner(), other);
    await assert.rejects(activate(hre, f.journal), /staging-only/);
    assert.equal(await f.deployed.OrchestratorRegistry.isOrchestrator(o4.address), false);
    assert.notEqual(f.manifest.contracts.WhitelistPolicyV2.address, constants.AddressZero);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
