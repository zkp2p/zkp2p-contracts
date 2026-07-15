import fs from "fs";
import os from "os";
import path from "path";

import {
  BigNumber,
  Contract,
  ContractReceipt,
  ContractTransaction,
  Wallet,
  ethers,
} from "ethers";

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

const VERIFIER_ABI = [
  "function owner() view returns (address)",
  "function requiredSignatures() view returns (uint256)",
  "function witnesses() view returns (address[])",
  "function isWitness(address) view returns (bool)",
  "function addWitness(address)",
  "function removeWitness(address)",
];

type Json = Record<string, unknown>;
type IntentName =
  | "freeLong"
  | "oversizeBonded"
  | "freeExact"
  | "freeReleased"
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
  nonceSeed: string;
  witnessAddedByRun: boolean;
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
  const nonceSeed = BigInt(
    ethers.utils.keccak256(ethers.utils.randomBytes(32))
  ).toString();
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    deposits: {},
    intents: {},
    transactions: {},
    expectedReverts: {},
    nonceSeed,
    witnessAddedByRun: false,
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

function loadArtifact(relative: string): { abi: unknown[] } {
  const absolute = artifactPath(relative);
  if (!fs.existsSync(absolute)) {
    throw new Error(
      `Missing ${relative}; run forge build in this worktree before scenario execution`
    );
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8")) as { abi: unknown[] };
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
  return output.slice(0, 4_000);
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

function decodeLogs(
  receipt: ContractReceipt,
  contracts: LoadedContracts
): Json[] {
  return receipt.logs.map((log) => {
    for (const [source, iface] of Object.entries(contracts.interfaces)) {
      try {
        const parsed = iface.parseLog(log);
        return {
          source,
          address: log.address,
          logIndex: log.logIndex,
          event: parsed.name,
          signature: parsed.signature,
          args: parsed.args,
        };
      } catch {
        // Try the next ABI. Addresses disambiguate events in the evidence bundle.
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
  `query RiskE2ESync { chain_metadata { chain_id block_height latest_fetched_block_number num_events_processed } }`,
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
          "latest_fetched_block_number",
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

const SNAPSHOT_QUERY = `
query RiskE2ESnapshot(
  $owners: [String!]!
  $takers: [String!]!
  $lps: [String!]!
  $methods: [String!]!
  $intents: [String!]!
) {
  TakerStakeState(where: { taker: { _in: $takers } }) {
    chainId vaultAddress taker stakeOwner delegatedStakeOwner stakeDelegationEnabled
    allowedStakeOwner riskManagerAddress vaultControllerVersion totalStake
    pendingWithdrawalAmount eligibleStake reservedStake freeStake exiting
    exitRequestedAt exitAvailableAt updatedAt
  }
  StakeAccountState(where: { stakeOwner: { _in: $owners } }) {
    chainId vaultAddress stakeOwner totalStake pendingWithdrawalAmount eligibleStake
    reservedStake freeStake exiting exitRequestedAt exitAvailableAt updatedAt
  }
  TakerStakeAuthorization(where: { taker: { _in: $takers } }) {
    chainId vaultAddress taker stakeOwner authorized updatedAt
  }
  TakerStakeDelegationPolicy(where: { taker: { _in: $takers } }) {
    chainId vaultAddress taker enabled allowedStakeOwner updatedAt
  }
  StakeExitState(where: { stakeOwner: { _in: $owners } }) {
    chainId vaultAddress stakeOwner exiting exitRequestedAt exitAvailableAt updatedAt
  }
  StakeWithdrawalState(where: { stakeOwner: { _in: $owners } }) {
    chainId vaultAddress stakeOwner status amount requestedAt availableAt updatedAt
  }
  StakeReservation(where: { intentHash: { _in: $intents } }) {
    chainId vaultAddress intentHash stakeOwner controller originalAmount createdAt
  }
  StakeReservationState(where: { intentHash: { _in: $intents } }) {
    chainId vaultAddress intentHash stakeOwner currentAmount status updatedAt
  }
  StakeReservationSchedule(where: { intentHash: { _in: $intents } }) {
    chainId vaultAddress intentHash releaseTime updatedAt
  }
  RiskPosition(where: { intentHash: { _in: $intents } }) {
    chainId riskManagerAddress intentHash taker stakeOwner lp paymentMethod mode
    consumedFreeTake intentAmount createdAt maxIntentPeriod griefingCliff
    griefingPenaltyBpsPerHour chargebackReserveBps riskWindow maxGriefingBond
    chargebackReserve initialReservation
  }
  RiskPositionState(where: { intentHash: { _in: $intents } }) {
    chainId riskManagerAddress intentHash status currentReservation releasedReservation
    griefingPenalty releasedAmount chargebackCoverage remainingCoverage deferredPayoutAmount
    totalChargebackCompensation cancelledAt settledAt coverageDeadline lastEvidenceId updatedAt
  }
  GriefingRiskState(where: { intentHash: { _in: $intents } }) {
    chainId riskManagerAddress intentHash maxGriefingBond penaltyCharged
    effectiveElapsed chargedAt updatedAt
  }
  ChargebackCoverage(where: { intentHash: { _in: $intents } }) {
    chainId riskManagerAddress intentHash stakeOwner lp paymentMethod mode status
    releasedAmount initialCoverage remainingCoverage uncoveredAmount deferredPayoutAmount
    beneficiary totalCompensated settledAt coverageDeadline updatedAt
  }
  PlatformRiskConfig(where: { paymentMethod: { _in: $methods } }) {
    chainId riskManagerAddress paymentMethod enabled updatedAt
  }
  PlatformChargebackConfig(where: { paymentMethod: { _in: $methods } }) {
    chainId riskManagerAddress paymentMethod chargebackable deferredPayoutEnabled
    reserveBps riskWindow updatedAt
  }
  PlatformGriefingConfig(where: { paymentMethod: { _in: $methods } }) {
    chainId riskManagerAddress paymentMethod griefingCliff griefingPenaltyBpsPerHour
    freeTakeCount freeTakeAmount updatedAt
  }
  FreeTakeUsage(where: { stakeOwner: { _in: $owners }, paymentMethod: { _in: $methods } }) {
    chainId riskManagerAddress stakeOwner paymentMethod freeTakesUsed freeTakeCount
    remainingFreeTakes totalFreeTakeAmount lastIntentHash lastAmount updatedAt
  }
  StakeOwnerRiskSummary(where: { stakeOwner: { _in: $owners } }) {
    chainId riskManagerAddress stakeOwner pendingPositionCount pendingIntentAmount
    pendingMaxGriefingBond pendingInitialReservation activeChargebackPositionCount
    activeChargebackCoverage deferredPayoutCoverage accruedGriefingPenalties
    totalChargebackCompensation updatedAt
  }
  LpRiskExposure(where: { lp: { _in: $lps }, paymentMethod: { _in: $methods } }) {
    chainId riskManagerAddress lp paymentMethod pendingPositionCount pendingIntentAmount
    pendingMaxGriefingBond pendingInitialReservation activeCoveragePositionCount
    activeReleasedAmount remainingCoverage uncoveredExposure deferredPayoutExposure
    maturedPositionCount maturedExposure exhaustedPositionCount exhaustedExposure
    totalGriefingCompensation totalChargebackCompensation updatedAt
  }
  MakerCompensation(where: { maker: { _in: $lps } }) {
    chainId vaultAddress maker claimableAmount updatedAt
  }
  DeferredPayoutState(where: { intentHash: { _in: $intents } }) {
    chainId vaultAddress intentHash beneficiary status amount updatedAt
  }
  DeferredPayoutSchedule(where: { intentHash: { _in: $intents } }) {
    chainId vaultAddress intentHash releaseTime updatedAt
  }
  DeferredPayoutRegistration(where: { intentHash: { _in: $intents } }) {
    chainId riskManagerAddress intentHash beneficiary deferredAmount
    chargebackCoverage coverageDeadline updatedAt
  }
  DepositRiskHook(where: { escrowAddress: { _eq: "${ADDRESSES.escrowV2.toLowerCase()}" } }) {
    chainId orchestratorAddress escrowAddress depositId hook setter updatedAt
  }
  IntentRiskHookState(where: { intentHash: { _in: $intents } }) {
    chainId intentHash orchestratorAddress riskHook requiresPostIntentHook updatedAt
  }
  IntentSettlementState(where: { intentHash: { _in: $intents } }) {
    chainId intentHash orchestratorAddress releasedAmount settledAt updatedAt
  }
  IntentCancellationState(where: { intentHash: { _in: $intents } }) {
    chainId intentHash orchestratorAddress cancelledAt updatedAt
  }
  EscrowIntentPeriodState(where: { escrowAddress: { _eq: "${ADDRESSES.escrowV2.toLowerCase()}" } }) {
    chainId escrowAddress maxIntentPeriod observedFrom updatedAt
  }
}`;

function snapshotVariables(state: RunState): Json {
  const actors = actorAddresses(loadActors());
  return {
    owners: [actors.ownerA, actors.ownerB].map((value) => value.toLowerCase()),
    takers: [
      actors.takerA1,
      actors.takerA2,
      actors.takerB,
      actors.unauthorized,
    ].map((value) => value.toLowerCase()),
    lps: [actors.lpA, actors.lpB].map((value) => value.toLowerCase()),
    methods: Object.values(PAYMENT_METHODS).map((value) => value.toLowerCase()),
    intents: Object.values(state.intents).map((value) => value.toLowerCase()),
  };
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
  return graphql(SNAPSHOT_QUERY, snapshotVariables(state));
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

function graphqlRows(indexer: Json, entity: string): Json[] {
  const data = indexer.data as Json | undefined;
  const rows = data?.[entity];
  if (!Array.isArray(rows))
    throw new Error(`GraphQL response is missing ${entity}`);
  return rows as Json[];
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

  for (const taker of [actors.takerA1, actors.takerA2, actors.takerB]) {
    const owner = await contracts.vault.stakeOwnerOf(taker, call);
    const rows = graphqlRows(indexer, "TakerStakeState");
    const row = rows.find(
      (candidate) =>
        String(candidate.taker).toLowerCase() === taker.toLowerCase()
    );
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
    const immutable = graphqlRows(indexer, "RiskPosition").find(
      (candidate) =>
        String(candidate.intentHash).toLowerCase() === intentHash.toLowerCase()
    );
    const current = graphqlRows(indexer, "RiskPositionState").find(
      (candidate) =>
        String(candidate.intentHash).toLowerCase() === intentHash.toLowerCase()
    );
    if (!immutable || !current)
      throw new Error(
        `Indexer missing risk position rows for ${name}/${intentHash}`
      );
    const position = await contracts.risk.getRiskPosition(intentHash, call);
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
  }

  for (const owner of [actors.ownerA, actors.ownerB]) {
    const used = await contracts.risk.freeTakesUsed(
      owner,
      PAYMENT_METHODS.zelle,
      call
    );
    if (!used.isZero()) {
      const row = graphqlRows(indexer, "FreeTakeUsage").find(
        (candidate) =>
          String(candidate.stakeOwner).toLowerCase() === owner.toLowerCase() &&
          String(candidate.paymentMethod).toLowerCase() ===
            PAYMENT_METHODS.zelle.toLowerCase()
      );
      if (!row) throw new Error(`Indexer missing FreeTakeUsage for ${owner}`);
      assertEqual(row.freeTakesUsed, used, `${owner} indexed free takes used`);
      checks.push({ entity: "FreeTakeUsage", key: owner, result: "PASS" });
    }
  }

  for (const maker of [actors.lpA, actors.lpB]) {
    const expected = await contracts.vault.claimableCompensation(maker, call);
    const row = graphqlRows(indexer, "MakerCompensation").find(
      (candidate) =>
        String(candidate.maker).toLowerCase() === maker.toLowerCase()
    );
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
    graphql: {
      query: SNAPSHOT_QUERY,
      variables: snapshotVariables(state),
      response: indexer,
    },
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
  "chargebacks: temporarily authorize 0x84 witness, submit partial/capped/replay claims, aggregate compensation, restore witness set",
  "cleanup: remove temporary witness if necessary and emit final contract/indexer reconciliation snapshot",
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
  const existing = state.transactions[label];
  if (existing) {
    if (!existing.indexerSync && existing.blockNumber) {
      existing.indexerSync = await waitForIndexer(Number(existing.blockNumber));
      if (options.reconcile) {
        existing.postOnchain = await contractSnapshot(
          contracts,
          state,
          Number(existing.blockNumber)
        );
        const response = await indexedSnapshot(state);
        existing.graphql = {
          query: SNAPSHOT_QUERY,
          variables: snapshotVariables(state),
          response,
        };
        existing.reconciliation = await assertIndexedReconciliation(
          response,
          contracts,
          state,
          Number(existing.blockNumber)
        );
      }
      state.transactions[label] = existing;
      saveState(state);
      writeEvidence(label, existing);
    }
    return existing;
  }

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
  const transaction = (await connected[method](...args)) as ContractTransaction;
  const receipt = await transaction.wait();
  const block = await provider.getBlock(receipt.blockNumber);
  const evidence: Json = {
    label,
    submittedAtUtc: new Date().toISOString(),
    actor: signer.address,
    contract: contract.address,
    method,
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    blockTimestamp: block.timestamp,
    gasUsed: receipt.gasUsed,
    decodedLogs: decodeLogs(receipt, contracts),
    preOnchain,
  };
  if (receipt.status !== 1)
    throw new Error(
      `${label} reverted in transaction ${receipt.transactionHash}`
    );
  options.afterReceipt?.(evidence);
  state.transactions[label] = evidence;
  saveState(state);

  const sync = await waitForIndexer(receipt.blockNumber);
  evidence.indexerSync = sync;
  if (options.reconcile) {
    evidence.postOnchain = await contractSnapshot(
      contracts,
      state,
      receipt.blockNumber
    );
    const response = await indexedSnapshot(state);
    evidence.graphql = {
      query: SNAPSHOT_QUERY,
      variables: snapshotVariables(state),
      response,
    };
    try {
      evidence.reconciliation = await assertIndexedReconciliation(
        response,
        contracts,
        state,
        receipt.blockNumber
      );
    } catch (error) {
      evidence.reconciliationError = redact(error);
      state.transactions[label] = evidence;
      saveState(state);
      writeEvidence(label, evidence);
      throw error;
    }
  }
  state.transactions[label] = evidence;
  saveState(state);
  writeEvidence(label, evidence);
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
  if (state.transactions[label]) return;
  const balance = await provider.getBalance(recipient);
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
  const value = target.sub(balance);
  await provider.call({ from: governance.address, to: recipient, value });
  requireMutationFlag();
  const transaction = await governance.sendTransaction({
    to: recipient,
    value,
  });
  const receipt = await transaction.wait();
  const block = await provider.getBlock(receipt.blockNumber);
  const evidence = {
    label,
    actor: governance.address,
    recipient,
    asset: "ETH",
    amount: value,
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    blockTimestamp: block.timestamp,
    gasUsed: receipt.gasUsed,
    indexerSync: await waitForIndexer(receipt.blockNumber),
  };
  state.transactions[label] = evidence;
  saveState(state);
  writeEvidence(label, evidence);
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
  if (state.intents[intentName]) return state.intents[intentName] as string;
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
  if (state.transactions[label]) return;
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

async function preflight(
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
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
  ] = await Promise.all([
    contracts.risk.owner(),
    contracts.vault.owner(),
    contracts.orchestrator.owner(),
    contracts.vault.stakeToken(),
    contracts.vault.controller(),
    contracts.risk.orchestrator(),
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

  const [zelle, venmo, maxIntentPeriod] = await Promise.all([
    contracts.risk.getPlatformRiskConfig(PAYMENT_METHODS.zelle),
    contracts.risk.getPlatformRiskConfig(PAYMENT_METHODS.venmo),
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

  const sync = await waitForIndexer(latestBlock);
  const [onchain, indexer] = await Promise.all([
    contractSnapshot(contracts, state, latestBlock),
    indexedSnapshot(state),
  ]);
  const evidence = {
    label: "00.preflight",
    observedAtUtc: new Date().toISOString(),
    chainId: network.chainId,
    latestBlock,
    governance: governance.address,
    actorAddresses: actorAddresses(loadActors()),
    sync,
    verifiedConfig: { zelle, venmo, maxIntentPeriod },
    onchain,
    graphql: {
      query: SNAPSHOT_QUERY,
      variables: snapshotVariables(state),
      response: indexer,
    },
  };
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
    if (!state.deposits[role]) {
      await runAction(
        `03.${role}.create-deposit`,
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
    }
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

function chargebackAttestation(
  state: RunState,
  index: bigint,
  intentHash: string,
  paymentMethod: string,
  chargebackAmount: string,
  now: number
): Json {
  const modulus = (1n << 256n) - 100n;
  return {
    chainId: EXPECTED_CHAIN_ID,
    riskManager: ADDRESSES.riskManager,
    orchestrator: ADDRESSES.orchestratorV3,
    intentHash,
    paymentMethod,
    chargebackAmount,
    evidenceId: ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(
        `affine-risk-staging-e2e:${intentHash}:${index.toString()}`
      )
    ),
    nonce: ((BigInt(state.nonceSeed) % modulus) + index).toString(),
    validAfter: now - 60,
    validUntil: now + 3_600,
  };
}

async function signedChargeback(
  label: string,
  attestation: Json,
  governance: Wallet,
  caller: Wallet,
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<Json> {
  const digest = await contracts.risk.hashChargebackAttestation(attestation);
  const signature = ethers.utils.joinSignature(
    governance._signingKey().signDigest(digest)
  );
  return runAction(
    label,
    caller,
    contracts.risk,
    "submitChargeback",
    [attestation, [signature], "0x"],
    provider,
    contracts,
    state,
    { reconcile: true }
  );
}

async function cleanupWitness(
  verifier: Contract,
  governance: Wallet,
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<void> {
  if (!state.witnessAddedByRun) return;
  if (!(await verifier.isWitness(EXPECTED_GOVERNANCE))) {
    state.witnessAddedByRun = false;
    saveState(state);
    return;
  }
  await runAction(
    "10.governance.remove-temporary-witness",
    governance,
    verifier,
    "removeWitness",
    [EXPECTED_GOVERNANCE],
    provider,
    contracts,
    state,
    {
      reconcile: true,
      afterReceipt: () => {
        state.witnessAddedByRun = false;
      },
    }
  );
}

async function chargebacks(
  provider: ethers.providers.JsonRpcProvider,
  contracts: LoadedContracts,
  state: RunState
): Promise<void> {
  requireMutationFlag();
  const settled = state.intents.chargebackSettled;
  const deferred = state.intents.deferredSettled;
  if (!settled || !deferred) throw new Error("Run fast before chargebacks");
  const governance = deployer(provider);
  const caller = actorWallet("caller", provider);
  const lpA = actorWallet("lpA", provider);
  const lpB = actorWallet("lpB", provider);
  const verifierAddress = await contracts.risk.attestationVerifier();
  const verifier = new Contract(verifierAddress, VERIFIER_ABI, provider);
  assertEqual(
    await verifier.owner(),
    EXPECTED_GOVERNANCE,
    "attestation verifier owner"
  );
  assertEqual(
    await verifier.requiredSignatures(),
    "1",
    "attestation verifier threshold"
  );

  const wasWitness = await verifier.isWitness(EXPECTED_GOVERNANCE);
  if (
    !wasWitness &&
    !state.transactions["10.governance.add-temporary-witness"]
  ) {
    await runAction(
      "10.governance.add-temporary-witness",
      governance,
      verifier,
      "addWitness",
      [EXPECTED_GOVERNANCE],
      provider,
      contracts,
      state,
      {
        reconcile: true,
        afterReceipt: () => {
          state.witnessAddedByRun = true;
        },
      }
    );
  } else if (!wasWitness) {
    throw new Error(
      "Temporary witness transaction is recorded but signer is not currently a witness"
    );
  }

  try {
    const now = (await provider.getBlock("latest")).timestamp;
    const partial = chargebackAttestation(
      state,
      1n,
      settled,
      PAYMENT_METHODS.venmo,
      "750000",
      now
    );
    await signedChargeback(
      "10.chargeback.stake.partial-750000",
      partial,
      governance,
      caller,
      provider,
      contracts,
      state
    );
    const partialDigest = await contracts.risk.hashChargebackAttestation(
      partial
    );
    const partialSignature = ethers.utils.joinSignature(
      governance._signingKey().signDigest(partialDigest)
    );
    await expectRevert(
      "10.chargeback.replay-nonce-reverts",
      caller,
      contracts.risk,
      "submitChargeback",
      [partial, [partialSignature], "0x"],
      state
    );

    const capped = chargebackAttestation(
      state,
      2n,
      settled,
      PAYMENT_METHODS.venmo,
      "5000000",
      now
    );
    await signedChargeback(
      "10.chargeback.stake.capped-to-remaining",
      capped,
      governance,
      caller,
      provider,
      contracts,
      state
    );
    const lpAClaimable = await contracts.vault.claimableCompensation(
      lpA.address
    );
    assertEqual(lpAClaimable, "2000000", "LP A aggregate compensation");
    await runAction(
      "10.compensation.lpA.withdraw-all",
      lpA,
      contracts.vault,
      "withdrawCompensation",
      [lpA.address],
      provider,
      contracts,
      state,
      { reconcile: true }
    );
    assertEqual(
      await contracts.vault.claimableCompensation(lpA.address),
      "0",
      "LP A post-withdraw compensation"
    );

    const deferredPartial = chargebackAttestation(
      state,
      3n,
      deferred,
      PAYMENT_METHODS.venmo,
      "400000",
      now
    );
    await signedChargeback(
      "10.chargeback.deferred.partial-400000",
      deferredPartial,
      governance,
      caller,
      provider,
      contracts,
      state
    );
    assertEqual(
      await contracts.vault.claimableCompensation(lpB.address),
      "400000",
      "LP B compensation"
    );
    const deferredPayout = await contracts.vault.getDeferredPayout(deferred);
    assertEqual(deferredPayout.amount, "600000", "remaining deferred payout");
    await runAction(
      "10.compensation.lpB.withdraw-all",
      lpB,
      contracts.vault,
      "withdrawCompensation",
      [lpB.address],
      provider,
      contracts,
      state,
      { reconcile: true }
    );
  } finally {
    if (!wasWitness)
      await cleanupWitness(verifier, governance, provider, contracts, state);
  }

  const block = await provider.getBlockNumber();
  await saveSynchronizedSnapshot(
    "10.chargebacks-complete",
    block,
    contracts,
    state
  );
  printJson({
    chargebacks: "PASS",
    witnessRestored: !(await verifier.isWitness(EXPECTED_GOVERNANCE)),
    block,
  });
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

  if (command === "preflight") return preflight(provider, contracts, state);
  if (command === "setup") return setup(provider, contracts, state);
  if (command === "fast") return fastScenarios(provider, contracts, state);
  if (command === "after-cliff") return afterCliff(provider, contracts, state);
  if (command === "chargebacks") return chargebacks(provider, contracts, state);
  if (command === "reconcile")
    return finalReconciliation(provider, contracts, state);
  if (command === "cleanup-witness") {
    const governance = deployer(provider);
    const verifierAddress = await contracts.risk.attestationVerifier();
    const verifier = new Contract(verifierAddress, VERIFIER_ABI, provider);
    await cleanupWitness(verifier, governance, provider, contracts, state);
    return printJson({
      cleanupWitness: "COMPLETE",
      isWitness: await verifier.isWitness(governance.address),
    });
  }
  if (command === "execute") {
    await preflight(provider, contracts, state);
    await setup(provider, contracts, state);
    await fastScenarios(provider, contracts, state);
    await chargebacks(provider, contracts, state);
    try {
      await afterCliff(provider, contracts, state);
    } catch (error) {
      if (!redact(error).includes("after-cliff is not ready")) throw error;
      printJson({ afterCliff: "PENDING_NATURAL_WAIT", detail: redact(error) });
    }
    return finalReconciliation(provider, contracts, state);
  }
  throw new Error(
    "Usage: affineRiskScenarioRunner.ts <plan|preflight|setup|fast|after-cliff|chargebacks|reconcile|cleanup-witness|execute>"
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`affine-risk-scenario: ${redact(error)}\n`);
  process.exitCode = 1;
});
