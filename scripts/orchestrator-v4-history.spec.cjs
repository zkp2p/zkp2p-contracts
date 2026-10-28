require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { utils } = require("ethers");
const { HISTORICAL_ABI_DEPLOYMENTS } = require("../packages/contracts/scripts/extractors/abis.ts");
const { releasePaths } = require("./orchestrator-v4-provenance.ts");

const root = resolve(__dirname, "..");
const archive = "deployments/orchestrator-v4/historical/2026-10-22";
const read = (path) => readFileSync(resolve(root, path));
const provenance = JSON.parse(read(`${archive}/provenance.json`));
const manifest = JSON.parse(read(`${archive}/orchestrator-v4-base_staging.json`));

test("October 22 records and evidence retain their exact archived bytes and source provenance", () => {
  assert.equal(manifest.sourceCommit, "cd849c5383a274a4c970d7bb6231e032285fd9a2");
  assert.equal(provenance.sourceCommit, manifest.sourceCommit);
  assert.equal(manifest.configurationHash, createHash("sha256").update(JSON.stringify(manifest.configuration)).digest("hex"));
  assert.equal(manifest.verification.active, false);
  assert.equal(manifest.transactions.length, 23);
  assert.deepEqual(manifest.transactions.map((tx) => tx.nonce), Array.from({ length: 23 }, (_, i) => 26 + i));
  for (const file of provenance.files) {
    assert.equal(createHash("sha256").update(read(file.path)).digest("hex"), file.sha256, file.path);
  }
});

test("October 22 package aliases use deployed ABIs and never alias historical addresses to current names", () => {
  const output = require("../deployments/outputs/baseStagingContracts.ts").default.contracts;
  const protectedPaths = releasePaths("base_staging").execution;
  assert.ok(protectedPaths.includes(archive));
  assert.equal(Object.keys(manifest.contracts).length, 7);
  for (const [name, contract] of Object.entries(manifest.contracts)) {
    const alias = `${name}Historical20261022`;
    const path = `deployments/base_staging/${alias}.json`;
    const record = JSON.parse(read(path));
    assert.ok(HISTORICAL_ABI_DEPLOYMENTS.includes(alias), alias);
    assert.ok(protectedPaths.includes(path), path);
    assert.equal(record.address, contract.address);
    assert.equal(record.transactionHash, contract.transactionHash);
    assert.deepEqual(record.args, contract.constructorArguments);
    const tx = manifest.transactions.find((tx) => tx.step === `deploy:${name}`);
    assert.equal(tx.data, record.bytecode + new utils.Interface(record.abi).encodeDeploy(record.args).slice(2));
    assert.deepEqual(output[alias], { address: record.address, abi: record.abi });
    assert.notEqual(output[name]?.address?.toLowerCase(), record.address.toLowerCase());
  }
});
