#!/usr/bin/env node
require(require.resolve("ts-node/register/transpile-only"));
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { constants, utils } = require("ethers");
const { UPV4_BASE_RELEASE, UPV5_BASE_RELEASE } = require("../deployments/parameters.ts");
const { Upv5Function: Fn, Upv5Target: Target, buildUpv5CutoverCalls, encodeUpv5Call } = require("../deployments/upv5Cutover.ts");
const {
  UPV5_BASE_SAFE_BATCH_FILE, assertUpv5SafeBatch, baseUpv5CutoverInput, decodeUpv5SafeBatch, renderUpv5SafeBatch,
  serializeUpv5SafeBatch, serializeUpv5SafeBatchSidecar,
} = require("../deployments/upv5SafeBatch.ts");

const ROOT = resolve(__dirname, "..");
const SAFE = "0x0bC26FF515411396DD588Abd6Ef6846E04470227";
const UPV3 = "0xC6F4a193576C60892a47e111Bb5706c30162502B";
const UPV4 = "0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048";
const PVR = "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e";
const NRV2 = "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB";
const DPP = "0xB49Fa38C6Bb3C8C51ddb13711BB213cDD9DB1799";
// Placeholders until lane 49 records the Base deployment.
const DEPLOYED = {
  nullifierRegistryV3: "0x3000000000000000000000000000000000000003",
  unifiedPaymentVerifierV5: "0x5000000000000000000000000000000000000005",
  disputeVerifierV2: "0x2000000000000000000000000000000000000002",
};
const CREATED_AT = 1795000000000;
const ROUTES = UPV4_BASE_RELEASE.paymentRoutes;
const METHODS = ROUTES.map((route) => utils.id(route.method));
const ABI = new utils.Interface(Object.values(Fn).map((signature) => `function ${signature}`));
const input = () => baseUpv5CutoverInput(DEPLOYED);
const render = () => renderUpv5SafeBatch(input(), SAFE, CREATED_AT);
const clone = (value) => JSON.parse(JSON.stringify(value));

test("the Base batch is one atomic transaction of exactly 30 calls in a fixed order", () => {
  const calls = buildUpv5CutoverCalls(input());
  assert.equal(calls.length, 30);
  assert.deepEqual(calls.slice(0, 3).map((call) => [call.to, call.target, call.signature, call.args]), [
    [NRV2, Target.NullifierRegistryV2, Fn.RemoveWriter, [UPV3]],
    [NRV2, Target.NullifierRegistryV2, Fn.RemoveWriter, [UPV4]],
    [DEPLOYED.nullifierRegistryV3, Target.NullifierRegistryV3, Fn.AddWriter, [DEPLOYED.unifiedPaymentVerifierV5]],
  ]);
  for (let index = 0; index < 13; index++) {
    const removal = calls[3 + index];
    assert.deepEqual([removal.to, removal.signature, removal.args], [PVR, Fn.RemoveMethod, [METHODS[12 - index]]]);
    const addition = calls[16 + index];
    assert.deepEqual([addition.to, addition.signature, addition.args],
      [PVR, Fn.AddMethod, [METHODS[index], DEPLOYED.unifiedPaymentVerifierV5, ROUTES[index].currencies.map(utils.id)]]);
  }
  assert.deepEqual([calls[29].to, calls[29].signature, calls[29].args], [DPP, Fn.SetDisputeVerifier, [DEPLOYED.disputeVerifierV2]]);
  assert.equal(ROUTES.length, 13);
  assert.deepEqual(input().retiredWriters, [UPV3, UPV4]);
  assert.equal(input().paymentVerifierRegistry, PVR);
  assert.equal(input().disputeProtectionPolicyV2, DPP);
  assert.equal(UPV5_BASE_RELEASE.governance, SAFE);
});

test("the batch never touches the legacy August dispute policies or any other contract", () => {
  const legacy = ["DisputeProtectionPolicy", "DisputeProtectionPolicyOptIn", "DisputeProtectionPolicyMethodScoped",
    "DisputeProtectionPolicyMethodScopedStaked"].map((name) =>
    JSON.parse(readFileSync(resolve(ROOT, "deployments/base", `${name}.json`), "utf8")).address.toLowerCase());
  const targets = new Set(render().transactions.map((transaction) => transaction.to.toLowerCase()));
  for (const address of legacy) assert.equal(targets.has(address), false, address);
  // DisputeVerifierV2 is constructed owned by the Safe, so the batch never calls it.
  assert.deepEqual([...targets].sort(), [NRV2, DEPLOYED.nullifierRegistryV3, PVR, DPP]
    .map((address) => address.toLowerCase()).sort());
});

function swapAndPop(values, value) {
  const index = values.indexOf(value);
  assert.notEqual(index, -1);
  values[index] = values[values.length - 1];
  values.pop();
}

test("under real swap-and-pop removal the batch keeps PVR order and currencies and swaps every writer", () => {
  const methods = [...METHODS];
  const store = new Map(ROUTES.map((route) => [utils.id(route.method), { verifier: UPV4, currencies: route.currencies.map(utils.id) }]));
  const nrv2 = new Set([UPV3, UPV4]);
  const nrv3 = new Set();
  let disputeVerifier = UPV5_BASE_RELEASE.disputeVerifier;
  for (const call of buildUpv5CutoverCalls(input())) {
    const { name, args } = ABI.parseTransaction(encodeUpv5Call(call));
    if (name === "removeWritePermission") assert.equal(nrv2.delete(args[0]), true);
    else if (name === "addWritePermission") nrv3.add(args[0]);
    else if (name === "setDisputeVerifier") disputeVerifier = args[0];
    else if (name === "removePaymentMethod") {
      assert.ok(store.delete(args[0]));
      swapAndPop(methods, args[0]);
      assert.deepEqual(methods, METHODS.slice(0, methods.length), "tail removal never reorders");
    } else {
      assert.equal(store.has(args[0]), false);
      store.set(args[0], { verifier: args[1], currencies: [...args[2]] });
      methods.push(args[0]);
    }
  }
  assert.deepEqual(methods, METHODS);
  ROUTES.forEach((route) => assert.deepEqual(store.get(utils.id(route.method)),
    { verifier: DEPLOYED.unifiedPaymentVerifierV5, currencies: route.currencies.map(utils.id) }));
  assert.deepEqual([...nrv2], []);
  assert.deepEqual([...nrv3], [DEPLOYED.unifiedPaymentVerifierV5]);
  assert.equal(disputeVerifier, DEPLOYED.disputeVerifierV2);
});

test("render shape, serialization and sidecar are deterministic", () => {
  const batch = render();
  assert.deepEqual(Object.keys(batch), ["version", "chainId", "createdAt", "meta", "transactions"]);
  assert.equal(batch.chainId, "8453");
  assert.equal(batch.createdAt, CREATED_AT);
  assert.deepEqual({ ...batch.meta, description: undefined }, {
    name: "Base UPV5 cutover", description: undefined, txBuilderVersion: "1.16.5",
    createdFromSafeAddress: SAFE, createdFromOwnerAddress: "",
  });
  assert.match(batch.meta.description, /^30 calls\. UPV5 0x5000000000000000000000000000000000000005; NullifierRegistryV3 0x3000000000000000000000000000000000000003; DisputeVerifierV2 0x2000000000000000000000000000000000000002\. One-way/);
  assert.ok(batch.transactions.every((transaction) => transaction.value === "0" &&
    transaction.contractMethod === null && transaction.contractInputsValues === null));
  assert.equal(batch.transactions[0].data.slice(0, 10), utils.id(Fn.RemoveWriter).slice(0, 10));
  const contents = serializeUpv5SafeBatch(batch);
  assert.equal(contents, serializeUpv5SafeBatch(render()));
  assert.ok(contents.endsWith("}\n"));
  const sidecar = JSON.parse(serializeUpv5SafeBatchSidecar(UPV5_BASE_SAFE_BATCH_FILE, contents));
  assert.deepEqual(sidecar, {
    file: "base_upv5_cutover.json", sha256: require("node:crypto").createHash("sha256").update(contents).digest("hex"),
  });
  assert.throws(() => renderUpv5SafeBatch(input(), SAFE, -1), /createdAt: invalid/);
  assert.throws(() => renderUpv5SafeBatch(input(), constants.AddressZero, CREATED_AT), /safe: invalid or zero address/);
});

test("decoder labels every row and rejects unsafe targets, calldata, values and metadata", () => {
  const rows = decodeUpv5SafeBatch(render(), input(), SAFE);
  assert.deepEqual(rows[0], { index: 0, to: NRV2, target: Target.NullifierRegistryV2, function: "removeWritePermission", writer: UPV3 });
  assert.deepEqual(rows[3], { index: 3, to: PVR, target: Target.PaymentVerifierRegistry, function: "removePaymentMethod", paymentMethod: "monobank" });
  assert.deepEqual(rows[16].currencies, ["CNY"]);
  assert.equal(rows[16].paymentMethod, "alipay");
  assert.equal(rows[29].disputeVerifier, DEPLOYED.disputeVerifierV2);
  const legacyPolicy = JSON.parse(readFileSync(resolve(ROOT, "deployments/base/DisputeProtectionPolicyOptIn.json"), "utf8")).address;
  const cases = [
    [(batch) => { batch.transactions[29].to = legacyPolicy; }, /transaction\[29\].to: unknown target/],
    [(batch) => { batch.transactions[29].to = DEPLOYED.disputeVerifierV2; }, /transaction\[29\].to: unknown target/],
    [(batch) => { batch.transactions[1].data = "0xdeadbeef"; }, /unknown selector/],
    [(batch) => { batch.transactions[1].data += "00"; }, /trailing calldata/],
    [(batch) => { batch.transactions[1].to = PVR; }, /unknown selector/],
    [(batch) => { batch.transactions[1].value = "1"; }, /value: expected 0/],
    [(batch) => { batch.transactions[1].contractMethod = {}; }, /expected null/],
    [(batch) => { batch.chainId = "1"; }, /chainId: mismatch/],
    [(batch) => { batch.meta.createdFromSafeAddress = UPV4; }, /safe: mismatch/],
  ];
  for (const [mutate, error] of cases) {
    const batch = render();
    mutate(batch);
    assert.throws(() => decodeUpv5SafeBatch(batch, input(), SAFE), error);
  }
});

test("assertion reports the first changed call, verifier, writer, policy or count", () => {
  const cases = [
    [(batch) => { [batch.transactions[3], batch.transactions[4]] = [batch.transactions[4], batch.transactions[3]]; },
      /transaction\[3\].paymentMethod: expected "monobank", got "xmoney"/],
    [(batch) => { batch.transactions[16].data = ABI.encodeFunctionData(Fn.AddMethod, [METHODS[0], UPV4, [utils.id("CNY")]]); },
      /transaction\[16\].verifier: expected/],
    [(batch) => { batch.transactions[16].data = ABI.encodeFunctionData(Fn.AddMethod, [METHODS[0], DEPLOYED.unifiedPaymentVerifierV5, [utils.id("USD")]]); },
      /transaction\[16\].currencies: expected \["CNY"\]/],
    [(batch) => { batch.transactions[1].data = ABI.encodeFunctionData(Fn.RemoveWriter, [DEPLOYED.unifiedPaymentVerifierV5]); },
      /transaction\[1\].writer: expected/],
    [(batch) => { batch.transactions[29].data = ABI.encodeFunctionData(Fn.SetDisputeVerifier, [UPV5_BASE_RELEASE.disputeVerifier]); },
      /transaction\[29\].disputeVerifier: expected/],
    [(batch) => { batch.transactions.shift(); }, /call count: expected 30, got 29/],
  ];
  for (const [mutate, error] of cases) {
    const batch = render();
    mutate(batch);
    assert.throws(() => assertUpv5SafeBatch(batch, input(), SAFE), error);
  }
  assertUpv5SafeBatch(render(), input(), SAFE);
});

test("the Safe transaction wraps the calls in one MultiSendCallOnly delegatecall", () => {
  const { buildSafeTransaction, safeTransactionHash } = require("./proposeSafeBatchChunks.ts");
  const calls = buildUpv5CutoverCalls(input()).map((call) => ({ ...encodeUpv5Call(call), operation: 0 }));
  const transaction = buildSafeTransaction(calls, 100);
  assert.equal(transaction.to, "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D");
  assert.equal(transaction.operation, 1);
  assert.match(safeTransactionHash(transaction), /^0x[0-9a-f]{64}$/);
  assert.notEqual(safeTransactionHash(transaction), safeTransactionHash(buildSafeTransaction(calls, 101)));
});

test("preflight simulates the whole batch as one call from the Safe running MultiSendCallOnly's code", async () => {
  const { simulateBatchFromSafe } = require("./upv5SafeBatches.ts");
  const { buildSafeTransaction } = require("./proposeSafeBatchChunks.ts");
  const calls = buildUpv5CutoverCalls(input()).map(encodeUpv5Call);
  const requests = [];
  const provider = {
    getCode: async (address, blockTag) => { requests.push(["getCode", address, blockTag]); return "0x6001"; },
    send: async (method, params) => { requests.push([method, params]); return "0x"; },
  };
  await simulateBatchFromSafe(provider, calls, SAFE, 123);
  const multiSend = buildSafeTransaction(calls.map((call) => ({ ...call, operation: 0 })), 0);
  assert.deepEqual(requests, [
    ["getCode", "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", 123],
    ["eth_call", [{ from: UPV5_BASE_RELEASE.deployer, to: SAFE, data: multiSend.data }, "0x7b", { [SAFE]: { code: "0x6001" } }]],
  ]);
  provider.getCode = async () => "0x";
  await assert.rejects(simulateBatchFromSafe(provider, calls, SAFE, 123), /MultiSendCallOnly .* has no code/);
});

function cliFixture(context) {
  const root = mkdtempSync(resolve(tmpdir(), "upv5-batch-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["scripts", "deployments/base", "deployments/outputs/safe-batches"]) {
    mkdirSync(resolve(root, directory), { recursive: true });
  }
  symlinkSync(resolve(ROOT, "node_modules"), resolve(root, "node_modules"));
  symlinkSync(resolve(ROOT, "utils"), resolve(root, "utils"));
  for (const file of ["deployments/parameters.ts", "deployments/upv5Cutover.ts", "deployments/upv5SafeBatch.ts",
    "deployments/upv5Postconditions.ts", "deployments/safeArtifacts.ts", "scripts/proposeSafeBatchChunks.ts"]) {
    symlinkSync(resolve(ROOT, file), resolve(root, file));
  }
  const script = resolve(root, "scripts/upv5SafeBatches.ts");
  copyFileSync(resolve(ROOT, "scripts/upv5SafeBatches.ts"), script);
  const run = (args) => spawnSync(resolve(ROOT, "node_modules/.bin/ts-node"), ["--transpile-only", script, ...args],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, TS_NODE_PROJECT: resolve(ROOT, "tsconfig.json") } });
  const writeRecords = (records = DEPLOYED) => {
    for (const [name, address] of [["NullifierRegistryV3", records.nullifierRegistryV3],
      ["UnifiedPaymentVerifierV5", records.unifiedPaymentVerifierV5], ["DisputeVerifierV2", records.disputeVerifierV2]]) {
      writeFileSync(resolve(root, "deployments/base", `${name}.json`), JSON.stringify({ address }));
    }
  };
  const batchFile = resolve(root, "deployments/outputs/safe-batches", UPV5_BASE_SAFE_BATCH_FILE);
  return { root, run, writeRecords, batchFile };
}

test("CLI renders from the Base records, verifies byte for byte and prints the Safe hash", (context) => {
  const f = cliFixture(context);
  for (const command of [["write"], ["verify"], ["hash", "100"]]) {
    const missing = f.run(command);
    assert.equal(missing.status, 1, command.join(" "));
    assert.match(missing.stderr, /Base UPV5 deployment records missing|missing; run write first/);
  }
  writeFileSync(resolve(f.root, "deployments/base/NullifierRegistryV3.json"), JSON.stringify({ address: DEPLOYED.nullifierRegistryV3 }));
  assert.match(f.run(["write"]).stderr, /partial UPV5 deployment records/);
  f.writeRecords();
  const written = f.run(["write", "--created-at", String(CREATED_AT)]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(readFileSync(f.batchFile, "utf8"), serializeUpv5SafeBatch(render()));
  assert.equal(readFileSync(f.batchFile.replace(/\.json$/, ".sha256.json"), "utf8"),
    serializeUpv5SafeBatchSidecar(UPV5_BASE_SAFE_BATCH_FILE, serializeUpv5SafeBatch(render())));
  assert.match(written.stdout, /\| 0 \| NullifierRegistryV2 \(0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB\) \| removeWritePermission \| 0xC6F4a193576C60892a47e111Bb5706c30162502B \|/);
  const verified = f.run(["verify"]);
  assert.equal(verified.status, 0, verified.stderr);
  const hashed = f.run(["hash", "100"]);
  assert.equal(hashed.status, 0, hashed.stderr);
  assert.match(hashed.stdout, /nonce=100 calls=30/);
  assert.match(hashed.stdout, /MultiSend target=0x40A2aCCbd92BCA938b02010E17A5b8929b49130D operation=1 data keccak=0x[0-9a-f]{64} safeTxHash=0x[0-9a-f]{64}/);

  const batch = clone(render());
  [batch.transactions[3], batch.transactions[4]] = [batch.transactions[4], batch.transactions[3]];
  writeFileSync(f.batchFile, serializeUpv5SafeBatch(batch));
  const reordered = f.run(["verify"]);
  assert.equal(reordered.status, 1);
  assert.match(reordered.stderr, /transaction\[3\].paymentMethod/);
  writeFileSync(f.batchFile, serializeUpv5SafeBatch(render()).trimEnd());
  assert.match(f.run(["verify"]).stderr, /bytes differ from fresh render/);

  // A rewrite after a record change archives the previous pair instead of overwriting it silently.
  f.writeRecords({ ...DEPLOYED, disputeVerifierV2: "0x2000000000000000000000000000000000000022" });
  assert.equal(f.run(["write", "--created-at", String(CREATED_AT)]).status, 0);
  assert.equal(readdirSync(resolve(f.root, "deployments/outputs/safe-batches/superseded")).length, 2);
  assert.equal(existsSync(f.batchFile), true);
  assert.equal(f.run(["bogus"]).status, 1);
});
