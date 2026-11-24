import { createHash } from "node:crypto";
import { utils } from "ethers";
import { UPV4_BASE_RELEASE, UPV5_BASE_RELEASE } from "./parameters";
import {
  UPV5_CALL_INTERFACES, Upv5Call, Upv5CutoverInput, Upv5Deployed, Upv5Function, Upv5Route, Upv5Target,
  buildUpv5CutoverCalls, encodeUpv5Call, listArg, lower, nonzeroAddress, scalarArg, validateUpv5CutoverInput,
} from "./upv5Cutover";

export interface Upv5SafeBatch {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: "1.16.5";
    createdFromSafeAddress: string;
    createdFromOwnerAddress: "";
  };
  transactions: Array<{
    to: string;
    value: "0";
    data: string;
    contractMethod: null;
    contractInputsValues: null;
  }>;
}

export interface Upv5DecodedRow {
  index: number;
  to: string;
  target: Upv5Target;
  function: string;
  writer?: string;
  paymentMethod?: string;
  verifier?: string;
  currencies?: string[];
  disputeVerifier?: string;
}

export const UPV5_BASE_SAFE_BATCH_FILE = "base_upv5_cutover.json";
const BATCH_NAME = "Base UPV5 cutover";

export function baseUpv5CutoverInput(deployed: Upv5Deployed): Upv5CutoverInput {
  return {
    chainId: UPV5_BASE_RELEASE.chainId,
    paymentVerifierRegistry: UPV5_BASE_RELEASE.paymentVerifierRegistry,
    nullifierRegistryV2: UPV5_BASE_RELEASE.nullifierRegistryV2,
    disputeProtectionPolicyV2: UPV5_BASE_RELEASE.disputeProtectionPolicyV2,
    deployed,
    retiredWriters: [...UPV5_BASE_RELEASE.retiredNullifierWriters],
    routes: UPV4_BASE_RELEASE.paymentRoutes.map(({ method, currencies }) => ({
      method: utils.id(method), currencies: currencies.map(utils.id), label: method, currencyLabels: [...currencies],
    })),
  };
}

export function renderUpv5SafeBatch(
  input: Upv5CutoverInput, safe: string, createdAt: number,
): Upv5SafeBatch {
  const calls = buildUpv5CutoverCalls(input);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("createdAt: invalid");
  const { nullifierRegistryV3, unifiedPaymentVerifierV5, disputeVerifierV2 } = input.deployed;
  return {
    version: "1.0", chainId: String(input.chainId), createdAt,
    meta: {
      name: BATCH_NAME,
      description: `${calls.length} calls. UPV5 ${utils.getAddress(unifiedPaymentVerifierV5)}; ` +
        `NullifierRegistryV3 ${utils.getAddress(nullifierRegistryV3)}; ` +
        `DisputeVerifierV2 ${utils.getAddress(disputeVerifierV2)}. One-way: once V3 takes a write, ` +
        "routing back to UPV4 reopens payment replay.",
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: nonzeroAddress(safe, "safe"), createdFromOwnerAddress: "",
    },
    transactions: calls.map((call) => ({ ...encodeUpv5Call(call), contractMethod: null, contractInputsValues: null })),
  };
}

export function serializeUpv5SafeBatch(batch: Upv5SafeBatch): string {
  return JSON.stringify(batch, null, 2) + "\n";
}

export function serializeUpv5SafeBatchSidecar(fileName: string, contents: string): string {
  const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
  return JSON.stringify({ file: fileName, sha256 }, null, 2) + "\n";
}

function decodedRow(call: Upv5Call, index: number, routes: Upv5Route[]): Upv5DecodedRow {
  const row: Upv5DecodedRow = { index, to: utils.getAddress(call.to), target: call.target, function: call.signature.split("(")[0] };
  if (call.signature === Upv5Function.AddWriter || call.signature === Upv5Function.RemoveWriter) {
    return { ...row, writer: utils.getAddress(scalarArg(call, 0)) };
  }
  if (call.signature === Upv5Function.SetDisputeVerifier) {
    return { ...row, disputeVerifier: utils.getAddress(scalarArg(call, 0)) };
  }
  const method = lower(scalarArg(call, 0));
  const route = routes.find((candidate) => lower(candidate.method) === method);
  row.paymentMethod = route?.label ?? method;
  if (call.signature === Upv5Function.AddMethod) {
    row.verifier = utils.getAddress(scalarArg(call, 1));
    row.currencies = listArg(call, 2).map((currency) => {
      const currencyIndex = route?.currencies.findIndex((candidate) => lower(candidate) === lower(currency)) ?? -1;
      return route?.currencyLabels?.[currencyIndex] ?? lower(currency);
    });
  }
  return row;
}

export function decodeUpv5SafeBatch(batch: Upv5SafeBatch, input: Upv5CutoverInput, safe: string): Upv5DecodedRow[] {
  const checked = validateUpv5CutoverInput(input);
  if (batch.chainId !== String(checked.chainId)) throw new Error("batch.chainId: mismatch");
  if (nonzeroAddress(batch.meta.createdFromSafeAddress, "batch.safe") !== nonzeroAddress(safe, "safe")) {
    throw new Error("batch.safe: mismatch");
  }
  const targets = new Map<string, Upv5Target>([
    [checked.nullifierRegistryV2, Upv5Target.NullifierRegistryV2],
    [checked.deployed.nullifierRegistryV3, Upv5Target.NullifierRegistryV3],
    [checked.paymentVerifierRegistry, Upv5Target.PaymentVerifierRegistry],
    [checked.disputeProtectionPolicyV2, Upv5Target.DisputeProtectionPolicyV2],
  ]);
  return batch.transactions.map((transaction, index) => {
    const prefix = `transaction[${index}]`;
    if (transaction.value !== "0") throw new Error(`${prefix}.value: expected 0`);
    if (transaction.contractMethod !== null || transaction.contractInputsValues !== null) {
      throw new Error(`${prefix}: expected null contractMethod/contractInputsValues`);
    }
    const to = nonzeroAddress(transaction.to, `${prefix}.to`);
    const target = targets.get(to);
    if (target === undefined) throw new Error(`${prefix}.to: unknown target ${to}`);
    let decoded: utils.TransactionDescription;
    try {
      decoded = UPV5_CALL_INTERFACES[target].parseTransaction({ data: transaction.data });
    } catch {
      throw new Error(`${prefix}.data: unknown selector or invalid calldata`);
    }
    if (UPV5_CALL_INTERFACES[target].encodeFunctionData(decoded.functionFragment, decoded.args) !== lower(transaction.data)) {
      throw new Error(`${prefix}.data: non-canonical or trailing calldata`);
    }
    const signature = Object.values(Upv5Function).find((candidate) => candidate === decoded.signature);
    if (signature === undefined) throw new Error(`${prefix}.data: unexpected function ${decoded.signature}`);
    const args = Array.from(decoded.args, (value: unknown): string | string[] =>
      Array.isArray(value) ? value.map(String) : String(value));
    return decodedRow({ to, target, signature, args, description: "" }, index, checked.routes);
  });
}

export function assertUpv5SafeBatch(batch: Upv5SafeBatch, input: Upv5CutoverInput, safe: string): void {
  const checked = validateUpv5CutoverInput(input);
  const expected = buildUpv5CutoverCalls(checked).map((call, index) => decodedRow(call, index, checked.routes));
  const rows = decodeUpv5SafeBatch(batch, checked, safe);
  if (rows.length !== expected.length) throw new Error(`call count: expected ${expected.length}, got ${rows.length}`);
  expected.forEach((row, index) => {
    // Object.keys returns string[]; every key comes from an Upv5DecodedRow built above.
    for (const field of Object.keys(row) as Array<keyof Upv5DecodedRow>) {
      if (JSON.stringify(rows[index][field]) !== JSON.stringify(row[field])) {
        throw new Error(`transaction[${index}].${field}: expected ${JSON.stringify(row[field])}, ` +
          `got ${JSON.stringify(rows[index][field])}`);
      }
    }
  });
}

export function formatUpv5Plan(rows: Upv5DecodedRow[]): string {
  return ["| # | target | function | args |", "| --- | --- | --- | --- |", ...rows.map((row) => {
    const args = [row.writer, row.disputeVerifier, row.paymentMethod, row.verifier,
      row.currencies ? `${row.currencies.length} ${row.currencies.length === 1 ? "currency" : "currencies"}: ${row.currencies.join(", ")}` : undefined,
    ].filter((value) => value !== undefined).join("; ");
    return `| ${row.index} | ${row.target} (${row.to}) | ${row.function} | ${args} |`;
  })].join("\n") + "\n";
}
