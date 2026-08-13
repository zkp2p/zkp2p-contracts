#!/usr/bin/env node

process.env.DEPLOY_TX_DELAY_MS = "0";
process.env.ALCHEMY_API_KEY ||= "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY ||=
  "1111111111111111111111111111111111111111111111111111111111111111";
process.env.TESTNET_DEPLOY_PRIVATE_KEY ||=
  "2222222222222222222222222222222222222222222222222222222222222222";

require("ts-node/register/transpile-only");
require("module-alias/register");

const moduleAlias = require("module-alias");
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

const assert = require("node:assert/strict");
const test = require("node:test");
const { BigNumber, utils } = require("ethers");

const { MULTI_SIG } = require("../deployments/parameters.ts");
const { safeBatchCollector } = require("../deployments/safeBatchCollector.ts");
const { setIntentGuardianFee } = require("../deploy/33_set_intent_guardian_fee.ts");

const DEPLOYER = "0x1000000000000000000000000000000000000001";
const OTHER = "0x2000000000000000000000000000000000000002";
const GUARDIAN = "0x3000000000000000000000000000000000000003";
const guardianInterface = new utils.Interface([
  "function setExtensionFeeBpsPerHour(uint256)",
]);

function fakeHre(network, accounts) {
  return {
    deployments: { getNetworkName: () => network },
    ethers: { getSigner: async (address) => ({ address }) },
    getUnnamedAccounts: async () => accounts,
  };
}

function fakeGuardian(initialFee, owner) {
  let fee = BigNumber.from(initialFee);
  let setterCalls = 0;

  const guardian = {
    address: GUARDIAN,
    interface: guardianInterface,
    extensionFeeBpsPerHour: async () => fee,
    owner: async () => owner,
    connect: () => ({
      setExtensionFeeBpsPerHour: async (newFee) => {
        setterCalls += 1;
        fee = BigNumber.from(newFee);
        return { wait: async () => undefined };
      },
    }),
  };

  return {
    guardian,
    fee: () => fee,
    setterCalls: () => setterCalls,
  };
}

test("sets the fee directly when the owner account is available", async () => {
  const state = fakeGuardian(2, DEPLOYER);

  await setIntentGuardianFee(fakeHre("hardhat", [DEPLOYER]), state.guardian);

  assert.equal(state.fee().toString(), "1");
  assert.equal(state.setterCalls(), 1);
});

test("queues exactly one Safe call when governance owns the guardian", async () => {
  const state = fakeGuardian(2, MULTI_SIG.base);
  const queuedBefore = safeBatchCollector.count();

  await setIntentGuardianFee(fakeHre("base", [DEPLOYER]), state.guardian);

  const queued = safeBatchCollector.getTransactionsSince(queuedBefore);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].to, GUARDIAN);
  assert.equal(
    queued[0].data,
    guardianInterface.encodeFunctionData("setExtensionFeeBpsPerHour", [1]),
  );
  assert.equal(state.setterCalls(), 0);
});

test("does nothing when the guardian already charges one bps per hour", async () => {
  const state = fakeGuardian(1, OTHER);
  const queuedBefore = safeBatchCollector.count();

  await setIntentGuardianFee(fakeHre("hardhat", [DEPLOYER]), state.guardian);

  assert.equal(safeBatchCollector.count(), queuedBefore);
  assert.equal(state.setterCalls(), 0);
});

test("rejects an unexpected guardian owner", async () => {
  const state = fakeGuardian(2, OTHER);
  const queuedBefore = safeBatchCollector.count();

  await assert.rejects(
    setIntentGuardianFee(fakeHre("hardhat", [DEPLOYER]), state.guardian),
    /IntentGuardian owner mismatch/,
  );
  assert.equal(safeBatchCollector.count(), queuedBefore);
  assert.equal(state.setterCalls(), 0);
});
