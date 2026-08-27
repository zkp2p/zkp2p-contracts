import "module-alias/register";

import fs from "fs";
import path from "path";

import { BigNumber, Contract, Wallet, ethers } from "ethers";

type ActiveDeposit = {
  escrowAddress: string;
  depositId: BigNumber;
  paymentMethodHashes: string[];
};

type BootstrapTarget = {
  escrowAddress: string;
  depositId: BigNumber;
  paymentMethodHash: string;
};

type TargetPaymentMethodRow = {
  depositId: string;
  depositIdOnContract: string | number;
  paymentMethodHash: string;
};

type BootstrapConfig = {
  network: "base" | "base_staging";
  expectedChainId: number;
  rpcUrl: string;
  receiptRpcUrl?: string;
  indexerUrl: string;
  indexerApiKey?: string;
  policyAddress: string;
  escrowAddresses: string[];
  groupIds: string[];
  pageSize: number;
  maxDeposits: number;
  batchSize: number;
  readConcurrency: number;
  confirmations: number;
  receiptTimeoutMs: number;
  maxPriorityFeePerGas: BigNumber;
  maxFeePerGasCap: BigNumber;
  expectedDepositCount?: number;
  expectedSelectionDigest?: string;
  allowCompleted: boolean;
  mode: "dry-run" | "execute" | "safe";
  privateKey?: string;
  safeOutputFile?: string;
};

export type SafeTransaction = {
  to: string;
  value: string;
  data: string;
  contractMethod: null;
  contractInputsValues: null;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: unknown[];
};

export const POLICY_ABI = [
  "function owner() view returns (address)",
  "function groupRegistry() view returns (address)",
  "function bootstrapped(address,uint256,bytes32) view returns (bool)",
  "function enabled(address,uint256,bytes32) view returns (bool)",
  "function getAllowedGroups(address,uint256,bytes32) view returns (bytes32[])",
  "function bootstrapDeposits(address,uint256[],bytes32,bytes32[])",
];

const GROUP_REGISTRY_ABI = [
  "function groupExists(bytes32) view returns (bool)",
];

const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
];

const ESCROW_ABI = [
  "function getDeposit(uint256) view returns (tuple(address depositor,address delegate,address token,tuple(uint256 min,uint256 max) intentAmountRange,bool acceptingIntents,uint256 remainingDeposits,uint256 outstandingIntentAmount,address intentGuardian,bool retainOnEmpty))",
  "function getDepositPaymentMethodActive(uint256,bytes32) view returns (bool)",
];

const TARGET_PAYMENT_METHODS = [
  {
    name: "venmo",
    hash: "0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268",
  },
  {
    name: "cashapp",
    hash: "0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d",
  },
  {
    name: "paypal",
    hash: "0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f",
  },
] as const;

const TARGET_PAYMENT_METHOD_HASHES = TARGET_PAYMENT_METHODS.map(({ hash }) => hash);
const TARGET_PAYMENT_METHOD_HASH_SET = new Set<string>(TARGET_PAYMENT_METHOD_HASHES);

const PRODUCTION_INDEXER_URL = "https://indexer.zkp2p.xyz/v1/graphql";
const KNOWN_PRODUCTION_GROUPS = {
  peerTaker: {
    name: "peer-taker-peer-v1",
    id: "0x2fb4591ba225813e272f6c51e6e64edcfa21fff18ea2619726363a4f785c2c09",
  },
  plus: {
    name: "peer-taker-plus-v1",
    id: "0xb8747401b308d4891385620071b5916e9c61284f25c4611541c529703de5babf",
  },
  pro: {
    name: "peer-taker-pro-v1",
    id: "0xf030f72e772f954059ca28f94974088aaf6ba37bb1f264df48843a3d0c221dc3",
  },
  peerChargebackableVolume: {
    name: "Peer Chargebackable Volume",
    id: "0xd75c75f345c8e5d4a9f48bc0cc458cf15adb0c4393469d6b10da1655c2c1c0f1",
  },
  plusChargebackableVolume: {
    name: "Plus Chargebackable Volume",
    id: "0x76d8468179105f4ec9ba8f553823f44dcde6eeb997ba5b70da09849effc0375e",
  },
  proChargebackableVolume: {
    name: "Pro Chargebackable Volume",
    id: "0xe2ada1e143bc3a45398381b4b5bbb9e7ed6ccba40225168f32e9702e0c4e8260",
  },
  topChargebackMerchants: {
    name: "Top Chargeback Merchants",
    id: "0xdf1c64c54745aa1ce00642a5874f97e3183bf5e993c1f559d0a37a4df0b803c7",
  },
  peerPay: {
    name: "Peer Pay",
    id: "0x174b8a29536721a3eae290bfd55651b85a53fc334b971d993fa93ed8dde15e48",
  },
} as const;
const KNOWN_PRODUCTION_GROUP_NAMES = new Map<string, string>(
  Object.values(KNOWN_PRODUCTION_GROUPS).map(({ id, name }) => [id, name]),
);

const TARGET_PAYMENT_METHODS_QUERY = `
  query TargetPaymentMethods(
    $chainId: Int!
    $depositIdPattern: String!
    $paymentMethodHashes: [String!]!
    $limit: Int!
    $offset: Int!
  ) {
    DepositPaymentMethod(
      where: {
        chainId: { _eq: $chainId }
        depositId: { _ilike: $depositIdPattern }
        paymentMethodHash: { _in: $paymentMethodHashes }
        active: { _eq: true }
      }
      order_by: { id: asc }
      limit: $limit
      offset: $offset
    ) {
      depositId
      depositIdOnContract
      paymentMethodHash
    }
  }
`;

const ACTIVE_DEPOSITS_QUERY = `
  query ActiveDeposits($chainId: Int!, $escrow: String!, $limit: Int!, $offset: Int!) {
    Deposit(
      where: {
        chainId: { _eq: $chainId }
        escrowAddress: { _ilike: $escrow }
        status: { _eq: ACTIVE }
      }
      order_by: { depositId: asc }
      limit: $limit
      offset: $offset
    ) {
      id
      depositId
    }
  }
`;

async function postGraphql<T>(
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
  apiKey?: string,
): Promise<T> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: abortController.signal,
    });
    if (!response.ok) throw new Error(`GraphQL request failed with HTTP ${response.status}`);

    const payload = (await response.json()) as GraphqlResponse<T>;
    if (payload.errors?.length || !payload.data) {
      throw new Error(`GraphQL response contained ${payload.errors?.length ?? 0} errors or no data`);
    }
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

function printUsage(): void {
  console.log(`Usage: yarn whitelist:bootstrap

Required environment:
  BOOTSTRAP_RPC_URL
  BOOTSTRAP_INDEXER_GRAPHQL_URL
  WHITELIST_GROUP_IDS                       (comma-separated ordered bytes32 list; at least one)

Optional environment:
  BOOTSTRAP_NETWORK=base_staging|base       (default: base_staging)
  BOOTSTRAP_WHITELIST_POLICY_ADDRESS        (default: WhitelistPolicyMethodScoped network deployment artifact)
  BOOTSTRAP_ESCROW_ADDRESSES                (comma-separated; default: EscrowV2 artifact)
  BOOTSTRAP_EXPECTED_CHAIN_ID               (default: 8453)
  BOOTSTRAP_EXPECTED_DEPOSIT_COUNT          (required for execute and Safe modes)
  BOOTSTRAP_EXPECTED_SELECTION_DIGEST       (required for execute and Safe modes)
  BOOTSTRAP_INDEXER_PAGE_SIZE               (default: 100)
  BOOTSTRAP_MAX_DEPOSITS                    (default: 10000)
  BOOTSTRAP_BATCH_SIZE                      (default: 20)
  BOOTSTRAP_READ_CONCURRENCY                (default: 10; read-only RPC preflight)
  BOOTSTRAP_CONFIRMATIONS                   (default: 1)
  BOOTSTRAP_RECEIPT_RPC_URL                 (optional confirmation-only RPC)
  BOOTSTRAP_RECEIPT_TIMEOUT_MS              (default: 180000)
  BOOTSTRAP_MAX_PRIORITY_FEE_GWEI           (default: 0.001)
  BOOTSTRAP_MAX_FEE_PER_GAS_GWEI            (default: 0.02; hard execution ceiling)
  BOOTSTRAP_INDEXER_API_KEY                 (sent as x-api-key; never logged)
  BOOTSTRAP_ALLOW_COMPLETED=true            (resume only verified prior bootstrap batches)
  BOOTSTRAP_EXECUTE=true                    (default: false/dry-run)
  BOOTSTRAP_CONFIRM_PRODUCTION=true         (required for direct execution on Base)
  BOOTSTRAP_OWNER_PRIVATE_KEY               (required only with BOOTSTRAP_EXECUTE=true)
  BOOTSTRAP_SAFE_OUTPUT_FILE                (unsigned Safe JSON; mutually exclusive with execute)

Validation-only:
  yarn whitelist:bootstrap --self-test

Base safety:
  Every WHITELIST_GROUP_IDS entry must be a known production AddressGroupRegistry group.
`);
}

function parsePositiveInteger(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function parseOptionalNonnegativeInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return value;
}

function parsePositiveGwei(name: string, fallback: string): BigNumber {
  const raw = process.env[name]?.trim() || fallback;
  try {
    const value = ethers.utils.parseUnits(raw, "gwei");
    if (value.lte(0)) throw new Error("nonpositive");
    return value;
  } catch {
    throw new Error(`${name} must be a positive decimal gwei value`);
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeAddress(value: string, label: string): string {
  try {
    return ethers.utils.getAddress(value);
  } catch {
    throw new Error(`${label} is not a valid address`);
  }
}

function normalizeGroupId(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error(`${label} must be a nonzero bytes32 value`);
  }
  return value.toLowerCase();
}

function parseGroupIds(): string[] {
  const groupIds = requireEnvironment("WHITELIST_GROUP_IDS")
    .split(",")
    .map((groupId, index) => normalizeGroupId(
      groupId.trim(),
      `WHITELIST_GROUP_IDS entry ${index + 1}`,
    ));
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error("WHITELIST_GROUP_IDS entries must be distinct");
  }
  return groupIds;
}

function assertKnownBaseGroupIds(groupIds: string[]): void {
  for (const groupId of groupIds) {
    if (!KNOWN_PRODUCTION_GROUP_NAMES.has(groupId)) {
      throw new Error(
        `Unknown Base whitelist group id ${groupId}; known production groups: `
        + [...KNOWN_PRODUCTION_GROUP_NAMES.values()].join(", "),
      );
    }
  }
}

function normalizeSelectionDigest(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a bytes32 value`);
  }
  return value.toLowerCase();
}

function normalizePrivateKey(value: string): string {
  const prefixed = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new Error("BOOTSTRAP_OWNER_PRIVATE_KEY must be a 32-byte hex private key");
  }
  return prefixed;
}

function deploymentAddress(network: "base" | "base_staging", contractName: string): string {
  const artifactPath = path.resolve(__dirname, "..", "deployments", network, `${contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing ${network} deployment artifact for ${contractName}`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { address?: unknown };
  if (typeof artifact.address !== "string") {
    throw new Error(`Invalid ${network} deployment artifact for ${contractName}`);
  }
  return normalizeAddress(artifact.address, `${network}.${contractName}`);
}

function optionalDeploymentAddress(
  network: "base" | "base_staging",
  contractName: string,
): string | undefined {
  const artifactPath = path.resolve(__dirname, "..", "deployments", network, `${contractName}.json`);
  return fs.existsSync(artifactPath) ? deploymentAddress(network, contractName) : undefined;
}

function assertMethodScopedPolicyTarget(
  network: "base" | "base_staging",
  policyAddress: string,
): void {
  const depositScopedPolicy = optionalDeploymentAddress(network, "WhitelistPolicy");
  if (depositScopedPolicy?.toLowerCase() === policyAddress.toLowerCase()) {
    throw new Error(
      `${network} WhitelistPolicy ${policyAddress} is the deposit-scoped policy; `
      + "bootstrap targets WhitelistPolicyMethodScoped only",
    );
  }
}

function loadConfig(): BootstrapConfig {
  const networkValue = process.env.BOOTSTRAP_NETWORK?.trim() || "base_staging";
  if (networkValue !== "base" && networkValue !== "base_staging") {
    throw new Error("BOOTSTRAP_NETWORK must be base_staging or base");
  }
  const network = networkValue;
  const policyAddress = normalizeAddress(
    process.env.BOOTSTRAP_WHITELIST_POLICY_ADDRESS?.trim()
      || deploymentAddress(network, "WhitelistPolicyMethodScoped"),
    "WhitelistPolicyMethodScoped",
  );
  assertMethodScopedPolicyTarget(network, policyAddress);
  const configuredEscrows = process.env.BOOTSTRAP_ESCROW_ADDRESSES
    ?.split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  const escrowAddresses = [
    ...new Map(
      (configuredEscrows?.length ? configuredEscrows : [deploymentAddress(network, "EscrowV2")])
        .map((address) => normalizeAddress(address, "escrow"))
        .map((address) => [address.toLowerCase(), address]),
    ).values(),
  ];

  const groupIds = parseGroupIds();

  const execute = process.env.BOOTSTRAP_EXECUTE === "true";
  const safeOutputFile = process.env.BOOTSTRAP_SAFE_OUTPUT_FILE?.trim();
  if (execute && safeOutputFile) {
    throw new Error("BOOTSTRAP_EXECUTE and BOOTSTRAP_SAFE_OUTPUT_FILE are mutually exclusive");
  }
  const mode = execute ? "execute" : safeOutputFile ? "safe" : "dry-run";
  const expectedDepositCount = parseOptionalNonnegativeInteger("BOOTSTRAP_EXPECTED_DEPOSIT_COUNT");
  const expectedSelectionDigestValue = process.env.BOOTSTRAP_EXPECTED_SELECTION_DIGEST?.trim();
  const expectedSelectionDigest = expectedSelectionDigestValue
    ? normalizeSelectionDigest(expectedSelectionDigestValue, "BOOTSTRAP_EXPECTED_SELECTION_DIGEST")
    : undefined;
  if (mode !== "dry-run" && (expectedDepositCount === undefined || !expectedSelectionDigest)) {
    throw new Error(
      "BOOTSTRAP_EXPECTED_DEPOSIT_COUNT and BOOTSTRAP_EXPECTED_SELECTION_DIGEST are required for execute and Safe modes",
    );
  }
  const config: BootstrapConfig = {
    network,
    expectedChainId: parsePositiveInteger("BOOTSTRAP_EXPECTED_CHAIN_ID", 8453),
    rpcUrl: requireEnvironment("BOOTSTRAP_RPC_URL"),
    receiptRpcUrl: process.env.BOOTSTRAP_RECEIPT_RPC_URL?.trim() || undefined,
    indexerUrl: requireEnvironment("BOOTSTRAP_INDEXER_GRAPHQL_URL"),
    indexerApiKey: process.env.BOOTSTRAP_INDEXER_API_KEY?.trim() || undefined,
    policyAddress,
    escrowAddresses,
    groupIds,
    pageSize: parsePositiveInteger("BOOTSTRAP_INDEXER_PAGE_SIZE", 100, 1_000),
    maxDeposits: parsePositiveInteger("BOOTSTRAP_MAX_DEPOSITS", 10_000, 100_000),
    batchSize: parsePositiveInteger("BOOTSTRAP_BATCH_SIZE", 20, 100),
    readConcurrency: parsePositiveInteger("BOOTSTRAP_READ_CONCURRENCY", 10, 50),
    confirmations: parsePositiveInteger("BOOTSTRAP_CONFIRMATIONS", 1, 100),
    receiptTimeoutMs: parsePositiveInteger("BOOTSTRAP_RECEIPT_TIMEOUT_MS", 180_000, 600_000),
    maxPriorityFeePerGas: parsePositiveGwei("BOOTSTRAP_MAX_PRIORITY_FEE_GWEI", "0.001"),
    maxFeePerGasCap: parsePositiveGwei("BOOTSTRAP_MAX_FEE_PER_GAS_GWEI", "0.02"),
    expectedDepositCount,
    expectedSelectionDigest,
    allowCompleted: process.env.BOOTSTRAP_ALLOW_COMPLETED === "true",
    mode,
    privateKey: execute
      ? normalizePrivateKey(requireEnvironment("BOOTSTRAP_OWNER_PRIVATE_KEY"))
      : undefined,
    safeOutputFile: safeOutputFile ? path.resolve(process.cwd(), safeOutputFile) : undefined,
  };
  if (config.maxPriorityFeePerGas.gte(config.maxFeePerGasCap)) {
    throw new Error("BOOTSTRAP_MAX_PRIORITY_FEE_GWEI must be below BOOTSTRAP_MAX_FEE_PER_GAS_GWEI");
  }

  if (network === "base") {
    const expectedPolicyAddress = deploymentAddress("base", "WhitelistPolicyMethodScoped");
    const expectedEscrowAddress = deploymentAddress("base", "EscrowV2");
    if (policyAddress.toLowerCase() !== expectedPolicyAddress.toLowerCase()) {
      throw new Error(
        `Base bootstrap must use deployed WhitelistPolicyMethodScoped ${expectedPolicyAddress}`,
      );
    }
    if (
      escrowAddresses.length !== 1
      || escrowAddresses[0].toLowerCase() !== expectedEscrowAddress.toLowerCase()
    ) {
      throw new Error(`Base bootstrap must use only deployed EscrowV2 ${expectedEscrowAddress}`);
    }
    if (config.indexerUrl.replace(/\/$/, "") !== PRODUCTION_INDEXER_URL) {
      throw new Error(`Base bootstrap must use production indexer ${PRODUCTION_INDEXER_URL}`);
    }
    assertKnownBaseGroupIds(groupIds);
    if (mode === "execute" && process.env.BOOTSTRAP_CONFIRM_PRODUCTION !== "true") {
      throw new Error("BOOTSTRAP_CONFIRM_PRODUCTION=true is required for direct execution on Base");
    }
  }

  return config;
}

async function loadEligibleDeposits(config: BootstrapConfig): Promise<ActiveDeposit[]> {
  const deposits: ActiveDeposit[] = [];
  const seen = new Set<string>();

  for (const escrowAddress of config.escrowAddresses) {
    const targetMethodsByDeposit = new Map<string, Set<string>>();
    let paymentMethodOffset = 0;
    while (true) {
      const data = await postGraphql<{ DepositPaymentMethod: TargetPaymentMethodRow[] }>(
        config.indexerUrl,
        TARGET_PAYMENT_METHODS_QUERY,
        {
          chainId: config.expectedChainId,
          depositIdPattern: `${escrowAddress.toLowerCase()}_%`,
          paymentMethodHashes: TARGET_PAYMENT_METHOD_HASHES,
          limit: config.pageSize,
          offset: paymentMethodOffset,
        },
        config.indexerApiKey,
      );
      if (!Array.isArray(data.DepositPaymentMethod)) {
        throw new Error("Indexer returned an invalid DepositPaymentMethod result");
      }

      for (const row of data.DepositPaymentMethod) {
        if (
          typeof row.depositId !== "string"
          || (typeof row.depositIdOnContract !== "string" && typeof row.depositIdOnContract !== "number")
          || typeof row.paymentMethodHash !== "string"
        ) {
          throw new Error("Indexer returned an invalid target payment-method row");
        }
        const depositId = BigNumber.from(row.depositIdOnContract);
        if (depositId.isNegative()) throw new Error("Indexer returned a negative depositIdOnContract");
        const expectedEntityId = `${escrowAddress.toLowerCase()}_${depositId.toString()}`;
        if (row.depositId.toLowerCase() !== expectedEntityId) {
          throw new Error(`Indexer returned mismatched deposit entity ${row.depositId}`);
        }
        const paymentMethodHash = row.paymentMethodHash.toLowerCase();
        if (!TARGET_PAYMENT_METHOD_HASH_SET.has(paymentMethodHash)) {
          throw new Error(`Indexer returned unexpected payment method ${paymentMethodHash}`);
        }
        const methods = targetMethodsByDeposit.get(expectedEntityId) || new Set<string>();
        methods.add(paymentMethodHash);
        targetMethodsByDeposit.set(expectedEntityId, methods);
      }

      if (data.DepositPaymentMethod.length < config.pageSize) break;
      paymentMethodOffset += data.DepositPaymentMethod.length;
    }

    let offset = 0;
    while (true) {
      const data = await postGraphql<{ Deposit: Array<{ id: unknown; depositId: unknown }> }>(
        config.indexerUrl,
        ACTIVE_DEPOSITS_QUERY,
        {
          chainId: config.expectedChainId,
          escrow: escrowAddress.toLowerCase(),
          limit: config.pageSize,
          offset,
        },
        config.indexerApiKey,
      );
      if (!Array.isArray(data.Deposit)) {
        throw new Error("Indexer returned an invalid Deposit result");
      }

      for (const row of data.Deposit) {
        if (
          typeof row.id !== "string"
          || (typeof row.depositId !== "string" && typeof row.depositId !== "number")
        ) {
          throw new Error("Indexer returned an invalid depositId");
        }
        const depositId = BigNumber.from(row.depositId);
        if (depositId.isNegative()) throw new Error("Indexer returned a negative depositId");
        const key = `${escrowAddress.toLowerCase()}_${depositId.toString()}`;
        if (row.id.toLowerCase() !== key) {
          throw new Error(`Indexer returned mismatched active deposit entity ${row.id}`);
        }
        const paymentMethodHashes = targetMethodsByDeposit.get(key);
        if (!paymentMethodHashes) continue;
        if (seen.has(key)) throw new Error(`Indexer returned duplicate active deposit ${key}`);
        seen.add(key);
        deposits.push({
          escrowAddress,
          depositId,
          paymentMethodHashes: [...paymentMethodHashes].sort(),
        });
        if (deposits.length > config.maxDeposits) {
          throw new Error(`Indexer returned more than BOOTSTRAP_MAX_DEPOSITS=${config.maxDeposits}`);
        }
      }

      if (data.Deposit.length < config.pageSize) break;
      offset += data.Deposit.length;
    }
  }

  deposits.sort((left, right) => {
    const byEscrow = left.escrowAddress.toLowerCase().localeCompare(right.escrowAddress.toLowerCase());
    if (byEscrow !== 0) return byEscrow;
    return left.depositId.lt(right.depositId) ? -1 : left.depositId.eq(right.depositId) ? 0 : 1;
  });
  return deposits;
}

function buildSelectionDigest(deposits: ActiveDeposit[], groupIds: string[]): string {
  const sortedDeposits = [...deposits].sort((left, right) => {
    const byEscrow = left.escrowAddress.toLowerCase().localeCompare(right.escrowAddress.toLowerCase());
    if (byEscrow !== 0) return byEscrow;
    return left.depositId.lt(right.depositId) ? -1 : left.depositId.eq(right.depositId) ? 0 : 1;
  });
  const depositPayload = sortedDeposits.map((deposit) => [
    deposit.escrowAddress.toLowerCase(),
    deposit.depositId.toString(),
    [...deposit.paymentMethodHashes].sort().join(","),
  ].join(":"));
  const payload = [`groups:${groupIds.join(",")}`, ...depositPayload];
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(payload.join("\n")));
}

function batch<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  callback: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function buildSafeTransaction(
  policyAddress: string,
  escrowAddress: string,
  depositIds: BigNumber[],
  paymentMethodHash: string,
  groupIds: string[],
): SafeTransaction {
  const policyInterface = new ethers.utils.Interface(POLICY_ABI);
  const data = policyInterface.encodeFunctionData("bootstrapDeposits", [
    escrowAddress,
    depositIds,
    paymentMethodHash,
    groupIds,
  ]);
  const decoded = policyInterface.decodeFunctionData("bootstrapDeposits", data);
  if (normalizeAddress(decoded[0], "decoded escrow") !== normalizeAddress(escrowAddress, "escrow")) {
    throw new Error("Generated Safe calldata contains the wrong escrow address");
  }
  const decodedDepositIds = (decoded[1] as BigNumber[]).map((depositId) => depositId.toString());
  if (decodedDepositIds.join(",") !== depositIds.map((depositId) => depositId.toString()).join(",")) {
    throw new Error("Generated Safe calldata contains the wrong deposit ids");
  }
  if (decoded[2].toLowerCase() !== paymentMethodHash.toLowerCase()) {
    throw new Error("Generated Safe calldata contains the wrong payment method");
  }
  const decodedGroupIds = (decoded[3] as string[]).map((groupId) => groupId.toLowerCase());
  if (decodedGroupIds.join(",") !== groupIds.map((groupId) => groupId.toLowerCase()).join(",")) {
    throw new Error("Generated Safe calldata contains the wrong group ids");
  }

  return {
    to: normalizeAddress(policyAddress, "WhitelistPolicy"),
    value: "0",
    data,
    contractMethod: null,
    contractInputsValues: null,
  };
}

export function buildSafeBatch(
  network: string,
  chainId: number,
  policyAddress: string,
  safeAddress: string,
  pendingTargetCount: number,
  transactions: SafeTransaction[],
) {
  if (transactions.length === 0) {
    throw new Error("Refusing to write an empty whitelist bootstrap Safe batch");
  }
  const normalizedPolicy = normalizeAddress(policyAddress, "WhitelistPolicy");
  const normalizedSafe = normalizeAddress(safeAddress, "WhitelistPolicy owner Safe");
  const policyInterface = new ethers.utils.Interface(POLICY_ABI);
  for (const transaction of transactions) {
    if (normalizeAddress(transaction.to, "Safe transaction target") !== normalizedPolicy) {
      throw new Error("Safe batch contains a transaction for a non-policy target");
    }
    if (transaction.value !== "0") throw new Error("Whitelist bootstrap Safe transaction has value");
    const parsed = policyInterface.parseTransaction({ data: transaction.data });
    if (parsed.name !== "bootstrapDeposits") {
      throw new Error("Safe batch contains non-bootstrap policy calldata");
    }
  }

  return {
    version: "1.0",
    chainId: chainId.toString(),
    createdAt: Date.now(),
    meta: {
      name: `ZKP2P whitelist bootstrap - ${network}`,
      description:
        `Bootstrap configured whitelist groups for ${pendingTargetCount} eligible deposit/payment-method tuples `
        + `on chain ${chainId}. `
        + `WhitelistPolicyMethodScoped ${normalizedPolicy}; policy owner Safe ${normalizedSafe}. `
        + "Generated unsigned; review, sign, and submit separately.",
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: normalizedSafe,
      createdFromOwnerAddress: "",
    },
    transactions,
  };
}

async function runSelfTest(): Promise<void> {
  const policyAddress = "0x1000000000000000000000000000000000000001";
  const escrowAddress = "0x2000000000000000000000000000000000000002";
  const safeAddress = "0x3000000000000000000000000000000000000003";
  const depositIds = [BigNumber.from(7), BigNumber.from(42)];
  const groupIds = [
    `0x${"11".repeat(32)}`,
    `0x${"22".repeat(32)}`,
    `0x${"33".repeat(32)}`,
    `0x${"44".repeat(32)}`,
  ];
  const selfTestGroupIds = process.env.WHITELIST_GROUP_IDS;
  try {
    process.env.WHITELIST_GROUP_IDS = groupIds[0];
    if (parseGroupIds().join(",") !== groupIds[0]) {
      throw new Error("Self-test failed to load a one-group whitelist bootstrap config");
    }

    process.env.WHITELIST_GROUP_IDS = groupIds.join(",");
    if (parseGroupIds().join(",") !== groupIds.join(",")) {
      throw new Error("Self-test failed to preserve a multi-group whitelist bootstrap config");
    }

    process.env.WHITELIST_GROUP_IDS = `${groupIds[0]},${groupIds[0]}`;
    try {
      parseGroupIds();
      throw new Error("Self-test accepted duplicate whitelist group ids");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "WHITELIST_GROUP_IDS entries must be distinct") {
        throw error;
      }
    }
  } finally {
    if (selfTestGroupIds === undefined) delete process.env.WHITELIST_GROUP_IDS;
    else process.env.WHITELIST_GROUP_IDS = selfTestGroupIds;
  }
  assertKnownBaseGroupIds([KNOWN_PRODUCTION_GROUPS.peerPay.id]);
  const unknownGroupId = `0x${"55".repeat(32)}`;
  try {
    assertKnownBaseGroupIds([unknownGroupId]);
    throw new Error("Self-test accepted an unknown Base whitelist group id");
  } catch (error) {
    if (
      !(error instanceof Error)
      || !error.message.includes(unknownGroupId)
      || ![...KNOWN_PRODUCTION_GROUP_NAMES.values()].every((name) => error.message.includes(name))
    ) {
      throw error;
    }
  }
  const paymentMethodHash = TARGET_PAYMENT_METHODS[0].hash;
  const transactions = [[groupIds[0]], groupIds].map((selfTestIds) => {
    const transaction = buildSafeTransaction(
      policyAddress,
      escrowAddress,
      depositIds,
      paymentMethodHash,
      selfTestIds,
    );
    const decoded = new ethers.utils.Interface(POLICY_ABI)
      .decodeFunctionData("bootstrapDeposits", transaction.data);
    if (!sameAddressForSelfTest(decoded[0], escrowAddress)) {
      throw new Error("Self-test decoded the wrong escrow address");
    }
    if ((decoded[1] as BigNumber[]).map((value) => value.toString()).join(",") !== "7,42") {
      throw new Error("Self-test decoded the wrong deposit ids");
    }
    if ((decoded[2] as string).toLowerCase() !== paymentMethodHash) {
      throw new Error("Self-test decoded the wrong payment method");
    }
    if ((decoded[3] as string[]).map((value) => value.toLowerCase()).join(",") !== selfTestIds.join(",")) {
      throw new Error("Self-test decoded the wrong group ids");
    }
    return transaction;
  });
  const selectionDeposits: ActiveDeposit[] = [
    {
      escrowAddress,
      depositId: BigNumber.from(7),
      paymentMethodHashes: [TARGET_PAYMENT_METHODS[0].hash],
    },
    {
      escrowAddress,
      depositId: BigNumber.from(42),
      paymentMethodHashes: [TARGET_PAYMENT_METHODS[1].hash, TARGET_PAYMENT_METHODS[2].hash],
    },
  ];
  const selectionDigest = buildSelectionDigest(selectionDeposits, groupIds);
  if (!/^0x[0-9a-f]{64}$/.test(selectionDigest)) {
    throw new Error("Self-test produced an invalid selection digest");
  }
  const oneGroupSelectionDigest = buildSelectionDigest(selectionDeposits, [groupIds[0]]);
  if (selectionDigest === oneGroupSelectionDigest) {
    throw new Error("Self-test selection digest did not bind the configured group ids");
  }
  if (selectionDigest === buildSelectionDigest(selectionDeposits, [...groupIds].reverse())) {
    throw new Error("Self-test selection digest did not bind the configured group order");
  }
  const safeBatch = buildSafeBatch("base", 8453, policyAddress, safeAddress, 2, [transactions[1]]);
  if (safeBatch.chainId !== "8453" || !sameAddressForSelfTest(
    safeBatch.meta.createdFromSafeAddress,
    safeAddress,
  )) {
    throw new Error("Self-test produced invalid Safe metadata");
  }
  const activeEscrow = {
    getDepositPaymentMethodActive: async () => true,
  } as unknown as Contract;
  await assertDepositPaymentMethodStillActive(
    activeEscrow,
    depositIds[0],
    paymentMethodHash,
  );
  const inactiveEscrow = {
    getDepositPaymentMethodActive: async () => false,
  } as unknown as Contract;
  try {
    await assertDepositPaymentMethodStillActive(
      inactiveEscrow,
      depositIds[0],
      paymentMethodHash,
    );
    throw new Error("Self-test accepted an inactive deposit payment method");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(
      `Deposit 7 payment method ${paymentMethodHash} is no longer active`,
    )) {
      throw error;
    }
  }
  console.log("Whitelist bootstrap configuration, calldata, digest, and Safe metadata self-test passed");
}

function sameAddressForSelfTest(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function assertDepositStillExists(escrow: Contract, depositId: BigNumber): Promise<void> {
  const deposit = await escrow.getDeposit(depositId);
  if (deposit.depositor === ethers.constants.AddressZero) {
    throw new Error(`Deposit ${depositId.toString()} no longer exists; indexer discovery is stale`);
  }
}

async function assertDepositPaymentMethodStillActive(
  escrow: Contract,
  depositId: BigNumber,
  paymentMethodHash: string,
): Promise<void> {
  if (!(await escrow.getDepositPaymentMethodActive(depositId, paymentMethodHash))) {
    throw new Error(
      `Deposit ${depositId.toString()} payment method ${paymentMethodHash} is no longer active`,
    );
  }
}

async function assertPolicyOwner(policy: Contract, expectedOwner: string): Promise<void> {
  const currentOwner = normalizeAddress(await policy.owner(), "WhitelistPolicy owner");
  if (currentOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(`WhitelistPolicy owner changed to ${currentOwner}; expected ${expectedOwner}`);
  }
}

async function buildExecutionFeeOverrides(
  provider: ethers.providers.Provider,
  config: BootstrapConfig,
): Promise<{ maxFeePerGas: BigNumber; maxPriorityFeePerGas: BigNumber }> {
  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock.baseFeePerGas) {
    throw new Error("Execution RPC did not return an EIP-1559 base fee");
  }
  const maxFeePerGas = latestBlock.baseFeePerGas.mul(2).add(config.maxPriorityFeePerGas);
  if (maxFeePerGas.gt(config.maxFeePerGasCap)) {
    throw new Error(
      `Required max fee ${ethers.utils.formatUnits(maxFeePerGas, "gwei")} gwei exceeds configured `
      + `${ethers.utils.formatUnits(config.maxFeePerGasCap, "gwei")} gwei ceiling`,
    );
  }
  return { maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas };
}

function sanitizeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of [
    "BOOTSTRAP_OWNER_PRIVATE_KEY",
    "BOOTSTRAP_INDEXER_API_KEY",
    "ALCHEMY_API_KEY",
    "INFURA_TOKEN",
  ]) {
    const secret = process.env[name];
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  return message;
}

async function retryConfirmedRead<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const attempts = 10;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(`${label} failed after ${attempts} attempts: ${sanitizeError(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(`${label} failed unexpectedly`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const config = loadConfig();
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const chain = await provider.getNetwork();
  if (chain.chainId !== config.expectedChainId) {
    throw new Error(`RPC chain id ${chain.chainId} does not match expected ${config.expectedChainId}`);
  }
  if ((await provider.getCode(config.policyAddress)) === "0x") {
    throw new Error(`WhitelistPolicy has no bytecode at ${config.policyAddress}`);
  }
  const receiptProvider = config.receiptRpcUrl
    ? new ethers.providers.JsonRpcProvider(config.receiptRpcUrl)
    : provider;
  if (config.receiptRpcUrl) {
    const receiptChain = await receiptProvider.getNetwork();
    if (receiptChain.chainId !== config.expectedChainId) {
      throw new Error(
        `Receipt RPC chain id ${receiptChain.chainId} does not match expected ${config.expectedChainId}`,
      );
    }
  }
  const stateProvider = provider;
  const confirmedStateProvider = config.mode === "execute" ? receiptProvider : provider;

  const policy = new Contract(config.policyAddress, POLICY_ABI, provider);
  const statePolicy = new Contract(config.policyAddress, POLICY_ABI, stateProvider);
  const confirmedStatePolicy = new Contract(
    config.policyAddress,
    POLICY_ABI,
    confirmedStateProvider,
  );
  const owner = normalizeAddress(await policy.owner(), "WhitelistPolicy owner");
  const groupRegistryAddress = normalizeAddress(await policy.groupRegistry(), "AddressGroupRegistry");
  const groupRegistry = new Contract(groupRegistryAddress, GROUP_REGISTRY_ABI, provider);
  for (const groupId of config.groupIds) {
    if (!(await groupRegistry.groupExists(groupId))) {
      throw new Error(`Configured group does not exist in ${groupRegistryAddress}`);
    }
  }

  const escrows = new Map<string, Contract>();
  const stateEscrows = new Map<string, Contract>();
  for (const escrowAddress of config.escrowAddresses) {
    if ((await provider.getCode(escrowAddress)) === "0x") {
      throw new Error(`Configured escrow has no bytecode at ${escrowAddress}`);
    }
    escrows.set(escrowAddress.toLowerCase(), new Contract(escrowAddress, ESCROW_ABI, provider));
    stateEscrows.set(
      escrowAddress.toLowerCase(),
      new Contract(escrowAddress, ESCROW_ABI, stateProvider),
    );
  }

  const activeDeposits = await loadEligibleDeposits(config);
  const selectionDigest = buildSelectionDigest(activeDeposits, config.groupIds);
  if (
    config.expectedDepositCount !== undefined
    && activeDeposits.length !== config.expectedDepositCount
  ) {
    throw new Error(
      `Discovered ${activeDeposits.length} eligible active deposits; expected ${config.expectedDepositCount}`,
    );
  }
  if (
    config.expectedSelectionDigest !== undefined
    && selectionDigest !== config.expectedSelectionDigest
  ) {
    throw new Error(
      `Selection digest ${selectionDigest} does not match expected ${config.expectedSelectionDigest}`,
    );
  }

  const activeTargets: BootstrapTarget[] = activeDeposits.flatMap((deposit) => (
    deposit.paymentMethodHashes.map((paymentMethodHash) => ({
      escrowAddress: deposit.escrowAddress,
      depositId: deposit.depositId,
      paymentMethodHash,
    }))
  ));
  let evaluatedTargetCount = 0;
  const evaluatedTargets = await mapWithConcurrency(
    activeTargets,
    config.readConcurrency,
    async (target): Promise<{ target: BootstrapTarget; completed: boolean }> => {
      const escrow = escrows.get(target.escrowAddress.toLowerCase())!;
      await assertDepositStillExists(escrow, target.depositId);
      await assertDepositPaymentMethodStillActive(
        escrow,
        target.depositId,
        target.paymentMethodHash,
      );
      const [isBootstrapped, isEnabled] = await Promise.all([
        policy.bootstrapped(target.escrowAddress, target.depositId, target.paymentMethodHash),
        policy.enabled(target.escrowAddress, target.depositId, target.paymentMethodHash),
      ]);
      let completed = false;
      if (isBootstrapped) {
        if (!config.allowCompleted) {
          throw new Error(
            `Active deposit ${target.depositId.toString()} payment method ${target.paymentMethodHash} `
            + "is already bootstrapped; "
            + "set BOOTSTRAP_ALLOW_COMPLETED=true only to resume a verified partial run",
          );
        }
        if (!isEnabled) {
          throw new Error(
            `Previously bootstrapped deposit ${target.depositId.toString()} payment method `
            + `${target.paymentMethodHash} is no longer enabled`,
          );
        }
        const existingGroups = (await policy.getAllowedGroups(
          target.escrowAddress,
          target.depositId,
          target.paymentMethodHash,
        )).map((groupId: string) => groupId.toLowerCase());
        if (!config.groupIds.every((groupId) => existingGroups.includes(groupId))) {
          throw new Error(
            `Previously bootstrapped deposit ${target.depositId.toString()} payment method `
            + `${target.paymentMethodHash} lacks a requested group`,
          );
        }
        completed = true;
      } else if (isEnabled) {
        throw new Error(
          `Active deposit ${target.depositId.toString()} payment method ${target.paymentMethodHash} `
          + "was enabled outside the one-time bootstrap",
        );
      }
      evaluatedTargetCount += 1;
      if (evaluatedTargetCount % 100 === 0 || evaluatedTargetCount === activeTargets.length) {
        console.log(
          `Policy preflight: ${evaluatedTargetCount}/${activeTargets.length} eligible deposit/payment-method tuples checked`,
        );
      }
      return { target, completed };
    },
  );
  const eligibleTargets = evaluatedTargets.filter(({ completed }) => !completed).map(({ target }) => target);
  const completedBeforeRun = evaluatedTargets.length - eligibleTargets.length;

  const grouped = new Map<string, { escrowAddress: string; paymentMethodHash: string; targets: BootstrapTarget[] }>();
  for (const target of eligibleTargets) {
    const key = `${target.escrowAddress.toLowerCase()}:${target.paymentMethodHash.toLowerCase()}`;
    const current = grouped.get(key) || {
      escrowAddress: target.escrowAddress,
      paymentMethodHash: target.paymentMethodHash,
      targets: [],
    };
    current.targets.push(target);
    grouped.set(key, current);
  }

  console.log(`Mode: ${config.mode}`);
  console.log(`Network: ${config.network} (chain ${config.expectedChainId})`);
  console.log(`WhitelistPolicy: ${config.policyAddress}`);
  console.log(`AddressGroupRegistry: ${groupRegistryAddress}`);
  console.log("Whitelist groups:");
  for (const groupId of config.groupIds) {
    console.log(`  ${groupId} (${KNOWN_PRODUCTION_GROUP_NAMES.get(groupId) || "unlisted"})`);
  }
  console.log(`Eligible active deposits discovered: ${activeDeposits.length}`);
  console.log(`Eligible deposit/payment-method tuples discovered: ${activeTargets.length}`);
  console.log(`Selection digest: ${selectionDigest}`);
  for (const targetMethod of TARGET_PAYMENT_METHODS) {
    const count = activeDeposits.filter(({ paymentMethodHashes }) => (
      paymentMethodHashes.includes(targetMethod.hash)
    )).length;
    console.log(`Eligible with ${targetMethod.name}: ${count}`);
  }
  console.log(`Pending tuple bootstrap: ${eligibleTargets.length}`);
  console.log(`Verified completed before this run: ${completedBeforeRun}`);

  let writablePolicy = policy;
  let executionSignerAddress: string | undefined;
  if (config.mode === "execute") {
    const signer = new Wallet(config.privateKey!, stateProvider);
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`Configured signer is not the WhitelistPolicy owner ${owner}`);
    }
    executionSignerAddress = signer.address;
    await assertPolicyOwner(confirmedStatePolicy, signer.address);
    writablePolicy = statePolicy.connect(signer);
  }
  if (config.mode === "safe") {
    if ((await provider.getCode(owner)) === "0x") {
      throw new Error(`WhitelistPolicy owner ${owner} has no bytecode and cannot be used as a Safe`);
    }
    try {
      const threshold = await new Contract(owner, SAFE_ABI, provider).getThreshold();
      if (!BigNumber.isBigNumber(threshold) || threshold.lte(0)) {
        throw new Error("invalid threshold");
      }
    } catch {
      throw new Error(`WhitelistPolicy owner ${owner} does not expose a valid Safe threshold`);
    }
  }

  const safeTransactions: SafeTransaction[] = [];
  const totalBatchCount = [...grouped.values()]
    .reduce((total, { targets }) => total + Math.ceil(targets.length / config.batchSize), 0);
  let processedBatchCount = 0;

  for (const { escrowAddress, paymentMethodHash, targets } of grouped.values()) {
    const escrow = stateEscrows.get(escrowAddress.toLowerCase())!;
    for (const targetBatch of batch(targets, config.batchSize)) {
      const depositIds = targetBatch.map(({ depositId }) => depositId);

      // Re-read both escrow and policy state immediately before simulation/submission. This fails
      // closed if the indexer page became stale or a depositor configured policy after discovery.
      await Promise.all(depositIds.map(async (depositId) => {
        await assertDepositStillExists(escrow, depositId);
        await assertDepositPaymentMethodStillActive(
          escrow,
          depositId,
          paymentMethodHash,
        );
        const [isBootstrapped, isEnabled] = await Promise.all([
          statePolicy.bootstrapped(escrowAddress, depositId, paymentMethodHash),
          statePolicy.enabled(escrowAddress, depositId, paymentMethodHash),
        ]);
        if (isBootstrapped || isEnabled) {
          throw new Error(
            `Deposit ${depositId.toString()} payment method ${paymentMethodHash} changed policy state after discovery`,
          );
        }
      }));
      await assertPolicyOwner(
        config.mode === "execute" ? confirmedStatePolicy : statePolicy,
        config.mode === "execute" ? executionSignerAddress! : owner,
      );
      await statePolicy.callStatic.bootstrapDeposits(
        escrowAddress,
        depositIds,
        paymentMethodHash,
        config.groupIds,
        { from: owner },
      );
      processedBatchCount += 1;

      if (config.mode === "safe") {
        safeTransactions.push(buildSafeTransaction(
          config.policyAddress,
          escrowAddress,
          depositIds,
          paymentMethodHash,
          config.groupIds,
        ));
        continue;
      }
      if (config.mode === "dry-run") {
        if (processedBatchCount % 5 === 0 || processedBatchCount === totalBatchCount) {
          console.log(`Batch simulation: ${processedBatchCount}/${totalBatchCount} passed`);
        }
        continue;
      }
      const transaction = await writablePolicy.bootstrapDeposits(
        escrowAddress,
        depositIds,
        paymentMethodHash,
        config.groupIds,
        await buildExecutionFeeOverrides(stateProvider, config),
      );
      console.log(
        `Submitted bootstrap batch ${processedBatchCount}/${totalBatchCount} `
        + `(${depositIds.length} deposits for ${paymentMethodHash}): ${transaction.hash}`,
      );
      const receipt = await receiptProvider.waitForTransaction(
        transaction.hash,
        config.confirmations,
        config.receiptTimeoutMs,
      );
      if (!receipt) {
        throw new Error(`Timed out waiting for bootstrap transaction ${transaction.hash}`);
      }
      if (receipt.status !== 1) {
        throw new Error(`Bootstrap transaction reverted: ${transaction.hash}`);
      }

      await mapWithConcurrency(depositIds, 2, async (depositId) => {
        const blockTag = { blockTag: receipt.blockNumber };
        const [isBootstrapped, isEnabled, allowedGroupsResult] = await retryConfirmedRead(
          `Confirmed state for deposit ${depositId.toString()}`,
          () => Promise.all([
            confirmedStatePolicy.bootstrapped(escrowAddress, depositId, paymentMethodHash, blockTag),
            confirmedStatePolicy.enabled(escrowAddress, depositId, paymentMethodHash, blockTag),
            confirmedStatePolicy.getAllowedGroups(escrowAddress, depositId, paymentMethodHash, blockTag),
          ]),
        );
        if (!isBootstrapped) {
          throw new Error(
            `Deposit ${depositId.toString()} payment method ${paymentMethodHash} was not marked bootstrapped`,
          );
        }
        if (!isEnabled) {
          throw new Error(`Deposit ${depositId.toString()} payment method ${paymentMethodHash} was not enabled`);
        }
        const allowedGroups = allowedGroupsResult
          .map((groupId: string) => groupId.toLowerCase());
        for (const groupId of config.groupIds) {
          if (!allowedGroups.includes(groupId)) {
            throw new Error(
              `Deposit ${depositId.toString()} payment method ${paymentMethodHash} is missing a configured group`,
            );
          }
        }
      });
    }
  }

  if (config.mode === "execute") {
    await assertPolicyOwner(confirmedStatePolicy, executionSignerAddress!);
  }

  if (config.mode === "safe") {
    if (fs.existsSync(config.safeOutputFile!)) {
      throw new Error(`Refusing to overwrite existing Safe batch ${config.safeOutputFile}`);
    }
    const safeBatch = buildSafeBatch(
      config.network,
      config.expectedChainId,
      config.policyAddress,
      owner,
      eligibleTargets.length,
      safeTransactions,
    );
    fs.mkdirSync(path.dirname(config.safeOutputFile!), { recursive: true });
    fs.writeFileSync(config.safeOutputFile!, `${JSON.stringify(safeBatch, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`Wrote ${safeTransactions.length} unsigned Safe transactions to ${config.safeOutputFile}`);
  }

  console.log(
    config.mode === "execute"
      ? `Bootstrap complete: ${activeTargets.length}/${activeTargets.length} eligible tuples verified`
      : config.mode === "safe"
        ? `Safe batch validation passed: ${eligibleTargets.length} pending tuples in ${safeTransactions.length} transactions`
        : `Dry-run simulation passed: ${eligibleTargets.length} pending, ${completedBeforeRun} already complete, ${activeTargets.length} eligible tuples discovered`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
