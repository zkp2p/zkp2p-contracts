import { createHash } from "crypto";

import {
  canonicalJson,
  type ContractIdentity,
} from "./activationBatchManifest";
import {
  canonicalTransactionHash,
  normalizeSafeTransactions,
} from "./safeBatchManifest";
import type { NormalizedSafeBatchTransaction } from "./safeBatchManifest";
import type {
  VaultActivationBatchKind,
  VaultActivationSnapshot,
  VaultTrustSurfaceInput,
} from "./vaultMethodScopedActivation";

export { canonicalJson } from "./activationBatchManifest";
export type { ContractIdentity } from "./activationBatchManifest";

export type VaultActivationBatchManifest = {
  version: 3;
  kind: VaultActivationBatchKind;
  chainId: 8453;
  safe: string;
  safeNonce: string;
  sourceSha: string;
  proofBlock: { number: number; hash: string };
  simulationBlockNumber: number;
  simulationBlockHash: string;
  simulationResult: "success";
  transactions: NormalizedSafeBatchTransaction[];
  transactionsSha256: string;
  guard: ContractIdentity;
  postcondition: ContractIdentity;
  trustSurface: VaultTrustSurfaceInput;
  proofSnapshot: VaultActivationSnapshot;
  manifestSha256: string;
};

export function computeVaultManifestSha256(
  manifest: Omit<VaultActivationBatchManifest, "manifestSha256">
): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function assertKeys(
  value: unknown,
  keys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    throw new Error(`Invalid ${label} keys`);
}

function assertString(
  value: unknown,
  pattern: RegExp,
  label: string
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error(`Invalid ${label}`);
}

function assertAddress(value: unknown, label: string): asserts value is string {
  assertString(value, /^0x[0-9a-f]{40}$/, label);
}

function assertHash(value: unknown, label: string): asserts value is string {
  assertString(value, /^0x[0-9a-f]{64}$/, label);
}

function assertDecimal(value: unknown, label: string): asserts value is string {
  assertString(value, /^(0|[1-9][0-9]*)$/, label);
}

function assertSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
}

function assertAddresses(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  value.forEach((item, index) => assertAddress(item, `${label}[${index}]`));
}

function assertHashes(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  value.forEach((item, index) => assertHash(item, `${label}[${index}]`));
}

function assertIdentity(value: unknown, label: string): void {
  assertKeys(
    value,
    [
      "address",
      "artifactName",
      "constructorArgs",
      "deployTransactionHash",
      "runtimeCodeHash",
    ],
    label
  );
  assertAddress(value.address, `${label}.address`);
  assertString(
    value.artifactName,
    /^[A-Za-z][A-Za-z0-9]*$/,
    `${label}.artifactName`
  );
  if (!Array.isArray(value.constructorArgs))
    throw new Error(`Invalid ${label}.constructorArgs`);
  canonicalJson(value.constructorArgs);
  assertHash(value.deployTransactionHash, `${label}.deployTransactionHash`);
  assertHash(value.runtimeCodeHash, `${label}.runtimeCodeHash`);
}

function assertTransactions(
  value: unknown
): asserts value is NormalizedSafeBatchTransaction[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Invalid transactions");
  value.forEach((transaction, index) => {
    assertKeys(
      transaction,
      ["to", "value", "data", "operation"],
      `transactions[${index}]`
    );
    assertAddress(transaction.to, `transactions[${index}].to`);
    assertDecimal(transaction.value, `transactions[${index}].value`);
    assertString(
      transaction.data,
      /^0x(?:[0-9a-f]{2})*$/,
      `transactions[${index}].data`
    );
    if (transaction.operation !== 0 && transaction.operation !== 1)
      throw new Error("Invalid transaction operation");
  });
}

function assertTrustSurface(value: unknown): void {
  const keys = [
    "safe",
    "disputeRegistry",
    "orchestrator",
    "orchestratorRegistry",
    "escrowRegistry",
    "paymentVerifierRegistry",
    "relayerRegistry",
    "protocolFeeRecipient",
    "allowMultipleIntents",
    "freshHook",
    "whitelistPolicy",
    "groupRegistry",
    "attestationVerifier",
    "witnesses",
    "disputeVerifier",
    "nullifierRegistryV2",
    "predecessorPolicy",
    "freshPolicy",
    "vaults",
    "predecessorHook",
    "paymentMethods",
    "riskWindows",
  ];
  assertKeys(value, keys, "trustSurface");
  keys
    .filter(
      (key) =>
        ![
          "allowMultipleIntents",
          "witnesses",
          "vaults",
          "paymentMethods",
          "riskWindows",
        ].includes(key)
    )
    .forEach((key) => assertAddress(value[key], `trustSurface.${key}`));
  assertKeys(
    value.vaults,
    ["freshVault", "predecessorVault"],
    "trustSurface.vaults"
  );
  assertAddress(value.vaults.freshVault, "trustSurface.vaults.freshVault");
  assertAddress(
    value.vaults.predecessorVault,
    "trustSurface.vaults.predecessorVault"
  );
  if (typeof value.allowMultipleIntents !== "boolean")
    throw new Error("Invalid trustSurface.allowMultipleIntents");
  assertAddresses(value.witnesses, "trustSurface.witnesses");
  assertHashes(value.paymentMethods, "trustSurface.paymentMethods");
  if (!Array.isArray(value.riskWindows))
    throw new Error("Invalid trustSurface.riskWindows");
  value.riskWindows.forEach((window, index) =>
    assertDecimal(window, `trustSurface.riskWindows[${index}]`)
  );
  if ((value.paymentMethods as unknown[]).length !== value.riskWindows.length)
    throw new Error("Invalid trustSurface method/window lengths");
}

function assertOwnership(value: Record<string, unknown>, label: string): void {
  assertAddress(value.owner, `${label}.owner`);
  assertAddress(value.pendingOwner, `${label}.pendingOwner`);
}

function assertSnapshot(value: unknown): void {
  assertKeys(
    value,
    [
      "network",
      "blockNumber",
      "blockHash",
      "blockTimestamp",
      "freshPolicy",
      "predecessorPolicy",
      "disputeVerifier",
      "freshVault",
      "predecessorVault",
      "registry",
      "orchestrator",
      "freshHook",
      "whitelistPolicy",
      "attestationVerifier",
      "lockProof",
      "inventory",
    ],
    "proofSnapshot"
  );
  if (value.network !== "base" && value.network !== "base_staging")
    throw new Error("Invalid proofSnapshot.network");
  assertSafeInteger(value.blockNumber, "proofSnapshot.blockNumber");
  assertHash(value.blockHash, "proofSnapshot.blockHash");
  assertDecimal(value.blockTimestamp, "proofSnapshot.blockTimestamp");

  const freshPolicy = value.freshPolicy;
  assertKeys(
    freshPolicy,
    [
      "owner",
      "pendingOwner",
      "admissionsPaused",
      "disputeVerifier",
      "disputeNullifierRegistry",
      "stakeVault",
      "authorizedHooks",
      "riskWindows",
    ],
    "proofSnapshot.freshPolicy"
  );
  assertOwnership(freshPolicy, "proofSnapshot.freshPolicy");
  ["disputeVerifier", "disputeNullifierRegistry", "stakeVault"].forEach((key) =>
    assertAddress(freshPolicy[key], `proofSnapshot.freshPolicy.${key}`)
  );
  if (typeof freshPolicy.admissionsPaused !== "boolean")
    throw new Error("Invalid fresh admissionsPaused");
  assertAddresses(
    freshPolicy.authorizedHooks,
    "proofSnapshot.freshPolicy.authorizedHooks"
  );
  canonicalJson(freshPolicy.riskWindows);

  const predecessorPolicy = value.predecessorPolicy;
  assertKeys(
    predecessorPolicy,
    [
      "owner",
      "pendingOwner",
      "admissionsPaused",
      "disputeVerifier",
      "disputeNullifierRegistry",
      "stakeVault",
    ],
    "proofSnapshot.predecessorPolicy"
  );
  assertOwnership(predecessorPolicy, "proofSnapshot.predecessorPolicy");
  ["disputeVerifier", "disputeNullifierRegistry", "stakeVault"].forEach((key) =>
    assertAddress(
      predecessorPolicy[key],
      `proofSnapshot.predecessorPolicy.${key}`
    )
  );
  if (typeof predecessorPolicy.admissionsPaused !== "boolean")
    throw new Error("Invalid predecessor admissionsPaused");

  assertKeys(
    value.disputeVerifier,
    ["owner", "pendingOwner", "attestationVerifier", "nullifierRegistry"],
    "proofSnapshot.disputeVerifier"
  );
  assertOwnership(value.disputeVerifier, "proofSnapshot.disputeVerifier");
  assertAddress(
    value.disputeVerifier.attestationVerifier,
    "proofSnapshot.disputeVerifier.attestationVerifier"
  );
  assertAddress(
    value.disputeVerifier.nullifierRegistry,
    "proofSnapshot.disputeVerifier.nullifierRegistry"
  );

  const freshVault = value.freshVault;
  assertKeys(
    freshVault,
    [
      "owner",
      "pendingOwner",
      "controller",
      "pendingController",
      "pendingControllerValidAt",
      "controllerChangeDelay",
      "stakeToken",
    ],
    "proofSnapshot.freshVault"
  );
  assertOwnership(freshVault, "proofSnapshot.freshVault");
  ["controller", "pendingController", "stakeToken"].forEach((key) =>
    assertAddress(freshVault[key], `proofSnapshot.freshVault.${key}`)
  );
  assertDecimal(
    freshVault.pendingControllerValidAt,
    "proofSnapshot.freshVault.pendingControllerValidAt"
  );
  assertDecimal(
    freshVault.controllerChangeDelay,
    "proofSnapshot.freshVault.controllerChangeDelay"
  );
  assertKeys(
    value.predecessorVault,
    ["pendingController"],
    "proofSnapshot.predecessorVault"
  );
  assertAddress(
    value.predecessorVault.pendingController,
    "proofSnapshot.predecessorVault.pendingController"
  );

  assertKeys(value.registry, ["owner", "writers"], "proofSnapshot.registry");
  assertAddress(value.registry.owner, "proofSnapshot.registry.owner");
  assertAddresses(value.registry.writers, "proofSnapshot.registry.writers");
  const orchestrator = value.orchestrator;
  assertKeys(
    orchestrator,
    [
      "owner",
      "paused",
      "lifecycleHook",
      "escrowRegistry",
      "paymentVerifierRegistry",
      "relayerRegistry",
      "protocolFee",
      "protocolFeeRecipient",
      "allowMultipleIntents",
      "registered",
    ],
    "proofSnapshot.orchestrator"
  );
  [
    "owner",
    "lifecycleHook",
    "escrowRegistry",
    "paymentVerifierRegistry",
    "relayerRegistry",
    "protocolFeeRecipient",
  ].forEach((key) =>
    assertAddress(orchestrator[key], `proofSnapshot.orchestrator.${key}`)
  );
  assertDecimal(
    orchestrator.protocolFee,
    "proofSnapshot.orchestrator.protocolFee"
  );
  ["paused", "allowMultipleIntents", "registered"].forEach((key) => {
    if (typeof orchestrator[key] !== "boolean")
      throw new Error(`Invalid proofSnapshot.orchestrator.${key}`);
  });
  const freshHook = value.freshHook;
  assertKeys(
    freshHook,
    ["orchestratorRegistry", "whitelistPolicy", "disputeProtectionPolicy"],
    "proofSnapshot.freshHook"
  );
  Object.keys(freshHook).forEach((key) =>
    assertAddress(freshHook[key], `proofSnapshot.freshHook.${key}`)
  );
  const whitelistPolicy = value.whitelistPolicy;
  assertKeys(
    whitelistPolicy,
    ["owner", "escrowRegistry", "groupRegistry", "orchestratorRegistry"],
    "proofSnapshot.whitelistPolicy"
  );
  Object.keys(whitelistPolicy).forEach((key) =>
    assertAddress(whitelistPolicy[key], `proofSnapshot.whitelistPolicy.${key}`)
  );
  assertKeys(
    value.attestationVerifier,
    ["owner", "requiredSignatures", "witnesses"],
    "proofSnapshot.attestationVerifier"
  );
  assertAddress(
    value.attestationVerifier.owner,
    "proofSnapshot.attestationVerifier.owner"
  );
  assertDecimal(
    value.attestationVerifier.requiredSignatures,
    "proofSnapshot.attestationVerifier.requiredSignatures"
  );
  assertAddresses(
    value.attestationVerifier.witnesses,
    "proofSnapshot.attestationVerifier.witnesses"
  );

  assertKeys(
    value.lockProof,
    [
      "fromBlock",
      "toBlock",
      "intents",
      "ok",
      "releasable",
      "blocking",
      "earliestMaturity",
    ],
    "proofSnapshot.lockProof"
  );
  assertSafeInteger(value.lockProof.fromBlock, "lockProof.fromBlock");
  assertSafeInteger(value.lockProof.toBlock, "lockProof.toBlock");
  if (!Array.isArray(value.lockProof.intents))
    throw new Error("Invalid lockProof.intents");
  value.lockProof.intents.forEach((intent, index) => {
    assertKeys(
      intent,
      ["intentHash", "status", "lockAmount", "maturesAt", "classification"],
      `lockProof.intents[${index}]`
    );
    assertHash(intent.intentHash, `lockProof.intents[${index}].intentHash`);
    assertSafeInteger(intent.status, `lockProof.intents[${index}].status`);
    if (![0, 1, 2, 3, 4, 5].includes(intent.status as number))
      throw new Error("Invalid intent status");
    assertDecimal(intent.lockAmount, `lockProof.intents[${index}].lockAmount`);
    assertDecimal(intent.maturesAt, `lockProof.intents[${index}].maturesAt`);
    assertString(
      intent.classification,
      /^(none|pending|settled-unmatured|settled-matured|terminal|terminal-locked)$/,
      `lockProof.intents[${index}].classification`
    );
  });
  if (typeof value.lockProof.ok !== "boolean")
    throw new Error("Invalid lockProof.ok");
  assertHashes(value.lockProof.releasable, "lockProof.releasable");
  assertHashes(value.lockProof.blocking, "lockProof.blocking");
  if (value.lockProof.earliestMaturity !== null)
    assertDecimal(
      value.lockProof.earliestMaturity,
      "lockProof.earliestMaturity"
    );

  const inventory = value.inventory;
  assertKeys(
    inventory,
    ["escrow", "depositCounter", "block", "tuples", "violations", "ok"],
    "proofSnapshot.inventory"
  );
  assertAddress(inventory.escrow, "inventory.escrow");
  assertDecimal(inventory.depositCounter, "inventory.depositCounter");
  assertSafeInteger(inventory.block, "inventory.block");
  ["tuples", "violations"].forEach((key) => {
    if (!Array.isArray(inventory[key]))
      throw new Error(`Invalid inventory.${key}`);
    (inventory[key] as unknown[]).forEach((tuple) => {
      assertKeys(
        tuple,
        ["escrow", "depositId", "paymentMethod", "sources"],
        `inventory.${key} tuple`
      );
      assertAddress(tuple.escrow, "tuple.escrow");
      assertDecimal(tuple.depositId, "tuple.depositId");
      assertHash(tuple.paymentMethod, "tuple.paymentMethod");
      if (
        !Array.isArray(tuple.sources) ||
        tuple.sources.some(
          (source) =>
            source !== "predecessor-opt-out" && source !== "token-mismatch"
        )
      )
        throw new Error("Invalid tuple.sources");
    });
  });
  if (typeof inventory.ok !== "boolean")
    throw new Error("Invalid inventory.ok");
}

export function validateVaultActivationBatchManifest(
  value: unknown,
  expected?: Partial<VaultActivationBatchManifest>
): asserts value is VaultActivationBatchManifest {
  try {
    assertKeys(
      value,
      [
        "version",
        "kind",
        "chainId",
        "safe",
        "safeNonce",
        "sourceSha",
        "proofBlock",
        "simulationBlockNumber",
        "simulationBlockHash",
        "simulationResult",
        "transactions",
        "transactionsSha256",
        "guard",
        "postcondition",
        "trustSurface",
        "proofSnapshot",
        "manifestSha256",
      ],
      "manifest"
    );
    if (
      value.version !== 3 ||
      (value.kind !== "vault-cutover" &&
        value.kind !== "vault-writer-removal") ||
      value.chainId !== 8453
    )
      throw new Error("Invalid envelope");
    assertAddress(value.safe, "safe");
    assertDecimal(value.safeNonce, "safeNonce");
    assertString(value.sourceSha, /^[0-9a-f]{40}$/, "sourceSha");
    assertKeys(value.proofBlock, ["number", "hash"], "proofBlock");
    assertSafeInteger(value.proofBlock.number, "proofBlock.number");
    assertHash(value.proofBlock.hash, "proofBlock.hash");
    assertSafeInteger(value.simulationBlockNumber, "simulationBlockNumber");
    assertHash(value.simulationBlockHash, "simulationBlockHash");
    if (value.simulationResult !== "success")
      throw new Error("Invalid simulationResult");
    assertTransactions(value.transactions);
    assertString(
      value.transactionsSha256,
      /^[0-9a-f]{64}$/,
      "transactionsSha256"
    );
    if (
      canonicalTransactionHash(value.transactions) !== value.transactionsSha256
    )
      throw new Error("Transaction digest mismatch");
    assertIdentity(value.guard, "guard");
    assertIdentity(value.postcondition, "postcondition");
    assertTrustSurface(value.trustSurface);
    assertSnapshot(value.proofSnapshot);
    assertString(value.manifestSha256, /^[0-9a-f]{64}$/, "manifestSha256");
    const { manifestSha256, ...unsigned } =
      value as unknown as VaultActivationBatchManifest;
    if (computeVaultManifestSha256(unsigned) !== manifestSha256)
      throw new Error("Manifest digest mismatch");
    if (expected)
      Object.entries(expected).forEach(([key, wanted]) => {
        if (
          canonicalJson((value as Record<string, unknown>)[key]) !==
          canonicalJson(wanted)
        )
          throw new Error(`Expected ${key} mismatch`);
      });
  } catch {
    throw new Error("Invalid vault activation Safe batch manifest");
  }
}

const SAFE_BATCH_DIR = "deployments/outputs/safe-batches";
const BASE_SAFE = "0x0bC26FF515411396DD588Abd6Ef6846E04470227";

export const VAULT_ACTIVATION_BATCH_PATHS: Record<
  VaultActivationBatchKind,
  {
    batch: string;
    sidecar: string;
    supersededDir: string;
    meta: { name: string; description: string };
  }
> = {
  "vault-cutover": {
    batch: `${SAFE_BATCH_DIR}/base_method_scoped_vault_cutover.json`,
    sidecar: `${SAFE_BATCH_DIR}/base_method_scoped_vault_cutover.sha256.json`,
    supersededDir: `${SAFE_BATCH_DIR}/superseded`,
    meta: {
      name: "ZKP2P method-scoped dedicated-vault cutover - base",
      description:
        "assertReady(); conditionally accept fresh vault and policy ownership; add fresh writer; set fresh lifecycle hook",
    },
  },
  "vault-writer-removal": {
    batch: `${SAFE_BATCH_DIR}/base_method_scoped_vault_writer_removal.json`,
    sidecar: `${SAFE_BATCH_DIR}/base_method_scoped_vault_writer_removal.sha256.json`,
    supersededDir: `${SAFE_BATCH_DIR}/superseded`,
    meta: {
      name: "ZKP2P method-scoped dedicated-vault predecessor writer removal - base",
      description:
        "assertReady(); remove predecessor dispute-registry writer after terminal unlocked intent proof",
    },
  },
};

export function vaultSafeBatchJson(
  kind: VaultActivationBatchKind,
  transactions: NormalizedSafeBatchTransaction[],
  createdAtMs: number
): object {
  if (!Number.isSafeInteger(createdAtMs))
    throw new Error("Invalid Safe batch creation time");
  return {
    version: "1.0",
    chainId: "8453",
    createdAt: createdAtMs,
    meta: {
      ...VAULT_ACTIVATION_BATCH_PATHS[kind].meta,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: BASE_SAFE,
      createdFromOwnerAddress: "",
    },
    transactions: normalizeSafeTransactions(transactions).map(
      (transaction) => ({
        ...transaction,
        contractMethod: null,
        contractInputsValues: null,
      })
    ),
  };
}

export function assertBatchMatchesVaultActivationManifest(
  batch: unknown,
  manifest: VaultActivationBatchManifest
): void {
  try {
    assertKeys(
      batch,
      ["version", "chainId", "createdAt", "meta", "transactions"],
      "Safe batch"
    );
    if (batch.version !== "1.0" || batch.chainId !== "8453")
      throw new Error("Invalid Safe batch envelope");
    assertSafeInteger(batch.createdAt, "Safe batch createdAt");
    assertKeys(
      batch.meta,
      [
        "name",
        "description",
        "txBuilderVersion",
        "createdFromSafeAddress",
        "createdFromOwnerAddress",
      ],
      "Safe batch meta"
    );
    const meta = VAULT_ACTIVATION_BATCH_PATHS[manifest.kind].meta;
    if (
      batch.meta.name !== meta.name ||
      batch.meta.description !== meta.description ||
      batch.meta.txBuilderVersion !== "1.16.5" ||
      batch.meta.createdFromSafeAddress !== BASE_SAFE ||
      batch.meta.createdFromOwnerAddress !== ""
    )
      throw new Error("Invalid Safe batch metadata");
    if (!Array.isArray(batch.transactions))
      throw new Error("Invalid Safe batch transactions");
    const normalized = normalizeSafeTransactions(
      batch.transactions as NormalizedSafeBatchTransaction[]
    );
    if (
      canonicalTransactionHash(normalized) !== manifest.transactionsSha256 ||
      canonicalJson(normalized) !== canonicalJson(manifest.transactions)
    )
      throw new Error("Safe batch transaction mismatch");
  } catch {
    throw new Error("Safe batch does not match vault activation manifest");
  }
}
