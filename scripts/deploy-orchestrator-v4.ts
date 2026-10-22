import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BigNumber, Contract, ContractFactory, Wallet, constants, providers, utils } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { SourceVerificationError, verifySources } from "./verify-orchestrator-v4-source";
import { zeroImmutableValues } from "../deployments/canonicalDeployment";

const ZERO = constants.AddressZero;
const REQUIRED_REGISTRY_OWNERS = ["OrchestratorRegistry", "PaymentVerifierRegistry", "NullifierRegistryV2", "DisputeNullifierRegistry"] as const;
export const NEW_CONTRACTS = {
  StakeVaultV2: "StakeVaultV2",
  AddressGroupRegistryV4: "AddressGroupRegistry",
  WhitelistPolicyV2: "WhitelistPolicyV2",
  DisputeProtectionPolicyV2: "DisputeProtectionPolicyV2",
  UnifiedPaymentVerifierV4: "UnifiedPaymentVerifierV4",
  OrchestratorV4: "OrchestratorV4",
  ProtocolViewerV4: "ProtocolViewerV4",
} as const;
type NewName = keyof typeof NEW_CONTRACTS;
type Pin = { address: string; artifact: string; runtimeCodeHash: string; deploymentTransaction: string; deploymentBlock: number };
export type ReleaseConfig = {
  version: 1; environment: "base_staging" | "base"; chainId: number; signer: string; governance: string;
  existing: Record<string, Pin>; stakeToken: string; protocolFee: string; protocolFeeRecipient: string;
  allowMultipleIntents: boolean; predecessorHook: string; paymentMethods: Array<{ method: string; currencies: string[] }>;
  retainedDisputeWriters: string[]; attestationWitnesses: string[]; attestationThreshold: string; baselineBlock: number;
  legacyDrainCheckpoints: Array<{ contract: string; intentCounter: string; indexedBlock: number }>;
};
type Receipt = { blockNumber: number; blockHash: string; transactionHash: string; gasUsed: string; effectiveGasPrice: string };
type Transaction = { step: string; hash: string; nonce: number; to: string | null; data: string; value: string; receipt: Receipt | null };
type NewContract = { address: string; artifact: string; constructorArguments: unknown[]; transactionHash: string; deploymentBlock: number; runtimeCodeHash: string };
export const DRAIN_QUERY = 'query { Intent(where:{status:{_eq:"SIGNALED"}},limit:1000){intentHash orchestratorAddress status} chain_metadata{latest_processed_block} }';
export type DrainEvidence = {
  pausedAtBlock: number; query: string;
  response: { data: { Intent: Array<{ intentHash: string; orchestratorAddress: string; status: string }>; chain_metadata: Array<{ latest_processed_block: number }> } };
};
export type Manifest = {
  version: 1; sourceCommit: string; configurationHash: string; configuration: ReleaseConfig;
  baseline: Awaited<ReturnType<typeof inspect>>; transactions: Transaction[]; activationDrainEvidence: DrainEvidence | null;
  contracts: Partial<Record<NewName, NewContract>>; verification: Record<string, unknown>; governanceTransactions: Array<{ to: string; data: string; value: string }>;
};
class ReleaseError extends Error {}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new ReleaseError(message); }
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a).toLowerCase() === JSON.stringify(b).toLowerCase();
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function validateConfig(value: unknown): asserts value is ReleaseConfig {
  check(typeof value === "object" && value !== null, "Configuration must be an object");
  const c = value as ReleaseConfig;
  check(c.version === 1 && ["base_staging", "base"].includes(c.environment), "Unsupported release configuration");
  check(Number.isSafeInteger(c.chainId) && c.chainId > 0, "Invalid configured chain ID");
  for (const name of ["signer", "governance", "stakeToken", "protocolFeeRecipient", "predecessorHook"] as const)
    check(typeof c[name] === "string" && utils.isAddress(c[name]) && !same(c[name], ZERO), `Invalid configured ${name}`);
  if (c.environment === "base_staging") check(same(c.signer, c.governance), "Staging governance must be its verified signer");
  check(typeof c.protocolFee === "string" && /^\d+$/.test(c.protocolFee) && BigNumber.from(c.protocolFee).lte("50000000000000000"), "Invalid protocol fee");
  check(typeof c.allowMultipleIntents === "boolean", "Missing allowMultipleIntents setting");
  check(c.existing && typeof c.existing === "object", "Missing reused contract pins");
  for (const name of ["EscrowV2", "EscrowRegistry", "OrchestratorRegistry", "PaymentVerifierRegistry", "RelayerRegistry", "NullifierRegistryV2", "DisputeNullifierRegistry", "DisputeVerifier", "MultiAttestationVerifier", "OrchestratorV3", "UnifiedPaymentVerifierV3", "Orchestrator"]) {
    const pin = c.existing[name];
    check(pin && utils.isAddress(pin.address) && !same(pin.address, ZERO) && /^0x[\da-f]{64}$/i.test(pin.runtimeCodeHash), `Invalid ${name} pin`);
    check(typeof pin.artifact === "string" && /^0x[\da-f]{64}$/i.test(pin.deploymentTransaction) && Number.isSafeInteger(pin.deploymentBlock), `Missing ${name} provenance`);
  }
  check(Array.isArray(c.paymentMethods) && c.paymentMethods.length > 0, "Empty payment catalog");
  const bytes32 = (v: string): boolean => typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
  for (const method of c.paymentMethods) check(bytes32(method.method) && method.currencies.length > 0 && method.currencies.every(bytes32), "Invalid payment method/currency");
  check(new Set(c.paymentMethods.map((m) => m.method.toLowerCase())).size === c.paymentMethods.length, "Duplicate payment method");
  for (const list of [c.retainedDisputeWriters, c.attestationWitnesses]) check(Array.isArray(list) && list.length > 0 && list.every(utils.isAddress), "Invalid writer/witness list");
  check(typeof c.attestationThreshold === "string" && /^[1-9]\d*$/.test(c.attestationThreshold), "Invalid witness threshold");
  check(Array.isArray(c.legacyDrainCheckpoints) && c.legacyDrainCheckpoints.length > 0, "Missing reviewed legacy drain checkpoints");
  for (const checkpoint of c.legacyDrainCheckpoints) check(c.existing[checkpoint.contract] && /^\d+$/.test(checkpoint.intentCounter) && Number.isSafeInteger(checkpoint.indexedBlock), "Invalid legacy drain checkpoint");
  check(c.legacyDrainCheckpoints.some((checkpoint) => checkpoint.contract === "Orchestrator"), "V1 drain checkpoint is required");
}

async function existing(hre: HardhatRuntimeEnvironment, c: ReleaseConfig, name: string): Promise<Contract> {
  const pin = c.existing[name];
  return new Contract(pin.address, (await hre.artifacts.readArtifact(pin.artifact)).abi, hre.ethers.provider);
}

/** One pinned read produces both the rollback baseline and actionable permission errors. */
export async function inspect(hre: HardhatRuntimeEnvironment, c: ReleaseConfig) {
  validateConfig(c);
  const provider = hre.ethers.provider;
  check((await provider.getNetwork()).chainId === c.chainId, "RPC chain ID differs from configuration");
  const block = await provider.getBlock("latest");
  const at = { blockTag: block.number };
  const contracts: Record<string, { address: string; runtimeCodeHash: string; owner: string }> = {};
  for (const [name, pin] of Object.entries(c.existing)) {
    const code = await provider.getCode(pin.address, block.number);
    check(code !== "0x" && same(utils.keccak256(code), pin.runtimeCodeHash), `${name} bytecode differs from pinned deployment`);
    const contract = await existing(hre, c, name);
    contracts[name] = { address: pin.address, runtimeCodeHash: utils.keccak256(code), owner: await contract.owner(at) };
  }
  const pvr = await existing(hre, c, "PaymentVerifierRegistry");
  const paymentMethods = [];
  for (const method of await pvr.getPaymentMethods(at)) paymentMethods.push({ method, currencies: await pvr.getCurrencies(method, at), verifier: await pvr.getVerifier(method, at) });
  const escrow = await existing(hre, c, "EscrowV2"), escrowRegistry = await existing(hre, c, "EscrowRegistry");
  const o3 = await existing(hre, c, "OrchestratorV3"), attestor = await existing(hre, c, "MultiAttestationVerifier");
  const disputeVerifier = await existing(hre, c, "DisputeVerifier"), verifier = await existing(hre, c, "UnifiedPaymentVerifierV3");
  const legacyOrchestrators = [];
  for (const checkpoint of c.legacyDrainCheckpoints) {
    const legacy = await existing(hre, c, checkpoint.contract);
    legacyOrchestrators.push({ contract: checkpoint.contract, paused: await legacy.paused(at), intentCounter: (await legacy.intentCounter(at)).toString() });
  }
  return {
    blockNumber: block.number, blockHash: block.hash, contracts, paymentMethods,
    requiredOwnershipChanges: REQUIRED_REGISTRY_OWNERS.filter((name) => !same(contracts[name].owner, c.governance)).map((name) => ({ name, address: contracts[name].address, owner: contracts[name].owner, requiredOwner: c.governance })),
    nullifierWriters: await (await existing(hre, c, "NullifierRegistryV2")).getWriters(at) as string[],
    disputeWriters: await (await existing(hre, c, "DisputeNullifierRegistry")).getWriters(at) as string[],
    escrow: { chainId: (await escrow.chainId(at)).toString(), orchestratorRegistry: await escrow.orchestratorRegistry(at), paymentVerifierRegistry: await escrow.paymentVerifierRegistry(at), registered: await escrowRegistry.isWhitelistedEscrow(escrow.address, at), intentExpirationPeriod: (await escrow.intentExpirationPeriod(at)).toString() },
    predecessor: { registered: await (await existing(hre, c, "OrchestratorRegistry")).isOrchestrator(o3.address, at), lifecycleHook: await o3.lifecycleHook(at), escrowRegistry: await o3.escrowRegistry(at), paymentVerifierRegistry: await o3.paymentVerifierRegistry(at), relayerRegistry: await o3.relayerRegistry(at), protocolFee: (await o3.protocolFee(at)).toString(), protocolFeeRecipient: await o3.protocolFeeRecipient(at), allowMultipleIntents: await o3.allowMultipleIntents(at), paused: await o3.paused(at) },
    attestation: { witnesses: await attestor.witnesses(at), threshold: (await attestor.requiredSignatures(at)).toString() },
    disputeVerifier: { nullifierRegistry: await disputeVerifier.nullifierRegistry(at), attestationVerifier: await disputeVerifier.attestationVerifier(at) },
    paymentVerifier: { orchestratorRegistry: await verifier.orchestratorRegistry(at), nullifierRegistry: await verifier.nullifierRegistry(at), attestationVerifier: await verifier.attestationVerifier(at) },
    legacyOrchestrators,
    signer: { address: c.signer, balanceWei: (await provider.getBalance(c.signer, block.number)).toString(), nonce: await provider.getTransactionCount(c.signer, block.number), pendingNonce: await provider.getTransactionCount(c.signer, "pending") },
  };
}

export function assertBaseline(c: ReleaseConfig, snapshot: Awaited<ReturnType<typeof inspect>>, manifest?: Manifest, completedActivationSteps?: string[]): void {
  check(snapshot.requiredOwnershipChanges.length === 0, `Activation ownership missing: ${snapshot.requiredOwnershipChanges.map((x) => `${x.name} owner ${x.owner}; requires ${x.requiredOwner}`).join("; ")}`);
  const a = (name: string): string => c.existing[name].address;
  check(snapshot.escrow.chainId === String(c.chainId) && snapshot.escrow.registered && same(snapshot.escrow.orchestratorRegistry, a("OrchestratorRegistry")) && same(snapshot.escrow.paymentVerifierRegistry, a("PaymentVerifierRegistry")), "Existing escrow is incompatible with reused registries");
  check(snapshot.predecessor.registered && !snapshot.predecessor.paused && same(snapshot.predecessor.lifecycleHook, c.predecessorHook), "O3 registration, pause or lifecycle hook changed");
  check(same(snapshot.predecessor.escrowRegistry, a("EscrowRegistry")) && same(snapshot.predecessor.paymentVerifierRegistry, a("PaymentVerifierRegistry")) && same(snapshot.predecessor.relayerRegistry, a("RelayerRegistry")), "O3 reused registry wiring changed");
  for (const verifier of [snapshot.paymentVerifier, snapshot.disputeVerifier]) check(same(verifier.nullifierRegistry, a("NullifierRegistryV2")) && same(verifier.attestationVerifier, a("MultiAttestationVerifier")), "Reused verifier dependency wiring changed");
  check(same(snapshot.paymentVerifier.orchestratorRegistry, a("OrchestratorRegistry")), "Predecessor UPV orchestrator registry changed");
  check(snapshot.predecessor.protocolFee === c.protocolFee && same(snapshot.predecessor.protocolFeeRecipient, c.protocolFeeRecipient) && snapshot.predecessor.allowMultipleIntents === c.allowMultipleIntents, "Predecessor fee or intent configuration changed");
  check(equal(snapshot.attestation.witnesses, c.attestationWitnesses) && snapshot.attestation.threshold === c.attestationThreshold, "Attestation witnesses or threshold changed");
  const freshVerifier = manifest?.contracts.UnifiedPaymentVerifierV4?.address;
  const freshPolicy = manifest?.contracts.DisputeProtectionPolicyV2?.address;
  if (completedActivationSteps) {
    const done = new Set(completedActivationSteps);
    const expectedRoutes = c.paymentMethods.filter(({ method }) => !done.has(`remove-route:${method}`) || done.has(`add-route:${method}`)).map(({ method, currencies }) => ({ method, currencies, verifier: done.has(`add-route:${method}`) ? freshVerifier : a("UnifiedPaymentVerifierV3") }));
    const expectedWriters = [...(done.has("retire-payment-writer") ? [] : [a("UnifiedPaymentVerifierV3")]), ...(done.has("authorize-payment-writer") ? [freshVerifier] : [])];
    const expectedDisputes = [...c.retainedDisputeWriters, ...(done.has("authorize-policy-writer") ? [freshPolicy] : [])];
    check(equal(snapshot.paymentMethods, expectedRoutes), "Payment registry differs from the confirmed activation prefix");
    check(equal(snapshot.nullifierWriters, expectedWriters), "Payment writers differ from the confirmed activation prefix");
    check(equal(snapshot.disputeWriters, expectedDisputes), "Dispute writers differ from the confirmed activation prefix");
    return;
  }
  check(equal(snapshot.paymentMethods.map(({ method, currencies }) => ({ method, currencies })), c.paymentMethods), "Payment catalog or currency order changed");
  for (const method of snapshot.paymentMethods) check(same(method.verifier, a("UnifiedPaymentVerifierV3")) || (freshVerifier && same(method.verifier, freshVerifier)), `Unrecognized payment verifier for ${method.method}`);
  const expectedNullifiers = [a("UnifiedPaymentVerifierV3"), ...(freshVerifier ? [freshVerifier] : [])];
  check(snapshot.nullifierWriters.length > 0 && snapshot.nullifierWriters.every((w) => expectedNullifiers.some((x) => same(w, x))), "Unexpected payment nullifier writer");
  if (!freshVerifier) check(equal(snapshot.nullifierWriters, expectedNullifiers), "Predecessor payment nullifier writer missing");
  check(c.retainedDisputeWriters.every((w) => snapshot.disputeWriters.some((x) => same(w, x))) && snapshot.disputeWriters.every((w) => c.retainedDisputeWriters.some((x) => same(w, x)) || (freshPolicy && same(w, freshPolicy))), "Dispute writer set changed");
}

/** Write the signed transaction before sending. An interrupted run only rebroadcasts these exact bytes. */
export class TransactionJournal<M extends Pick<Manifest, "transactions"> & { configuration: Pick<ReleaseConfig, "chainId"> } = Manifest> {
  constructor(readonly path: string, readonly manifest: M, readonly wallet: Wallet) {}
  save(): void { atomicJson(this.path, this.manifest); }
  async execute(step: string, request: providers.TransactionRequest): Promise<Transaction> {
    let transaction = this.manifest.transactions.find((tx) => tx.step === step);
    const to = request.to ? utils.getAddress(String(request.to)) : null, data = String(request.data), value = BigNumber.from(request.value || 0).toString();
    const requestToSign = { ...(to === null ? {} : { to }), data, value };
    if (transaction) check(equal([transaction.to, transaction.data, transaction.value], [to, data, value]), `Resumed transaction differs: ${step}`);
    else {
      const provider = this.wallet.provider;
      const nonce = await provider.getTransactionCount(this.wallet.address, "latest");
      check(nonce === await provider.getTransactionCount(this.wallet.address, "pending"), "Signer has an unrelated pending transaction");
      const gas = await provider.estimateGas({ ...requestToSign, from: this.wallet.address });
      const unsigned = await this.wallet.populateTransaction({ ...requestToSign, nonce, gasLimit: gas.mul(12).div(10), chainId: this.manifest.configuration.chainId });
      const raw = await this.wallet.signTransaction(unsigned);
      transaction = { step, hash: utils.keccak256(raw), nonce, to, data, value, receipt: null };
      atomicJson(`${this.path}.pending`, { hash: transaction.hash, raw });
      this.manifest.transactions.push(transaction);
      this.save();
    }
    if (!transaction.receipt) {
      let receipt = await this.wallet.provider.getTransactionReceipt(transaction.hash);
      if (!receipt) {
        check(existsSync(`${this.path}.pending`), `Missing signed journal for ${transaction.hash}; recover its receipt before continuing`);
        const pending = JSON.parse(readFileSync(`${this.path}.pending`, "utf8")) as { hash: string; raw: string };
        check(pending.hash === transaction.hash && utils.keccak256(pending.raw) === transaction.hash, "Pending transaction journal hash mismatch");
        const onchain = await this.wallet.provider.getTransaction(transaction.hash);
        if (!onchain) {
          check(await this.wallet.provider.getTransactionCount(this.wallet.address, "latest") === transaction.nonce, `Nonce consumed without expected receipt: ${transaction.hash}`);
          await this.wallet.provider.sendTransaction(pending.raw);
        }
        receipt = await this.wallet.provider.waitForTransaction(transaction.hash, 1, 180_000);
      }
      check(receipt && receipt.status === 1, `Transaction unconfirmed or reverted: ${transaction.hash}`);
      transaction.receipt = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, transactionHash: receipt.transactionHash, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString() };
      this.save();
      if (existsSync(`${this.path}.pending`)) unlinkSync(`${this.path}.pending`);
    }
    const confirmed = await this.wallet.provider.getTransactionReceipt(transaction.hash);
    check(confirmed && confirmed.status === 1 && confirmed.blockHash === transaction.receipt.blockHash, `Recorded transaction is no longer canonical: ${transaction.hash}`);
    return transaction;
  }
}

async function assertRuntime(hre: HardhatRuntimeEnvironment, address: string, artifactName: string): Promise<string> {
  const artifact = await hre.deployments.getExtendedArtifact(artifactName);
  const code = await hre.ethers.provider.getCode(address);
  const references = artifact.evm?.deployedBytecode?.immutableReferences || {};
  check(typeof artifact.deployedBytecode === "string", `${artifactName} compiler runtime is unavailable`);
  check(code !== "0x" && zeroImmutableValues(code, references) === zeroImmutableValues(artifact.deployedBytecode, references), `${artifactName} deployed bytecode does not match compiler output`);
  return utils.keccak256(code);
}

export async function deploySuite(hre: HardhatRuntimeEnvironment, journal: TransactionJournal): Promise<void> {
  const m = journal.manifest, c = m.configuration;
  check(same(journal.wallet.address, c.signer), "Signer differs from configured migrated deployer");
  assertBaseline(c, await inspect(hre, c), m);
  const a = (name: string): string => c.existing[name].address;
  const fresh = (name: NewName): string => { const record = m.contracts[name]; check(record, `${name} has not been deployed`); return record.address; };
  async function deploy(name: NewName, args: unknown[]): Promise<void> {
    const artifactName = NEW_CONTRACTS[name], artifact = await hre.artifacts.readArtifact(artifactName);
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, journal.wallet);
    const tx = await journal.execute(`deploy:${name}`, factory.getDeployTransaction(...args));
    check(tx.receipt, `${name} receipt missing`);
    const address = utils.getContractAddress({ from: c.signer, nonce: tx.nonce });
    const runtimeCodeHash = await assertRuntime(hre, address, artifactName);
    m.contracts[name] = { address, artifact: artifactName, constructorArguments: args, transactionHash: tx.hash, deploymentBlock: tx.receipt.blockNumber, runtimeCodeHash };
    journal.save();
    // Keep standard Hardhat records for verification and package extraction. Historical records remain separate.
    await hre.deployments.save(name, { ...await hre.deployments.getExtendedArtifact(artifactName), address, args, transactionHash: tx.hash, receipt: await hre.ethers.provider.getTransactionReceipt(tx.hash) });
  }
  async function call(name: NewName, method: string, args: unknown[]): Promise<void> {
    const contract = new Contract(fresh(name), (await hre.artifacts.readArtifact(NEW_CONTRACTS[name])).abi);
    await journal.execute(`${name}:${method}`, { to: contract.address, data: contract.interface.encodeFunctionData(method, args) });
  }
  await deploy("StakeVaultV2", [c.signer, c.stakeToken]);
  await deploy("AddressGroupRegistryV4", []);
  await deploy("WhitelistPolicyV2", [fresh("AddressGroupRegistryV4")]);
  await deploy("DisputeProtectionPolicyV2", [c.signer, fresh("StakeVaultV2"), a("DisputeVerifier"), a("DisputeNullifierRegistry"), a("OrchestratorRegistry")]);
  await call("StakeVaultV2", "setController", [fresh("DisputeProtectionPolicyV2"), true]);
  await deploy("UnifiedPaymentVerifierV4", [a("OrchestratorRegistry"), a("NullifierRegistryV2"), a("MultiAttestationVerifier")]);
  const upv = new Contract(fresh("UnifiedPaymentVerifierV4"), (await hre.artifacts.readArtifact("UnifiedPaymentVerifierV4")).abi);
  for (const { method } of c.paymentMethods) await journal.execute(`verifier-method:${method}`, { to: upv.address, data: upv.interface.encodeFunctionData("addPaymentMethod", [method]) });
  await deploy("OrchestratorV4", [c.signer, c.chainId, a("EscrowRegistry"), a("PaymentVerifierRegistry"), a("RelayerRegistry"), c.protocolFee, c.protocolFeeRecipient, fresh("WhitelistPolicyV2")]);
  await call("OrchestratorV4", "setSettlementPolicy", [fresh("DisputeProtectionPolicyV2")]);
  if (c.allowMultipleIntents) await call("OrchestratorV4", "setAllowMultipleIntents", [true]);
  await deploy("ProtocolViewerV4", []);
  if (!same(c.signer, c.governance)) for (const name of ["StakeVaultV2", "DisputeProtectionPolicyV2", "UnifiedPaymentVerifierV4", "OrchestratorV4"] as const) await call(name, "transferOwnership", [c.governance]);
  await verifySuite(hre, journal, false);
}

export async function activationTransactions(hre: HardhatRuntimeEnvironment, m: Manifest) {
  const c = m.configuration, transactions: Array<{ step: string; to: string; data: string; value: string }> = [];
  const fresh = (name: NewName): string => { const record = m.contracts[name]; check(record, `${name} has not been deployed`); return record.address; };
  async function append(step: string, address: string, artifact: string, method: string, args: unknown[]) {
    const iface = new utils.Interface((await hre.artifacts.readArtifact(artifact)).abi);
    transactions.push({ step, to: address, data: iface.encodeFunctionData(method, args), value: "0" });
  }
  if (!same(c.signer, c.governance)) for (const name of ["StakeVaultV2", "DisputeProtectionPolicyV2"] as const) await append(`accept:${name}`, fresh(name), name, "acceptOwnership", []);
  await append("authorize-policy-writer", c.existing.DisputeNullifierRegistry.address, "NullifierRegistry", "addWritePermission", [fresh("DisputeProtectionPolicyV2")]);
  await append("authorize-payment-writer", c.existing.NullifierRegistryV2.address, "NullifierRegistryV2", "addWritePermission", [fresh("UnifiedPaymentVerifierV4")]);
  // Remove backwards before rebuilding: forward remove/add changes this swap-and-pop registry's order.
  for (const { method } of [...c.paymentMethods].reverse()) {
    await append(`remove-route:${method}`, c.existing.PaymentVerifierRegistry.address, "PaymentVerifierRegistry", "removePaymentMethod", [method]);
  }
  for (const { method, currencies } of c.paymentMethods) {
    await append(`add-route:${method}`, c.existing.PaymentVerifierRegistry.address, "PaymentVerifierRegistry", "addPaymentMethod", [method, fresh("UnifiedPaymentVerifierV4"), currencies]);
  }
  await append("retire-payment-writer", c.existing.NullifierRegistryV2.address, "NullifierRegistryV2", "removeWritePermission", [c.existing.UnifiedPaymentVerifierV3.address]);
  await append("register-orchestrator", c.existing.OrchestratorRegistry.address, "OrchestratorRegistry", "addOrchestrator", [fresh("OrchestratorV4")]);
  return transactions;
}

export async function activate(hre: HardhatRuntimeEnvironment, journal: TransactionJournal): Promise<void> {
  const c = journal.manifest.configuration;
  check(c.environment === "base_staging" && same(journal.wallet.address, c.governance), "Direct activation is staging-only; production uses its Safe batch");
  await assertDrainEvidence(hre, c, journal.manifest.activationDrainEvidence);
  const transactions = await activationTransactions(hre, journal.manifest);
  const started = transactions.some((tx) => journal.manifest.transactions.some((entry) => entry.step === tx.step));
  if (!started) await verifySuite(hre, journal, false);
  const completed: string[] = [];
  for (const tx of transactions) {
    const recorded = journal.manifest.transactions.find((entry) => entry.step === tx.step);
    if (!recorded) break;
    // Reconcile receipts only. A signed-but-unsent transaction must wait for the prefix preflight below.
    if (!await hre.ethers.provider.getTransactionReceipt(recorded.hash)) break;
    await journal.execute(tx.step, tx);
    completed.push(tx.step);
  }
  check(!transactions.slice(completed.length + 1).some((tx) => journal.manifest.transactions.some((entry) => entry.step === tx.step)), "Activation journal is not a contiguous prefix");
  const assertActivationState = async (): Promise<void> => {
    const snapshot = await inspect(hre, c);
    assertLegacyDrained(c, snapshot);
    assertBaseline(c, snapshot, journal.manifest, completed);
    const o4 = journal.manifest.contracts.OrchestratorV4; check(o4, "O4 is missing");
    const registered = await (await existing(hre, c, "OrchestratorRegistry")).isOrchestrator(o4.address);
    check(registered === completed.includes("register-orchestrator"), "O4 registration differs from the confirmed activation prefix");
  };
  await assertActivationState();
  // No writes to the old orchestrator, escrow, deposits, relayer registry or old dispute policies.
  for (const tx of transactions.slice(completed.length)) {
    await journal.execute(tx.step, tx);
    completed.push(tx.step);
    await assertActivationState();
  }
  await verifySuite(hre, journal, true);
}

export async function assertDrainEvidence(hre: HardhatRuntimeEnvironment, c: ReleaseConfig, value: unknown): Promise<void> {
  check(typeof value === "object" && value !== null, "Post-pause indexer drain evidence is required before activation");
  const evidence = value as DrainEvidence;
  check(Number.isSafeInteger(evidence.pausedAtBlock) && evidence.pausedAtBlock > 0, "Invalid pause observation block");
  check(typeof evidence.query === "string" && evidence.query.replace(/\s/g, "") === DRAIN_QUERY.replace(/\s/g, ""), "Drain query must enumerate all signaled intents");
  const data = evidence.response?.data;
  check(data && Array.isArray(data.Intent) && data.Intent.length < 1000 && Array.isArray(data.chain_metadata) && data.chain_metadata.length === 1, "Drain response is incomplete or paginated");
  const indexedBlock = data.chain_metadata[0].latest_processed_block;
  check(Number.isSafeInteger(indexedBlock) && indexedBlock >= evidence.pausedAtBlock, "Indexer drain evidence predates the pause observation");
  for (const intent of data.Intent) {
    check(utils.isAddress(intent.orchestratorAddress) && /^0x[\da-f]{64}$/i.test(intent.intentHash) && intent.status === "SIGNALED", "Malformed drain intent row");
    check(!c.legacyDrainCheckpoints.some((checkpoint) => same(c.existing[checkpoint.contract].address, intent.orchestratorAddress)), "Retired orchestrator still has a signaled intent");
  }
  const snapshot = await inspect(hre, c); assertLegacyDrained(c, snapshot);
  check(indexedBlock <= snapshot.blockNumber, "Indexer drain height is ahead of the selected chain");
  for (const checkpoint of c.legacyDrainCheckpoints) {
    const legacy = await existing(hre, c, checkpoint.contract);
    const at = { blockTag: evidence.pausedAtBlock };
    check(await legacy.paused(at), `${checkpoint.contract} was not paused at the drain observation block`);
    check((await legacy.intentCounter(at)).toString() === checkpoint.intentCounter, `${checkpoint.contract} counter differs at the pause observation`);
    const unpauses = await hre.ethers.provider.getLogs({ address: legacy.address, fromBlock: evidence.pausedAtBlock, toBlock: snapshot.blockNumber, topics: [utils.id("Unpaused(address)")] });
    check(unpauses.length === 0, `${checkpoint.contract} was unpaused after the drain observation; recheck the indexed drain`);
  }
}

export async function recordDrainEvidence(hre: HardhatRuntimeEnvironment, journal: TransactionJournal, evidence: unknown): Promise<void> {
  await assertDrainEvidence(hre, journal.manifest.configuration, evidence);
  journal.manifest.activationDrainEvidence = evidence as DrainEvidence; journal.save();
}

function assertLegacyDrained(c: ReleaseConfig, snapshot: Awaited<ReturnType<typeof inspect>>): void {
  for (const checkpoint of c.legacyDrainCheckpoints) {
    const legacy = snapshot.legacyOrchestrators.find((record) => record.contract === checkpoint.contract);
    check(legacy && legacy.paused, `${checkpoint.contract} must be paused before the shared verifier cutover`);
    check(legacy.intentCounter === checkpoint.intentCounter, `${checkpoint.contract} intent counter changed after its zero-open-intent checkpoint; drain and review again`);
  }
}

export async function verifySuite(hre: HardhatRuntimeEnvironment, journal: TransactionJournal, active: boolean): Promise<void> {
  const m = journal.manifest, c = m.configuration;
  const snapshot = await inspect(hre, c);
  assertBaseline(c, snapshot, m);
  const contracts = {} as Record<NewName, Contract>;
  for (const name of Object.keys(NEW_CONTRACTS) as NewName[]) {
    const record = m.contracts[name]; check(record, `Missing deployed ${name}`);
    check(same(await assertRuntime(hre, record.address, record.artifact), record.runtimeCodeHash), `${name} runtime changed`);
    const tx = await hre.ethers.provider.getTransaction(record.transactionHash);
    const artifact = await hre.artifacts.readArtifact(record.artifact);
    check(tx && same(tx.from, c.signer) && tx.to === null && tx.data === new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...record.constructorArguments).data, `${name} constructor transaction differs`);
    contracts[name] = new Contract(record.address, artifact.abi, hre.ethers.provider);
  }
  const o = contracts.OrchestratorV4, v = contracts.UnifiedPaymentVerifierV4, p = contracts.DisputeProtectionPolicyV2, vault = contracts.StakeVaultV2;
  const expectedFields: Array<[Contract, string, string]> = [
    [o, "whitelistPolicy", contracts.WhitelistPolicyV2.address], [o, "settlementPolicy", p.address],
    [o, "escrowRegistry", c.existing.EscrowRegistry.address], [o, "paymentVerifierRegistry", c.existing.PaymentVerifierRegistry.address], [o, "relayerRegistry", c.existing.RelayerRegistry.address],
    [o, "protocolFeeRecipient", c.protocolFeeRecipient], [vault, "stakeToken", c.stakeToken], [p, "stakeVault", vault.address],
    [p, "disputeVerifier", c.existing.DisputeVerifier.address], [p, "disputeNullifierRegistry", c.existing.DisputeNullifierRegistry.address], [p, "orchestratorRegistry", c.existing.OrchestratorRegistry.address],
    [v, "orchestratorRegistry", c.existing.OrchestratorRegistry.address], [v, "nullifierRegistry", c.existing.NullifierRegistryV2.address], [v, "attestationVerifier", c.existing.MultiAttestationVerifier.address],
    [contracts.WhitelistPolicyV2, "groupRegistry", contracts.AddressGroupRegistryV4.address],
  ];
  for (const [contract, field, expected] of expectedFields) check(same(await contract[field](), expected), `${contract.address} ${field} mismatch`);
  check((await o.chainId()).eq(c.chainId) && (await o.protocolFee()).eq(c.protocolFee) && await o.allowMultipleIntents() === c.allowMultipleIntents && !await o.paused(), "O4 fee, chain, intent or pause mismatch");
  check(await vault.isController(p.address), "Policy is not the vault controller");
  check(equal(await v.getPaymentMethods(), c.paymentMethods.map((method) => method.method)), "UPV4 method catalog mismatch");
  for (const contract of [o, v, vault, p]) {
    const twoStep = same(contract.address, vault.address) || same(contract.address, p.address);
    const pending = !active && twoStep && !same(c.signer, c.governance);
    check(same(await contract.owner(), pending ? c.signer : c.governance), `${contract.address} owner mismatch`);
    if (twoStep) check(same(await contract.pendingOwner(), pending ? c.governance : ZERO), `${contract.address} pending owner mismatch`);
  }
  const registered = await (await existing(hre, c, "OrchestratorRegistry")).isOrchestrator(o.address);
  check(registered === active, "O4 registration does not match release phase");
  if (active) {
    assertLegacyDrained(c, snapshot);
    check(snapshot.paymentMethods.every((method) => same(method.verifier, v.address)), "Not all payment routes select UPV4");
    check(equal(snapshot.nullifierWriters, [v.address]), "UPV4 must be the only payment nullifier writer");
    check(equal(snapshot.disputeWriters, [...c.retainedDisputeWriters, p.address]), "Policy writer missing or predecessor writer changed");
  }
  m.verification = { ...m.verification, verifiedAtBlock: snapshot.blockNumber, active, bytecode: true, constructors: true, wiring: true, governance: true, paymentCatalog: true, escrowCompatible: true, predecessorPreserved: true };
  journal.save();
}

async function main(): Promise<void> {
  const [environment, action, evidencePath] = process.argv.slice(2);
  check(["base_staging", "base"].includes(environment) && ["inspect", "deploy", "activate", "prepare-governance", "verify", "verify-source", "record-drain"].includes(action), "Usage: deploy-orchestrator-v4.ts base_staging|base inspect|deploy|activate|prepare-governance|verify|verify-source|record-drain [EVIDENCE_JSON]");
  process.env.HARDHAT_NETWORK = environment;
  const hre = require("hardhat") as HardhatRuntimeEnvironment;
  const configPath = resolve(`deployments/orchestrator-v4/${environment}.json`);
  const c: unknown = JSON.parse(readFileSync(configPath, "utf8")); validateConfig(c);
  check(c.environment === environment && c.chainId === 8453, "Live deployment requires the selected environment on Base 8453");
  const manifestPath = resolve(`deployments/outputs/orchestrator-v4-${environment}.json`);
  if (action === "inspect") { const snapshot = await inspect(hre, c); atomicJson(`${manifestPath}.preflight`, snapshot); console.log(JSON.stringify(snapshot, null, 2)); return; }
  const keyName = environment === "base_staging" ? "STAGING_DEPLOYER_KEY" : "O4_PRODUCTION_DEPLOYER_KEY";
  const key = process.env[keyName]; check(key, `${keyName} is unavailable; no fallback signer is permitted`);
  const wallet = new Wallet(key.startsWith("0x") ? key : `0x${key}`, hre.ethers.provider);
  check(same(wallet.address, c.signer), "Derived signer differs from the verified configuration");
  const protectedPaths = ["contracts", "hardhat.config.ts", "scripts/deploy-orchestrator-v4.ts", "scripts/verify-orchestrator-v4-source.ts", "deployments/canonicalDeployment.ts", configPath];
  for (const path of ["scripts/deploy-orchestrator-v4.ts", "scripts/verify-orchestrator-v4-source.ts", `deployments/orchestrator-v4/${environment}.json`])
    execFileSync("git", ["cat-file", "-e", `HEAD:${path}`], { stdio: "pipe" });
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ...protectedPaths], { stdio: "pipe" });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await hre.run("compile", { quiet: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  const lockPath = `${manifestPath}.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  try {
    let manifest: Manifest;
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      check(manifest.version === 1 && manifest.configurationHash === hash(c), "Manifest configuration differs; do not overwrite or start a duplicate release");
      execFileSync("git", ["diff", "--exit-code", manifest.sourceCommit, "HEAD", "--", ...protectedPaths], { stdio: "pipe" });
    } else {
      check(action === "deploy", "No deployment manifest exists; run deploy first");
      const baseline = await inspect(hre, c); assertBaseline(c, baseline);
      check(baseline.signer.nonce === baseline.signer.pendingNonce, "Signer has pending transactions");
      manifest = { version: 1, sourceCommit, configurationHash: hash(c), configuration: c, baseline, transactions: [], activationDrainEvidence: null, contracts: {}, verification: {}, governanceTransactions: [] };
    }
    const journal = new TransactionJournal(manifestPath, manifest, wallet);
    if (action === "deploy") await deploySuite(hre, journal);
    if (action === "record-drain") {
      check(evidencePath, "record-drain requires the post-pause indexer evidence JSON");
      await recordDrainEvidence(hre, journal, JSON.parse(readFileSync(evidencePath, "utf8")));
    }
    if (action === "activate") await activate(hre, journal);
    if (action === "prepare-governance") {
      check(environment === "base", "Governance batch is only for Base production");
      await verifySuite(hre, journal, false);
      await assertDrainEvidence(hre, c, manifest.activationDrainEvidence);
      manifest.governanceTransactions = await activationTransactions(hre, manifest); journal.save();
      console.log("Unsigned Safe calls recorded; no governance transaction submitted.");
    }
    if (action === "verify") await verifySuite(hre, journal, true);
    if (action === "verify-source") {
      const apiKey = process.env.ETHERSCAN_API_KEY; check(apiKey, "ETHERSCAN_API_KEY is unavailable");
      await verifySuite(hre, journal, manifest.verification.active === true);
      manifest.verification.sources = await verifySources(hre, manifest, apiKey); journal.save();
    }
    console.log(JSON.stringify({ manifest: manifestPath, sourceCommit: manifest.sourceCommit, contracts: manifest.contracts, verification: manifest.verification }, null, 2));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

if (require.main === module) main().catch((error: unknown) => {
  // RPC errors may contain authenticated URLs or environment details; only our credential-free boundary errors are printed.
  console.error(error instanceof ReleaseError || error instanceof SourceVerificationError ? error.message : "Release failed. Inspect the recorded transaction hashes and rerun inspect; no alternate signer will be used.");
  process.exitCode = 1;
});
