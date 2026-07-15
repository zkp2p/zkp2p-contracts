import fs from "fs";
import os from "os";
import path from "path";

import { JsonFragment } from "@ethersproject/abi";
import { BigNumber, Contract, ContractReceipt, Wallet, ethers } from "ethers";

import {
  ADDRESSES,
  EXPECTED_CHAIN_ID,
  EXPECTED_GOVERNANCE,
  PAYMENT_METHODS,
  actorAddresses,
  ceilDiv,
  deployer,
  loadActors,
  loadEnvironment,
  normalize,
  printJson,
  requireMutationFlag,
  rpcUrl,
} from "./affineRiskE2E";

const ZERO = ethers.constants.AddressZero;
const USD = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
const PRECISE_ONE = ethers.constants.WeiPerEther;
const RUN_ROOT = path.join(os.tmpdir(), "zkp2p-affine-risk-e2e");
const STATE_FILE =
  process.env.E2E_RUN_STATE || path.join(RUN_ROOT, "run-state.json");
const EVIDENCE_ROOT =
  process.env.E2E_EVIDENCE_DIR ||
  path.resolve(__dirname, "../../docs/staging/evidence/affine-risk-run");
const INDEXER_TIMEOUT_MS = Number(
  process.env.E2E_INDEXER_TIMEOUT_MS || "55000"
);
const INDEXER_POLL_MS = Number(process.env.E2E_INDEXER_POLL_MS || "3000");
const RECEIPT_TIMEOUT_MS = Number(
  process.env.E2E_RECEIPT_TIMEOUT_MS || "55000"
);

const TARGET_FUNDING = {
  ownerA: { native: "180000000000000", usdc: "8000000" },
  ownerB: { native: "180000000000000", usdc: "1000000" },
  takerA1: { native: "180000000000000", usdc: "0" },
  takerA2: { native: "180000000000000", usdc: "0" },
  takerB: { native: "180000000000000", usdc: "0" },
  lpA: { native: "250000000000000", usdc: "40000000" },
  lpB: { native: "220000000000000", usdc: "5000000" },
  recipient: { native: "180000000000000", usdc: "0" },
  unauthorized: { native: "120000000000000", usdc: "0" },
  caller: { native: "180000000000000", usdc: "0" },
} as const;

const ARTIFACTS = {
  risk: "out/RiskManager.sol/RiskManager.json",
  vault: "out/StakeVault.sol/StakeVault.json",
  orchestrator: "out/OrchestratorV3.sol/OrchestratorV3.json",
  escrow: "out/EscrowV2.sol/EscrowV2.json",
  hook: "out/DeferredPayoutHook.sol/DeferredPayoutHook.json",
} as const;

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

type Json = Record<string, unknown>;
type IntentName =
  | "freeLong"
  | "oversizeBonded"
  | "freeExact"
  | "freeReleased"
  | "freeWhileExiting"
  | "bondedLong"
  | "chargebackCancelled"
  | "chargebackSettled"
  | "deferredSettled";

type RunState = {
  version: 1;
  createdAt: string;
  deposits: Record<string, string>;
  intents: Partial<Record<IntentName, string>>;
  transactions: Record<string, Json>;
  expectedReverts: Record<string, Json>;
};

type LoadedContracts = {
  risk: Contract;
  vault: Contract;
  orchestrator: Contract;
  escrow: Contract;
  hook: Contract;
  token: Contract;
  interfaces: Record<string, ethers.utils.Interface>;
};

function ensurePrivateDirectory(): void {
  fs.mkdirSync(RUN_ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(RUN_ROOT, 0o700);
}

function newState(): RunState {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    deposits: {},
    intents: {},
    transactions: {},
    expectedReverts: {},
  };
}

function loadState(): RunState {
  ensurePrivateDirectory();
  if (!fs.existsSync(STATE_FILE)) {
    const state = newState();
    saveState(state);
    return state;
  }
  const stat = fs.statSync(STATE_FILE);
  if ((stat.mode & 0o077) !== 0)
    throw new Error("Run state permissions must be 0600");
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RunState;
}

function saveState(state: RunState): void {
  ensurePrivateDirectory();
  const temporary = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
  fs.chmodSync(STATE_FILE, 0o600);
}

function artifactPath(relative: string): string {
  return path.resolve(__dirname, "../..", relative);
}

function loadArtifact(relative: string): { abi: JsonFragment[] } {
  const absolute = artifactPath(relative);
  if (!fs.existsSync(absolute)) {
    throw new Error(
      `Missing ${relative}; run forge build in this worktree before scenario execution`
    );
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8")) as {
    abi: JsonFragment[];
  };
}

function loadContracts(
  provider: ethers.providers.JsonRpcProvider
): LoadedContracts {
  const interfaces = Object.fromEntries(
    Object.entries(ARTIFACTS).map(([name, artifact]) => [
      name,
      new ethers.utils.Interface(loadArtifact(artifact).abi),
    ])
  );
  return {
    risk: new Contract(ADDRESSES.riskManager, interfaces.risk, provider),
    vault: new Contract(ADDRESSES.stakeVault, interfaces.vault, provider),
    orchestrator: new Contract(
      ADDRESSES.orchestratorV3,
      interfaces.orchestrator,
      provider
    ),
    escrow: new Contract(ADDRESSES.escrowV2, interfaces.escrow, provider),
    hook: new Contract(ADDRESSES.deferredPayoutHook, interfaces.hook, provider),
    token: new Contract(ADDRESSES.usdc, TOKEN_ABI, provider),
    interfaces,
  };
}

function redact(input: unknown): string {
  let output = input instanceof Error ? input.message : String(input);
  const secrets = [
    process.env.BASE_DEPLOY_PRIVATE_KEY,
    process.env.E2E_INDEXER_URL,
    process.env.E2E_RPC_URL,
    process.env.INFURA_TOKEN,
  ].filter((value): value is string => Boolean(value));
  for (const secret of secrets)
    output = output.split(secret).join("[REDACTED]");
  output = output.replace(/https?:\/\/[^\s"']+/g, "[REDACTED_URL]");
  output = output.replace(/0x[0-9a-fA-F]{128,}/g, "[REDACTED_HEX_PAYLOAD]");
  return output.slice(0, 4_000);
}

const SAFE_BROADCAST_ERROR_CODES = new Set([
  "ACTION_REJECTED",
  "INSUFFICIENT_FUNDS",
  "NETWORK_ERROR",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
  "SERVER_ERROR",
  "TIMEOUT",
  "TRANSACTION_REPLACED",
  "UNKNOWN_ERROR",
  "-32000",
  "-32001",
  "-32603",
]);

function safeBroadcastError(error: unknown, rawTransaction: string): Json {
  const candidate =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const nested =
    candidate.error && typeof candidate.error === "object"
      ? (candidate.error as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const observedCode = String(candidate.code ?? nested.code ?? "UNKNOWN_ERROR");
  const code = SAFE_BROADCAST_ERROR_CODES.has(observedCode)
    ? observedCode
    : "UNKNOWN_ERROR";
  const observedReason = String(
    candidate.reason ??
      nested.reason ??
      nested.message ??
      candidate.message ??
      "raw transaction broadcast failed"
  );
  const withoutExactPayload = observedReason
    .split(rawTransaction)
    .join("[REDACTED_SIGNED_TRANSACTION]");
  return {
    code,
    reason: redact(withoutExactPayload).slice(0, 500),
  };
}

function evidenceFile(label: string): string {
  return path.join(
    EVIDENCE_ROOT,
    `${label.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`
  );
}

function writeEvidence(label: string, evidence: unknown): void {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.writeFileSync(
    evidenceFile(label),
    `${JSON.stringify(normalize(evidence), null, 2)}\n`,
    "utf8"
  );
}

function sanitizeTransactionEvidence(value: unknown): unknown {
  if (BigNumber.isBigNumber(value)) return value;
  if (typeof value === "string")
    return value.replace(/0x[0-9a-fA-F]{128,}/g, "[REDACTED_HEX_PAYLOAD]");
  if (Array.isArray(value)) return value.map(sanitizeTransactionEvidence);
  if (value && typeof value === "object") {
    const sanitized: Json = {};
    for (const [key, child] of Object.entries(value as Json)) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey === "rawtransaction" ||
        normalizedKey === "signedtransaction"
      ) {
        continue;
      }
      sanitized[key] = sanitizeTransactionEvidence(child);
    }
    return sanitized;
  }
  return value;
}

function writeTransactionEvidence(label: string, record: Json): void {
  writeEvidence(label, sanitizeTransactionEvidence(record));
}

async function prepareSignedTransaction(
  signer: Wallet,
  request: ethers.providers.TransactionRequest
): Promise<{ rawTransaction: string; journal: Json }> {
  if (!signer.provider)
    throw new Error("Transaction signer is missing an RPC provider");
  const [latestBlock, rpcGasPrice] = await Promise.all([
    signer.provider.getBlock("latest"),
    signer.provider.getGasPrice(),
  ]);
  if (!latestBlock?.baseFeePerGas)
    throw new Error("Base RPC did not return an EIP-1559 base fee");

  const baseFee = latestBlock.baseFeePerGas;
  const minimumTip = BigNumber.from(
    process.env.E2E_MIN_PRIORITY_FEE_PER_GAS_WEI || "1000000"
  );
  const maximumAutomaticTip = BigNumber.from(
    process.env.E2E_MAX_AUTOMATIC_PRIORITY_FEE_PER_GAS_WEI || "5000000"
  );
  const suggestedTip = rpcGasPrice.gt(baseFee)
    ? rpcGasPrice.sub(baseFee)
    : minimumTip;
  const automaticTip = suggestedTip.gt(minimumTip) ? suggestedTip : minimumTip;
  if (
    !process.env.E2E_PRIORITY_FEE_PER_GAS_WEI &&
    automaticTip.gt(maximumAutomaticTip)
  ) {
    throw new Error(
      `RPC priority fee ${automaticTip.toString()} exceeds automatic safety cap ${maximumAutomaticTip.toString()}; set E2E_PRIORITY_FEE_PER_GAS_WEI only after operator review`
    );
  }
  const priorityFee = process.env.E2E_PRIORITY_FEE_PER_GAS_WEI
    ? BigNumber.from(process.env.E2E_PRIORITY_FEE_PER_GAS_WEI)
    : automaticTip;
  const maxFee = process.env.E2E_MAX_FEE_PER_GAS_WEI
    ? BigNumber.from(process.env.E2E_MAX_FEE_PER_GAS_WEI)
    : baseFee.mul(2).add(priorityFee);
  const absoluteMaxFee = BigNumber.from(
    process.env.E2E_ABSOLUTE_MAX_FEE_PER_GAS_WEI || "100000000"
  );
  if (maxFee.lt(baseFee.add(priorityFee)))
    throw new Error("Configured max fee does not cover base fee plus priority");
  if (maxFee.gt(absoluteMaxFee)) {
    throw new Error(
      `Max fee ${maxFee.toString()} exceeds safety cap ${absoluteMaxFee.toString()}`
    );
  }

  const eip1559Request = { ...request };
  delete eip1559Request.gasPrice;
  eip1559Request.type = 2;
  eip1559Request.maxPriorityFeePerGas = priorityFee;
  eip1559Request.maxFeePerGas = maxFee;
  const populated = await signer.populateTransaction(eip1559Request);
  if (populated.nonce === undefined)
    throw new Error("Populated transaction is missing an explicit nonce");
  if (populated.chainId === undefined)
    throw new Error("Populated transaction is missing an explicit chain id");
  if (!populated.gasLimit)
    throw new Error("Populated transaction is missing an explicit gas limit");
  if (
    populated.gasPrice === undefined &&
    (populated.maxFeePerGas === undefined ||
      populated.maxPriorityFeePerGas === undefined)
  ) {
    throw new Error("Populated transaction is missing explicit fee fields");
  }
  assertEqual(populated.chainId, EXPECTED_CHAIN_ID, "signed transaction chain");
  const rawTransaction = await signer.signTransaction(populated);
  const transactionHash = ethers.utils.keccak256(rawTransaction);
  return {
    rawTransaction,
    journal: {
      transactionHash,
      nonce: populated.nonce,
      chainId: populated.chainId,
      type: populated.type,
      to: populated.to,
      value: populated.value || 0,
      dataHash: ethers.utils.keccak256(populated.data || "0x"),
      gasLimit: populated.gasLimit,
      gasPrice: populated.gasPrice,
      maxFeePerGas: populated.maxFeePerGas,
      maxPriorityFeePerGas: populated.maxPriorityFeePerGas,
    },
  };
}

function decodeLogs(
  receipt: ContractReceipt,
  contracts: LoadedContracts
): Json[] {
  const sourceByAddress: Record<string, keyof LoadedContracts["interfaces"]> = {
    [ADDRESSES.riskManager.toLowerCase()]: "risk",
    [ADDRESSES.stakeVault.toLowerCase()]: "vault",
    [ADDRESSES.orchestratorV3.toLowerCase()]: "orchestrator",
    [ADDRESSES.escrowV2.toLowerCase()]: "escrow",
    [ADDRESSES.deferredPayoutHook.toLowerCase()]: "hook",
  };
  return receipt.logs.map((log) => {
    const source = sourceByAddress[log.address.toLowerCase()];
    if (source) {
      try {
        const parsed = contracts.interfaces[source].parseLog(log);
        return {
          source,
          address: log.address,
          logIndex: log.logIndex,
          event: parsed.name,
          signature: parsed.signature,
          args: parsed.args,
        };
      } catch {
        // The address is known, but this event is not present in the selected ABI.
      }
    }
    return {
      source: "unknown",
      address: log.address,
      logIndex: log.logIndex,
      topics: log.topics,
      data: log.data,
    };
  });
}

const RAW_EVENT_PREFIX: Record<string, string> = {
  risk: "RiskManager",
  vault: "StakeVault",
  orchestrator: "OrchestratorV3",
  escrow: "EscrowV2",
  hook: "DeferredPayoutHook",
};

// EscrowV2 delegates inherited lifecycle events to the V2.1 handlers, which
// intentionally retain the Escrow_V21 raw-audit entity namespace.
const ESCROW_V21_AUDIT_EVENTS = new Set([
  "DepositReceived",
  "DepositDelegateSet",
  "DepositDelegateRemoved",
  "DepositFundsAdded",
  "DepositWithdrawn",
  "DepositClosed",
  "DepositPaymentMethodAdded",
  "DepositPaymentMethodActiveUpdated",
  "DepositCurrencyAdded",
  "FundsLocked",
  "FundsUnlocked",
  "FundsUnlockedAndTransferred",
  "IntentExpiryExtended",
  "DepositIntentAmountRangeUpdated",
  "DepositMinConversionRateUpdated",
  "DepositAcceptingIntentsUpdated",
]);

function normalizeEventValue(value: unknown): unknown {
  if (BigNumber.isBigNumber(value)) return value.toString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    const namedEntries = Object.entries(value).filter(
      ([key]) => !/^\d+$/.test(key)
    );
    if (namedEntries.length > 0) {
      return Object.fromEntries(
        namedEntries.map(([key, child]) => [key, normalizeEventValue(child)])
      );
    }
    return value.map(normalizeEventValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/^\d+$/.test(key))
        .map(([key, child]) => [key, normalizeEventValue(child)])
    );
  }
  return value;
}

function rawEventExpectation(
  log: Json
): { entity: string; fields: string[]; expected: Json } | undefined {
  const eventName = String(log.event);
  const prefix =
    log.source === "escrow" && ESCROW_V21_AUDIT_EVENTS.has(eventName)
      ? "Escrow_V21"
      : RAW_EVENT_PREFIX[String(log.source)];
  if (!prefix || !log.event) return undefined;
  const expected = normalizeEventValue(log.args) as Json;
  if (
    log.event === "DepositReceived" ||
    log.event === "DepositIntentAmountRangeUpdated"
  ) {
    const range = expected.intentAmountRange as Json | undefined;
    delete expected.intentAmountRange;
    if (range) {
      expected.intentAmountRange_0 = range.min;
      expected.intentAmountRange_1 = range.max;
    }
  }
  if (
    log.event === "DepositPaymentMethodAdded" &&
    expected.payeeDetails !== undefined
  ) {
    expected.payeeDetailsHash = expected.payeeDetails;
    delete expected.payeeDetails;
  }
  if (
    log.event === "DepositPaymentMethodActiveUpdated" &&
    expected.active !== undefined
  ) {
    expected.isActive = expected.active;
    delete expected.active;
  }
  return {
    entity: `${prefix}_${eventName}`,
    fields: ["id", ...Object.keys(expected)],
    expected,
  };
}

function compareRawScalar(
  actual: unknown,
  expected: unknown,
  label: string
): void {
  if (typeof actual === "boolean" || typeof expected === "boolean") {
    assertEqual(actual, expected, label);
    return;
  }
  assertEqual(String(actual), String(expected), label);
}

async function fetchAndAssertRawReceiptRows(
  receipt: ContractReceipt,
  contracts: LoadedContracts
): Promise<Json> {
  const logs = decodeLogs(receipt, contracts);
  const expectedRows = logs
    .map((log) => ({ log, expectation: rawEventExpectation(log) }))
    .filter(
      (
        item
      ): item is {
        log: Json;
        expectation: { entity: string; fields: string[]; expected: Json };
      } => Boolean(item.expectation)
    );
  if (expectedRows.length === 0)
    return { query: null, response: null, checks: [] };
  const fields = expectedRows.map(({ log, expectation }, index) => {
    const id = `${EXPECTED_CHAIN_ID}_${receipt.blockNumber}_${String(
      log.logIndex
    )}`;
    return `event_${index}: ${expectation.entity}_by_pk(id: ${quoted(
      id
    )}) { ${expectation.fields.join(" ")} }`;
  });
  const query = `query RiskE2ERawReceipt {\n${fields.join("\n")}\n}`;
  const startedAt = Date.now();
  let response: Json;
  let data: Json;
  let missing: string[];
  do {
    response = await graphql(query);
    data = graphqlData(response);
    missing = expectedRows
      .map(({ expectation }, index) =>
        data[`event_${index}`] ? "" : expectation.entity
      )
      .filter(Boolean);
    if (missing.length === 0) break;
    if (Date.now() - startedAt > INDEXER_TIMEOUT_MS) {
      throw new Error(
        `Indexer raw rows not visible within ${INDEXER_TIMEOUT_MS}ms: ${missing.join(
          ","
        )}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, INDEXER_POLL_MS));
  } while (true);
  const checks: Json[] = [];
  expectedRows.forEach(({ log, expectation }, index) => {
    const row = data[`event_${index}`] as Json | undefined;
    if (!row) {
      throw new Error(
        `Indexer missing raw ${expectation.entity} row for ${
          receipt.blockNumber
        }/${String(log.logIndex)}`
      );
    }
    for (const [name, expected] of Object.entries(expectation.expected)) {
      compareRawScalar(row[name], expected, `${expectation.entity}.${name}`);
    }
    checks.push({
      entity: expectation.entity,
      id: row.id,
      blockNumber: receipt.blockNumber,
      logIndex: log.logIndex,
      result: "PASS",
    });
  });
  return { query, response, checks, waitedMs: Date.now() - startedAt };
}

async function graphql(query: string, variables: Json = {}): Promise<Json> {
  const endpoint = process.env.E2E_INDEXER_URL;
  if (!endpoint)
    throw new Error("E2E_INDEXER_URL is required for scenario execution");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const result = (await response.json()) as Json;
  if (!response.ok || result.errors) {
    throw new Error(
      `Indexer GraphQL request failed: ${redact(JSON.stringify(result))}`
    );
  }
  return result;
}

function maximumNumeric(value: unknown, keys: string[]): bigint {
  let maximum = -1n;
  if (Array.isArray(value)) {
    for (const child of value)
      maximum =
        maximum > maximumNumeric(child, keys)
          ? maximum
          : maximumNumeric(child, keys);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Json)) {
      if (
        keys.includes(key) &&
        (typeof child === "string" || typeof child === "number")
      ) {
        try {
          const parsed = BigInt(child);
          if (parsed > maximum) maximum = parsed;
        } catch {
          // Ignore non-integer metadata.
        }
      }
      const nested = maximumNumeric(child, keys);
      if (nested > maximum) maximum = nested;
    }
  }
  return maximum;
}

const META_QUERIES = [
  `query RiskE2ESync { chain_metadata(where: { chain_id: { _eq: ${EXPECTED_CHAIN_ID} } }) { chain_id block_height num_events_processed } }`,
  `query RiskE2ESync { chain_metadata { chain_id block_height } }`,
];

async function waitForIndexer(blockNumber: number): Promise<Json> {
  const startedAt = Date.now();
  let last: Json | undefined;
  let lastError = "";
  while (Date.now() - startedAt <= INDEXER_TIMEOUT_MS) {
    for (const query of META_QUERIES) {
      try {
        last = await graphql(query);
        const indexed = maximumNumeric(last, [
          "block_height",
          "latest_processed_block",
        ]);
        if (indexed >= BigInt(blockNumber)) {
          return {
            waitedMs: Date.now() - startedAt,
            indexedBlock: indexed.toString(),
            metadata: last,
          };
        }
      } catch (error) {
        lastError = redact(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, INDEXER_POLL_MS));
  }
  throw new Error(
    `Indexer did not reach block ${blockNumber} in ${INDEXER_TIMEOUT_MS}ms; last=${JSON.stringify(
      normalize(last || {})
    )}; error=${lastError}`
  );
}

async function waitForMinedBlock(
  provider: ethers.providers.JsonRpcProvider,
  blockNumber: number
): Promise<ethers.providers.Block> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= RECEIPT_TIMEOUT_MS) {
    const block = await provider.getBlock(blockNumber);
    if (block) return block;
    await new Promise((resolve) => setTimeout(resolve, INDEXER_POLL_MS));
  }
  throw new Error(
    `RPC did not return mined block ${blockNumber} within ${RECEIPT_TIMEOUT_MS}ms; resume the journaled transaction later`
  );
}

const STAKE_FIELDS = `chainId vaultAddress stakeOwner totalStake pendingWithdrawalAmount eligibleStake reservedStake freeStake exiting exitRequestedAt exitAvailableAt updatedAt`;
const TAKER_FIELDS = `chainId vaultAddress taker stakeOwner delegatedStakeOwner stakeDelegationEnabled allowedStakeOwner riskManagerAddress vaultControllerVersion totalStake pendingWithdrawalAmount eligibleStake reservedStake freeStake exiting exitRequestedAt exitAvailableAt updatedAt`;
const POSITION_FIELDS = `chainId riskManagerAddress intentHash taker stakeOwner lp paymentMethod mode consumedFreeTake intentAmount createdAt maxIntentPeriod griefingCliff griefingPenaltyBpsPerHour chargebackReserveBps riskWindow maxGriefingBond chargebackReserve initialReservation`;
const POSITION_STATE_FIELDS = `chainId riskManagerAddress intentHash status currentReservation releasedReservation griefingPenalty releasedAmount chargebackCoverage remainingCoverage deferredPayoutAmount totalChargebackCompensation cancelledAt settledAt coverageDeadline lastEvidenceId updatedAt`;

function quoted(value: string): string {
  return JSON.stringify(value.toLowerCase());
}

function byPk(
  alias: string,
  entity: string,
  id: string,
  fields: string
): string {
  return `${alias}: ${entity}_by_pk(id: ${quoted(id)}) { ${fields} }`;
}

function buildExactSnapshotQuery(state: RunState): string {
  const actors = actorAddresses(loadActors());
  const chain = EXPECTED_CHAIN_ID;
  const vault = ADDRESSES.stakeVault.toLowerCase();
  const manager = ADDRESSES.riskManager.toLowerCase();
  const orchestrator = ADDRESSES.orchestratorV3.toLowerCase();
  const escrow = ADDRESSES.escrowV2.toLowerCase();
  const fields: string[] = [];

  for (const role of ["ownerA", "ownerB"] as const) {
    const address = actors[role].toLowerCase();
    fields.push(
      byPk(
        `stake_${role}`,
        "StakeAccountState",
        `${chain}_${vault}_${address}`,
        STAKE_FIELDS
      )
    );
    fields.push(
      byPk(
        `summary_${role}`,
        "StakeOwnerRiskSummary",
        `${chain}_${manager}_${address}`,
        `chainId riskManagerAddress stakeOwner pendingPositionCount pendingIntentAmount pendingMaxGriefingBond pendingInitialReservation activeChargebackPositionCount activeChargebackCoverage deferredPayoutCoverage accruedGriefingPenalties totalChargebackCompensation updatedAt`
      )
    );
  }
  for (const role of [
    "takerA1",
    "takerA2",
    "takerB",
    "unauthorized",
  ] as const) {
    const address = actors[role].toLowerCase();
    const id = `${chain}_${vault}_${address}`;
    fields.push(byPk(`taker_${role}`, "TakerStakeState", id, TAKER_FIELDS));
    fields.push(
      byPk(
        `authorization_${role}`,
        "TakerStakeAuthorization",
        id,
        `chainId vaultAddress taker stakeOwner authorized updatedAt`
      )
    );
    fields.push(
      byPk(
        `delegation_${role}`,
        "TakerStakeDelegationPolicy",
        id,
        `chainId vaultAddress taker enabled allowedStakeOwner updatedAt`
      )
    );
  }
  for (const [methodName, method] of Object.entries(PAYMENT_METHODS)) {
    const platformId = `${chain}_${manager}_${method.toLowerCase()}`;
    fields.push(
      byPk(
        `platform_${methodName}`,
        "PlatformRiskConfig",
        platformId,
        `chainId riskManagerAddress paymentMethod enabled updatedAt`
      ),
      byPk(
        `chargebackConfig_${methodName}`,
        "PlatformChargebackConfig",
        platformId,
        `chainId riskManagerAddress paymentMethod chargebackable deferredPayoutEnabled reserveBps riskWindow updatedAt`
      ),
      byPk(
        `griefingConfig_${methodName}`,
        "PlatformGriefingConfig",
        platformId,
        `chainId riskManagerAddress paymentMethod griefingCliff griefingPenaltyBpsPerHour freeTakeCount freeTakeAmount updatedAt`
      )
    );
    for (const role of ["ownerA", "ownerB"] as const) {
      fields.push(
        byPk(
          `free_${role}_${methodName}`,
          "FreeTakeUsage",
          `${chain}_${manager}_${actors[
            role
          ].toLowerCase()}_${method.toLowerCase()}`,
          `chainId riskManagerAddress stakeOwner paymentMethod freeTakesUsed freeTakeCount remainingFreeTakes totalFreeTakeAmount lastIntentHash lastAmount updatedAt`
        )
      );
    }
    for (const role of ["lpA", "lpB"] as const) {
      fields.push(
        byPk(
          `exposure_${role}_${methodName}`,
          "LpRiskExposure",
          `${chain}_${manager}_${actors[
            role
          ].toLowerCase()}_${method.toLowerCase()}`,
          `chainId riskManagerAddress lp paymentMethod pendingPositionCount pendingIntentAmount pendingMaxGriefingBond pendingInitialReservation activeCoveragePositionCount activeReleasedAmount remainingCoverage uncoveredExposure deferredPayoutExposure maturedPositionCount maturedExposure exhaustedPositionCount exhaustedExposure totalGriefingCompensation totalChargebackCompensation updatedAt`
        )
      );
    }
  }
  fields.push(
    byPk(
      "escrowPeriod",
      "EscrowIntentPeriodState",
      `${chain}_${escrow}`,
      `chainId escrowAddress maxIntentPeriod observedFrom updatedAt`
    ),
    byPk(
      "managerAdmission",
      "RiskAdmissionConfig",
      `${chain}_${manager}`,
      `chainId riskManagerAddress admissionPaused updatedAt`
    )
  );

  for (const [role, depositId] of Object.entries(state.deposits)) {
    const depositEntityId = `${escrow}_${depositId}`;
    fields.push(
      byPk(
        `deposit_${role}`,
        "Deposit",
        depositEntityId,
        `chainId escrowAddress depositId depositor token remainingDeposits outstandingIntentAmount riskHookAddress updatedAt`
      ),
      byPk(
        `depositHook_${role}`,
        "DepositRiskHook",
        `${chain}_${orchestrator}_${escrow}_${depositId}`,
        `chainId orchestratorAddress escrowAddress depositId hook setter updatedAt`
      )
    );
    const methods =
      role === "lpA"
        ? { zelle: PAYMENT_METHODS.zelle, venmo: PAYMENT_METHODS.venmo }
        : { venmo: PAYMENT_METHODS.venmo };
    for (const [methodName, method] of Object.entries(methods)) {
      const quoteId = `${depositEntityId}_${method.toLowerCase()}_${USD.toLowerCase()}`;
      fields.push(
        byPk(
          `quote_${role}_${methodName}`,
          "QuoteCandidate",
          quoteId,
          `chainId depositId escrowAddress paymentMethodHash currencyCode riskHookAddress isActive updatedAt`
        ),
        byPk(
          `orderbook_${role}_${methodName}`,
          "OrderbookEntry",
          `${depositEntityId}_${methodName}_${USD.toLowerCase()}`,
          `chainId depositId escrowAddress paymentMethodHash currencyCode riskHookAddress isActive updatedAt`
        )
      );
    }
  }

  for (const [name, intentHash] of Object.entries(state.intents)) {
    const intent = intentHash.toLowerCase();
    const positionId = `${chain}_${manager}_${intent}`;
    const reservationId = `${chain}_${vault}_${intent}`;
    const lifecycleId = `${chain}_${intent}`;
    fields.push(
      byPk(`position_${name}`, "RiskPosition", positionId, POSITION_FIELDS),
      byPk(
        `positionState_${name}`,
        "RiskPositionState",
        positionId,
        POSITION_STATE_FIELDS
      ),
      byPk(
        `griefing_${name}`,
        "GriefingRiskState",
        positionId,
        `chainId riskManagerAddress intentHash maxGriefingBond penaltyCharged effectiveElapsed chargedAt updatedAt`
      ),
      byPk(
        `coverage_${name}`,
        "ChargebackCoverage",
        positionId,
        `chainId riskManagerAddress intentHash stakeOwner lp paymentMethod mode status releasedAmount initialCoverage remainingCoverage uncoveredAmount deferredPayoutAmount beneficiary totalCompensated settledAt coverageDeadline updatedAt`
      ),
      byPk(
        `reservation_${name}`,
        "StakeReservationState",
        reservationId,
        `chainId vaultAddress intentHash stakeOwner currentAmount status updatedAt`
      ),
      byPk(
        `deferred_${name}`,
        "DeferredPayoutState",
        lifecycleId,
        `chainId vaultAddress intentHash beneficiary status amount updatedAt`
      ),
      byPk(
        `deferredRegistration_${name}`,
        "DeferredPayoutRegistration",
        positionId,
        `chainId riskManagerAddress intentHash beneficiary deferredAmount chargebackCoverage coverageDeadline updatedAt`
      ),
      byPk(
        `intentHook_${name}`,
        "IntentRiskHookState",
        lifecycleId,
        `chainId intentHash orchestratorAddress riskHook requiresPostIntentHook updatedAt`
      ),
      byPk(
        `intentSettlement_${name}`,
        "IntentSettlementState",
        lifecycleId,
        `chainId intentHash orchestratorAddress releasedAmount settledAt updatedAt`
      ),
      byPk(
        `intentCancellation_${name}`,
        "IntentCancellationState",
        lifecycleId,
        `chainId intentHash orchestratorAddress cancelledAt updatedAt`
      )
    );
  }
  for (const role of ["lpA", "lpB"] as const) {
    fields.push(
      byPk(
        `compensation_${role}`,
        "MakerCompensation",
        `${chain}_${vault}_${actors[role].toLowerCase()}`,
        `chainId vaultAddress maker claimableAmount updatedAt`
      )
    );
  }
  return `query RiskE2EExactSnapshot {\n${fields.join("\n")}\n}`;
}

async function contractSnapshot(
  contracts: LoadedContracts,
  state: RunState,
  blockTag?: number
): Promise<Json> {
  const actors = actorAddresses(loadActors());
  const call = { blockTag };
  const owners = await Promise.all(
    [actors.ownerA, actors.ownerB].map(async (owner) => ({
      owner,
      stakeBalance: await contracts.vault.stakeBalance(owner, call),
      eligibleStake: await contracts.vault.eligibleStake(owner, call),
      reservedStake: await contracts.vault.reservedStake(owner, call),
      freeStake: await contracts.vault.freeStake(owner, call),
      exiting: await contracts.vault.isExiting(owner, call),
      withdrawal: await contracts.vault.getStakeWithdrawalRequest(owner, call),
      exit: await contracts.vault.getExitRequest(owner, call),
      compensation: await contracts.vault.claimableCompensation(owner, call),
    }))
  );
  const takers = await Promise.all(
    [actors.takerA1, actors.takerA2, actors.takerB, actors.unauthorized].map(
      async (taker) => ({
        taker,
        stakeOwner: await contracts.vault.stakeOwnerOf(taker, call),
        allowedStakeOwner: await contracts.vault.allowedStakeOwner(taker, call),
        delegationEnabled: await contracts.vault.stakeDelegationEnabled(
          taker,
          call
        ),
        takerState: await contracts.risk.getTakerState(taker, call),
      })
    )
  );
  const positions = await Promise.all(
    Object.entries(state.intents).map(async ([name, intentHash]) => ({
      name,
      intentHash,
      position: await contracts.risk.getRiskPosition(intentHash, call),
      reservation: await contracts.vault.getReservation(intentHash, call),
      deferredPayout: await contracts.vault.getDeferredPayout(intentHash, call),
      intentSettlement: await contracts.orchestrator.getIntentSettlement(
        intentHash,
        call
      ),
      intentCancellation: await contracts.orchestrator.getIntentCancellation(
        intentHash,
        call
      ),
    }))
  );
  return {
    observedAtUtc: new Date().toISOString(),
    blockTag,
    totals: {
      totalStaked: await contracts.vault.totalStaked(call),
      totalDeferredPayouts: await contracts.vault.totalDeferredPayouts(call),
      totalClaimableCompensation:
        await contracts.vault.totalClaimableCompensation(call),
      totalLiabilities: await contracts.vault.totalLiabilities(call),
    },
    freeTakes: await Promise.all(
      [actors.ownerA, actors.ownerB].flatMap((owner) =>
        Object.entries(PAYMENT_METHODS).map(async ([method, hash]) => ({
          owner,
          method,
          used: await contracts.risk.freeTakesUsed(owner, hash, call),
        }))
      )
    ),
    owners,
    takers,
    makerCompensation: await Promise.all(
      [actors.lpA, actors.lpB].map(async (maker) => ({
        maker,
        claimable: await contracts.vault.claimableCompensation(maker, call),
      }))
    ),
    positions,
  };
}

async function indexedSnapshot(state: RunState): Promise<Json> {
  return graphql(buildExactSnapshotQuery(state));
}

const MODE_NAMES = ["NONE", "FREE", "STAKE_BACKED", "DEFERRED_PAYOUT"];
const STATUS_NAMES = [
  "NONE",
  "PENDING",
  "CANCELLED",
  "SETTLED",
  "RELEASED",
  "SLASHED",
];

function graphqlData(indexer: Json): Json {
  const data = indexer.data as Json | undefined;
  if (!data) throw new Error("GraphQL response is missing data");
  return data;
}

async function assertIndexedReconciliation(
  indexer: Json,
  contracts: LoadedContracts,
  state: RunState,
  blockTag: number
): Promise<Json[]> {
  const checks: Json[] = [];
  const call = { blockTag };
  const actors = actorAddresses(loadActors());
  const data = graphqlData(indexer);
  const observedPositions: Array<{
    name: string;
    intentHash: string;
    position: any;
  }> = [];

  for (const [methodName, method] of Object.entries(PAYMENT_METHODS)) {
    const admission = data[`platform_${methodName}`] as Json | undefined;
    const chargeback = data[`chargebackConfig_${methodName}`] as
      | Json
      | undefined;
    const griefing = data[`griefingConfig_${methodName}`] as Json | undefined;
    if (!admission || !chargeback || !griefing)
      throw new Error(
        `Indexer missing exact three-row platform config for ${methodName}`
      );
    const expected = await contracts.risk.getPlatformRiskConfig(method, call);
    assertEqual(
      admission.riskManagerAddress,
      ADDRESSES.riskManager,
      `${methodName} manager scope`
    );
    assertEqual(admission.enabled, expected.enabled, `${methodName} enabled`);
    assertEqual(
      chargeback.chargebackable,
      expected.chargeback.chargebackable,
      `${methodName} chargebackable`
    );
    assertEqual(
      chargeback.deferredPayoutEnabled,
      expected.chargeback.deferredPayoutEnabled,
      `${methodName} deferred payout enabled`
    );
    assertEqual(
      chargeback.reserveBps,
      expected.chargeback.reserveBps,
      `${methodName} reserve bps`
    );
    assertEqual(
      chargeback.riskWindow,
      expected.chargeback.riskWindow,
      `${methodName} risk window`
    );
    assertEqual(
      griefing.griefingCliff,
      expected.griefing.griefingCliff,
      `${methodName} cliff`
    );
    assertEqual(
      griefing.griefingPenaltyBpsPerHour,
      expected.griefing.griefingPenaltyBpsPerHour,
      `${methodName} slope`
    );
    assertEqual(
      griefing.freeTakeCount,
      expected.griefing.freeTakeCount,
      `${methodName} free count`
    );
    assertEqual(
      griefing.freeTakeAmount,
      expected.griefing.freeTakeAmount,
      `${methodName} free amount`
    );
    checks.push({
      entity: "PlatformRiskConfig(3 rows)",
      key: method,
      result: "PASS",
    });
  }

  const vaultTokenBalance = await contracts.token.balanceOf(
    ADDRESSES.stakeVault,
    call
  );
  const totalLiabilities = await contracts.vault.totalLiabilities(call);
  assertEqual(
    vaultTokenBalance,
    totalLiabilities,
    "StakeVault token/liability conservation"
  );
  checks.push({
    entity: "StakeVault",
    key: ADDRESSES.stakeVault,
    result: "PASS",
  });

  for (const role of ["ownerA", "ownerB"] as const) {
    const owner = actors[role];
    const expected = {
      totalStake: await contracts.vault.stakeBalance(owner, call),
      eligibleStake: await contracts.vault.eligibleStake(owner, call),
      reservedStake: await contracts.vault.reservedStake(owner, call),
      freeStake: await contracts.vault.freeStake(owner, call),
      exiting: await contracts.vault.isExiting(owner, call),
    };
    const row = data[`stake_${role}`] as Json | undefined;
    if (!expected.totalStake.isZero()) {
      if (!row)
        throw new Error(`Indexer missing StakeAccountState for ${role}`);
      assertEqual(
        row.totalStake,
        expected.totalStake,
        `${role} indexed total stake`
      );
      assertEqual(
        row.eligibleStake,
        expected.eligibleStake,
        `${role} indexed eligible stake`
      );
      assertEqual(
        row.reservedStake,
        expected.reservedStake,
        `${role} indexed reserved stake`
      );
      assertEqual(
        row.freeStake,
        expected.freeStake,
        `${role} indexed free stake`
      );
      assertEqual(row.exiting, expected.exiting, `${role} indexed exit state`);
      checks.push({ entity: "StakeAccountState", key: owner, result: "PASS" });
    }
  }

  for (const role of ["takerA1", "takerA2", "takerB"] as const) {
    const taker = actors[role];
    const owner = await contracts.vault.stakeOwnerOf(taker, call);
    const row = data[`taker_${role}`] as Json | undefined;
    if (owner.toLowerCase() !== taker.toLowerCase()) {
      if (!row)
        throw new Error(
          `Indexer missing TakerStakeState for delegated taker ${taker}`
        );
      const expected = await contracts.risk.getTakerState(taker, call);
      assertEqual(row.stakeOwner, owner, `${taker} indexed stake owner`);
      assertEqual(
        row.totalStake,
        expected.totalStake,
        `${taker} indexed total stake`
      );
      assertEqual(
        row.reservedStake,
        expected.reserved,
        `${taker} indexed reserved stake`
      );
      assertEqual(row.freeStake, expected.free, `${taker} indexed free stake`);
      assertEqual(row.exiting, expected.exiting, `${taker} indexed exiting`);
      checks.push({ entity: "TakerStakeState", key: taker, result: "PASS" });
    }
  }

  for (const [name, intentHash] of Object.entries(state.intents)) {
    const immutable = data[`position_${name}`] as Json | undefined;
    const current = data[`positionState_${name}`] as Json | undefined;
    if (!immutable || !current)
      throw new Error(
        `Indexer missing risk position rows for ${name}/${intentHash}`
      );
    const position = await contracts.risk.getRiskPosition(intentHash, call);
    observedPositions.push({ name, intentHash, position });
    assertEqual(immutable.taker, position.taker, `${name} indexed taker`);
    assertEqual(
      immutable.stakeOwner,
      position.stakeOwner,
      `${name} indexed stake owner`
    );
    assertEqual(immutable.lp, position.lp, `${name} indexed LP`);
    assertEqual(
      immutable.intentAmount,
      position.intentAmount,
      `${name} indexed intent amount`
    );
    assertEqual(
      immutable.maxGriefingBond,
      position.maxGriefingBond,
      `${name} indexed max bond`
    );
    assertEqual(
      immutable.initialReservation,
      position.initialReservation,
      `${name} indexed initial reservation`
    );
    assertEqual(
      immutable.mode,
      MODE_NAMES[Number(position.mode)],
      `${name} indexed mode`
    );
    assertEqual(
      current.status,
      STATUS_NAMES[Number(position.status)],
      `${name} indexed status`
    );
    assertEqual(
      current.currentReservation,
      position.reservedAmount,
      `${name} indexed current reservation`
    );
    assertEqual(
      current.releasedAmount,
      position.releasedAmount,
      `${name} indexed released amount`
    );
    if (Number(position.status) === 2) {
      assertEqual(
        current.griefingPenalty,
        position.slashedAmount,
        `${name} indexed griefing slash`
      );
      assertEqual(
        current.totalChargebackCompensation,
        "0",
        `${name} indexed chargeback compensation`
      );
    } else {
      assertEqual(
        current.totalChargebackCompensation,
        position.slashedAmount,
        `${name} indexed chargeback compensation`
      );
    }
    checks.push({
      entity: "RiskPosition+RiskPositionState",
      key: intentHash,
      result: "PASS",
    });

    const coverage = data[`coverage_${name}`] as Json | undefined;
    if (coverage) {
      const initial = BigInt(String(coverage.initialCoverage));
      const remaining = BigInt(String(coverage.remainingCoverage));
      const compensated = BigInt(String(coverage.totalCompensated));
      const released = BigInt(String(coverage.releasedAmount));
      const uncovered = BigInt(String(coverage.uncoveredAmount));
      assertEqual(
        initial,
        remaining + compensated,
        `${name} coverage conservation`
      );
      assertEqual(
        released,
        initial + uncovered,
        `${name} released coverage conservation`
      );
      checks.push({
        entity: "ChargebackCoverage",
        key: intentHash,
        result: "PASS",
      });
    }
    const deferred = data[`deferred_${name}`] as Json | undefined;
    if (deferred) {
      const fundedRemaining =
        BigInt(position.deferredPayoutAmount.toString()) -
        BigInt(position.slashedAmount.toString());
      assertEqual(
        deferred.amount,
        fundedRemaining,
        `${name} deferred funded remainder`
      );
      checks.push({
        entity: "DeferredPayoutState",
        key: intentHash,
        result: "PASS",
      });
    }
  }

  const sum = (values: bigint[]): bigint =>
    values.reduce((total, value) => total + value, 0n);
  for (const role of ["ownerA", "ownerB"] as const) {
    const owner = actors[role].toLowerCase();
    const positions = observedPositions.filter(
      ({ position }) => String(position.stakeOwner).toLowerCase() === owner
    );
    if (positions.length === 0) continue;
    const row = data[`summary_${role}`] as Json | undefined;
    if (!row)
      throw new Error(`Indexer missing StakeOwnerRiskSummary for ${role}`);
    const pending = positions.filter(
      ({ position }) => Number(position.status) === 1
    );
    const active = positions.filter(
      ({ position }) => Number(position.status) === 3
    );
    const cancelled = positions.filter(
      ({ position }) => Number(position.status) === 2
    );
    assertEqual(
      row.pendingPositionCount,
      BigInt(pending.length),
      `${role} pending count`
    );
    assertEqual(
      row.pendingIntentAmount,
      sum(
        pending.map(({ position }) => BigInt(position.intentAmount.toString()))
      ),
      `${role} pending amount`
    );
    assertEqual(
      row.pendingMaxGriefingBond,
      sum(
        pending.map(({ position }) =>
          BigInt(position.maxGriefingBond.toString())
        )
      ),
      `${role} pending maximum griefing bond`
    );
    assertEqual(
      row.pendingInitialReservation,
      sum(
        pending.map(({ position }) =>
          BigInt(position.initialReservation.toString())
        )
      ),
      `${role} pending initial reservation`
    );
    assertEqual(
      row.activeChargebackPositionCount,
      BigInt(active.length),
      `${role} active coverage count`
    );
    assertEqual(
      row.activeChargebackCoverage,
      sum(
        active.map(({ position }) => BigInt(position.reservedAmount.toString()))
      ),
      `${role} active coverage`
    );
    assertEqual(
      row.deferredPayoutCoverage,
      sum(
        active
          .filter(({ position }) => Number(position.mode) === 3)
          .map(({ position }) => BigInt(position.reservedAmount.toString()))
      ),
      `${role} deferred coverage`
    );
    assertEqual(
      row.accruedGriefingPenalties,
      sum(
        cancelled.map(({ position }) =>
          BigInt(position.slashedAmount.toString())
        )
      ),
      `${role} griefing compensation`
    );
    checks.push({
      entity: "StakeOwnerRiskSummary",
      key: owner,
      result: "PASS",
    });
  }

  for (const role of ["lpA", "lpB"] as const) {
    for (const [methodName, method] of Object.entries(PAYMENT_METHODS)) {
      const positions = observedPositions.filter(
        ({ position }) =>
          String(position.lp).toLowerCase() === actors[role].toLowerCase() &&
          String(position.paymentMethod).toLowerCase() === method.toLowerCase()
      );
      if (positions.length === 0) continue;
      const row = data[`exposure_${role}_${methodName}`] as Json | undefined;
      if (!row)
        throw new Error(
          `Indexer missing LpRiskExposure for ${role}/${methodName}`
        );
      const pending = positions.filter(
        ({ position }) => Number(position.status) === 1
      );
      const active = positions.filter(
        ({ position }) => Number(position.status) === 3
      );
      assertEqual(
        row.pendingPositionCount,
        BigInt(pending.length),
        `${role}/${methodName} pending count`
      );
      assertEqual(
        row.pendingIntentAmount,
        sum(
          pending.map(({ position }) =>
            BigInt(position.intentAmount.toString())
          )
        ),
        `${role}/${methodName} pending amount`
      );
      assertEqual(
        row.pendingMaxGriefingBond,
        sum(
          pending.map(({ position }) =>
            BigInt(position.maxGriefingBond.toString())
          )
        ),
        `${role}/${methodName} pending max bond`
      );
      assertEqual(
        row.pendingInitialReservation,
        sum(
          pending.map(({ position }) =>
            BigInt(position.initialReservation.toString())
          )
        ),
        `${role}/${methodName} pending reservation`
      );
      assertEqual(
        row.activeCoveragePositionCount,
        BigInt(active.length),
        `${role}/${methodName} active count`
      );
      assertEqual(
        row.activeReleasedAmount,
        sum(
          active.map(({ position }) =>
            BigInt(position.releasedAmount.toString())
          )
        ),
        `${role}/${methodName} active released amount`
      );
      assertEqual(
        row.remainingCoverage,
        sum(
          active.map(({ position }) =>
            BigInt(position.reservedAmount.toString())
          )
        ),
        `${role}/${methodName} remaining coverage`
      );
      const uncovered = sum(
        active.map(({ position }) => {
          const released = BigInt(position.releasedAmount.toString());
          const initial = ceilDiv(
            released * BigInt(position.chargebackReserveBps.toString()),
            10_000n
          );
          return released - initial;
        })
      );
      assertEqual(
        row.uncoveredExposure,
        uncovered,
        `${role}/${methodName} uncovered exposure`
      );
      assertEqual(
        row.deferredPayoutExposure,
        sum(
          active
            .filter(({ position }) => Number(position.mode) === 3)
            .map(({ position }) => BigInt(position.reservedAmount.toString()))
        ),
        `${role}/${methodName} deferred exposure`
      );
      checks.push({
        entity: "LpRiskExposure",
        key: `${role}/${methodName}`,
        result: "PASS",
      });
    }
  }

  for (const role of ["ownerA", "ownerB"] as const) {
    const owner = actors[role];
    const used = await contracts.risk.freeTakesUsed(
      owner,
      PAYMENT_METHODS.zelle,
      call
    );
    if (!BigNumber.from(used).isZero()) {
      const row = data[`free_${role}_zelle`] as Json | undefined;
      if (!row) throw new Error(`Indexer missing FreeTakeUsage for ${owner}`);
      assertEqual(row.freeTakesUsed, used, `${owner} indexed free takes used`);
      checks.push({ entity: "FreeTakeUsage", key: owner, result: "PASS" });
    }
  }

  for (const role of ["lpA", "lpB"] as const) {
    const maker = actors[role];
    const expected = await contracts.vault.claimableCompensation(maker, call);
    const row = data[`compensation_${role}`] as Json | undefined;
    if (row)
      assertEqual(
        row.claimableAmount,
        expected,
        `${maker} indexed compensation`
      );
    if (!expected.isZero() && !row)
      throw new Error(`Indexer missing MakerCompensation for ${maker}`);
    if (row)
      checks.push({ entity: "MakerCompensation", key: maker, result: "PASS" });
  }

  for (const [role, depositId] of Object.entries(state.deposits)) {
    const hook = data[`depositHook_${role}`] as Json | undefined;
    const deposit = data[`deposit_${role}`] as Json | undefined;
    if (!deposit)
      throw new Error(
        `Indexer missing exact deposit row for ${role}/${depositId}`
      );
    const expectedHook = await contracts.orchestrator.getDepositRiskHook(
      ADDRESSES.escrowV2,
      depositId,
      call
    );
    if (String(expectedHook).toLowerCase() === ZERO.toLowerCase()) {
      if (hook) assertEqual(hook.hook, ZERO, `${role} pre-hook exact hook row`);
      checks.push({ entity: "Deposit(pre-hook)", key: role, result: "PASS" });
      continue;
    }
    if (!hook)
      throw new Error(
        `Indexer missing exact deposit hook row for ${role}/${depositId}`
      );
    assertEqual(
      hook.hook,
      ADDRESSES.riskManager,
      `${role} indexed deposit hook`
    );
    assertEqual(
      deposit.riskHookAddress,
      ADDRESSES.riskManager,
      `${role} deposit risk hook projection`
    );
    const methods = role === "lpA" ? ["zelle", "venmo"] : ["venmo"];
    for (const method of methods) {
      const quote = data[`quote_${role}_${method}`] as Json | undefined;
      const orderbook = data[`orderbook_${role}_${method}`] as Json | undefined;
      if (!quote || !orderbook)
        throw new Error(
          `Indexer missing quote/orderbook hook rows for ${role}/${method}`
        );
      assertEqual(
        quote.riskHookAddress,
        ADDRESSES.riskManager,
        `${role}/${method} quote risk hook`
      );
      assertEqual(
        orderbook.riskHookAddress,
        ADDRESSES.riskManager,
        `${role}/${method} orderbook risk hook`
      );
      checks.push({
        entity: "Deposit+QuoteCandidate+OrderbookEntry",
        key: `${role}/${method}`,
        result: "PASS",
      });
    }
  }
  return checks;
}

async function saveSynchronizedSnapshot(
  label: string,
  blockNumber: number,
  contracts: LoadedContracts,
  state: RunState
): Promise<Json> {
  const sync = await waitForIndexer(blockNumber);
  const [onchain, indexer] = await Promise.all([
    contractSnapshot(contracts, state, blockNumber),
    indexedSnapshot(state),
  ]);
  const evidence: Json = {
    label,
    capturedAtUtc: new Date().toISOString(),
    receiptBlock: blockNumber,
    sync,
    graphql: { query: buildExactSnapshotQuery(state), response: indexer },
    onchain,
  };
  evidence.reconciliation = await assertIndexedReconciliation(
    indexer,
    contracts,
    state,
    blockNumber
  );
  writeEvidence(`${label}.snapshot`, evidence);
  return evidence;
}

const ACTION_PLAN = [
  "preflight: verify chain/artifacts/actors, Envio sync, configs, and empty actor baseline",
  "setup: targeted native/USDC funding, one-sided delegated stake, two isolated LP deposits, risk hooks",
  "fast: whole-free boundary cases, bonded reservation, partial withdrawal/exit gates, shared capacity, stake-backed settlement, deferred settlement",
  "after-cliff: cancel long-lived free and bonded positions and reconcile exact time-linear griefing charge",
  "fork-only chargebacks/failure induction: intentionally absent from this live runner; execute from a separately reviewed isolated-fork fixture",
  "reconcile: exact chain+contract primary keys, raw receipt event rows, hook projections, and conservation equations",
];

function showPlan(): void {
  printJson({
    writesEnabled: process.env.E2E_ALLOW_MUTATION === "YES",
    endpointConfigured: Boolean(process.env.E2E_INDEXER_URL),
    stateFileStoredPrivately: STATE_FILE,
    evidenceDirectory: EVIDENCE_ROOT,
    phases: ACTION_PLAN,
    longDurationCases: {
      griefingCliff:
        "run after-cliff after the saved notBefore timestamp (about 15 minutes)",
      chargebackMaturity: "30-day maturity remains PREPROD",
      deferredWithdrawal: "30-day maturity remains PREPROD",
      externalProofFulfillment:
        "DATA; manual LP release validates settlement callbacks without fabricating proofs",
    },
  });
}

function actorWallet(
  role: string,
  provider: ethers.providers.Provider
): Wallet {
  const actor = loadActors()[role];
  if (!actor) throw new Error(`Unknown actor role ${role}`);
  const wallet = new Wallet(actor.privateKey, provider);
  if (wallet.address.toLowerCase() !== actor.address.toLowerCase()) {
    throw new Error(`Actor key/address mismatch for ${role}`);
  }
  return wallet;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const left = BigNumber.isBigNumber(actual)
    ? actual.toString()
    : String(actual).toLowerCase();
  const right = BigNumber.isBigNumber(expected)
    ? expected.toString()
    : String(expected).toLowerCase();
  if (left !== right)
    throw new Error(`${label}: expected ${right}, observed ${left}`);
}

function findDecodedEvent(evidence: Json, eventName: string): Json {
  const events = evidence.decodedLogs as Json[];
  const event = events.find((candidate) => candidate.event === eventName);
  if (!event)
    throw new Error(`${eventName} missing from ${String(evidence.label)}`);
  return event;
}

function eventArgument(event: Json, name: string): string {
  const args = event.args as Record<string, unknown>;
  const value = args[name];
  if (value === undefined)
    throw new Error(`${String(event.event)}.${name} missing`);
  return BigNumber.isBigNumber(value) ? value.toString() : String(value);
}

async function runAction(
  label: string,
  signer: Wallet,
  contract: Contract,
  method: string,
  args: unknown[],
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState,
  options: {
    reconcile?: boolean;
    afterReceipt?: (evidence: Json) => void;
  } = {}
): Promise<Json> {
  const persist = (record: Json): void => {
    state.transactions[label] = record;
    saveState(state);
    writeTransactionEvidence(label, record);
  };

  let evidence = state.transactions[label];
  let broadcastTransaction: ethers.providers.TransactionResponse | undefined;
  if (!evidence) {
    const connected = contract.connect(signer);
    const preBlock = await provider.getBlockNumber();
    const preOnchain = options.reconcile
      ? await contractSnapshot(contracts, state, preBlock)
      : undefined;
    try {
      await connected.callStatic[method](...args);
    } catch (error) {
      throw new Error(`${label} simulation failed: ${redact(error)}`);
    }

    requireMutationFlag();
    const request = await connected.populateTransaction[method](...args);
    const prepared = await prepareSignedTransaction(signer, request);
    evidence = {
      label,
      journalStatus: "PRE_BROADCAST",
      preparedAtUtc: new Date().toISOString(),
      actor: signer.address,
      contract: contract.address,
      method,
      ...prepared.journal,
      rawTransaction: prepared.rawTransaction,
      preBlock,
      preOnchain,
    };
    // Persist the locally signed hash before eth_sendRawTransaction. A lost RPC
    // response can then only resolve this exact hash; it can never build a new tx.
    persist(evidence);
    try {
      broadcastTransaction = await provider.sendTransaction(
        prepared.rawTransaction
      );
      assertEqual(
        broadcastTransaction.hash,
        prepared.journal.transactionHash,
        `${label} broadcast hash`
      );
      evidence.journalStatus = "PENDING_RECEIPT";
      evidence.broadcastAcknowledgedAtUtc = new Date().toISOString();
      persist(evidence);
    } catch (error) {
      evidence.broadcastError = safeBroadcastError(
        error,
        prepared.rawTransaction
      );
      evidence.broadcastAttemptedAtUtc = new Date().toISOString();
      persist(evidence);
    }
  }

  if (evidence.skipped) return evidence;

  let receipt = await provider.getTransactionReceipt(
    String(evidence.transactionHash)
  );
  if (!receipt) {
    const observed =
      broadcastTransaction ||
      (await provider.getTransaction(String(evidence.transactionHash)));
    if (!observed) {
      throw new Error(
        `${label} journaled transaction ${String(
          evidence.transactionHash
        )} is absent from the RPC. Treat the pre-signed hash/nonce as an ambiguous or dropped/replaced send. Resolve it explicitly from the private run-state journal; never construct or automatically broadcast a different transaction.`
      );
    }
    receipt = await provider.waitForTransaction(
      String(evidence.transactionHash),
      1,
      RECEIPT_TIMEOUT_MS
    );
    if (!receipt) {
      throw new Error(
        `${label} transaction ${String(
          evidence.transactionHash
        )} is still pending after ${RECEIPT_TIMEOUT_MS}ms; resume later without deleting its journal entry`
      );
    }
  }

  if (!evidence.blockNumber) {
    const block = await waitForMinedBlock(provider, receipt.blockNumber);
    delete evidence.rawTransaction;
    delete evidence.broadcastError;
    evidence = {
      ...evidence,
      journalStatus: receipt.status === 1 ? "MINED" : "REVERTED",
      transactionHash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      blockTimestamp: block.timestamp,
      gasUsed: receipt.gasUsed,
      decodedLogs: decodeLogs(receipt as ContractReceipt, contracts),
      afterReceiptApplied: false,
    };
    persist(evidence);
  }
  if (Number(evidence.status) !== 1) {
    throw new Error(
      `${label} reverted in transaction ${String(evidence.transactionHash)}`
    );
  }

  if (
    evidence.journalStatus === "MINED" &&
    evidence.afterReceiptApplied !== true
  ) {
    options.afterReceipt?.(evidence);
    evidence.afterReceiptApplied = true;
    persist(evidence);
  }

  if (!evidence.indexerSync) {
    evidence.indexerSync = await waitForIndexer(Number(evidence.blockNumber));
    persist(evidence);
  }
  if (!evidence.rawEventRows) {
    evidence.rawEventRows = await fetchAndAssertRawReceiptRows(
      receipt as ContractReceipt,
      contracts
    );
    persist(evidence);
  }
  if (
    options.reconcile &&
    (!evidence.reconciliation || evidence.reconciliationError)
  ) {
    evidence.postOnchain = await contractSnapshot(
      contracts,
      state,
      Number(evidence.blockNumber)
    );
    const response = await indexedSnapshot(state);
    evidence.graphql = { query: buildExactSnapshotQuery(state), response };
    try {
      const reconciliation = await assertIndexedReconciliation(
        response,
        contracts,
        state,
        Number(evidence.blockNumber)
      );
      evidence.reconciliation = reconciliation;
      delete evidence.reconciliationError;
      persist(evidence);
    } catch (error) {
      evidence.reconciliationError = redact(error);
      persist(evidence);
      throw error;
    }
  }
  return evidence;
}

async function runNativeFunding(
  label: string,
  governance: Wallet,
  recipient: string,
  target: BigNumber,
  provider: ethers.providers.JsonRpcProvider,
  state: RunState
): Promise<void> {
  const persist = (record: Json): void => {
    state.transactions[label] = record;
    saveState(state);
    writeTransactionEvidence(label, record);
  };
  let evidence = state.transactions[label];
  let broadcastTransaction: ethers.providers.TransactionResponse | undefined;
  if (!evidence) {
    const balance = await provider.getBalance(recipient);
    if (balance.gte(target)) {
      persist({
        label,
        skipped: true,
        reason: "target balance already present",
        observedBalance: balance,
      });
      return;
    }
    const value = target.sub(balance);
    await provider.call({ from: governance.address, to: recipient, value });
    requireMutationFlag();
    const prepared = await prepareSignedTransaction(governance, {
      to: recipient,
      value,
    });
    evidence = {
      label,
      journalStatus: "PRE_BROADCAST",
      preparedAtUtc: new Date().toISOString(),
      actor: governance.address,
      recipient,
      asset: "ETH",
      amount: value,
      ...prepared.journal,
      rawTransaction: prepared.rawTransaction,
    };
    persist(evidence);
    try {
      broadcastTransaction = await provider.sendTransaction(
        prepared.rawTransaction
      );
      assertEqual(
        broadcastTransaction.hash,
        prepared.journal.transactionHash,
        `${label} broadcast hash`
      );
      evidence.journalStatus = "PENDING_RECEIPT";
      evidence.broadcastAcknowledgedAtUtc = new Date().toISOString();
      persist(evidence);
    } catch (error) {
      evidence.broadcastError = safeBroadcastError(
        error,
        prepared.rawTransaction
      );
      evidence.broadcastAttemptedAtUtc = new Date().toISOString();
      persist(evidence);
    }
  }
  if (evidence.skipped) return;

  let receipt = await provider.getTransactionReceipt(
    String(evidence.transactionHash)
  );
  if (!receipt) {
    const observed =
      broadcastTransaction ||
      (await provider.getTransaction(String(evidence.transactionHash)));
    if (!observed) {
      throw new Error(
        `${label} journaled native-funding transaction ${String(
          evidence.transactionHash
        )} is absent from the RPC. Resolve the pre-signed hash/nonce explicitly from the private run-state journal; never construct or automatically broadcast a different transaction.`
      );
    }
    receipt = await provider.waitForTransaction(
      String(evidence.transactionHash),
      1,
      RECEIPT_TIMEOUT_MS
    );
    if (!receipt) {
      throw new Error(
        `${label} native-funding transaction ${String(
          evidence.transactionHash
        )} is still pending after ${RECEIPT_TIMEOUT_MS}ms; resume later without deleting its journal entry`
      );
    }
  }
  if (!evidence.blockNumber) {
    const block = await waitForMinedBlock(provider, receipt.blockNumber);
    delete evidence.rawTransaction;
    delete evidence.broadcastError;
    evidence = {
      ...evidence,
      journalStatus: receipt.status === 1 ? "MINED" : "REVERTED",
      transactionHash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      blockTimestamp: block.timestamp,
      gasUsed: receipt.gasUsed,
    };
    persist(evidence);
  }
  if (Number(evidence.status) !== 1) {
    throw new Error(
      `${label} reverted in transaction ${String(evidence.transactionHash)}`
    );
  }
  if (!evidence.indexerSync) {
    evidence.indexerSync = await waitForIndexer(Number(evidence.blockNumber));
    persist(evidence);
  }
}

async function expectRevert(
  label: string,
  signer: Wallet,
  contract: Contract,
  method: string,
  args: unknown[],
  state: RunState
): Promise<void> {
  if (state.expectedReverts[label]) return;
  try {
    await contract.connect(signer).callStatic[method](...args);
  } catch (error) {
    const evidence = {
      label,
      observedAtUtc: new Date().toISOString(),
      actor: signer.address,
      contract: contract.address,
      method,
      reverted: true,
      error: redact(error),
    };
    state.expectedReverts[label] = evidence;
    saveState(state);
    writeEvidence(label, evidence);
    return;
  }
  throw new Error(`${label}: simulation unexpectedly succeeded`);
}

function signalParams(
  depositId: string,
  amount: string,
  paymentMethod: string,
  recipient: string,
  postIntentHook = ZERO
): Json {
  return {
    escrow: ADDRESSES.escrowV2,
    depositId,
    amount,
    to: recipient,
    paymentMethod,
    fiatCurrency: USD,
    conversionRate: PRECISE_ONE,
    referralFees: [],
    gatingServiceSignature: "0x",
    signatureExpiration: 0,
    postIntentHook,
    preIntentHookData: "0x",
    data: "0x",
  };
}

function depositParams(
  amount: string,
  maximum: string,
  methods: string[],
  guardian: string
): Json {
  const currency = {
    code: USD,
    minConversionRate: PRECISE_ONE,
    oracleRateConfig: {
      adapter: ZERO,
      adapterConfig: "0x",
      spreadBps: 0,
      maxStaleness: 0,
    },
  };
  return {
    token: ADDRESSES.usdc,
    amount,
    intentAmountRange: { min: "1", max: maximum },
    paymentMethods: methods,
    paymentMethodData: methods.map((method) => ({
      intentGatingService: ZERO,
      payeeDetails: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["address", "bytes32"],
          [guardian, method]
        )
      ),
      data: "0x",
    })),
    currencies: methods.map(() => [currency]),
    delegate: ZERO,
    intentGuardian: guardian,
    retainOnEmpty: true,
  };
}

async function signal(
  label: string,
  intentName: IntentName,
  taker: Wallet,
  params: Json,
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<string> {
  if (state.intents[intentName] && !state.transactions[label]) {
    throw new Error(
      `Intent ${intentName} exists without its transaction journal ${label}`
    );
  }
  await runAction(
    label,
    taker,
    contracts.orchestrator,
    "signalIntent",
    [params],
    provider,
    contracts,
    state,
    {
      reconcile: true,
      afterReceipt: (evidence) => {
        const intentHash = eventArgument(
          findDecodedEvent(evidence, "IntentSignaled"),
          "intentHash"
        );
        state.intents[intentName] = intentHash;
      },
    }
  );
  if (!state.intents[intentName])
    throw new Error(`Intent ${intentName} missing after ${label}`);
  return state.intents[intentName] as string;
}

async function runTokenFunding(
  label: string,
  governance: Wallet,
  recipient: string,
  target: BigNumber,
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<void> {
  const existing = state.transactions[label];
  if (existing?.skipped) return;
  if (existing) {
    await runAction(
      label,
      governance,
      contracts.token,
      "transfer",
      [recipient, 0],
      provider,
      contracts,
      state
    );
    return;
  }
  const balance = await contracts.token.balanceOf(recipient);
  if (balance.gte(target)) {
    state.transactions[label] = {
      label,
      skipped: true,
      reason: "target balance already present",
      observedBalance: balance,
    };
    saveState(state);
    return;
  }
  await runAction(
    label,
    governance,
    contracts.token,
    "transfer",
    [recipient, target.sub(balance)],
    provider,
    contracts,
    state
  );
}

function setupHasStarted(state: RunState): boolean {
  return (
    Object.keys(state.deposits).length > 0 ||
    Object.keys(state.intents).length > 0 ||
    Object.keys(state.transactions).some(
      (label) => label.startsWith("01.") || label.startsWith("02.")
    )
  );
}

function requireNullIndexerRow(data: Json, alias: string): void {
  if (!(alias in data))
    throw new Error(`Fresh-baseline GraphQL response omitted ${alias}`);
  if (data[alias] !== null)
    throw new Error(`Fresh-baseline indexer row ${alias} is not null`);
}

async function assertFreshActorBaseline(
  contracts: LoadedContracts,
  indexer: Json,
  state: RunState,
  blockTag: number
): Promise<void> {
  if (setupHasStarted(state))
    throw new Error(
      "Fresh-baseline assertion requested after setup state was recorded"
    );

  const actors = actorAddresses(loadActors());
  const call = { blockTag };
  for (const role of ["ownerA", "ownerB"] as const) {
    const owner = actors[role];
    const [stake, reserved, eligible, free, exit, withdrawal] =
      await Promise.all([
        contracts.vault.stakeBalance(owner, call),
        contracts.vault.reservedStake(owner, call),
        contracts.vault.eligibleStake(owner, call),
        contracts.vault.freeStake(owner, call),
        contracts.vault.getExitRequest(owner, call),
        contracts.vault.getStakeWithdrawalRequest(owner, call),
      ]);
    assertEqual(stake, 0, `${role} fresh stake`);
    assertEqual(reserved, 0, `${role} fresh reserved stake`);
    assertEqual(eligible, 0, `${role} fresh eligible stake`);
    assertEqual(free, 0, `${role} fresh free stake`);
    assertEqual(exit.exiting, false, `${role} fresh exit flag`);
    assertEqual(exit.requestedAt, 0, `${role} fresh exit requestedAt`);
    assertEqual(exit.availableAt, 0, `${role} fresh exit availableAt`);
    assertEqual(withdrawal.amount, 0, `${role} fresh withdrawal amount`);
    assertEqual(
      withdrawal.requestedAt,
      0,
      `${role} fresh withdrawal requestedAt`
    );
    assertEqual(
      withdrawal.availableAt,
      0,
      `${role} fresh withdrawal availableAt`
    );
    for (const method of Object.values(PAYMENT_METHODS)) {
      assertEqual(
        await contracts.risk.freeTakesUsed(owner, method, call),
        0,
        `${role} fresh free-take usage`
      );
    }
  }

  for (const role of [
    "takerA1",
    "takerA2",
    "takerB",
    "unauthorized",
  ] as const) {
    const taker = actors[role];
    const [stakeOwner, allowedStakeOwner, delegationEnabled, takerState] =
      await Promise.all([
        contracts.vault.stakeOwnerOf(taker, call),
        contracts.vault.allowedStakeOwner(taker, call),
        contracts.vault.stakeDelegationEnabled(taker, call),
        contracts.risk.getTakerState(taker, call),
      ]);
    assertEqual(stakeOwner, taker, `${role} fresh self stake owner`);
    assertEqual(allowedStakeOwner, ZERO, `${role} fresh allowed stake owner`);
    assertEqual(delegationEnabled, true, `${role} fresh delegation policy`);
    assertEqual(takerState.stakeOwner, taker, `${role} fresh taker owner`);
    assertEqual(takerState.totalStake, 0, `${role} fresh taker total stake`);
    assertEqual(takerState.reserved, 0, `${role} fresh taker reserved stake`);
    assertEqual(takerState.free, 0, `${role} fresh taker free stake`);
    assertEqual(takerState.exiting, false, `${role} fresh taker exit flag`);
  }

  for (const role of ["lpA", "lpB"] as const) {
    assertEqual(
      await contracts.vault.claimableCompensation(actors[role], call),
      0,
      `${role} fresh compensation`
    );
  }

  const data = graphqlData(indexer);
  for (const role of ["ownerA", "ownerB"] as const) {
    requireNullIndexerRow(data, `stake_${role}`);
    requireNullIndexerRow(data, `summary_${role}`);
    for (const methodName of Object.keys(PAYMENT_METHODS))
      requireNullIndexerRow(data, `free_${role}_${methodName}`);
  }
  for (const role of [
    "takerA1",
    "takerA2",
    "takerB",
    "unauthorized",
  ] as const) {
    requireNullIndexerRow(data, `taker_${role}`);
    requireNullIndexerRow(data, `authorization_${role}`);
    requireNullIndexerRow(data, `delegation_${role}`);
  }
  for (const role of ["lpA", "lpB"] as const) {
    requireNullIndexerRow(data, `compensation_${role}`);
    for (const methodName of Object.keys(PAYMENT_METHODS))
      requireNullIndexerRow(data, `exposure_${role}_${methodName}`);
  }
}

async function preflight(
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState,
  requireFreshActors: boolean
): Promise<void> {
  const network = await provider.getNetwork();
  assertEqual(network.chainId, EXPECTED_CHAIN_ID, "chain id");
  const governance = deployer(provider);
  assertEqual(governance.address, EXPECTED_GOVERNANCE, "governance signer");
  const latestBlock = await provider.getBlockNumber();

  const [
    riskOwner,
    vaultOwner,
    orchestratorOwner,
    stakeToken,
    controller,
    riskOrchestrator,
    riskVault,
    riskHook,
    hookToken,
    hookVault,
    hookRisk,
    admissionPaused,
    depositsPaused,
    reservationsPaused,
    escrowPaused,
  ] = await Promise.all([
    contracts.risk.owner(),
    contracts.vault.owner(),
    contracts.orchestrator.owner(),
    contracts.vault.stakeToken(),
    contracts.vault.controller(),
    contracts.risk.orchestrator(),
    contracts.risk.stakeVault(),
    contracts.risk.deferredPayoutHook(),
    contracts.hook.payoutToken(),
    contracts.hook.stakeVault(),
    contracts.hook.riskManager(),
    contracts.risk.admissionPaused(),
    contracts.vault.depositsPaused(),
    contracts.vault.reservationsPaused(),
    contracts.escrow.paused(),
  ]);
  assertEqual(riskOwner, EXPECTED_GOVERNANCE, "RiskManager owner");
  assertEqual(vaultOwner, EXPECTED_GOVERNANCE, "StakeVault owner");
  assertEqual(orchestratorOwner, EXPECTED_GOVERNANCE, "Orchestrator owner");
  assertEqual(stakeToken, ADDRESSES.usdc, "StakeVault token");
  assertEqual(controller, ADDRESSES.riskManager, "StakeVault controller");
  assertEqual(
    riskOrchestrator,
    ADDRESSES.orchestratorV3,
    "RiskManager orchestrator"
  );
  assertEqual(riskVault, ADDRESSES.stakeVault, "RiskManager vault");
  assertEqual(riskHook, ADDRESSES.deferredPayoutHook, "RiskManager hook");
  assertEqual(hookToken, ADDRESSES.usdc, "DeferredPayoutHook token");
  assertEqual(hookVault, ADDRESSES.stakeVault, "DeferredPayoutHook vault");
  assertEqual(
    hookRisk,
    ADDRESSES.riskManager,
    "DeferredPayoutHook risk manager"
  );
  assertEqual(admissionPaused, false, "RiskManager admission pause");
  assertEqual(depositsPaused, false, "StakeVault deposits pause");
  assertEqual(reservationsPaused, false, "StakeVault reservations pause");
  assertEqual(escrowPaused, false, "Escrow pause");

  const [zelle, venmo, paypal, maxIntentPeriod] = await Promise.all([
    contracts.risk.getPlatformRiskConfig(PAYMENT_METHODS.zelle),
    contracts.risk.getPlatformRiskConfig(PAYMENT_METHODS.venmo),
    contracts.risk.getPlatformRiskConfig(PAYMENT_METHODS.paypal),
    contracts.escrow.intentExpirationPeriod(),
  ]);
  assertEqual(maxIntentPeriod, "3600", "staging maximum intent period");
  assertEqual(zelle.enabled, true, "Zelle enabled");
  assertEqual(zelle.chargeback.chargebackable, false, "Zelle chargebackable");
  assertEqual(zelle.griefing.griefingCliff, "900", "Zelle griefing cliff");
  assertEqual(
    zelle.griefing.griefingPenaltyBpsPerHour,
    "10",
    "Zelle griefing slope"
  );
  assertEqual(zelle.griefing.freeTakeCount, "3", "Zelle free take count");
  assertEqual(
    zelle.griefing.freeTakeAmount,
    "20000000",
    "Zelle free take amount"
  );
  assertEqual(venmo.enabled, true, "Venmo enabled");
  assertEqual(venmo.chargeback.chargebackable, true, "Venmo chargebackable");
  assertEqual(
    venmo.chargeback.deferredPayoutEnabled,
    true,
    "Venmo deferred payout"
  );
  assertEqual(venmo.chargeback.reserveBps, "10000", "Venmo reserve bps");
  assertEqual(venmo.chargeback.riskWindow, "2592000", "Venmo risk window");
  assertEqual(venmo.griefing.freeTakeCount, "0", "Venmo free take count");
  assertEqual(paypal.enabled, true, "PayPal enabled");
  assertEqual(paypal.chargeback.chargebackable, true, "PayPal chargebackable");
  assertEqual(
    paypal.chargeback.deferredPayoutEnabled,
    true,
    "PayPal deferred payout"
  );
  assertEqual(paypal.chargeback.reserveBps, "10000", "PayPal reserve bps");
  assertEqual(paypal.chargeback.riskWindow, "2592000", "PayPal risk window");
  assertEqual(paypal.griefing.griefingCliff, "900", "PayPal griefing cliff");
  assertEqual(
    paypal.griefing.griefingPenaltyBpsPerHour,
    "10",
    "PayPal griefing slope"
  );
  assertEqual(paypal.griefing.freeTakeCount, "0", "PayPal free take count");

  const invalidBase = {
    enabled: true,
    chargeback: {
      chargebackable: true,
      deferredPayoutEnabled: true,
      reserveBps: 10_000,
      riskWindow: 2_592_000,
    },
    griefing: {
      griefingCliff: 900,
      griefingPenaltyBpsPerHour: 10,
      freeTakeCount: 0,
      freeTakeAmount: 0,
    },
  };
  await expectRevert(
    "00.config.reserve-over-100-percent-reverts",
    governance,
    contracts.risk,
    "setPlatformRiskConfig",
    [
      PAYMENT_METHODS.venmo,
      {
        ...invalidBase,
        chargeback: { ...invalidBase.chargeback, reserveBps: 10_001 },
      },
    ],
    state
  );
  await expectRevert(
    "00.config.chargeback-free-takes-revert",
    governance,
    contracts.risk,
    "setPlatformRiskConfig",
    [
      PAYMENT_METHODS.venmo,
      {
        ...invalidBase,
        griefing: {
          ...invalidBase.griefing,
          freeTakeCount: 1,
          freeTakeAmount: 1,
        },
      },
    ],
    state
  );
  await expectRevert(
    "00.config.nonchargeback-reserve-reverts",
    governance,
    contracts.risk,
    "setPlatformRiskConfig",
    [
      PAYMENT_METHODS.zelle,
      {
        ...invalidBase,
        chargeback: {
          chargebackable: false,
          deferredPayoutEnabled: false,
          reserveBps: 1,
          riskWindow: 0,
        },
      },
    ],
    state
  );
  await expectRevert(
    "00.config.half-free-config-reverts",
    governance,
    contracts.risk,
    "setPlatformRiskConfig",
    [
      PAYMENT_METHODS.zelle,
      {
        ...invalidBase,
        chargeback: {
          chargebackable: false,
          deferredPayoutEnabled: false,
          reserveBps: 0,
          riskWindow: 0,
        },
        griefing: {
          ...invalidBase.griefing,
          freeTakeCount: 1,
          freeTakeAmount: 0,
        },
      },
    ],
    state
  );
  await expectRevert(
    "00.config.zero-payment-method-reverts",
    governance,
    contracts.risk,
    "setPlatformRiskConfig",
    [ethers.constants.HashZero, invalidBase],
    state
  );
  for (const [label, chargeback] of [
    ["zero-reserve", { ...invalidBase.chargeback, reserveBps: 0 }],
    ["zero-window", { ...invalidBase.chargeback, riskWindow: 0 }],
    [
      "window-over-365-days",
      { ...invalidBase.chargeback, riskWindow: 31_536_001 },
    ],
  ] as const) {
    await expectRevert(
      `00.config.chargeback-${label}-reverts`,
      governance,
      contracts.risk,
      "setPlatformRiskConfig",
      [PAYMENT_METHODS.venmo, { ...invalidBase, chargeback }],
      state
    );
  }
  await expectRevert(
    "00.config.nonchargeback-deferred-reverts",
    governance,
    contracts.risk,
    "setPlatformRiskConfig",
    [
      PAYMENT_METHODS.zelle,
      {
        ...invalidBase,
        chargeback: {
          chargebackable: false,
          deferredPayoutEnabled: true,
          reserveBps: 0,
          riskWindow: 0,
        },
      },
    ],
    state
  );

  const sync = await waitForIndexer(latestBlock);
  const [onchain, indexer] = await Promise.all([
    contractSnapshot(contracts, state, latestBlock),
    indexedSnapshot(state),
  ]);
  if (requireFreshActors)
    await assertFreshActorBaseline(contracts, indexer, state, latestBlock);
  const evidence: Json = {
    label: "00.preflight",
    observedAtUtc: new Date().toISOString(),
    chainId: network.chainId,
    latestBlock,
    governance: governance.address,
    actorAddresses: actorAddresses(loadActors()),
    freshActorBaselineRequired: requireFreshActors,
    sync,
    verifiedConfig: {
      zelle,
      venmo,
      paypal,
      maxIntentPeriod,
      admissionPaused,
      depositsPaused,
      reservationsPaused,
      escrowPaused,
    },
    onchain,
    graphql: { query: buildExactSnapshotQuery(state), response: indexer },
  };
  evidence.reconciliation = await assertIndexedReconciliation(
    indexer,
    contracts,
    state,
    latestBlock
  );
  writeEvidence("00.preflight", evidence);
  printJson({
    preflight: "PASS",
    latestBlock,
    indexedBlock: sync.indexedBlock,
  });
}

async function setup(
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<void> {
  requireMutationFlag();
  const governance = deployer(provider);
  const actors = actorAddresses(loadActors());

  for (const [role, amounts] of Object.entries(TARGET_FUNDING)) {
    await runNativeFunding(
      `01.fund.${role}.native`,
      governance,
      actors[role],
      BigNumber.from(amounts.native),
      provider,
      state
    );
    if (amounts.usdc !== "0") {
      await runTokenFunding(
        `01.fund.${role}.usdc`,
        governance,
        actors[role],
        BigNumber.from(amounts.usdc),
        provider,
        contracts,
        state
      );
    }
  }

  const ownerA = actorWallet("ownerA", provider);
  const ownerB = actorWallet("ownerB", provider);
  const lpA = actorWallet("lpA", provider);
  const lpB = actorWallet("lpB", provider);
  const unauthorized = actorWallet("unauthorized", provider);

  await runAction(
    "02.ownerA.approve-vault",
    ownerA,
    contracts.token,
    "approve",
    [ADDRESSES.stakeVault, ethers.constants.MaxUint256],
    provider,
    contracts,
    state
  );
  await runAction(
    "02.ownerA.stake-for-takerA1",
    ownerA,
    contracts.vault,
    "depositStakeFor",
    [actors.takerA1, "6000000"],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await runAction(
    "02.ownerA.authorize-takerA2-batch",
    ownerA,
    contracts.vault,
    "setTakerAuthorizations",
    [[actors.takerA2], true],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await runAction(
    "02.ownerB.approve-vault",
    ownerB,
    contracts.token,
    "approve",
    [ADDRESSES.stakeVault, ethers.constants.MaxUint256],
    provider,
    contracts,
    state
  );
  await runAction(
    "02.ownerB.stake-for-takerB",
    ownerB,
    contracts.vault,
    "depositStakeFor",
    [actors.takerB, "10000"],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  await expectRevert(
    "02.authorization.batch-atomic-on-invalid-taker",
    ownerA,
    contracts.vault,
    "setTakerAuthorizations",
    [[actors.takerA1, ZERO], true],
    state
  );
  await runAction(
    "02.delegation.unauthorized-opt-out",
    unauthorized,
    contracts.vault,
    "setStakeDelegationEnabled",
    [false],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await expectRevert(
    "02.delegation.opt-out-rejects-owner",
    ownerA,
    contracts.vault,
    "setTakerAuthorization",
    [actors.unauthorized, true],
    state
  );
  await runAction(
    "02.delegation.unauthorized-allow-ownerB",
    unauthorized,
    contracts.vault,
    "setAllowedStakeOwner",
    [actors.ownerB],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await expectRevert(
    "02.delegation.exact-owner-rejects-ownerA",
    ownerA,
    contracts.vault,
    "setTakerAuthorization",
    [actors.unauthorized, true],
    state
  );
  await runAction(
    "02.delegation.ownerB-authorizes-exact-taker",
    ownerB,
    contracts.vault,
    "setTakerAuthorization",
    [actors.unauthorized, true],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await expectRevert(
    "02.delegation.first-owner-collision-reverts",
    ownerA,
    contracts.vault,
    "setTakerAuthorization",
    [actors.unauthorized, true],
    state
  );
  await runAction(
    "02.delegation.taker-clears-owner",
    unauthorized,
    contracts.vault,
    "clearStakeOwner",
    [],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await runAction(
    "02.delegation.taker-reenables",
    unauthorized,
    contracts.vault,
    "setStakeDelegationEnabled",
    [true],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await runAction(
    "02.delegation.ownerA-authorizes-after-recovery",
    ownerA,
    contracts.vault,
    "setTakerAuthorization",
    [actors.unauthorized, true],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await runAction(
    "02.delegation.ownerA-revokes-cleanup",
    ownerA,
    contracts.vault,
    "setTakerAuthorization",
    [actors.unauthorized, false],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  for (const [role, lp, amount, maximum, methods] of [
    [
      "lpA",
      lpA,
      "40000000",
      "25000000",
      [PAYMENT_METHODS.zelle, PAYMENT_METHODS.venmo],
    ],
    ["lpB", lpB, "5000000", "5000000", [PAYMENT_METHODS.venmo]],
  ] as const) {
    await runAction(
      `03.${role}.approve-escrow`,
      lp,
      contracts.token,
      "approve",
      [ADDRESSES.escrowV2, ethers.constants.MaxUint256],
      provider,
      contracts,
      state
    );
    const depositLabel = `03.${role}.create-deposit`;
    if (state.deposits[role] && !state.transactions[depositLabel]) {
      throw new Error(
        `Deposit ${role} exists without its transaction journal ${depositLabel}`
      );
    }
    await runAction(
      depositLabel,
      lp,
      contracts.escrow,
      "createDeposit",
      [depositParams(amount, maximum, [...methods], lp.address)],
      provider,
      contracts,
      state,
      {
        reconcile: true,
        afterReceipt: (evidence) => {
          state.deposits[role] = eventArgument(
            findDecodedEvent(evidence, "DepositReceived"),
            "depositId"
          );
        },
      }
    );
    if (!state.deposits[role])
      throw new Error(`Deposit ${role} missing after ${depositLabel}`);
    await runAction(
      `03.${role}.set-risk-hook`,
      lp,
      contracts.orchestrator,
      "setDepositRiskHook",
      [ADDRESSES.escrowV2, state.deposits[role], ADDRESSES.riskManager],
      provider,
      contracts,
      state,
      { reconcile: true }
    );
  }

  const block = await provider.getBlockNumber();
  await saveSynchronizedSnapshot("03.setup-complete", block, contracts, state);
  printJson({ setup: "PASS", deposits: state.deposits, block });
}

async function assertPosition(
  contracts: LoadedContracts,
  intentHash: string,
  expected: { mode: number; status: number; reservation: string; free: boolean }
): Promise<void> {
  const position = await contracts.risk.getRiskPosition(intentHash);
  assertEqual(position.mode, expected.mode, `${intentHash} mode`);
  assertEqual(position.status, expected.status, `${intentHash} status`);
  assertEqual(
    position.initialReservation,
    expected.reservation,
    `${intentHash} initial reservation`
  );
  assertEqual(
    position.consumedFreeTake,
    expected.free,
    `${intentHash} consumed free take`
  );
}

async function fastScenarios(
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<void> {
  requireMutationFlag();
  if (!state.deposits.lpA || !state.deposits.lpB)
    throw new Error("Run setup before fast");
  const actors = actorAddresses(loadActors());
  const takerA1 = actorWallet("takerA1", provider);
  const takerA2 = actorWallet("takerA2", provider);
  const takerB = actorWallet("takerB", provider);
  const ownerA = actorWallet("ownerA", provider);
  const ownerB = actorWallet("ownerB", provider);
  const lpA = actorWallet("lpA", provider);
  const lpB = actorWallet("lpB", provider);
  const recipient = actorWallet("recipient", provider);
  const caller = actorWallet("caller", provider);
  const unauthorized = actorWallet("unauthorized", provider);

  const freeLong = await signal(
    "04.free-1raw.signal",
    "freeLong",
    takerA1,
    signalParams(
      state.deposits.lpA,
      "1",
      PAYMENT_METHODS.zelle,
      actors.recipient
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, freeLong, {
    mode: 1,
    status: 1,
    reservation: "0",
    free: true,
  });

  const oversizeAmount = 20_000_001n;
  const oversizeBond = ceilDiv(oversizeAmount * 10n * 2_700n, 10_000n * 3_600n);
  assertEqual(oversizeBond, 15_001n, "oversize exact griefing bond");
  writeEvidence("04.oversize.math", {
    amount: oversizeAmount,
    numerator: oversizeAmount * 10n * 2_700n,
    denominator: 10_000n * 3_600n,
    rounding: "ceiling",
    expectedBond: oversizeBond,
  });
  const oversize = await signal(
    "04.oversize-wholly-bonded.signal",
    "oversizeBonded",
    takerA1,
    signalParams(
      state.deposits.lpA,
      oversizeAmount.toString(),
      PAYMENT_METHODS.zelle,
      actors.recipient
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, oversize, {
    mode: 2,
    status: 1,
    reservation: oversizeBond.toString(),
    free: false,
  });
  await runAction(
    "04.oversize-wholly-bonded.cancel-before-cliff",
    takerA1,
    contracts.orchestrator,
    "cancelIntent",
    [oversize],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  const freeExact = await signal(
    "04.free-exact-20usdc.signal",
    "freeExact",
    takerA2,
    signalParams(
      state.deposits.lpA,
      "20000000",
      PAYMENT_METHODS.zelle,
      actors.recipient
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, freeExact, {
    mode: 1,
    status: 1,
    reservation: "0",
    free: true,
  });
  await runAction(
    "04.free-exact-20usdc.cancel",
    takerA2,
    contracts.orchestrator,
    "cancelIntent",
    [freeExact],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  const freeReleased = await signal(
    "04.free-third.signal",
    "freeReleased",
    takerA1,
    signalParams(
      state.deposits.lpA,
      "500000",
      PAYMENT_METHODS.zelle,
      actors.recipient
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, freeReleased, {
    mode: 1,
    status: 1,
    reservation: "0",
    free: true,
  });
  await runAction(
    "04.free-third.manual-release",
    lpA,
    contracts.orchestrator,
    "releaseFundsToPayer",
    [freeReleased],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  const bondedAmount = 500_000n;
  const bondedBond = ceilDiv(bondedAmount * 10n * 2_700n, 10_000n * 3_600n);
  assertEqual(bondedBond, 375n, "fourth-take griefing bond");
  const bondedLong = await signal(
    "04.fourth-take-bonded.signal",
    "bondedLong",
    takerA2,
    signalParams(
      state.deposits.lpA,
      bondedAmount.toString(),
      PAYMENT_METHODS.zelle,
      actors.recipient
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, bondedLong, {
    mode: 2,
    status: 1,
    reservation: bondedBond.toString(),
    free: false,
  });

  await expectRevert(
    "04.unauthorized-cannot-use-ownerA-stake",
    unauthorized,
    contracts.orchestrator,
    "signalIntent",
    [
      signalParams(
        state.deposits.lpA,
        "1",
        PAYMENT_METHODS.venmo,
        actors.recipient
      ),
    ],
    state
  );
  await runAction(
    "04.ownerA.revoke-takerA2",
    ownerA,
    contracts.vault,
    "setTakerAuthorization",
    [actors.takerA2, false],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  const existingAfterRevocation = await contracts.risk.getRiskPosition(
    bondedLong
  );
  assertEqual(
    existingAfterRevocation.stakeOwner,
    actors.ownerA,
    "existing position owner after revocation"
  );
  await expectRevert(
    "04.revoked-taker-cannot-open-new-backed-position",
    takerA2,
    contracts.orchestrator,
    "signalIntent",
    [
      signalParams(
        state.deposits.lpA,
        "1",
        PAYMENT_METHODS.venmo,
        actors.recipient
      ),
    ],
    state
  );
  await runAction(
    "04.ownerA.reauthorize-takerA2",
    ownerA,
    contracts.vault,
    "setTakerAuthorization",
    [actors.takerA2, true],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  const eligibleBeforeWithdrawal = await contracts.vault.eligibleStake(
    ownerA.address
  );
  const freeBeforeWithdrawal = await contracts.vault.freeStake(ownerA.address);
  await runAction(
    "05.partial-withdrawal.request",
    ownerA,
    contracts.vault,
    "requestStakeWithdrawal",
    ["1000000"],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  assertEqual(
    await contracts.vault.eligibleStake(ownerA.address),
    eligibleBeforeWithdrawal.sub("1000000"),
    "partial request immediately reduces eligible stake"
  );
  assertEqual(
    await contracts.vault.freeStake(ownerA.address),
    freeBeforeWithdrawal.sub("1000000"),
    "partial request immediately reduces free stake"
  );
  await expectRevert(
    "05.partial-withdrawal.early-withdraw-reverts",
    ownerA,
    contracts.vault,
    "withdrawRequestedStake",
    [actors.ownerA],
    state
  );
  await runAction(
    "05.partial-withdrawal.cancel",
    ownerA,
    contracts.vault,
    "cancelStakeWithdrawal",
    [],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await runAction(
    "05.full-exit.request",
    ownerA,
    contracts.vault,
    "requestExit",
    [],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await expectRevert(
    "05.full-exit.blocks-new-bonded-admission",
    takerA1,
    contracts.orchestrator,
    "signalIntent",
    [
      signalParams(
        state.deposits.lpA,
        "500001",
        PAYMENT_METHODS.zelle,
        actors.recipient
      ),
    ],
    state
  );
  await runAction(
    "05.full-exit.cancel",
    ownerA,
    contracts.vault,
    "cancelExit",
    [],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  await runAction(
    "05.free-admission-while-owner-exiting.request-exit",
    ownerB,
    contracts.vault,
    "requestExit",
    [],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  const freeWhileExiting = await signal(
    "05.free-admission-while-owner-exiting.signal",
    "freeWhileExiting",
    takerB,
    signalParams(
      state.deposits.lpA,
      "1",
      PAYMENT_METHODS.zelle,
      actors.recipient
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, freeWhileExiting, {
    mode: 1,
    status: 1,
    reservation: "0",
    free: true,
  });
  await runAction(
    "05.free-admission-while-owner-exiting.cancel",
    takerB,
    contracts.orchestrator,
    "cancelIntent",
    [freeWhileExiting],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await runAction(
    "05.free-admission-while-owner-exiting.cancel-exit",
    ownerB,
    contracts.vault,
    "cancelExit",
    [],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  const chargebackCancelled = await signal(
    "06.chargeback-1.signal",
    "chargebackCancelled",
    takerA1,
    signalParams(
      state.deposits.lpA,
      "1000000",
      PAYMENT_METHODS.venmo,
      actors.recipient
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, chargebackCancelled, {
    mode: 2,
    status: 1,
    reservation: "1000000",
    free: false,
  });
  const chargebackSettled = await signal(
    "06.chargeback-2.signal",
    "chargebackSettled",
    takerA2,
    signalParams(
      state.deposits.lpA,
      "2000000",
      PAYMENT_METHODS.venmo,
      actors.recipient
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, chargebackSettled, {
    mode: 2,
    status: 1,
    reservation: "2000000",
    free: false,
  });
  await expectRevert(
    "06.shared-portfolio-over-capacity-reverts",
    takerA1,
    contracts.orchestrator,
    "signalIntent",
    [
      signalParams(
        state.deposits.lpA,
        "4000000",
        PAYMENT_METHODS.venmo,
        actors.recipient
      ),
    ],
    state
  );
  await runAction(
    "06.chargeback-1.cancel-before-cliff",
    takerA1,
    contracts.orchestrator,
    "cancelIntent",
    [chargebackCancelled],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  await runAction(
    "06.chargeback-2.manual-release",
    lpA,
    contracts.orchestrator,
    "releaseFundsToPayer",
    [chargebackSettled],
    provider,
    contracts,
    state,
    { reconcile: true }
  );

  await expectRevert(
    "07.deferred.missing-canonical-hook-reverts",
    takerB,
    contracts.orchestrator,
    "signalIntent",
    [
      signalParams(
        state.deposits.lpB,
        "1000000",
        PAYMENT_METHODS.venmo,
        actors.recipient
      ),
    ],
    state
  );
  await expectRevert(
    "07.deferred.below-griefing-bond-reverts",
    takerB,
    contracts.orchestrator,
    "signalIntent",
    [
      signalParams(
        state.deposits.lpA,
        "20000000",
        PAYMENT_METHODS.venmo,
        actors.recipient,
        ADDRESSES.deferredPayoutHook
      ),
    ],
    state
  );
  await expectRevert(
    "07.deferred.canonical-hook-rejected-for-fully-staked-position",
    takerA1,
    contracts.orchestrator,
    "signalIntent",
    [
      signalParams(
        state.deposits.lpA,
        "1000000",
        PAYMENT_METHODS.venmo,
        actors.recipient,
        ADDRESSES.deferredPayoutHook
      ),
    ],
    state
  );
  assertEqual(
    await contracts.orchestrator.protocolFee(),
    "0",
    "deferred protocol fee prerequisite"
  );
  const managerFee = await contracts.escrow.getManagerFee(state.deposits.lpB);
  assertEqual(managerFee.fee, "0", "deferred manager fee prerequisite");

  const deferred = await signal(
    "07.deferred.signal",
    "deferredSettled",
    takerB,
    signalParams(
      state.deposits.lpB,
      "1000000",
      PAYMENT_METHODS.venmo,
      actors.recipient,
      ADDRESSES.deferredPayoutHook
    ),
    provider,
    contracts,
    state
  );
  await assertPosition(contracts, deferred, {
    mode: 3,
    status: 1,
    reservation: "750",
    free: false,
  });
  await runAction(
    "07.deferred.manual-release",
    lpB,
    contracts.orchestrator,
    "releaseFundsToPayer",
    [deferred],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  const deferredPosition = await contracts.risk.getRiskPosition(deferred);
  const deferredPayout = await contracts.vault.getDeferredPayout(deferred);
  assertEqual(
    deferredPayout.amount,
    deferredPosition.releasedAmount,
    "zero-fee deferred payout equals gross released amount"
  );
  await expectRevert(
    "07.deferred.registration-wrong-caller-reverts",
    caller,
    contracts.risk,
    "registerDeferredPayout",
    [deferred, actors.recipient, "1000000"],
    state
  );

  await expectRevert(
    "08.batch.empty-cancellation-reconcile-reverts",
    caller,
    contracts.risk,
    "reconcileCancellations",
    [[]],
    state
  );
  await expectRevert(
    "08.batch.empty-settlement-reconcile-reverts",
    caller,
    contracts.risk,
    "reconcileSettlements",
    [[]],
    state
  );
  await expectRevert(
    "08.batch.early-maturity-atomic-revert",
    caller,
    contracts.risk,
    "releaseMaturedPositions",
    [[chargebackSettled, deferred]],
    state
  );
  await expectRevert(
    "08.batch.early-deferred-withdraw-reverts",
    recipient,
    contracts.vault,
    "withdrawDeferredPayouts",
    [[deferred], actors.recipient],
    state
  );

  const freePosition = await contracts.risk.getRiskPosition(freeLong);
  const bondedPosition = await contracts.risk.getRiskPosition(bondedLong);
  const notBefore =
    Math.max(
      freePosition.createdAt.add(freePosition.griefingCliff).toNumber(),
      bondedPosition.createdAt.add(bondedPosition.griefingCliff).toNumber()
    ) + 1;
  const block = await provider.getBlockNumber();
  await saveSynchronizedSnapshot(
    "08.fast-scenarios-complete",
    block,
    contracts,
    state
  );
  printJson({
    fastScenarios: "PASS",
    notBeforeUnix: notBefore,
    intents: state.intents,
  });
}

function griefingPenalty(
  amount: bigint,
  createdAt: bigint,
  cancelledAt: bigint,
  maxIntentPeriod: bigint,
  cliff: bigint,
  slope: bigint
): Json {
  const elapsed = cancelledAt - createdAt;
  const effectiveElapsed =
    elapsed > maxIntentPeriod ? maxIntentPeriod : elapsed;
  const chargeableTime =
    effectiveElapsed > cliff ? effectiveElapsed - cliff : 0n;
  const numerator = amount * slope * chargeableTime;
  const denominator = 10_000n * 3_600n;
  return {
    amount,
    createdAt,
    cancelledAt,
    elapsed,
    effectiveElapsed,
    cliff,
    chargeableTime,
    slopeBpsPerHour: slope,
    numerator,
    denominator,
    rounding: "ceiling",
    expectedPenalty: ceilDiv(numerator, denominator),
  };
}

async function afterCliff(
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<void> {
  requireMutationFlag();
  const freeLong = state.intents.freeLong;
  const bondedLong = state.intents.bondedLong;
  if (!freeLong || !bondedLong) throw new Error("Run fast before after-cliff");
  const freePosition = await contracts.risk.getRiskPosition(freeLong);
  const bondedPosition = await contracts.risk.getRiskPosition(bondedLong);
  const notBefore =
    Math.max(
      freePosition.createdAt.add(freePosition.griefingCliff).toNumber(),
      bondedPosition.createdAt.add(bondedPosition.griefingCliff).toNumber()
    ) + 1;
  const latest = await provider.getBlock("latest");
  if (latest.timestamp < notBefore) {
    throw new Error(
      `after-cliff is not ready; retry after Unix ${notBefore} (${
        notBefore - latest.timestamp
      }s remaining)`
    );
  }

  await runAction(
    "09.free-long.cancel-after-cliff",
    actorWallet("takerA1", provider),
    contracts.orchestrator,
    "cancelIntent",
    [freeLong],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  const freeAfter = await contracts.risk.getRiskPosition(freeLong);
  assertEqual(freeAfter.slashedAmount, "0", "free take griefing slash");

  const evidence = await runAction(
    "09.bonded-long.cancel-after-cliff",
    actorWallet("takerA2", provider),
    contracts.orchestrator,
    "cancelIntent",
    [bondedLong],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
  const after = await contracts.risk.getRiskPosition(bondedLong);
  const oracle = griefingPenalty(
    BigInt(bondedPosition.intentAmount.toString()),
    BigInt(bondedPosition.createdAt.toString()),
    BigInt(String(evidence.blockTimestamp)),
    BigInt(bondedPosition.maxIntentPeriod.toString()),
    BigInt(bondedPosition.griefingCliff.toString()),
    BigInt(bondedPosition.griefingPenaltyBpsPerHour.toString())
  );
  assertEqual(
    after.slashedAmount,
    oracle.expectedPenalty as bigint,
    "bonded cancellation penalty"
  );
  writeEvidence("09.bonded-long.penalty-oracle", oracle);
  const block = await provider.getBlockNumber();
  await saveSynchronizedSnapshot(
    "09.after-cliff-complete",
    block,
    contracts,
    state
  );
  printJson({ afterCliff: "PASS", penalty: oracle.expectedPenalty, block });
}

async function finalReconciliation(
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<void> {
  const block = await provider.getBlockNumber();
  const evidence = await saveSynchronizedSnapshot(
    "11.final-reconciliation",
    block,
    contracts,
    state
  );
  printJson({
    finalReconciliation: "CAPTURED",
    block,
    transactionCount: Object.keys(state.transactions).length,
    expectedRevertCount: Object.keys(state.expectedReverts).length,
    intentCount: Object.keys(state.intents).length,
    evidenceFile: evidenceFile("11.final-reconciliation.snapshot"),
    evidence,
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] || "plan";
  if (command === "plan") return showPlan();

  loadEnvironment();
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl());
  const contracts = loadContracts(provider);
  const state = loadState();

  const runSafetyGate = () =>
    preflight(provider, contracts, state, !setupHasStarted(state));

  if (command === "preflight") return runSafetyGate();
  if (command === "setup") {
    await runSafetyGate();
    return setup(provider, contracts, state);
  }
  if (command === "fast") {
    await runSafetyGate();
    return fastScenarios(provider, contracts, state);
  }
  if (command === "after-cliff") {
    await runSafetyGate();
    return afterCliff(provider, contracts, state);
  }
  if (command === "reconcile")
    return finalReconciliation(provider, contracts, state);
  if (command === "execute") {
    await runSafetyGate();
    await setup(provider, contracts, state);
    await fastScenarios(provider, contracts, state);
    try {
      await afterCliff(provider, contracts, state);
    } catch (error) {
      if (!redact(error).includes("after-cliff is not ready")) throw error;
      printJson({ afterCliff: "PENDING_NATURAL_WAIT", detail: redact(error) });
    }
    return finalReconciliation(provider, contracts, state);
  }
  throw new Error(
    "Usage: affineRiskScenarioRunner.ts <plan|preflight|setup|fast|after-cliff|reconcile|execute>"
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`affine-risk-scenario: ${redact(error)}\n`);
  process.exitCode = 1;
});
