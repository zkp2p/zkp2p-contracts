// Run after yarn pkg:build; verification uses only local artifacts.
require(require.resolve("ts-node/register/transpile-only"));
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { ethers } = require("ethers");
const { buildDisputeStackManifest } = require("../packages/contracts/scripts/extractors/disputeStack.ts");

const root = join(__dirname, "..");
const networks = /** @type {const} */ (["base", "baseStaging"]);

test("production retirement batch removes only O3 through the registry", () => {
  const batch = require("../deployments/outputs/safe-batches/base_orchestratorv3_retirement.json");
  const registry = require("../deployments/base/OrchestratorRegistry.json");
  const o3 = require("../deployments/base/OrchestratorV3.json");
  const iface = new ethers.utils.Interface(registry.abi);
  assert.equal(batch.version, "1.0");
  assert.equal(batch.chainId, "8453");
  assert.equal(batch.meta.createdFromSafeAddress, "0x0bC26FF515411396DD588Abd6Ef6846E04470227");
  assert.match(batch.meta.description, /nonce 94/);
  assert.deepEqual(batch.transactions, [{
    to: registry.address,
    value: "0",
    data: iface.encodeFunctionData("removeOrchestrator", [o3.address]),
    contractMethod: null,
    contractInputsValues: null,
  }]);
});

test("extraction rejects a missing or mismatched current O4 record", () => {
  for (const network of networks) {
    const output = require(`../deployments/outputs/${network}Contracts.ts`);
    const contracts = (output.default || output).contracts;
    const original = contracts.OrchestratorV4;
    try {
      delete contracts.OrchestratorV4;
      assert.throws(() => buildDisputeStackManifest(network), /OrchestratorV4 address does not match/);
      contracts.OrchestratorV4 = contracts.OrchestratorV3;
      assert.throws(() => buildDisputeStackManifest(network), /OrchestratorV4 address does not match/);
    } finally {
      contracts.OrchestratorV4 = original;
    }
  }
});

test("release verification rejects stale O3 registration and missing O4 on either network", () => {
  const verify = () => spawnSync(process.execPath, ["packages/contracts/scripts/verify-release.mjs"], {
    cwd: root, encoding: "utf8",
  });
  const baseline = verify();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  for (const network of networks) {
    const file = join(root, "packages/contracts/disputeStack", `${network}.json`);
    const original = readFileSync(file, "utf8");
    try {
      for (const mutation of ["register-o3", "authorize-o3", "remove-o4", "omit-retirement"]) {
        const manifest = JSON.parse(original);
        const o3 = manifest.runtimeIdentities.OrchestratorV3.address;
        if (mutation === "register-o3") manifest.expectedRelations.registeredOrchestrator = o3;
        if (mutation === "authorize-o3") manifest.exactAuthorizationSets.authorizedOrchestrators.push(o3);
        if (mutation === "remove-o4") {
          manifest.exactAuthorizationSets.authorizedOrchestrators = manifest.exactAuthorizationSets.authorizedOrchestrators
            .filter(/** @param {string} address */ (address) => address !== manifest.expectedRelations.registeredOrchestrator);
        }
        if (mutation === "omit-retirement") delete manifest.expectedRelations.unregisteredOrchestrator;
        writeFileSync(file, JSON.stringify(manifest));
        const result = verify();
        assert.equal(result.status, 1, `${network}: ${mutation}`);
        assert.match(result.stderr, /dependency relations differ|authorization sets differ/);
      }
    } finally {
      writeFileSync(file, original);
    }
  }
});
