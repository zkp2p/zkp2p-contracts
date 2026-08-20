#!/usr/bin/env node

require(require.resolve("ts-node/register/transpile-only"));

const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const {
  getActiveDisputeDeploymentName,
  getActiveDisputeSelectionStamp,
  normalizeDisputeNetworkName,
  resolveActiveDisputeAliases,
} = require("../deployments/activeDisputeStack.cjs");
const {
  canonicalizeDeploymentOutput,
  serializeDeploymentOutput,
} = require("./canonicalizeDeploymentOutput.ts");
const {
  resolveAddressOutputContracts,
} = require("../packages/contracts/scripts/extractors/addresses.ts");
const {
  resolveAbiOutputContracts,
} = require("../packages/contracts/scripts/extractors/abis.ts");

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
    DisputeProtectionPolicy: deployment(
      "0x0000000000000000000000000000000000000012"
    ),
    IntentLifecycleHookV1: deployment(
      "0x0000000000000000000000000000000000000013"
    ),
    StakeVaultOptIn: deployment("0x0000000000000000000000000000000000000021"),
    DisputeProtectionPolicyOptIn: deployment(
      "0x0000000000000000000000000000000000000022"
    ),
    IntentLifecycleHookV1OptIn: deployment(
      "0x0000000000000000000000000000000000000023"
    ),
  };
}

test("normalizes Hardhat and package network names through one boundary", () => {
  assert.equal(normalizeDisputeNetworkName("base_staging"), "base_staging");
  assert.equal(normalizeDisputeNetworkName("baseStaging"), "base_staging");
  assert.equal(normalizeDisputeNetworkName("base"), "base");
  assert.equal(normalizeDisputeNetworkName("localhost"), "localhost");
  assert.equal(normalizeDisputeNetworkName("hardhat"), "hardhat");
  assert.throws(
    () => normalizeDisputeNetworkName("sepolia"),
    /Unsupported dispute stack network/
  );
});

test("resolves successor records on live networks after the passive deployment", () => {
  assert.deepEqual(resolveActiveDisputeAliases("base", contracts()), {
    OtherContract: deployment("0x0000000000000000000000000000000000000001", []),
    StakeVault: deployment("0x0000000000000000000000000000000000000021"),
    DisputeProtectionPolicy: deployment(
      "0x0000000000000000000000000000000000000022"
    ),
    IntentLifecycleHookV1: deployment(
      "0x0000000000000000000000000000000000000023"
    ),
  });
  assert.equal(
    resolveActiveDisputeAliases("base_staging", contracts()).StakeVault.address,
    "0x0000000000000000000000000000000000000021"
  );
});

test("resolves successor records locally and removes every internal deployment key", () => {
  const resolved = resolveActiveDisputeAliases("hardhat", contracts());

  assert.equal(
    resolved.StakeVault.address,
    "0x0000000000000000000000000000000000000021"
  );
  assert.equal(
    resolved.DisputeProtectionPolicy.address,
    "0x0000000000000000000000000000000000000022"
  );
  assert.equal(
    resolved.IntentLifecycleHookV1.address,
    "0x0000000000000000000000000000000000000023"
  );
  assert.equal(
    Object.keys(resolved).some((name) => name.endsWith("OptIn")),
    false
  );
});

test("returns only known canonical deployment names", () => {
  assert.equal(
    getActiveDisputeDeploymentName("base", "StakeVault"),
    "StakeVaultOptIn"
  );
  assert.equal(
    getActiveDisputeDeploymentName("hardhat", "StakeVault"),
    "StakeVaultOptIn"
  );
  assert.throws(
    () => getActiveDisputeDeploymentName("base", "UnknownPolicy"),
    /Unknown canonical dispute deployment/
  );
});

test("fails closed on missing records and public/internal ABI drift", () => {
  const missing = contracts();
  delete missing.StakeVaultOptIn;
  assert.throws(
    () => resolveActiveDisputeAliases("localhost", missing),
    /Missing active dispute deployment/
  );

  const drifted = contracts();
  drifted.StakeVault.abi = [
    { type: "function", name: "different", inputs: [], outputs: [] },
  ];
  assert.throws(
    () => resolveActiveDisputeAliases("localhost", drifted),
    /ABI mismatch/
  );
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

test("every deployment/package consumer exposes only canonical aliases", () => {
  const input = contracts();
  const consumers =
    /** @type {Array<(value: ReturnType<typeof contracts>) => ReturnType<typeof contracts>>} */ ([
      (value) => resolveActiveDisputeAliases("hardhat", value),
      (value) => resolveAddressOutputContracts("hardhat", value),
      (value) => resolveAbiOutputContracts("hardhat", value),
    ]);
  for (const resolveContracts of consumers) {
    const resolved = resolveContracts(input);
    assert.equal(resolved.StakeVault.address, input.StakeVaultOptIn.address);
    assert.equal(
      resolved.DisputeProtectionPolicy.address,
      input.DisputeProtectionPolicyOptIn.address
    );
    assert.equal(
      resolved.IntentLifecycleHookV1.address,
      input.IntentLifecycleHookV1OptIn.address
    );
    assert.equal(
      Object.keys(resolved).some((name) => name.endsWith("OptIn")),
      false
    );
  }
});

test("accepts only a currently stamped canonical successor output", () => {
  const canonical = /** @type {ReturnType<typeof contracts>} */ (
    resolveActiveDisputeAliases("localhost", contracts())
  );
  const stamp = getActiveDisputeSelectionStamp("localhost");
  const consumers =
    /** @type {Array<(value: ReturnType<typeof contracts>) => ReturnType<typeof contracts>>} */ ([
      (value) => resolveActiveDisputeAliases("localhost", value, stamp),
      (value) => resolveAddressOutputContracts("localhost", value, stamp),
      (value) => resolveAbiOutputContracts("localhost", value, stamp),
    ]);

  for (const resolveContracts of consumers) {
    assert.deepEqual(resolveContracts(canonical), canonical);
  }
  assert.throws(
    () => resolveActiveDisputeAliases("localhost", canonical),
    /Missing active dispute deployment/
  );
  assert.throws(
    () =>
      resolveActiveDisputeAliases("localhost", canonical, {
        ...stamp,
        selectionHash: "0".repeat(64),
      }),
    /selection stamp mismatch/
  );
});

test("canonical deployment-output rewriting is deterministic and leaves deployment evidence untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "active-dispute-output-"));
  const outputPath = join(directory, "localhostContracts.ts");
  const historicalPath = join(directory, "StakeVaultOptIn.json");
  const output = {
    name: "localhost",
    chainId: "31337",
    contracts: contracts(),
  };
  const originalOutput = serializeDeploymentOutput(output);
  const historicalBytes = '{"address":"0x1234","receipt":{"blockNumber":7}}\n';
  try {
    writeFileSync(outputPath, originalOutput);
    writeFileSync(historicalPath, historicalBytes);
    canonicalizeDeploymentOutput("localhost", outputPath);
    const first = readFileSync(outputPath, "utf8");
    canonicalizeDeploymentOutput("localhost", outputPath);
    assert.equal(readFileSync(outputPath, "utf8"), first);
    assert.equal(readFileSync(historicalPath, "utf8"), historicalBytes);
    assert.equal(first.includes("StakeVaultOptIn"), false);
    assert.match(first, new RegExp(inputAddressFor("StakeVaultOptIn"), "i"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** @param {string} name */
function inputAddressFor(name) {
  return contracts()[name].address;
}
