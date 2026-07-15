import fs from "fs";
import os from "os";
import path from "path";

import dotenv from "dotenv";
import {
  BigNumber,
  Contract,
  ContractReceipt,
  ContractTransaction,
  Wallet,
  ethers,
} from "ethers";

export const EXPECTED_CHAIN_ID = 8453;
export const EXPECTED_GOVERNANCE = "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929";
const DEFAULT_ACTOR_FILE = path.join(
  os.tmpdir(),
  "zkp2p-affine-risk-e2e",
  "actors.json"
);

export const ADDRESSES = {
  orchestratorV3: "0x79dE2123eE792e77165b2E6E65A54B745E8A734E",
  stakeVault: "0x5c570D2be2bFD8960B2B9F8d2D3C8148A1e24C5f",
  riskManager: "0x57E4b9046EA5ABCe1fc688b77D846aE67222b998",
  deferredPayoutHook: "0xd279997e057b22ecC4660C7bBaD82FF0017B08A9",
  escrowV2: "0x77e8f808FE201075e0bD651CD46fdF239fc83265",
  orchestratorRegistry: "0xfA6384EB6176cfEC049540526A3d2126C3666d8A",
  escrowRegistry: "0xc545f336eC77E69bf115729acCbf2e557A00ac91",
  paymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

const DEPLOYMENTS = {
  orchestratorV3: {
    block: 48_667_836,
    tx: "0xfe001ee1326c34824c1ba64eba9a597f7331bf2415eebfbf0de0d9bf60cd725d",
  },
  stakeVault: {
    block: 48_667_841,
    tx: "0x4b9a3183cdf085e1cd655fe1fd05bcada1777538c44d4a79a3001e05466a43d8",
  },
  riskManager: {
    block: 48_667_846,
    tx: "0xee3873ec064c797c4adb668812ce060788e8880bbef2fb4f7d36a98bd8368e28",
  },
  deferredPayoutHook: {
    block: 48_667_851,
    tx: "0x766d2bfa8ce32aaf5f48a7ff133b2c4bbea7915e1c6d5cb803f9705898b269b4",
  },
} as const;

export const PAYMENT_METHODS = {
  venmo: "0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268",
  paypal: "0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f",
  zelle: "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3",
} as const;

const ABIS = {
  orchestrator: [
    "function owner() view returns (address)",
    "function chainId() view returns (uint256)",
    "function escrowRegistry() view returns (address)",
    "function paymentVerifierRegistry() view returns (address)",
    "function relayerRegistry() view returns (address)",
    "function protocolFee() view returns (uint256)",
    "function protocolFeeRecipient() view returns (address)",
    "function allowMultipleIntents() view returns (bool)",
    "function paused() view returns (bool)",
    "function riskCallbackGasLimit() view returns (uint256)",
  ],
  vault: [
    "function owner() view returns (address)",
    "function stakeToken() view returns (address)",
    "function controller() view returns (address)",
    "function baseExitDelay() view returns (uint64)",
    "function controllerChangeDelay() view returns (uint64)",
    "function depositsPaused() view returns (bool)",
    "function reservationsPaused() view returns (bool)",
    "function totalStaked() view returns (uint256)",
    "function totalDeferredPayouts() view returns (uint256)",
    "function totalClaimableCompensation() view returns (uint256)",
    "function totalLiabilities() view returns (uint256)",
    "function depositStake(uint256 amount)",
    "function depositStakeFor(address taker,uint256 amount)",
    "function setTakerAuthorization(address taker,bool authorized)",
    "function stakeBalance(address staker) view returns (uint256)",
    "function reservedStake(address staker) view returns (uint256)",
    "function freeStake(address staker) view returns (uint256)",
    "function stakeOwnerOf(address taker) view returns (address)",
  ],
  risk: [
    "function owner() view returns (address)",
    "function orchestrator() view returns (address)",
    "function stakeVault() view returns (address)",
    "function attestationVerifier() view returns (address)",
    "function deferredPayoutHook() view returns (address)",
    "function admissionPaused() view returns (bool)",
    "function getPlatformRiskConfig(bytes32 paymentMethod) view returns ((bool enabled,(bool chargebackable,bool deferredPayoutEnabled,uint16 reserveBps,uint64 riskWindow) chargeback,(uint64 griefingCliff,uint32 griefingPenaltyBpsPerHour,uint32 freeTakeCount,uint256 freeTakeAmount) griefing))",
    "function calculateMaxGriefingBond(uint256 amount,uint64 maxIntentPeriod,(uint64 griefingCliff,uint32 griefingPenaltyBpsPerHour,uint32 freeTakeCount,uint256 freeTakeAmount) config) pure returns (uint256)",
    "function calculateChargebackReserve(uint256 amount,uint16 reserveBps) pure returns (uint256)",
    "function calculateRequiredReservation(uint256 amount,uint64 maxIntentPeriod,(bool enabled,(bool chargebackable,bool deferredPayoutEnabled,uint16 reserveBps,uint64 riskWindow) chargeback,(uint64 griefingCliff,uint32 griefingPenaltyBpsPerHour,uint32 freeTakeCount,uint256 freeTakeAmount) griefing) config) pure returns (uint256,uint256,uint256)",
  ],
  hook: [
    "function payoutToken() view returns (address)",
    "function stakeVault() view returns (address)",
    "function riskManager() view returns (address)",
    "function orchestratorRegistry() view returns (address)",
  ],
  escrow: [
    "function owner() view returns (address)",
    "function orchestratorRegistry() view returns (address)",
    "function paymentVerifierRegistry() view returns (address)",
    "function chainId() view returns (uint256)",
    "function paused() view returns (bool)",
    "function depositCounter() view returns (uint256)",
    "function dustThreshold() view returns (uint256)",
    "function maxIntentsPerDeposit() view returns (uint256)",
    "function intentExpirationPeriod() view returns (uint256)",
  ],
  token: [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address account) view returns (uint256)",
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
    "function transfer(address to,uint256 amount) returns (bool)",
  ],
  orchestratorRegistry: [
    "function owner() view returns (address)",
    "function isOrchestrator(address) view returns (bool)",
  ],
  escrowRegistry: [
    "function acceptAllEscrows() view returns (bool)",
    "function isWhitelistedEscrow(address) view returns (bool)",
  ],
};

export type ActorRecord = Record<
  string,
  { address: string; privateKey: string }
>;

export function loadEnvironment(): void {
  const envPath = process.env.CONTRACTS_ENV_PATH;
  if (!envPath)
    throw new Error("CONTRACTS_ENV_PATH must point to the contracts repo .env");
  const result = dotenv.config({ path: envPath });
  if (result.error) throw new Error("Unable to load CONTRACTS_ENV_PATH");
}

export function rpcUrl(): string {
  if (process.env.E2E_RPC_URL) return process.env.E2E_RPC_URL;
  if (process.env.INFURA_TOKEN)
    return `https://base-mainnet.infura.io/v3/${process.env.INFURA_TOKEN}`;
  return "https://developer-access-mainnet.base.org";
}

export function deployer(provider: ethers.providers.Provider): Wallet {
  const rawKey = process.env.BASE_DEPLOY_PRIVATE_KEY;
  if (!rawKey) throw new Error("BASE_DEPLOY_PRIVATE_KEY is missing");
  const normalizedKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  const wallet = new Wallet(normalizedKey, provider);
  if (wallet.address.toLowerCase() !== EXPECTED_GOVERNANCE.toLowerCase()) {
    throw new Error(
      `Configured key derives to unexpected address ${wallet.address}`
    );
  }
  return wallet;
}

export function normalize(value: unknown): unknown {
  if (BigNumber.isBigNumber(value)) return value.toString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/^\d+$/.test(key))
      .map(([key, child]) => [key, normalize(child)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(normalize(value), null, 2)}\n`);
}

export function actorFile(): string {
  return process.env.E2E_ACTORS_FILE || DEFAULT_ACTOR_FILE;
}

export function loadActors(): ActorRecord {
  const file = actorFile();
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0)
    throw new Error("Actor file permissions must be 0600");
  return JSON.parse(fs.readFileSync(file, "utf8")) as ActorRecord;
}

export function actorAddresses(actors: ActorRecord): Record<string, string> {
  return Object.fromEntries(
    Object.entries(actors).map(([role, actor]) => [role, actor.address])
  );
}

async function prepareActors(): Promise<void> {
  const file = actorFile();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const roles = [
      "ownerA",
      "ownerB",
      "takerA1",
      "takerA2",
      "takerB",
      "lpA",
      "lpB",
      "recipient",
      "unauthorized",
      "caller",
    ];
    const actors = Object.fromEntries(
      roles.map((role) => {
        const wallet = Wallet.createRandom();
        return [
          role,
          { address: wallet.address, privateKey: wallet.privateKey },
        ];
      })
    );
    const temporaryFile = `${file}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(actors, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryFile, file);
    fs.chmodSync(file, 0o600);
  }
  printJson({
    actorFileStoredPrivately: file,
    addresses: actorAddresses(loadActors()),
  });
}

async function baseline(
  provider: ethers.providers.JsonRpcProvider
): Promise<void> {
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID)
    throw new Error(`Unexpected chain ${network.chainId}`);
  const signer = deployer(provider);

  const contracts = {
    orchestrator: new Contract(
      ADDRESSES.orchestratorV3,
      ABIS.orchestrator,
      provider
    ),
    vault: new Contract(ADDRESSES.stakeVault, ABIS.vault, provider),
    risk: new Contract(ADDRESSES.riskManager, ABIS.risk, provider),
    hook: new Contract(ADDRESSES.deferredPayoutHook, ABIS.hook, provider),
    escrow: new Contract(ADDRESSES.escrowV2, ABIS.escrow, provider),
    token: new Contract(ADDRESSES.usdc, ABIS.token, provider),
    orchestratorRegistry: new Contract(
      ADDRESSES.orchestratorRegistry,
      ABIS.orchestratorRegistry,
      provider
    ),
    escrowRegistry: new Contract(
      ADDRESSES.escrowRegistry,
      ABIS.escrowRegistry,
      provider
    ),
  };

  const deploymentEvidence = await Promise.all(
    Object.entries(DEPLOYMENTS).map(async ([name, deployment]) => {
      const address = ADDRESSES[name as keyof typeof DEPLOYMENTS];
      const [code, receipt, block] = await Promise.all([
        provider.getCode(address),
        provider.getTransactionReceipt(deployment.tx),
        provider.getBlock(deployment.block),
      ]);
      return {
        name,
        address,
        transactionHash: deployment.tx,
        receiptStatus: receipt.status,
        receiptContractAddress: receipt.contractAddress,
        blockNumber: deployment.block,
        blockHash: block.hash,
        blockTimestamp: block.timestamp,
        codeSizeBytes: (code.length - 2) / 2,
        codeHash: ethers.utils.keccak256(code),
      };
    })
  );

  const [venmoConfig, paypalConfig, zelleConfig] = await Promise.all(
    Object.values(PAYMENT_METHODS).map((paymentMethod) =>
      contracts.risk.getPlatformRiskConfig(paymentMethod)
    )
  );

  printJson({
    observedAtUtc: new Date().toISOString(),
    chainId: network.chainId,
    latestBlock: await provider.getBlockNumber(),
    governanceSigner: signer.address,
    deploymentEvidence,
    token: {
      address: ADDRESSES.usdc,
      name: await contracts.token.name(),
      symbol: await contracts.token.symbol(),
      decimals: await contracts.token.decimals(),
      governanceBalance: await contracts.token.balanceOf(signer.address),
      vaultBalance: await contracts.token.balanceOf(ADDRESSES.stakeVault),
      hookBalance: await contracts.token.balanceOf(
        ADDRESSES.deferredPayoutHook
      ),
    },
    orchestrator: {
      address: ADDRESSES.orchestratorV3,
      owner: await contracts.orchestrator.owner(),
      chainId: await contracts.orchestrator.chainId(),
      escrowRegistry: await contracts.orchestrator.escrowRegistry(),
      paymentVerifierRegistry:
        await contracts.orchestrator.paymentVerifierRegistry(),
      relayerRegistry: await contracts.orchestrator.relayerRegistry(),
      protocolFee: await contracts.orchestrator.protocolFee(),
      protocolFeeRecipient: await contracts.orchestrator.protocolFeeRecipient(),
      allowMultipleIntents: await contracts.orchestrator.allowMultipleIntents(),
      paused: await contracts.orchestrator.paused(),
      riskCallbackGasLimit: await contracts.orchestrator.riskCallbackGasLimit(),
    },
    vault: {
      address: ADDRESSES.stakeVault,
      owner: await contracts.vault.owner(),
      stakeToken: await contracts.vault.stakeToken(),
      controller: await contracts.vault.controller(),
      baseExitDelay: await contracts.vault.baseExitDelay(),
      controllerChangeDelay: await contracts.vault.controllerChangeDelay(),
      depositsPaused: await contracts.vault.depositsPaused(),
      reservationsPaused: await contracts.vault.reservationsPaused(),
      totalStaked: await contracts.vault.totalStaked(),
      totalDeferredPayouts: await contracts.vault.totalDeferredPayouts(),
      totalClaimableCompensation:
        await contracts.vault.totalClaimableCompensation(),
      totalLiabilities: await contracts.vault.totalLiabilities(),
    },
    risk: {
      address: ADDRESSES.riskManager,
      owner: await contracts.risk.owner(),
      orchestrator: await contracts.risk.orchestrator(),
      stakeVault: await contracts.risk.stakeVault(),
      attestationVerifier: await contracts.risk.attestationVerifier(),
      deferredPayoutHook: await contracts.risk.deferredPayoutHook(),
      admissionPaused: await contracts.risk.admissionPaused(),
      platformConfigs: {
        venmo: venmoConfig,
        paypal: paypalConfig,
        zelle: zelleConfig,
      },
    },
    hook: {
      address: ADDRESSES.deferredPayoutHook,
      payoutToken: await contracts.hook.payoutToken(),
      stakeVault: await contracts.hook.stakeVault(),
      riskManager: await contracts.hook.riskManager(),
      orchestratorRegistry: await contracts.hook.orchestratorRegistry(),
    },
    escrow: {
      address: ADDRESSES.escrowV2,
      owner: await contracts.escrow.owner(),
      orchestratorRegistry: await contracts.escrow.orchestratorRegistry(),
      paymentVerifierRegistry: await contracts.escrow.paymentVerifierRegistry(),
      chainId: await contracts.escrow.chainId(),
      paused: await contracts.escrow.paused(),
      depositCounter: await contracts.escrow.depositCounter(),
      dustThreshold: await contracts.escrow.dustThreshold(),
      maxIntentsPerDeposit: await contracts.escrow.maxIntentsPerDeposit(),
      intentExpirationPeriod: await contracts.escrow.intentExpirationPeriod(),
      whitelisted: await contracts.escrowRegistry.isWhitelistedEscrow(
        ADDRESSES.escrowV2
      ),
    },
    registry: {
      owner: await contracts.orchestratorRegistry.owner(),
      orchestratorAllowed: await contracts.orchestratorRegistry.isOrchestrator(
        ADDRESSES.orchestratorV3
      ),
    },
  });
}

export function requireMutationFlag(): void {
  if (process.env.E2E_ALLOW_MUTATION !== "YES") {
    throw new Error(
      "Set E2E_ALLOW_MUTATION=YES explicitly before any transaction command"
    );
  }
}

export async function receiptEvidence(
  provider: ethers.providers.JsonRpcProvider,
  transaction: ContractTransaction
): Promise<Record<string, unknown>> {
  const receipt: ContractReceipt = await transaction.wait();
  const block = await provider.getBlock(receipt.blockNumber);
  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    blockTimestamp: block.timestamp,
    gasUsed: receipt.gasUsed,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      logIndex: log.logIndex,
    })),
  };
}

async function fundActors(
  provider: ethers.providers.JsonRpcProvider
): Promise<void> {
  requireMutationFlag();
  const governance = deployer(provider);
  const actors = loadActors();
  const nativeWei = BigNumber.from(
    process.env.E2E_ACTOR_NATIVE_WEI || "250000000000000"
  );
  const usdcUnits = BigNumber.from(
    process.env.E2E_ACTOR_USDC_UNITS || "2000000"
  );
  const token = new Contract(ADDRESSES.usdc, ABIS.token, governance);
  const evidence: Record<string, unknown>[] = [];

  for (const [role, actor] of Object.entries(actors)) {
    const nativeBalance = await provider.getBalance(actor.address);
    if (nativeBalance.lt(nativeWei)) {
      const transaction = await governance.sendTransaction({
        to: actor.address,
        value: nativeWei.sub(nativeBalance),
      });
      evidence.push({
        role,
        asset: "ETH",
        ...(await receiptEvidence(
          provider,
          transaction as ContractTransaction
        )),
      });
    }
    if (["ownerA", "ownerB", "lpA", "lpB"].includes(role)) {
      const tokenBalance = await token.balanceOf(actor.address);
      if (tokenBalance.lt(usdcUnits)) {
        const transaction = await token.transfer(
          actor.address,
          usdcUnits.sub(tokenBalance)
        );
        evidence.push({
          role,
          asset: "USDC",
          ...(await receiptEvidence(provider, transaction)),
        });
      }
    }
  }

  printJson({
    fundedAtUtc: new Date().toISOString(),
    actors: actorAddresses(actors),
    evidence,
  });
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function math(amountRaw: string): void {
  const amount = BigInt(amountRaw);
  const maxIntentPeriod = 3_600n;
  const griefingCliff = 900n;
  const slope = 10n;
  const griefingNumerator = amount * slope * (maxIntentPeriod - griefingCliff);
  const griefingDenominator = 10_000n * 3_600n;
  const maxGriefingBond = ceilDiv(griefingNumerator, griefingDenominator);
  const chargebackReserve = ceilDiv(amount * 10_000n, 10_000n);
  printJson({
    amount,
    maxIntentPeriod,
    griefingCliff,
    maxChargeableTime: maxIntentPeriod - griefingCliff,
    griefingNumerator,
    griefingDenominator,
    maxGriefingBond,
    chargebackReserve,
    requiredNonChargebackable: maxGriefingBond,
    requiredChargebackable:
      maxGriefingBond > chargebackReserve ? maxGriefingBond : chargebackReserve,
  });
}

async function main(): Promise<void> {
  loadEnvironment();
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl());
  const command = process.argv[2];
  if (command === "baseline") return baseline(provider);
  if (command === "prepare-actors") return prepareActors();
  if (command === "show-actors")
    return printJson({ addresses: actorAddresses(loadActors()) });
  if (command === "fund-actors") return fundActors(provider);
  if (command === "math") return math(process.argv[3] || "1000000");
  throw new Error(
    "Usage: affineRiskE2E.ts <baseline|prepare-actors|show-actors|fund-actors|math> [amountRaw]"
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`affine-risk-e2e: ${message}\n`);
    process.exitCode = 1;
  });
}
