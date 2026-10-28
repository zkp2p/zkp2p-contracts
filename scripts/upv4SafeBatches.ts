import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { utils } from "ethers";
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

function sourceSha(batch: Upv4SafeBatch): string {
  const tokens = [...batch.meta.description.matchAll(/\bSource ([0-9a-fA-F]{40})\./g)];
  if (tokens.length !== 1) throw new Error(`${batch.meta.name}: expected one Source <40-hex>. token`);
  return tokens[0][1];
}

/**
 * Lane 47 uses the deployment block timestamp (ms) and release SHA in every batch.
 * Recover those inputs from cutover, require all batches to agree, then compare all
 * six committed files byte-for-byte against fresh renders from the deployment record.
 */
function verify(): void {
  const recordFile = resolve(ROOT, "deployments/base/UnifiedPaymentVerifierV4.json");
  if (!existsSync(recordFile)) throw new Error("UnifiedPaymentVerifierV4 is not deployed on Base yet");
  const record: { address: string } = JSON.parse(readFileSync(recordFile, "utf8"));
  const config = baseCutoverConfig();
  const cutover: Upv4SafeBatch = JSON.parse(readFileSync(
    resolve(BATCH_DIRECTORY, UPV4_SAFE_BATCH_FILES[Upv4SafeBatchKind.Cutover]), "utf8",
  ));
  const options = { createdAt: cutover.createdAt, sourceSha: sourceSha(cutover) };
  const plan = buildUpv4ReleasePlan();
  for (const batchPlan of plan.batches) {
    const fileName = UPV4_SAFE_BATCH_FILES[batchPlan.kind];
    const file = resolve(BATCH_DIRECTORY, fileName);
    const committed: Upv4SafeBatch = JSON.parse(readFileSync(file, "utf8"));
    if (committed.createdAt !== options.createdAt) throw new Error(`${fileName}: createdAt mismatch`);
    if (sourceSha(committed) !== options.sourceSha) throw new Error(`${fileName}: source SHA mismatch`);
    assertUpv4SafeBatch(batchPlan.kind, committed, config, record.address);
    const fresh = renderUpv4SafeBatch(batchPlan.kind, config, record.address, options);
    const contents = serializeUpv4SafeBatch(fresh);
    requireBytes(file, contents);
    requireBytes(file.replace(/\.json$/, ".sha256.json"),
      serializeUpv4SafeBatchSidecar(fileName, contents));
    batchPlan.rows = decodeUpv4SafeBatch(committed, config);
  }
  process.stdout.write(formatUpv4PlanMarkdown(plan));
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
  throw new Error("Usage: upv4SafeBatches.ts plan [--write] | verify | ffi <cutover|upv3-writer-removal|rollback> <upv4Address>");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
