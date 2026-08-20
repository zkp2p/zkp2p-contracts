import { readFileSync } from "fs";
import { ethers } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  DisputeSafeBatchManifest,
  NormalizedSafeBatchTransaction,
  SafeBatchTransactionInput,
  normalizeSafeTransactions,
  validateSafeBatchManifest,
} from "../deployments/safeBatchManifest";
import {
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
} from "../deployments/parameters";
import { PREDECESSOR_DISPUTE_STACKS } from "../deploy/32_deploy_and_activate_dispute_lifecycle_stack";

export const BASE_SAFE = "0x0bC26FF515411396DD588Abd6Ef6846E04470227";
export const BASE_SAFE_RUNTIME_HASH =
  "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000";
export const MULTI_SEND_CALL_ONLY =
  "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";
export const MULTI_SEND_CALL_ONLY_RUNTIME_HASH =
  "0xa9865ac2d9c7a1591619b188c4d88167b50df6cc0c5327fcbd1c8c75f7c066ad";

const safeInterface = new ethers.utils.Interface([
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function simulateAndRevert(address targetContract,bytes calldataPayload)",
]);
const multiSendInterface = new ethers.utils.Interface([
  "function multiSend(bytes transactions)",
]);

export type DisputePostconditionConfig = {
  safe: string;
  disputeVerifier: string;
  disputeRegistry: string;
  predecessorPolicy: string;
  predecessorVault: string;
  freshVault: string;
  freshPolicy: string;
  freshHook: string;
  orchestrator: string;
  paymentMethods: string[];
  riskWindows: Array<string | number>;
};

export function packMultiSendTransactions(
  transactions: readonly SafeBatchTransactionInput[]
): string {
  const normalized = normalizeSafeTransactions(transactions);
  return `0x${normalized
    .map((transaction) => {
      const operation = ethers.utils
        .hexZeroPad(ethers.utils.hexlify(transaction.operation), 1)
        .slice(2);
      const target = transaction.to.slice(2);
      const value = ethers.utils
        .hexZeroPad(ethers.BigNumber.from(transaction.value).toHexString(), 32)
        .slice(2);
      const dataLength = ethers.utils
        .hexZeroPad(
          ethers.BigNumber.from(
            ethers.utils.arrayify(transaction.data).length
          ).toHexString(),
          32
        )
        .slice(2);
      return `${operation}${target}${value}${dataLength}${transaction.data.slice(
        2
      )}`;
    })
    .join("")}`;
}

export function encodeMultiSendCalldata(
  transactions: readonly SafeBatchTransactionInput[]
): string {
  return multiSendInterface.encodeFunctionData("multiSend", [
    packMultiSendTransactions(transactions),
  ]);
}

export function decodeSafeSimulationEnvelope(data: string): {
  success: boolean;
  returnData: string;
} {
  try {
    const bytes = ethers.utils.arrayify(data);
    if (bytes.length < 64) throw new Error();
    const successWord = ethers.BigNumber.from(bytes.slice(0, 32));
    if (!successWord.isZero() && !successWord.eq(1)) throw new Error();
    const returnDataLength = ethers.BigNumber.from(bytes.slice(32, 64));
    if (returnDataLength.gt(String(Number.MAX_SAFE_INTEGER))) throw new Error();
    const length = returnDataLength.toNumber();
    if (bytes.length !== 64 + length) throw new Error();
    return {
      success: successWord.eq(1),
      returnData: ethers.utils.hexlify(bytes.slice(64)),
    };
  } catch {
    throw new Error("Invalid Safe simulation envelope");
  }
}

export function appendSimulationPostcondition(
  persisted: readonly SafeBatchTransactionInput[],
  assertionAddress: string,
  assertionData: string
): NormalizedSafeBatchTransaction[] {
  return normalizeSafeTransactions([
    ...persisted,
    { to: assertionAddress, value: "0", data: assertionData, operation: 0 },
  ]);
}

function extractRevertData(error: any): string | undefined {
  const candidates = [
    error?.data?.data,
    error?.data,
    error?.error?.data,
    error?.error?.error?.data,
  ];
  return candidates.find(
    (candidate) => typeof candidate === "string" && candidate.startsWith("0x")
  );
}

export function requireRuntimeHash(
  code: string,
  expectedHash: string,
  label: string
): void {
  if (code === "0x" || ethers.utils.keccak256(code) !== expectedHash) {
    throw new Error(`${label} runtime bytecode hash mismatch`);
  }
}

async function assertRuntime(
  hre: HardhatRuntimeEnvironment,
  address: string,
  expectedHash: string,
  label: string
): Promise<void> {
  const code = await hre.ethers.provider.getCode(address);
  requireRuntimeHash(code, expectedHash, label);
}

async function resetPinnedBaseFork(
  hre: HardhatRuntimeEnvironment,
  forkRpcUrl: string,
  blockNumber: number,
  blockHash: string
): Promise<any> {
  if (!forkRpcUrl)
    throw new Error("BASE_FORK_RPC_URL is required for Safe batch simulation");
  await hre.network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: forkRpcUrl, blockNumber } }],
  });
  const block = await hre.ethers.provider.getBlock(blockNumber);
  if (!block || block.hash.toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error("Safe simulation block hash mismatch");
  }
  await assertRuntime(hre, BASE_SAFE, BASE_SAFE_RUNTIME_HASH, "Safe v1.3.0");
  await assertRuntime(
    hre,
    MULTI_SEND_CALL_ONLY,
    MULTI_SEND_CALL_ONLY_RUNTIME_HASH,
    "MultiSendCallOnly"
  );
  const safe = new ethers.Contract(
    BASE_SAFE,
    safeInterface,
    hre.ethers.provider
  );
  if ((await safe.VERSION()) !== "1.3.0")
    throw new Error("Unsupported Safe version");
  return safe;
}

async function callSafeSimulation(
  hre: HardhatRuntimeEnvironment,
  transactions: readonly SafeBatchTransactionInput[]
): Promise<{ success: boolean; returnData: string }> {
  const multiSendCalldata = encodeMultiSendCalldata(transactions);
  const simulationCalldata = safeInterface.encodeFunctionData(
    "simulateAndRevert",
    [MULTI_SEND_CALL_ONLY, multiSendCalldata]
  );
  let envelope: string | undefined;
  try {
    await hre.ethers.provider.call({ to: BASE_SAFE, data: simulationCalldata });
  } catch (error) {
    envelope = extractRevertData(error);
  }
  if (!envelope)
    throw new Error(
      "Safe simulation did not return its deliberate revert envelope"
    );
  return decodeSafeSimulationEnvelope(envelope);
}

export async function simulateDisputeOptInSafeBatch(
  hre: HardhatRuntimeEnvironment,
  manifest: DisputeSafeBatchManifest,
  postconditions: DisputePostconditionConfig,
  forkRpcUrl: string
): Promise<void> {
  validateSafeBatchManifest(manifest);
  if (manifest.safe.toLowerCase() !== BASE_SAFE.toLowerCase()) {
    throw new Error("Safe manifest does not target the pinned ZKP2P Base Safe");
  }
  if (postconditions.safe.toLowerCase() !== BASE_SAFE.toLowerCase()) {
    throw new Error(
      "Safe postcondition owner does not match the pinned ZKP2P Base Safe"
    );
  }
  const safe = await resetPinnedBaseFork(
    hre,
    forkRpcUrl,
    manifest.simulationBlockNumber,
    manifest.simulationBlockHash
  );
  if (!(await safe.nonce()).eq(manifest.safeNonce))
    throw new Error("Safe nonce drifted before simulation");

  const assertionFactory = await hre.ethers.getContractFactory(
    "DisputeLifecyclePostcondition"
  );
  const assertion = await assertionFactory.deploy(
    postconditions.safe,
    postconditions.disputeVerifier,
    postconditions.disputeRegistry,
    postconditions.predecessorPolicy,
    postconditions.predecessorVault,
    postconditions.freshVault,
    postconditions.freshPolicy,
    postconditions.freshHook,
    postconditions.orchestrator,
    postconditions.paymentMethods,
    postconditions.riskWindows
  );
  await assertion.deployed();
  const assertionData = assertion.interface.encodeFunctionData(
    "assertPostconditions"
  );
  const simulatedTransactions = appendSimulationPostcondition(
    manifest.transactions,
    assertion.address,
    assertionData
  );
  const result = await callSafeSimulation(hre, simulatedTransactions);
  if (!result.success)
    throw new Error(
      `Atomic Safe batch simulation failed: ${result.returnData}`
    );
}

export async function simulateObsoleteDisputeSafeBatchInvalidation(
  hre: HardhatRuntimeEnvironment,
  transactions: readonly SafeBatchTransactionInput[],
  forkRpcUrl: string,
  blockNumber: number,
  blockHash: string
): Promise<void> {
  const normalized = normalizeSafeTransactions(transactions);
  if (normalized.length !== 4)
    throw new Error(
      "Obsolete dispute Safe batch must contain exactly four calls"
    );
  await resetPinnedBaseFork(hre, forkRpcUrl, blockNumber, blockHash);
  const predecessor = PREDECESSOR_DISPUTE_STACKS.base;
  const ownedInterface = new ethers.utils.Interface([
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
  ]);
  for (const [label, address] of [
    ["predecessor StakeVault", predecessor.contracts.StakeVault.address],
    [
      "predecessor policy",
      predecessor.contracts.DisputeProtectionPolicy.address,
    ],
  ] as const) {
    const contract = new ethers.Contract(
      address,
      ownedInterface,
      hre.ethers.provider
    );
    if (
      (await contract.pendingOwner()).toLowerCase() !==
        ethers.constants.AddressZero.toLowerCase() ||
      (await contract.owner()).toLowerCase() !==
        "0x84e113087c97cd80ea9d78983d4b8ff61eca1929"
    )
      throw new Error(
        `${label} ownership cancellation is not present on the pinned fork`
      );
  }
  let secondCallReverted = false;
  try {
    await hre.ethers.provider.call({
      from: BASE_SAFE,
      to: normalized[1].to,
      value: normalized[1].value,
      data: normalized[1].data,
    });
  } catch {
    secondCallReverted = true;
  }
  if (!secondCallReverted)
    throw new Error(
      "Obsolete predecessor StakeVault ownership call is still executable"
    );
  const result = await callSafeSimulation(hre, normalized);
  if (result.success)
    throw new Error(
      "Obsolete Base dispute Safe batch unexpectedly remains executable"
    );
}

function paymentMethodHash(method: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(method));
}

export async function buildBasePostconditionConfig(
  _hre?: HardhatRuntimeEnvironment
): Promise<DisputePostconditionConfig> {
  const predecessor = PREDECESSOR_DISPUTE_STACKS.base;
  const freshVault = require("../deployments/base/StakeVaultOptIn.json");
  const freshPolicy = require("../deployments/base/DisputeProtectionPolicyOptIn.json");
  const freshHook = require("../deployments/base/IntentLifecycleHookV1OptIn.json");
  const orchestrator = require("../deployments/base/OrchestratorV3.json");
  return {
    safe: BASE_SAFE,
    disputeVerifier: predecessor.contracts.DisputeVerifier.address,
    disputeRegistry: predecessor.contracts.DisputeNullifierRegistry.address,
    predecessorPolicy: predecessor.contracts.DisputeProtectionPolicy.address,
    predecessorVault: predecessor.contracts.StakeVault.address,
    freshVault: freshVault.address,
    freshPolicy: freshPolicy.address,
    freshHook: freshHook.address,
    orchestrator: orchestrator.address,
    paymentMethods: DISPUTABLE_PAYMENT_METHODS.map(paymentMethodHash),
    riskWindows: DISPUTABLE_PAYMENT_METHODS.map(() =>
      DISPUTE_RISK_WINDOW.base.toString()
    ),
  };
}

async function main(): Promise<void> {
  const inlinePayload = process.env.DISPUTE_SAFE_SIMULATION_PAYLOAD;
  if (inlinePayload) {
    const hre: HardhatRuntimeEnvironment = require("hardhat");
    const payload = JSON.parse(inlinePayload) as {
      manifest: DisputeSafeBatchManifest;
      postconditions: DisputePostconditionConfig;
    };
    await simulateDisputeOptInSafeBatch(
      hre,
      validateSafeBatchManifest(payload.manifest),
      payload.postconditions,
      process.env.BASE_FORK_RPC_URL || ""
    );
    return;
  }
  const obsoleteBatchIndex = process.argv.indexOf("--obsolete-batch");
  if (obsoleteBatchIndex >= 0) {
    const obsoleteBatchPath = process.argv[obsoleteBatchIndex + 1];
    if (!obsoleteBatchPath) throw new Error("--obsolete-batch requires a path");
    const forkRpcUrl = process.env.BASE_FORK_RPC_URL || "";
    if (!forkRpcUrl)
      throw new Error(
        "BASE_FORK_RPC_URL is required for obsolete-batch simulation"
      );
    const batch = JSON.parse(readFileSync(obsoleteBatchPath, "utf8"));
    const {
      assertObsoleteBaseBatchShape,
    } = require("../deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts");
    const transactions = assertObsoleteBaseBatchShape(batch);
    const liveProvider = new ethers.providers.JsonRpcProvider(forkRpcUrl);
    const block = await liveProvider.getBlock("latest");
    if (!block?.hash)
      throw new Error(
        "Could not pin the latest Base block for obsolete-batch simulation"
      );
    const hre: HardhatRuntimeEnvironment = require("hardhat");
    await simulateObsoleteDisputeSafeBatchInvalidation(
      hre,
      transactions,
      forkRpcUrl,
      block.number,
      block.hash
    );
    console.log(
      `Obsolete Base dispute Safe batch is atomically invalid at block ${block.number} (${block.hash}).`
    );
    return;
  }
  const batchIndex = process.argv.indexOf("--batch");
  const sidecarIndex = process.argv.indexOf("--sidecar");
  if (
    batchIndex < 0 ||
    sidecarIndex < 0 ||
    !process.argv[batchIndex + 1] ||
    !process.argv[sidecarIndex + 1]
  ) {
    throw new Error(
      "usage: simulate-dispute-opt-in-safe-batch --batch <path> --sidecar <path>"
    );
  }
  const hre: HardhatRuntimeEnvironment = require("hardhat");
  const batch = JSON.parse(readFileSync(process.argv[batchIndex + 1], "utf8"));
  const manifest = validateSafeBatchManifest(
    JSON.parse(readFileSync(process.argv[sidecarIndex + 1], "utf8"))
  );
  const persisted = normalizeSafeTransactions(
    batch.transactions.map((transaction: any) => ({
      ...transaction,
      operation: transaction.operation ?? 0,
    }))
  );
  if (JSON.stringify(persisted) !== JSON.stringify(manifest.transactions)) {
    throw new Error(
      "Persisted Safe batch transactions do not match the sidecar"
    );
  }
  await simulateDisputeOptInSafeBatch(
    hre,
    manifest,
    await buildBasePostconditionConfig(hre),
    process.env.BASE_FORK_RPC_URL || ""
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
