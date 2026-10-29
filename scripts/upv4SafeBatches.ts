import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { utils } from "ethers";
import { UPV4_BASE_RELEASE } from "../deployments/parameters";
import { installSafeArtifactPair } from "../deployments/safeArtifacts";
import { buildSafeTransaction, safeTransactionHash } from "./proposeSafeBatchChunks";
import {
  assertUpv4SafeBatch, baseCutoverConfig, buildUpv4ReleasePlan, buildUpv4SafeCalls,
  decodeUpv4SafeBatch, encodeUpv4SafeCall, formatUpv4PlanMarkdown, renderUpv4SafeBatch,
  serializeUpv4SafeBatch, UPV4_SAFE_BATCH_FILES, Upv4SafeBatch, Upv4SafeBatchKind,
  serializeUpv4SafeBatchSidecar,
} from "../deployments/upv4BaseCutover";

const ROOT = resolve(__dirname, "..");
const BATCH_DIRECTORY = resolve(ROOT, "deployments/outputs/safe-batches");
const PLAN_FILE = resolve(ROOT, "deployments/upv4-base-release-plan.json");

function requireBytes(file: string, expected: string): void {
  if (readFileSync(file, "utf8") !== expected) throw new Error(`${file}: bytes differ from fresh render`);
}

function pinnedRecordAddress(): string {
  const recordFile = resolve(ROOT, "deployments/base/UnifiedPaymentVerifierV4.json");
  assert.ok(existsSync(recordFile), "UnifiedPaymentVerifierV4 record missing; run the tagged lane-47 adoption");
  const record: { address: string } = JSON.parse(readFileSync(recordFile, "utf8"));
  assert.equal(record.address?.toLowerCase(), UPV4_BASE_RELEASE.unifiedPaymentVerifierV4.toLowerCase(),
    "UnifiedPaymentVerifierV4 record address mismatch");
  return UPV4_BASE_RELEASE.unifiedPaymentVerifierV4;
}

function renderedArtifacts(address: string) {
  const options = {
    createdAt: UPV4_BASE_RELEASE.deployment.blockTimestamp * 1000,
    sourceSha: UPV4_BASE_RELEASE.deployment.sourceSha,
  };
  return Object.values(Upv4SafeBatchKind).map((kind) => {
    const fileName = UPV4_SAFE_BATCH_FILES[kind];
    const batch = renderUpv4SafeBatch(kind, baseCutoverConfig(), address, options);
    const contents = serializeUpv4SafeBatch(batch);
    return { kind, fileName, batch, contents, sidecar: serializeUpv4SafeBatchSidecar(fileName, contents) };
  });
}

function write(): void {
  const address = pinnedRecordAddress();
  const artifacts = renderedArtifacts(address);
  mkdirSync(BATCH_DIRECTORY, { recursive: true });
  for (const { kind, fileName, batch, contents, sidecar } of artifacts) {
    assertUpv4SafeBatch(kind, batch, baseCutoverConfig(), address);
    const batchPath = resolve(BATCH_DIRECTORY, fileName);
    const result = installSafeArtifactPair({
      batchPath, sidecarPath: batchPath.replace(/\.json$/, ".sha256.json"),
      supersededDir: resolve(BATCH_DIRECTORY, "superseded"), supersededSuffix: randomUUID(),
      batchContents: contents, sidecarContents: sidecar,
    });
    process.stdout.write(`${fileName}: ${result}\n`);
  }
}

/** All six files are reproduced from pinned deployment provenance, never from their own metadata. */
function verify(): void {
  const address = pinnedRecordAddress();
  const config = baseCutoverConfig();
  const plan = buildUpv4ReleasePlan();
  for (const { kind, fileName, contents, sidecar } of renderedArtifacts(address)) {
    const file = resolve(BATCH_DIRECTORY, fileName);
    const committed: Upv4SafeBatch = JSON.parse(readFileSync(file, "utf8"));
    assertUpv4SafeBatch(kind, committed, config, address);
    requireBytes(file, contents);
    requireBytes(file.replace(/\.json$/, ".sha256.json"), sidecar);
    plan.batches.find((batch) => batch.kind === kind)!.rows = decodeUpv4SafeBatch(committed, config);
  }
  const calls = buildUpv4SafeCalls(Upv4SafeBatchKind.Cutover, config, address)
    .map((call) => ({ ...encodeUpv4SafeCall(call), operation: 0 }));
  const transaction = buildSafeTransaction(calls, UPV4_BASE_RELEASE.cutoverSafeNonce);
  const hash = safeTransactionHash(transaction);
  assert.equal(hash, UPV4_BASE_RELEASE.cutoverSafeTxHash, "UPV4 cutover safeTxHash mismatch");
  const signedTransaction = { ...transaction, to: UPV4_BASE_RELEASE.signedCutover.multiSendCallOnly };
  const signedHash = safeTransactionHash(signedTransaction);
  assert.equal(signedHash, UPV4_BASE_RELEASE.signedCutover.safeTxHash, "UPV4 signed cutover safeTxHash mismatch");
  process.stdout.write(formatUpv4PlanMarkdown(plan));
  process.stdout.write(`MultiSend target=${transaction.to} operation=${transaction.operation} ` +
    `data keccak=${utils.keccak256(transaction.data)} safeTxHash=${hash}\n`);
  process.stdout.write(`MultiSend target=${signedTransaction.to} operation=${signedTransaction.operation} ` +
    `data keccak=${utils.keccak256(signedTransaction.data)} safeTxHash=${signedHash}\n`);
  process.stdout.write(`Signed cutover URL=${UPV4_BASE_RELEASE.signedCutover.url}\n`);
}

function main(args: string[]): void {
  if (args[0] === "plan" && (args.length === 1 || (args.length === 2 && args[1] === "--write"))) {
    const plan = buildUpv4ReleasePlan();
    const contents = JSON.stringify(plan, null, 2) + "\n";
    process.stdout.write(formatUpv4PlanMarkdown(plan));
    if (args[1] === "--write") writeFileSync(PLAN_FILE, contents);
    else requireBytes(PLAN_FILE, contents);
    return;
  }
  if (args[0] === "write" && args.length === 1) return write();
  if (args[0] === "verify" && args.length === 1) return verify();
  if (args[0] === "ffi" && args.length === 3) {
    const kind = Object.values(Upv4SafeBatchKind).find((candidate) => candidate === args[1]);
    if (kind === undefined) throw new Error(`Unknown batch kind: ${args[1]}`);
    const calls = buildUpv4SafeCalls(kind, baseCutoverConfig(), args[2]).map(encodeUpv4SafeCall);
    process.stdout.write(utils.defaultAbiCoder.encode(
      ["address[]", "bytes[]"], [calls.map((call) => call.to), calls.map((call) => call.data)],
    ) + "\n");
    return;
  }
  throw new Error("Usage: upv4SafeBatches.ts plan [--write] | write | verify | ffi <cutover|upv3-writer-removal|rollback> <upv4Address>");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
