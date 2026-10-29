import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Contract, VoidSigner, constants, utils } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { installSafeArtifactPair } from "../deployments/safeArtifacts";
import {
  buildO4SafeCalls, decodeO4SafeBatch, O4_MULTI_SEND_CANDIDATES, O4_SAFE_BATCH_FILES,
  O4SafeBatchKind, O4SafeTransactionCandidate, o4SafeTransactions, renderO4SafeBatch,
  serializeO4SafeBatch, serializeO4SafeBatchSidecar,
} from "../deployments/orchestratorV4SafeBatches";
import { Manifest, TransactionJournal, inspect, verifySuite } from "./deploy-orchestrator-v4";
import { BASE_SAFE, SafeTransaction } from "./proposeSafeBatchChunks";
import { BASE_SAFE_RUNTIME_HASH, MULTI_SEND_CALL_ONLY_RUNTIME_HASH, requireRuntimeHash, restoreHardhatModuleResolution } from "./simulate-dispute-opt-in-safe-batch";

const ROOT = resolve(__dirname, "..");
const MANIFEST_FILE = resolve(ROOT, "deployments/outputs/orchestrator-v4-base.json");
const BATCH_DIRECTORY = resolve(ROOT, "deployments/outputs/safe-batches");
const FORK_CONFIG = resolve(ROOT, "hardhat.base-fork.config.ts");
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const SENTINEL = "0x0000000000000000000000000000000000000001";
export const O4_SAFE_OWNERS = ["0xbD020867Cebdad3bf9F31480E4b01e9bbeFf7552", "0xf6598cA199dc739848d342Aef8Bb16578382a2f6"] as const;
const SAFE_ABI = [
  "function VERSION() view returns(string)", "function nonce() view returns(uint256)",
  "function getOwners() view returns(address[])", "function getThreshold() view returns(uint256)",
  "function getModulesPaginated(address,uint256) view returns(address[],address)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)",
  "function approveHash(bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns(bool)",
  "event ExecutionSuccess(bytes32 txHash,uint256 payment)",
];
const normalized = (values: readonly string[]): string[] => values.map((v) => v.toLowerCase()).sort();
const sameAddress = (actual: string, expected: string, label: string): void => assert.equal(actual.toLowerCase(), expected.toLowerCase(), label);

export function renderO4Artifacts(manifest: Manifest) {
  return Object.values(O4SafeBatchKind).map((kind) => {
    const batch = renderO4SafeBatch(kind, manifest), fileName = O4_SAFE_BATCH_FILES[kind];
    const contents = serializeO4SafeBatch(batch);
    return { kind, fileName, batch, contents, sidecar: serializeO4SafeBatchSidecar(fileName, contents) };
  });
}

export function writeO4Artifacts(manifest: Manifest, directory = BATCH_DIRECTORY): void {
  const artifacts = renderO4Artifacts(manifest);
  mkdirSync(directory, { recursive: true });
  for (const { fileName, contents, sidecar } of artifacts) {
    const batchPath = join(directory, fileName);
    installSafeArtifactPair({ batchPath, sidecarPath: batchPath.replace(/\.json$/, ".sha256.json"),
      supersededDir: join(directory, "superseded"), supersededSuffix: randomUUID(), batchContents: contents, sidecarContents: sidecar });
  }
}

export function verifyO4Artifacts(manifest: Manifest, directory = BATCH_DIRECTORY): void {
  for (const { fileName, contents, sidecar } of renderO4Artifacts(manifest)) {
    const file = join(directory, fileName);
    assert.equal(readFileSync(file, "utf8"), contents, `${fileName}: bytes differ from fresh render`);
    assert.equal(readFileSync(file.replace(/\.json$/, ".sha256.json"), "utf8"), sidecar, `${fileName} sidecar: bytes differ from fresh render`);
  }
}

export function printO4Batches(manifest: Manifest, safeNonce: number): void {
  for (const { kind, fileName, batch } of renderO4Artifacts(manifest)) {
    console.log(`${fileName}\n${JSON.stringify(decodeO4SafeBatch(batch, manifest), null, 2)}`);
    for (const { safeTx, safeTxHash } of o4SafeTransactions(kind, buildO4SafeCalls(kind, manifest), safeNonce + (kind === O4SafeBatchKind.Rollback ? 1 : 0))) {
      console.log(`${kind}: nonce=${safeTx.nonce} to=${safeTx.to} operation=${safeTx.operation} safeTxHash=${safeTxHash}`);
    }
  }
  console.log("Rollback uses activation nonce + 1; recompute if anything else executes first.");
}

/** Check before loading Hardhat or making even a reset request. */
export function assertO4ForkEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  assert.equal(env.HARDHAT_NETWORK, "hardhat", "Simulation requires HARDHAT_NETWORK=hardhat");
  assert.ok(env.HARDHAT_CONFIG && resolve(env.HARDHAT_CONFIG) === FORK_CONFIG,
    "Simulation requires HARDHAT_CONFIG=hardhat.base-fork.config.ts");
  assert.ok(env.BASE_FORK_RPC_URL, "BASE_FORK_RPC_URL is required for simulation");
}

function assertForkRuntime(hre: HardhatRuntimeEnvironment): void {
  assertO4ForkEnvironment();
  assert.equal(hre.network.name, "hardhat", "Simulation requires in-process Hardhat");
  assert.equal(resolve(hre.config.paths.configFile), FORK_CONFIG, "Unexpected Hardhat config");
  assert.equal(hre.network.config.chainId, 8453, "Fork config chainId must be 8453");
}

export async function resetO4BaseFork(hre: HardhatRuntimeEnvironment): Promise<void> {
  assertForkRuntime(hre);
  const configuredBlock = process.env.BASE_FORK_BLOCK;
  if (configuredBlock !== undefined) assert.ok(/^[1-9]\d*$/.test(configuredBlock) && Number.isSafeInteger(Number(configuredBlock)), "Invalid BASE_FORK_BLOCK");
  await hre.network.provider.request({ method: "hardhat_reset", params: [{ forking: {
    jsonRpcUrl: process.env.BASE_FORK_RPC_URL,
    ...(configuredBlock === undefined ? {} : { blockNumber: Number(configuredBlock) }),
  } }] });
  assert.equal((await hre.ethers.provider.getNetwork()).chainId, 8453, "Fork chainId mismatch");
}

async function checkedSafe(hre: HardhatRuntimeEnvironment, nonce: number): Promise<{ safe: Contract; owners: string[] }> {
  assertForkRuntime(hre);
  const metadata = await hre.network.provider.send("hardhat_metadata");
  assert.equal(metadata.forkedNetwork?.chainId, 8453, "Simulation requires a Base fork");
  const provider = hre.ethers.provider;
  assert.equal((await provider.getNetwork()).chainId, 8453, "Fork chainId mismatch");
  requireRuntimeHash(await provider.getCode(BASE_SAFE), BASE_SAFE_RUNTIME_HASH, "Safe");
  for (const to of O4_MULTI_SEND_CANDIDATES) requireRuntimeHash(await provider.getCode(to), MULTI_SEND_CALL_ONLY_RUNTIME_HASH, "MultiSendCallOnly");
  const safe = new Contract(BASE_SAFE, SAFE_ABI, provider);
  assert.equal(await safe.VERSION(), "1.3.0", "Safe version mismatch");
  assert.equal(await provider.getStorageAt(BASE_SAFE, GUARD_SLOT), constants.HashZero, "Safe guard must be zero");
  assert.equal((await safe.nonce()).toString(), String(nonce), "Safe nonce mismatch");
  assert.equal((await safe.getThreshold()).toNumber(), 2, "Safe threshold mismatch");
  const owners: string[] = [...await safe.getOwners()].sort((a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()));
  assert.deepEqual(normalized(owners), normalized(O4_SAFE_OWNERS), "Safe owners mismatch");
  const [modules, next] = await safe.getModulesPaginated(SENTINEL, 1);
  assert.deepEqual(modules, [], "Safe modules must be empty");
  sameAddress(next, SENTINEL, "Safe module list is incomplete");
  // EIP-7702 owners still use the approved-hash signature path; never substitute owner code.
  for (const owner of owners) {
    const code = await provider.getCode(owner);
    assert.ok(code === "0x" || /^0xef0100[\da-f]{40}$/i.test(code), "Safe owner must be EOA or EIP-7702 delegated EOA");
  }
  return { safe, owners };
}

function transactionArgs(tx: SafeTransaction): unknown[] {
  return [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver];
}

async function executeSafeTransaction(hre: HardhatRuntimeEnvironment, candidate: O4SafeTransactionCandidate) {
  const { safeTx, safeTxHash } = candidate;
  const { safe, owners } = await checkedSafe(hre, safeTx.nonce);
  assert.equal(await safe.getTransactionHash(...transactionArgs(safeTx), safeTx.nonce), safeTxHash, "On-chain safeTxHash mismatch");
  const impersonated: string[] = [];
  try {
    for (const owner of owners) {
      await hre.network.provider.send("hardhat_impersonateAccount", [owner]);
      impersonated.push(owner);
      await hre.network.provider.send("hardhat_setBalance", [owner, utils.hexValue(utils.parseEther("100"))]);
    }
    for (const owner of owners.slice(0, -1)) await (await safe.connect(hre.ethers.provider.getSigner(owner)).approveHash(safeTxHash)).wait();
    const signatures = utils.hexConcat(owners.map((owner) => utils.hexConcat([utils.hexZeroPad(owner, 32), constants.HashZero, "0x01"])));
    const receipt = await (await safe.connect(hre.ethers.provider.getSigner(owners[owners.length - 1]))
      .execTransaction(...transactionArgs(safeTx), signatures)).wait();
    assert.equal(receipt.status, 1, "Safe execution reverted");
    const success = receipt.logs.filter((log: { address: string; topics: string[] }) =>
      log.address.toLowerCase() === BASE_SAFE.toLowerCase() && log.topics[0] === safe.interface.getEventTopic("ExecutionSuccess"));
    assert.equal(success.length, 1, "Missing Safe ExecutionSuccess");
    assert.equal(safe.interface.parseLog(success[0]).args.txHash, safeTxHash, "ExecutionSuccess hash mismatch");
    assert.equal((await safe.nonce()).toNumber(), safeTx.nonce + 1, "Safe nonce did not advance");
    return { safeTxHash, gasUsed: receipt.gasUsed.toString(), nonce: safeTx.nonce };
  } finally {
    for (const owner of impersonated) await hre.network.provider.send("hardhat_stopImpersonatingAccount", [owner]);
  }
}

export function assertO4PaymentWriters(actual: readonly string[], before: readonly string[], upv3: string, upv4: string): void {
  const expected = normalized(before), allowed = normalized([upv3, upv4]);
  assert.ok(expected.includes(upv4.toLowerCase()) && new Set(expected).size === expected.length
    && expected.every((writer) => allowed.includes(writer)), "Unexpected pre-activation payment nullifier writers");
  assert.deepEqual(normalized(actual), expected, "Payment nullifier writers changed");
}

async function assertO4Postconditions(hre: HardhatRuntimeEnvironment, manifest: Manifest, paused: boolean, predecessorHook: string, beforeWriters: readonly string[]) {
  const c = manifest.configuration, provider = hre.ethers.provider;
  const snapshot = await inspect(hre, c);
  assert.equal(snapshot.predecessor.registered, true, "O3 must remain registered");
  assert.equal(snapshot.predecessor.paused, false, "O3 must remain unpaused");
  sameAddress(snapshot.predecessor.lifecycleHook, predecessorHook, "O3 hook changed");
  assertO4PaymentWriters(snapshot.nullifierWriters, beforeWriters, c.existing.UnifiedPaymentVerifierV3.address, c.existing.UnifiedPaymentVerifierV4.address);
  assert.deepEqual(normalized(snapshot.disputeWriters), normalized([...c.retainedDisputeWriters, manifest.contracts.DisputeProtectionPolicyV2!.address]), "Dispute writers changed");
  assert.deepEqual(snapshot.paymentMethods, c.paymentMethods.map(({ method, currencies }) => ({ method, currencies, verifier: c.existing.UnifiedPaymentVerifierV4.address })), "Payment routes/currencies changed");
  const o4 = new Contract(manifest.contracts.OrchestratorV4!.address, ["function paused() view returns(bool)", "function owner() view returns(address)"], provider);
  const registry = new Contract(c.existing.OrchestratorRegistry.address, ["function isOrchestrator(address) view returns(bool)"], provider);
  assert.equal(await registry.isOrchestrator(o4.address), true, "O4 must remain registered");
  assert.equal(await o4.paused(), paused, "O4 pause state mismatch");
  sameAddress(await o4.owner(), BASE_SAFE, "O4 owner mismatch");
  for (const name of ["StakeVaultV2", "DisputeProtectionPolicyV2"] as const) {
    const contract = new Contract(manifest.contracts[name]!.address, ["function owner() view returns(address)", "function pendingOwner() view returns(address)"], provider);
    sameAddress(await contract.owner(), BASE_SAFE, `${name} owner mismatch`);
    sameAddress(await contract.pendingOwner(), constants.AddressZero, `${name} pending owner mismatch`);
  }
  return { predecessor: snapshot.predecessor, paymentMethods: snapshot.paymentMethods, nullifierWriters: normalized(snapshot.nullifierWriters), disputeWriters: snapshot.disputeWriters };
}

/** Operates on an already reset fork so rehearsals can deploy the suite before this exact core runs. */
export async function simulateO4SafeBatches(hre: HardhatRuntimeEnvironment, manifest: Manifest, safeNonce: number) {
  const activation = o4SafeTransactions(O4SafeBatchKind.Activation, buildO4SafeCalls(O4SafeBatchKind.Activation, manifest), safeNonce)[0];
  const rollback = o4SafeTransactions(O4SafeBatchKind.Rollback, buildO4SafeCalls(O4SafeBatchKind.Rollback, manifest), safeNonce + 1).find(({ safeTx }) => safeTx.operation === 0)!;
  await checkedSafe(hre, safeNonce);
  const prepared = manifest.governancePreparedAt!;
  const block = await hre.ethers.provider.getBlock(prepared.blockNumber);
  assert.equal(block.hash, prepared.blockHash, "Prepared block hash mismatch");
  assert.equal(block.timestamp, prepared.timestamp, "Prepared timestamp mismatch");
  const before = await inspect(hre, manifest.configuration);
  assert.equal(before.predecessor.registered, true, "O3 must be registered before activation");
  assert.equal(before.predecessor.paused, false, "O3 must be unpaused before activation");
  const directory = mkdtempSync(join(tmpdir(), "o4-safe-simulation-"));
  try {
    const copy: Manifest = JSON.parse(JSON.stringify(manifest));
    const journal = new TransactionJournal(join(directory, "manifest.json"), copy, new VoidSigner(copy.configuration.signer, hre.ethers.provider));
    await verifySuite(hre, journal, false);
    const activated = await executeSafeTransaction(hre, activation);
    await verifySuite(hre, journal, true);
    const activeState = await assertO4Postconditions(hre, manifest, false, before.predecessor.lifecycleHook, before.nullifierWriters);
    const rolledBack = await executeSafeTransaction(hre, rollback);
    const rollbackState = await assertO4Postconditions(hre, manifest, true, before.predecessor.lifecycleHook, before.nullifierWriters);
    assert.deepEqual(rollbackState, activeState, "Rollback changed O3, routes or writers");
    console.log(`activation: safeTxHash=${activated.safeTxHash} gasUsed=${activated.gasUsed}`);
    console.log(`rollback: safeTxHash=${rolledBack.safeTxHash} gasUsed=${rolledBack.gasUsed}`);
    return { activation: activated, rollback: rolledBack };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

enum Command { Render = "render", Verify = "verify", Simulate = "simulate" }
const USAGE = "Usage: yarn o4:safe-batches <render|verify|simulate> --safe-nonce N";
export function parseO4SafeBatchArgs(args: string[]): { command: Command; safeNonce: number } {
  const command = Object.values(Command).find((value) => value === args[0]);
  assert.ok(command && args.length === 3 && args[1] === "--safe-nonce" && /^(0|[1-9]\d*)$/.test(args[2]), USAGE);
  const safeNonce = Number(args[2]);
  assert.ok(Number.isSafeInteger(safeNonce) && Number.isSafeInteger(safeNonce + 1), USAGE);
  return { command, safeNonce };
}

export async function main(args: string[]): Promise<void> {
  const { command, safeNonce } = parseO4SafeBatchArgs(args);
  if (command === Command.Simulate) assertO4ForkEnvironment();
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  if (command === Command.Render) writeO4Artifacts(manifest);
  else verifyO4Artifacts(manifest);
  printO4Batches(manifest, safeNonce);
  if (command === Command.Simulate) {
    restoreHardhatModuleResolution();
    const hre: HardhatRuntimeEnvironment = require("hardhat");
    await resetO4BaseFork(hre);
    await simulateO4SafeBatches(hre, manifest, safeNonce);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((error: unknown) => {
  // RPC errors can include authenticated URLs; only local assertions are safe to print.
  console.error(error instanceof assert.AssertionError ? error.message : "O4 Safe batch command failed; check inputs and fork RPC availability.");
  process.exitCode = 1;
});
