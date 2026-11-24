#!/usr/bin/env node
require(require.resolve("ts-node/register/transpile-only"));
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const net = require("node:net");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { BigNumber, ContractFactory, Contract, Wallet, providers, utils } = require("ethers");
const {
  KmsDigestSigner, KmsMessageType, KmsSigner, KmsSigningAlgorithm, parseDerSignature, publicKeyFromSpki,
} = require("../utils/kmsSigner.ts");
const { KmsSigningProvider } = require("../utils/kmsSigningProvider.ts");
const { FakeKms, derSignature } = require("./lib/fakeKms.ts");

const ROOT = resolve(__dirname, "..");
const KEY_ID = "alias/peer-kohai-staging-deployer";
const WALLET = new Wallet(utils.keccak256(utils.toUtf8Bytes("upv5 kms fake deployer")));
const ORDER = BigNumber.from("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const fake = (options = {}) => new FakeKms(WALLET.privateKey, { keyId: KEY_ID, ...options });
const signerFor = (kms = fake({ highS: true })) => KmsDigestSigner.create(kms, KEY_ID, WALLET.address);
const digest = (label) => utils.keccak256(utils.toUtf8Bytes(label));

test("the KMS public key derives the deployer address and nothing else may sign", async () => {
  const kms = fake();
  const key = await kms.getPublicKey(KEY_ID);
  assert.equal(utils.computeAddress(publicKeyFromSpki(key.publicKey)), WALLET.address);
  assert.equal((await signerFor()).address, WALLET.address);
  await assert.rejects(KmsDigestSigner.create(kms, KEY_ID, "0x41123d6419C7b8e44157f6F3b0088442116641eC"),
    /derives 0x[0-9a-fA-F]{40}, not the expected signer 0x41123d6419C7b8e44157f6F3b0088442116641eC/);
  await assert.rejects(KmsDigestSigner.create(kms, KEY_ID, WALLET.address, [WALLET.address.toLowerCase()]), /derives retired signer/);
  // The real retired deployer stays refused by default.
  const { RETIRED_DEPLOYERS } = require("../utils/deployerKeys.ts");
  assert.deepEqual(RETIRED_DEPLOYERS, ["0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929"]);
  const wrongSpec = { getPublicKey: async () => ({ ...key, keySpec: "ECC_NIST_P256" }), sign: kms.sign.bind(kms) };
  await assert.rejects(KmsDigestSigner.create(wrongSpec, KEY_ID, WALLET.address), /is ECC_NIST_P256, not ECC_SECG_P256K1/);
  const noEcdsa = { getPublicKey: async () => ({ ...key, signingAlgorithms: ["RSASSA_PSS_SHA_256"] }), sign: kms.sign.bind(kms) };
  await assert.rejects(KmsDigestSigner.create(noEcdsa, KEY_ID, WALLET.address), /does not allow ECDSA_SHA_256/);
  // P-256 (prime256v1) SubjectPublicKeyInfo: right shape, wrong curve.
  const p256 = utils.arrayify(utils.hexlify(key.publicKey).replace("2b8104000a", "2a8648ce3d030107").replace("3056301006", "3059301306"));
  assert.throws(() => publicKeyFromSpki(p256), /not on secp256k1|ASN.1/);
  assert.throws(() => publicKeyFromSpki(utils.arrayify(utils.hexlify(key.publicKey) + "00")), /trailing bytes/);
});

test("the fake KMS enforces the deployer key policy", async () => {
  const kms = fake();
  const request = { keyId: KEY_ID, digest: utils.arrayify(digest("policy")), messageType: KmsMessageType.Digest,
    signingAlgorithm: KmsSigningAlgorithm.EcdsaSha256 };
  await kms.sign(request);
  await assert.rejects(kms.sign({ ...request, messageType: "RAW" }), /AccessDenied/);
  await assert.rejects(kms.sign({ ...request, signingAlgorithm: "ECDSA_SHA_384" }), /AccessDenied/);
  await assert.rejects(kms.sign({ ...request, digest: new Uint8Array(31) }), /32 bytes/);
  await assert.rejects(kms.sign({ ...request, keyId: "alias/other" }), /NotFound/);
  const signer = await signerFor(kms);
  await assert.rejects(signer.signDigest("0x1234"), /32-byte digests only/);
});

test("high-s KMS signatures are normalised, recover to the deployer and match a local signer", async () => {
  const signer = await signerFor(fake({ highS: true }));
  for (const label of ["one", "two", "three", "four", "five", "six"]) {
    const signature = await signer.signDigest(digest(label));
    assert.ok(BigNumber.from(signature.s).lte(ORDER.shr(1)), "s is in the lower half");
    assert.equal(utils.recoverAddress(digest(label), signature), WALLET.address);
    const local = WALLET._signingKey().signDigest(digest(label));
    assert.deepEqual([signature.r, signature.s, signature.v], [local.r, local.s, local.v]);
  }
});

test("DER signatures parse strictly", () => {
  const r = BigNumber.from("0x80" + "11".repeat(31));
  const s = ORDER.sub(5);
  const parsed = parseDerSignature(derSignature(r, s));
  assert.equal(parsed.r, utils.hexZeroPad(r.toHexString(), 32));
  assert.equal(parsed.s, utils.hexZeroPad("0x05", 32), "high s becomes n - s");
  const good = utils.hexlify(derSignature(BigNumber.from(7), BigNumber.from(9)));
  assert.deepEqual(parseDerSignature(utils.arrayify(good)), { r: utils.hexZeroPad("0x07", 32), s: utils.hexZeroPad("0x09", 32) });
  for (const [bytes, error] of [
    [good + "00", /trailing bytes/],
    ["0x3006020100020109", /out of range/],
    ["0x300702020007020109", /non-minimal/],
    ["0x3006020181020109", /not a positive integer/],
    ["0x3008020107020109", /truncated|bad ASN.1/],
    [utils.hexlify(derSignature(ORDER, BigNumber.from(9))), /out of range/],
    ["0x31060201070201" + "09", /expected ASN.1 tag/],
  ]) {
    assert.throws(() => parseDerSignature(utils.arrayify(bytes)), error);
  }
});

test("the ethers KMS signer produces the same EIP-1559 transactions and messages as a local key", async () => {
  const signer = new KmsSigner(await signerFor());
  assert.equal(await signer.getAddress(), WALLET.address);
  const transaction = {
    type: 2, chainId: 8453, nonce: 7, to: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc", data: "0x1234", value: 0,
    gasLimit: 100000, maxFeePerGas: 2_000_000_000, maxPriorityFeePerGas: 1_000_000,
  };
  const raw = await signer.signTransaction(transaction);
  assert.equal(raw, await WALLET.signTransaction(transaction));
  const parsed = utils.parseTransaction(raw);
  assert.equal(parsed.from, WALLET.address);
  assert.equal(parsed.type, 2);
  assert.equal(await signer.signMessage("hello"), await WALLET.signMessage("hello"));
  await assert.rejects(signer.signTransaction({ ...transaction, from: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc" }), /cannot be signed/);
});

function mockNode(overrides = {}) {
  const calls = [];
  const handlers = {
    eth_chainId: () => "0x2105",
    eth_accounts: () => ["0x00000000000000000000000000000000000000a1"],
    eth_getTransactionCount: () => "0x9",
    eth_estimateGas: () => "0x5208",
    eth_maxPriorityFeePerGas: () => "0x3b9aca00",
    eth_getBlockByNumber: () => ({ number: "0x10", baseFeePerGas: "0x64" }),
    eth_sendRawTransaction: ([raw]) => utils.parseTransaction(raw).hash,
    eth_sendTransaction: () => "0xforwarded",
    ...overrides,
  };
  const node = Object.assign(new EventEmitter(), {
    request: async ({ method, params }) => {
      calls.push([method, params ?? []]);
      if (!handlers[method]) throw new Error(`unexpected ${method}`);
      return handlers[method](params ?? []);
    },
  });
  return { node, calls };
}

test("the Hardhat provider wrapper signs the deployer's transactions with KMS and fills them like Hardhat", async () => {
  const { node, calls } = mockNode();
  const provider = new KmsSigningProvider(node, await signerFor());
  assert.deepEqual(await provider.request({ method: "eth_accounts" }),
    [WALLET.address, "0x00000000000000000000000000000000000000a1"]);
  const hash = await provider.request({ method: "eth_sendTransaction", params: [{
    from: WALLET.address.toLowerCase(), to: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc", data: "0xabcd",
  }] });
  const [, [raw]] = calls.find(([method]) => method === "eth_sendRawTransaction");
  const sent = utils.parseTransaction(raw);
  assert.equal(hash, sent.hash);
  assert.equal(sent.from, WALLET.address);
  assert.deepEqual([sent.type, sent.chainId, sent.nonce, sent.gasLimit.toNumber(), sent.data],
    [2, 8453, 9, 21000, "0xabcd"]);
  assert.equal(sent.maxPriorityFeePerGas.toString(), "1000000000");
  assert.equal(sent.maxFeePerGas.toString(), String(100 * 2 + 1_000_000_000));
  assert.equal(calls.some(([method]) => method === "eth_sendTransaction"), false, "the node never sees the deployer's unsigned send");

  // Caller-supplied fields win; a gas price makes a legacy transaction.
  await provider.request({ method: "eth_sendTransaction", params: [{
    from: WALLET.address, to: WALLET.address, value: "0x1", gas: "0x7530", gasPrice: "0x10", nonce: "0x2a",
  }] });
  const legacy = utils.parseTransaction(calls.filter(([method]) => method === "eth_sendRawTransaction").pop()[1][0]);
  assert.deepEqual([legacy.type, legacy.nonce, legacy.gasLimit.toNumber(), legacy.gasPrice.toNumber(), legacy.from],
    [null, 42, 30000, 16, WALLET.address]);

  assert.equal(await provider.request({ method: "eth_sendTransaction", params: [{ from: "0x00000000000000000000000000000000000000a1" }] }),
    "0xforwarded", "other senders pass through to the node");
  await assert.rejects(provider.request({ method: "eth_sendTransaction", params: [{ from: WALLET.address, chainId: "0x1" }] }),
    /differs from the node's 8453/);
  await assert.rejects(provider.request({ method: "personal_sign", params: ["0x1234", WALLET.address] }), /not supported for the KMS deployer/);
  await assert.rejects(provider.request({ method: "eth_sendTransaction", params: [{ from: "nope" }] }), /invalid from/);
});

function freePort() {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const hasAnvil = spawnSync("anvil", ["--version"], { encoding: "utf8" }).status === 0;
const artifact = (path) => JSON.parse(readFileSync(resolve(ROOT, "artifacts/contracts", path), "utf8"));

test("a deploy and calls go through the KMS path on a local node, as hardhat-deploy sends them", { skip: !hasAnvil && "anvil not installed" }, async (context) => {
  const port = await freePort();
  const anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  context.after(() => anvil.kill());
  const url = `http://127.0.0.1:${port}`;
  const rpc = new providers.StaticJsonRpcProvider(url, 31337);
  for (let attempt = 0; ; attempt++) {
    try { await rpc.getBlockNumber(); break; } catch (error) {
      if (attempt > 50) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  await rpc.send("anvil_setBalance", [WALLET.address, "0x56bc75e2d63100000"]);
  const node = Object.assign(new EventEmitter(), { request: ({ method, params }) => rpc.send(method, params ?? []) });
  const signs = [];
  const kms = fake({ highS: true, onSign: (request) => signs.push(request) });
  const kmsProvider = new KmsSigningProvider(node, await signerFor(kms));
  // hardhat-deploy and hardhat-ethers wrap the network provider and send through a JSON-RPC signer.
  const signer = new providers.Web3Provider(kmsProvider).getSigner(WALLET.address);
  const legacyRegistry = artifact("registries/NullifierRegistry.sol/NullifierRegistry.json");
  const registryV3 = artifact("registries/NullifierRegistryV3.sol/NullifierRegistryV3.json");
  const v1 = await new ContractFactory(legacyRegistry.abi, legacyRegistry.bytecode, signer).deploy();
  await v1.deployed();
  const v3 = await new ContractFactory(registryV3.abi, registryV3.bytecode, signer).deploy(v1.address);
  await v3.deployed();
  const writer = "0x00000000000000000000000000000000000000b1";
  const added = await (await v3.addWritePermission(writer)).wait();
  // The script path: an ethers Signer over the same KMS key, straight to the node.
  const scripted = new KmsSigner(await signerFor(kms), rpc);
  const removed = await (await new Contract(v3.address, registryV3.abi, scripted).removeWritePermission(writer)).wait();
  for (const receipt of [added, removed]) {
    assert.equal(receipt.status, 1);
    assert.equal(receipt.from, WALLET.address);
  }
  assert.equal(await v3.predecessor(), v1.address);
  assert.deepEqual(await v3.getWriters(), []);
  assert.equal(await v3.owner(), WALLET.address);
  assert.equal(await rpc.getTransactionCount(WALLET.address), 4);
  assert.equal(signs.length, 4, "every transaction was signed by the KMS double");
  assert.ok(signs.every((request) => request.messageType === "DIGEST" && request.signingAlgorithm === "ECDSA_SHA_256"));
  const deployTx = await rpc.getTransaction(v3.deployTransaction.hash);
  assert.equal(deployTx.type, 2);
});
