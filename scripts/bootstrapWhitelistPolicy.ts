import "module-alias/register";

import fs from "fs";
import path from "path";

import { BigNumber, Contract, Wallet, ethers } from "ethers";

type ActiveDeposit = {
  escrowAddress: string;
  depositId: BigNumber;
};

type BootstrapConfig = {
  network: "base" | "base_staging";
  expectedChainId: number;
  rpcUrl: string;
  indexerUrl: string;
  indexerApiKey?: string;
  policyAddress: string;
  escrowAddresses: string[];
  groupIds: string[];
  pageSize: number;
  maxDeposits: number;
  batchSize: number;
  confirmations: number;
  expectedDepositCount?: number;
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
  "function bootstrapped(address,uint256) view returns (bool)",
  "function enabled(address,uint256) view returns (bool)",
  "function getAllowedGroups(address,uint256) view returns (bytes32[])",
  "function bootstrapDeposits(address,uint256[],bytes32[])",
];

const GROUP_REGISTRY_ABI = [
  "function groupExists(bytes32) view returns (bool)",
];

const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
];

const ESCROW_ABI = [
  "function getDeposit(uint256) view returns (tuple(address depositor,address delegate,address token,tuple(uint256 min,uint256 max) intentAmountRange,bool acceptingIntents,uint256 remainingDeposits,uint256 outstandingIntentAmount,address intentGuardian,bool retainOnEmpty))",
];

const ACTIVE_DEPOSITS_QUERY = `
  query ActiveDeposits($chainId: Int!, $escrow: String!, $limit: Int!, $offset: Int!) {
    Deposit(
      where: {
        chainId: { _eq: $chainId }
        escrowAddress: { _eq: $escrow }
        status: { _eq: ACTIVE }
      }
      order_by: { depositId: asc }
      limit: $limit
      offset: $offset
    ) {
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
  WHITELIST_PRO_GROUP_ID
  WHITELIST_PLUS_GROUP_ID

Optional environment:
  BOOTSTRAP_NETWORK=base_staging|base       (default: base_staging)
  BOOTSTRAP_WHITELIST_POLICY_ADDRESS        (default: network deployment artifact)
  BOOTSTRAP_ESCROW_ADDRESSES                (comma-separated; default: EscrowV2 artifact)
  BOOTSTRAP_EXPECTED_CHAIN_ID               (default: 8453)
  BOOTSTRAP_EXPECTED_DEPOSIT_COUNT          (required for execute and Safe modes)
  BOOTSTRAP_INDEXER_PAGE_SIZE               (default: 100)
  BOOTSTRAP_MAX_DEPOSITS                    (default: 10000)
  BOOTSTRAP_BATCH_SIZE                      (default: 20)
  BOOTSTRAP_CONFIRMATIONS                   (default: 1)
  BOOTSTRAP_INDEXER_API_KEY                 (sent as x-api-key; never logged)
  BOOTSTRAP_ALLOW_COMPLETED=true            (resume only verified prior bootstrap batches)
  BOOTSTRAP_EXECUTE=true                    (default: false/dry-run)
  BOOTSTRAP_OWNER_PRIVATE_KEY               (required only with BOOTSTRAP_EXECUTE=true)
  BOOTSTRAP_SAFE_OUTPUT_FILE                (unsigned Safe JSON; mutually exclusive with execute)

Validation-only:
  yarn whitelist:bootstrap --self-test
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

function loadConfig(): BootstrapConfig {
  const networkValue = process.env.BOOTSTRAP_NETWORK?.trim() || "base_staging";
  if (networkValue !== "base" && networkValue !== "base_staging") {
    throw new Error("BOOTSTRAP_NETWORK must be base_staging or base");
  }
  const network = networkValue;
  const policyAddress = normalizeAddress(
    process.env.BOOTSTRAP_WHITELIST_POLICY_ADDRESS?.trim()
      || deploymentAddress(network, "WhitelistPolicy"),
    "WhitelistPolicy",
  );
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

  const groupIds = [
    normalizeGroupId(requireEnvironment("WHITELIST_PRO_GROUP_ID"), "WHITELIST_PRO_GROUP_ID"),
    normalizeGroupId(requireEnvironment("WHITELIST_PLUS_GROUP_ID"), "WHITELIST_PLUS_GROUP_ID"),
  ];
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error("PRO and PLUS group ids must be distinct");
  }

  const execute = process.env.BOOTSTRAP_EXECUTE === "true";
  const safeOutputFile = process.env.BOOTSTRAP_SAFE_OUTPUT_FILE?.trim();
  if (execute && safeOutputFile) {
    throw new Error("BOOTSTRAP_EXECUTE and BOOTSTRAP_SAFE_OUTPUT_FILE are mutually exclusive");
  }
  const mode = execute ? "execute" : safeOutputFile ? "safe" : "dry-run";
  const expectedDepositCount = parseOptionalNonnegativeInteger("BOOTSTRAP_EXPECTED_DEPOSIT_COUNT");
  if (mode !== "dry-run" && expectedDepositCount === undefined) {
    throw new Error("BOOTSTRAP_EXPECTED_DEPOSIT_COUNT is required for execute and Safe modes");
  }
  return {
    network,
    expectedChainId: parsePositiveInteger("BOOTSTRAP_EXPECTED_CHAIN_ID", 8453),
    rpcUrl: requireEnvironment("BOOTSTRAP_RPC_URL"),
    indexerUrl: requireEnvironment("BOOTSTRAP_INDEXER_GRAPHQL_URL"),
    indexerApiKey: process.env.BOOTSTRAP_INDEXER_API_KEY?.trim() || undefined,
    policyAddress,
    escrowAddresses,
    groupIds,
    pageSize: parsePositiveInteger("BOOTSTRAP_INDEXER_PAGE_SIZE", 100, 1_000),
    maxDeposits: parsePositiveInteger("BOOTSTRAP_MAX_DEPOSITS", 10_000, 100_000),
    batchSize: parsePositiveInteger("BOOTSTRAP_BATCH_SIZE", 20, 100),
    confirmations: parsePositiveInteger("BOOTSTRAP_CONFIRMATIONS", 1, 100),
    expectedDepositCount,
    allowCompleted: process.env.BOOTSTRAP_ALLOW_COMPLETED === "true",
    mode,
    privateKey: execute
      ? normalizePrivateKey(requireEnvironment("BOOTSTRAP_OWNER_PRIVATE_KEY"))
      : undefined,
    safeOutputFile: safeOutputFile ? path.resolve(process.cwd(), safeOutputFile) : undefined,
  };
}

async function loadActiveDeposits(config: BootstrapConfig): Promise<ActiveDeposit[]> {
  const deposits: ActiveDeposit[] = [];
  const seen = new Set<string>();

  for (const escrowAddress of config.escrowAddresses) {
    let offset = 0;
    while (true) {
      const data = await postGraphql<{ Deposit: Array<{ depositId: unknown }> }>(
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
        if (typeof row.depositId !== "string" && typeof row.depositId !== "number") {
          throw new Error("Indexer returned an invalid depositId");
        }
        const depositId = BigNumber.from(row.depositId);
        if (depositId.isNegative()) throw new Error("Indexer returned a negative depositId");
        const key = `${escrowAddress.toLowerCase()}_${depositId.toString()}`;
        if (seen.has(key)) throw new Error(`Indexer returned duplicate active deposit ${key}`);
        seen.add(key);
        deposits.push({ escrowAddress, depositId });
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

function batch<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

export function buildSafeTransaction(
  policyAddress: string,
  escrowAddress: string,
  depositIds: BigNumber[],
  groupIds: string[],
): SafeTransaction {
  const policyInterface = new ethers.utils.Interface(POLICY_ABI);
  const data = policyInterface.encodeFunctionData("bootstrapDeposits", [
    escrowAddress,
    depositIds,
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
  const decodedGroupIds = (decoded[2] as string[]).map((groupId) => groupId.toLowerCase());
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
  pendingActiveDepositCount: number,
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
        `Bootstrap PRO and PLUS groups for ${pendingActiveDepositCount} active deposits on chain ${chainId}. `
        + `WhitelistPolicy ${normalizedPolicy}; policy owner Safe ${normalizedSafe}. `
        + "Generated unsigned; review, sign, and submit separately.",
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: normalizedSafe,
      createdFromOwnerAddress: "",
    },
    transactions,
  };
}

function runSelfTest(): void {
  const policyAddress = "0x1000000000000000000000000000000000000001";
  const escrowAddress = "0x2000000000000000000000000000000000000002";
  const safeAddress = "0x3000000000000000000000000000000000000003";
  const depositIds = [BigNumber.from(7), BigNumber.from(42)];
  const groupIds = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
  const transaction = buildSafeTransaction(policyAddress, escrowAddress, depositIds, groupIds);
  const decoded = new ethers.utils.Interface(POLICY_ABI)
    .decodeFunctionData("bootstrapDeposits", transaction.data);
  if (!sameAddressForSelfTest(decoded[0], escrowAddress)) {
    throw new Error("Self-test decoded the wrong escrow address");
  }
  if ((decoded[1] as BigNumber[]).map((value) => value.toString()).join(",") !== "7,42") {
    throw new Error("Self-test decoded the wrong deposit ids");
  }
  if ((decoded[2] as string[]).map((value) => value.toLowerCase()).join(",") !== groupIds.join(",")) {
    throw new Error("Self-test decoded the wrong group ids");
  }
  const safeBatch = buildSafeBatch("base", 8453, policyAddress, safeAddress, 2, [transaction]);
  if (safeBatch.chainId !== "8453" || !sameAddressForSelfTest(
    safeBatch.meta.createdFromSafeAddress,
    safeAddress,
  )) {
    throw new Error("Self-test produced invalid Safe metadata");
  }
  console.log("Whitelist bootstrap raw calldata and Safe metadata self-test passed");
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

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
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

  const policy = new Contract(config.policyAddress, POLICY_ABI, provider);
  const owner = normalizeAddress(await policy.owner(), "WhitelistPolicy owner");
  const groupRegistryAddress = normalizeAddress(await policy.groupRegistry(), "AddressGroupRegistry");
  const groupRegistry = new Contract(groupRegistryAddress, GROUP_REGISTRY_ABI, provider);
  for (const groupId of config.groupIds) {
    if (!(await groupRegistry.groupExists(groupId))) {
      throw new Error(`Configured group does not exist in ${groupRegistryAddress}`);
    }
  }

  const escrows = new Map<string, Contract>();
  for (const escrowAddress of config.escrowAddresses) {
    if ((await provider.getCode(escrowAddress)) === "0x") {
      throw new Error(`Configured escrow has no bytecode at ${escrowAddress}`);
    }
    escrows.set(escrowAddress.toLowerCase(), new Contract(escrowAddress, ESCROW_ABI, provider));
  }

  const activeDeposits = await loadActiveDeposits(config);
  if (
    config.expectedDepositCount !== undefined
    && activeDeposits.length !== config.expectedDepositCount
  ) {
    throw new Error(
      `Discovered ${activeDeposits.length} active deposits; expected ${config.expectedDepositCount}`,
    );
  }

  const eligible: ActiveDeposit[] = [];
  let completedBeforeRun = 0;
  for (const deposit of activeDeposits) {
    const escrow = escrows.get(deposit.escrowAddress.toLowerCase())!;
    await assertDepositStillExists(escrow, deposit.depositId);
    if (await policy.bootstrapped(deposit.escrowAddress, deposit.depositId)) {
      if (!config.allowCompleted) {
        throw new Error(
          `Active deposit ${deposit.depositId.toString()} is already bootstrapped; `
          + "set BOOTSTRAP_ALLOW_COMPLETED=true only to resume a verified partial run",
        );
      }
      if (!(await policy.enabled(deposit.escrowAddress, deposit.depositId))) {
        throw new Error(`Previously bootstrapped deposit ${deposit.depositId.toString()} is no longer enabled`);
      }
      const existingGroups = (await policy.getAllowedGroups(
        deposit.escrowAddress,
        deposit.depositId,
      )).map((groupId: string) => groupId.toLowerCase());
      if (!config.groupIds.every((groupId) => existingGroups.includes(groupId))) {
        throw new Error(
          `Previously bootstrapped deposit ${deposit.depositId.toString()} lacks a requested group`,
        );
      }
      completedBeforeRun += 1;
      continue;
    }
    if (await policy.enabled(deposit.escrowAddress, deposit.depositId)) {
      throw new Error(
        `Active deposit ${deposit.depositId.toString()} was enabled outside the one-time bootstrap`,
      );
    }
    eligible.push(deposit);
  }

  const grouped = new Map<string, ActiveDeposit[]>();
  for (const deposit of eligible) {
    const current = grouped.get(deposit.escrowAddress) || [];
    current.push(deposit);
    grouped.set(deposit.escrowAddress, current);
  }

  console.log(`Mode: ${config.mode}`);
  console.log(`Network: ${config.network} (chain ${config.expectedChainId})`);
  console.log(`WhitelistPolicy: ${config.policyAddress}`);
  console.log(`AddressGroupRegistry: ${groupRegistryAddress}`);
  console.log(`Active deposits discovered: ${activeDeposits.length}`);
  console.log(`Pending bootstrap: ${eligible.length}`);
  console.log(`Verified completed before this run: ${completedBeforeRun}`);

  let writablePolicy = policy;
  if (config.mode === "execute") {
    const signer = new Wallet(config.privateKey!, provider);
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`Configured signer is not the WhitelistPolicy owner ${owner}`);
    }
    writablePolicy = policy.connect(signer);
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

  for (const [escrowAddress, deposits] of grouped) {
    const escrow = escrows.get(escrowAddress.toLowerCase())!;
    for (const depositBatch of batch(deposits, config.batchSize)) {
      const depositIds = depositBatch.map(({ depositId }) => depositId);

      // Re-read both escrow and policy state immediately before simulation/submission. This fails
      // closed if the indexer page became stale or a depositor configured policy after discovery.
      for (const depositId of depositIds) {
        await assertDepositStillExists(escrow, depositId);
        if (
          await policy.bootstrapped(escrowAddress, depositId)
          || await policy.enabled(escrowAddress, depositId)
        ) {
          throw new Error(`Deposit ${depositId.toString()} changed policy state after discovery`);
        }
      }
      await policy.callStatic.bootstrapDeposits(
        escrowAddress,
        depositIds,
        config.groupIds,
        { from: owner },
      );

      if (config.mode === "safe") {
        safeTransactions.push(buildSafeTransaction(
          config.policyAddress,
          escrowAddress,
          depositIds,
          config.groupIds,
        ));
        continue;
      }
      if (config.mode === "dry-run") continue;
      const transaction = await writablePolicy.bootstrapDeposits(
        escrowAddress,
        depositIds,
        config.groupIds,
      );
      console.log(`Submitted bootstrap batch (${depositIds.length} deposits): ${transaction.hash}`);
      await transaction.wait(config.confirmations);

      for (const depositId of depositIds) {
        if (!(await policy.bootstrapped(escrowAddress, depositId))) {
          throw new Error(`Deposit ${depositId.toString()} was not marked bootstrapped`);
        }
        if (!(await policy.enabled(escrowAddress, depositId))) {
          throw new Error(`Deposit ${depositId.toString()} was not enabled`);
        }
        const allowedGroups = (await policy.getAllowedGroups(escrowAddress, depositId))
          .map((groupId: string) => groupId.toLowerCase());
        for (const groupId of config.groupIds) {
          if (!allowedGroups.includes(groupId)) {
            throw new Error(`Deposit ${depositId.toString()} is missing a configured group`);
          }
        }
      }
    }
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
      eligible.length,
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
      ? `Bootstrap complete: ${activeDeposits.length}/${activeDeposits.length} active deposits verified`
      : config.mode === "safe"
        ? `Safe batch validation passed: ${eligible.length} pending deposits in ${safeTransactions.length} transactions`
        : `Dry-run simulation passed: ${eligible.length} pending, ${completedBeforeRun} already complete, ${activeDeposits.length} discovered`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
