require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { constants, utils } = require("ethers");
const hre = require("hardhat");
const { NEW_CONTRACTS } = require("./deploy-orchestrator-v4.ts");
const {
  buildO4SafeCalls, decodeO4SafeBatch, encodeO4SafeCall, O4SafeBatchKind: Kind,
  O4SafeContract: Contract, O4SafeFunction: Fn, O4_SAFE_BATCH_FILES, O4_MULTI_SEND_CANDIDATES,
  o4SafeTransactions, renderO4SafeBatch, serializeO4SafeBatch, serializeO4SafeBatchSidecar,
} = require("../deployments/orchestratorV4SafeBatches.ts");
const { BASE_SAFE, buildSafeTransaction, safeTransactionHash, encodeMultiSendCalldata } = require("./proposeSafeBatchChunks.ts");
const { writeO4Artifacts, verifyO4Artifacts, parseO4SafeBatchArgs, assertO4ForkEnvironment, assertO4PaymentWriters, resetO4BaseFork, simulateO4SafeBatches } = require("./orchestrator-v4-safe-batches.ts");

const UPV3 = "0x" + "ab".repeat(20), UPV4 = "0x" + "cd".repeat(20), EXTRA_WRITER = "0x" + "ef".repeat(20);
for (const before of [[UPV4], [UPV3, UPV4]]) test(`payment writers preserve ${before.length === 1 ? "UPV4 alone" : "UPV3 and UPV4"} regardless of order or address case`, () => {
  const actual = [...before].reverse().map((address) => utils.getAddress(address));
  assert.doesNotThrow(() => assertO4PaymentWriters(actual, before, UPV3, UPV4));
});

for (const [name, actual, before] of [
  ["removing UPV3", [UPV4], [UPV3, UPV4]],
  ["adding UPV3", [UPV3, UPV4], [UPV4]],
  ["adding another writer", [UPV4, EXTRA_WRITER], [UPV4]],
]) test(`payment writers reject ${name} after the pre-activation snapshot`, () => {
  assert.throws(() => assertO4PaymentWriters(actual, before, UPV3, UPV4), /Payment nullifier writers changed/);
});

for (const [name, writers] of [
  ["an extra writer", [UPV3, UPV4, EXTRA_WRITER]],
  ["missing UPV4", [UPV3]],
  ["an empty set", []],
]) test(`payment writers reject an unchanged pre-activation set with ${name}`, () => {
  assert.throws(() => assertO4PaymentWriters(writers, writers, UPV3, UPV4), /Unexpected pre-activation payment nullifier writers/);
});

async function fixture(routes = false) {
  const configuration = JSON.parse(readFileSync("deployments/orchestrator-v4/base.json", "utf8"));
  const contracts = {};
  for (const [index, [name, artifact]] of Object.entries(NEW_CONTRACTS).filter(([name]) => name !== "UnifiedPaymentVerifierV4").entries()) {
    contracts[name] = { address: utils.getAddress(utils.hexZeroPad(utils.hexlify(index + 100), 20)), artifact, constructorArguments: [], transactionHash: utils.id(`${name} deployment`), runtimeCodeHash: utils.id(`${name} runtime`), deploymentBlock: 100 };
  }
  const m = { version: 1, sourceCommit: "a".repeat(40), configurationHash: "fixture", configuration, contracts, transactions: [], verification: { active: false }, governancePreparedAt: { blockNumber: 101, blockHash: utils.id("prepared block"), timestamp: 1793260000 }, governanceTransactions: [] };
  async function append(step, to, artifact, fn, args) {
    const abi = new utils.Interface((await hre.artifacts.readArtifact(artifact)).abi);
    m.governanceTransactions.push({ step, to, data: abi.encodeFunctionData(fn, args), value: "0" });
  }
  await append("accept:StakeVaultV2", contracts.StakeVaultV2.address, "StakeVaultV2", "acceptOwnership", []);
  await append("accept:DisputeProtectionPolicyV2", contracts.DisputeProtectionPolicyV2.address, "DisputeProtectionPolicyV2", "acceptOwnership", []);
  await append("authorize-policy-writer", configuration.existing.DisputeNullifierRegistry.address, "NullifierRegistry", "addWritePermission", [contracts.DisputeProtectionPolicyV2.address]);
  if (routes) {
    for (const { method } of [...configuration.paymentMethods].reverse()) await append(`remove-route:${method}`, configuration.existing.PaymentVerifierRegistry.address, "PaymentVerifierRegistry", "removePaymentMethod", [method]);
    for (const { method, currencies } of configuration.paymentMethods) await append(`add-route:${method}`, configuration.existing.PaymentVerifierRegistry.address, "PaymentVerifierRegistry", "addPaymentMethod", [method, configuration.existing.UnifiedPaymentVerifierV4.address, currencies]);
  }
  await append("register-orchestrator", configuration.existing.OrchestratorRegistry.address, "OrchestratorRegistry", "addOrchestrator", [contracts.OrchestratorV4.address]);
  return m;
}

test("Base O4 activation is exactly four re-encoded calls, registration last, with decoded rows", async () => {
  const m = await fixture(), calls = buildO4SafeCalls(Kind.Activation, m), batch = renderO4SafeBatch(Kind.Activation, m);
  assert.deepEqual(calls.map(encodeO4SafeCall), m.governanceTransactions.map(({ step, ...tx }) => tx));
  assert.deepEqual(decodeO4SafeBatch(batch, m), [
    { index: 0, step: "accept:StakeVaultV2", to: m.contracts.StakeVaultV2.address, contract: Contract.StakeVaultV2, function: Fn.AcceptOwnership, args: [] },
    { index: 1, step: "accept:DisputeProtectionPolicyV2", to: m.contracts.DisputeProtectionPolicyV2.address, contract: Contract.DisputeProtectionPolicyV2, function: Fn.AcceptOwnership, args: [] },
    { index: 2, step: "authorize-policy-writer", to: "0xA845615b5203F7a21321DdF5e3a1ca024D93a443", contract: Contract.DisputeNullifierRegistry, function: Fn.AddWriter, args: [m.contracts.DisputeProtectionPolicyV2.address] },
    { index: 3, step: "register-orchestrator", to: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9", contract: Contract.OrchestratorRegistry, function: Fn.RegisterOrchestrator, args: [m.contracts.OrchestratorV4.address] },
  ]);
  assert.equal(batch.version, "1.0"); assert.equal(batch.chainId, "8453");
  assert.equal(batch.createdAt, 1793260000000); assert.equal(batch.meta.txBuilderVersion, "1.16.5");
  assert.equal(batch.meta.createdFromSafeAddress, BASE_SAFE); assert.equal(batch.meta.createdFromOwnerAddress, "");
  for (const tx of batch.transactions) { assert.equal(tx.contractMethod, null); assert.equal(tx.contractInputsValues, null); }
  for (const text of ["4 calls", m.sourceCommit, "Prepared block 101", m.contracts.OrchestratorV4.address, m.contracts.DisputeProtectionPolicyV2.address, m.contracts.StakeVaultV2.address, "O3 stays registered", "UPV3 writer is NOT revoked"]) assert.ok(batch.meta.description.includes(text));
});

test("route rebuild removes the entire catalog in reverse and adds it in order to adopted UPV4", async () => {
  const m = await fixture(true), calls = buildO4SafeCalls(Kind.Activation, m), methods = m.configuration.paymentMethods;
  assert.equal(calls.length, 4 + 2 * methods.length);
  assert.deepEqual(calls.map(encodeO4SafeCall), m.governanceTransactions.map(({ step, ...tx }) => tx));
  assert.deepEqual(calls.slice(3, 3 + methods.length).map((c) => c.args), [...methods].reverse().map(({ method }) => [method]));
  assert.deepEqual(calls.slice(3 + methods.length, -1).map((c) => c.args), methods.map(({ method, currencies }) => [method, m.configuration.existing.UnifiedPaymentVerifierV4.address, currencies]));
  assert.equal(decodeO4SafeBatch(renderO4SafeBatch(Kind.Activation, m), m).length, calls.length);
});

for (const [name, mutate, expected] of [
  ["retire-payment-writer", (m) => { m.governanceTransactions[2].step = "retire-payment-writer"; }, /step\/order/],
  ["authorize-payment-writer", (m) => { m.governanceTransactions[2].step = "authorize-payment-writer"; }, /step\/order/],
  ["unknown step", (m) => { m.governanceTransactions[2].step = "unknown"; }, /step\/order/],
  ["duplicate step", (m) => { m.governanceTransactions.splice(2, 0, m.governanceTransactions[0]); }, /count/],
  ["duplicate with same count", (m) => { m.governanceTransactions[1] = m.governanceTransactions[0]; }, /step\/order/],
  ["registration before writer", (m) => { [m.governanceTransactions[2], m.governanceTransactions[3]] = [m.governanceTransactions[3], m.governanceTransactions[2]]; }, /step\/order/],
  ["missing acceptance", (m) => { m.governanceTransactions.shift(); }, /count/],
  ["wrong target", (m) => { m.governanceTransactions[2].to = m.configuration.existing.NullifierRegistryV2.address; }, /target/],
  ["tampered calldata argument", (m) => { m.governanceTransactions[2].data = new utils.Interface([`function ${Fn.AddWriter}`]).encodeFunctionData(Fn.AddWriter, [BASE_SAFE]); }, /calldata/],
  ["trailing calldata", (m) => { m.governanceTransactions[0].data += "00"; }, /calldata/],
  ["removeWritePermission", (m) => { m.governanceTransactions[2].data = new utils.Interface(["function removeWritePermission(address)"]).encodeFunctionData("removeWritePermission", [m.contracts.DisputeProtectionPolicyV2.address]); }, /calldata/],
  ["non-zero value", (m) => { m.governanceTransactions[0].value = "1"; }, /value/],
  ["wrong Safe", (m) => { m.configuration.governance = m.configuration.signer; }, /Base Safe/],
  ["wrong chain", (m) => { m.configuration.chainId = 31337; }, /chainId/],
  ["wrong environment", (m) => { m.configuration.environment = "other"; }, /configuration/],
  ["active manifest", (m) => { m.verification.active = true; }, /already active/],
  ["missing preparation", (m) => { delete m.governancePreparedAt; }, /governancePreparedAt/],
  ["missing timestamp", (m) => { delete m.governancePreparedAt.timestamp; }, /timestamp/],
  ["wrong adopted pin", (m) => { m.configuration.existing.UnifiedPaymentVerifierV4.address = BASE_SAFE; }, /pin mismatch/],
]) test(`rejects ${name}`, async () => {
  const m = await fixture(); mutate(m);
  assert.throws(() => buildO4SafeCalls(Kind.Activation, m), expected);
});

test("requires all seven deployed records for both batch kinds", async () => {
  for (const name of Object.keys((await fixture()).contracts)) for (const kind of Object.values(Kind)) {
    const m = await fixture(); delete m.contracts[name];
    assert.throws(() => buildO4SafeCalls(kind, m), new RegExp(`Missing deployed ${name}`));
  }
});

test("rejects partial, interleaved or reversed route rebuilds and altered currencies or verifier", async () => {
  for (const mutate of [
    (m) => m.governanceTransactions.splice(3, 1),
    (m) => { const n = m.configuration.paymentMethods.length; [m.governanceTransactions[3], m.governanceTransactions[3 + n]] = [m.governanceTransactions[3 + n], m.governanceTransactions[3]]; },
    (m) => m.governanceTransactions.splice(3, m.configuration.paymentMethods.length, ...m.governanceTransactions.slice(3, 3 + m.configuration.paymentMethods.length).reverse()),
    (m) => { const i = 3 + m.configuration.paymentMethods.length, { method, currencies } = m.configuration.paymentMethods[0]; m.governanceTransactions[i].data = new utils.Interface([`function ${Fn.AddMethod}`]).encodeFunctionData(Fn.AddMethod, [method, m.configuration.existing.UnifiedPaymentVerifierV3.address, currencies]); },
    (m) => { const i = 3 + m.configuration.paymentMethods.length, { method } = m.configuration.paymentMethods[0]; m.governanceTransactions[i].data = new utils.Interface([`function ${Fn.AddMethod}`]).encodeFunctionData(Fn.AddMethod, [method, m.configuration.existing.UnifiedPaymentVerifierV4.address, [utils.id("WRONG")]]); },
  ]) {
    const m = await fixture(true); mutate(m);
    assert.throws(() => buildO4SafeCalls(Kind.Activation, m), /count|step\/order|calldata/);
  }
});

test("rollback contains only O4.pauseOrchestrator", async () => {
  const m = await fixture(), batch = renderO4SafeBatch(Kind.Rollback, m);
  const abi = new utils.Interface((await hre.artifacts.readArtifact("OrchestratorV4")).abi);
  assert.deepEqual(batch.transactions, [{ to: m.contracts.OrchestratorV4.address, value: "0", data: abi.encodeFunctionData("pauseOrchestrator"), contractMethod: null, contractInputsValues: null }]);
  assert.deepEqual(decodeO4SafeBatch(batch, m), [{ index: 0, step: "pause-orchestrator", to: m.contracts.OrchestratorV4.address, contract: Contract.OrchestratorV4, function: Fn.PauseOrchestrator, args: [] }]);
  assert.match(batch.meta.description, /1 call.*Pauses O4 only/);
});

test("decoder rejects a batch that differs from the manifest", async () => {
  const m = await fixture();
  for (const mutate of [
    (b) => { b.chainId = "1"; }, (b) => { b.meta.createdFromSafeAddress = constants.AddressZero; },
    (b) => { b.transactions[0].data += "00"; }, (b) => { b.transactions[0].contractMethod = {}; },
    (b) => { b.meta.name = "other"; }, (b) => { b.transactions.reverse(); },
  ]) { const b = renderO4SafeBatch(Kind.Activation, m); mutate(b); assert.throws(() => decodeO4SafeBatch(b, m), /differs|Unknown/); }
});

test("serialization and sha256 sidecars are deterministic", async () => {
  const m = await fixture();
  for (const kind of Object.values(Kind)) {
    const contents = serializeO4SafeBatch(renderO4SafeBatch(kind, m));
    assert.equal(contents, serializeO4SafeBatch(renderO4SafeBatch(kind, JSON.parse(JSON.stringify(m)))));
    assert.ok(contents.endsWith("\n"));
    const sidecar = serializeO4SafeBatchSidecar(O4_SAFE_BATCH_FILES[kind], contents);
    assert.equal(sidecar, JSON.stringify({ file: O4_SAFE_BATCH_FILES[kind], sha256: createHash("sha256").update(contents).digest("hex") }, null, 2) + "\n");
  }
});

test("both MultiSend candidates and direct rollback use the expected SafeTx fields and existing hash implementation", async () => {
  const m = await fixture();
  assert.deepEqual(O4_MULTI_SEND_CANDIDATES, ["0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", "0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B"]);
  for (const kind of Object.values(Kind)) {
    const nonce = kind === Kind.Activation ? 87 : 88, calls = buildO4SafeCalls(kind, m);
    const encoded = calls.map((call) => ({ ...encodeO4SafeCall(call), operation: 0 }));
    const candidates = o4SafeTransactions(kind, calls, nonce);
    assert.equal(candidates.length, kind === Kind.Activation ? 2 : 3);
    const expected = buildSafeTransaction(encoded, nonce);
    assert.deepEqual(expected, { to: O4_MULTI_SEND_CANDIDATES[0], value: "0", data: encodeMultiSendCalldata(encoded), operation: 1, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: constants.AddressZero, refundReceiver: constants.AddressZero, nonce });
    for (const [index, to] of O4_MULTI_SEND_CANDIDATES.entries()) {
      assert.deepEqual(candidates[index], { kind, safeTx: { ...expected, to }, safeTxHash: safeTransactionHash({ ...expected, to }) });
    }
    if (kind === Kind.Rollback) {
      const direct = { ...expected, ...encoded[0], operation: 0 };
      assert.deepEqual(candidates[2], { kind, safeTx: direct, safeTxHash: safeTransactionHash(direct) });
    }
    assert.equal(new Set(candidates.map((c) => c.safeTxHash)).size, candidates.length);
    assert.notEqual(candidates[0].safeTxHash, o4SafeTransactions(kind, calls, nonce + 1)[0].safeTxHash);
  }
});

test("verify rejects byte mismatches in either artifact; render archives superseded pairs", async () => {
  const m = await fixture(), directory = mkdtempSync(join(tmpdir(), "o4-safe-artifacts-"));
  try {
    writeO4Artifacts(m, directory); verifyO4Artifacts(m, directory); writeO4Artifacts(m, directory);
    assert.equal(readdirSync(directory).length, 4);
    for (const suffix of [".json", ".sha256.json"]) {
      const file = join(directory, `base_o4_activation${suffix}`), bytes = readFileSync(file, "utf8");
      writeFileSync(file, bytes + " ");
      assert.throws(() => verifyO4Artifacts(m, directory), /bytes differ from fresh render/);
      writeFileSync(file, bytes);
    }
    m.governancePreparedAt.timestamp++;
    assert.throws(() => verifyO4Artifacts(m, directory), /bytes differ/);
    writeO4Artifacts(m, directory); verifyO4Artifacts(m, directory);
    assert.equal(readdirSync(join(directory, "superseded")).length, 4);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("CLI accepts only the three commands and an explicit canonical nonnegative nonce", () => {
  for (const command of ["render", "verify", "simulate"]) assert.deepEqual(parseO4SafeBatchArgs([command, "--safe-nonce", "87"]), { command, safeNonce: 87 });
  for (const args of [[], ["propose", "--safe-nonce", "87"], ["render"], ["render", "--safe-nonce", "87", "--sign"], ...["-1", "1.1", "01", " 1", "1e2", "9007199254740991"].map((n) => ["verify", "--safe-nonce", n])]) assert.throws(() => parseO4SafeBatchArgs(args), /Usage:/);
});

test("fork guards refuse missing RPC, wrong network or config before provider interaction", async () => {
  const env = { HARDHAT_CONFIG: "hardhat.base-fork.config.ts", HARDHAT_NETWORK: "hardhat", BASE_FORK_RPC_URL: "http://fixture.invalid" };
  assert.doesNotThrow(() => assertO4ForkEnvironment(env));
  for (const patch of [{ BASE_FORK_RPC_URL: "" }, { HARDHAT_NETWORK: "base" }, { HARDHAT_CONFIG: "hardhat.canonical.config.ts" }]) assert.throws(() => assertO4ForkEnvironment({ ...env, ...patch }), /requires|required/);
  // The CI config is canonical, never the fork config, so these fail before touching the provider.
  await assert.rejects(resetO4BaseFork(hre), /requires/);
  await assert.rejects(simulateO4SafeBatches(hre, await fixture(), 87), /requires/);
});

test("Base fork config preserves canonical fixture accounts and clears remote accounts", () => {
  const directory = mkdtempSync(join(tmpdir(), "o4-fork-config-")), root = resolve(__dirname, "..");
  try {
    const result = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register/transpile-only"), "-e",
      `const h=require(${JSON.stringify(require.resolve("hardhat"))}); console.log(JSON.stringify({chainId:h.network.config.chainId,accounts:h.network.config.accounts,remote:Object.entries(h.config.networks).filter(([n])=>n!=="hardhat").map(([n,c])=>c.accounts)}))`],
    { cwd: directory, env: { PATH: process.env.PATH, TS_NODE_PROJECT: join(root, "tsconfig.json"), HARDHAT_CONFIG: join(root, "hardhat.base-fork.config.ts"), HARDHAT_NETWORK: "hardhat" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.chainId, 8453); assert.equal(config.accounts.mnemonic, "test test test test test test test test test test test junk");
    assert.ok(config.remote.every((accounts) => Array.isArray(accounts) && accounts.length === 0));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
