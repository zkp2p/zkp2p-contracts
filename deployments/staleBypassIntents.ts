import { utils } from "ethers";
import type { providers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Deployment } from "hardhat-deploy/types";
import { BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS } from "./bypassDisputeStack";

const lower = (value: string): string => value.toLowerCase();
function requireState(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function deploymentBlock(record: Deployment): number {
  const block = record.receipt?.blockNumber;
  requireState(
    typeof block === "number" && Number.isSafeInteger(block) && block >= 0,
    `${record.address} lacks deployment block evidence`
  );
  return block;
}

export async function pagedLogs(
  hre: HardhatRuntimeEnvironment,
  filter: Omit<providers.Filter, "fromBlock" | "toBlock">,
  from: number,
  to: number
): Promise<providers.Log[]> {
  if (from > to) return [];
  async function readRange(
    start: number,
    end: number
  ): Promise<providers.Log[]> {
    try {
      return await hre.ethers.provider.getLogs({
        ...filter,
        fromBlock: start,
        toBlock: end,
      });
    } catch (error) {
      if (start === end) throw error;
      const middle = start + Math.floor((end - start) / 2);
      const left = await readRange(start, middle);
      const right = await readRange(middle + 1, end);
      return left.concat(right);
    }
  }
  const logs = await readRange(from, to);
  return logs.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex
  );
}

export function openStaleBypassIntents(
  events: { name: string; intentHash: string }[]
): string[] {
  const opened = new Set<string>();
  const terminal = new Set<string>();
  for (const event of events) {
    const hash = event.intentHash.toLowerCase();
    if (event.name === "DisputeProtectionIntentOpened") opened.add(hash);
    if (
      event.name === "DisputeProtectionIntentCancelled" ||
      event.name === "DisputeProtectionIntentSettled"
    )
      terminal.add(hash);
  }
  return [...opened].filter((hash) => !terminal.has(hash));
}
type ReadStaleLogs = (
  filter: providers.Filter
) => Promise<Array<Pick<providers.Log, "topics" | "data">>>;
export async function readOpenStaleBypassIntents(
  readLogs: ReadStaleLogs,
  staleRecord: Deployment,
  toBlock: number
): Promise<string[]> {
  const iface = new utils.Interface(staleRecord.abi);
  const logs = await readLogs({
    address: staleRecord.address,
    fromBlock: deploymentBlock(staleRecord),
    toBlock,
  });
  const events = logs
    .map((log) => iface.parseLog(log))
    .filter((event) =>
      [
        "DisputeProtectionIntentOpened",
        "DisputeProtectionIntentCancelled",
        "DisputeProtectionIntentSettled",
      ].includes(event.name)
    )
    .map((event) => ({
      name: event.name,
      intentHash: String(event.args.intentHash),
    }));
  return openStaleBypassIntents(events);
}
export async function assertStaleBypassIntentsDrained(
  readLogs: ReadStaleLogs,
  staleRecord: Deployment,
  toBlock: number
): Promise<void> {
  const open = await readOpenStaleBypassIntents(readLogs, staleRecord, toBlock);
  requireState(
    open.length === 0,
    `Stale bypass intents still open: ${open.length}; ${open.join(", ")}`
  );
}
export async function stalePolicyScan(
  hre: HardhatRuntimeEnvironment,
  toBlock: number
) {
  const record = await hre.deployments.get("DisputeProtectionPolicyBypass");
  const pin =
    BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS.DisputeProtectionPolicyBypass;
  requireState(
    lower(record.address) === lower(pin.address),
    "Stale bypass policy address mismatch"
  );
  requireState(
    lower(
      hre.ethers.utils.keccak256(
        await hre.ethers.provider.getCode(pin.address, toBlock)
      )
    ) === lower(pin.runtimeCodeHash),
    "Stale bypass policy runtime bytecode hash mismatch"
  );
  const readLogs: ReadStaleLogs = (filter) =>
    pagedLogs(
      hre,
      { address: filter.address },
      Number(filter.fromBlock),
      Number(filter.toBlock)
    );
  return { record, readLogs };
}

export async function reportOpenStaleBypassIntents(
  readLogs: ReadStaleLogs,
  staleRecord: Deployment,
  toBlock: number,
  report: (message: string) => void = console.log
): Promise<void> {
  const open = await readOpenStaleBypassIntents(readLogs, staleRecord, toBlock);
  report(`Stale bypass intents still open: ${open.length}; ${open.join(", ")}`);
}
