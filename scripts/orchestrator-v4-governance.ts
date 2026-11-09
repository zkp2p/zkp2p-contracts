import * as assert from "node:assert/strict";
import { constants, providers, utils } from "ethers";
import type { ReleaseConfig, inspect } from "./deploy-orchestrator-v4";

type GovernanceReceipt = {
  transactionHash: string; blockNumber: number; blockHash: string;
  safeNonce: number; safeTransactionHash: string;
};
/** Executed Safe witness migration; neither historical state is an optional allowance. */
export type BaseWitnessChange = {
  version: 1; environment: "base"; chainId: number; verifier: string; safe: string;
  transactionHash: string; blockNumber: number; blockHash: string;
  safeNonce: number; safeTransactionHash: string; addedWitness: string;
  witnesses: string[]; threshold: string;
  removal: GovernanceReceipt & { removedWitness: string; witnesses: string[]; threshold: string };
};
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const normalized = (values: string[]): string[] => values.map((value) => value.toLowerCase());
const verifierAbi = new utils.Interface([
  "function addWitness(address)", "function removeWitness(address)",
  "event WitnessAdded(address indexed witness)", "event WitnessRemoved(address indexed witness)",
  "event RequiredSignaturesUpdated(uint256 previousThreshold,uint256 newThreshold)",
  "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
]);
const safeAbi = new utils.Interface(["event ExecutionSuccess(bytes32 txHash,uint256 payment)"]);

/** Bounded scans include the inspection head, so temporary add/remove cycles also fail. */
async function governanceLogs(provider: providers.Provider, address: string, topics: string[], from: number, through: number): Promise<providers.Log[]> {
  const logs: providers.Log[] = [];
  for (let fromBlock = from; fromBlock <= through; fromBlock += 50000)
    logs.push(...await provider.getLogs({ address, fromBlock, toBlock: Math.min(fromBlock + 49999, through), topics: [topics] }));
  return logs;
}
function logIdentity(log: providers.Log) {
  return { address: log.address.toLowerCase(), transactionHash: log.transactionHash.toLowerCase(), blockNumber: log.blockNumber,
    blockHash: log.blockHash.toLowerCase(), logIndex: log.logIndex, topics: normalized(log.topics), data: log.data.toLowerCase() };
}
async function canonicalReceipt(provider: providers.Provider, record: GovernanceReceipt, safe: string, label: string) {
  const receipt = await provider.getTransactionReceipt(record.transactionHash);
  assert.ok(receipt && receipt.status === 1 && same(receipt.transactionHash, record.transactionHash) && receipt.blockNumber === record.blockNumber && same(receipt.blockHash, record.blockHash), `${label} receipt mismatch`);
  const block = await provider.getBlock(record.blockNumber);
  assert.ok(block && same(block.hash, record.blockHash), `${label} receipt is not canonical`);
  const successes = receipt.logs.filter(log => same(log.address, safe) && log.topics[0] === safeAbi.getEventTopic("ExecutionSuccess"));
  assert.ok(successes.length === 1 && same(safeAbi.parseLog(successes[0]).args.txHash, record.safeTransactionHash) && safeAbi.parseLog(successes[0]).args.payment.isZero(), `${label} receipt lacks the exact Safe ExecutionSuccess event`);
  return receipt;
}
function witnessSafeHash(c: ReleaseConfig, change: BaseWitnessChange, record: GovernanceReceipt, method: string, witness: string): string {
  return utils._TypedDataEncoder.hash({ chainId: c.chainId, verifyingContract: change.safe }, {
    SafeTx: [
      { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
    ],
  }, {
    to: change.verifier, value: 0, data: verifierAbi.encodeFunctionData(method, [witness]),
    operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: constants.AddressZero, refundReceiver: constants.AddressZero, nonce: record.safeNonce,
  });
}

/** Base Safe nonce 94 retired exactly this predecessor; this is required state, not an optional absence. */
const BASE_O3_RETIREMENT = Object.freeze({
  address: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
  orchestratorV4: "0x74c55679268FAfB493864915aD16A320AB8c40Ba",
  registry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
  safe: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  safeNonce: 94,
  safeTransactionHash: "0x7d3884d343432f13d433a38603fea28e44cb80b849156099d463f9fd1e697f77",
  transactionHash: "0x85b7c40b779350cdeb6890f84d72375588e1bf930f9fdcd8eeea97aa4ea60dfc",
  blockNumber: 53550556,
  blockHash: "0xe331521b6087f609d6cb148a186a143fd22693bfd43058295d3473ad55070181",
  legacyOrchestrator: "0x88888883Ed048FF0a415271B28b2F52d431810D0",
  followupTransactions: [
    {
      transactionHash: "0x497b6d78199baebce6c1b1c9adcc4b6c2c8422e348e67c63fb85a93eab9a505c",
      blockNumber: 54173646,
      blockHash: "0x35d191318b3f5ed9ba8475660181ab3e4a96f7ccb63d2d51f157b41035cecd81",
      safeNonce: 95,
      safeTransactionHash: "0x27c3e24e1d1c91afa353660e91a26c623a8b497f8a7eee274c0bed05f0580c33",
      transactionTarget: "0x781388759EacB9892f60D77D9A99c9BE2F7F4ada",
      events: [
        { event: "OrchestratorAdded", orchestrator: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7", logIndex: 9 },
        { event: "OrchestratorRemoved", orchestrator: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7", logIndex: 100 },
      ],
    },
    {
      transactionHash: "0x825754eb601dd1ffe71a03c918508421ec9a2a15533f4a5ee195c548e40dfe20",
      blockNumber: 54199685,
      blockHash: "0xbbc8b569470b4b35c6321719d2ec53b0a535f6b01f6c6519cae4ede1978fe8e3",
      safeNonce: 96,
      safeTransactionHash: "0x5a0edfe3396da88550e2c01223a187b31c776ac6b916794857807423530a9c48",
      transactionTarget: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
      events: [
        { event: "OrchestratorRemoved", orchestrator: "0x88888883Ed048FF0a415271B28b2F52d431810D0", logIndex: 7 },
      ],
    },
  ],
});
const orchestratorRegistryAbi = new utils.Interface([
  "function isOrchestrator(address) view returns (bool)",
  "event OrchestratorAdded(address indexed orchestrator)",
  "event OrchestratorRemoved(address indexed orchestrator)",
]);

export async function verifyBaseO3Retirement(
  provider: providers.Provider, c: ReleaseConfig, snapshot: Awaited<ReturnType<typeof inspect>>, orchestratorV4: string,
): Promise<typeof BASE_O3_RETIREMENT> {
  const r = BASE_O3_RETIREMENT;
  assert.ok(c.environment === "base" && c.chainId === 8453, "Base O3 retirement environment mismatch");
  assert.ok(same(c.existing.OrchestratorV3.address, r.address) && same(c.existing.OrchestratorRegistry.address, r.registry) && same(c.governance, r.safe) && same(orchestratorV4, r.orchestratorV4), "Base O3 retirement target mismatch");
  assert.ok(snapshot.blockNumber >= r.followupTransactions[1].blockNumber, "Snapshot predates Base O3 retirement");
  assert.equal(snapshot.predecessor.registered, false, "O3 must remain unregistered after Base retirement");
  const registered = await provider.call({ to: r.registry, data: orchestratorRegistryAbi.encodeFunctionData("isOrchestrator", [r.orchestratorV4]) }, snapshot.blockNumber);
  assert.equal(orchestratorRegistryAbi.decodeFunctionResult("isOrchestrator", registered)[0], true, "O4 must remain registered after Base O3 retirement");

  const legacyRegistered = await provider.call({ to: r.registry, data: orchestratorRegistryAbi.encodeFunctionData("isOrchestrator", [r.legacyOrchestrator]) }, snapshot.blockNumber);
  assert.equal(orchestratorRegistryAbi.decodeFunctionResult("isOrchestrator", legacyRegistered)[0], false, "Legacy orchestrator must remain unregistered after Base retirement");

  const receipt = await provider.getTransactionReceipt(r.transactionHash);
  assert.ok(receipt && receipt.status === 1 && same(receipt.to, r.safe) && same(receipt.transactionHash, r.transactionHash) && receipt.blockNumber === r.blockNumber && same(receipt.blockHash, r.blockHash), "Base O3 retirement receipt mismatch");
  const block = await provider.getBlock(r.blockNumber);
  assert.ok(block && same(block.hash, r.blockHash), "Base O3 retirement receipt is not canonical");
  const removedTopic = orchestratorRegistryAbi.getEventTopic("OrchestratorRemoved");
  const removals = receipt.logs.filter((log) => same(log.address, r.registry) && log.topics[0] === removedTopic);
  assert.ok(removals.length === 1 && same(orchestratorRegistryAbi.parseLog(removals[0]).args.orchestrator, r.address), "Base retirement receipt lacks the exact OrchestratorRemoved event");
  const successes = receipt.logs.filter((log) => same(log.address, r.safe) && log.topics[0] === safeAbi.getEventTopic("ExecutionSuccess"));
  assert.ok(successes.length === 1 && same(safeAbi.parseLog(successes[0]).args.txHash, r.safeTransactionHash) && safeAbi.parseLog(successes[0]).args.payment.isZero(), "Base retirement receipt lacks the exact Safe ExecutionSuccess event");

  const registryTopics = [orchestratorRegistryAbi.getEventTopic("OrchestratorAdded"), removedTopic];
  const expectedLogs = [removals[0]];
  for (const record of r.followupTransactions) {
    const receipt = await canonicalReceipt(provider, record, r.safe, "Base registry governance");
    assert.ok(same(receipt.to, record.transactionTarget), "Base registry governance receipt mismatch");
    const events = receipt.logs.filter(log => same(log.address, r.registry) && registryTopics.includes(log.topics[0]));
    const expected = record.events.map(event => ({
      address: r.registry, transactionHash: record.transactionHash, blockNumber: record.blockNumber, blockHash: record.blockHash, logIndex: event.logIndex,
      ...orchestratorRegistryAbi.encodeEventLog(orchestratorRegistryAbi.getEvent(event.event), [event.orchestrator]),
    } as providers.Log));
    assert.deepEqual(events.map(logIdentity), expected.map(logIdentity), "Base governance receipt lacks the exact registry events");
    expectedLogs.push(...events);
  }
  // Preserve the nonce-94 checkpoint. Only the pinned atomic drain and legacy
  // removal may follow it; any change to any member, even a reverted set, fails.
  const changes = await governanceLogs(provider, r.registry, registryTopics, r.blockNumber, snapshot.blockNumber);
  assert.deepEqual(changes.map(logIdentity), expectedLogs.map(logIdentity), "Unexpected Base orchestrator registry changes since O3 retirement");
  return r;
}

export async function verifyBaseWitnessChange(
  provider: providers.Provider, c: ReleaseConfig, snapshot: Awaited<ReturnType<typeof inspect>>, value: unknown,
): Promise<BaseWitnessChange> {
  assert.ok(value && typeof value === "object", "Base witness governance record is required");
  const change = value as BaseWitnessChange;
  assert.ok(c.environment === "base" && c.chainId === 8453 && change.version === 1 && change.environment === "base" && change.chainId === c.chainId, "Base witness governance environment mismatch");
  for (const address of [change.verifier, change.safe, change.addedWitness])
    assert.ok(typeof address === "string" && utils.isAddress(address) && !same(address, constants.AddressZero), "Invalid Base witness governance address");
  assert.ok(same(change.verifier, c.existing.MultiAttestationVerifier.address) && same(change.safe, c.governance), "Base witness governance target mismatch");
  for (const digest of [change.transactionHash, change.blockHash, change.safeTransactionHash])
    assert.match(digest, /^0x[\da-f]{64}$/i, "Invalid Base witness governance hash");
  assert.ok(Number.isSafeInteger(change.blockNumber) && change.blockNumber > c.baselineBlock && change.blockNumber <= snapshot.blockNumber, "Base witness governance block mismatch");
  assert.ok(Number.isSafeInteger(change.safeNonce) && change.safeNonce >= 0, "Invalid Base witness governance nonce");
  assert.ok(Array.isArray(change.witnesses) && change.witnesses.every(utils.isAddress), "Invalid Base witness governance witnesses");
  assert.ok(!c.attestationWitnesses.some((witness) => same(witness, change.addedWitness)), "Governance witness was already in the deployment baseline");
  assert.deepEqual(normalized(change.witnesses), normalized([...c.attestationWitnesses, change.addedWitness]), "Governance witnesses must be exactly the baseline plus the recorded addition");
  assert.equal(change.threshold, c.attestationThreshold, "Governance record cannot change the threshold");
  const removal = change.removal;
  assert.ok(removal && typeof removal === "object", "Base witness removal record is required");
  assert.ok(Number.isSafeInteger(removal.blockNumber) && removal.blockNumber > change.blockNumber && removal.blockNumber <= snapshot.blockNumber, "Base witness removal block mismatch");
  for (const digest of [removal.transactionHash, removal.blockHash, removal.safeTransactionHash])
    assert.match(digest, /^0x[\da-f]{64}$/i, "Invalid Base witness removal hash");
  assert.ok(Number.isSafeInteger(removal.safeNonce) && removal.safeNonce > change.safeNonce, "Invalid Base witness removal nonce");
  assert.ok(typeof removal.removedWitness === "string" && same(removal.removedWitness, c.attestationWitnesses[0]), "Unexpected Base removed witness");
  // EnumerableSet moves the last member into the removed member's slot.
  const witnesses = [...change.witnesses]; witnesses[0] = witnesses.pop()!;
  assert.ok(Array.isArray(removal.witnesses) && removal.witnesses.every(utils.isAddress), "Invalid Base removal witnesses");
  assert.deepEqual(normalized(removal.witnesses), normalized(witnesses), "Unexpected Base removal witnesses");
  assert.equal(removal.threshold, change.threshold, "Removal cannot change the threshold");
  assert.deepEqual(normalized(snapshot.attestation.witnesses), normalized(witnesses), "Live witnesses differ from the executed Base governance change");
  assert.equal(snapshot.attestation.threshold, change.threshold, "Live attestation threshold changed");
  assert.ok(same(snapshot.contracts.MultiAttestationVerifier.owner, change.safe), "Attestation verifier owner changed");

  const expectedLogs: providers.Log[] = [];
  for (const [record, method, event, witness] of [
    [change, "addWitness", "WitnessAdded", change.addedWitness],
    [removal, "removeWitness", "WitnessRemoved", removal.removedWitness],
  ] as const) {
    assert.ok(same(witnessSafeHash(c, change, record, method, witness), record.safeTransactionHash), "Governance Safe call or nonce mismatch");
    const receipt = await canonicalReceipt(provider, record, change.safe, "Base witness governance");
    const logs = receipt.logs.filter(log => same(log.address, change.verifier) && log.topics[0] === verifierAbi.getEventTopic(event));
    assert.ok(logs.length === 1 && same(verifierAbi.parseLog(logs[0]).args.witness, witness), `Governance receipt lacks the exact ${event} event`);
    expectedLogs.push(logs[0]);
  }
  const history = await governanceLogs(provider, change.verifier,
    ["WitnessAdded", "WitnessRemoved", "RequiredSignaturesUpdated", "OwnershipTransferred"].map(event => verifierAbi.getEventTopic(event)), change.blockNumber, snapshot.blockNumber);
  assert.deepEqual(history.map(logIdentity), expectedLogs.map(logIdentity), "Unexpected Base witness governance changes since the recorded addition");
  return { ...change, witnesses };
}
