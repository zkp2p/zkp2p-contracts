import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, providers, utils } from "ethers";
import * as dotenv from "dotenv";
import {
  UPV5_STAGING_JOURNAL_PATH, Upv5Call, Upv5CatalogPlan, Upv5ContractAddresses, Upv5CutoverInput, Upv5Deployed,
  Upv5Function, Upv5Network, Upv5StagingJournal, buildUpv5CutoverCalls, encodeUpv5Call, lower, pendingUpv5Calls,
  readUpv5Addresses, readUpv5Bindings, readUpv5StagingJournal, sameAddress, scalarArg, simulateUpv5Call,
  upv5ReleasePins,
} from "../deployments/upv5Cutover";
import {
  Upv5CheckMode, Upv5CheckPhase, Upv5Snapshot, evaluateUpv5Postconditions, formatUpv5Checks, readUpv5Snapshot,
  routingStateFromSnapshot,
} from "../deployments/upv5Postconditions";
import { getActivePaymentMethods } from "../deployments/parameters";
import { getDeployerAccounts } from "../utils/deployerKeys";

const ROOT = resolve(__dirname, "..");
const NETWORK = Upv5Network.BaseStaging;
const JOURNAL_FILE = resolve(ROOT, UPV5_STAGING_JOURNAL_PATH);
const USAGE = "Usage: upv5-staging-cutover.ts [--execute] [--rpc <url>]";
const STAGING_METHOD_NAMES = new Map(getActivePaymentMethods(NETWORK).map((name) => [utils.id(name), name]));

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function rpcUrl(args: string[]): string {
  const explicit = option(args, "--rpc") ?? process.env.STAGING_RPC_URL;
  if (explicit) return explicit;
  if (process.env.ALCHEMY_API_KEY) return `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  return "https://base-rpc.publicnode.com";
}

export function journalInput(journal: Upv5StagingJournal, deployed: Upv5Deployed): Upv5CutoverInput {
  for (const field of ["nullifierRegistryV3", "unifiedPaymentVerifierV5", "disputeVerifierV2"] as const) {
    if (!sameAddress(journal.deployed[field], deployed[field])) throw new Error(`Journal ${field} differs from the deployment record`);
  }
  const pins = upv5ReleasePins(NETWORK);
  return {
    chainId: pins.chainId, paymentVerifierRegistry: pins.paymentVerifierRegistry,
    nullifierRegistryV2: pins.nullifierRegistryV2, disputeProtectionPolicyV2: pins.disputeProtectionPolicyV2,
    deployed, retiredWriters: journal.retiredWriters, routes: journal.routes,
  };
}

/**
 * Without a journal the plan can only be rebuilt from a state no cutover call has touched. A crash after some
 * route removals plus a lost journal would otherwise drop those methods silently, so every sign of an earlier
 * run (fewer writers, a V3 grant, a moved route or dispute verifier, a catalog smaller than UPV4's) stops it.
 */
export function assertFreshStagingState(snapshot: Upv5Snapshot, addresses: Upv5ContractAddresses): void {
  const problems: string[] = [];
  if (snapshot.nullifierRegistryV2Writers.length === 0) problems.push("NullifierRegistryV2 has no writers left");
  if (snapshot.nullifierRegistryV3.writers.length > 0) problems.push("NullifierRegistryV3 already has writers");
  if (!sameAddress(snapshot.policy.disputeVerifier, addresses.disputeVerifier)) {
    problems.push(`DisputeProtectionPolicyV2 selects ${snapshot.policy.disputeVerifier}, not the old DisputeVerifier`);
  }
  if (snapshot.routes.length === 0 || snapshot.routes.some((route) => !sameAddress(route.verifier, addresses.unifiedPaymentVerifierV4))) {
    problems.push("not every PaymentVerifierRegistry route is on UPV4");
  }
  const registry = snapshot.routes.map((route) => lower(route.method)).sort();
  const upv4 = snapshot.unifiedPaymentVerifierV4.methods.map(lower).sort();
  if (JSON.stringify(registry) !== JSON.stringify(upv4)) {
    problems.push(`PaymentVerifierRegistry methods [${registry.join(", ")}] differ from UPV4's [${upv4.join(", ")}]`);
  }
  if (problems.length > 0) {
    throw new Error(`No journal at ${UPV5_STAGING_JOURNAL_PATH} and the state is not untouched; refusing to rebuild the plan:\n- ` +
      problems.join("\n- "));
  }
}

/**
 * Builds the staging plan once, from the untouched pre-cutover state: every NullifierRegistryV2 writer is
 * retired, whatever it is, and every route is re-added with the currencies it has now. The plan is journaled
 * before the first transaction because removed routes lose their currencies on-chain, so a resumed run must
 * not rebuild it from live state.
 */
async function main(args: string[]): Promise<void> {
  const rpc = option(args, "--rpc");
  const known = args.filter((arg) => arg === "--execute" || arg === "--rpc" || arg === rpc);
  if (known.length !== args.length) throw new Error(USAGE);
  dotenv.config({ path: resolve(ROOT, ".env") });
  const execute = args.includes("--execute");
  const pins = upv5ReleasePins(NETWORK);
  const addresses = readUpv5Addresses(ROOT, NETWORK);
  const provider = new providers.StaticJsonRpcProvider(rpcUrl(args), pins.chainId);
  if ((await provider.getNetwork()).chainId !== pins.chainId) throw new Error("RPC is not Base (8453)");

  const snapshot = await readUpv5Snapshot(provider, addresses);
  let journal = readUpv5StagingJournal(ROOT);
  const bindings = readUpv5Bindings(ROOT, NETWORK, addresses);
  const catalogOf = (planned: Upv5StagingJournal | null): Upv5CatalogPlan | null =>
    planned ? { source: UPV5_STAGING_JOURNAL_PATH, routes: planned.routes } : null;
  const checks = evaluateUpv5Postconditions(snapshot, addresses, { governance: pins.governance, bindings, catalog: catalogOf(journal) });
  const deploymentFailures = checks.filter((check) => check.phase === Upv5CheckPhase.Deployment && !check.ok);
  if (deploymentFailures.length > 0) {
    throw new Error(`The deployed UPV5 stack is not ready for the cutover:\n${formatUpv5Checks(deploymentFailures, Upv5CheckMode.Post)}`);
  }
  for (const [label, owner] of [
    ["NullifierRegistryV2", snapshot.nullifierRegistryV2Owner], ["PaymentVerifierRegistry", snapshot.paymentVerifierRegistryOwner],
    ["DisputeProtectionPolicyV2", snapshot.policy.owner],
  ] as const) {
    if (!sameAddress(owner, pins.governance)) throw new Error(`${label} owner ${owner} is not the staging signer`);
  }

  let input: Upv5CutoverInput;
  if (journal) {
    input = journalInput(journal, addresses);
    process.stdout.write(`Resuming the plan journaled at block ${journal.plannedAtBlock} (${JOURNAL_FILE}).\n`);
  } else {
    assertFreshStagingState(snapshot, addresses);
    input = {
      chainId: pins.chainId, paymentVerifierRegistry: addresses.paymentVerifierRegistry,
      nullifierRegistryV2: addresses.nullifierRegistryV2, disputeProtectionPolicyV2: addresses.disputeProtectionPolicyV2,
      deployed: addresses, retiredWriters: snapshot.nullifierRegistryV2Writers.map((writer) => utils.getAddress(writer)),
      routes: snapshot.routes.map((route) => ({
        method: route.method, currencies: route.currencies, label: STAGING_METHOD_NAMES.get(route.method.toLowerCase()),
      })),
    };
  }

  const upv5Methods = snapshot.unifiedPaymentVerifierV5.methods.map((method) => method.toLowerCase());
  const unsupported = input.routes.filter((route) => !upv5Methods.includes(route.method.toLowerCase()));
  if (unsupported.length > 0) {
    throw new Error(`UPV5 lacks routed methods [${unsupported.map((route) => route.method).join(", ")}]; re-run lane 49 first`);
  }

  const calls = buildUpv5CutoverCalls(input);
  const pending = pendingUpv5Calls(calls, routingStateFromSnapshot(snapshot, addresses));
  const firstPending = calls.length - pending.length;
  process.stdout.write(`Base staging UPV5 cutover at block ${snapshot.blockNumber}: ${calls.length} calls, ` +
    `${pending.length} to send.\n`);
  calls.forEach((call, index) => {
    process.stdout.write(`${index < firstPending ? "done" : "todo"}  ${String(index).padStart(2)}  ${call.description}\n` +
      `      to=${call.to} data=${encodeUpv5Call(call).data}\n`);
  });

  if (!execute) {
    await simulate(provider, pending, snapshot.routes.map((route) => route.method.toLowerCase()), pins.governance, snapshot.blockNumber);
    process.stdout.write("\nDry run only; nothing was sent. Re-run with --execute to send the todo calls.\n\n");
    process.stdout.write(formatUpv5Checks(checks, Upv5CheckMode.Pre));
    return;
  }

  const [key] = getDeployerAccounts(process.env).base_staging;
  if (!key) throw new Error("STAGING_DEPLOYER_KEY is not set");
  const wallet = new Wallet(key, provider);
  if (!sameAddress(wallet.address, pins.governance)) throw new Error(`STAGING_DEPLOYER_KEY signs as ${wallet.address}, not the staging signer`);

  if (!journal) {
    journal = {
      network: NETWORK, chainId: pins.chainId, plannedAtBlock: snapshot.blockNumber,
      deployed: {
        nullifierRegistryV3: addresses.nullifierRegistryV3, unifiedPaymentVerifierV5: addresses.unifiedPaymentVerifierV5,
        disputeVerifierV2: addresses.disputeVerifierV2,
      },
      retiredWriters: input.retiredWriters, routes: input.routes, transactions: [],
    };
    writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2) + "\n");
  }
  for (const [offset, call] of pending.entries()) {
    const index = firstPending + offset;
    const request = encodeUpv5Call(call);
    const response = await wallet.sendTransaction({ to: request.to, data: request.data });
    process.stdout.write(`sent  ${String(index).padStart(2)}  ${call.description}: ${response.hash}\n`);
    const receipt = await response.wait();
    if (receipt.status !== 1) throw new Error(`Call ${index} reverted: ${response.hash}`);
    journal.transactions.push({ index, description: call.description, to: request.to, data: request.data,
      hash: response.hash, blockNumber: receipt.blockNumber });
    writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2) + "\n");
  }

  const after = await readUpv5Snapshot(provider, addresses);
  const result = evaluateUpv5Postconditions(after, addresses, { governance: pins.governance, bindings, catalog: catalogOf(journal) });
  process.stdout.write(`\nPost-check at block ${after.blockNumber}:\n${formatUpv5Checks(result, Upv5CheckMode.Post)}`);
  if (result.some((check) => !check.ok)) process.exitCode = 1;
}

/** Route re-adds depend on the removal before them, so only calls valid against the current state are simulated. */
async function simulate(provider: providers.JsonRpcProvider, pending: Upv5Call[], routed: string[], from: string, blockTag: number) {
  process.stdout.write("\nSimulating from the staging signer:\n");
  for (const call of pending) {
    if (call.signature === Upv5Function.AddMethod && routed.includes(scalarArg(call, 0).toLowerCase())) {
      process.stdout.write(`skip  ${call.description} (runs after its removal)\n`);
      continue;
    }
    try {
      await simulateUpv5Call(provider, from, encodeUpv5Call(call), blockTag);
      process.stdout.write(`ok    ${call.description}\n`);
    } catch (error) {
      throw new Error(`Simulation reverted: ${call.description}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
