import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { ethers } from "ethers";

import {
  NormalizedSafeBatchTransaction,
  SafeBatchTransactionInput,
  normalizeSafeTransactions,
} from "../deployments/safeBatchManifest";
import whitelistPolicyDeployment from "../deployments/base/WhitelistPolicyMethodScoped.json";
import {
  BASE_SAFE,
  MULTI_SEND_CALL_ONLY,
  MULTI_SEND_CALL_ONLY_RUNTIME_HASH,
  encodeMultiSendCalldata,
  packMultiSendTransactions,
} from "./simulate-dispute-opt-in-safe-batch";

export {
  BASE_SAFE,
  MULTI_SEND_CALL_ONLY,
  encodeMultiSendCalldata,
  packMultiSendTransactions,
};

export const BASE_CHAIN_ID = 8453;
export const DEFAULT_MAX_GAS = "30000000";
export const SAFE_TRANSACTION_SERVICE_URL =
  "https://api.safe.global/tx-service/base/api/v1";
export const SAFE_UI_BASE_URL = "https://app.safe.global/transactions/tx";
export const SAFE_SERVICE_TIMEOUT_MS = 30_000;

export const SAFE_TX_TYPES: Record<
  string,
  Array<{ name: string; type: string }>
> = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const safeInterface = new ethers.utils.Interface([
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
]);
const whitelistPolicyInterface = new ethers.utils.Interface(
  whitelistPolicyDeployment.abi
);

export type SafeTransaction = {
  to: string;
  value: string;
  data: string;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
};

export type PlannedSafeChunk = {
  calls: NormalizedSafeBatchTransaction[];
  estimatedGas: string;
  safeTx: SafeTransaction;
  safeTxHash: string;
};

export type TransactionBuilderBatch = {
  chainId: number;
  meta: Record<string, unknown>;
  transactions: NormalizedSafeBatchTransaction[];
};

export type CliOptions = {
  file: string;
  maxGas?: string;
  chunkCalls?: number;
  propose?: boolean;
  startNonce?: number;
  origin?: string;
};

type ProviderLike = {
  getNetwork?(): Promise<{ chainId: number }>;
  getCode(address: string): Promise<string>;
  call(transaction: { to: string; data: string }): Promise<string>;
  estimateGas(transaction: {
    from: string;
    to: string;
    data: string;
  }): Promise<ethers.BigNumber>;
};

type FetchResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

type FetchRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

type FetchLike = (
  url: string,
  init?: FetchRequestInit
) => Promise<FetchResponseLike>;

export type RunDependencies = {
  provider?: ProviderLike;
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  multiSendRuntimeHash?: string;
  log?: (message: string) => void;
};

type QueuedSafeTransaction = {
  nonce: number;
  safeTxHash?: string;
};

type ServiceSafe = {
  nonce: number;
  owners: string[];
  threshold: number;
};

function requireNonnegativeInteger(value: unknown, label: string): number {
  const normalized =
    typeof value === "string" && value !== "" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(normalized);
}

function requirePositiveInteger(value: unknown, label: string): number {
  const normalized = requireNonnegativeInteger(value, label);
  if (normalized === 0) throw new Error(`${label} must be greater than zero`);
  return normalized;
}

function parsePositiveBigNumber(
  value: string,
  label: string
): ethers.BigNumber {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return ethers.BigNumber.from(value);
}

function normalizeBuilderTransaction(
  value: unknown,
  index: number
): NormalizedSafeBatchTransaction {
  if (!value || typeof value !== "object") {
    throw new Error(`Transaction ${index} must be an object`);
  }
  const transaction = value as Record<string, unknown>;
  if (
    typeof transaction.to !== "string" ||
    !ethers.utils.isAddress(transaction.to)
  ) {
    throw new Error(`Transaction ${index} has an invalid target`);
  }
  if (transaction.value !== "0") {
    throw new Error(`Transaction ${index} must have value 0`);
  }
  if (
    typeof transaction.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.data)
  ) {
    throw new Error(`Transaction ${index} has invalid calldata`);
  }
  const operation =
    transaction.operation === undefined ? 0 : transaction.operation;
  if (operation !== 0 && operation !== "0") {
    throw new Error(`Transaction ${index} must have operation 0`);
  }
  return normalizeSafeTransactions([
    {
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
      operation: 0,
    },
  ])[0];
}

export function loadTransactionBuilderFile(
  file: string
): TransactionBuilderBatch {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Transaction Builder JSON: ${message}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error("Transaction Builder JSON must be an object");
  }
  const batch = value as Record<string, unknown>;
  if (String(batch.chainId) !== String(BASE_CHAIN_ID)) {
    throw new Error(`Transaction Builder chainId ${BASE_CHAIN_ID} is required`);
  }
  if (!Array.isArray(batch.transactions) || batch.transactions.length === 0) {
    throw new Error("Transaction Builder JSON must contain transactions");
  }
  const meta = batch.meta;
  if (
    meta !== undefined &&
    (!meta || typeof meta !== "object" || Array.isArray(meta))
  ) {
    throw new Error("Transaction Builder meta must be an object");
  }
  const normalizedMeta = (meta || {}) as Record<string, unknown>;
  const createdFromSafeAddress = normalizedMeta.createdFromSafeAddress;
  if (
    createdFromSafeAddress !== undefined &&
    (typeof createdFromSafeAddress !== "string" ||
      !ethers.utils.isAddress(createdFromSafeAddress) ||
      createdFromSafeAddress.toLowerCase() !== BASE_SAFE.toLowerCase())
  ) {
    throw new Error(
      "Transaction Builder was not created from the pinned Base Safe"
    );
  }
  return {
    chainId: BASE_CHAIN_ID,
    meta: normalizedMeta,
    transactions: batch.transactions.map(normalizeBuilderTransaction),
  };
}

export function buildSafeTransaction(
  calls: readonly SafeBatchTransactionInput[],
  nonce: number
): SafeTransaction {
  requireNonnegativeInteger(nonce, "Safe transaction nonce");
  return {
    to: MULTI_SEND_CALL_ONLY,
    value: "0",
    data: encodeMultiSendCalldata(calls),
    operation: 1,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ethers.constants.AddressZero,
    refundReceiver: ethers.constants.AddressZero,
    nonce,
  };
}

export function safeTransactionHash(safeTx: SafeTransaction): string {
  return ethers.utils._TypedDataEncoder.hash(
    { chainId: BASE_CHAIN_ID, verifyingContract: BASE_SAFE },
    SAFE_TX_TYPES,
    safeTx
  );
}

function extractRevertData(error: any): string | undefined {
  const candidates = [
    error?.data?.data,
    error?.data,
    error?.error?.data,
    error?.error?.error?.data,
    error?.body,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (/^0x[0-9a-fA-F]+$/.test(candidate)) return candidate;
    try {
      const parsed = JSON.parse(candidate);
      const nested = extractRevertData(parsed);
      if (nested) return nested;
    } catch {
      // The candidate was not a JSON-wrapped RPC error.
    }
  }
  return undefined;
}

function formatDecodedError(data: string): string | undefined {
  try {
    const decoded = whitelistPolicyInterface.parseError(data);
    const argumentsText = decoded.args
      .map((argument: unknown) => String(argument))
      .join(", ");
    return `${decoded.name}(${argumentsText})`;
  } catch {
    // Fall through to Solidity's built-in errors.
  }
  try {
    if (data.startsWith("0x08c379a0")) {
      const [reason] = ethers.utils.defaultAbiCoder.decode(
        ["string"],
        `0x${data.slice(10)}`
      );
      return `Error(${reason})`;
    }
    if (data.startsWith("0x4e487b71")) {
      const [code] = ethers.utils.defaultAbiCoder.decode(
        ["uint256"],
        `0x${data.slice(10)}`
      );
      return `Panic(${code.toString()})`;
    }
  } catch {
    // Return the raw provider message when built-in error decoding fails.
  }
  return undefined;
}

function formatEstimateError(error: unknown): string {
  const revertData = extractRevertData(error);
  const decoded = revertData ? formatDecodedError(revertData) : undefined;
  if (decoded) return decoded;
  return error instanceof Error ? error.message : String(error);
}

async function estimateChunkGas(
  provider: ProviderLike,
  calls: readonly SafeBatchTransactionInput[]
): Promise<ethers.BigNumber> {
  try {
    return await provider.estimateGas({
      from: BASE_SAFE,
      to: MULTI_SEND_CALL_ONLY,
      data: encodeMultiSendCalldata(calls),
    });
  } catch (error) {
    throw new Error(
      `MultiSend simulation reverted: ${formatEstimateError(error)}`
    );
  }
}

export async function planSafeBatchChunks(
  transactions: readonly SafeBatchTransactionInput[],
  provider: ProviderLike,
  options: {
    maxGas: ethers.BigNumber;
    chunkCalls?: number;
    startNonce: number;
  }
): Promise<PlannedSafeChunk[]> {
  if (transactions.length === 0)
    throw new Error("Cannot chunk an empty transaction list");
  if (options.maxGas.lte(0))
    throw new Error("maxGas must be greater than zero");
  if (options.chunkCalls !== undefined)
    requirePositiveInteger(options.chunkCalls, "chunkCalls");
  requireNonnegativeInteger(options.startNonce, "startNonce");

  const normalized = normalizeSafeTransactions(transactions);
  const chunks: Array<{
    calls: NormalizedSafeBatchTransaction[];
    estimatedGas: ethers.BigNumber;
  }> = [];
  let current: NormalizedSafeBatchTransaction[] = [];
  let currentGas: ethers.BigNumber | undefined;

  const finishCurrent = () => {
    if (current.length === 0 || currentGas === undefined) return;
    chunks.push({ calls: current, estimatedGas: currentGas });
    current = [];
    currentGas = undefined;
  };

  for (const transaction of normalized) {
    if (
      options.chunkCalls !== undefined &&
      current.length >= options.chunkCalls
    ) {
      finishCurrent();
    }
    const candidate = [...current, transaction];
    const candidateGas = await estimateChunkGas(provider, candidate);
    if (candidateGas.gt(options.maxGas)) {
      if (current.length === 0) {
        throw new Error(
          `A single call requires ${candidateGas.toString()} gas, exceeding max-gas ${options.maxGas.toString()}`
        );
      }
      finishCurrent();
      const singleGas = await estimateChunkGas(provider, [transaction]);
      if (singleGas.gt(options.maxGas)) {
        throw new Error(
          `A single call requires ${singleGas.toString()} gas, exceeding max-gas ${options.maxGas.toString()}`
        );
      }
      current = [transaction];
      currentGas = singleGas;
      continue;
    }
    current = candidate;
    currentGas = candidateGas;
  }
  finishCurrent();

  return chunks.map(({ calls, estimatedGas }, index) => {
    const safeTx = buildSafeTransaction(calls, options.startNonce + index);
    return {
      calls,
      estimatedGas: estimatedGas.toString(),
      safeTx,
      safeTxHash: safeTransactionHash(safeTx),
    };
  });
}

function normalizeQueuedTransactions(value: unknown): QueuedSafeTransaction[] {
  if (!Array.isArray(value))
    throw new Error("Safe queue response did not contain results");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Safe queue entry ${index} is invalid`);
    }
    const transaction = entry as Record<string, unknown>;
    return {
      nonce: requireNonnegativeInteger(
        transaction.nonce,
        `Safe queue nonce ${index}`
      ),
      safeTxHash:
        typeof transaction.safeTxHash === "string"
          ? transaction.safeTxHash
          : undefined,
    };
  });
}

export function selectStartNonce(
  onChainNonce: number,
  queuedTransactions: readonly Pick<QueuedSafeTransaction, "nonce">[],
  explicitStartNonce?: number
): number {
  requireNonnegativeInteger(onChainNonce, "on-chain nonce");
  if (explicitStartNonce !== undefined) {
    const explicit = requireNonnegativeInteger(
      explicitStartNonce,
      "start nonce"
    );
    if (explicit < onChainNonce) {
      throw new Error(
        `start nonce ${explicit} is below on-chain nonce ${onChainNonce}`
      );
    }
    return explicit;
  }
  const nonStale = queuedTransactions
    .map(({ nonce }) => requireNonnegativeInteger(nonce, "queued nonce"))
    .filter((nonce) => nonce >= onChainNonce);
  return nonStale.length === 0
    ? onChainNonce
    : requireNonnegativeInteger(Math.max(...nonStale) + 1, "next queued nonce");
}

async function requestJson(
  fetchImplementation: FetchLike,
  url: string,
  init?: FetchRequestInit
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SAFE_SERVICE_TIMEOUT_MS);
  let response: FetchResponseLike;
  let body: string;
  try {
    response = await fetchImplementation(url, {
      ...init,
      signal: controller.signal,
    });
    body = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Safe Transaction Service request timed out after ${SAFE_SERVICE_TIMEOUT_MS}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(
      `Safe Transaction Service returned ${response.status}: ${body}`
    );
  }
  try {
    return body === "" ? {} : JSON.parse(body);
  } catch {
    throw new Error(
      `Safe Transaction Service returned invalid JSON (${response.status})`
    );
  }
}

async function getPaginatedResults(
  fetchImplementation: FetchLike,
  initialUrl: string
): Promise<unknown[]> {
  const results: unknown[] = [];
  let url: string | null = initialUrl;
  while (url) {
    const page = (await requestJson(fetchImplementation, url)) as Record<
      string,
      unknown
    >;
    if (!Array.isArray(page.results)) {
      throw new Error("Safe Transaction Service page did not contain results");
    }
    results.push(...page.results);
    if (
      page.next !== null &&
      page.next !== undefined &&
      typeof page.next !== "string"
    ) {
      throw new Error("Safe Transaction Service page has an invalid next URL");
    }
    url = (page.next as string | null | undefined) || null;
  }
  return results;
}

async function readServiceSafe(
  fetchImplementation: FetchLike,
  serviceUrl: string
): Promise<ServiceSafe> {
  const value = (await requestJson(
    fetchImplementation,
    `${serviceUrl}/safes/${BASE_SAFE}/`
  )) as Record<string, unknown>;
  if (
    !Array.isArray(value.owners) ||
    value.owners.some((owner) => typeof owner !== "string")
  ) {
    throw new Error("Safe Transaction Service returned invalid owners");
  }
  return {
    nonce: requireNonnegativeInteger(value.nonce, "Safe service nonce"),
    owners: value.owners as string[],
    threshold: requirePositiveInteger(value.threshold, "Safe threshold"),
  };
}

async function verifyOnChain(
  provider: ProviderLike,
  expectedMultiSendRuntimeHash: string
): Promise<number> {
  const [network, versionResult, nonceResult, multiSendCode] =
    await Promise.all([
      provider.getNetwork
        ? provider.getNetwork()
        : Promise.resolve({ chainId: BASE_CHAIN_ID }),
      provider.call({
        to: BASE_SAFE,
        data: safeInterface.getSighash("VERSION"),
      }),
      provider.call({ to: BASE_SAFE, data: safeInterface.getSighash("nonce") }),
      provider.getCode(MULTI_SEND_CALL_ONLY),
    ]);
  if (network.chainId !== BASE_CHAIN_ID) {
    throw new Error(`RPC chain id must be ${BASE_CHAIN_ID}`);
  }
  const [version] = safeInterface.decodeFunctionResult(
    "VERSION",
    versionResult
  );
  if (version !== "1.3.0")
    throw new Error(`Unsupported Safe version ${version}`);
  if (
    multiSendCode === "0x" ||
    ethers.utils.keccak256(multiSendCode).toLowerCase() !==
      expectedMultiSendRuntimeHash.toLowerCase()
  ) {
    throw new Error("MultiSendCallOnly runtime bytecode hash mismatch");
  }
  const [nonce] = safeInterface.decodeFunctionResult("nonce", nonceResult);
  if (
    !ethers.BigNumber.isBigNumber(nonce) ||
    nonce.gt(String(Number.MAX_SAFE_INTEGER))
  ) {
    throw new Error("Safe nonce is outside the supported range");
  }
  return nonce.toNumber();
}

function normalizeDelegateAddress(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  for (const key of ["delegate", "delegateAddress"]) {
    if (
      typeof entry[key] === "string" &&
      ethers.utils.isAddress(entry[key] as string)
    ) {
      return (entry[key] as string).toLowerCase();
    }
  }
  return undefined;
}

async function assertAuthorizedProposer(
  fetchImplementation: FetchLike,
  serviceUrl: string,
  owners: readonly string[],
  proposerAddress: string
): Promise<void> {
  if (
    owners.some(
      (owner) => owner.toLowerCase() === proposerAddress.toLowerCase()
    )
  )
    return;
  const v2BaseUrl = serviceUrl.replace(/\/api\/v1\/?$/, "/api/v2");
  const delegates = await getPaginatedResults(
    fetchImplementation,
    `${v2BaseUrl}/delegates/?safe=${encodeURIComponent(BASE_SAFE)}`
  );
  if (
    !delegates.some(
      (delegate) =>
        normalizeDelegateAddress(delegate) === proposerAddress.toLowerCase()
    )
  ) {
    throw new Error(
      `${proposerAddress} is neither a Safe owner nor a registered delegate`
    );
  }
}

function describeInnerCall(
  transaction: NormalizedSafeBatchTransaction
): string {
  return `${transaction.data.slice(0, 10)}@${transaction.to}`;
}

function sidecarPayload(
  inputFile: string,
  maxGas: ethers.BigNumber,
  chunks: readonly PlannedSafeChunk[]
) {
  return {
    version: 1,
    chainId: BASE_CHAIN_ID,
    safe: BASE_SAFE,
    sourceFile: resolve(inputFile),
    maxGas: maxGas.toString(),
    chunks: chunks.map(({ calls, estimatedGas, safeTx, safeTxHash }) => ({
      safeTx,
      safeTxHash,
      estimatedGas,
      callCount: calls.length,
      firstCall: describeInnerCall(calls[0]),
      lastCall: describeInnerCall(calls[calls.length - 1]),
    })),
  };
}

function safeUiLink(safeTxHash: string): string {
  return `${SAFE_UI_BASE_URL}?safe=base:${BASE_SAFE}&id=multisig_${BASE_SAFE}_${safeTxHash}`;
}

export async function runProposeSafeBatchChunks(
  options: CliOptions,
  dependencies: RunDependencies = {}
): Promise<{
  chunks: PlannedSafeChunk[];
  sidecarFile: string;
  proposedLinks: string[];
}> {
  const env = dependencies.env || process.env;
  const log = dependencies.log || console.log;
  const maxGas = parsePositiveBigNumber(
    options.maxGas || DEFAULT_MAX_GAS,
    "max-gas"
  );
  const chunkCalls =
    options.chunkCalls === undefined
      ? undefined
      : requirePositiveInteger(options.chunkCalls, "chunk-calls");
  const batch = loadTransactionBuilderFile(options.file);
  const privateKey =
    env.SAFE_PROPOSER_PRIVATE_KEY?.trim() ||
    env.BASE_DEPLOY_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error(
      "SAFE_PROPOSER_PRIVATE_KEY or BASE_DEPLOY_PRIVATE_KEY is required"
    );
  }
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(privateKey);
  } catch {
    throw new Error("Safe proposer private key is invalid");
  }
  const rpcUrl =
    env.SAFE_RPC_URL?.trim() ||
    (env.ALCHEMY_API_KEY?.trim()
      ? `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY.trim()}`
      : undefined);
  if (!dependencies.provider && !rpcUrl) {
    throw new Error("SAFE_RPC_URL or ALCHEMY_API_KEY is required");
  }
  const provider: ProviderLike =
    dependencies.provider || new ethers.providers.JsonRpcProvider(rpcUrl!);
  const fetchImplementation =
    dependencies.fetch || ((globalThis as any).fetch as FetchLike | undefined);
  if (!fetchImplementation)
    throw new Error("A fetch implementation is required");

  const serviceUrl = SAFE_TRANSACTION_SERVICE_URL;
  const [onChainNonce, serviceSafe, queuedValues] = await Promise.all([
    verifyOnChain(
      provider,
      dependencies.multiSendRuntimeHash || MULTI_SEND_CALL_ONLY_RUNTIME_HASH
    ),
    readServiceSafe(fetchImplementation, serviceUrl),
    getPaginatedResults(
      fetchImplementation,
      `${serviceUrl}/safes/${BASE_SAFE}/multisig-transactions/?executed=false`
    ),
  ]);
  if (serviceSafe.nonce !== onChainNonce) {
    throw new Error(
      `Safe Transaction Service nonce ${serviceSafe.nonce} does not match on-chain nonce ${onChainNonce}`
    );
  }
  await assertAuthorizedProposer(
    fetchImplementation,
    serviceUrl,
    serviceSafe.owners,
    wallet.address
  );
  const queuedTransactions = normalizeQueuedTransactions(queuedValues);
  const startNonce = selectStartNonce(
    onChainNonce,
    queuedTransactions,
    options.startNonce
  );
  const chunks = await planSafeBatchChunks(batch.transactions, provider, {
    maxGas,
    chunkCalls,
    startNonce,
  });

  log(
    `Planned ${chunks.length} Safe MultiSend chunk${
      chunks.length === 1 ? "" : "s"
    }.`
  );
  chunks.forEach((chunk, index) => {
    log(
      `Chunk ${index + 1}: nonce=${chunk.safeTx.nonce} calls=${
        chunk.calls.length
      } ` +
        `estimatedGas=${chunk.estimatedGas} safeTxHash=${chunk.safeTxHash} ` +
        `first=${describeInnerCall(chunk.calls[0])} ` +
        `last=${describeInnerCall(chunk.calls[chunk.calls.length - 1])}`
    );
  });
  const sidecarFile = `${resolve(options.file)}.chunks.json`;
  writeFileSync(
    sidecarFile,
    `${JSON.stringify(
      sidecarPayload(options.file, maxGas, chunks),
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  log(`Wrote chunk plan to ${sidecarFile}`);

  const proposedLinks: string[] = [];
  if (!options.propose) {
    log("Dry-run only; pass --propose to submit these chunks.");
    return { chunks, sidecarFile, proposedLinks };
  }

  const queuedHashes = new Set(
    queuedTransactions
      .map(({ safeTxHash }) => safeTxHash?.toLowerCase())
      .filter((hash): hash is string => hash !== undefined)
  );
  for (const chunk of chunks) {
    if (queuedHashes.has(chunk.safeTxHash.toLowerCase())) {
      throw new Error(`Safe transaction ${chunk.safeTxHash} is already queued`);
    }
  }

  for (const chunk of chunks) {
    const signature = await wallet._signTypedData(
      { chainId: BASE_CHAIN_ID, verifyingContract: BASE_SAFE },
      SAFE_TX_TYPES,
      chunk.safeTx
    );
    const body = {
      ...chunk.safeTx,
      contractTransactionHash: chunk.safeTxHash,
      sender: wallet.address,
      signature,
      origin: options.origin || "ZKP2P gas-bounded MultiSend chunks",
    };
    await requestJson(
      fetchImplementation,
      `${serviceUrl}/safes/${BASE_SAFE}/multisig-transactions/`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const link = safeUiLink(chunk.safeTxHash);
    proposedLinks.push(link);
    log(`Proposed nonce ${chunk.safeTx.nonce}: ${link}`);
  }
  return { chunks, sidecarFile, proposedLinks };
}

export function parseCliArguments(argv: readonly string[]): CliOptions {
  const options: CliOptions = { file: "", propose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--propose") {
      options.propose = true;
      continue;
    }
    if (
      argument !== "--file" &&
      argument !== "--max-gas" &&
      argument !== "--chunk-calls" &&
      argument !== "--start-nonce" &&
      argument !== "--origin"
    ) {
      throw new Error(`Unknown argument ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--file") options.file = value;
    if (argument === "--max-gas") options.maxGas = value;
    if (argument === "--chunk-calls") {
      options.chunkCalls = requirePositiveInteger(value, "chunk-calls");
    }
    if (argument === "--start-nonce") {
      options.startNonce = requireNonnegativeInteger(value, "start-nonce");
    }
    if (argument === "--origin") options.origin = value;
  }
  if (!options.file)
    throw new Error("--file <transaction-builder.json> is required");
  return options;
}

async function main(): Promise<void> {
  await runProposeSafeBatchChunks(parseCliArguments(process.argv.slice(2)));
}

function sanitizeCliError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [
    process.env.SAFE_PROPOSER_PRIVATE_KEY,
    process.env.BASE_DEPLOY_PRIVATE_KEY,
    process.env.ALCHEMY_API_KEY,
    process.env.SAFE_RPC_URL,
  ]) {
    if (secret && secret.length >= 4)
      message = message.split(secret).join("[redacted]");
  }
  return message;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(sanitizeCliError(error));
    process.exitCode = 1;
  });
}
