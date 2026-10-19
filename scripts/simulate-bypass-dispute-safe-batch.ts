import { resolve } from "path";
import { ethers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  type BypassActivationBatchManifest,
  assertBatchMatchesBypassActivationManifest,
  validateBypassActivationBatchManifest,
} from "../deployments/bypassActivationBatchManifest";
import { assertSafeArtifactPairConsistent } from "../deployments/safeArtifacts";
import {
  BASE_SAFE,
  BASE_SAFE_RUNTIME_HASH,
  MULTI_SEND_CALL_ONLY,
  MULTI_SEND_CALL_ONLY_RUNTIME_HASH,
  appendSimulationPostcondition,
  decodeSafeSimulationEnvelope,
  encodeMultiSendCalldata,
  requireRuntimeHash,
  restoreHardhatModuleResolution,
} from "./simulate-dispute-opt-in-safe-batch";

const safeInterface = new ethers.utils.Interface([
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function simulateAndRevert(address targetContract,bytes calldataPayload)",
]);
const postconditionInterface = new ethers.utils.Interface([
  "function assertPostconditions()",
]);

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function extractRevertData(error: unknown): string | undefined {
  const data = property(error, "data");
  const nested = property(error, "error");
  return [
    property(data, "data"),
    data,
    property(nested, "data"),
    property(property(nested, "error"), "data"),
  ].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.startsWith("0x")
  );
}

async function assertRuntime(
  hre: HardhatRuntimeEnvironment,
  address: string,
  expectedHash: string,
  label: string
): Promise<void> {
  requireRuntimeHash(
    await hre.ethers.provider.getCode(address),
    expectedHash,
    label
  );
}

async function assertManifestContractRuntimeHashes(
  hre: HardhatRuntimeEnvironment,
  manifest: BypassActivationBatchManifest
): Promise<void> {
  await assertRuntime(
    hre,
    manifest.guard.address,
    manifest.guard.runtimeCodeHash,
    "Activation guard"
  );
  await assertRuntime(
    hre,
    manifest.postcondition.address,
    manifest.postcondition.runtimeCodeHash,
    "Activation postcondition"
  );
}

export async function simulateBypassSafeBatch(
  hre: HardhatRuntimeEnvironment,
  manifest: BypassActivationBatchManifest,
  forkRpcUrl: string
): Promise<void> {
  validateBypassActivationBatchManifest(manifest);
  if (manifest.safe.toLowerCase() !== BASE_SAFE.toLowerCase()) {
    throw new Error("Safe manifest does not target the pinned ZKP2P Base Safe");
  }
  if (!forkRpcUrl) {
    throw new Error("BASE_FORK_RPC_URL is required for Safe batch simulation");
  }
  await hre.network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl: forkRpcUrl,
          blockNumber: manifest.simulationBlockNumber,
        },
      },
    ],
  });
  const block = await hre.ethers.provider.getBlock(
    manifest.simulationBlockNumber
  );
  if (
    !block?.hash ||
    block.hash.toLowerCase() !== manifest.simulationBlockHash.toLowerCase()
  ) {
    throw new Error("Safe simulation block hash mismatch");
  }
  await Promise.all([
    assertRuntime(hre, BASE_SAFE, BASE_SAFE_RUNTIME_HASH, "Safe v1.3.0"),
    assertRuntime(
      hre,
      MULTI_SEND_CALL_ONLY,
      MULTI_SEND_CALL_ONLY_RUNTIME_HASH,
      "MultiSendCallOnly"
    ),
    assertManifestContractRuntimeHashes(hre, manifest),
  ]);
  const safe = new ethers.Contract(
    BASE_SAFE,
    safeInterface,
    hre.ethers.provider
  );
  if ((await safe.VERSION()) !== "1.3.0") {
    throw new Error("Unsupported Safe version");
  }
  if (!(await safe.nonce()).eq(manifest.safeNonce)) {
    throw new Error("Safe nonce drifted before simulation");
  }
  const transactions = appendSimulationPostcondition(
    manifest.transactions,
    manifest.postcondition.address,
    postconditionInterface.encodeFunctionData("assertPostconditions")
  );
  const simulationCalldata = safeInterface.encodeFunctionData(
    "simulateAndRevert",
    [MULTI_SEND_CALL_ONLY, encodeMultiSendCalldata(transactions)]
  );
  let envelope: string | undefined;
  try {
    envelope = await hre.ethers.provider.call({
      to: BASE_SAFE,
      data: simulationCalldata,
    });
  } catch (error: unknown) {
    envelope = extractRevertData(error);
  }
  if (!envelope || envelope === "0x") {
    throw new Error(
      "Safe simulation did not return its deliberate revert envelope"
    );
  }
  const result = decodeSafeSimulationEnvelope(envelope);
  if (!result.success) {
    throw new Error(
      `Atomic Safe batch simulation failed: ${result.returnData}`
    );
  }
}

function loadHardhatRuntime(): HardhatRuntimeEnvironment {
  restoreHardhatModuleResolution();
  return require("hardhat");
}

async function main(): Promise<void> {
  const inlinePayload = process.env.DISPUTE_BYPASS_SAFE_SIMULATION_PAYLOAD;
  if (inlinePayload) {
    const payload: unknown = JSON.parse(inlinePayload);
    const manifest = property(payload, "manifest");
    validateBypassActivationBatchManifest(manifest);
    await simulateBypassSafeBatch(
      loadHardhatRuntime(),
      manifest,
      process.env.BASE_FORK_RPC_URL || ""
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
      "usage: simulate-bypass-dispute-safe-batch --batch <path> --sidecar <path>"
    );
  }
  const batchPath = resolve(process.argv[batchIndex + 1]);
  const sidecarPath = resolve(process.argv[sidecarIndex + 1]);
  const pair = assertSafeArtifactPairConsistent(batchPath, sidecarPath);
  const manifest: unknown = pair.manifest;
  validateBypassActivationBatchManifest(manifest);
  assertBatchMatchesBypassActivationManifest(pair.batch, manifest);
  await simulateBypassSafeBatch(
    loadHardhatRuntime(),
    manifest,
    process.env.BASE_FORK_RPC_URL || ""
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
