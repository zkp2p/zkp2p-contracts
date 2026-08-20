#!/usr/bin/env node

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  getActiveDisputeDeploymentName,
  normalizeDisputeNetworkName,
  resolveActiveDisputeAliases,
} = require("../deployments/activeDisputeStack.cjs");

const ABI = [{ type: "function", name: "owner", inputs: [], outputs: [] }];

/**
 * @param {string} address
 * @param {unknown[]} abi
 */
function deployment(address, abi = ABI) {
  return { address, abi };
}

/** @returns {Record<string, { address: string, abi: unknown[] }>} */
function contracts() {
  return {
    OtherContract: deployment("0x0000000000000000000000000000000000000001", []),
    StakeVault: deployment("0x0000000000000000000000000000000000000011"),
    DisputeProtectionPolicy: deployment("0x0000000000000000000000000000000000000012"),
    IntentLifecycleHookV1: deployment("0x0000000000000000000000000000000000000013"),
    StakeVaultOptIn: deployment("0x0000000000000000000000000000000000000021"),
    DisputeProtectionPolicyOptIn: deployment("0x0000000000000000000000000000000000000022"),
    IntentLifecycleHookV1OptIn: deployment("0x0000000000000000000000000000000000000023"),
  };
}

test("normalizes Hardhat and package network names through one boundary", () => {
  assert.equal(normalizeDisputeNetworkName("base_staging"), "base_staging");
  assert.equal(normalizeDisputeNetworkName("baseStaging"), "base_staging");
  assert.equal(normalizeDisputeNetworkName("base"), "base");
  assert.equal(normalizeDisputeNetworkName("localhost"), "localhost");
  assert.equal(normalizeDisputeNetworkName("hardhat"), "hardhat");
  assert.throws(() => normalizeDisputeNetworkName("sepolia"), /Unsupported dispute stack network/);
});

test("resolves predecessor records on live networks before the successor deployment", () => {
  assert.deepEqual(resolveActiveDisputeAliases("base", contracts()), {
    OtherContract: deployment("0x0000000000000000000000000000000000000001", []),
    StakeVault: deployment("0x0000000000000000000000000000000000000011"),
    DisputeProtectionPolicy: deployment("0x0000000000000000000000000000000000000012"),
    IntentLifecycleHookV1: deployment("0x0000000000000000000000000000000000000013"),
  });
});

test("resolves successor records locally and removes every internal deployment key", () => {
  const resolved = resolveActiveDisputeAliases("hardhat", contracts());

  assert.equal(resolved.StakeVault.address, "0x0000000000000000000000000000000000000021");
  assert.equal(
    resolved.DisputeProtectionPolicy.address,
    "0x0000000000000000000000000000000000000022",
  );
  assert.equal(
    resolved.IntentLifecycleHookV1.address,
    "0x0000000000000000000000000000000000000023",
  );
  assert.equal(Object.keys(resolved).some((name) => name.endsWith("OptIn")), false);
});

test("returns only known canonical deployment names", () => {
  assert.equal(getActiveDisputeDeploymentName("base", "StakeVault"), "StakeVault");
  assert.equal(getActiveDisputeDeploymentName("hardhat", "StakeVault"), "StakeVaultOptIn");
  assert.throws(
    () => getActiveDisputeDeploymentName("base", "UnknownPolicy"),
    /Unknown canonical dispute deployment/,
  );
});

test("fails closed on missing records and public/internal ABI drift", () => {
  const missing = contracts();
  delete missing.StakeVaultOptIn;
  assert.throws(() => resolveActiveDisputeAliases("localhost", missing), /Missing active dispute deployment/);

  const drifted = contracts();
  drifted.StakeVault.abi = [{ type: "function", name: "different", inputs: [], outputs: [] }];
  assert.throws(() => resolveActiveDisputeAliases("localhost", drifted), /ABI mismatch/);
});

test("does not mutate its input or expose one internal record twice", () => {
  const input = contracts();
  const snapshot = structuredClone(input);
  const resolved = resolveActiveDisputeAliases("localhost", input);

  assert.deepEqual(input, snapshot);
  const exposedAddresses = [
    resolved.StakeVault.address,
    resolved.DisputeProtectionPolicy.address,
    resolved.IntentLifecycleHookV1.address,
  ];
  assert.equal(new Set(exposedAddresses).size, exposedAddresses.length);
});
