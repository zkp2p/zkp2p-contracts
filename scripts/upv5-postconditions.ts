import { resolve } from "node:path";
import { providers, utils } from "ethers";
import {
  Upv5Network, parseUpv5Network, readUpv5Addresses, readUpv5Bindings, upv5CatalogFor, upv5ReleasePins,
} from "../deployments/upv5Cutover";
import {
  Upv5CheckMode, evaluateUpv5Postconditions, formatUpv5Checks, readUpv5Snapshot,
} from "../deployments/upv5Postconditions";

const ROOT = resolve(__dirname, "..");
const DEFAULT_RPC_URL = "https://base-rpc.publicnode.com";
const USAGE = "Usage: upv5-postconditions.ts <network> [--pre] [--rpc <url>] [--governance <address>] [--block <number>]";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function governanceFor(network: string, override: string | undefined): string {
  if (override !== undefined) {
    if (!utils.isAddress(override)) throw new Error("--governance: invalid address");
    return utils.getAddress(override);
  }
  if (Object.values(Upv5Network).some((candidate) => candidate === network)) {
    return upv5ReleasePins(parseUpv5Network(network)).governance;
  }
  throw new Error(`--governance is required for ${network}`);
}

/** Read-only. Exits non-zero in post mode when any check fails, and in either mode when a read fails. */
async function main(args: string[]): Promise<void> {
  const network = args[0];
  if (network === undefined || network.startsWith("--")) throw new Error(USAGE);
  const mode = args.includes("--pre") ? Upv5CheckMode.Pre : Upv5CheckMode.Post;
  const addresses = readUpv5Addresses(ROOT, network);
  const governance = governanceFor(network, option(args, "--governance"));
  const provider = new providers.StaticJsonRpcProvider(option(args, "--rpc") ?? process.env.BASE_RPC_URL ?? DEFAULT_RPC_URL);
  const block = option(args, "--block");
  const snapshot = await readUpv5Snapshot(provider, addresses, block === undefined ? undefined : Number(block));
  const checks = evaluateUpv5Postconditions(snapshot, addresses, {
    governance, bindings: readUpv5Bindings(ROOT, network, addresses), catalog: upv5CatalogFor(ROOT, network),
  });
  process.stdout.write(`UPV5 ${mode}-check on ${network} at block ${snapshot.blockNumber} (governance ${governance})\n`);
  process.stdout.write(formatUpv5Checks(checks, mode));
  const open = checks.filter((check) => !check.ok).length;
  process.stdout.write(`${checks.length - open}/${checks.length} true${open === 0 ? "" : `, ${open} not yet true`}\n`);
  if (mode === Upv5CheckMode.Post && open > 0) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
