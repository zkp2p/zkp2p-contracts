require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync, execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { BigNumber, constants, utils } = require("ethers");
const { CALLS, PLAN_HASH, HISTORICAL_OWNER, assertJournal, assertState, assertTransaction, reconcile, assertOperatorSource } = require("./handoff-staging-owner.ts");
const { assertReleaseProvenance } = require("./orchestrator-v4-provenance.ts");
const { assertLegacyIntentInventory, assertReleasedLegacyLock } = require("./deploy-orchestrator-v4.ts");

function transaction(index = 0) {
  return { ...CALLS[index], chainId: 8453, nonce: 60 + index, type: 2, gasLimit: BigNumber.from(80000), maxFeePerGas: BigNumber.from(6000000), maxPriorityFeePerGas: BigNumber.from(1000000) };
}
function journal(length = 0) {
  return { configuration: { chainId: 8453 }, planHash: PLAN_HASH, initialNonce: 60, transactions: CALLS.slice(0, length).map((call, i) => ({ ...call, nonce: 60 + i, hash: utils.id(call.step), receipt: null })) };
}
function state(completed = 0) {
  return { states: CALLS.map((_, i) => ({ owner: i >= 2 && i < 6 && i < completed ? "0x41123d6419C7b8e44157f6F3b0088442116641eC" : HISTORICAL_OWNER, completed: i < completed })), latestNonce: 60 + completed, pendingNonce: 60 + completed };
}

test("the fixed seven calls are two pauses, four transfers and one scoped relayer add", () => {
  assert.equal(CALLS.length, 7);
  assert.deepEqual(CALLS.slice(0, 2).map((c) => c.data), ["0x45a734b7", "0x45a734b7"]);
  assert.deepEqual(CALLS.slice(2, 6).map((c) => c.data), Array(4).fill("0xf2fde38b00000000000000000000000041123d6419c7b8e44157f6f3b0088442116641ec"));
  assert.equal(CALLS[6].data, "0xdd39f00d000000000000000000000000bc6ca58369853d77a9a2f33358334bf9e9b9094f");
  assert.ok(CALLS.every((c) => c.value === "0"));
  assertTransaction(transaction(), CALLS[0], 60);
  for (const drift of [{ chainId: 1 }, { nonce: 61 }, { value: "1" }, { to: CALLS[2].to }, { data: "0x" }, { gasLimit: 150001 }, { maxFeePerGas: 100000001 }])
    assert.throws(() => assertTransaction({ ...transaction(), ...drift }, CALLS[0], 60));
});

test("wrong apply confirmation rejects before RPC work and never prints the injected key", () => {
  const secret = "0x" + "11".repeat(32);
  const child = spawnSync(process.execPath, ["-r", "ts-node/register/transpile-only", "scripts/handoff-staging-owner.ts", "apply", "pause", "wrong"], { cwd: join(__dirname, ".."), env: { PATH: process.env.PATH, O4_HISTORICAL_OWNER_KEY: secret, BASE_RPC_URL: "http://127.0.0.1:1" }, encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /exact reviewed plan hash/);
  assert.ok(!child.stderr.includes(secret));
  assert.ok(!child.stderr.includes("127.0.0.1"));
});

test("resume rejects skipped calls, unjournaled state, foreign owners and consumed nonces", () => {
  assertJournal(journal(1));
  const skipped = journal(1); skipped.transactions[0] = { ...skipped.transactions[0], ...CALLS[2] };
  assert.throws(() => assertJournal(skipped), /contiguous/);
  assertState(state(), 0, 60, false);
  assertState({ ...state(), pendingNonce: 61 }, 0, 60, true);
  assert.throws(() => assertState({ ...state(), pendingNonce: 61 }, 0, 60, false), /unrelated pending/);
  assert.throws(() => assertState(state(1), 0, 60, false), /confirmed journal prefix/);
  assert.throws(() => assertState({ ...state(), latestNonce: 61 }, 0, 60, false), /consumed outside/);
  const foreign = state(); foreign.states[3].owner = constants.AddressZero;
  assert.throws(() => assertState(foreign, 0, 60, false), /Unexpected owner/);
});

test("receipt recovery reconciles the same transaction without a signer or broadcast", async () => {
  const pending = journal(1), hash = pending.transactions[0].hash;
  const receipt = { status: 1, blockHash: utils.id("sealed"), blockNumber: 100, transactionHash: hash, gasUsed: BigNumber.from(30000), effectiveGasPrice: BigNumber.from(5000000) };
  const provider = { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: receipt.blockHash }), getTransaction: async () => ({ ...transaction(), from: HISTORICAL_OWNER }) };
  assert.equal(await reconcile(provider, pending), 1);
  assert.equal(pending.transactions[0].receipt.transactionHash, hash);
  assertState(state(1), 1, 60, false);
  await assert.rejects(reconcile({ ...provider, getTransactionReceipt: async () => ({ ...receipt, blockHash: constants.HashZero }) }, pending), /not sealed/);
  await assert.rejects(reconcile({ ...provider, getTransaction: async () => ({ ...transaction(), from: constants.AddressZero }) }, pending), /sender/);
});

test("historical signal inventory rejects indexer-only absence, duplicates, foreign events and live intents", async () => {
  const historical = require("../deployments/base_staging/OrchestratorV4Historical20261016.json");
  const iface = new utils.Interface(historical.abi), hash = utils.id("actual intent fixture");
  const event = iface.encodeEventLog(iface.getEvent("IntentSignaled"), [hash, CALLS[0].to, 1, utils.id("venmo"), HISTORICAL_OWNER, HISTORICAL_OWNER, 1, utils.id("USD"), 1, 100]);
  const log = { ...event, address: historical.address, logIndex: 4 };
  const receipt = { status: 1, blockHash: utils.id("canonical"), blockNumber: 99, logs: [log] };
  const provider = { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: receipt.blockHash }) };
  const legacy = { address: historical.address, interface: iface, provider, getIntent: async () => ({ owner: constants.AddressZero }) };
  const refs = [{ transactionHash: utils.id("signal"), logIndex: 4 }];
  await assertLegacyIntentInventory(legacy, refs, "1", 100, 101);
  await assert.rejects(assertLegacyIntentInventory(legacy, [], "38", 100, 101), /full on-chain counter/);
  await assert.rejects(assertLegacyIntentInventory(legacy, [...refs, ...refs], "2", 100, 101), /Duplicate/);
  await assert.rejects(assertLegacyIntentInventory({ ...legacy, getIntent: async () => ({ owner: HISTORICAL_OWNER }) }, refs, "1", 100, 101), /remains open/);
  await assert.rejects(assertLegacyIntentInventory({ ...legacy, provider: { ...provider, getTransactionReceipt: async () => ({ ...receipt, logs: [{ ...log, address: constants.AddressZero }] }) } }, refs, "1", 100, 101), /expected event/);
  await assert.rejects(assertLegacyIntentInventory(legacy, refs, "1", 98, 101), /after pause/);
  await assert.rejects(assertLegacyIntentInventory({ ...legacy, provider: { ...provider, getBlock: async () => ({ hash: utils.id("reorg") }) } }, refs, "1", 100, 101), /not canonical/);
});

test("a residual V1 record requires its exact authentic unlock and a fully deleted escrow lock at both blocks", async () => {
  const record = require("../deployments/base_staging/Escrow.json"), iface = new utils.Interface(record.abi);
  const signal = { intentHash: utils.id("orphan"), depositId: BigNumber.from(3), amount: BigNumber.from(1000000) };
  const event = iface.encodeEventLog(iface.getEvent("FundsUnlocked"), [3, signal.intentHash, 1000000]);
  const receipt = { status: 1, blockHash: utils.id("sealed unlock"), blockNumber: 90, logs: [{ ...event, address: record.address, logIndex: 19 }] };
  const empty = { intentHash: constants.HashZero, amount: BigNumber.from(0), timestamp: BigNumber.from(0), expiryTime: BigNumber.from(0) };
  const escrow = { address: record.address, interface: iface, provider: { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: receipt.blockHash }) }, getDepositIntent: async () => empty, getDepositIntentHashes: async () => [] };
  const unlock = { transactionHash: utils.id("unlock"), logIndex: 19 };
  await assertReleasedLegacyLock(escrow, signal, unlock, 90, 18, 100, 101);
  await assert.rejects(assertReleasedLegacyLock(escrow, signal, undefined, 90, 18, 100, 101), /authenticated escrow unlock/);
  await assert.rejects(assertReleasedLegacyLock(escrow, { ...signal, depositId: BigNumber.from(4) }, unlock, 90, 18, 100, 101), /differs from the authentic signal/);
  await assert.rejects(assertReleasedLegacyLock({ ...escrow, getDepositIntent: async (_id, _hash, at) => at.blockTag === 100 ? { ...empty, amount: BigNumber.from(1) } : empty }, signal, unlock, 90, 18, 100, 101), /still has an intent lock/);
  await assert.rejects(assertReleasedLegacyLock({ ...escrow, getDepositIntentHashes: async () => [signal.intentHash] }, signal, unlock, 90, 18, 100, 101), /still has an intent lock/);
  await assert.rejects(assertReleasedLegacyLock(escrow, signal, unlock, 80, 18, 89, 101), /after pause/);
  await assert.rejects(assertReleasedLegacyLock(escrow, signal, unlock, 90, 20, 100, 101), /does not follow/);
  await assert.rejects(assertReleasedLegacyLock({ ...escrow, provider: { ...escrow.provider, getBlock: async () => ({ hash: utils.id("reorg") }) } }, signal, unlock, 90, 18, 100, 101), /not canonical/);
});

test("operator source cannot claim an untracked helper, dirty imported code or leak injected credentials to git", () => {
  const directory = mkdtempSync(join(tmpdir(), "o4-operator-source-")), previous = process.cwd(), oldPath = process.env.PATH;
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe", encoding: "utf8" }).trim();
  const paths = ["scripts/handoff-staging-owner.ts", "scripts/deploy-orchestrator-v4.ts", "scripts/canonical-receipts.ts", "scripts/orchestrator-v4-provenance.ts", "scripts/verify-orchestrator-v4-source.ts", "deployments/canonicalDeployment.ts", "deployments/orchestrator-v4/base_staging.json"];
  try {
    git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    for (const path of paths) { mkdirSync(join(directory, require("node:path").dirname(path)), { recursive: true }); writeFileSync(join(directory, path), "fixture"); }
    git("add", "deployments"); git("commit", "-m", "source before helper"); process.chdir(directory);
    assert.throws(() => assertOperatorSource());
    git("add", "scripts"); git("commit", "-m", "reviewed helper");
    const sha = git("rev-parse", "HEAD");
    assert.equal(assertOperatorSource(), sha);
    writeFileSync(join(directory, "scripts/verify-orchestrator-v4-source.ts"), "unreviewed import");
    assert.throws(() => assertOperatorSource()); git("restore", ".");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin/git"), `#!/bin/sh\n[ -z "\${O4_HISTORICAL_OWNER_KEY+x}" ] || exit 70\n[ -z "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET+x}" ] || exit 71\nexec '${realGit}' "$@"\n`, { mode: 0o700 });
    process.env.PATH = join(directory, "bin") + ":" + oldPath;
    process.env.O4_HISTORICAL_OWNER_KEY = "public-fixture-never-in-child";
    assert.equal(assertOperatorSource(), sha);
  } finally { delete process.env.O4_HISTORICAL_OWNER_KEY; process.env.PATH = oldPath; process.chdir(previous); rmSync(directory, { recursive: true, force: true }); }
});

test("tool-only upgrade needs an exact explicit revision while compiled source and dirty drift remain forbidden", () => {
  const directory = mkdtempSync(join(tmpdir(), "o4-provenance-")), previous = process.cwd();
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe", encoding: "utf8" }).trim();
  try {
    mkdirSync(join(directory, "scripts")); mkdirSync(join(directory, "contracts"));
    git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(directory, "scripts/deploy-orchestrator-v4.ts"), "original"); writeFileSync(join(directory, "contracts/Contract.sol"), "immutable");
    for (const wrapper of ["hardhat.readonly.config.ts", "hardhat.canonical.config.ts"]) writeFileSync(join(directory, wrapper), "reviewed execution wrapper");
    git("add", "."); git("commit", "-m", "deployed"); const source = git("rev-parse", "HEAD");
    writeFileSync(join(directory, "scripts/deploy-orchestrator-v4.ts"), "reviewed stronger drain"); git("add", "."); git("commit", "-m", "tool"); const tool = git("rev-parse", "HEAD");
    process.chdir(directory);
    assert.throws(() => assertReleaseProvenance(source, undefined, "base_staging"));
    assert.throws(() => assertReleaseProvenance(source, source, "base_staging"));
    assert.throws(() => assertReleaseProvenance(source, "0".repeat(40), "base_staging"));
    assertReleaseProvenance(source, tool, "base_staging");
    for (const wrapper of ["hardhat.readonly.config.ts", "hardhat.canonical.config.ts"]) {
      writeFileSync(join(directory, wrapper), "unreviewed runtime override");
      assert.throws(() => assertReleaseProvenance(source, tool, "base_staging"));
      git("restore", wrapper);
    }
    writeFileSync(join(directory, "scripts/deploy-orchestrator-v4.ts"), "unreviewed dirty change");
    assert.throws(() => assertReleaseProvenance(source, tool, "base_staging"));
    git("restore", "."); writeFileSync(join(directory, "contracts/Contract.sol"), "different deployed source"); git("add", "."); git("commit", "-m", "source drift");
    assert.throws(() => assertReleaseProvenance(source, git("rev-parse", "HEAD"), "base_staging"));
  } finally { process.chdir(previous); rmSync(directory, { recursive: true, force: true }); }
});
