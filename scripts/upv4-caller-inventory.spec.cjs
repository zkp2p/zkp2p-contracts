require(require.resolve("ts-node/register/transpile-only"));
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { utils } = require("ethers");
const { inspectUpv4Callers } = require("./inspect-upv4-callers.ts");

const registry = "0x0000000000000000000000000000000000000010";
const caller = "0x0000000000000000000000000000000000000020";
const knownCaller = "0x0000000000000000000000000000000000000030";
const owner = "0x0000000000000000000000000000000000000040";
const iface = new utils.Interface([
  "event OrchestratorAdded(address indexed orchestrator)",
  "event OrchestratorRemoved(address indexed orchestrator)",
  "function isOrchestrator(address) view returns (bool)",
  "function owner() view returns (address)",
]);
const blockHash = (/** @type {number} */ block) => utils.id(`block-${block}`);
const deployment = {
  address: registry,
  transactionHash: utils.id("creation"),
  bytecode: "0x123456",
  deployedBytecode: "0x1234",
};
function event(
  /** @type {string} */ name,
  /** @type {number} */ block,
  index = 0
) {
  const encoded = iface.encodeEventLog(iface.getEvent(name), [caller]);
  return {
    address: registry,
    blockNumber: block,
    blockHash: blockHash(block),
    transactionHash: utils.id(`event-${block}`),
    transactionIndex: 0,
    logIndex: index,
    removed: false,
    ...encoded,
  };
}
function fixture() {
  const events = [
    event("OrchestratorAdded", 10),
    event("OrchestratorRemoved", 12),
    event("OrchestratorAdded", 14),
  ];
  /** @type {Array<[number, number]>} */
  const ranges = [];
  /** @type {Array<number>} */
  const callBlocks = [];
  const authorized = new Map([
    [caller, true],
    [knownCaller, false],
  ]);
  const receipt = {
    status: 1,
    contractAddress: registry,
    transactionHash: deployment.transactionHash,
    blockNumber: 10,
    blockHash: blockHash(10),
  };
  const creation = {
    hash: deployment.transactionHash,
    to: null,
    data: deployment.bytecode,
    blockHash: receipt.blockHash,
  };
  /** @type {any} */
  const provider = {
    getNetwork: async () => ({ chainId: 8453 }),
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => creation,
    getBlock: async (/** @type {number} */ number) => ({
      number,
      hash: blockHash(number),
    }),
    getCode: async (
      /** @type {string} */ address,
      /** @type {number} */ block
    ) =>
      address === registry
        ? block < 10
          ? "0x"
          : deployment.deployedBytecode
        : "0x56",
    getLogs: async (
      /** @type {{fromBlock: number, toBlock: number}} */ range
    ) => {
      ranges.push([range.fromBlock, range.toBlock]);
      return events.filter(
        (entry) =>
          entry.blockNumber >= range.fromBlock &&
          entry.blockNumber <= range.toBlock
      );
    },
    call: async (
      /** @type {{data: string}} */ tx,
      /** @type {number} */ block
    ) => {
      callBlocks.push(block);
      const decoded = iface.parseTransaction(tx);
      return iface.encodeFunctionResult(
        decoded.name,
        decoded.name === "owner"
          ? [owner]
          : [authorized.get(decoded.args[0]) === true]
      );
    },
  };
  return {
    provider,
    events,
    ranges,
    callBlocks,
    authorized,
    receipt,
    creation,
  };
}
const inspect = (/** @type {ReturnType<typeof fixture>} */ state) =>
  inspectUpv4Callers(state.provider, deployment, [knownCaller], 15, 2);

test("scans the complete creation-to-anchor range and reconciles removed/readded plus known callers", async () => {
  const state = fixture();
  const result = await inspect(state);
  assert.deepEqual(state.ranges, [
    [10, 11],
    [12, 13],
    [14, 15],
  ]);
  assert.deepEqual(state.callBlocks, [15, 15, 15]);
  assert.equal(result.blockHash, blockHash(15));
  assert.equal(result.creationBlockHash, blockHash(10));
  assert.equal(result.owner, owner);
  assert.equal(result.events.length, 3);
  assert.deepEqual(result.callers, [
    {
      address: caller,
      authorized: true,
      runtimeCodeHash: utils.keccak256("0x56"),
    },
    {
      address: knownCaller,
      authorized: false,
      runtimeCodeHash: utils.keccak256("0x56"),
    },
  ]);
  assert.equal("activationReady" in result, false);
});

test("rejects missing add/remove transitions, duplicate and out-of-range events", async () => {
  for (const corrupt of [
    (/** @type {ReturnType<typeof fixture>} */ state) => state.events.shift(),
    (/** @type {ReturnType<typeof fixture>} */ state) =>
      state.events.splice(1, 1),
    (/** @type {ReturnType<typeof fixture>} */ state) =>
      state.events.push(state.events[0]),
    (/** @type {ReturnType<typeof fixture>} */ state) => {
      state.provider.getLogs = async () => [event("OrchestratorAdded", 16)];
    },
  ]) {
    const state = fixture();
    corrupt(state);
    await assert.rejects(
      inspect(state),
      /Inconsistent registry history|Malformed, duplicate or out-of-range/
    );
  }
});

test("detects omitted known active callers and final state disagreement", async () => {
  for (const address of [caller, knownCaller]) {
    const state = fixture();
    state.authorized.set(address, !state.authorized.get(address));
    await assert.rejects(
      inspect(state),
      /Registry getter disagrees with history/
    );
  }
});

test("rejects wrong chain, constructor, creation boundary and runtime before scanning", async () => {
  for (const corrupt of [
    (/** @type {ReturnType<typeof fixture>} */ state) => {
      state.provider.getNetwork = async () => ({ chainId: 1 });
    },
    (/** @type {ReturnType<typeof fixture>} */ state) => {
      state.creation.data = "0x9999";
    },
    (/** @type {ReturnType<typeof fixture>} */ state) => {
      state.provider.getCode = async () => deployment.deployedBytecode;
    },
    (/** @type {ReturnType<typeof fixture>} */ state) => {
      state.provider.getCode = async () => "0x9999";
    },
  ]) {
    const state = fixture();
    corrupt(state);
    await assert.rejects(
      inspect(state),
      /requires Base|creation does not match|runtime or creation boundary/
    );
    assert.deepEqual(state.ranges, []);
  }
});

test("RPC failures and anchor reorgs fail without returning an inventory", async () => {
  const failed = fixture();
  failed.provider.getLogs = async () => {
    throw new Error("archive unavailable");
  };
  await assert.rejects(inspect(failed), /archive unavailable/);
  const reorg = fixture();
  let anchorReads = 0;
  reorg.provider.getBlock = async (/** @type {number} */ number) => ({
    number,
    hash:
      number === 15 && ++anchorReads > 1
        ? utils.id("reorg")
        : blockHash(number),
  });
  await assert.rejects(inspect(reorg), /Chain reorganized/);
});
