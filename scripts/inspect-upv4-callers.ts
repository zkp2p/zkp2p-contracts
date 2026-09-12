import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { constants, providers, utils } from "ethers";

const registryInterface = new utils.Interface([
  "event OrchestratorAdded(address indexed orchestrator)",
  "event OrchestratorRemoved(address indexed orchestrator)",
  "function isOrchestrator(address) view returns (bool)",
  "function owner() view returns (address)",
]);
const added = registryInterface.getEventTopic("OrchestratorAdded");
const removed = registryInterface.getEventTopic("OrchestratorRemoved");

class CallerInventoryError extends Error {}

type RegistryDeployment = {
  address: string;
  transactionHash: string;
  bytecode: string;
  deployedBytecode: string;
};

/** Full registry history from a trusted archive RPC; not a caller-behavior or drain proof. */
export async function inspectUpv4Callers(
  provider: providers.Provider,
  deployment: RegistryDeployment,
  knownCallers: string[],
  blockNumber: number,
  blockSpan: number
) {
  if (
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < 1 ||
    !Number.isSafeInteger(blockSpan) ||
    blockSpan < 1
  )
    throw new CallerInventoryError(
      "Block number and scan span must be positive safe integers"
    );
  const registry = utils.getAddress(deployment.address);
  const chain = await provider.getNetwork();
  if (chain.chainId !== 8453)
    throw new CallerInventoryError("Caller inventory requires Base chain 8453");
  const receipt = await provider.getTransactionReceipt(
    deployment.transactionHash
  );
  const creation = await provider.getTransaction(deployment.transactionHash);
  if (
    !receipt ||
    receipt.status !== 1 ||
    !receipt.contractAddress ||
    utils.getAddress(receipt.contractAddress) !== registry ||
    receipt.transactionHash.toLowerCase() !==
      deployment.transactionHash.toLowerCase() ||
    !creation ||
    creation.to !== null ||
    creation.hash.toLowerCase() !== deployment.transactionHash.toLowerCase() ||
    creation.data.toLowerCase() !== deployment.bytecode.toLowerCase() ||
    creation.blockHash !== receipt.blockHash ||
    receipt.blockNumber < 1 ||
    receipt.blockNumber > blockNumber
  )
    throw new CallerInventoryError(
      "Registry creation does not match the recorded deployment"
    );
  const start = await provider.getBlock(receipt.blockNumber);
  const anchor = await provider.getBlock(blockNumber);
  if (!start || start.hash !== receipt.blockHash || !anchor)
    throw new CallerInventoryError(
      "Registry creation or inventory block is not canonical"
    );
  const runtime = await provider.getCode(registry, blockNumber);
  if (
    runtime === "0x" ||
    runtime.toLowerCase() !== deployment.deployedBytecode.toLowerCase() ||
    (await provider.getCode(registry, receipt.blockNumber)).toLowerCase() !==
      runtime.toLowerCase() ||
    (await provider.getCode(registry, receipt.blockNumber - 1)) !== "0x"
  )
    throw new CallerInventoryError(
      "Registry runtime or creation boundary differs from the recorded deployment"
    );

  const events: Array<{
    blockNumber: number;
    blockHash: string;
    transactionHash: string;
    logIndex: number;
    orchestrator: string;
    authorized: boolean;
  }> = [];
  const membership = new Map<string, boolean>();
  let rangesScanned = 0;
  for (let fromBlock = receipt.blockNumber; fromBlock <= blockNumber; ) {
    const toBlock = Math.min(blockNumber, fromBlock + blockSpan - 1);
    const logs = await provider.getLogs({
      address: registry,
      fromBlock,
      toBlock,
      topics: [[added, removed]],
    });
    logs.sort(
      (left, right) =>
        left.blockNumber - right.blockNumber || left.logIndex - right.logIndex
    );
    let previousBlock = -1;
    let previousIndex = -1;
    for (const log of logs) {
      if (
        log.removed ||
        utils.getAddress(log.address) !== registry ||
        !Number.isSafeInteger(log.blockNumber) ||
        log.blockNumber < fromBlock ||
        log.blockNumber > toBlock ||
        !Number.isSafeInteger(log.logIndex) ||
        log.logIndex < 0 ||
        (log.blockNumber === previousBlock && log.logIndex <= previousIndex) ||
        log.topics.length !== 2 ||
        ![added, removed].includes(log.topics[0]) ||
        log.data !== "0x" ||
        !utils.isHexString(log.blockHash, 32) ||
        !utils.isHexString(log.transactionHash, 32)
      )
        throw new CallerInventoryError(
          "Malformed, duplicate or out-of-range registry event"
        );
      const decoded = registryInterface.parseLog(log);
      const orchestrator = utils.getAddress(decoded.args.orchestrator);
      const authorized = log.topics[0] === added;
      if (
        orchestrator === constants.AddressZero ||
        authorized === (membership.get(orchestrator) === true)
      )
        throw new CallerInventoryError(
          `Inconsistent registry history for ${orchestrator}`
        );
      membership.set(orchestrator, authorized);
      events.push({
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        orchestrator,
        authorized,
      });
      previousBlock = log.blockNumber;
      previousIndex = log.logIndex;
    }
    rangesScanned++;
    fromBlock = toBlock + 1;
  }
  // Artifact candidates also catch an entirely omitted history for a known active caller.
  for (const candidate of knownCallers) {
    const address = utils.getAddress(candidate);
    if (!membership.has(address)) membership.set(address, false);
  }
  const callers: Array<{
    address: string;
    authorized: boolean;
    runtimeCodeHash: string;
  }> = [];
  for (const [address, authorized] of membership) {
    const result = await provider.call(
      {
        to: registry,
        data: registryInterface.encodeFunctionData("isOrchestrator", [address]),
      },
      blockNumber
    );
    if (
      result !==
      registryInterface.encodeFunctionResult("isOrchestrator", [authorized])
    )
      throw new CallerInventoryError(
        `Registry getter disagrees with history for ${address}`
      );
    callers.push({
      address,
      authorized,
      runtimeCodeHash: utils.keccak256(
        await provider.getCode(address, blockNumber)
      ),
    });
  }
  const [owner] = registryInterface.decodeFunctionResult(
    "owner",
    await provider.call(
      {
        to: registry,
        data: registryInterface.encodeFunctionData("owner"),
      },
      blockNumber
    )
  );
  if (
    (await provider.getBlock(blockNumber)).hash !== anchor.hash ||
    (await provider.getBlock(receipt.blockNumber)).hash !== start.hash
  )
    throw new CallerInventoryError("Chain reorganized during caller inventory");
  return {
    chainId: chain.chainId,
    blockNumber,
    blockHash: anchor.hash,
    registry,
    registryRuntimeCodeHash: utils.keccak256(runtime),
    owner: String(owner),
    creationTransaction: deployment.transactionHash,
    creationBlock: receipt.blockNumber,
    creationBlockHash: start.hash,
    blockSpan,
    rangesScanned,
    events,
    callers,
    limitations: [
      "History completeness depends on the trusted archive RPC returning every matching log.",
      "Runtime hashes do not identify or approve caller admission behavior, escrow reachability or payment drain.",
      "The snapshot is not an execution-time guard or activation authorization.",
    ],
  };
}

async function main() {
  const [network, block, output, span = "2000", ...extra] =
    process.argv.slice(2);
  if (
    (network !== "base" && network !== "base_staging") ||
    !block ||
    !output ||
    extra.length
  )
    throw new Error(
      "usage: inspect-upv4-callers <base|base_staging> <block> <new-output.json> [block-span]"
    );
  const rpc = process.env.UPV4_INVENTORY_RPC_URL;
  if (!rpc)
    throw new Error("UPV4_INVENTORY_RPC_URL must select a trusted archive RPC");
  const root = resolve(__dirname, "..");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("status", "--porcelain"))
    throw new Error("Caller inventory requires clean committed source");
  const sourceSha = git("rev-parse", "HEAD");
  const recordPath = `deployments/${network}/OrchestratorRegistry.json`;
  const record = readFileSync(resolve(root, recordPath), "utf8");
  const knownCallers = ["Orchestrator", "OrchestratorV2", "OrchestratorV3"].map(
    (name) => {
      const path = `deployments/${network}/${name}.json`;
      const contents = readFileSync(resolve(root, path), "utf8");
      return {
        path,
        hash: utils.keccak256(utils.toUtf8Bytes(contents)),
        address: utils.getAddress(JSON.parse(contents).address),
      };
    }
  );
  // The RPC URL can contain credentials. Never echo provider errors or persist connection details.
  let inventory: Awaited<ReturnType<typeof inspectUpv4Callers>>;
  try {
    inventory = await inspectUpv4Callers(
      new providers.JsonRpcProvider(rpc),
      JSON.parse(record),
      knownCallers.map((caller) => caller.address),
      Number(block),
      Number(span)
    );
  } catch (error) {
    if (error instanceof CallerInventoryError) throw error;
    throw new Error(
      "Caller inventory failed: RPC history, deployment identity, event/getter reconciliation or block stability could not be verified; no report written"
    );
  }
  if (git("rev-parse", "HEAD") !== sourceSha || git("status", "--porcelain"))
    throw new Error(
      "Source changed during caller inventory; no report written"
    );
  writeFileSync(
    output,
    JSON.stringify(
      {
        sourceSha,
        network,
        knownCallers,
        deploymentRecord: recordPath,
        deploymentRecordHash: utils.keccak256(utils.toUtf8Bytes(record)),
        ...inventory,
      },
      null,
      2
    ) + "\n",
    { flag: "wx" }
  );
}

if (require.main === module)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Caller inventory failed"}\n`
    );
    process.exitCode = 1;
  });
