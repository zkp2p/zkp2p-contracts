import { createHash } from "node:crypto";
import { constants, utils } from "ethers";
import { UPV4_BASE_RELEASE } from "./parameters";

export enum Upv4SafeBatchKind {
  Cutover = "cutover",
  Upv3WriterRemoval = "upv3-writer-removal",
  Rollback = "rollback",
}

export enum Upv4SafeContract {
  NullifierRegistryV2 = "NullifierRegistryV2",
  PaymentVerifierRegistry = "PaymentVerifierRegistry",
}

export enum Upv4SafeFunction {
  AddWriter = "addWritePermission(address)",
  RemoveWriter = "removeWritePermission(address)",
  AddMethod = "addPaymentMethod(bytes32,address,bytes32[])",
  RemoveMethod = "removePaymentMethod(bytes32)",
}

export interface Upv4CutoverConfig {
  chainId: number;
  safe: string;
  paymentVerifierRegistry: string;
  nullifierRegistryV2: string;
  unifiedPaymentVerifierV3: string;
  routes: Array<{ method: string; currencies: string[]; label?: string; currencyLabels?: string[] }>;
}

export interface Upv4SafeCall {
  to: string;
  contract: Upv4SafeContract;
  signature: Upv4SafeFunction;
  args: Array<string | string[]>;
  description: string;
}

export interface Upv4SafeBatch {
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

export interface Upv4DecodedRow {
  index: number;
  to: string;
  contract: Upv4SafeContract;
  function: string;
  paymentMethod?: string;
  verifier?: string;
  currencies?: string[];
  writer?: string;
}

export interface Upv4ReleasePlan {
  pinnedBlock: number;
  safe: string;
  batches: Array<{ kind: Upv4SafeBatchKind; name: string; callCount: number; rows: Upv4DecodedRow[] }>;
}

export const UPV4_SAFE_BATCH_FILES: Record<Upv4SafeBatchKind, string> = {
  [Upv4SafeBatchKind.Cutover]: "base_upv4_cutover.json",
  [Upv4SafeBatchKind.Upv3WriterRemoval]: "base_upv4_upv3_writer_removal.json",
  [Upv4SafeBatchKind.Rollback]: "base_upv4_rollback.json",
};

const BATCH_NAMES: Record<Upv4SafeBatchKind, string> = {
  [Upv4SafeBatchKind.Cutover]: "Base UPV4 payment-route cutover",
  [Upv4SafeBatchKind.Upv3WriterRemoval]: "Base UPV3 NullifierRegistryV2 writer removal",
  [Upv4SafeBatchKind.Rollback]: "Base UPV4 payment-route rollback to UPV3",
};

const INTERFACES = {
  [Upv4SafeContract.NullifierRegistryV2]: new utils.Interface([
    `function ${Upv4SafeFunction.AddWriter}`,
    `function ${Upv4SafeFunction.RemoveWriter}`,
  ]),
  [Upv4SafeContract.PaymentVerifierRegistry]: new utils.Interface([
    `function ${Upv4SafeFunction.AddMethod}`,
    `function ${Upv4SafeFunction.RemoveMethod}`,
  ]),
};

export function baseCutoverConfig(): Upv4CutoverConfig {
  return {
    chainId: UPV4_BASE_RELEASE.chainId,
    safe: UPV4_BASE_RELEASE.safe,
    paymentVerifierRegistry: UPV4_BASE_RELEASE.paymentVerifierRegistry,
    nullifierRegistryV2: UPV4_BASE_RELEASE.nullifierRegistryV2,
    unifiedPaymentVerifierV3: UPV4_BASE_RELEASE.unifiedPaymentVerifierV3,
    routes: UPV4_BASE_RELEASE.paymentRoutes.map(({ method, currencies }) => ({
      method: utils.id(method), currencies: currencies.map(utils.id),
      label: method, currencyLabels: [...currencies],
    })),
  };
}

function nonzeroAddress(value: string, field: string): string {
  if (!utils.isAddress(value) || value.toLowerCase() === constants.AddressZero) {
    throw new Error(`${field}: invalid or zero address`);
  }
  return utils.getAddress(value);
}

function hashes(values: string[], field: string): string[] {
  if (values.length === 0) throw new Error(`${field}: empty`);
  const normalized = values.map((value) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value) || value === constants.HashZero) {
      throw new Error(`${field}: invalid or zero hash`);
    }
    return value.toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field}: duplicate hash`);
  return normalized;
}

function validateConfig(config: Upv4CutoverConfig): Upv4CutoverConfig {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error("chainId: invalid");
  const addresses = {
    safe: nonzeroAddress(config.safe, "safe"),
    paymentVerifierRegistry: nonzeroAddress(config.paymentVerifierRegistry, "paymentVerifierRegistry"),
    nullifierRegistryV2: nonzeroAddress(config.nullifierRegistryV2, "nullifierRegistryV2"),
    unifiedPaymentVerifierV3: nonzeroAddress(config.unifiedPaymentVerifierV3, "unifiedPaymentVerifierV3"),
  };
  if (new Set(Object.values(addresses)).size !== 4) throw new Error("config: duplicate address");
  const methods = hashes(config.routes.map((route) => route.method), "routes");
  const routes = config.routes.map((route, index) => {
    const method = methods[index];
    const currencies = hashes(route.currencies, `routes[${index}].currencies`);
    if (route.label !== undefined && utils.id(route.label) !== method) {
      throw new Error(`routes[${index}].label: hash mismatch`);
    }
    if (route.currencyLabels !== undefined && (route.currencyLabels.length !== currencies.length ||
      route.currencyLabels.some((label, currencyIndex) => utils.id(label) !== currencies[currencyIndex]))) {
      throw new Error(`routes[${index}].currencyLabels: hash mismatch`);
    }
    return { ...route, method, currencies };
  });
  return { ...config, ...addresses, routes };
}

function plannedCalls(kind: Upv4SafeBatchKind, config: Upv4CutoverConfig, upv4: string): Upv4SafeCall[] {
  const writerCall = (signature: Upv4SafeFunction, writer: string): Upv4SafeCall => ({
    to: config.nullifierRegistryV2, contract: Upv4SafeContract.NullifierRegistryV2,
    signature, args: [writer], description: `${signature}: ${writer}`,
  });
  if (kind === Upv4SafeBatchKind.Upv3WriterRemoval) {
    return [writerCall(Upv4SafeFunction.RemoveWriter, config.unifiedPaymentVerifierV3)];
  }
  if (kind !== Upv4SafeBatchKind.Cutover && kind !== Upv4SafeBatchKind.Rollback) {
    throw new Error(`Unknown batch kind: ${kind}`);
  }
  const verifier = kind === Upv4SafeBatchKind.Cutover ? upv4 : config.unifiedPaymentVerifierV3;
  return [
    ...(kind === Upv4SafeBatchKind.Cutover ? [writerCall(Upv4SafeFunction.AddWriter, upv4)] : []),
    ...[...config.routes].reverse().map((route): Upv4SafeCall => ({
      to: config.paymentVerifierRegistry, contract: Upv4SafeContract.PaymentVerifierRegistry,
      signature: Upv4SafeFunction.RemoveMethod, args: [route.method],
      description: `Remove ${route.label ?? route.method}`,
    })),
    ...config.routes.map((route): Upv4SafeCall => ({
      to: config.paymentVerifierRegistry, contract: Upv4SafeContract.PaymentVerifierRegistry,
      signature: Upv4SafeFunction.AddMethod, args: [route.method, verifier, [...route.currencies]],
      description: `Route ${route.label ?? route.method} to ${verifier}`,
    })),
  ];
}

/** Remove from the tail to avoid swap-and-pop reordering; keep UPV3's writer permission for rollback. */
export function buildUpv4SafeCalls(
  kind: Upv4SafeBatchKind, config: Upv4CutoverConfig, upv4Address: string,
): Upv4SafeCall[] {
  const checked = validateConfig(config);
  const upv4 = nonzeroAddress(upv4Address, "upv4Address");
  if ([checked.safe, checked.paymentVerifierRegistry, checked.nullifierRegistryV2,
    checked.unifiedPaymentVerifierV3].includes(upv4)) throw new Error("upv4Address: conflicts with config");
  return plannedCalls(kind, checked, upv4);
}

export function encodeUpv4SafeCall(call: Upv4SafeCall): { to: string; value: "0"; data: string } {
  return { to: call.to, value: "0", data: INTERFACES[call.contract].encodeFunctionData(call.signature, call.args) };
}

export function renderUpv4SafeBatch(
  kind: Upv4SafeBatchKind, config: Upv4CutoverConfig, upv4Address: string,
  { createdAt, sourceSha }: { createdAt: number; sourceSha?: string },
): Upv4SafeBatch {
  const calls = buildUpv4SafeCalls(kind, config, upv4Address);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("createdAt: invalid");
  if (sourceSha !== undefined && !/^[0-9a-fA-F]{40}$/.test(sourceSha)) throw new Error("sourceSha: invalid");
  const conditions: Record<Upv4SafeBatchKind, string> = {
    [Upv4SafeBatchKind.Cutover]: "Cutover keeps UPV3 as a writer for rollback.",
    [Upv4SafeBatchKind.Upv3WriterRemoval]:
      "Prepared but not scheduled; disables the rollback batch until UPV3 is re-added as a writer.",
    [Upv4SafeBatchKind.Rollback]: "Rollback is valid only while UPV3 remains a writer; UPV4 stays a writer.",
  };
  return {
    version: "1.0", chainId: String(config.chainId), createdAt,
    meta: {
      name: BATCH_NAMES[kind],
      description: `${calls.length} ${calls.length === 1 ? "call" : "calls"}. UPV4 ${utils.getAddress(upv4Address)}; ` +
        `UPV3 ${utils.getAddress(config.unifiedPaymentVerifierV3)}. ${conditions[kind]}` +
        (sourceSha === undefined ? "" : ` Source ${sourceSha}.`),
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: utils.getAddress(config.safe), createdFromOwnerAddress: "",
    },
    transactions: calls.map((call) => ({
      ...encodeUpv4SafeCall(call), contractMethod: null, contractInputsValues: null,
    })),
  };
}

export function serializeUpv4SafeBatch(batch: Upv4SafeBatch): string {
  return JSON.stringify(batch, null, 2) + "\n";
}

export function upv4SafeBatchSidecar(fileName: string, contents: string): { file: string; sha256: string } {
  return { file: fileName, sha256: createHash("sha256").update(contents, "utf8").digest("hex") };
}

export function serializeUpv4SafeBatchSidecar(fileName: string, contents: string): string {
  return JSON.stringify(upv4SafeBatchSidecar(fileName, contents), null, 2) + "\n";
}

function decodedRow(call: Upv4SafeCall, index: number, config: Upv4CutoverConfig): Upv4DecodedRow {
  const row: Upv4DecodedRow = {
    index, to: call.to, contract: call.contract, function: call.signature.split("(")[0],
  };
  if (call.contract === Upv4SafeContract.NullifierRegistryV2) {
    return { ...row, writer: call.args[0] as string };
  }
  const [method, verifier, currencies] = call.args as [string, string, string[]];
  const route = config.routes.find((candidate) => candidate.method === method);
  row.paymentMethod = route?.label ?? method;
  if (call.signature === Upv4SafeFunction.AddMethod) {
    row.verifier = verifier;
    row.currencies = currencies.map((currency) => {
      const currencyIndex = route?.currencies.indexOf(currency) ?? -1;
      return route?.currencyLabels?.[currencyIndex] ?? currency;
    });
  }
  return row;
}

export function decodeUpv4SafeBatch(batch: Upv4SafeBatch, config: Upv4CutoverConfig): Upv4DecodedRow[] {
  const checked = validateConfig(config);
  if (batch.chainId !== String(checked.chainId)) throw new Error("batch.chainId: mismatch");
  if (nonzeroAddress(batch.meta.createdFromSafeAddress, "batch.safe") !== checked.safe) {
    throw new Error("batch.safe: mismatch");
  }
  return batch.transactions.map((transaction, index) => {
    const prefix = `transaction[${index}]`;
    if (transaction.value !== "0") throw new Error(`${prefix}.value: expected 0`);
    if (transaction.contractMethod !== null || transaction.contractInputsValues !== null) {
      throw new Error(`${prefix}: expected null contractMethod/contractInputsValues`);
    }
    const to = nonzeroAddress(transaction.to, `${prefix}.to`);
    let contract: Upv4SafeContract;
    if (to === checked.nullifierRegistryV2) contract = Upv4SafeContract.NullifierRegistryV2;
    else if (to === checked.paymentVerifierRegistry) contract = Upv4SafeContract.PaymentVerifierRegistry;
    else throw new Error(`${prefix}.to: unknown target ${to}`);
    const abi = INTERFACES[contract];
    let decoded: utils.TransactionDescription;
    try {
      decoded = abi.parseTransaction({ data: transaction.data });
    } catch {
      throw new Error(`${prefix}.data: unknown selector or invalid calldata`);
    }
    if (abi.encodeFunctionData(decoded.functionFragment, decoded.args) !== transaction.data.toLowerCase()) {
      throw new Error(`${prefix}.data: non-canonical or trailing calldata`);
    }
    return decodedRow({
      to, contract, signature: decoded.signature as Upv4SafeFunction,
      args: Array.from(decoded.args), description: "",
    }, index, checked);
  });
}

export function assertUpv4SafeBatch(
  kind: Upv4SafeBatchKind, batch: Upv4SafeBatch, config: Upv4CutoverConfig, upv4Address: string,
): void {
  const calls = buildUpv4SafeCalls(kind, config, upv4Address);
  const rows = decodeUpv4SafeBatch(batch, config);
  const checked = validateConfig(config);
  const expected = calls.map((call, index) => decodedRow(call, index, checked));
  if (rows.length !== expected.length) {
    throw new Error(`call count: expected ${expected.length}, got ${rows.length}`);
  }
  for (let index = 0; index < expected.length; index++) {
    for (const field of Object.keys(expected[index]) as Array<keyof Upv4DecodedRow>) {
      if (JSON.stringify(rows[index][field]) !== JSON.stringify(expected[index][field])) {
        throw new Error(`transaction[${index}].${field}: expected ${JSON.stringify(expected[index][field])}, ` +
          `got ${JSON.stringify(rows[index][field])}`);
      }
    }
  }
}

export function buildUpv4ReleasePlan(): Upv4ReleasePlan {
  const config = validateConfig(baseCutoverConfig());
  return {
    pinnedBlock: UPV4_BASE_RELEASE.pinnedBlock, safe: config.safe,
    batches: Object.values(Upv4SafeBatchKind).map((kind) => {
      const rows = plannedCalls(kind, config, "UnifiedPaymentVerifierV4")
        .map((call, index) => decodedRow(call, index, config));
      return { kind, name: BATCH_NAMES[kind], callCount: rows.length, rows };
    }),
  };
}

export function formatUpv4PlanMarkdown(plan: Upv4ReleasePlan): string {
  return [`Pinned Base block: ${plan.pinnedBlock}. Safe: ${plan.safe}.`, ...plan.batches.map((batch) => [
    `### ${batch.name} (${batch.callCount} ${batch.callCount === 1 ? "call" : "calls"})`,
    "", "| # | target | function | args |", "| --- | --- | --- | --- |",
    ...batch.rows.map((row) => {
      const args = row.writer ?? [row.paymentMethod, row.verifier,
        row.currencies ? `${row.currencies.length} ${row.currencies.length === 1 ? "currency" : "currencies"}: ${row.currencies.join(", ")}` : undefined,
      ].filter((value) => value !== undefined).join("; ");
      return `| ${row.index} | ${row.contract} (${row.to}) | ${row.function} | ${args} |`;
    }),
  ].join("\n"))].join("\n\n") + "\n";
}
