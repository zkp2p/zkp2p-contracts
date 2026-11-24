import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { providers, utils } from "ethers";
import { UPV5_BASE_RELEASE } from "../deployments/parameters";
import { installSafeArtifactPair } from "../deployments/safeArtifacts";
import {
  Upv5Function, buildUpv5CutoverCalls, encodeUpv5Call, readUpv5Addresses, readUpv5Bindings, readUpv5Deployed,
  sameAddress, simulateUpv5Call, upv5CatalogFor,
} from "../deployments/upv5Cutover";
import { Upv5CheckPhase, evaluateUpv5Postconditions, readUpv5Snapshot } from "../deployments/upv5Postconditions";
import {
  UPV5_BASE_SAFE_BATCH_FILE, Upv5SafeBatch, assertUpv5SafeBatch, baseUpv5CutoverInput, decodeUpv5SafeBatch,
  formatUpv5Plan, renderUpv5SafeBatch, serializeUpv5SafeBatch, serializeUpv5SafeBatchSidecar,
} from "../deployments/upv5SafeBatch";
import { buildSafeTransaction, safeTransactionHash } from "./proposeSafeBatchChunks";

const ROOT = resolve(__dirname, "..");
const BATCH_DIRECTORY = resolve(ROOT, "deployments/outputs/safe-batches");
const BATCH_FILE = resolve(BATCH_DIRECTORY, UPV5_BASE_SAFE_BATCH_FILE);
const SIDECAR_FILE = BATCH_FILE.replace(/\.json$/, ".sha256.json");
const DEFAULT_RPC_URL = "https://base-rpc.publicnode.com";
const SAFE = UPV5_BASE_RELEASE.governance;

function recordedInput() {
  const deployed = readUpv5Deployed(ROOT, "base");
  if (!deployed) throw new Error("Base UPV5 deployment records missing; run lane 49 on Base first");
  return baseUpv5CutoverInput(deployed);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function write(args: string[]): void {
  const createdAt = Number(option(args, "--created-at") ?? Date.now());
  const input = recordedInput();
  const batch = renderUpv5SafeBatch(input, SAFE, createdAt);
  assertUpv5SafeBatch(batch, input, SAFE);
  const contents = serializeUpv5SafeBatch(batch);
  mkdirSync(BATCH_DIRECTORY, { recursive: true });
  const result = installSafeArtifactPair({
    batchPath: BATCH_FILE, sidecarPath: SIDECAR_FILE, supersededDir: resolve(BATCH_DIRECTORY, "superseded"),
    supersededSuffix: randomUUID(), batchContents: contents,
    sidecarContents: serializeUpv5SafeBatchSidecar(UPV5_BASE_SAFE_BATCH_FILE, contents),
  });
  process.stdout.write(`${UPV5_BASE_SAFE_BATCH_FILE}: ${result}\n`);
  process.stdout.write(formatUpv5Plan(decodeUpv5SafeBatch(batch, input, SAFE)));
}

/** Re-derives every call from the deployment records and pins; only createdAt is taken from the file. */
function verify(): Upv5SafeBatch {
  if (!existsSync(BATCH_FILE)) throw new Error(`${UPV5_BASE_SAFE_BATCH_FILE} missing; run write first`);
  const input = recordedInput();
  const committed: Upv5SafeBatch = JSON.parse(readFileSync(BATCH_FILE, "utf8"));
  assertUpv5SafeBatch(committed, input, SAFE);
  const contents = serializeUpv5SafeBatch(renderUpv5SafeBatch(input, SAFE, committed.createdAt));
  if (readFileSync(BATCH_FILE, "utf8") !== contents) throw new Error(`${BATCH_FILE}: bytes differ from fresh render`);
  if (readFileSync(SIDECAR_FILE, "utf8") !== serializeUpv5SafeBatchSidecar(UPV5_BASE_SAFE_BATCH_FILE, contents)) {
    throw new Error(`${SIDECAR_FILE}: bytes differ from fresh render`);
  }
  process.stdout.write(formatUpv5Plan(decodeUpv5SafeBatch(committed, input, SAFE)));
  return committed;
}

function hash(args: string[]): void {
  const nonce = Number(args[0]);
  verify();
  const calls = buildUpv5CutoverCalls(recordedInput()).map((call) => ({ ...encodeUpv5Call(call), operation: 0 }));
  const transaction = buildSafeTransaction(calls, nonce);
  process.stdout.write(`Safe ${SAFE} nonce=${nonce} calls=${calls.length}\n`);
  process.stdout.write(`MultiSend target=${transaction.to} operation=${transaction.operation} ` +
    `data keccak=${utils.keccak256(transaction.data)} safeTxHash=${safeTransactionHash(transaction)}\n`);
  process.stdout.write("If the Safe UI wraps with a different MultiSendCallOnly, only the target and safeTxHash change; " +
    "compare the data keccak.\n");
}

/** The node's own revert message, without the request body ethers wraps around it. */
function rpcErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.match(/\\?"message\\?":\\?"([^"\\]+)/)?.[1] ?? text.split("\n")[0].slice(0, 200);
}

/**
 * Executes the whole batch as one call from the Safe: an eth_call to the Safe's address with MultiSendCallOnly's
 * runtime code overridden in, so every inner call runs in order with `msg.sender` = Safe, as the Safe's own
 * delegatecall to MultiSendCallOnly would. Nothing is sent and no signature is involved.
 */
export async function simulateBatchFromSafe(
  provider: providers.JsonRpcProvider, calls: Array<{ to: string; value: "0"; data: string }>, safe: string, blockTag: number,
): Promise<void> {
  const transaction = buildSafeTransaction(calls.map((call) => ({ ...call, operation: 0 })), 0);
  const code = await provider.getCode(transaction.to, blockTag);
  if (code === "0x") throw new Error(`MultiSendCallOnly ${transaction.to} has no code`);
  await provider.send("eth_call", [
    { from: UPV5_BASE_RELEASE.deployer, to: safe, data: transaction.data }, utils.hexValue(blockTag), { [safe]: { code } },
  ]);
}

/**
 * Read-only gate before proposing and again immediately before executing: live Base must still match what the
 * batch assumes and every deployment check must hold, then the whole batch must succeed as one transaction from
 * the Safe. If it reverts, each independent call is simulated alone to name the one that fails.
 */
async function preflight(args: string[]): Promise<void> {
  const input = recordedInput();
  verify();
  const provider = new providers.StaticJsonRpcProvider(option(args, "--rpc") ?? process.env.BASE_RPC_URL ?? DEFAULT_RPC_URL, input.chainId);
  const addresses = readUpv5Addresses(ROOT, "base");
  const snapshot = await readUpv5Snapshot(provider, addresses);
  const failures: string[] = [];
  const expect = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const checks = evaluateUpv5Postconditions(snapshot, addresses, {
    governance: SAFE, bindings: readUpv5Bindings(ROOT, "base", addresses), catalog: upv5CatalogFor(ROOT, "base"),
  });
  for (const check of checks.filter((candidate) => candidate.phase === Upv5CheckPhase.Deployment ||
    candidate.name === "PaymentVerifierRegistry catalog equals the plan")) {
    expect(check.ok, `${check.name}: ${check.detail}`);
  }
  expect(snapshot.routes.every((route) => sameAddress(route.verifier, addresses.unifiedPaymentVerifierV4)),
    "not every PaymentVerifierRegistry route is on UPV4");
  expect(snapshot.nullifierRegistryV2Writers.length === input.retiredWriters.length && input.retiredWriters.every((writer) =>
    snapshot.nullifierRegistryV2Writers.some((live) => sameAddress(live, writer))),
  `NullifierRegistryV2 writers [${snapshot.nullifierRegistryV2Writers.join(", ")}] differ from the batch's removals`);
  expect(snapshot.nullifierRegistryV3.writers.length === 0, "NullifierRegistryV3 already has writers");
  expect(sameAddress(snapshot.policy.disputeVerifier, UPV5_BASE_RELEASE.disputeVerifier), "DisputeProtectionPolicyV2 no longer selects the pinned DisputeVerifier");
  for (const owner of [snapshot.nullifierRegistryV2Owner, snapshot.paymentVerifierRegistryOwner, snapshot.policy.owner]) {
    expect(sameAddress(owner, SAFE), `owner ${owner} is not the Safe`);
  }
  const calls = buildUpv5CutoverCalls(input);
  try {
    await simulateBatchFromSafe(provider, calls.map(encodeUpv5Call), SAFE, snapshot.blockNumber);
  } catch (error) {
    failures.push(`the batch reverts as one transaction from the Safe (${rpcErrorMessage(error)})`);
    for (const call of calls.filter((candidate) => candidate.signature !== Upv5Function.AddMethod)) {
      try {
        await simulateUpv5Call(provider, SAFE, encodeUpv5Call(call), snapshot.blockNumber);
      } catch {
        failures.push(`alone, this call reverts: ${call.description}`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`Base UPV5 preflight failed at block ${snapshot.blockNumber}:\n- ${failures.join("\n- ")}`);
  process.stdout.write(`Base UPV5 preflight passed at block ${snapshot.blockNumber}: live state matches and all ${calls.length} ` +
    "calls succeed as one transaction from the Safe.\n");
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "write") return write(rest);
  if (command === "verify" && rest.length === 0) {
    verify();
    return;
  }
  if (command === "hash" && rest.length === 1 && /^\d+$/.test(rest[0])) return hash(rest);
  if (command === "preflight") return preflight(rest);
  throw new Error("Usage: upv5SafeBatches.ts write [--created-at <ms>] | verify | hash <safeNonce> | preflight [--rpc <url>]");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
