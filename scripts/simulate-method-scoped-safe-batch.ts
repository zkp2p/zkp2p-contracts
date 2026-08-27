import { readFileSync } from "fs";
import { resolve } from "path";
import { ethers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  type ActivationBatchManifest,
  assertBatchMatchesActivationManifest,
  validateActivationBatchManifest,
} from "../deployments/activationBatchManifest";
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

export const decodeMethodScopedSafeSimulationEnvelope =
  decodeSafeSimulationEnvelope;

function extractRevertData(error: any): string | undefined {
  return [
    error?.data?.data,
    error?.data,
    error?.error?.data,
    error?.error?.error?.data,
  ].find(
    (candidate) => typeof candidate === "string" && candidate.startsWith("0x")
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

export async function assertManifestContractRuntimeHashes(
  hre: HardhatRuntimeEnvironment,
  manifest: ActivationBatchManifest
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

export async function simulateMethodScopedSafeBatch(
  hre: HardhatRuntimeEnvironment,
  manifest: ActivationBatchManifest,
  forkRpcUrl: string
): Promise<void> {
  validateActivationBatchManifest(manifest);
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
  } catch (error) {
    envelope = extractRevertData(error);
  }
  if (!envelope || envelope === "0x") {
    throw new Error(
      "Safe simulation did not return its deliberate revert envelope"
    );
  }
  const result = decodeMethodScopedSafeSimulationEnvelope(envelope);
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
  const inlinePayload = process.env.METHOD_SCOPED_SAFE_SIMULATION_PAYLOAD;
  if (inlinePayload) {
    const payload = JSON.parse(inlinePayload) as {
      manifest: ActivationBatchManifest;
    };
    validateActivationBatchManifest(payload.manifest);
    await simulateMethodScopedSafeBatch(
      loadHardhatRuntime(),
      payload.manifest,
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
      "usage: simulate-method-scoped-safe-batch --batch <path> --sidecar <path>"
    );
  }
  const batchPath = resolve(process.argv[batchIndex + 1]);
  const sidecarPath = resolve(process.argv[sidecarIndex + 1]);
  const pair = assertSafeArtifactPairConsistent(batchPath, sidecarPath);
  const manifest = JSON.parse(
    readFileSync(sidecarPath, "utf8")
  ) as ActivationBatchManifest;
  validateActivationBatchManifest(manifest);
  assertBatchMatchesActivationManifest(pair.batch, manifest);
  await simulateMethodScopedSafeBatch(
    loadHardhatRuntime(),
    manifest,
    process.env.BASE_FORK_RPC_URL || ""
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
