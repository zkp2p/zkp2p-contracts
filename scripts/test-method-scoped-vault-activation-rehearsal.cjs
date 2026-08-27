#!/usr/bin/env node

process.env.ALCHEMY_API_KEY ||= "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY ||=
  "1111111111111111111111111111111111111111111111111111111111111111";
process.env.TESTNET_DEPLOY_PRIVATE_KEY ||=
  "2222222222222222222222222222222222222222222222222222222222222222";

require(require.resolve("ts-node/register/transpile-only"));
require(require.resolve("module-alias/register"));
const moduleAlias = require(require.resolve("module-alias"));
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const hre = /** @type {any} */ (require("hardhat"));
const { ethers } = hre;

const foundryArtifacts = {
  DisputeMethodScopedVaultCutoverGuard:
    "out/DisputeMethodScopedVaultCutoverGuard.sol/DisputeMethodScopedVaultCutoverGuard.json",
  DisputeMethodScopedVaultCutoverPostcondition:
    "out/DisputeMethodScopedVaultCutoverPostcondition.sol/DisputeMethodScopedVaultCutoverPostcondition.json",
  DisputeMethodScopedVaultWriterRemovalGuard:
    "out/DisputeMethodScopedVaultWriterRemovalGuard.sol/DisputeMethodScopedVaultWriterRemovalGuard.json",
  DisputeMethodScopedVaultWriterRemovalPostcondition:
    "out/DisputeMethodScopedVaultWriterRemovalPostcondition.sol/DisputeMethodScopedVaultWriterRemovalPostcondition.json",
};

/** @param {keyof typeof foundryArtifacts} name */
async function getFactory(name) {
  try {
    return await ethers.getContractFactory(name);
  } catch (error) {
    if (!String(error).includes("HH700")) throw error;
    const artifact = JSON.parse(
      readFileSync(join(process.cwd(), foundryArtifacts[name]), "utf8")
    );
    return new ethers.ContractFactory(
      artifact.abi,
      artifact.bytecode.object,
      (await ethers.getSigners())[0]
    );
  }
}

/** @param {keyof typeof foundryArtifacts} name @param {unknown[]} args */
async function deploy(name, args) {
  const contract = await (await getFactory(name)).deploy(...args);
  await contract.deployed();
  return contract;
}

/** @param {string[]} values */
function trustSurface(values) {
  /** @param {number} index */
  const address = (index) => values[index % values.length];
  return {
    safe: address(0),
    disputeRegistry: address(1),
    orchestrator: address(2),
    orchestratorRegistry: address(3),
    escrowRegistry: address(4),
    paymentVerifierRegistry: address(5),
    relayerRegistry: address(6),
    protocolFeeRecipient: address(7),
    allowMultipleIntents: true,
    freshHook: address(8),
    whitelistPolicy: address(9),
    groupRegistry: address(10),
    attestationVerifier: address(11),
    witnesses: [address(12)],
    disputeVerifier: address(13),
    nullifierRegistryV2: address(14),
    predecessorPolicy: address(15),
    freshPolicy: address(16),
    vaults: { freshVault: address(17), predecessorVault: address(18) },
    predecessorHook: address(19),
    paymentMethods: [ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"))],
    riskWindows: ["86400"],
  };
}

/** @param {Array<{address: string}>} signers */
function signerAddresses(signers) {
  return signers.map((signer) => signer.address);
}

test("lane 40 rehearsal surface uses the Task B vault machinery", () => {
  const lane = require("../deploy/40_activate_method_scoped_vault_stack.ts");
  const activation = require("../deployments/vaultMethodScopedActivation.ts");
  assert.equal(typeof lane.prepareOrExecuteStagingActivation, "function");
  assert.equal(typeof lane.prepareBaseVaultCutoverBatch, "function");
  assert.equal(typeof lane.prepareBaseVaultWriterRemovalBatch, "function");
  assert.equal(typeof lane.releaseMaturedPredecessorIntents, "function");
  assert.equal(typeof activation.buildVaultCutoverTransactions, "function");
  assert.equal(
    typeof activation.buildVaultWriterRemovalTransactions,
    "function"
  );
});

test("Task B dedicated-vault cutover guard and postcondition deploy in-process", async () => {
  const signers = await ethers.getSigners();
  const surface = trustSurface(signerAddresses(signers));
  const guard = await deploy("DisputeMethodScopedVaultCutoverGuard", [
    surface,
    false,
    false,
    [],
    surface.escrowRegistry,
    "0",
  ]);
  const postcondition = await deploy(
    "DisputeMethodScopedVaultCutoverPostcondition",
    [surface]
  );
  assert.ok(guard.address !== ethers.constants.AddressZero);
  assert.ok(postcondition.address !== ethers.constants.AddressZero);
  assert.equal(typeof guard.callStatic.assertReady, "function");
  assert.equal(
    typeof postcondition.callStatic.assertPostconditions,
    "function"
  );
});

test("Task B deferred writer-removal guard and postcondition deploy in-process", async () => {
  const signers = await ethers.getSigners();
  const surface = trustSurface(signerAddresses(signers));
  const guard = await deploy("DisputeMethodScopedVaultWriterRemovalGuard", [
    surface,
    [],
  ]);
  const postcondition = await deploy(
    "DisputeMethodScopedVaultWriterRemovalPostcondition",
    [surface]
  );
  assert.ok(guard.address !== ethers.constants.AddressZero);
  assert.ok(postcondition.address !== ethers.constants.AddressZero);
  assert.equal(typeof guard.callStatic.assertReady, "function");
  assert.equal(
    typeof postcondition.callStatic.assertPostconditions,
    "function"
  );
});
