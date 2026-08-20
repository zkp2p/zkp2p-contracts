import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ethers } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  DisputeSafeBatchManifest,
  canonicalTransactionHash,
  normalizeSafeTransactions,
  validateSafeBatchManifest,
} from "../deployments/safeBatchManifest";
import {
  BASE_SAFE,
  buildBasePostconditionConfig,
  simulateDisputeOptInSafeBatch,
} from "./simulate-dispute-opt-in-safe-batch";

export const DISPUTE_SAFE_BATCH_PATH =
  "deployments/outputs/safe-batches/base_opt_in_dispute_lifecycle.json";
export const DISPUTE_SAFE_SIDECAR_PATH =
  "deployments/outputs/safe-batches/base_opt_in_dispute_lifecycle.sha256.json";
export const OBSOLETE_BATCH_ARCHIVE_PATH =
  "deployments/outputs/safe-batches/superseded/base_2026-08-11T07-40-03.json";
export const OBSOLETE_BATCH_ACTIVE_PATH =
  "deployments/outputs/safe-batches/base_2026-08-11T07-40-03.json";

type GitMode = "generation" | "artifact-child";

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export function assertSafeArtifactGitState(
  repositoryRoot: string,
  sourceSha: string,
  mode: GitMode
): void {
  if (git(repositoryRoot, ["status", "--porcelain"]) !== "") {
    throw new Error("Safe artifact verification requires a clean worktree");
  }
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (mode === "generation") {
    if (head !== sourceSha)
      throw new Error("Generation HEAD does not equal the recorded source SHA");
    return;
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sourceSha, head], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      "Recorded source SHA is not an ancestor of the artifact commit"
    );
  }
  const allowed = new Set([
    DISPUTE_SAFE_BATCH_PATH,
    DISPUTE_SAFE_SIDECAR_PATH,
    OBSOLETE_BATCH_ACTIVE_PATH,
    OBSOLETE_BATCH_ARCHIVE_PATH,
  ]);
  const changed = git(repositoryRoot, [
    "diff",
    "--name-only",
    `${sourceSha}..${head}`,
  ])
    .split("\n")
    .filter(Boolean);
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(
      `Artifact child contains unrelated paths: ${unexpected.join(", ")}`
    );
  }
}

export function assertBatchMatchesManifest(
  batch: any,
  manifest: DisputeSafeBatchManifest
): void {
  if (
    batch?.version !== "1.0" ||
    batch?.chainId !== String(manifest.chainId) ||
    !Number.isSafeInteger(batch?.createdAt) ||
    batch.createdAt <= 0 ||
    batch?.meta?.name !== "ZKP2P opt-in dispute lifecycle activation - base" ||
    batch?.meta?.description !==
      "Atomic ownership, writer, and OrchestratorV3 lifecycle-hook cutover" ||
    batch?.meta?.txBuilderVersion !== "1.16.5" ||
    String(batch?.meta?.createdFromSafeAddress).toLowerCase() !==
      manifest.safe.toLowerCase() ||
    batch?.meta?.createdFromOwnerAddress !== "" ||
    !Array.isArray(batch?.transactions)
  )
    throw new Error(
      "Persisted Safe batch metadata does not match its manifest"
    );
  const persisted = normalizeSafeTransactions(
    batch.transactions.map((transaction: any) => ({
      ...transaction,
      operation: transaction.operation ?? 0,
    }))
  );
  if (JSON.stringify(persisted) !== JSON.stringify(manifest.transactions)) {
    throw new Error("Persisted Safe transactions do not match their manifest");
  }
}

export async function verifyDisputeSafeArtifacts(
  hre: HardhatRuntimeEnvironment,
  batchPath: string,
  sidecarPath: string,
  mode: GitMode,
  repositoryRoot: string,
  forkRpcUrl: string
): Promise<void> {
  const expectedBatchPath = resolve(repositoryRoot, DISPUTE_SAFE_BATCH_PATH);
  const expectedSidecarPath = resolve(
    repositoryRoot,
    DISPUTE_SAFE_SIDECAR_PATH
  );
  if (
    resolve(batchPath) !== expectedBatchPath ||
    resolve(sidecarPath) !== expectedSidecarPath
  ) {
    throw new Error(
      "Safe artifact verifier accepts only the deterministic batch and sidecar paths"
    );
  }
  const batch = JSON.parse(readFileSync(batchPath, "utf8"));
  const manifest = validateSafeBatchManifest(
    JSON.parse(readFileSync(sidecarPath, "utf8"))
  );
  if (manifest.safe.toLowerCase() !== BASE_SAFE.toLowerCase()) {
    throw new Error("Safe manifest does not target the pinned ZKP2P Base Safe");
  }
  assertBatchMatchesManifest(batch, manifest);
  assertSafeArtifactGitState(repositoryRoot, manifest.sourceSha, mode);

  if (!forkRpcUrl)
    throw new Error(
      "BASE_FORK_RPC_URL is required for Safe artifact verification"
    );
  const liveProvider = new ethers.providers.JsonRpcProvider(forkRpcUrl);
  const network = await liveProvider.getNetwork();
  if (network.chainId !== manifest.chainId)
    throw new Error("Safe manifest chain ID drifted");
  const safe = new ethers.Contract(
    BASE_SAFE,
    ["function nonce() view returns (uint256)"],
    liveProvider
  );
  if (!(await safe.nonce()).eq(manifest.safeNonce))
    throw new Error("Safe nonce drifted from the manifest");
  const block = await liveProvider.getBlock(manifest.simulationBlockNumber);
  if (
    !block ||
    block.hash.toLowerCase() !== manifest.simulationBlockHash.toLowerCase()
  ) {
    throw new Error("Simulation block hash drifted from the manifest");
  }
  if (batch.createdAt !== block.timestamp * 1000) {
    throw new Error(
      "Safe batch creation timestamp does not match the pinned simulation block"
    );
  }
  const postconditions = await buildBasePostconditionConfig(hre);
  const ownedInterface = [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
  ];
  const verifier = new ethers.Contract(
    postconditions.disputeVerifier,
    ownedInterface,
    liveProvider
  );
  const vault = new ethers.Contract(
    postconditions.freshVault,
    ownedInterface,
    liveProvider
  );
  const policy = new ethers.Contract(
    postconditions.freshPolicy,
    ownedInterface,
    liveProvider
  );
  const registry = new ethers.Contract(
    postconditions.disputeRegistry,
    [
      "function owner() view returns (address)",
      "function getWriters() view returns (address[] memory)",
    ],
    liveProvider
  );
  const orchestrator = new ethers.Contract(
    postconditions.orchestrator,
    [
      "function owner() view returns (address)",
      "function lifecycleHook() view returns (address)",
    ],
    liveProvider
  );
  const {
    buildBaseGovernanceTransactions,
  } = require("../deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts");
  const expectedTransactions = buildBaseGovernanceTransactions({
    safe: BASE_SAFE,
    verifier: {
      address: verifier.address,
      owner: await verifier.owner(),
      pendingOwner: await verifier.pendingOwner(),
    },
    vault: {
      address: vault.address,
      owner: await vault.owner(),
      pendingOwner: await vault.pendingOwner(),
    },
    policy: {
      address: policy.address,
      owner: await policy.owner(),
      pendingOwner: await policy.pendingOwner(),
    },
    registry: {
      address: registry.address,
      owner: await registry.owner(),
      writers: await registry.getWriters(),
    },
    predecessorPolicy: postconditions.predecessorPolicy,
    orchestrator: {
      address: orchestrator.address,
      owner: await orchestrator.owner(),
      currentHook: await orchestrator.lifecycleHook(),
    },
    predecessorHook:
      require("../deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts")
        .PREDECESSOR_DISPUTE_STACKS.base.activeLifecycleHook.address,
    freshHook: postconditions.freshHook,
  });
  if (
    canonicalTransactionHash(expectedTransactions) !==
      manifest.transactionsSha256 ||
    JSON.stringify(expectedTransactions) !==
      JSON.stringify(manifest.transactions)
  )
    throw new Error(
      "Safe manifest no longer matches the exact live governance calls"
    );
  await simulateDisputeOptInSafeBatch(
    hre,
    manifest,
    postconditions,
    forkRpcUrl
  );
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(__dirname, "..");
  const getArgument = (name: string, fallback: string): string => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const mode = getArgument("--mode", "artifact-child") as GitMode;
  if (mode !== "generation" && mode !== "artifact-child")
    throw new Error(`Unknown Git-state mode ${mode}`);
  const batchPath = resolve(
    repositoryRoot,
    getArgument("--batch", DISPUTE_SAFE_BATCH_PATH)
  );
  const sidecarPath = resolve(
    repositoryRoot,
    getArgument("--sidecar", DISPUTE_SAFE_SIDECAR_PATH)
  );
  const hre: HardhatRuntimeEnvironment = require("hardhat");
  await verifyDisputeSafeArtifacts(
    hre,
    batchPath,
    sidecarPath,
    mode,
    repositoryRoot,
    process.env.BASE_FORK_RPC_URL || ""
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
