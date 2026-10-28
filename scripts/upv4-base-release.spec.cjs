#!/usr/bin/env node
process.env.DEPLOY_TX_DELAY_MS = "0";
require(require.resolve("ts-node/register/transpile-only"));
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { ContractFactory, constants, utils } = require("ethers");
const { BASE_ACTIVE_PAYMENT_METHODS, MULTI_SIG, UPV4_BASE_RELEASE } = require("../deployments/parameters.ts");
const {
  Upv4SafeBatchKind: Kind, Upv4SafeContract: Contract, Upv4SafeFunction: Function,
  UPV4_SAFE_BATCH_FILES, baseCutoverConfig, buildUpv4SafeCalls, encodeUpv4SafeCall,
  renderUpv4SafeBatch, serializeUpv4SafeBatch, upv4SafeBatchSidecar,
  decodeUpv4SafeBatch, assertUpv4SafeBatch, buildUpv4ReleasePlan, formatUpv4PlanMarkdown,
} = require("../deployments/upv4BaseCutover.ts");

const ROOT = resolve(__dirname, "..");
const UPV4 = "0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048";
const OTHER_ADDRESS = "0x1000000000000000000000000000000000000001";
const OPTIONS = { createdAt: 1793210291000, sourceSha: "646898f2afa2d0e114a7f44e96fc6222aa1c7a91" };
const ABI = new utils.Interface(Object.values(Function).map((signature) => `function ${signature}`));
// Lane 31 imports Hardhat; keep an independent literal fixture instead of initializing HRE.
const EXPECTED_ROUTES = [
  { method: "alipay", currencies: ["CNY"] },
  { method: "chime", currencies: ["USD"] },
  { method: "venmo", currencies: ["USD"] },
  { method: "revolut", currencies: [
    "USD", "EUR", "GBP", "SGD", "NZD", "AUD", "CAD", "JPY", "HKD", "MXN", "SAR", "AED",
    "THB", "TRY", "PLN", "CHF", "ZAR", "CNY", "CZK", "DKK", "HUF", "NOK", "RON", "SEK",
  ] },
  { method: "cashapp", currencies: ["USD"] },
  { method: "wise", currencies: [
    "USD", "CNY", "EUR", "GBP", "AUD", "NZD", "CAD", "AED", "CHF", "ZAR", "SGD", "ILS",
    "HKD", "JPY", "PLN", "TRY", "IDR", "KES", "MYR", "MXN", "THB", "VND", "UGX", "CZK",
    "DKK", "HUF", "INR", "NOK", "PHP", "RON", "SEK",
  ] },
  { method: "mercadopago", currencies: ["ARS"] },
  { method: "zelle", currencies: ["USD"] },
  { method: "monzo", currencies: ["GBP"] },
  { method: "paypal", currencies: ["USD", "EUR", "GBP", "SGD", "NZD", "AUD", "CAD"] },
  { method: "upi", currencies: ["INR"] },
  { method: "xmoney", currencies: ["USD"] },
  { method: "monobank", currencies: ["UAH"] },
];
const EXPECTED_NAMES = EXPECTED_ROUTES.map((route) => route.method);
const EXPECTED_METHODS = EXPECTED_NAMES.map(utils.id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const render = (kind = Kind.Cutover) => renderUpv4SafeBatch(kind, baseCutoverConfig(), UPV4, OPTIONS);

test("pins the exact Base block, addresses, catalog order, currencies and endpoint hashes", () => {
  const { paymentRoutes, ...pins } = UPV4_BASE_RELEASE;
  assert.deepEqual(pins, {
    pinnedBlock: 53209611, chainId: 8453,
    deployer: "0x41123d6419C7b8e44157f6F3b0088442116641eC",
    safe: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    orchestratorRegistry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
    nullifierRegistryV2: "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB",
    multiAttestationVerifier: "0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5",
    paymentVerifierRegistry: "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e",
    unifiedPaymentVerifierV3: "0xC6F4a193576C60892a47e111Bb5706c30162502B",
    orchestratorV3: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
    unifiedPaymentVerifierV4: UPV4,
    deployment: {
      transactionHash: "0xa6fa3ce43ca5352460be4ce917709f17d60fda677fa48a1fbc6f081902dcf931",
      blockNumber: 53210472, blockTimestamp: 1793210291, deployerNonce: 117,
      ownershipTransferTransactionHash: "0xa9abe1334345ea502e059c769db50bc31153d229c8f05e85e01d5c1d8ff54ce6",
      ownershipTransferBlock: 53210497, sourceSha: OPTIONS.sourceSha,
    },
    cutoverSafeNonce: 86,
    cutoverSafeTxHash: "0xe22ba698b10018c270a658525412b5e9cd81db2a4f42f9dd58983b639a2f8c70",
  });
  assert.equal(pins.safe, MULTI_SIG.base);
  assert.deepEqual(paymentRoutes, EXPECTED_ROUTES);
  assert.deepEqual(paymentRoutes.map((route) => route.method), BASE_ACTIVE_PAYMENT_METHODS);
  assert.equal(paymentRoutes.length, 13);
  assert.equal(paymentRoutes.reduce((count, route) => count + route.currencies.length, 0), 72);
  const config = baseCutoverConfig();
  assert.equal(config.routes[0].method, "0xcac9daea62d7b89d75ac73af4ee14dcf25721012ae82b568c2ea5c808eaa04ff");
  assert.equal(config.routes[12].method, "0x1d966dbd6aeb8674d7c05174bd0ded7b56a798672bfb862ef20bbe8c2bbfce18");
  for (const value of Object.values(pins).filter((value) => typeof value === "string" && value.length === 42)) {
    assert.equal(utils.getAddress(value), value);
  }
  assert.equal(Object.keys(require.cache).some((file) => file.includes("/hardhat/")), false);
});

test("cutover matches the imported Safe transaction at nonce 86 without loading Hardhat", () => {
  const { buildSafeTransaction, safeTransactionHash } = require("./proposeSafeBatchChunks.ts");
  const calls = buildUpv4SafeCalls(Kind.Cutover, baseCutoverConfig(), UPV4).map(encodeUpv4SafeCall);
  const transaction = buildSafeTransaction(calls.map((call) => ({ ...call, operation: 0 })), 86);
  assert.equal(transaction.to, "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D");
  assert.equal(transaction.operation, 1);
  assert.equal(utils.hexDataLength(transaction.data), 6916);
  assert.equal(utils.keccak256(transaction.data), "0x6d61bafbe0947c6db17eec69fedd7b485062d712ee66c7cbb3dacd3575d9ae58");
  assert.equal(safeTransactionHash(transaction), "0xe22ba698b10018c270a658525412b5e9cd81db2a4f42f9dd58983b639a2f8c70");
  assert.equal(Object.keys(require.cache).some((file) => file.includes("/hardhat/")), false);
});

test("UPV4 release sources never reference the compromised deployer or its key", () => {
  for (const file of ["deploy/47_deploy_unified_payment_verifier_v4.ts", "deployments/upv4BaseCutover.ts", "scripts/upv4SafeBatches.ts"]) {
    assert.doesNotMatch(readFileSync(resolve(ROOT, file), "utf8"), /0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929|BASE_DEPLOY_PRIVATE_KEY/i, file);
  }
});

test("cutover has exactly one writer addition, reverse removals, and original-order UPV4 routes", () => {
  const config = baseCutoverConfig();
  const calls = buildUpv4SafeCalls(Kind.Cutover, config, UPV4);
  assert.equal(calls.length, 27);
  assert.deepEqual(calls[0], {
    to: config.nullifierRegistryV2, contract: Contract.NullifierRegistryV2,
    signature: Function.AddWriter, args: [UPV4], description: `addWritePermission(address): ${UPV4}`,
  });
  for (let index = 0; index < 13; index++) {
    const removal = calls[index + 1];
    assert.equal(removal.to, config.paymentVerifierRegistry);
    assert.equal(removal.contract, Contract.PaymentVerifierRegistry);
    assert.equal(removal.signature, Function.RemoveMethod);
    assert.deepEqual(removal.args, [EXPECTED_METHODS[12 - index]]);
    const addition = calls[index + 14];
    assert.equal(addition.to, config.paymentVerifierRegistry);
    assert.equal(addition.contract, Contract.PaymentVerifierRegistry);
    assert.equal(addition.signature, Function.AddMethod);
    assert.deepEqual(addition.args, [EXPECTED_METHODS[index], UPV4, EXPECTED_ROUTES[index].currencies.map(utils.id)]);
  }
  assert.equal(calls.some((call) => call.signature === Function.RemoveWriter), false);
});

test("writer removal is exactly the UPV3 revocation; rollback changes only routes", () => {
  const config = baseCutoverConfig();
  const calls = buildUpv4SafeCalls(Kind.Upv3WriterRemoval, config, UPV4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, config.nullifierRegistryV2);
  assert.equal(calls[0].contract, Contract.NullifierRegistryV2);
  assert.equal(calls[0].signature, Function.RemoveWriter);
  assert.deepEqual(calls[0].args, [config.unifiedPaymentVerifierV3]);
  const rollback = buildUpv4SafeCalls(Kind.Rollback, config, UPV4);
  assert.equal(rollback.length, 26);
  assert.ok(rollback.every((call) => call.contract === Contract.PaymentVerifierRegistry));
  assert.deepEqual(rollback.slice(0, 13).map((call) => call.args), [...EXPECTED_METHODS].reverse().map((method) => [method]));
  assert.ok(rollback.slice(0, 13).every((call) => call.signature === Function.RemoveMethod));
  assert.deepEqual(rollback.slice(13).map((call) => call.args), EXPECTED_ROUTES.map((route) => [
    utils.id(route.method), config.unifiedPaymentVerifierV3, route.currencies.map(utils.id),
  ]));
  assert.ok(rollback.slice(13).every((call) => call.signature === Function.AddMethod));
});

function swapAndPop(values, value) {
  const index = values.indexOf(value);
  assert.notEqual(index, -1);
  const last = values.length - 1;
  if (index !== last) values[index] = values[last];
  values.pop();
}

function registryModel() {
  const config = baseCutoverConfig();
  const methods = [...EXPECTED_METHODS];
  const store = new Map(config.routes.map((route) => [route.method, {
    verifier: config.unifiedPaymentVerifierV3, currencies: [...route.currencies],
    isCurrency: new Set(route.currencies),
  }]));
  const writers = new Set([config.unifiedPaymentVerifierV3]);
  function apply(encoded) {
    const { name, args } = ABI.parseTransaction(encoded);
    if (name === "addWritePermission") return writers.add(args[0]);
    if (name === "removeWritePermission") return writers.delete(args[0]);
    if (name === "removePaymentMethod") {
      const route = store.get(args[0]);
      assert.ok(route);
      // PVR clears each currency's mapping entry and swap-and-pops its array before deleting the config.
      for (const currency of [...route.currencies]) {
        assert.equal(route.isCurrency.delete(currency), true);
        swapAndPop(route.currencies, currency);
      }
      assert.equal(route.isCurrency.size, 0);
      store.delete(args[0]);
      swapAndPop(methods, args[0]);
    } else {
      assert.equal(name, "addPaymentMethod");
      assert.equal(store.has(args[0]), false);
      assert.notEqual(args[1], constants.AddressZero);
      assert.ok(args[2].length > 0);
      assert.equal(new Set(args[2]).size, args[2].length);
      store.set(args[0], { verifier: args[1], currencies: [...args[2]], isCurrency: new Set(args[2]) });
      methods.push(args[0]);
    }
  }
  return { methods, store, writers, apply };
}

test("encoded cutover and rollback preserve PVR order and currencies under real swap-and-pop semantics", () => {
  const config = baseCutoverConfig();
  const model = registryModel();
  for (const kind of [Kind.Cutover, Kind.Rollback]) {
    for (const call of buildUpv4SafeCalls(kind, config, UPV4)) {
      model.apply(encodeUpv4SafeCall(call));
      if (call.signature === Function.RemoveMethod) {
        assert.deepEqual(model.methods, EXPECTED_METHODS.slice(0, model.methods.length));
      }
    }
    assert.deepEqual(model.methods, EXPECTED_METHODS);
    config.routes.forEach((route) => {
      assert.deepEqual(model.store.get(route.method).currencies, route.currencies);
      assert.equal(model.store.get(route.method).verifier, kind === Kind.Cutover ? UPV4 : config.unifiedPaymentVerifierV3);
    });
    assert.deepEqual([...model.writers], [config.unifiedPaymentVerifierV3, UPV4]);
  }
});

test("forward removal scrambles the remaining order (re-adding everything still restores final order)", () => {
  const config = baseCutoverConfig();
  const model = registryModel();
  const calls = buildUpv4SafeCalls(Kind.Rollback, config, UPV4);
  const forward = calls.slice(0, 13).reverse();
  model.apply(encodeUpv4SafeCall(forward[0]));
  assert.deepEqual(model.methods, [EXPECTED_METHODS[12], ...EXPECTED_METHODS.slice(1, 12)]);
  assert.notDeepEqual(model.methods, EXPECTED_METHODS.slice(1));
  forward.slice(1).forEach((call) => model.apply(encodeUpv4SafeCall(call)));
  calls.slice(13).forEach((call) => model.apply(encodeUpv4SafeCall(call)));
  assert.deepEqual(model.methods, EXPECTED_METHODS);
});

test("decoder round-trips all kinds and supports local configs containing only hashes", () => {
  for (const kind of Object.values(Kind)) {
    const config = baseCutoverConfig();
    const batch = render(kind);
    assertUpv4SafeBatch(kind, batch, config, UPV4);
    const expected = clone(buildUpv4ReleasePlan().batches.find((entry) => entry.kind === kind).rows);
    for (const row of expected) {
      if (row.writer === "UnifiedPaymentVerifierV4") row.writer = UPV4;
      if (row.verifier === "UnifiedPaymentVerifierV4") row.verifier = UPV4;
    }
    assert.deepEqual(decodeUpv4SafeBatch(batch, config), expected);
  }
  const local = baseCutoverConfig();
  local.chainId = 31337;
  local.routes = [{ method: utils.id("local-method"), currencies: [utils.id("LOCAL")] }];
  const batch = renderUpv4SafeBatch(Kind.Cutover, local, UPV4, OPTIONS);
  assert.equal(batch.chainId, "31337");
  assertUpv4SafeBatch(Kind.Cutover, batch, local, UPV4);
  const rows = decodeUpv4SafeBatch(batch, local);
  assert.equal(rows[2].paymentMethod, utils.id("local-method"));
  assert.deepEqual(rows[2].currencies, [utils.id("LOCAL")]);
});

test("decoder rejects unsafe targets, calldata, values and metadata", () => {
  const cases = [
    [(batch) => { batch.transactions[0].to = UPV4; }, /transaction\[0\].to: unknown target/],
    [(batch) => { batch.transactions[0].data = "0xdeadbeef"; }, /unknown selector/],
    [(batch) => { batch.transactions[0].data += "00"; }, /trailing calldata/],
    [(batch) => { batch.transactions[0].data = batch.transactions[0].data.slice(0, -2); }, /invalid calldata/],
    [(batch) => { batch.transactions[0].to = baseCutoverConfig().paymentVerifierRegistry; }, /unknown selector/],
    [(batch) => { batch.transactions[0].value = "1"; }, /value: expected 0/],
    [(batch) => { batch.transactions[0].contractMethod = {}; }, /expected null/],
    [(batch) => { batch.transactions[0].contractInputsValues = {}; }, /expected null/],
    [(batch) => { delete batch.transactions[0].contractMethod; }, /expected null/],
    [(batch) => { batch.chainId = "1"; }, /chainId: mismatch/],
    [(batch) => { batch.meta.createdFromSafeAddress = UPV4; }, /safe: mismatch/],
  ];
  for (const [mutate, error] of cases) {
    const batch = render();
    mutate(batch);
    assert.throws(() => decodeUpv4SafeBatch(batch, baseCutoverConfig()), error);
  }
});

test("assertion reports the first changed call, currency, verifier, writer or count", () => {
  const cases = [
    [(batch) => { [batch.transactions[1], batch.transactions[2]] = [batch.transactions[2], batch.transactions[1]]; },
      /transaction\[1\].paymentMethod: expected "monobank", got "xmoney"/],
    [(batch) => { batch.transactions[14].data = ABI.encodeFunctionData(Function.AddMethod, [EXPECTED_METHODS[0], UPV4, [utils.id("USD")]]); },
      /transaction\[14\].currencies: expected/],
    [(batch) => { batch.transactions[14].data = ABI.encodeFunctionData(Function.AddMethod, [EXPECTED_METHODS[0], baseCutoverConfig().unifiedPaymentVerifierV3, [utils.id("CNY")]]); },
      /transaction\[14\].verifier: expected/],
    [(batch) => { batch.transactions[0].data = ABI.encodeFunctionData(Function.AddWriter, [baseCutoverConfig().unifiedPaymentVerifierV3]); },
      /transaction\[0\].writer: expected/],
    [(batch) => { batch.transactions.pop(); }, /call count: expected 27, got 26/],
  ];
  for (const [mutate, error] of cases) {
    const batch = render();
    mutate(batch);
    assert.throws(() => assertUpv4SafeBatch(Kind.Cutover, batch, baseCutoverConfig(), UPV4), error);
  }
});

test("builder rejects zero, malformed, empty, duplicate and conflicting inputs", () => {
  const config = baseCutoverConfig();
  for (const kind of Object.values(Kind)) {
    for (const address of [undefined, "", "invalid", "UnifiedPaymentVerifierV4", constants.AddressZero,
      config.unifiedPaymentVerifierV3.toLowerCase(), config.safe, config.paymentVerifierRegistry, config.nullifierRegistryV2]) {
      assert.throws(() => buildUpv4SafeCalls(kind, config, address), /upv4Address/);
    }
  }
  const cases = [
    [(value) => { value.routes = []; }, /routes: empty/],
    [(value) => { value.routes[0].method = constants.HashZero; }, /routes: invalid or zero hash/],
    [(value) => { value.routes[0].method = "0x12"; }, /routes: invalid or zero hash/],
    [(value) => { value.routes.push(clone(value.routes[0])); }, /routes: duplicate hash/],
    [(value) => { value.routes[0].currencies = []; }, /currencies: empty/],
    [(value) => { value.routes[0].currencies = [constants.HashZero]; }, /currencies: invalid or zero hash/],
    [(value) => { value.routes[0].currencies.push(value.routes[0].currencies[0].toUpperCase().replace("0X", "0x")); }, /currencies: duplicate hash/],
    [(value) => { value.routes[0].label = "wrong-label"; }, /label: hash mismatch/],
    [(value) => { value.routes[0].currencyLabels = ["USD"]; }, /currencyLabels: hash mismatch/],
    [(value) => { value.safe = constants.AddressZero; }, /safe: invalid or zero address/],
    [(value) => { value.nullifierRegistryV2 = value.paymentVerifierRegistry; }, /config: duplicate address/],
    [(value) => { value.chainId = 0; }, /chainId: invalid/],
  ];
  for (const [mutate, error] of cases) {
    const value = baseCutoverConfig();
    mutate(value);
    assert.throws(() => buildUpv4SafeCalls(Kind.Cutover, value, UPV4), error);
  }
  assert.throws(() => buildUpv4SafeCalls("unknown", config, UPV4), /Unknown batch kind/);
});

test("render shape, conditions, filenames, exact serialization and SHA256 are deterministic", () => {
  assert.deepEqual(UPV4_SAFE_BATCH_FILES, {
    cutover: "base_upv4_cutover.json",
    "upv3-writer-removal": "base_upv4_upv3_writer_removal.json",
    rollback: "base_upv4_rollback.json",
  });
  const names = ["Base UPV4 payment-route cutover", "Base UPV3 NullifierRegistryV2 writer removal", "Base UPV4 payment-route rollback to UPV3"];
  for (const [index, kind] of Object.values(Kind).entries()) {
    const batch = render(kind);
    const contents = serializeUpv4SafeBatch(batch);
    assert.equal(contents, serializeUpv4SafeBatch(render(kind)));
    assert.equal(contents, JSON.stringify(batch, null, 2) + "\n");
    assert.deepEqual(Object.keys(batch), ["version", "chainId", "createdAt", "meta", "transactions"]);
    assert.equal(batch.version, "1.0");
    assert.equal(batch.chainId, "8453");
    assert.equal(batch.createdAt, OPTIONS.createdAt);
    assert.deepEqual(batch.meta, {
      name: names[index], description: batch.meta.description, txBuilderVersion: "1.16.5",
      createdFromSafeAddress: baseCutoverConfig().safe, createdFromOwnerAddress: "",
    });
    assert.ok(batch.meta.description.startsWith(`${batch.transactions.length} ${batch.transactions.length === 1 ? "call" : "calls"}.`));
    assert.ok(batch.meta.description.includes(UPV4));
    assert.ok(batch.meta.description.includes(baseCutoverConfig().unifiedPaymentVerifierV3));
    assert.ok(batch.meta.description.endsWith(`Source ${OPTIONS.sourceSha}.`));
    for (const transaction of batch.transactions) {
      assert.deepEqual(Object.keys(transaction), ["to", "value", "data", "contractMethod", "contractInputsValues"]);
      assert.equal(transaction.value, "0");
      assert.equal(transaction.contractMethod, null);
      assert.equal(transaction.contractInputsValues, null);
    }
    assert.deepEqual(upv4SafeBatchSidecar(UPV4_SAFE_BATCH_FILES[kind], contents), {
      file: UPV4_SAFE_BATCH_FILES[kind], sha256: createHash("sha256").update(Buffer.from(contents)).digest("hex"),
    });
  }
  assert.match(render().meta.description, /keeps UPV3 as a writer for rollback/);
  assert.match(render(Kind.Upv3WriterRemoval).meta.description, /Prepared but not scheduled; disables the rollback batch until UPV3 is re-added/);
  assert.match(render(Kind.Rollback).meta.description, /valid only while UPV3 remains a writer; UPV4 stays a writer/);
  assert.doesNotMatch(renderUpv4SafeBatch(Kind.Cutover, baseCutoverConfig(), UPV4, { createdAt: 0 }).meta.description, /Source /);
  assert.throws(() => renderUpv4SafeBatch(Kind.Cutover, baseCutoverConfig(), UPV4, { createdAt: -1 }), /createdAt/);
  assert.throws(() => renderUpv4SafeBatch(Kind.Cutover, baseCutoverConfig(), UPV4, { ...OPTIONS, sourceSha: "short" }), /sourceSha/);
});

test("committed golden plan is exact and never invents an UPV4 address", () => {
  const plan = buildUpv4ReleasePlan();
  const contents = JSON.stringify(plan, null, 2) + "\n";
  assert.equal(readFileSync(resolve(ROOT, "deployments/upv4-base-release-plan.json"), "utf8"), contents);
  assert.deepEqual(plan.batches.map((batch) => batch.callCount), [27, 1, 26]);
  const cutover = plan.batches[0];
  assert.equal(cutover.rows[0].writer, "UnifiedPaymentVerifierV4");
  assert.ok(cutover.rows.slice(14).every((row) => row.verifier === "UnifiedPaymentVerifierV4"));
  assert.equal(contents.includes(UPV4), false);
  assert.deepEqual(new Set(contents.match(/0x[0-9a-fA-F]{40}/g)), new Set([
    baseCutoverConfig().safe, baseCutoverConfig().paymentVerifierRegistry,
    baseCutoverConfig().nullifierRegistryV2, baseCutoverConfig().unifiedPaymentVerifierV3,
  ]));
  const markdown = formatUpv4PlanMarkdown(plan);
  assert.equal((markdown.match(/\| # \| target \| function \| args \|/g) ?? []).length, 3);
  assert.ok(markdown.includes("31 currencies: USD, CNY, EUR"));
});

function cli(args, script = resolve(ROOT, "scripts/upv4SafeBatches.ts")) {
  return spawnSync(resolve(ROOT, "node_modules/.bin/ts-node"), ["--transpile-only", script, ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, TS_NODE_PROJECT: resolve(ROOT, "tsconfig.json") },
  });
}

test("FFI stdout is only one ABI-encoded line of the exact targets and calldata", () => {
  for (const kind of Object.values(Kind)) {
    const result = cli(["ffi", kind, UPV4]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^0x[0-9a-f]+\n$/);
    const [targets, data] = utils.defaultAbiCoder.decode(["address[]", "bytes[]"], result.stdout.trim());
    const calls = buildUpv4SafeCalls(kind, baseCutoverConfig(), UPV4).map(encodeUpv4SafeCall);
    assert.deepEqual([...targets], calls.map((call) => call.to));
    assert.deepEqual([...data], calls.map((call) => call.data));
  }
  const invalid = cli(["ffi", Kind.Cutover, constants.AddressZero]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /upv4Address: invalid or zero address/);
});

function cliFixture(context) {
  const root = mkdtempSync(resolve(tmpdir(), "upv4-release-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["scripts", "deployments/base", "deployments/outputs/safe-batches"]) {
    mkdirSync(resolve(root, directory), { recursive: true });
  }
  symlinkSync(resolve(ROOT, "node_modules"), resolve(root, "node_modules"));
  for (const file of ["deployments/upv4BaseCutover.ts", "deployments/parameters.ts", "deployments/safeArtifacts.ts",
    "scripts/proposeSafeBatchChunks.ts"]) {
    symlinkSync(resolve(ROOT, file), resolve(root, file));
  }
  const script = resolve(root, "scripts/upv4SafeBatches.ts");
  copyFileSync(resolve(ROOT, "scripts/upv4SafeBatches.ts"), script);
  const batchFile = (kind) => resolve(root, "deployments/outputs/safe-batches", UPV4_SAFE_BATCH_FILES[kind]);
  function writeBatches() {
    for (const kind of Object.values(Kind)) {
      const contents = serializeUpv4SafeBatch(render(kind));
      writeFileSync(batchFile(kind), contents);
      writeFileSync(batchFile(kind).replace(/\.json$/, ".sha256.json"),
        JSON.stringify(upv4SafeBatchSidecar(UPV4_SAFE_BATCH_FILES[kind], contents), null, 2) + "\n");
    }
  }
  return { root, batchFile, writeBatches, run: (args) => cli(args, script) };
}

test("plan CLI writes the golden file and detects byte drift", (context) => {
  const fixture = cliFixture(context);
  const written = fixture.run(["plan", "--write"]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stdout, formatUpv4PlanMarkdown(buildUpv4ReleasePlan()));
  const checked = fixture.run(["plan"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout, written.stdout);
  const planFile = resolve(fixture.root, "deployments/upv4-base-release-plan.json");
  writeFileSync(planFile, readFileSync(planFile, "utf8").trimEnd());
  const drifted = fixture.run(["plan"]);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /bytes differ from fresh render/);
});

test("CLI write requires the pinned record, renders six files, archives changes and verifies the Safe hash", (context) => {
  const fixture = cliFixture(context);
  const recordFile = resolve(fixture.root, "deployments/base/UnifiedPaymentVerifierV4.json");
  const batchDirectory = resolve(fixture.root, "deployments/outputs/safe-batches");
  for (const command of ["write", "verify"]) {
    const missing = fixture.run([command]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /UnifiedPaymentVerifierV4 record missing/);
    writeFileSync(recordFile, JSON.stringify({ address: OTHER_ADDRESS }));
    const wrong = fixture.run([command]);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /record address mismatch/);
    rmSync(recordFile);
    assert.deepEqual(readdirSync(batchDirectory), []);
  }
  writeFileSync(recordFile, JSON.stringify({ address: UPV4 }));
  const written = fixture.run(["write"]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(readdirSync(batchDirectory).length, 6);
  for (const kind of Object.values(Kind)) {
    const contents = readFileSync(fixture.batchFile(kind), "utf8");
    assert.equal(contents, serializeUpv4SafeBatch(render(kind)));
    assertUpv4SafeBatch(kind, JSON.parse(contents), baseCutoverConfig(), UPV4);
    assert.equal(readFileSync(fixture.batchFile(kind).replace(/\.json$/, ".sha256.json"), "utf8"),
      JSON.stringify(upv4SafeBatchSidecar(UPV4_SAFE_BATCH_FILES[kind], contents), null, 2) + "\n");
  }
  const checked = fixture.run(["verify"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(checked.stdout.includes(UPV4));
  assert.match(checked.stdout, /0x40A2aCCbd92BCA938b02010E17A5b8929b49130D/);
  assert.match(checked.stdout, /operation[=: ]+1/);
  assert.match(checked.stdout, /0x6d61bafbe0947c6db17eec69fedd7b485062d712ee66c7cbb3dacd3575d9ae58/);
  assert.match(checked.stdout, /0xe22ba698b10018c270a658525412b5e9cd81db2a4f42f9dd58983b639a2f8c70/);
  assert.equal(fixture.run(["write"]).status, 0);
  assert.equal(existsSync(resolve(batchDirectory, "superseded")), false);
  const file = fixture.batchFile(Kind.Cutover);
  const sidecar = file.replace(/\.json$/, ".sha256.json");
  const oldBatch = readFileSync(file, "utf8") + "\n";
  const oldSidecar = readFileSync(sidecar, "utf8") + "\n";
  writeFileSync(file, oldBatch);
  writeFileSync(sidecar, oldSidecar);
  assert.equal(fixture.run(["write"]).status, 0);
  const archived = readdirSync(resolve(batchDirectory, "superseded"));
  assert.equal(archived.length, 2);
  for (const name of archived) {
    assert.equal(readFileSync(resolve(batchDirectory, "superseded", name), "utf8"),
      name.endsWith(".sha256.json") ? oldSidecar : oldBatch);
  }
  assert.equal(fixture.run(["verify"]).status, 0);
});

test("verify CLI checks the pinned provenance and all six exact files", (context) => {
  const fixture = cliFixture(context);
  writeFileSync(resolve(fixture.root, "deployments/base/UnifiedPaymentVerifierV4.json"), JSON.stringify({ address: UPV4 }));
  fixture.writeBatches();
  for (const kind of Object.values(Kind)) {
    for (const sidecar of [false, true]) {
      const file = sidecar ? fixture.batchFile(kind).replace(/\.json$/, ".sha256.json") : fixture.batchFile(kind);
      writeFileSync(file, readFileSync(file, "utf8") + "\n");
      const drifted = fixture.run(["verify"]);
      assert.equal(drifted.status, 1);
      assert.match(drifted.stderr, /bytes differ from fresh render/);
      fixture.writeBatches();
    }
  }
  // Changing every file consistently must not replace the trusted provenance inputs.
  for (const field of ["createdAt", "sourceSha"]) {
    for (const kind of Object.values(Kind)) {
      const options = { ...OPTIONS, [field]: field === "createdAt" ? OPTIONS.createdAt + 1 : "a".repeat(40) };
      const contents = serializeUpv4SafeBatch(renderUpv4SafeBatch(kind, baseCutoverConfig(), UPV4, options));
      writeFileSync(fixture.batchFile(kind), contents);
      writeFileSync(fixture.batchFile(kind).replace(/\.json$/, ".sha256.json"),
        JSON.stringify(upv4SafeBatchSidecar(UPV4_SAFE_BATCH_FILES[kind], contents), null, 2) + "\n");
    }
    const rejected = fixture.run(["verify"]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /bytes differ from fresh render/);
    fixture.writeBatches();
  }
  const batch = render();
  [batch.transactions[1], batch.transactions[2]] = [batch.transactions[2], batch.transactions[1]];
  writeFileSync(fixture.batchFile(Kind.Cutover), serializeUpv4SafeBatch(batch));
  const rejected = fixture.run(["verify"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /transaction\[1\].paymentMethod|bytes differ from fresh render/);
});

function laneFixture(context, network = "base") {
  const lane = require("../deploy/47_deploy_unified_payment_verifier_v4.ts");
  const savedEnv = { ...process.env };
  context.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  process.env.DEPLOY_ACTIVE_TAG = lane.TAG;
  const artifactRoot = mkdtempSync(resolve(tmpdir(), "upv4-lane-"));
  context.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const pins = UPV4_BASE_RELEASE;
  const local = network === "localhost" || network === "hardhat";
  const model = registryModel();
  const args = [pins.orchestratorRegistry, pins.nullifierRegistryV2, pins.multiAttestationVerifier];
  const artifact = {
    abi: ["constructor(address,address,address)",
      ...["orchestratorRegistry", "nullifierRegistry", "attestationVerifier", "owner"].map((name) => `function ${name}() view returns (address)`),
      "function DOMAIN_SEPARATOR() view returns (bytes32)", "function getPaymentMethods() view returns (bytes32[])"],
    bytecode: "0x60006000a161010003", deployedBytecode: "0x60006000a161010003",
  };
  artifact.metadata = JSON.stringify({ output: { abi: artifact.abi } });
  const iface = new utils.Interface(artifact.abi);
  const records = new Map(Object.entries({
    OrchestratorRegistry: pins.orchestratorRegistry, NullifierRegistryV2: pins.nullifierRegistryV2,
    MultiAttestationVerifier: pins.multiAttestationVerifier, PaymentVerifierRegistry: pins.paymentVerifierRegistry,
    UnifiedPaymentVerifierV3: pins.unifiedPaymentVerifierV3,
    NullifierRegistry: "0x2000000000000000000000000000000000000002",
  }).map(([name, address]) => [name, { address }]));
  const state = {
    chainId: local ? 31337 : 8453, deployer: pins.deployer, block: 53210521,
    writes: [], saves: [], accounts: [], reads: [], artifactReads: 0, missingCode: new Set(), model, legacyWriters: [],
    upv4Bindings: [...args], upv4Owner: local ? pins.deployer : pins.safe,
    upv4Methods: local ? [] : [...EXPECTED_METHODS], domain: undefined,
    runtime: "0x60016001a161010003",
    transaction: { from: pins.deployer, to: null, nonce: 117,
      data: new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args).data },
    receipt: { status: 1, contractAddress: UPV4, blockNumber: 53210472, from: pins.deployer,
      transactionHash: "0xa6fa3ce43ca5352460be4ce917709f17d60fda677fa48a1fbc6f081902dcf931" },
  };
  function read(label, value, options) {
    assert.equal(options?.blockTag, state.block, `${label} must use the snapshot block`);
    state.reads.push({ label, block: options.blockTag });
    return value;
  }
  function tx(action) {
    state.writes.push(action);
    assert.ok(local, "Base must never send or deploy");
    state.block++;
    return { wait: async () => ({ blockNumber: state.block, status: 1 }) };
  }
  function account(action) {
    state.accounts.push(action);
    assert.ok(local, "Base must never access accounts or signers");
  }
  const domain = () => utils._TypedDataEncoder.hashDomain({
    name: "UnifiedPaymentVerifier", version: "1", chainId: state.chainId, verifyingContract: UPV4,
  });
  const contracts = new Map([
    [pins.paymentVerifierRegistry, {
      getPaymentMethods: async (options) => read("pvr.methods", [...model.methods], options),
      getCurrencies: async (method, options) => read("pvr.currencies", [...model.store.get(method).currencies], options),
      getVerifier: async (method, options) => read("pvr.verifier", model.store.get(method).verifier, options),
    }],
    [pins.nullifierRegistryV2, { getWriters: async (options) => read("nrv2.writers", [...model.writers], options) }],
    [records.get("NullifierRegistry").address, { getWriters: async (options) => read("legacy.writers", state.legacyWriters, options) }],
  ]);
  const verifier = {
    address: UPV4,
    owner: async (options) => read("upv4.owner", state.upv4Owner, options),
    DOMAIN_SEPARATOR: async (options) => read("upv4.domain", state.domain ?? domain(), options),
    getPaymentMethods: async (options) => read("upv4.methods", [...state.upv4Methods], options),
    addPaymentMethod: async (method) => {
      assert.equal(state.upv4Owner, pins.deployer);
      state.upv4Methods.push(method);
      return tx({ action: "addPaymentMethod", method });
    },
    transferOwnership: async (owner) => {
      state.upv4Owner = owner;
      return tx({ action: "transferOwnership", owner });
    },
  };
  for (const [index, method] of ["orchestratorRegistry", "nullifierRegistry", "attestationVerifier"].entries()) {
    verifier[method] = async (options) => read(`upv4.${method}`, state.upv4Bindings[index], options);
  }
  contracts.set(UPV4, verifier);
  const signer = {
    sendTransaction: async (encoded) => {
      model.apply(encoded);
      return tx({ action: "sendTransaction", from: state.deployer, ...encoded });
    },
  };
  const hre = {
    deployments: {
      getNetworkName: () => network,
      getOrNull: async (name) => records.get(name) ?? null,
      get: async (name) => { assert.ok(records.has(name), `missing ${name}`); return records.get(name); },
      getArtifact: async () => artifact,
      getExtendedArtifact: async () => { state.artifactReads++; return artifact; },
      save: async (name, record) => { state.saves.push({ name, record }); records.set(name, record); },
      deploy: async (name, options) => {
        assert.equal(name, lane.DEPLOYMENT_NAME);
        assert.equal(records.has(name), false, "must never redeploy a recorded UPV4");
        await tx({ action: "deploy", name, ...options }).wait();
        const record = { address: UPV4, receipt: { blockNumber: state.block } };
        records.set(name, record);
        return record;
      },
    },
    getUnnamedAccounts: async () => { account("getUnnamedAccounts"); return [state.deployer]; },
    ethers: {
      getSigner: async () => { account("getSigner"); return signer; },
      getContractAt: async (_name, address) => { assert.ok(contracts.has(address), `unknown ${address}`); return contracts.get(address); },
      provider: {
        _isProvider: true,
        getNetwork: async () => ({ chainId: state.chainId }),
        getBlockNumber: async () => state.block,
        getTransaction: async (hash) => { assert.equal(hash, pins.deployment.transactionHash); return state.transaction; },
        getTransactionReceipt: async (hash) => { assert.equal(hash, pins.deployment.transactionHash); return state.receipt; },
        getCode: async (address, blockTag) => read("code", state.missingCode.has(address) ? "0x" : state.runtime, { blockTag }),
        call: async (request, blockTag) => {
          assert.equal((await request.to).toLowerCase(), UPV4.toLowerCase());
          const parsed = iface.parseTransaction({ data: await request.data });
          return iface.encodeFunctionResult(parsed.name, [await verifier[parsed.name]({ blockTag })]);
        },
        sendTransaction: async () => tx({ action: "provider.sendTransaction" }),
      },
    },
  };
  const func = lane.createUpv4DeploymentLane();
  function recordUpv4(count = 13, owner = pins.safe) {
    records.set(lane.DEPLOYMENT_NAME, { ...clone(artifact), address: UPV4, transactionHash: state.receipt.transactionHash,
      args: [...args], receipt: { ...state.receipt } });
    state.upv4Methods = EXPECTED_METHODS.slice(0, count);
    state.upv4Owner = owner;
  }
  return { state, hre, lane, func, records, artifactRoot, recordUpv4, args, artifact,
    run: () => func(hre), skip: () => func.skip(hre) };
}

test("lane 47 exports exact identity without dependencies or deployment flags", (context) => {
  const { lane } = laneFixture(context);
  assert.equal(lane.TAG, "47_deploy_unified_payment_verifier_v4");
  assert.equal(lane.DEPLOYMENT_NAME, "UnifiedPaymentVerifierV4");
  assert.deepEqual(lane.default.tags, [lane.TAG, lane.DEPLOYMENT_NAME]);
  assert.equal(lane.default.dependencies, undefined);
  assert.equal(lane.LIVE_FLAG, undefined);
  assert.equal(lane.RELEASE_SHA_FLAG, undefined);
});

test("tagged Base adoption saves exactly one pinned record without accounts or chain writes", async (context) => {
  const f = laneFixture(context);
  assert.equal(await f.skip(), false);
  await f.run();
  assert.equal(f.state.saves.length, 1);
  assert.equal(f.state.saves[0].name, f.lane.DEPLOYMENT_NAME);
  assert.deepEqual(f.state.saves[0].record, {
    ...f.artifact, address: UPV4, args: f.args,
    transactionHash: UPV4_BASE_RELEASE.deployment.transactionHash, receipt: f.state.receipt,
  });
  assert.equal(f.state.saves[0].record.receipt.from, UPV4_BASE_RELEASE.deployer);
  assert.deepEqual(f.state.writes, []);
  assert.deepEqual(f.state.accounts, []);
  assert.deepEqual(readdirSync(f.artifactRoot), []);
  assert.equal(f.state.artifactReads, 1);
  delete process.env.DEPLOY_ACTIVE_TAG;
  assert.equal(await f.skip(), true);
  assert.equal(f.state.artifactReads, 1);
});

test("recorded Base verification ignores later compiled artifact changes", async (context) => {
  const f = laneFixture(context);
  f.recordUpv4();
  f.artifact.abi = [];
  f.artifact.metadata = JSON.stringify({ output: { abi: [] } });
  f.artifact.bytecode = "0x6000";
  f.artifact.deployedBytecode = "0x6000";
  f.hre.deployments.getExtendedArtifact = async () => assert.fail("recorded verification must not load compiled artifacts");
  f.hre.ethers.getContractAt = async () => assert.fail("recorded verification must use the record ABI and provider");
  delete process.env.DEPLOY_ACTIVE_TAG;
  assert.equal(await f.skip(), true);
  process.env.DEPLOY_ACTIVE_TAG = f.lane.TAG;
  await f.run();
  assert.deepEqual(f.state.saves, []);
  assert.deepEqual(f.state.writes, []);
  assert.deepEqual(f.state.accounts, []);
});

test("the committed Base record satisfies the pinned record checks", (context) => {
  const f = laneFixture(context);
  const record = JSON.parse(readFileSync(resolve(ROOT, "deployments/base/UnifiedPaymentVerifierV4.json"), "utf8"));
  f.lane.assertPinnedUpv4Record(record, f.args);
});

for (const [field, value, expected] of [
  ["bytecode", "0x60016000a161010003", /creation input/],
  ["deployedBytecode", "0x60006000a162010003", /runtime metadata/],
]) {
  test(`Base adoption rejects compiled ${field} drift against the deployment`, async (context) => {
    const f = laneFixture(context);
    f.artifact[field] = value;
    await assert.rejects(f.run(), expected);
    assert.equal(f.state.artifactReads, 1);
    assert.deepEqual(f.state.saves, []);
    assert.deepEqual(f.state.writes, []);
    assert.deepEqual(f.state.accounts, []);
  });
}

test("skip requires tagged adoption only when Base has no record", async (context) => {
  const f = laneFixture(context);
  delete process.env.DEPLOY_ACTIVE_TAG;
  await assert.rejects(f.skip(), /UnifiedPaymentVerifierV4 record missing; run the tagged lane-47 adoption/);
  await assert.rejects(f.run(), /DEPLOY_ACTIVE_TAG/);
  assert.deepEqual(f.state.saves, []);
  for (const network of ["localhost", "hardhat", "base_staging", "sepolia"]) {
    const other = laneFixture(context, network);
    for (const tagged of [true, false]) {
      if (tagged) process.env.DEPLOY_ACTIVE_TAG = other.lane.TAG;
      else delete process.env.DEPLOY_ACTIVE_TAG;
      assert.equal(await other.skip(), !["localhost", "hardhat"].includes(network));
    }
    assert.deepEqual(other.state.writes, []);
  }
});

const adoptionFailures = [
  ["wrong chain", (f) => { f.state.chainId = 1; }, /chainId/],
  ["missing transaction", (f) => { f.state.transaction = null; }, /transaction.*missing/i],
  ["tx.from", (f) => { f.state.transaction.from = OTHER_ADDRESS; }, /from/],
  ["tx.to", (f) => { f.state.transaction.to = UPV4; }, /creation|to/],
  ["nonce", (f) => { f.state.transaction.nonce++; }, /nonce/],
  ["creation bytecode", (f) => { f.state.transaction.data = f.state.transaction.data.replace(/^0x60/, "0x61"); }, /creation input/],
  ["creation args", (f) => { f.state.transaction.data = new ContractFactory(f.artifact.abi, f.artifact.bytecode)
    .getDeployTransaction(OTHER_ADDRESS, ...f.args.slice(1)).data; }, /creation input/],
  ["missing receipt", (f) => { f.state.receipt = null; }, /receipt.*missing/i],
  ["receipt status", (f) => { f.state.receipt.status = 0; }, /status/],
  ["receipt contractAddress", (f) => { f.state.receipt.contractAddress = OTHER_ADDRESS; }, /contractAddress/],
  ["receipt block", (f) => { f.state.receipt.blockNumber++; }, /block/],
  ["absent code", (f) => { f.state.missingCode.add(UPV4); }, /runtime/],
  ["runtime length", (f) => { f.state.runtime = "0x6000" + f.state.runtime.slice(2); }, /runtime/],
  ["runtime metadata", (f) => { f.state.runtime = "0x60016001a162010003"; }, /runtime/],
  ["invalid metadata length", (f) => { f.state.runtime = "0x60016001a16101ffff"; }, /runtime/],
  ...["orchestratorRegistry", "nullifierRegistry", "attestationVerifier"].map((name, index) =>
    [name, (f) => { f.state.upv4Bindings[index] = OTHER_ADDRESS; }, new RegExp(name)]),
  ["DOMAIN_SEPARATOR", (f) => { f.state.domain = constants.HashZero; }, /DOMAIN_SEPARATOR/],
  ["deployer owns UPV4", (f) => { f.state.upv4Owner = UPV4_BASE_RELEASE.deployer; }, /owner/],
  ["unknown owner", (f) => { f.state.upv4Owner = OTHER_ADDRESS; }, /owner/],
  ["catalog order", (f) => { f.state.upv4Methods.reverse(); }, /catalog/],
  ["partial catalog", (f) => { f.state.upv4Methods.pop(); }, /catalog/],
];
for (const [name, mutate, expected] of adoptionFailures) {
  test(`Base adoption and recorded skip reject ${name} before saving`, async (context) => {
    const f = laneFixture(context);
    mutate(f);
    await assert.rejects(f.run(), expected);
    assert.deepEqual(f.state.saves, []);
    // Populate a separately valid record, then check the same on-chain drift on the skip path.
    const recorded = laneFixture(context);
    recorded.recordUpv4();
    mutate(recorded);
    delete process.env.DEPLOY_ACTIVE_TAG;
    await assert.rejects(recorded.skip(), expected);
    for (const fixture of [f, recorded]) {
      assert.deepEqual(fixture.state.saves, []);
      assert.deepEqual(fixture.state.writes, []);
      assert.deepEqual(fixture.state.accounts, []);
    }
  });
}

for (const [name, mutate, expected = /record/i] of [
  ["address", (r) => { r.address = OTHER_ADDRESS; }],
  ["transactionHash", (r) => { r.transactionHash = constants.HashZero; }],
  ["args", (r) => { r.args.reverse(); }],
  ["missing args", (r) => { delete r.args; }],
  ["empty ABI", (r) => { r.abi = []; }, /record ABI/],
  ["ABI differs from metadata", (r) => { r.abi.pop(); }, /record ABI/],
  ["missing metadata", (r) => { delete r.metadata; }, /metadata/],
  ["malformed metadata", (r) => { r.metadata = "{"; }, /JSON/],
  ["missing metadata ABI", (r) => { r.metadata = JSON.stringify({ output: {} }); }, /record ABI/],
  ["bytecode", (r) => { r.bytecode = "0x60016000a161010003"; }, /creation input/],
  ["missing bytecode", (r) => { delete r.bytecode; }, /bytecode/],
  ["receipt.from", (r) => { r.receipt.from = OTHER_ADDRESS; }],
  ["receipt.status", (r) => { r.receipt.status = 0; }],
  ["receipt.blockNumber", (r) => { r.receipt.blockNumber++; }],
  ["receipt.contractAddress", (r) => { r.receipt.contractAddress = OTHER_ADDRESS; }],
  ["receipt.transactionHash", (r) => { r.receipt.transactionHash = constants.HashZero; }],
  ["missing receipt", (r) => { delete r.receipt; }],
  ["deployedBytecode", (r) => { r.deployedBytecode = "0x6000"; }, /runtime/],
  ["deployedBytecode metadata", (r) => { r.deployedBytecode = "0x60006000a162010003"; }, /runtime metadata/],
]) {
  test(`recorded Base rejects record ${name} drift before saving`, async (context) => {
    const f = laneFixture(context);
    f.recordUpv4();
    mutate(f.records.get(f.lane.DEPLOYMENT_NAME));
    await assert.rejects(f.skip(), expected);
    await assert.rejects(f.run(), expected);
    assert.deepEqual(f.state.saves, []);
    assert.deepEqual(f.state.writes, []);
    assert.deepEqual(f.state.accounts, []);
  });
}

test("recorded adoption is a no-op across batch lifecycle route and writer states", async (context) => {
  const f = laneFixture(context);
  f.recordUpv4();
  for (const kind of [Kind.Cutover, Kind.Upv3WriterRemoval, Kind.Rollback]) {
    for (const call of buildUpv4SafeCalls(kind, baseCutoverConfig(), UPV4)) f.state.model.apply(encodeUpv4SafeCall(call));
    assert.equal(await f.skip(), true);
    await f.run();
  }
  assert.deepEqual(f.state.saves, []);
  assert.deepEqual(f.state.writes, []);
  assert.deepEqual(f.state.accounts, []);
});

test("local first run uses exact 27 cutover calls, second run is a no-op", async (context) => {
  const f = laneFixture(context, "localhost");
  await f.run();
  const config = { ...baseCutoverConfig(), chainId: 31337, safe: UPV4_BASE_RELEASE.deployer };
  const expected = buildUpv4SafeCalls(Kind.Cutover, config, UPV4).map(encodeUpv4SafeCall);
  assert.deepEqual(f.state.writes.filter((write) => write.action === "sendTransaction"),
    expected.map((call) => ({ action: "sendTransaction", from: UPV4_BASE_RELEASE.deployer, ...call })));
  assert.equal(f.state.upv4Owner, UPV4_BASE_RELEASE.deployer);
  assert.deepEqual(f.state.model.methods, EXPECTED_METHODS);
  assert.deepEqual([...f.state.model.writers], [UPV4_BASE_RELEASE.unifiedPaymentVerifierV3, UPV4]);
  assert.deepEqual(readdirSync(f.artifactRoot), []);
  f.state.writes.length = 0;
  await f.run();
  assert.deepEqual(f.state.writes, []);
});

test("local uses the live hash-only catalog and currencies", async (context) => {
  const f = laneFixture(context, "hardhat");
  const method = utils.id("local-only");
  const currencies = [utils.id("ONE"), utils.id("TWO")];
  f.state.model.methods.splice(0, 13, method);
  f.state.model.store.clear();
  f.state.model.store.set(method, { verifier: UPV4_BASE_RELEASE.unifiedPaymentVerifierV3, currencies: [...currencies], isCurrency: new Set(currencies) });
  await f.run();
  assert.deepEqual(f.state.upv4Methods, [method]);
  assert.deepEqual(f.state.model.methods, [method]);
  assert.deepEqual(f.state.model.store.get(method).currencies, currencies);
  assert.equal(f.state.writes.filter((write) => write.action === "sendTransaction").length, 3);
});

for (const [name, mutate] of [
  ["mixed routes", (f) => { f.state.model.store.get(EXPECTED_METHODS[0]).verifier = UPV4; }],
  ["missing UPV3 writer", (f) => { f.state.model.writers.clear(); }],
  ["UPV4 writer before cutover", (f) => { f.state.model.writers.add(UPV4); }],
]) {
  test(`local rejects ${name} before writes`, async (context) => {
    const f = laneFixture(context, "localhost");
    f.recordUpv4(13, UPV4_BASE_RELEASE.deployer);
    mutate(f);
    await assert.rejects(f.run(), /route|writer/);
    assert.deepEqual(f.state.writes, []);
  });
}

test("upv4RoutesActive recognizes only complete routes with safe replay writers", async (context) => {
  const f = laneFixture(context);
  const active = () => f.lane.upv4RoutesActive(f.hre);
  assert.equal(await active(), false);
  f.recordUpv4();
  const getContractAt = f.hre.ethers.getContractAt;
  f.hre.ethers.getContractAt = async (name, address) => {
    assert.notEqual(name, f.lane.DEPLOYMENT_NAME, "active UPV4 reads must use the record ABI");
    return getContractAt(name, address);
  };
  assert.equal(await active(), false);
  f.state.model.store.get(EXPECTED_METHODS[0]).verifier = UPV4;
  await assert.rejects(active(), /route/);
  for (const route of f.state.model.store.values()) route.verifier = UPV4;
  await assert.rejects(active(), /writer/);
  f.state.model.writers.add(UPV4);
  assert.equal(await active(), true);
  f.state.model.writers.delete(UPV4_BASE_RELEASE.unifiedPaymentVerifierV3);
  assert.equal(await active(), true);
  f.state.model.writers.add(UPV4_BASE_RELEASE.deployer);
  await assert.rejects(active(), /writer/);
  f.state.model.writers.delete(UPV4_BASE_RELEASE.deployer);
  f.state.legacyWriters.push(UPV4_BASE_RELEASE.unifiedPaymentVerifierV3);
  await assert.rejects(active(), /legacy.*writer/i);
  f.state.legacyWriters.length = 0;
  f.state.upv4Methods.reverse();
  await assert.rejects(active(), /catalog|method order/);
});
