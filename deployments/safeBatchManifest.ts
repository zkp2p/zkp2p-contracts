import { createHash } from "crypto";

export type SafeBatchTransactionInput = {
  to: string;
  value: string | number;
  data: string;
  operation: string | number;
};

export type NormalizedSafeBatchTransaction = {
  to: string;
  value: string;
  data: string;
  operation: number;
};

export type DisputeSafeBatchManifest = {
  version: 1;
  chainId: number;
  safe: string;
  safeNonce: string;
  sourceSha: string;
  simulationBlockNumber: number;
  simulationBlockHash: string;
  simulationResult: "success";
  transactions: NormalizedSafeBatchTransaction[];
  transactionsSha256: string;
};

function requireHex(
  value: string,
  bytes: number | null,
  label: string
): string {
  const pattern =
    bytes === null
      ? /^0x(?:[0-9a-fA-F]{2})*$/
      : new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

export function normalizeSafeTransactions(
  transactions: readonly SafeBatchTransactionInput[]
): NormalizedSafeBatchTransaction[] {
  return transactions.map((transaction) => {
    const value = String(transaction.value);
    if (!/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error("Invalid Safe transaction value");
    const operation = Number(transaction.operation);
    if (!Number.isSafeInteger(operation) || operation < 0 || operation > 1) {
      throw new Error("Invalid Safe transaction operation");
    }
    return {
      to: requireHex(transaction.to, 20, "Safe transaction target"),
      value,
      data: requireHex(transaction.data, null, "Safe transaction calldata"),
      operation,
    };
  });
}

export function canonicalTransactionBytes(
  transactions: readonly SafeBatchTransactionInput[]
): Buffer {
  return Buffer.from(
    JSON.stringify(normalizeSafeTransactions(transactions)),
    "utf8"
  );
}

export function canonicalTransactionHash(
  transactions: readonly SafeBatchTransactionInput[]
): string {
  return createHash("sha256")
    .update(canonicalTransactionBytes(transactions))
    .digest("hex");
}

export function validateSafeBatchManifest(
  value: DisputeSafeBatchManifest,
  expected?: DisputeSafeBatchManifest
): DisputeSafeBatchManifest {
  try {
    if (value.version !== 1 || value.chainId !== 8453) throw new Error();
    requireHex(value.safe, 20, "Safe address");
    if (!/^(0|[1-9][0-9]*)$/.test(value.safeNonce)) throw new Error();
    if (!/^[0-9a-f]{40}$/.test(value.sourceSha)) throw new Error();
    if (
      !Number.isSafeInteger(value.simulationBlockNumber) ||
      value.simulationBlockNumber <= 0
    )
      throw new Error();
    requireHex(value.simulationBlockHash, 32, "simulation block hash");
    if (value.simulationResult !== "success") throw new Error();
    if (!Array.isArray(value.transactions) || value.transactions.length === 0)
      throw new Error();
    if (!/^[0-9a-f]{64}$/.test(value.transactionsSha256)) throw new Error();
    if (
      canonicalTransactionHash(value.transactions) !== value.transactionsSha256
    )
      throw new Error();
    if (expected) {
      for (const key of [
        "chainId",
        "safe",
        "safeNonce",
        "sourceSha",
        "simulationBlockNumber",
        "simulationBlockHash",
        "simulationResult",
        "transactionsSha256",
      ] as const) {
        const actual =
          typeof value[key] === "string"
            ? String(value[key]).toLowerCase()
            : value[key];
        const wanted =
          typeof expected[key] === "string"
            ? String(expected[key]).toLowerCase()
            : expected[key];
        if (actual !== wanted) throw new Error();
      }
    }
  } catch {
    throw new Error("Invalid dispute Safe batch manifest");
  }
  return value;
}
