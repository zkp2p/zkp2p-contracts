import { createHash } from "crypto";
import { BigNumber } from "ethers";
import { canonicalJson } from "./activationBatchManifest";
import type { ContractIdentity } from "./activationBatchManifest";
import {
  canonicalTransactionHash,
  normalizeSafeTransactions,
} from "./safeBatchManifest";
import type { NormalizedSafeBatchTransaction } from "./safeBatchManifest";
import type {
  BypassActivationSnapshot,
  BypassTrustSurfaceInput,
} from "./bypassDisputeActivation";

export { canonicalJson } from "./activationBatchManifest";
export type { ContractIdentity } from "./activationBatchManifest";

export type BypassActivationBatchManifest = {
  version: 4;
  kind: "dispute-bypass-cutover";
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
  trustSurface: BypassTrustSurfaceInput;
  proofSnapshot: BypassActivationSnapshot;
  manifestSha256: string;
};
export function computeBypassManifestSha256(
  manifest: Omit<BypassActivationBatchManifest, "manifestSha256">
): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

type Validator = (value: unknown, label: string) => void;
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
function pattern(regex: RegExp): Validator {
  return (value, label) => {
    if (typeof value !== "string" || !regex.test(value))
      throw new Error(`Invalid ${label}`);
  };
}
const address = pattern(/^0x[0-9a-f]{40}$/);
const hash = pattern(/^0x[0-9a-f]{64}$/);
const decimal = pattern(/^(0|[1-9][0-9]*)$/);
const digest = pattern(/^[0-9a-f]{64}$/);
const boolean: Validator = (value, label) => {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
};
const integer: Validator = (value, label) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${label}`);
};
function uint(bits: number): Validator {
  return (value, label) => {
    decimal(value, label);
    if (BigNumber.from(value as string).gte(BigNumber.from(2).pow(bits)))
      throw new Error(`Invalid ${label} range`);
  };
}
const uint64 = uint(64);
const uint256 = uint(256);
function array(item: Validator): Validator {
  return (value, label) => {
    if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
    Array.from(value).forEach((entry: unknown, index) =>
      item(entry, `${label}[${index}]`)
    );
  };
}
function object(fields: Record<string, Validator>): Validator {
  return (value, label) => {
    assertKeys(value, Object.keys(fields), label);
    Object.entries(fields).forEach(([key, validate]) =>
      validate(value[key], `${label}.${key}`)
    );
  };
}
const addresses = array(address);
const hashes = array(hash);
const ownership = { owner: address, pendingOwner: address };
const hook = object({
  orchestratorRegistry: address,
  whitelistPolicy: address,
  disputeProtectionPolicy: address,
});
const riskWindows: Validator = (value, label) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  Object.entries(value).forEach(([method, window]) => {
    hash(method, `${label} key`);
    uint64(window, `${label}.${method}`);
  });
};
const inventoryTuple = object({
  escrow: address,
  depositId: uint256,
  paymentMethod: hash,
});
const inventory = object({
  escrow: address,
  block: decimal,
  tuples: array(inventoryTuple),
  violations: array(inventoryTuple),
  ok: boolean,
});
const route = object({
  paymentMethod: hash,
  verifier: address,
  currencies: hashes,
});
const registry = object({ owner: address, writers: addresses });
const snapshot = object({
  network: pattern(/^(base|base_staging|localhost|hardhat)$/),
  blockNumber: decimal,
  blockHash: hash,
  blockTimestamp: decimal,
  freshVault: object({
    ...ownership,
    controller: address,
    pendingController: address,
    pendingControllerValidAt: uint64,
    controllerChangeDelay: uint64,
    stakeToken: address,
  }),
  freshPolicy: object({
    ...ownership,
    admissionsPaused: boolean,
    stakeVault: address,
    disputeVerifier: address,
    disputeNullifierRegistry: address,
    authorizedHooks: addresses,
    riskWindows,
  }),
  freshHook: hook,
  verifier: object({
    owner: address,
    orchestratorRegistry: address,
    nullifierRegistry: address,
    attestationVerifier: address,
    paymentMethods: hashes,
  }),
  retiredVerifier: object({ owner: address, paymentMethods: hashes }),
  predecessorVault: object({
    owner: address,
    controller: address,
    pendingController: address,
  }),
  predecessorPolicy: object({
    ...ownership,
    stakeVault: address,
    disputeVerifier: address,
    disputeNullifierRegistry: address,
    predecessorHookAuthorized: boolean,
  }),
  predecessorHook: hook,
  disputeRegistry: registry,
  nullifierRegistryV2: registry,
  paymentVerifierRegistry: object({ owner: address, methods: array(route) }),
  orchestrator: object({
    owner: address,
    paused: boolean,
    lifecycleHook: address,
    escrowRegistry: address,
    paymentVerifierRegistry: address,
    relayerRegistry: address,
    protocolFee: uint256,
    protocolFeeRecipient: address,
    allowMultipleIntents: boolean,
    registered: boolean,
  }),
  whitelistPolicy: object({
    owner: address,
    escrowRegistry: address,
    groupRegistry: address,
    orchestratorRegistry: address,
  }),
  attestationVerifier: object({
    owner: address,
    requiredSignatures: uint256,
    witnesses: addresses,
  }),
  disputeVerifier: object({
    ...ownership,
    attestationVerifier: address,
    nullifierRegistry: address,
  }),
  inventory,
});
const trustSurface = object({
  safe: address,
  deployer: address,
  orchestrator: address,
  orchestratorRegistry: address,
  escrowRegistry: address,
  paymentVerifierRegistry: address,
  relayerRegistry: address,
  protocolFeeRecipient: address,
  allowMultipleIntents: boolean,
  nullifierRegistryV2: address,
  retiredVerifier: address,
  verifier: address,
  attestationVerifier: address,
  witnesses: addresses,
  disputeRegistry: address,
  disputeVerifier: address,
  whitelistPolicy: address,
  whitelistPolicyOwner: address,
  groupRegistry: address,
  stakeToken: address,
  predecessorVault: address,
  predecessorPolicy: address,
  predecessorHook: address,
  freshVault: address,
  freshPolicy: address,
  freshHook: address,
  paymentMethods: hashes,
  currencies: hashes,
  currencyCounts: array(uint256),
  riskWindowMethods: hashes,
  riskWindows: array(uint64),
});
const identity = object({
  address,
  artifactName: pattern(/^[A-Za-z][A-Za-z0-9]*$/),
  constructorArgs: (value, label) => {
    if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
    canonicalJson(value);
  },
  deployTransactionHash: hash,
  runtimeCodeHash: hash,
});
const transaction = object({
  to: address,
  value: decimal,
  data: pattern(/^0x(?:[0-9a-f]{2})*$/),
  operation: (value, label) => {
    if (value !== 0 && value !== 1) throw new Error(`Invalid ${label}`);
  },
});
const manifestSchema = object({
  version: (value) => {
    if (value !== 4) throw new Error("Invalid version");
  },
  kind: (value) => {
    if (value !== "dispute-bypass-cutover") throw new Error("Invalid kind");
  },
  chainId: (value) => {
    if (value !== 8453) throw new Error("Invalid chainId");
  },
  safe: address,
  safeNonce: decimal,
  sourceSha: pattern(/^[0-9a-f]{40}$/),
  proofBlock: object({ number: integer, hash }),
  simulationBlockNumber: integer,
  simulationBlockHash: hash,
  simulationResult: (value) => {
    if (value !== "success") throw new Error("Invalid simulationResult");
  },
  transactions: array(transaction),
  transactionsSha256: digest,
  guard: identity,
  postcondition: identity,
  trustSurface,
  proofSnapshot: snapshot,
  manifestSha256: digest,
});
function assertSurfaceLengths(surface: BypassTrustSurfaceInput): void {
  if (
    surface.paymentMethods.length !== surface.currencyCounts.length ||
    surface.riskWindowMethods.length !== surface.riskWindows.length
  ) {
    throw new Error("Invalid trustSurface array lengths");
  }
  const count = surface.currencyCounts.reduce(
    (total, value) => total.add(value),
    BigNumber.from(0)
  );
  if (!count.eq(surface.currencies.length))
    throw new Error("Invalid trustSurface currency count");
}
export function validateBypassActivationBatchManifest(
  value: unknown,
  expected?: Partial<BypassActivationBatchManifest>
): asserts value is BypassActivationBatchManifest {
  try {
    manifestSchema(value, "manifest");
    // The complete recursive schema above establishes this type before digest checks.
    const manifest = value as BypassActivationBatchManifest;
    if (manifest.transactions.length === 0)
      throw new Error("Empty transactions");
    if (
      canonicalTransactionHash(manifest.transactions) !==
      manifest.transactionsSha256
    )
      throw new Error("Transaction digest mismatch");
    assertSurfaceLengths(manifest.trustSurface);
    const { manifestSha256, ...unsigned } = manifest;
    if (computeBypassManifestSha256(unsigned) !== manifestSha256)
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
    throw new Error("Invalid dispute bypass Safe batch manifest");
  }
}

const SAFE_BATCH_DIR = "deployments/outputs/safe-batches";
const BASE_SAFE = "0x0bC26FF515411396DD588Abd6Ef6846E04470227";
export const BYPASS_ACTIVATION_BATCH_PATHS = {
  batch: `${SAFE_BATCH_DIR}/base_dispute_bypass_cutover.json`,
  sidecar: `${SAFE_BATCH_DIR}/base_dispute_bypass_cutover.sha256.json`,
  supersededDir: `${SAFE_BATCH_DIR}/superseded`,
  meta: {
    name: "ZKP2P no-stake dispute bypass and UPV4 cutover - base",
    description:
      "assertReady(); conditionally accept fresh vault and policy ownership; add fresh dispute writer; add UPV4 nullifier writer; re-route every payment method to UPV4 preserving order and currencies; remove UPV3 nullifier writer; set fresh lifecycle hook",
  },
} as const;
export function bypassSafeBatchJson(
  transactions: NormalizedSafeBatchTransaction[],
  createdAtMs: number
): object {
  integer(createdAtMs, "Safe batch creation time");
  return {
    version: "1.0",
    chainId: "8453",
    createdAt: createdAtMs,
    meta: {
      ...BYPASS_ACTIVATION_BATCH_PATHS.meta,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: BASE_SAFE,
      createdFromOwnerAddress: "",
    },
    transactions: normalizeSafeTransactions(transactions).map((item) => ({
      ...item,
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
}
export function assertBatchMatchesBypassActivationManifest(
  batch: unknown,
  manifest: BypassActivationBatchManifest
): void {
  try {
    validateBypassActivationBatchManifest(manifest);
    assertKeys(
      batch,
      ["version", "chainId", "createdAt", "meta", "transactions"],
      "Safe batch"
    );
    if (batch.version !== "1.0" || batch.chainId !== "8453")
      throw new Error("Invalid Safe batch envelope");
    integer(batch.createdAt, "Safe batch createdAt");
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
    if (
      batch.meta.name !== BYPASS_ACTIVATION_BATCH_PATHS.meta.name ||
      batch.meta.description !==
        BYPASS_ACTIVATION_BATCH_PATHS.meta.description ||
      batch.meta.txBuilderVersion !== "1.16.5" ||
      batch.meta.createdFromSafeAddress !== BASE_SAFE ||
      batch.meta.createdFromOwnerAddress !== ""
    ) {
      throw new Error("Invalid Safe batch metadata");
    }
    if (!Array.isArray(batch.transactions))
      throw new Error("Invalid Safe batch transactions");
    const transactions = batch.transactions.map(
      (item: unknown, index): NormalizedSafeBatchTransaction => {
        assertKeys(
          item,
          [
            "to",
            "value",
            "data",
            "operation",
            "contractMethod",
            "contractInputsValues",
          ],
          `Safe batch transactions[${index}]`
        );
        if (item.contractMethod !== null || item.contractInputsValues !== null)
          throw new Error("Invalid Safe batch transaction metadata");
        const { contractMethod, contractInputsValues, ...raw } = item;
        transaction(raw, `Safe batch transactions[${index}]`);
        return raw as NormalizedSafeBatchTransaction;
      }
    );
    const normalized = normalizeSafeTransactions(transactions);
    if (
      canonicalTransactionHash(normalized) !== manifest.transactionsSha256 ||
      canonicalJson(normalized) !== canonicalJson(manifest.transactions)
    ) {
      throw new Error("Safe batch transaction mismatch");
    }
  } catch {
    throw new Error(
      "Safe batch does not match dispute bypass activation manifest"
    );
  }
}
