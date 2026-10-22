import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { BigNumber, Contract, VoidSigner, Wallet, providers, utils } from "ethers";
import { CanonicalJsonRpcProvider } from "./canonical-receipts";
import { Manifest, ReleaseConfig, TransactionJournal } from "./deploy-orchestrator-v4";

const config: ReleaseConfig = require("../deployments/orchestrator-v4/base_staging.json");
export const HISTORICAL_OWNER = "0xdd93E0f5fC32c86A568d87Cb4f08598f55E980F3";
const migrated = "0x41123d6419C7b8e44157f6F3b0088442116641eC";
const relayer = "0xBC6Ca58369853D77a9A2f33358334BF9E9B9094F";
const abi = ["function owner() view returns(address)", "function paused() view returns(bool)", "function intentCounter() view returns(uint256)", "function isWhitelistedRelayer(address) view returns(bool)", "function pauseOrchestrator()", "function transferOwnership(address)", "function addRelayer(address)"];
const iface = new utils.Interface(abi);
type Phase = "pause" | "handoff";
type Call = { step: string; phase: Phase; to: string; data: string; value: string; runtimeCodeHash: string };
class HandoffError extends Error {}
function check(value: unknown, message: string): asserts value { if (!value) throw new HandoffError(message); }
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sourcePaths = ["scripts/handoff-staging-owner.ts", "scripts/deploy-orchestrator-v4.ts", "scripts/canonical-receipts.ts", "scripts/orchestrator-v4-provenance.ts", "scripts/verify-orchestrator-v4-source.ts", "deployments/canonicalDeployment.ts", "deployments/orchestrator-v4/base_staging.json"];

export function assertOperatorSource(): string {
  const env = Object.fromEntries(["PATH", "HOME", "LANG"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const git = (args: string[]): string => execFileSync("git", args, { env, stdio: "pipe", encoding: "utf8" }).trim();
  for (const path of sourcePaths) git(["cat-file", "-e", `HEAD:${path}`]);
  git(["diff", "--exit-code", "HEAD", "--", ...sourcePaths]);
  return git(["rev-parse", "HEAD"]);
}

// Maximum L2 gas and fee per transaction. The separate balance reserve covers L1 data fees.
export const LIMITS = { gasLimit: "150000", maxFeePerGas: "100000000", minimumBalanceWei: "200000000000000" };
export const CALLS: Call[] = [
  ...config.legacyDrainCheckpoints.map(({ contract }) => ({ step: `pause:${contract}`, phase: "pause" as const, runtimeCodeHash: config.existing[contract].runtimeCodeHash, to: config.existing[contract].address, data: iface.encodeFunctionData("pauseOrchestrator"), value: "0" })),
  ...["OrchestratorRegistry", "PaymentVerifierRegistry", "NullifierRegistryV2", "DisputeNullifierRegistry"].map((name) => ({ step: `transfer:${name}`, phase: "handoff" as const, runtimeCodeHash: config.existing[name].runtimeCodeHash, to: config.existing[name].address, data: iface.encodeFunctionData("transferOwnership", [migrated]), value: "0" })),
  { step: "add:RelayerRegistry", phase: "handoff", runtimeCodeHash: config.existing.RelayerRegistry.runtimeCodeHash, to: config.existing.RelayerRegistry.address, data: iface.encodeFunctionData("addRelayer", [relayer]), value: "0" },
];
export const PLAN = { chainId: 8453, sender: HISTORICAL_OWNER, recipientOwner: migrated, limits: LIMITS, calls: CALLS };
export const PLAN_HASH = createHash("sha256").update(JSON.stringify(PLAN)).digest("hex");
type HandoffJournal = { configuration: { chainId: number }; planHash: string; initialNonce: number; transactions: Manifest["transactions"] };

export function assertTransaction(request: Omit<providers.TransactionRequest, "type"> & { type?: number | null }, call: Call, nonce: number): void {
  check(request.chainId === 8453 && request.nonce === nonce, "Transaction chain or nonce differs from reviewed plan");
  check(typeof request.to === "string" && same(request.to, call.to) && request.data === call.data && BigNumber.from(request.value).isZero(), "Transaction differs from the exact staging call");
  check(request.type === 2 && BigNumber.from(request.gasLimit).lte(LIMITS.gasLimit) && BigNumber.from(request.gasLimit).gt(0), "Transaction exceeds reviewed gas limit");
  check(BigNumber.from(request.maxFeePerGas).lte(LIMITS.maxFeePerGas) && BigNumber.from(request.maxPriorityFeePerGas).lte(BigNumber.from(request.maxFeePerGas)), "Transaction exceeds reviewed fee limit");
}

export function assertJournal(journal: HandoffJournal): void {
  check(journal.planHash === PLAN_HASH && journal.configuration.chainId === 8453, "Journal belongs to another plan or chain");
  check(Number.isSafeInteger(journal.initialNonce) && journal.initialNonce >= 0 && Array.isArray(journal.transactions) && journal.transactions.length <= CALLS.length, "Invalid handoff journal");
  journal.transactions.forEach((tx, index) => {
    const call = CALLS[index];
    check(tx.step === call.step && tx.to === call.to && tx.data === call.data && tx.value === "0" && tx.nonce === journal.initialNonce + index, "Journal is not the exact contiguous call prefix");
    check(tx.receipt !== null || index === journal.transactions.length - 1, "Only the final journal transaction may be pending");
  });
}

export async function readState(provider: providers.JsonRpcProvider) {
  check((await provider.getNetwork()).chainId === 8453, "Historical handoff only supports Base chain 8453");
  check(config.environment === "base_staging" && same(config.signer, migrated) && CALLS.length === 7, "Staging handoff configuration changed");
  const block = await provider.getBlock("latest"), at = { blockTag: block.number };
  const states = [];
  for (const call of CALLS) {
    check(utils.keccak256(await provider.getCode(call.to, block.number)) === call.runtimeCodeHash, `Pinned runtime differs: ${call.step}`);
    const contract = new Contract(call.to, abi, provider), owner: string = await contract.owner(at);
    if (call.phase === "pause") {
      const checkpoint = config.legacyDrainCheckpoints.find(({ contract }) => call.step === `pause:${contract}`);
      check(checkpoint, "Missing legacy intent checkpoint");
      check((await contract.intentCounter(at)).toString() === checkpoint.intentCounter, `Legacy intent counter changed: ${call.step}`);
      states.push({ owner, completed: await contract.paused(at) as boolean });
    } else states.push({ owner, completed: call.step.startsWith("transfer:") ? same(owner, migrated) : await contract.isWhitelistedRelayer(relayer, at) as boolean });
  }
  return { blockNumber: block.number, blockHash: block.hash, states, latestNonce: await provider.getTransactionCount(HISTORICAL_OWNER, "latest"), pendingNonce: await provider.getTransactionCount(HISTORICAL_OWNER, "pending"), balanceWei: (await provider.getBalance(HISTORICAL_OWNER, block.number)).toString() };
}

export function assertState(state: Awaited<ReturnType<typeof readState>>, completed: number, initialNonce: number, pending: boolean): void {
  state.states.forEach((row, index) => {
    check(row.completed === (index < completed), `Live state differs from confirmed journal prefix: ${CALLS[index].step}`);
    const expectedOwner = index >= 2 && index < 6 && index < completed ? migrated : HISTORICAL_OWNER;
    check(same(row.owner, expectedOwner), `Unexpected owner: ${CALLS[index].step}`);
  });
  check(state.latestNonce === initialNonce + completed, "Historical owner nonce was consumed outside this journal");
  check(state.pendingNonce === state.latestNonce || (pending && state.pendingNonce === state.latestNonce + 1), "Historical owner has an unrelated pending transaction");
}

/** Inspect receipts without broadcasting; state validation must precede any pending replay. */
export async function reconcile(provider: providers.JsonRpcProvider, journal: HandoffJournal): Promise<number> {
  assertJournal(journal);
  let completed = 0;
  for (const tx of journal.transactions) {
    const receipt = await provider.getTransactionReceipt(tx.hash);
    if (!receipt) { check(tx.receipt === null, "Previously recorded receipt is no longer canonical"); break; }
    check(receipt.status === 1 && receipt.blockHash !== utils.hexZeroPad("0x00", 32), "Handoff transaction reverted or is not sealed");
    check((await provider.getBlock(receipt.blockNumber)).hash === receipt.blockHash, "Handoff receipt is not on the canonical chain");
    if (tx.receipt) check(tx.receipt.blockHash === receipt.blockHash, "Recorded handoff block changed");
    const actual = await provider.getTransaction(tx.hash);
    check(actual && same(actual.from, HISTORICAL_OWNER), "Receipt sender differs from historical owner");
    assertTransaction(actual, CALLS[completed], tx.nonce);
    tx.receipt = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, transactionHash: receipt.transactionHash, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString() };
    completed++;
  }
  return completed;
}

class ScopedWallet extends Wallet {
  constructor(key: string, provider: providers.JsonRpcProvider, readonly plannedCall: Call, readonly nonce: number) { super(key, provider); }
  async signTransaction(request: providers.TransactionRequest): Promise<string> {
    assertTransaction(request, this.plannedCall, this.nonce);
    check(same(this.address, HISTORICAL_OWNER), "Injected signer is not the historical owner");
    return super.signTransaction(request);
  }
}

export async function simulate(provider: providers.JsonRpcProvider, call: Call) {
  const request = { from: HISTORICAL_OWNER, to: call.to, data: call.data, value: "0" };
  await provider.call(request);
  const gasLimit = (await provider.estimateGas(request)).mul(12).div(10);
  const [block, gasPrice, priority] = await Promise.all([provider.getBlock("latest"), provider.getGasPrice(), provider.send("eth_maxPriorityFeePerGas", [])]);
  const tip = BigNumber.from(priority);
  check(block.baseFeePerGas && tip.gte(0) && tip.lte(gasPrice), "RPC priority fee is inconsistent");
  const maxFee = block.baseFeePerGas.mul(2).add(tip);
  check(gasLimit.lte(LIMITS.gasLimit) && maxFee.lte(LIMITS.maxFeePerGas), "Simulation exceeds reviewed fee or gas limits");
  return { gasLimit: gasLimit.toString(), maxFeePerGas: maxFee.toString(), maximumL2FeeWei: gasLimit.mul(maxFee).toString() };
}

export async function main(): Promise<void> {
  const [action = "plan", phase = "pause", confirmation] = process.argv.slice(2);
  const key = action === "apply" ? process.env.O4_HISTORICAL_OWNER_KEY : undefined;
  delete process.env.O4_HISTORICAL_OWNER_KEY;
  check(["plan", "apply", "verify"].includes(action) && ["pause", "handoff"].includes(phase), "Usage: plan|verify|apply pause|handoff [PLAN_HASH]");
  if (action === "apply") check(confirmation === PLAN_HASH, "Apply requires the exact reviewed plan hash");
  const sourceCommit = assertOperatorSource();
  const rpcUrl = process.env.BASE_RPC_URL;
  check(rpcUrl, "BASE_RPC_URL is required");
  const provider = new CanonicalJsonRpcProvider(rpcUrl);
  const path = resolve(process.env.O4_OWNER_JOURNAL || "deployments/outputs/orchestrator-v4-historical-owner.json");
  // Lock reads too, so a plan cannot race a local execution journal update.
  const lock = openSync(`${path}.lock`, "wx", 0o600);
  try {
    const state = await readState(provider);
    const manifest: HandoffJournal = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { configuration: { chainId: 8453 }, planHash: PLAN_HASH, initialNonce: state.latestNonce, transactions: [] };
    let completed = await reconcile(provider, manifest);
    assertState(await readState(provider), completed, manifest.initialNonce, manifest.transactions.length > completed);
    const end = phase === "pause" ? 2 : 7;
    if (phase === "handoff" && action !== "plan") check(completed >= 2, "Handoff requires both sealed pause receipts");
    const estimates = [];
    for (let i = completed; i < end; i++) estimates.push({ step: CALLS[i].step, ...await simulate(provider, CALLS[i]) });
    if (action === "plan") { console.log(JSON.stringify({ sourceCommit, planHash: PLAN_HASH, plan: PLAN, state, confirmedCalls: completed, estimates }, null, 2)); return; }
    if (action === "verify" || completed >= end) { check(completed >= end, "Requested phase is incomplete"); console.log(JSON.stringify({ sourceCommit, planHash: PLAN_HASH, confirmedCalls: completed, state: await readState(provider) }, null, 2)); return; }
    check(BigNumber.from(state.balanceWei).gte(LIMITS.minimumBalanceWei), "Historical owner balance is below reviewed gas reserve");
    check(key && /^0x[0-9a-f]{64}$/i.test(key), "Explicit O4_HISTORICAL_OWNER_KEY is required");
    check(same(new Wallet(key).address, HISTORICAL_OWNER), "Injected signer is not the historical owner");
    const journal = new TransactionJournal(path, manifest, new VoidSigner(HISTORICAL_OWNER, provider));
    journal.save();
    if (manifest.transactions.length === completed && existsSync(`${path}.pending`)) unlinkSync(`${path}.pending`);
    for (; completed < end; completed++) {
      const call = CALLS[completed], prior = manifest.transactions[completed];
      assertState(await readState(provider), completed, manifest.initialNonce, prior !== undefined);
      await simulate(provider, call);
      if (prior) {
        check(existsSync(`${path}.pending`), "Missing signed pending journal");
        const pending = JSON.parse(readFileSync(`${path}.pending`, "utf8"));
        const parsed = utils.parseTransaction(pending.raw);
        check(parsed.hash === prior.hash && pending.hash === prior.hash && parsed.from && same(parsed.from, HISTORICAL_OWNER), "Pending signature differs from recorded historical sender/hash");
        assertTransaction(parsed, call, manifest.initialNonce + completed);
        if ((await provider.getTransactionCount(HISTORICAL_OWNER, "pending")) > prior.nonce) check(await provider.getTransaction(prior.hash), "Unknown pending transaction occupies historical owner nonce");
      }
      const scoped = new ScopedWallet(key, provider, call, manifest.initialNonce + completed);
      await new TransactionJournal(path, manifest, scoped).execute(call.step, call);
      assertState(await readState(provider), completed + 1, manifest.initialNonce, false);
    }
    console.log(JSON.stringify({ sourceCommit, planHash: PLAN_HASH, confirmedCalls: completed, transactions: manifest.transactions, state: await readState(provider) }, null, 2));
  } finally { closeSync(lock); unlinkSync(`${path}.lock`); }
}

if (require.main === module) main().catch((error: unknown) => {
  // RPC errors can embed authenticated URLs or raw signed transactions. Keep them out of logs.
  console.error(error instanceof HandoffError ? error.message : "Historical owner handoff failed; inspect the read-only plan and retained journal before retrying."); process.exitCode = 1;
});
