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
const { BigNumber, constants, utils } = require("ethers");
const { BASE_ACTIVE_PAYMENT_METHODS, MULTI_SIG, UPV4_BASE_RELEASE } = require("../deployments/parameters.ts");
const {
  Upv4SafeBatchKind: Kind, Upv4SafeContract: Contract, Upv4SafeFunction: Function,
  UPV4_SAFE_BATCH_FILES, baseCutoverConfig, buildUpv4SafeCalls, encodeUpv4SafeCall,
  renderUpv4SafeBatch, serializeUpv4SafeBatch, upv4SafeBatchSidecar,
  decodeUpv4SafeBatch, assertUpv4SafeBatch, buildUpv4ReleasePlan, formatUpv4PlanMarkdown,
} = require("../deployments/upv4BaseCutover.ts");

const ROOT = resolve(__dirname, "..");
const UPV4 = "0x1000000000000000000000000000000000000001";
const OPTIONS = { createdAt: 1793188800000, sourceSha: "cb116d102b36c60e1502a902bb7fd6646e7f2f43" };
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
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    safe: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    orchestratorRegistry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
    nullifierRegistryV2: "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB",
    multiAttestationVerifier: "0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5",
    paymentVerifierRegistry: "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e",
    unifiedPaymentVerifierV3: "0xC6F4a193576C60892a47e111Bb5706c30162502B",
    orchestratorV3: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
    stagingUnifiedPaymentVerifierV4: "0x7Da43ba0F85cfb64733216C4A2288f80dFfe1EAb",
  });
  assert.equal(pins.safe, MULTI_SIG.base);
  assert.deepEqual(paymentRoutes, EXPECTED_ROUTES);
  assert.deepEqual(paymentRoutes.map((route) => route.method), BASE_ACTIVE_PAYMENT_METHODS);
  assert.equal(paymentRoutes.length, 13);
  assert.equal(paymentRoutes.reduce((count, route) => count + route.currencies.length, 0), 72);
  const config = baseCutoverConfig();
  assert.equal(config.routes[0].method, "0xcac9daea62d7b89d75ac73af4ee14dcf25721012ae82b568c2ea5c808eaa04ff");
  assert.equal(config.routes[12].method, "0x1d966dbd6aeb8674d7c05174bd0ded7b56a798672bfb862ef20bbe8c2bbfce18");
  for (const value of Object.values(pins).filter((value) => typeof value === "string")) {
    assert.equal(utils.getAddress(value), value);
  }
  assert.equal(Object.keys(require.cache).some((file) => file.includes("/hardhat/")), false);
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
  symlinkSync(resolve(ROOT, "deployments/upv4BaseCutover.ts"), resolve(root, "deployments/upv4BaseCutover.ts"));
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

test("verify CLI fails before deployment, then checks shared provenance and all six exact files", (context) => {
  const fixture = cliFixture(context);
  const missing = fixture.run(["verify"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /UnifiedPaymentVerifierV4 is not deployed on Base yet/);
  writeFileSync(resolve(fixture.root, "deployments/base/UnifiedPaymentVerifierV4.json"), JSON.stringify({ address: UPV4 }));
  fixture.writeBatches();
  const valid = fixture.run(["verify"]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.ok(valid.stdout.includes(UPV4));
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
  const cases = [
    [Kind.Rollback, (batch) => { batch.createdAt += 1; }, /createdAt mismatch/],
    [Kind.Upv3WriterRemoval, (batch) => { batch.meta.description = batch.meta.description.replace(OPTIONS.sourceSha, "a".repeat(40)); }, /source SHA mismatch/],
    [Kind.Cutover, (batch) => { batch.meta.description = "missing source"; }, /expected one Source/],
    [Kind.Cutover, (batch) => { batch.meta.description += ` Source ${OPTIONS.sourceSha}.`; }, /expected one Source/],
    [Kind.Cutover, (batch) => { [batch.transactions[1], batch.transactions[2]] = [batch.transactions[2], batch.transactions[1]]; }, /transaction\[1\].paymentMethod/],
  ];
  for (const [kind, mutate, error] of cases) {
    const batch = render(kind);
    mutate(batch);
    writeFileSync(fixture.batchFile(kind), serializeUpv4SafeBatch(batch));
    const rejected = fixture.run(["verify"]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, error);
    fixture.writeBatches();
  }
});

function laneFixture(context, network = "base", root) {
  const lane = require("../deploy/47_deploy_unified_payment_verifier_v4.ts");
  const savedEnv = { ...process.env };
  context.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  process.env.DEPLOY_ACTIVE_TAG = lane.TAG;
  process.env[lane.LIVE_FLAG] = "true";
  process.env[lane.RELEASE_SHA_FLAG] = OPTIONS.sourceSha;
  const artifactRoot = root ?? mkdtempSync(resolve(tmpdir(), "upv4-lane-"));
  if (!root) context.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const pins = UPV4_BASE_RELEASE;
  const model = registryModel();
  const records = new Map(Object.entries({
    OrchestratorRegistry: pins.orchestratorRegistry, NullifierRegistryV2: pins.nullifierRegistryV2,
    MultiAttestationVerifier: pins.multiAttestationVerifier, PaymentVerifierRegistry: pins.paymentVerifierRegistry,
    UnifiedPaymentVerifierV3: pins.unifiedPaymentVerifierV3, OrchestratorV3: pins.orchestratorV3,
    NullifierRegistry: "0x2000000000000000000000000000000000000002",
  }).map(([name, address]) => [name, { address }]));
  const state = {
    chainId: network === "base" ? 8453 : 31337, deployer: pins.deployer,
    head: OPTIONS.sourceSha, dirty: "", block: 100, writes: [], reads: [],
    missingCode: new Set(), model, owners: new Map([...records.keys()].map((name) => [name, pins.safe])),
    registered: true, o3Registry: pins.paymentVerifierRegistry, upv3Methods: [...EXPECTED_METHODS],
    requiredSignatures: 1, witnesses: [pins.deployer], legacyWriters: [],
    upv3Bindings: [pins.orchestratorRegistry, pins.nullifierRegistryV2, pins.multiAttestationVerifier],
    upv4Bindings: [pins.orchestratorRegistry, pins.nullifierRegistryV2, pins.multiAttestationVerifier],
    upv4Owner: pins.deployer, upv4Methods: [], domain: undefined,
    compiled: "0x60006000a161010003", staging: "0x60016001a161010003",
  };
  function read(label, value, options) {
    assert.equal(typeof options?.blockTag, "number", `${label} must pin its read`);
    assert.equal(options.blockTag, state.block, `${label} must use the current snapshot block`);
    state.reads.push({ label, block: options.blockTag, writes: state.writes.length });
    return value;
  }
  function tx(action) {
    state.writes.push(action);
    state.block++;
    return { wait: async () => ({ blockNumber: state.block, status: 1 }) };
  }
  const domain = () => utils._TypedDataEncoder.hashDomain({
    name: "UnifiedPaymentVerifier", version: "1", chainId: state.chainId, verifyingContract: UPV4,
  });
  const contracts = new Map([...records].map(([name, record]) => [record.address, {
    address: record.address, owner: async (options) => read(`${name}.owner`, state.owners.get(name), options),
  }]));
  Object.assign(contracts.get(pins.paymentVerifierRegistry), {
    getPaymentMethods: async (options) => read("pvr.methods", [...model.methods], options),
    getCurrencies: async (method, options) => read("pvr.currencies", [...model.store.get(method).currencies], options),
    getVerifier: async (method, options) => read("pvr.verifier", model.store.get(method).verifier, options),
  });
  Object.assign(contracts.get(pins.nullifierRegistryV2), {
    getWriters: async (options) => read("nrv2.writers", [...model.writers], options),
  });
  Object.assign(contracts.get(records.get("NullifierRegistry").address), {
    getWriters: async (options) => read("legacy.writers", state.legacyWriters, options),
  });
  Object.assign(contracts.get(pins.orchestratorRegistry), {
    isOrchestrator: async (address, options) => {
      assert.equal(address, pins.orchestratorV3);
      return read("orchestrator.registered", state.registered, options);
    },
  });
  Object.assign(contracts.get(pins.orchestratorV3), {
    paymentVerifierRegistry: async (options) => read("o3.pvr", state.o3Registry, options),
  });
  Object.assign(contracts.get(pins.multiAttestationVerifier), {
    requiredSignatures: async (options) => read("mav.threshold", BigNumber.from(state.requiredSignatures), options),
    witnesses: async (options) => read("mav.witnesses", state.witnesses, options),
  });
  for (const [index, method] of ["orchestratorRegistry", "nullifierRegistry", "attestationVerifier"].entries()) {
    contracts.get(pins.unifiedPaymentVerifierV3)[method] = async (options) => read(`upv3.${method}`, state.upv3Bindings[index], options);
  }
  contracts.get(pins.unifiedPaymentVerifierV3).getPaymentMethods = async (options) => read("upv3.methods", state.upv3Methods, options);
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
      assert.equal(state.upv4Owner, pins.deployer);
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
      getArtifact: async (name) => { assert.equal(name, lane.DEPLOYMENT_NAME); return { deployedBytecode: state.compiled }; },
      deploy: async (name, options) => {
        assert.equal(name, lane.DEPLOYMENT_NAME);
        assert.equal(records.has(name), false, "must never redeploy a recorded UPV4");
        await tx({ action: "deploy", name, ...options }).wait();
        const record = { address: UPV4, receipt: { blockNumber: state.block }, transactionHash: "0x" + "1".repeat(64) };
        records.set(name, record);
        return record;
      },
    },
    getUnnamedAccounts: async () => [state.deployer],
    ethers: {
      getSigner: async (address) => { assert.equal(address, state.deployer); return signer; },
      getContractAt: async (_name, address) => { assert.ok(contracts.has(address), `unknown ${address}`); return contracts.get(address); },
      provider: {
        getNetwork: async () => ({ chainId: state.chainId }),
        getBlockNumber: async () => state.block,
        getBlock: async (block) => {
          assert.equal(block, records.get(lane.DEPLOYMENT_NAME).receipt.blockNumber);
          return { timestamp: OPTIONS.createdAt / 1000 };
        },
        getCode: async (address, blockTag) => read("code", state.missingCode.has(address) ? "0x" :
          address === pins.stagingUnifiedPaymentVerifierV4 ? state.staging : "0x6000", { blockTag }),
      },
    },
  };
  const func = lane.createUpv4DeploymentLane({
    artifactRoot,
    git: (args) => {
      if (args[0] === "rev-parse") return state.head;
      assert.deepEqual(args, ["status", "--porcelain", "--untracked-files=all"]);
      return state.dirty;
    },
  });
  function recordUpv4(count = 13, owner = pins.safe) {
    records.set(lane.DEPLOYMENT_NAME, { address: UPV4, receipt: { blockNumber: 90 } });
    state.upv4Methods = EXPECTED_METHODS.slice(0, count);
    state.upv4Owner = owner;
  }
  return { state, hre, lane, func, records, artifactRoot, recordUpv4,
    run: () => func(hre), skip: () => func.skip(hre),
    file: (kind, sidecar = false) => resolve(artifactRoot, UPV4_SAFE_BATCH_FILES[kind].replace(/\.json$/, sidecar ? ".sha256.json" : ".json")),
  };
}

test("lane 47 exports exact identity without dependencies", (context) => {
  const { lane } = laneFixture(context);
  assert.equal(lane.TAG, "47_deploy_unified_payment_verifier_v4");
  assert.equal(lane.LIVE_FLAG, "ENABLE_BASE_UPV4_DEPLOYMENT");
  assert.equal(lane.RELEASE_SHA_FLAG, "CONFIRM_BASE_UPV4_RELEASE_READY_SHA");
  assert.equal(lane.DEPLOYMENT_NAME, "UnifiedPaymentVerifierV4");
  assert.deepEqual(lane.default.tags, [lane.TAG, lane.DEPLOYMENT_NAME]);
  assert.equal(lane.default.dependencies, undefined);
});

test("lane 47 skip matrix and flags require the canonical tag", async (context) => {
  for (const network of ["localhost", "hardhat", "base_staging", "base", "sepolia"]) {
    const fixture = laneFixture(context, network);
    for (const tagged of [true, false]) {
      delete process.env[fixture.lane.LIVE_FLAG];
      delete process.env[fixture.lane.RELEASE_SHA_FLAG];
      if (tagged) process.env.DEPLOY_ACTIVE_TAG = fixture.lane.TAG;
      else delete process.env.DEPLOY_ACTIVE_TAG;
      assert.equal(await fixture.skip(), !["localhost", "hardhat"].includes(network) && (network !== "base" || !tagged));
      if (!tagged) for (const flag of [fixture.lane.LIVE_FLAG, fixture.lane.RELEASE_SHA_FLAG]) {
        process.env[flag] = "false";
        await assert.rejects(fixture.skip(), /Lane 47 flags require DEPLOY_ACTIVE_TAG=47_deploy_unified_payment_verifier_v4/);
        delete process.env[flag];
      }
    }
    assert.deepEqual(fixture.state.writes, []);
  }
});

const baseFailures = [
  ["missing live flag", (f) => { delete process.env[f.lane.LIVE_FLAG]; }, /ENABLE_BASE_UPV4_DEPLOYMENT=true required/],
  ["missing SHA", (f) => { delete process.env[f.lane.RELEASE_SHA_FLAG]; }, /40.*hex|release SHA/i],
  ["malformed SHA", (f) => { process.env[f.lane.RELEASE_SHA_FLAG] = "A".repeat(40); }, /40.*hex|release SHA/i],
  ["different HEAD", (f) => { f.state.head = "a".repeat(40); }, /HEAD/],
  ["unrelated dirty file", (f) => { f.state.dirty = " M contracts/EscrowV2.sol\n"; }, /dirty|worktree/],
  ["rename from unrelated file", (f) => { f.state.dirty = "R  package.json -> deployments/base/UnifiedPaymentVerifierV4.json\n"; }, /dirty|worktree/],
  ["wrong chain", (f) => { f.state.chainId = 1; }, /chainId/],
  ["wrong deployer", (f) => { f.state.deployer = UPV4; }, /deployer/],
  ["record address drift", (f) => { f.records.get("OrchestratorRegistry").address = UPV4; }, /OrchestratorRegistry.*address/],
  ["missing record", (f) => { f.records.delete("OrchestratorV3"); }, /OrchestratorV3/],
  ["missing runtime", (f) => { f.state.missingCode.add(UPV4_BASE_RELEASE.orchestratorRegistry); }, /runtime/],
  ...["PaymentVerifierRegistry", "NullifierRegistryV2", "OrchestratorRegistry", "UnifiedPaymentVerifierV3", "MultiAttestationVerifier"].map((name) =>
    [`${name} owner`, (f) => { f.state.owners.set(name, UPV4); }, new RegExp(`${name}.*owner`)]),
  ["method order", (f) => { f.state.model.methods.reverse(); }, /method order/],
  ["currencies", (f) => { f.state.model.store.get(EXPECTED_METHODS[0]).currencies = [utils.id("USD")]; }, /currenc/],
  ["route drift", (f) => { f.state.model.store.get(EXPECTED_METHODS[0]).verifier = UPV4; }, /route/],
  ["writers", (f) => { f.state.model.writers.add(UPV4); }, /writers/],
  ["O3 unregistered", (f) => { f.state.registered = false; }, /OrchestratorV3.*registered/],
  ["O3 registry", (f) => { f.state.o3Registry = UPV4; }, /OrchestratorV3.*registry/],
  ["UPV3 bindings", (f) => { f.state.upv3Bindings[1] = UPV4; }, /UnifiedPaymentVerifierV3.*nullifier/],
  ["UPV3 catalog", (f) => { f.state.upv3Methods.reverse(); }, /UnifiedPaymentVerifierV3.*method/],
  ["MAV zero threshold", (f) => { f.state.requiredSignatures = 0; }, /witness|threshold/],
  ["MAV insufficient witnesses", (f) => { f.state.requiredSignatures = 2; }, /witness|threshold/],
  ["staging metadata", (f) => { f.state.staging = "0x60006000a162010003"; }, /UPV4 artifact differs from the reviewed staging source/],
  ["staging length", (f) => { f.state.staging = "0x600060006000a161010003"; }, /UPV4 artifact differs from the reviewed staging source/],
  ["truncated staging metadata", (f) => { f.state.staging = "0x60006000a16101ffff"; }, /UPV4 artifact differs from the reviewed staging source/],
];
for (const [name, mutate, expected] of baseFailures) {
  test(`Base preflight rejects ${name} before any write`, async (context) => {
    const fixture = laneFixture(context);
    mutate(fixture);
    await assert.rejects(fixture.run(), expected);
    assert.deepEqual(fixture.state.writes, []);
    assert.deepEqual(readdirSync(fixture.artifactRoot), []);
  });
}

test("Base deploys, registers 13 methods, hands off once, and lane-written pairs pass CLI verify", async (context) => {
  const cli = cliFixture(context);
  const f = laneFixture(context, "base", resolve(cli.root, "deployments/outputs/safe-batches"));
  await f.run();
  assert.deepEqual(f.state.writes, [
    { action: "deploy", name: f.lane.DEPLOYMENT_NAME, contract: "UnifiedPaymentVerifierV4", from: UPV4_BASE_RELEASE.deployer,
      args: [UPV4_BASE_RELEASE.orchestratorRegistry, UPV4_BASE_RELEASE.nullifierRegistryV2, UPV4_BASE_RELEASE.multiAttestationVerifier], log: true },
    ...EXPECTED_METHODS.map((method) => ({ action: "addPaymentMethod", method })),
    { action: "transferOwnership", owner: UPV4_BASE_RELEASE.safe },
  ]);
  assert.deepEqual(new Set(f.state.reads.filter((read) => read.writes === 0).map((read) => read.block)), new Set([100]));
  assert.equal(readdirSync(f.artifactRoot).length, 6);
  for (const [index, kind] of Object.values(Kind).entries()) {
    const contents = readFileSync(f.file(kind), "utf8");
    const batch = JSON.parse(contents);
    assertUpv4SafeBatch(kind, batch, baseCutoverConfig(), UPV4);
    assert.equal(batch.transactions.length, [27, 1, 26][index]);
    assert.equal(batch.createdAt, OPTIONS.createdAt);
    assert.equal(contents, serializeUpv4SafeBatch(render(kind)));
    assert.equal(readFileSync(f.file(kind, true), "utf8"),
      require("../deployments/upv4BaseCutover.ts").serializeUpv4SafeBatchSidecar(UPV4_SAFE_BATCH_FILES[kind], contents));
    const decoded = decodeUpv4SafeBatch(batch, baseCutoverConfig());
    assert.equal(decoded.some((row) => row.function === "acceptOwnership"), false);
    assert.equal(decoded.some((row) => row.function === "removeWritePermission"), kind === Kind.Upv3WriterRemoval);
  }
  writeFileSync(resolve(cli.root, "deployments/base/UnifiedPaymentVerifierV4.json"), JSON.stringify({ address: UPV4 }));
  const checked = cli.run(["verify"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(checked.stdout.includes(UPV4));
  f.state.writes.length = 0;
  assert.equal(await f.skip(), true);
  await f.run();
  assert.deepEqual(f.state.writes, []);
});

test("complete Base skip detects each missing or changed artifact and resumes without transactions", async (context) => {
  const f = laneFixture(context);
  f.recordUpv4();
  await f.run();
  for (const kind of Object.values(Kind)) for (const sidecar of [false, true]) {
    const file = f.file(kind, sidecar);
    rmSync(file);
    assert.equal(await f.skip(), false);
    await f.run();
    assert.equal(await f.skip(), true);
    writeFileSync(file, readFileSync(file, "utf8") + "\n");
    assert.equal(await f.skip(), false);
    await f.run();
    assert.equal(await f.skip(), true);
  }
  assert.deepEqual(f.state.writes, []);
  assert.ok(readdirSync(resolve(f.artifactRoot, "superseded")).length > 0);
});

test("Base resumes a five-method prefix without redeployment", async (context) => {
  const f = laneFixture(context);
  f.recordUpv4(5, UPV4_BASE_RELEASE.deployer);
  f.state.dirty = [
    "?? deployments/base/UnifiedPaymentVerifierV4.json", " M deployments/base/.migrations.json",
    "?? deployments/base/solcInputs/source.json", "?? deployments/outputs/safe-batches/base_upv4_cutover.json",
  ].join("\n") + "\n";
  assert.equal(await f.skip(), false);
  await f.run();
  assert.deepEqual(f.state.writes, [
    ...EXPECTED_METHODS.slice(5).map((method) => ({ action: "addPaymentMethod", method })),
    { action: "transferOwnership", owner: UPV4_BASE_RELEASE.safe },
  ]);
});

for (const [name, mutate, expected] of [
  ["non-prefix catalog", (s) => { s.upv4Methods.reverse(); }, /ordered prefix/],
  ["unknown owner", (s) => { s.upv4Owner = UPV4; }, /owner/],
  ["Safe with partial catalog", (s) => { s.upv4Methods.pop(); }, /catalog/],
  ["immutable drift", (s) => { s.upv4Bindings[0] = UPV4; }, /orchestratorRegistry/],
  ["domain drift", (s) => { s.domain = constants.HashZero; }, /DOMAIN_SEPARATOR/],
  ["absent code", (s) => { s.missingCode.add(UPV4); }, /runtime/],
]) {
  test(`Base resume and skip reject ${name} without writes`, async (context) => {
    const f = laneFixture(context);
    f.recordUpv4();
    mutate(f.state);
    await assert.rejects(f.skip(), expected);
    await assert.rejects(f.run(), expected);
    assert.deepEqual(f.state.writes, []);
  });
}

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
