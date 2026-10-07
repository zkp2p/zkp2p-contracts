import { readFileSync } from "fs";
import { resolve } from "path";
import { BigNumber, Contract, ethers } from "ethers";

export type CutoverIntent = {
  hash: string;
  status: number;
  stakeOwner: string;
  releaseAmount: string;
  releaseEligibleAt: string;
  lockOwner: string;
  lockAmount: string;
  lockMaturity: string;
};

/** A settled inventory is deliberately allowed: its locks stay in the same vault for lazy adoption. */
export function assertDrainedInventory(intents: CutoverIntent[]): void {
  for (const intent of intents) {
    if (intent.status === 1) throw new Error(`Pending predecessor intent: ${intent.hash}`);
    if (intent.status === 0) throw new Error(`Missing predecessor admission: ${intent.hash}`);
    if (intent.status === 3) {
      if (intent.stakeOwner.toLowerCase() !== intent.lockOwner.toLowerCase()
          || intent.releaseAmount !== intent.lockAmount || intent.releaseEligibleAt !== intent.lockMaturity) {
        throw new Error(`Predecessor lock mismatch: ${intent.hash}`);
      }
    } else if (intent.lockAmount !== "0") throw new Error(`Terminal predecessor still locked: ${intent.hash}`);
  }
}

type Configuration = {
  rpcUrl: string;
  chainId: number;
  governance: string;
  predecessor: string;
  predecessorDeploymentTransaction: string;
  successor: string;
  successorDeploymentTransaction: string;
  vault: string;
  disputeVerifier: string;
  disputeRegistry: string;
  upv: string;
  witnessVerifier: string;
  oldHook: string;
  newHook: string;
  orchestrator: string;
};

function requireEqual(actual: string, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} mismatch`);
}

/** Read-only preflight and unsigned Safe calls. Re-run immediately before governance execution. */
export async function prepareStakePolicyCutover(config: Configuration) {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error("Invalid chainId");
  for (const field of ["governance", "predecessor", "successor", "vault", "disputeVerifier", "disputeRegistry", "upv", "witnessVerifier", "oldHook", "newHook", "orchestrator"] as const) {
    if (!ethers.utils.isAddress(config[field]) || config[field] === ethers.constants.AddressZero) throw new Error(`Invalid ${field}`);
  }
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  if ((await provider.getNetwork()).chainId !== config.chainId) throw new Error("Wrong chain");
  const block = await provider.getBlock("latest");
  const at = { blockTag: block.number };
  const artifact = (file: string, name: string) => JSON.parse(readFileSync(resolve(__dirname, `../artifacts/contracts/${file}.sol/${name}.json`), "utf8")).abi;
  const old = new Contract(config.predecessor, artifact("hooks/DisputeProtectionPolicy", "DisputeProtectionPolicy"), provider);
  const next = new Contract(config.successor, artifact("hooks/DisputeProtectionPolicyV2", "DisputeProtectionPolicyV2"), provider);
  const vault = new Contract(config.vault, artifact("StakeVault", "StakeVault"), provider);
  const hook = new Contract(config.newHook, artifact("hooks/IntentLifecycleHookV2", "IntentLifecycleHookV2"), provider);
  const oldHook = new Contract(config.oldHook, artifact("hooks/IntentLifecycleHookV1", "IntentLifecycleHookV1"), provider);
  const upv = new Contract(config.upv, artifact("unifiedVerifier/UnifiedPaymentVerifierV3", "UnifiedPaymentVerifierV3"), provider);
  const registry = new Contract(config.disputeRegistry, artifact("registries/NullifierRegistry", "NullifierRegistry"), provider);
  const o3 = new Contract(config.orchestrator, artifact("OrchestratorV3", "OrchestratorV3"), provider);

  for (const [contract, label] of [[old, "predecessor"], [next, "successor"]] as const) {
    requireEqual(await contract.stakeVault(at), config.vault, `${label} vault`);
    requireEqual(await contract.disputeVerifier(at), config.disputeVerifier, `${label} dispute verifier`);
    requireEqual(await contract.disputeNullifierRegistry(at), config.disputeRegistry, `${label} registry`);
    requireEqual(await contract.owner(at), config.governance, `${label} governance`);
  }
  for (const contract of [vault, upv, registry, o3]) requireEqual(await contract.owner(at), config.governance, "governance");
  requireEqual(await next.predecessor(at), config.predecessor, "trusted predecessor");
  requireEqual(await vault.controller(at), config.predecessor, "current controller");
  requireEqual(await vault.pendingController(at), config.successor, "pending controller");
  const controllerValidAt = await vault.pendingControllerValidAt(at);
  if (BigNumber.from(controllerValidAt).gt(block.timestamp)) throw new Error("Controller change delay has not elapsed");
  if (!(await old.admissionsPaused(at))) throw new Error("Predecessor admissions must be paused");
  if (await next.admissionsPaused(at)) throw new Error("Successor admissions are paused");
  requireEqual(await hook.disputeProtectionPolicy(at), config.successor, "new hook policy");
  requireEqual(await hook.paymentVerifier(at), config.upv, "new hook UPV3");
  requireEqual(await hook.signatureVerifier(at), config.witnessVerifier, "captured witness verifier");
  requireEqual(await upv.attestationVerifier(at), config.witnessVerifier, "current witness verifier");
  requireEqual(await hook.orchestratorRegistry(at), await upv.orchestratorRegistry(at), "orchestrator registry");
  requireEqual(await oldHook.orchestratorRegistry(at), await hook.orchestratorRegistry(at), "old hook registry");
  requireEqual(await oldHook.whitelistPolicy(at), await hook.whitelistPolicy(at), "retained whitelist policy");
  requireEqual(await oldHook.disputeProtectionPolicy(at), config.predecessor, "old hook policy");
  requireEqual(await o3.lifecycleHook(at), config.oldHook, "future admission hook");
  if (!(await next.isLifecycleHookAuthorized(config.newHook, at))) throw new Error("New hook is not authorized");
  if (!(await old.isLifecycleHookAuthorized(config.oldHook, at))) throw new Error("Old callbacks are not authorized");
  const orchestratorRegistry = new Contract(await hook.orchestratorRegistry(at), ["function isOrchestrator(address) view returns (bool)"], provider);
  if (!(await orchestratorRegistry.isOrchestrator(config.orchestrator, at))) throw new Error("O3 is unregistered");
  const methods = new Contract(await o3.paymentVerifierRegistry(at), ["function getVerifier(bytes32) view returns (address)"], provider);
  for (const rail of ["venmo", "paypal"]) {
    requireEqual(await methods.getVerifier(ethers.utils.id(rail), at), config.upv, `${rail} UPV3 route`);
    if (!BigNumber.from(await next.getRiskWindow(ethers.utils.id(rail), at)).eq(14 * 86400)) throw new Error(`${rail} default is not 14 days`);
  }
  for (const [name, rail, kind, window] of [
    ["venmo_personal", "venmo", 0, 0], ["paypal_personal", "paypal", 0, 0],
    ["venmo_goods_and_services", "venmo", 1, 90 * 86400], ["paypal_goods_and_services", "paypal", 1, 90 * 86400],
    ["venmo_balance", "venmo", 1, 0],
  ] as const) {
    const rule = await hook.policies(ethers.utils.id(name), at);
    requireEqual(rule.paymentMethod, ethers.utils.id(rail), `${name} method`);
    if (rule.kind !== kind || !BigNumber.from(rule.window).eq(window)) throw new Error(`${name} terms mismatch`);
    // Balance admissions remain off until live Nitro and consumer qualification is separately completed.
    if (rule.noStakeAdmissionEnabled) throw new Error(`${name} no-stake admission must remain disabled during cutover`);
  }

  async function creationBlock(transaction: string, contract: Contract): Promise<number> {
    const receipt = await provider.getTransactionReceipt(transaction);
    if (!receipt || receipt.status !== 1 || !receipt.contractAddress || receipt.blockNumber > block.number) throw new Error("Invalid policy deployment receipt");
    requireEqual(receipt.contractAddress, contract.address, "deployment address");
    return receipt.blockNumber;
  }
  const oldStart = await creationBlock(config.predecessorDeploymentTransaction, old);
  const nextStart = await creationBlock(config.successorDeploymentTransaction, next);
  async function events(contract: Contract, name: string, start: number) {
    const rows: ethers.utils.LogDescription[] = [];
    for (let from = start; from <= block.number; from += 5000) {
      const logs = await provider.getLogs({ address: contract.address, topics: [contract.interface.getEventTopic(name)], fromBlock: from, toBlock: Math.min(from + 4999, block.number) });
      rows.push(...logs.map((log) => contract.interface.parseLog(log)));
    }
    return rows;
  }
  const hashes = new Set((await events(old, "DisputeProtectionIntentOpened", oldStart)).map((event) => event.args.intentHash as string));
  const inventory: CutoverIntent[] = [];
  for (const hash of hashes) {
    const record = await old.getDisputeProtectionIntent(hash, at);
    const lock = await vault.locks(hash, at);
    inventory.push({ hash, status: record.status, stakeOwner: record.stakeOwner, releaseAmount: record.releaseAmount.toString(), releaseEligibleAt: record.releaseEligibleAt.toString(), lockOwner: lock.stakeOwner, lockAmount: lock.amount.toString(), lockMaturity: lock.maturesAt.toString() });
  }
  assertDrainedInventory(inventory);
  if ((await events(next, "LegacyIntentAdopted", nextStart)).length !== 0) throw new Error("Successor already adopted predecessor state; do not replay cutover");
  if ((await events(hook, "PolicyIntentSignaled", nextStart)).length !== 0) throw new Error("New hook already admitted policy intents");
  if ((await events(next, "DisputeProtectionIntentOpened", nextStart)).length !== 0) throw new Error("Successor already admitted stake before cutover");
  function latestTuples(rows: ethers.utils.LogDescription[]) {
    const tuples = new Map<string, ethers.utils.Result>();
    for (const event of rows) {
      const args = event.args;
      tuples.set(`${args.escrow.toLowerCase()}:${args.depositId.toString()}:${args.paymentMethod}`, args);
    }
    return tuples;
  }
  const oldTuples = latestTuples(await events(old, "DisputeProtectionEnabledUpdated", oldStart));
  const nextTuples = latestTuples(await events(next, "DisputeProtectionEnabledUpdated", nextStart));
  const optOuts: string[] = [];
  for (const [key, tuple] of oldTuples) {
    if (tuple.isDisputeProtectionEnabled) continue;
    const replacement = nextTuples.get(key);
    if (!replacement || replacement.isDisputeProtectionEnabled) throw new Error(`Depositor must reapply opt-out: ${key}`);
    optOuts.push(key);
  }
  const writers: string[] = await registry.getWriters(at);
  if (writers.length !== 1 || writers[0].toLowerCase() !== config.predecessor.toLowerCase()) throw new Error("Unexpected dispute writer inventory");
  const call = (contract: Contract, method: string, args: unknown[]) => ({ to: contract.address, value: "0", data: contract.interface.encodeFunctionData(method, args) });
  const calls = [
    call(next, "acceptVaultController", []), call(registry, "addWritePermission", [config.successor]),
    call(upv, "setAttestationVerifier", [config.newHook]), call(o3, "setLifecycleHook", [config.newHook]),
    call(registry, "removeWritePermission", [config.predecessor]),
  ];
  requireEqual((await provider.getBlock(block.number)).hash, block.hash, "pinned block hash");
  return {
    chainId: config.chainId, block: block.number, blockHash: block.hash, governance: config.governance,
    controllerChangeDelay: (await vault.controllerChangeDelay(at)).toString(), inventory, optOuts,
    totalStaked: (await vault.totalStaked(at)).toString(), totalClaimable: (await vault.totalClaimable(at)).toString(),
    calls,
  };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: ts-node scripts/prepareStakePolicyCutover.ts <configuration.json>");
  prepareStakePolicyCutover(JSON.parse(readFileSync(file, "utf8"))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
