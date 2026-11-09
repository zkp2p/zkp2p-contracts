require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { constants, utils } = require("ethers");
const { verifyBaseO3Retirement } = require("./orchestrator-v4-governance.ts");
const { assertBaseline, verifySuite, releaseToolCommit } = require("./deploy-orchestrator-v4.ts");
const { assertReleaseProvenance } = require("./orchestrator-v4-provenance.ts");

const retirement = {
  address: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
  orchestratorV4: "0x74c55679268FAfB493864915aD16A320AB8c40Ba",
  registry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
  safe: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  safeNonce: 94,
  safeTransactionHash: "0x7d3884d343432f13d433a38603fea28e44cb80b849156099d463f9fd1e697f77",
  transactionHash: "0x85b7c40b779350cdeb6890f84d72375588e1bf930f9fdcd8eeea97aa4ea60dfc",
  blockNumber: 53550556,
  blockHash: "0xe331521b6087f609d6cb148a186a143fd22693bfd43058295d3473ad55070181",
  legacyOrchestrator: "0x88888883Ed048FF0a415271B28b2F52d431810D0",
  followupTransactions: [
    {
      transactionHash: "0x497b6d78199baebce6c1b1c9adcc4b6c2c8422e348e67c63fb85a93eab9a505c",
      blockNumber: 54173646,
      blockHash: "0x35d191318b3f5ed9ba8475660181ab3e4a96f7ccb63d2d51f157b41035cecd81",
      safeNonce: 95,
      safeTransactionHash: "0x27c3e24e1d1c91afa353660e91a26c623a8b497f8a7eee274c0bed05f0580c33",
      transactionTarget: "0x781388759EacB9892f60D77D9A99c9BE2F7F4ada",
      events: [
        { event: "OrchestratorAdded", orchestrator: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7", logIndex: 9 },
        { event: "OrchestratorRemoved", orchestrator: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7", logIndex: 100 },
      ],
    },
    {
      transactionHash: "0x825754eb601dd1ffe71a03c918508421ec9a2a15533f4a5ee195c548e40dfe20",
      blockNumber: 54199685,
      blockHash: "0xbbc8b569470b4b35c6321719d2ec53b0a535f6b01f6c6519cae4ede1978fe8e3",
      safeNonce: 96,
      safeTransactionHash: "0x5a0edfe3396da88550e2c01223a187b31c776ac6b916794857807423530a9c48",
      transactionTarget: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
      events: [
        { event: "OrchestratorRemoved", orchestrator: "0x88888883Ed048FF0a415271B28b2F52d431810D0", logIndex: 7 },
      ],
    },
  ],
};
const registryAbi = new utils.Interface(["function isOrchestrator(address) view returns (bool)", "event OrchestratorRemoved(address indexed orchestrator)", "event OrchestratorAdded(address indexed orchestrator)"]);
const safeAbi = new utils.Interface(["event ExecutionSuccess(bytes32 txHash,uint256 payment)"]);
const other = "0x1111111111111111111111111111111111111111";
function fixture() {
  const manifest = JSON.parse(readFileSync("deployments/outputs/orchestrator-v4-base.json"));
  const config = manifest.configuration, snapshot = structuredClone(manifest.baseline);
  snapshot.blockNumber = retirement.followupTransactions.at(-1).blockNumber + 100001;
  snapshot.predecessor.registered = false;
  const removal = { address: retirement.registry, transactionHash: retirement.transactionHash, blockNumber: retirement.blockNumber, blockHash: retirement.blockHash, logIndex: 828, ...registryAbi.encodeEventLog(registryAbi.getEvent("OrchestratorRemoved"), [retirement.address]) };
  const receipt = { status: 1, to: retirement.safe, transactionHash: retirement.transactionHash, blockNumber: retirement.blockNumber, blockHash: retirement.blockHash, logs: [removal, { address: retirement.safe, ...safeAbi.encodeEventLog(safeAbi.getEvent("ExecutionSuccess"), [retirement.safeTransactionHash, 0]) }] };
  const followupReceipts = retirement.followupTransactions.map(r => ({
    status: 1, to: r.transactionTarget, transactionHash: r.transactionHash, blockNumber: r.blockNumber, blockHash: r.blockHash,
    logs: [...r.events.map(e => ({ address: retirement.registry, transactionHash: r.transactionHash, blockNumber: r.blockNumber, blockHash: r.blockHash, logIndex: e.logIndex, ...registryAbi.encodeEventLog(registryAbi.getEvent(e.event), [e.orchestrator]) })),
      { address: retirement.safe, ...safeAbi.encodeEventLog(safeAbi.getEvent("ExecutionSuccess"), [r.safeTransactionHash, 0]) }],
  }));
  const followupBlocks = retirement.followupTransactions.map(r => ({ hash: r.blockHash }));
  const f = { manifest, config, snapshot, receipt, followupReceipts, followupBlocks, legacyRegistered: false, block: { hash: retirement.blockHash }, logs: [structuredClone(removal), ...followupReceipts.flatMap(r => structuredClone(r.logs.slice(0, -1)))], registered: true, o4: retirement.orchestratorV4, ranges: [] };
  f.provider = {
    getTransactionReceipt: async (hash) => hash === retirement.transactionHash ? f.receipt : f.followupReceipts[retirement.followupTransactions.findIndex(r => r.transactionHash === hash)],
    getBlock: async (height) => height === retirement.blockNumber ? f.block : f.followupBlocks[retirement.followupTransactions.findIndex(r => r.blockNumber === height)],
    call: async (request, blockTag) => {
      assert.equal(request.to, retirement.registry); assert.equal(blockTag, snapshot.blockNumber);
      const address = registryAbi.decodeFunctionData("isOrchestrator", request.data)[0];
      assert.ok([retirement.orchestratorV4, retirement.legacyOrchestrator].includes(address));
      return registryAbi.encodeFunctionResult("isOrchestrator", [address === retirement.orchestratorV4 ? f.registered : f.legacyRegistered]);
    },
    getLogs: async (filter) => {
      assert.equal(filter.address, retirement.registry);
      assert.deepEqual(filter.topics, [[registryAbi.getEventTopic("OrchestratorAdded"), registryAbi.getEventTopic("OrchestratorRemoved")]]);
      assert.ok(filter.toBlock - filter.fromBlock < 50000);
      f.ranges.push([filter.fromBlock, filter.toBlock]);
      return f.logs.filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock);
    },
  };
  return f;
}
const verify = (f) => verifyBaseO3Retirement(f.provider, f.config, f.snapshot, f.o4);

test("Base retirement accepts only the recorded nonce 94-96 events and preserves the deployment baseline", async () => {
  const f = fixture(), before = JSON.stringify(f.manifest);
  assert.deepEqual(await verify(f), retirement);
  assert.equal(f.ranges[0][0], retirement.blockNumber);
  assert.equal(f.ranges.at(-1)[1], f.snapshot.blockNumber);
  for (let i = 1; i < f.ranges.length; i++) assert.equal(f.ranges[i][0], f.ranges[i - 1][1] + 1);
  assert.equal(JSON.stringify(f.manifest), before);
  assert.throws(() => assertBaseline(f.config, f.snapshot, f.manifest), /O3 registration/);
});

for (const [name, mutate, error] of [
  ["O3 re-registered", (f) => { f.snapshot.predecessor.registered = true; }, /O3 must remain unregistered/],
  ["O4 unregistered", (f) => { f.registered = false; }, /O4 must remain registered/],
  ["staging", (f) => { f.config.environment = "base_staging"; }, /Base O3 retirement environment/],
  ["wrong chain", (f) => { f.config.chainId = 1; }, /Base O3 retirement environment/],
  ["different O3", (f) => { f.config.existing.OrchestratorV3.address = other; }, /target mismatch/],
  ["different registry", (f) => { f.config.existing.OrchestratorRegistry.address = other; }, /target mismatch/],
  ["different Safe", (f) => { f.config.governance = other; }, /target mismatch/],
  ["different O4", (f) => { f.o4 = other; }, /target mismatch/],
  ["pre-retirement snapshot", (f) => { f.snapshot.blockNumber = retirement.blockNumber - 1; }, /predates/],
  ["missing receipt", (f) => { f.receipt = null; }, /receipt mismatch/],
  ["reverted receipt", (f) => { f.receipt.status = 0; }, /receipt mismatch/],
  ["wrong transaction", (f) => { f.receipt.transactionHash = constants.HashZero; }, /receipt mismatch/],
  ["wrong block", (f) => { f.receipt.blockNumber++; }, /receipt mismatch/],
  ["wrong block hash", (f) => { f.receipt.blockHash = constants.HashZero; }, /receipt mismatch/],
  ["wrong transaction target", (f) => { f.receipt.to = other; }, /receipt mismatch/],
  ["reorg", (f) => { f.block.hash = constants.HashZero; }, /not canonical/],
  ["missing block", (f) => { f.block = null; }, /not canonical/],
  ["wrong removal emitter", (f) => { f.receipt.logs[0].address = other; }, /exact OrchestratorRemoved/],
  ["wrong removed address", (f) => { f.receipt.logs[0].topics[1] = utils.hexZeroPad(other, 32); }, /exact OrchestratorRemoved/],
  ["duplicate removal", (f) => f.receipt.logs.push(f.receipt.logs[0]), /exact OrchestratorRemoved/],
  ["missing Safe success", (f) => f.receipt.logs.pop(), /exact Safe ExecutionSuccess/],
  ["wrong Safe emitter", (f) => { f.receipt.logs[1].address = other; }, /exact Safe ExecutionSuccess/],
  ["wrong Safe call", (f) => { f.receipt.logs[1].data = safeAbi.encodeEventLog(safeAbi.getEvent("ExecutionSuccess"), [constants.HashZero, 0]).data; }, /exact Safe ExecutionSuccess/],
  ["unexpected Safe payment", (f) => { f.receipt.logs[1].data = safeAbi.encodeEventLog(safeAbi.getEvent("ExecutionSuccess"), [retirement.safeTransactionHash, 1]).data; }, /exact Safe ExecutionSuccess/],
  ["missing registry history", (f) => { f.logs = []; }, /Unexpected Base orchestrator registry/],
  ["new registry member", (f) => f.logs.push({ ...f.logs[0], blockNumber: f.snapshot.blockNumber, ...registryAbi.encodeEventLog(registryAbi.getEvent("OrchestratorAdded"), [other]) }), /Unexpected Base orchestrator registry/],
  ["another removal in the retirement block", (f) => f.logs.push({ ...f.logs[0], logIndex: 829, ...registryAbi.encodeEventLog(registryAbi.getEvent("OrchestratorRemoved"), [other]) }), /Unexpected Base orchestrator registry/],
  ["O3 re-added then removed", (f) => f.logs.push({ ...f.logs[0], blockNumber: f.snapshot.blockNumber - 1, ...registryAbi.encodeEventLog(registryAbi.getEvent("OrchestratorAdded"), [retirement.address]) }, { ...f.logs[0], blockNumber: f.snapshot.blockNumber }), /Unexpected Base orchestrator registry/],
]) test(`Base retirement rejects ${name}`, async () => { const f = fixture(); mutate(f); await assert.rejects(verify(f), error); });

for (const [name, mutate, error] of [
  ["legacy orchestrator still registered", f => { f.legacyRegistered = true; }, /Legacy orchestrator must remain unregistered/],
  ["snapshot before the final recorded removal", f => { f.snapshot.blockNumber = retirement.followupTransactions[1].blockNumber - 1; }, /predates/],
  ["missing atomic addition", f => { f.logs.splice(1, 1); }, /Unexpected Base orchestrator/],
  ["missing atomic removal", f => { f.logs.splice(2, 1); }, /Unexpected Base orchestrator/],
  ["atomic events reversed", f => { [f.logs[1], f.logs[2]] = [f.logs[2], f.logs[1]]; }, /Unexpected Base orchestrator/],
  ["atomic removal in another transaction", f => { f.logs[2].transactionHash = constants.HashZero; }, /Unexpected Base orchestrator/],
  ["legacy removal in another block", f => { f.logs[3].blockNumber++; }, /Unexpected Base orchestrator/],
  ["unrecorded removal after final event", f => { f.logs.push({ ...f.logs[3], blockNumber: f.snapshot.blockNumber }); }, /Unexpected Base orchestrator/],
]) test(`Base retirement rejects ${name}`, async () => { const f = fixture(); mutate(f); await assert.rejects(verify(f), error); });

for (const index of [0, 1]) for (const [name, mutate, error] of [
  ["missing receipt", (f, i) => { f.followupReceipts[i] = null; }, /receipt mismatch/],
  ["reverted receipt", (f, i) => { f.followupReceipts[i].status = 0; }, /receipt mismatch/],
  ["wrong tx", (f, i) => { f.followupReceipts[i].transactionHash = constants.HashZero; }, /receipt mismatch/],
  ["wrong block", (f, i) => { f.followupReceipts[i].blockNumber++; }, /receipt mismatch/],
  ["wrong block hash", (f, i) => { f.followupReceipts[i].blockHash = constants.HashZero; }, /receipt mismatch/],
  ["noncanonical block", (f, i) => { f.followupBlocks[i].hash = constants.HashZero; }, /not canonical/],
  ["wrong emitter", (f, i) => { f.followupReceipts[i].logs[0].address = other; }, /exact registry events/],
  ["wrong member", (f, i) => { f.followupReceipts[i].logs[0].topics[1] = utils.hexZeroPad(other, 32); }, /exact registry events/],
  ["wrong event position", (f, i) => { f.followupReceipts[i].logs[0].logIndex++; }, /exact registry events/],
  ["duplicate event", (f, i) => { f.followupReceipts[i].logs.push(f.followupReceipts[i].logs[0]); }, /exact registry events/],
  ["missing Safe success", (f, i) => { f.followupReceipts[i].logs.pop(); }, /exact Safe ExecutionSuccess/],
  ["wrong Safe hash", (f, i) => { f.followupReceipts[i].logs.at(-1).data = safeAbi.encodeEventLog(safeAbi.getEvent("ExecutionSuccess"), [constants.HashZero, 0]).data; }, /exact Safe ExecutionSuccess/],
]) test(`Base retirement nonce ${95 + index} rejects ${name}`, async () => { const f = fixture(); mutate(f, index); await assert.rejects(verify(f), error); });

test("Base retirement evidence cannot enable staging or passive verification", async () => {
  const f = fixture();
  for (const [environment, active] of [["base_staging", true], ["base", false]]) {
    const manifest = { ...f.manifest, configuration: { ...f.config, environment } };
    await assert.rejects(verifySuite({}, { manifest }, active, {}), /requires active Base/);
  }
  f.manifest.executionToolCommit = "a".repeat(40); f.manifest.verificationToolCommit = "b".repeat(40);
  assert.equal(releaseToolCommit(f.manifest, "verify"), "b".repeat(40));
  assert.equal(releaseToolCommit(f.manifest, "prepare-governance"), "a".repeat(40));
  f.config.environment = "base_staging";
  assert.equal(releaseToolCommit(f.manifest, "verify"), "a".repeat(40));
});

test("Base source provenance excludes only the exact archive README; staging remains exact", () => {
  const directory = mkdtempSync(join(tmpdir(), "o4-retirement-provenance-")), previous = process.cwd();
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (path, value) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), value); };
  const readme = "contracts/archive/README.md";
  const protectedPaths = ["contracts/OrchestratorV4.sol", "contracts/archive/Orchestrator.sol", "contracts/archive/OTHER.md", "contracts/archive/README.md.sol", "contracts/README.md", "hardhat.config.ts", "scripts/verify-orchestrator-v4-source.ts", "deployments/canonicalDeployment.ts", "deployments/orchestrator-v4/base.json"];
  try {
    git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    for (const path of [readme, ...protectedPaths]) write(path, "original");
    git("add", "."); git("commit", "-m", "source"); const source = git("rev-parse", "HEAD");
    write(readme, "recorded retirement"); git("add", "."); git("commit", "-m", "retirement documentation");
    process.chdir(directory);
    assert.doesNotThrow(() => assertReleaseProvenance(source, source, "base"));
    assert.throws(() => assertReleaseProvenance(source, source, "base_staging"));
    for (const path of protectedPaths) {
      write(path, "source drift"); assert.throws(() => assertReleaseProvenance(source, git("rev-parse", "HEAD"), "base"), path);
      git("add", "."); git("commit", "-m", "drift");
      assert.throws(() => assertReleaseProvenance(source, git("rev-parse", "HEAD"), "base"), path);
      git("restore", "--source", source, path); git("add", "."); git("commit", "-m", "restore");
    }
    rmSync(join(directory, readme)); write(`${readme}/Hidden.sol`, "source drift");
    git("add", "."); git("commit", "-m", "README directory must not hide source");
    assert.throws(() => assertReleaseProvenance(source, git("rev-parse", "HEAD"), "base"));
  } finally { process.chdir(previous); rmSync(directory, { recursive: true, force: true }); }
});
