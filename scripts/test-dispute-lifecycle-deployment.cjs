#!/usr/bin/env node

process.env.ALCHEMY_API_KEY = "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
process.env.TESTNET_DEPLOY_PRIVATE_KEY =
  "2222222222222222222222222222222222222222222222222222222222222222";

// @ts-expect-error Runtime registration entrypoint has no declaration file.
require("ts-node/register/transpile-only");
// @ts-expect-error Runtime registration entrypoint has no declaration file.
require("module-alias/register");

const assert = require("node:assert/strict");
const path = require("node:path");
const dotenv = require("dotenv");
const { ethers } = require("ethers");
// @ts-expect-error module-alias does not publish declarations.
const moduleAlias = require("module-alias");

dotenv.config = () => ({ parsed: {} });
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

const historicalLaneModule = require("../deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts");
const historicalLane = historicalLaneModule.default;
const { PREDECESSOR_DISPUTE_STACKS } = historicalLaneModule;

/** @type {Record<string, Record<string, string>>} */
const EXPECTED_RUNTIME_HASHES = {
  base: {
    StakeVault: "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
    DisputeProtectionPolicy: "0xf08bce9ad622b9d45ce310493627cbef3bf6c4ac915661d5bc572bb59b61e084",
    IntentLifecycleHookV1: "0xff9db07ce83908b7cedb31f8c085004aa78c91bb86e0565f11fad3e4bc36c5cb",
    DisputeVerifier: "0x65246e11392befc33d92246cf3ac2467d1f338a8b73c6514b76fab0a70a01ead",
    DisputeNullifierRegistry: "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
  },
  base_staging: {
    StakeVault: "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
    DisputeProtectionPolicy: "0x4e6617a94819ad15693289b173a9a66a78cfe1dd706f6b4fdc5a5f6ad6a32971",
    IntentLifecycleHookV1: "0xba70239e37624f5808e2f79e100e83a17daeb1558f310543187f5d8a121ec367",
    DisputeVerifier: "0xb3b34734cfd162cd129d0c84285461c751321545213ec20164745b8e72f9dd6c",
    DisputeNullifierRegistry: "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
  },
};

/** @type {Record<string, string>} */
const MOCK_RUNTIME_CODES = {
  StakeVault: "0x6001",
  DisputeProtectionPolicy: "0x6002",
  IntentLifecycleHookV1: "0x6003",
  DisputeVerifier: "0x6004",
  DisputeNullifierRegistry: "0x6005",
};

/** @param {string} network */
function localHre(network) {
  return {
    deployments: {
      getNetworkName: () => network,
      get: async () => {
        throw new Error("local historical lane must not read deployment records");
      },
    },
    ethers: {
      provider: {
        getCode: async () => {
          throw new Error("local historical lane must not read chain code");
        },
      },
    },
  };
}

/**
 * @param {"base" | "base_staging"} network
 * @param {{ omit?: string, addressDrift?: string, codeDrift?: string }} [options]
 */
function liveHre(network, { omit, addressDrift, codeDrift } = {}) {
  const deployments = new Map();
  for (const name of Object.keys(PREDECESSOR_DISPUTE_STACKS[network].contracts)) {
    if (name === omit) continue;
    const artifact = require(path.join(process.cwd(), "deployments", network, `${name}.json`));
    deployments.set(name, {
      ...artifact,
      address:
        name === addressDrift ? "0x0000000000000000000000000000000000000001" : artifact.address,
    });
  }

  let deployCalls = 0;
  let rawTransactions = 0;
  return {
    hre: {
      deployments: {
        getNetworkName: () => network,
        get: async (/** @type {string} */ name) => {
          if (!deployments.has(name)) throw new Error(`Missing deployment: ${name}`);
          return deployments.get(name);
        },
        deploy: async () => {
          deployCalls += 1;
          throw new Error("historical lane must not deploy");
        },
        rawTx: async () => {
          rawTransactions += 1;
          throw new Error("historical lane must not send transactions");
        },
      },
      ethers: {
        provider: {
          getCode: async (/** @type {string} */ address) => {
            for (const [name, artifact] of deployments) {
              if (artifact.address.toLowerCase() === address.toLowerCase()) {
                return name === codeDrift ? "0x00" : MOCK_RUNTIME_CODES[name];
              }
            }
            return "0x";
          },
        },
      },
    },
    mutationCounts: () => ({ deployCalls, rawTransactions }),
  };
}

async function run() {
  assert.ok(PREDECESSOR_DISPUTE_STACKS, "historical predecessor evidence is not exported");
  assert.deepEqual(PREDECESSOR_DISPUTE_STACKS.base_staging.activeLifecycleHook, {
    address: "0x19D9F0Fcb08C60D8bd0CD061C34eae27eF8b6e65",
    runtimeCodeHash: "0xba70239e37624f5808e2f79e100e83a17daeb1558f310543187f5d8a121ec367",
  });
  assert.equal(await historicalLane.skip(localHre("localhost")), true);
  assert.equal(await historicalLane.skip(localHre("hardhat")), true);

  /** @type {Array<"base" | "base_staging">} */
  const liveNetworks = ["base_staging", "base"];
  for (const network of liveNetworks) {
    for (const [name, evidence] of Object.entries(PREDECESSOR_DISPUTE_STACKS[network].contracts)) {
      const artifact = require(path.join(process.cwd(), "deployments", network, `${name}.json`));
      assert.equal(
        evidence.deploymentBytecodeHash,
        ethers.utils.keccak256(artifact.deployedBytecode),
        `${network} ${name} must pin its deployment artifact separately from live runtime code`,
      );
      assert.equal(evidence.runtimeCodeHash, EXPECTED_RUNTIME_HASHES[network][name]);
    }

    const originalRuntimeHashes = Object.fromEntries(
      Object.entries(PREDECESSOR_DISPUTE_STACKS[network].contracts).map(([name, evidence]) => [
        name,
        evidence.runtimeCodeHash,
      ]),
    );
    try {
      for (const [name, evidence] of Object.entries(PREDECESSOR_DISPUTE_STACKS[network].contracts)) {
        evidence.runtimeCodeHash = ethers.utils.keccak256(MOCK_RUNTIME_CODES[name]);
      }

      const exact = liveHre(network);
      assert.equal(await historicalLane.skip(exact.hre), true);
      await historicalLane(exact.hre);
      assert.deepEqual(exact.mutationCounts(), { deployCalls: 0, rawTransactions: 0 });

      await assert.rejects(
        historicalLane.skip(liveHre(network, { omit: "StakeVault" }).hre),
        /Missing predecessor deployment StakeVault/,
      );
      await assert.rejects(
        historicalLane.skip(liveHre(network, { addressDrift: "DisputeProtectionPolicy" }).hre),
        /predecessor address mismatch/,
      );
      await assert.rejects(
        historicalLane.skip(liveHre(network, { codeDrift: "IntentLifecycleHookV1" }).hre),
        /predecessor runtime bytecode hash mismatch/,
      );
    } finally {
      for (const [name, runtimeCodeHash] of Object.entries(originalRuntimeHashes)) {
        PREDECESSOR_DISPUTE_STACKS[network].contracts[name].runtimeCodeHash = runtimeCodeHash;
      }
    }
  }

  assert.deepEqual(historicalLane.dependencies || [], []);
  assert.deepEqual(historicalLane.tags, ["32_historical_dispute_lifecycle_stack"]);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
