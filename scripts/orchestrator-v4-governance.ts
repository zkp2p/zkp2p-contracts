import * as assert from "node:assert/strict";
import { constants, providers, utils } from "ethers";
import type { ReleaseConfig, inspect } from "./deploy-orchestrator-v4";

/** An executed, single-call Safe addWitness; never an optional witness allowance. */
export type BaseWitnessChange = {
  version: 1; environment: "base"; chainId: number; verifier: string; safe: string;
  transactionHash: string; blockNumber: number; blockHash: string;
  safeNonce: number; safeTransactionHash: string; addedWitness: string;
  witnesses: string[]; threshold: string;
};
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const normalized = (values: string[]): string[] => values.map((value) => value.toLowerCase());
const verifierAbi = new utils.Interface(["function addWitness(address)", "event WitnessAdded(address indexed witness)"]);
const safeAbi = new utils.Interface(["event ExecutionSuccess(bytes32 txHash,uint256 payment)"]);

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
  assert.ok(snapshot.blockNumber >= r.blockNumber, "Snapshot predates Base O3 retirement");
  assert.equal(snapshot.predecessor.registered, false, "O3 must remain unregistered after Base retirement");
  const registered = await provider.call({ to: r.registry, data: orchestratorRegistryAbi.encodeFunctionData("isOrchestrator", [r.orchestratorV4]) }, snapshot.blockNumber);
  assert.equal(orchestratorRegistryAbi.decodeFunctionResult("isOrchestrator", registered)[0], true, "O4 must remain registered after Base O3 retirement");

  const receipt = await provider.getTransactionReceipt(r.transactionHash);
  assert.ok(receipt && receipt.status === 1 && same(receipt.to, r.safe) && same(receipt.transactionHash, r.transactionHash) && receipt.blockNumber === r.blockNumber && same(receipt.blockHash, r.blockHash), "Base O3 retirement receipt mismatch");
  const block = await provider.getBlock(r.blockNumber);
  assert.ok(block && same(block.hash, r.blockHash), "Base O3 retirement receipt is not canonical");
  const removedTopic = orchestratorRegistryAbi.getEventTopic("OrchestratorRemoved");
  const removals = receipt.logs.filter((log) => same(log.address, r.registry) && log.topics[0] === removedTopic);
  assert.ok(removals.length === 1 && same(orchestratorRegistryAbi.parseLog(removals[0]).args.orchestrator, r.address), "Base retirement receipt lacks the exact OrchestratorRemoved event");
  const successes = receipt.logs.filter((log) => same(log.address, r.safe) && log.topics[0] === safeAbi.getEventTopic("ExecutionSuccess"));
  assert.ok(successes.length === 1 && same(safeAbi.parseLog(successes[0]).args.txHash, r.safeTransactionHash) && safeAbi.parseLog(successes[0]).args.payment.isZero(), "Base retirement receipt lacks the exact Safe ExecutionSuccess event");

  // The registry has no enumerable member list. Its complete mutation history
  // from the retirement block must contain only the authorized removal, including
  // later re-add/remove cycles and changes to any other member. Bound RPC ranges.
  const changes: providers.Log[] = [];
  for (let fromBlock = r.blockNumber; fromBlock <= snapshot.blockNumber; fromBlock += 50000) {
    changes.push(...await provider.getLogs({ address: r.registry, fromBlock, toBlock: Math.min(fromBlock + 49999, snapshot.blockNumber), topics: [[orchestratorRegistryAbi.getEventTopic("OrchestratorAdded"), removedTopic]] }));
  }
  assert.ok(changes.length === 1 && same(changes[0].transactionHash, r.transactionHash) && same(changes[0].blockHash, r.blockHash) && changes[0].blockNumber === r.blockNumber && changes[0].logIndex === removals[0].logIndex && changes[0].topics[0] === removedTopic && same(orchestratorRegistryAbi.parseLog(changes[0]).args.orchestrator, r.address), "Unexpected Base orchestrator registry changes since O3 retirement");
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
  assert.deepEqual(normalized(snapshot.attestation.witnesses), normalized(change.witnesses), "Live witnesses differ from the executed Base governance change");
  assert.equal(snapshot.attestation.threshold, change.threshold, "Live attestation threshold changed");
  assert.ok(same(snapshot.contracts.MultiAttestationVerifier.owner, change.safe), "Attestation verifier owner changed");

  // The outer tx targets a relayer. Derive the inner Safe call, including nonce
  // and zero fee fields, then authenticate the Safe and verifier receipt logs.
  const safeTxHash = utils._TypedDataEncoder.hash({ chainId: c.chainId, verifyingContract: change.safe }, {
    SafeTx: [
      { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
    ],
  }, {
    to: change.verifier, value: 0, data: verifierAbi.encodeFunctionData("addWitness", [change.addedWitness]),
    operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: constants.AddressZero, refundReceiver: constants.AddressZero, nonce: change.safeNonce,
  });
  assert.ok(same(safeTxHash, change.safeTransactionHash), "Governance Safe call or nonce mismatch");
  const receipt = await provider.getTransactionReceipt(change.transactionHash);
  assert.ok(receipt && receipt.status === 1 && same(receipt.transactionHash, change.transactionHash) && receipt.blockNumber === change.blockNumber && same(receipt.blockHash, change.blockHash), "Base witness governance receipt mismatch");
  const block = await provider.getBlock(change.blockNumber);
  assert.ok(block && same(block.hash, change.blockHash), "Base witness governance receipt is not canonical");
  const additions = receipt.logs.filter((log) => same(log.address, change.verifier) && log.topics[0] === verifierAbi.getEventTopic("WitnessAdded"));
  assert.ok(additions.length === 1 && same(verifierAbi.parseLog(additions[0]).args.witness, change.addedWitness), "Governance receipt lacks the exact WitnessAdded event");
  const successes = receipt.logs.filter((log) => same(log.address, change.safe) && log.topics[0] === safeAbi.getEventTopic("ExecutionSuccess"));
  assert.ok(successes.length === 1 && same(safeAbi.parseLog(successes[0]).args.txHash, safeTxHash) && safeAbi.parseLog(successes[0]).args.payment.isZero(), "Governance receipt lacks the exact Safe ExecutionSuccess event");
  return change;
}
