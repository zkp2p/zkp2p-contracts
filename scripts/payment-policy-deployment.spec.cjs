#!/usr/bin/env node

require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const hre = require("hardhat");
const {
  historicalDisputeArtifact,
  withHistoricalDisputeArtifacts,
} = require("../deployments/historicalDisputeArtifacts");
const lane = require("../deploy/43_deploy_local_payment_policy_stack").default;

// These tests run serially because artifact resolution belongs to one deployment invocation.
test("historical resolution uses executed artifacts and restores current ABI even on failure", async () => {
  const readers = [hre.artifacts.readArtifact, hre.deployments.getExtendedArtifact, hre.deployments.deploy];
  const current = await hre.artifacts.readArtifact("DisputeProtectionPolicy");
  assert(current.abi.some((entry) => entry.name === "getPolicyIntent"));
  assert(!current.abi.some((entry) => entry.name === "getRiskWindow"));
  const failure = new Error("rehearsal failed");
  await assert.rejects(withHistoricalDisputeArtifacts(hre, async () => {
    for (const name of ["DisputeProtectionPolicy", "IntentLifecycleHookV1"]) {
      const historical = historicalDisputeArtifact(name);
      assert.equal((await hre.artifacts.readArtifact(name)).bytecode, historical.bytecode);
      assert.equal((await hre.deployments.getExtendedArtifact(name)).bytecode, historical.bytecode);
    }
    const historical = await hre.artifacts.readArtifact("DisputeProtectionPolicy");
    assert(historical.abi.some((entry) => entry.name === "getRiskWindow"));
    assert(!historical.abi.some((entry) => entry.name === "getPolicyIntent"));
    throw failure;
  }), (error) => error === failure);
  assert.deepEqual([hre.artifacts.readArtifact, hre.deployments.getExtendedArtifact, hre.deployments.deploy], readers);
  assert.deepEqual(await hre.artifacts.readArtifact("DisputeProtectionPolicy"), current);
});

test("local successor refuses live execution before any account or chain access", async () => {
  const originalTag = process.env.DEPLOY_ACTIVE_TAG;
  try {
    for (const network of ["base", "base_staging", "sepolia"]) {
      const live = { deployments: { getNetworkName: () => network } };
      delete process.env.DEPLOY_ACTIVE_TAG;
      assert.equal(await lane.skip(live), true);
      await assert.rejects(lane(live), /local-only/);
      process.env.DEPLOY_ACTIVE_TAG = "43_deploy_local_payment_policy_stack";
      await assert.rejects(lane.skip(live), /local-only/);
    }
  } finally {
    if (originalTag === undefined) delete process.env.DEPLOY_ACTIVE_TAG;
    else process.env.DEPLOY_ACTIVE_TAG = originalTag;
  }
});
