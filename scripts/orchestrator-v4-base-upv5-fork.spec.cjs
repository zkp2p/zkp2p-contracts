const assert = require("node:assert/strict");
const { test } = require("node:test");

// main's `yarn upv5:safe-batches hash` at 99a3895f (contracts #400): the MultiSend data keccak, which no Safe nonce changes.
const MAIN_BATCH_DATA_KECCAK = "0xdceb80fb748ee77ca6ff949f1f4fab60b88ce2495238c0f4d023d715d4341e14";

// Decide before loading Hardhat/config/dotenv. Never discover a fork URL from a local file.
test("main's Base UPV5 Safe batch on an anvil fork: untouched and complete verify, every later prefix fails", {
  skip: process.env.O4_UPV5_FORK_RPC_URL ? false : "O4_UPV5_FORK_RPC_URL is unset",
}, async () => {
  // Every write below is an impersonated Safe call. Refuse anything but a local anvil before the first request.
  const url = new URL(process.env.O4_UPV5_FORK_RPC_URL);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "O4_UPV5_FORK_RPC_URL must be a local anvil");
  require("ts-node/register/transpile-only");
  const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { VoidSigner, providers, utils } = require("ethers");
  const provider = new providers.StaticJsonRpcProvider(url.href, 8453);
  assert.match(await provider.send("web3_clientVersion", []), /^anvil\//, "O4_UPV5_FORK_RPC_URL must be anvil");
  const hre = require("hardhat");
  const { inspect, verifySuite, verifyBaseUpv5Cutover, TransactionJournal } = require("./deploy-orchestrator-v4.ts");
  const { BASE_GOVERNANCE_CHANGES, BASE_UPV5_CUTOVER } = require("./orchestrator-v4-provenance.ts");
  const manifest = JSON.parse(readFileSync("deployments/outputs/orchestrator-v4-base.json", "utf8")), c = manifest.configuration;
  const pins = JSON.parse(readFileSync(BASE_UPV5_CUTOVER, "utf8")), governance = JSON.parse(readFileSync(BASE_GOVERNANCE_CHANGES, "utf8"));
  // Only the provider is the fork's; artifacts, records and the configuration are this checkout's.
  const fork = { ...hre, ethers: { provider } };

  // main's buildUpv5CutoverCalls order: both NullifierRegistryV2 writers, UPV5's V3 grant, every route removed from
  // the tail and re-added in order on UPV5 with its currencies, then the dispute verifier.
  const calls = [
    ...pins.retiredNullifierWriters.map((writer) => [c.existing.NullifierRegistryV2.address, "removeWritePermission(address)", [writer]]),
    [pins.nullifierRegistryV3.address, "addWritePermission(address)", [pins.unifiedPaymentVerifierV5.address]],
    ...[...c.paymentMethods].reverse().map(({ method }) => [c.existing.PaymentVerifierRegistry.address, "removePaymentMethod(bytes32)", [method]]),
    ...c.paymentMethods.map(({ method, currencies }) => [c.existing.PaymentVerifierRegistry.address, "addPaymentMethod(bytes32,address,bytes32[])", [method, pins.unifiedPaymentVerifierV5.address, currencies]]),
    [manifest.contracts.DisputeProtectionPolicyV2.address, "setDisputeVerifier(address)", [pins.disputeVerifierV2.address]],
  ].map(([to, signature, args]) => ({ to, data: new utils.Interface([`function ${signature}`]).encodeFunctionData(signature, args) }));
  assert.equal(calls.length, 30);
  const packed = utils.hexConcat(calls.map(({ to, data }) => utils.solidityPack(["uint8", "address", "uint256", "uint256", "bytes"], [0, to, 0, utils.hexDataLength(data), data])));
  assert.equal(utils.keccak256(new utils.Interface(["function multiSend(bytes)"]).encodeFunctionData("multiSend", [packed])), MAIN_BATCH_DATA_KECCAK);

  const restore = await provider.send("evm_snapshot", []);
  const directory = mkdtempSync(join(tmpdir(), "o4-base-upv5-fork-"));
  try {
    const classify = async () => verifyBaseUpv5Cutover(fork, manifest, pins, await inspect(fork, c));
    assert.equal((await classify()).state, "untouched");
    await provider.send("anvil_impersonateAccount", [c.governance]);
    await provider.send("anvil_setBalance", [c.governance, utils.hexValue(utils.parseEther("1"))]);
    const safe = provider.getSigner(c.governance);
    for (const [index, call] of calls.entries()) {
      assert.equal((await (await safe.sendTransaction(call)).wait()).status, 1);
      // Removing only UPV3 is a writer set the release checks already admit; every later prefix short of the batch fails.
      if (index === 0) assert.equal((await classify()).state, "untouched");
      else if (index < calls.length - 1) await assert.rejects(classify(), /Base UPV5 cutover is incomplete/, `prefix ${index + 1}`);
    }
    assert.deepEqual(await classify(), { state: "complete", ...pins });
    // The whole read-only gate on the post-batch state: rejected without the pins, accepted with them.
    const journal = () => new TransactionJournal(join(directory, "orchestrator-v4-base.json.verification"), JSON.parse(JSON.stringify(manifest)), new VoidSigner(c.signer, provider));
    await assert.rejects(verifySuite(fork, journal(), true, governance), /Unrecognized payment verifier/);
    const verified = journal();
    await verifySuite(fork, verified, true, governance, pins);
    assert.equal(verified.manifest.verification.active, true);
    assert.deepEqual(verified.manifest.verification.upv5Cutover, { state: "complete", ...pins });
    console.log(`Base UPV5 fork verification: complete at block ${verified.manifest.verification.verifiedAtBlock}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await provider.send("anvil_stopImpersonatingAccount", [c.governance]);
    await provider.send("evm_revert", [restore]);
  }
});
