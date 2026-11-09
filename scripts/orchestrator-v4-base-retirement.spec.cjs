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
};
const registryAbi = new utils.Interface(["function isOrchestrator(address) view returns (bool)", "event OrchestratorRemoved(address indexed orchestrator)", "event OrchestratorAdded(address indexed orchestrator)"]);
const safeAbi = new utils.Interface(["event ExecutionSuccess(bytes32 txHash,uint256 payment)"]);
const other = "0x1111111111111111111111111111111111111111";
function fixture() {
  const manifest = JSON.parse(readFileSync("deployments/outputs/orchestrator-v4-base.json"));
  const config = manifest.configuration, snapshot = structuredClone(manifest.baseline);
  snapshot.blockNumber = retirement.blockNumber + 100001;
  snapshot.predecessor.registered = false;
  const removal = { address: retirement.registry, transactionHash: retirement.transactionHash, blockNumber: retirement.blockNumber, blockHash: retirement.blockHash, logIndex: 828, ...registryAbi.encodeEventLog(registryAbi.getEvent("OrchestratorRemoved"), [retirement.address]) };
  const receipt = { status: 1, to: retirement.safe, transactionHash: retirement.transactionHash, blockNumber: retirement.blockNumber, blockHash: retirement.blockHash, logs: [removal, { address: retirement.safe, ...safeAbi.encodeEventLog(safeAbi.getEvent("ExecutionSuccess"), [retirement.safeTransactionHash, 0]) }] };
  const f = { manifest, config, snapshot, receipt, block: { hash: retirement.blockHash }, logs: [removal], registered: true, o4: retirement.orchestratorV4, ranges: [] };
  f.provider = {
    getTransactionReceipt: async (hash) => { assert.equal(hash, retirement.transactionHash); return f.receipt; },
    getBlock: async (height) => { assert.equal(height, retirement.blockNumber); return f.block; },
    call: async (request, blockTag) => {
      assert.equal(request.to, retirement.registry); assert.equal(blockTag, snapshot.blockNumber);
      assert.equal(registryAbi.decodeFunctionData("isOrchestrator", request.data)[0], retirement.orchestratorV4);
      return registryAbi.encodeFunctionResult("isOrchestrator", [f.registered]);
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

test("Base retirement accepts only the executed O3 removal and preserves the deployment baseline", async () => {
  const f = fixture(), before = JSON.stringify(f.manifest);
  assert.deepEqual(await verify(f), retirement);
  assert.deepEqual(f.ranges, [[53550556, 53600555], [53600556, 53650555], [53650556, 53650557]]);
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
