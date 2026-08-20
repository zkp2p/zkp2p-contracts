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
// @ts-expect-error module-alias does not publish declarations.
const moduleAlias = require("module-alias");

dotenv.config = () => ({ parsed: {} });
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

const historicalLaneModule = require("../deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts");
const historicalLane = historicalLaneModule.default;
const { PREDECESSOR_DISPUTE_STACKS } = historicalLaneModule;

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
                return name === codeDrift ? "0x00" : artifact.deployedBytecode;
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
  assert.equal(await historicalLane.skip(localHre("localhost")), true);
  assert.equal(await historicalLane.skip(localHre("hardhat")), true);

  /** @type {Array<"base" | "base_staging">} */
  const liveNetworks = ["base_staging", "base"];
  for (const network of liveNetworks) {
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
  }

  assert.deepEqual(historicalLane.dependencies || [], []);
  assert.deepEqual(historicalLane.tags, ["32_historical_dispute_lifecycle_stack"]);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
