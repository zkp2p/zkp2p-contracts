import { createHash } from "crypto";

import type {
  ActivationSnapshot,
  TrustSurfaceInput,
} from "./methodScopedActivation";
import {
  canonicalTransactionHash,
  normalizeSafeTransactions,
} from "./safeBatchManifest";
import type { NormalizedSafeBatchTransaction } from "./safeBatchManifest";

export type ActivationBatchKind = "rotation" | "cutover";
export type ContractIdentity = {
  address: string;
  artifactName: string;
  constructorArgs: unknown[];
  deployTransactionHash: string;
  runtimeCodeHash: string;
};
export type ActivationBatchManifest = {
  version: 2;
  kind: ActivationBatchKind;
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
  trustSurface: TrustSurfaceInput;
  proofSnapshot: ActivationSnapshot;
  manifestSha256: string;
};

function serializeCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical JSON numbers must be safe integers");
    }
    return String(value);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, serializeCanonical).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  if ("_hex" in record || "_isBigNumber" in record) {
    throw new Error("BigNumber-like values are not canonical JSON");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Canonical JSON requires plain objects");
  }
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new Error("Canonical JSON does not support symbol keys");
  }
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`)
    .join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

export function computeManifestSha256(
  manifest: Omit<ActivationBatchManifest, "manifestSha256">
): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function assertKeys(
  value: unknown,
  keys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Invalid ${label} keys`);
  }
}

function assertString(
  value: unknown,
  pattern: RegExp,
  label: string
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
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

function assertStringArray(
  value: unknown,
  validator: (item: unknown, label: string) => void,
  label: string
): void {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  value.forEach((item, index) => validator(item, `${label}[${index}]`));
}

function assertContractIdentity(value: unknown, label: string): void {
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
  for (const [index, transaction] of value.entries()) {
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
    assertSafeInteger(
      transaction.operation,
      `transactions[${index}].operation`
    );
    if (transaction.operation !== 0 && transaction.operation !== 1)
      throw new Error("Invalid transaction operation");
  }
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
    "freshHook",
    "whitelistPolicy",
    "groupRegistry",
    "attestationVerifier",
    "witnesses",
    "disputeVerifier",
    "nullifierRegistryV2",
    "predecessorPolicy",
    "freshPolicy",
    "vault",
    "predecessorHook",
    "paymentMethods",
    "riskWindows",
  ];
  assertKeys(value, keys, "trustSurface");
  for (const key of keys.filter(
    (key) => !["witnesses", "paymentMethods", "riskWindows"].includes(key)
  )) {
    assertAddress(value[key], `trustSurface.${key}`);
  }
  assertStringArray(value.witnesses, assertAddress, "trustSurface.witnesses");
  assertStringArray(
    value.paymentMethods,
    assertHash,
    "trustSurface.paymentMethods"
  );
  assertStringArray(
    value.riskWindows,
    assertDecimal,
    "trustSurface.riskWindows"
  );
  if (
    (value.paymentMethods as unknown[]).length !==
    (value.riskWindows as unknown[]).length
  ) {
    throw new Error("Invalid trustSurface method/window lengths");
  }
}

function assertOwnership(value: Record<string, unknown>, label: string): void {
  assertAddress(value.owner, `${label}.owner`);
  assertAddress(value.pendingOwner, `${label}.pendingOwner`);
}

function assertRiskWindows(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  for (const [method, window] of Object.entries(value)) {
    assertHash(method, `${label} key`);
    assertDecimal(window, `${label}.${method}`);
  }
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
      "vault",
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

  assertKeys(
    value.freshPolicy,
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
  assertOwnership(value.freshPolicy, "proofSnapshot.freshPolicy");
  if (typeof value.freshPolicy.admissionsPaused !== "boolean")
    throw new Error("Invalid admissionsPaused");
  assertAddress(
    value.freshPolicy.disputeVerifier,
    "proofSnapshot.freshPolicy.disputeVerifier"
  );
  assertAddress(
    value.freshPolicy.disputeNullifierRegistry,
    "proofSnapshot.freshPolicy.disputeNullifierRegistry"
  );
  assertAddress(
    value.freshPolicy.stakeVault,
    "proofSnapshot.freshPolicy.stakeVault"
  );
  assertStringArray(
    value.freshPolicy.authorizedHooks,
    assertAddress,
    "proofSnapshot.freshPolicy.authorizedHooks"
  );
  assertRiskWindows(
    value.freshPolicy.riskWindows,
    "proofSnapshot.freshPolicy.riskWindows"
  );

  assertKeys(
    value.predecessorPolicy,
    [
      "owner",
      "pendingOwner",
      "admissionsPaused",
      "disputeVerifier",
      "disputeNullifierRegistry",
    ],
    "proofSnapshot.predecessorPolicy"
  );
  assertOwnership(value.predecessorPolicy, "proofSnapshot.predecessorPolicy");
  if (typeof value.predecessorPolicy.admissionsPaused !== "boolean")
    throw new Error("Invalid predecessor admissionsPaused");
  assertAddress(
    value.predecessorPolicy.disputeVerifier,
    "proofSnapshot.predecessorPolicy.disputeVerifier"
  );
  assertAddress(
    value.predecessorPolicy.disputeNullifierRegistry,
    "proofSnapshot.predecessorPolicy.disputeNullifierRegistry"
  );

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

  assertKeys(
    value.vault,
    [
      "owner",
      "pendingOwner",
      "controller",
      "pendingController",
      "pendingControllerValidAt",
      "controllerChangeDelay",
      "stakeToken",
    ],
    "proofSnapshot.vault"
  );
  assertOwnership(value.vault, "proofSnapshot.vault");
  assertAddress(value.vault.controller, "proofSnapshot.vault.controller");
  assertAddress(
    value.vault.pendingController,
    "proofSnapshot.vault.pendingController"
  );
  assertDecimal(
    value.vault.pendingControllerValidAt,
    "proofSnapshot.vault.pendingControllerValidAt"
  );
  assertDecimal(
    value.vault.controllerChangeDelay,
    "proofSnapshot.vault.controllerChangeDelay"
  );
  assertAddress(value.vault.stakeToken, "proofSnapshot.vault.stakeToken");

  assertKeys(value.registry, ["owner", "writers"], "proofSnapshot.registry");
  assertAddress(value.registry.owner, "proofSnapshot.registry.owner");
  assertStringArray(
    value.registry.writers,
    assertAddress,
    "proofSnapshot.registry.writers"
  );

  assertKeys(
    value.orchestrator,
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
  for (const key of [
    "owner",
    "lifecycleHook",
    "escrowRegistry",
    "paymentVerifierRegistry",
    "relayerRegistry",
    "protocolFeeRecipient",
  ])
    assertAddress(value.orchestrator[key], `proofSnapshot.orchestrator.${key}`);
  assertDecimal(
    value.orchestrator.protocolFee,
    "proofSnapshot.orchestrator.protocolFee"
  );
  for (const key of ["paused", "allowMultipleIntents", "registered"])
    if (typeof value.orchestrator[key] !== "boolean")
      throw new Error(`Invalid proofSnapshot.orchestrator.${key}`);

  assertKeys(
    value.freshHook,
    ["orchestratorRegistry", "whitelistPolicy", "disputeProtectionPolicy"],
    "proofSnapshot.freshHook"
  );
  for (const key of Object.keys(value.freshHook))
    assertAddress(value.freshHook[key], `proofSnapshot.freshHook.${key}`);
  assertKeys(
    value.whitelistPolicy,
    ["owner", "escrowRegistry", "groupRegistry", "orchestratorRegistry"],
    "proofSnapshot.whitelistPolicy"
  );
  for (const key of Object.keys(value.whitelistPolicy))
    assertAddress(
      value.whitelistPolicy[key],
      `proofSnapshot.whitelistPolicy.${key}`
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
  assertStringArray(
    value.attestationVerifier.witnesses,
    assertAddress,
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
  assertSafeInteger(
    value.lockProof.fromBlock,
    "proofSnapshot.lockProof.fromBlock"
  );
  assertSafeInteger(value.lockProof.toBlock, "proofSnapshot.lockProof.toBlock");
  if (!Array.isArray(value.lockProof.intents))
    throw new Error("Invalid lock intents");
  for (const intent of value.lockProof.intents) {
    assertKeys(
      intent,
      ["intentHash", "status", "lockAmount", "maturesAt", "classification"],
      "proofSnapshot.lockProof.intent"
    );
    assertHash(intent.intentHash, "intentHash");
    assertSafeInteger(intent.status, "intent status");
    if (![0, 1, 2, 3, 4, 5].includes(intent.status as number))
      throw new Error("Invalid intent status");
    assertDecimal(intent.lockAmount, "intent lockAmount");
    assertDecimal(intent.maturesAt, "intent maturesAt");
    if (
      ![
        "none",
        "pending",
        "settled-unmatured",
        "settled-matured",
        "terminal",
        "terminal-locked",
      ].includes(intent.classification as string)
    )
      throw new Error("Invalid intent classification");
  }
  if (typeof value.lockProof.ok !== "boolean")
    throw new Error("Invalid lockProof.ok");
  assertStringArray(
    value.lockProof.releasable,
    assertHash,
    "lockProof.releasable"
  );
  assertStringArray(value.lockProof.blocking, assertHash, "lockProof.blocking");
  if (value.lockProof.earliestMaturity !== null)
    assertDecimal(
      value.lockProof.earliestMaturity,
      "lockProof.earliestMaturity"
    );

  assertKeys(
    value.inventory,
    ["escrow", "depositCounter", "block", "tuples", "violations", "ok"],
    "proofSnapshot.inventory"
  );
  assertAddress(value.inventory.escrow, "inventory.escrow");
  assertDecimal(value.inventory.depositCounter, "inventory.depositCounter");
  assertSafeInteger(value.inventory.block, "inventory.block");
  for (const key of ["tuples", "violations"]) {
    if (!Array.isArray(value.inventory[key]))
      throw new Error(`Invalid inventory.${key}`);
    for (const tuple of value.inventory[key] as unknown[]) {
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
    }
  }
  if (typeof value.inventory.ok !== "boolean")
    throw new Error("Invalid inventory.ok");
}

export function validateActivationBatchManifest(
  value: unknown,
  expected?: Partial<ActivationBatchManifest>
): asserts value is ActivationBatchManifest {
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
      value.version !== 2 ||
      (value.kind !== "rotation" && value.kind !== "cutover") ||
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
    assertContractIdentity(value.guard, "guard");
    assertContractIdentity(value.postcondition, "postcondition");
    assertTrustSurface(value.trustSurface);
    assertSnapshot(value.proofSnapshot);
    assertString(value.manifestSha256, /^[0-9a-f]{64}$/, "manifestSha256");
    const { manifestSha256, ...unsigned } =
      value as unknown as ActivationBatchManifest;
    if (computeManifestSha256(unsigned) !== manifestSha256)
      throw new Error("Manifest digest mismatch");
    if (expected) {
      for (const [key, wanted] of Object.entries(expected)) {
        if (
          canonicalJson((value as Record<string, unknown>)[key]) !==
          canonicalJson(wanted)
        )
          throw new Error(`Expected ${key} mismatch`);
      }
    }
  } catch {
    throw new Error("Invalid activation Safe batch manifest");
  }
}

const SAFE_BATCH_DIR = "deployments/outputs/safe-batches";
const BASE_SAFE = "0x0bC26FF515411396DD588Abd6Ef6846E04470227";

export const ACTIVATION_BATCH_PATHS: Record<
  ActivationBatchKind,
  {
    batch: string;
    sidecar: string;
    supersededDir: string;
    meta: { name: string; description: string };
  }
> = {
  rotation: {
    batch: `${SAFE_BATCH_DIR}/base_method_scoped_rotation.json`,
    sidecar: `${SAFE_BATCH_DIR}/base_method_scoped_rotation.sha256.json`,
    supersededDir: `${SAFE_BATCH_DIR}/superseded`,
    meta: {
      name: "ZKP2P method-scoped dispute rotation - base",
      description:
        "assertReady(); optionally acceptOwnership(); setAdmissionsPaused(true); proposeController(freshPolicy)",
    },
  },
  cutover: {
    batch: `${SAFE_BATCH_DIR}/base_method_scoped_cutover.json`,
    sidecar: `${SAFE_BATCH_DIR}/base_method_scoped_cutover.sha256.json`,
    supersededDir: `${SAFE_BATCH_DIR}/superseded`,
    meta: {
      name: "ZKP2P method-scoped dispute cutover - base",
      description:
        "assertReady(); acceptVaultController(); add fresh writer; remove predecessor writer; set fresh lifecycle hook",
    },
  },
};

export function safeBatchJson(
  kind: ActivationBatchKind,
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
      ...ACTIVATION_BATCH_PATHS[kind].meta,
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

export function assertBatchMatchesActivationManifest(
  batch: unknown,
  manifest: ActivationBatchManifest
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
    const expectedMeta = ACTIVATION_BATCH_PATHS[manifest.kind].meta;
    if (
      batch.meta.name !== expectedMeta.name ||
      batch.meta.description !== expectedMeta.description ||
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
    throw new Error("Safe batch does not match activation manifest");
  }
}
