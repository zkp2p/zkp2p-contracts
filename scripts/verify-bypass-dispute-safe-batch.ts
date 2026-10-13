import { execFileSync } from "child_process";
import { resolve } from "path";
import { ethers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  BYPASS_ACTIVATION_BATCH_PATHS,
  type BypassActivationBatchManifest,
  type ContractIdentity,
  assertBatchMatchesBypassActivationManifest,
  canonicalJson,
  validateBypassActivationBatchManifest,
} from "../deployments/bypassActivationBatchManifest";
import {
  type BypassActivationSnapshot,
  type BypassExpectedActivationState,
  assertBypassCanonicalTransactions,
  assertBypassGuardExpectationsUnchanged,
  buildBypassTrustSurface,
  bypassInventoryTupleArgs,
  bypassTrustSurfaceTuple,
  reduceBypassActivation,
} from "../deployments/bypassDisputeActivation";
import { zeroImmutableValues } from "../deployments/canonicalDeployment";
import { assertSafeArtifactPairConsistent } from "../deployments/safeArtifacts";
import { BASE_SAFE } from "./simulate-dispute-opt-in-safe-batch";
import { liveHre } from "./verify-method-scoped-safe-batch";

export type BypassActivationGitMode = "generation" | "artifact-child";
export const BYPASS_ACTIVATION_PROTECTED_PATHS: readonly string[] = [
  "deploy/45_*",
  "deploy/46_*",
  "deployments/bypassDisputeStack.ts",
  "deployments/bypassDisputeActivation.ts",
  "deployments/bypassActivationBatchManifest.ts",
  "deployments/activationBatchManifest.ts",
  "deployments/methodScopedActivation.ts",
  "deployments/helpers.ts",
  "deployments/activeDisputeStack.cjs",
  "deployments/active-dispute-stack.json",
  "deployments/safeArtifacts.ts",
  "deployments/safeBatchManifest.ts",
  "deployments/canonicalDeployment.ts",
  "deployments/parameters.ts",
  "deployments/immutableDeploymentLanes.ts",
  "deploy/31_*",
  "deploy/37_*",
  "deploy/38_*",
  "deployments/base/",
  "scripts/verify-bypass-dispute-safe-batch.ts",
  "scripts/verify-method-scoped-safe-batch.ts",
  "scripts/simulate-bypass-dispute-safe-batch.ts",
  "scripts/simulate-dispute-opt-in-safe-batch.ts",
  "contracts/",
  "hardhat.config.ts",
  "foundry.toml",
  "package.json",
  "yarn.lock",
  "tsconfig*.json",
];

type VerificationRuntimeEnvironment = HardhatRuntimeEnvironment & {
  __methodScopedVerificationProvider?: ethers.providers.Provider;
};

export type BypassActivationLaneBindings = {
  loadBypassActivationContext: (
    hre: HardhatRuntimeEnvironment,
    network: "base"
  ) => Promise<void>;
  expectedBypassActivationState: (
    network: "base"
  ) => BypassExpectedActivationState;
  readBypassActivationSnapshot: (
    hre: HardhatRuntimeEnvironment,
    network: "base",
    blockTag: number
  ) => Promise<BypassActivationSnapshot>;
  runPinnedSimulation: (
    manifest: BypassActivationBatchManifest,
    forkRpcUrl: string
  ) => Promise<void>;
};

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export function assertBypassArtifactGitState(
  repositoryRoot: string,
  sourceSha: string,
  mode: BypassActivationGitMode
): void {
  if (git(repositoryRoot, ["status", "--porcelain"]) !== "") {
    throw new Error("Safe artifact verification requires a clean worktree");
  }
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (mode === "generation") {
    if (head !== sourceSha) {
      throw new Error("Generation HEAD does not equal the recorded source SHA");
    }
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
  const changed = git(repositoryRoot, [
    "diff",
    "--name-only",
    "--no-renames",
    `${sourceSha}..${head}`,
  ])
    .split("\n")
    .filter(Boolean);
  const isProtected = (path: string): boolean =>
    BYPASS_ACTIVATION_PROTECTED_PATHS.some((candidate) => {
      if (candidate.endsWith("/")) return path.startsWith(candidate);
      const wildcard = candidate.indexOf("*");
      if (wildcard === -1) return path === candidate;
      return (
        path.startsWith(candidate.slice(0, wildcard)) &&
        path.endsWith(candidate.slice(wildcard + 1))
      );
    });
  const protectedChanges = changed.filter(isProtected);
  if (protectedChanges.length > 0) {
    throw new Error(
      `Artifact child changes protected paths: ${protectedChanges.join(", ")}`
    );
  }
}

export function deriveBypassConstructorArgs(
  manifest: BypassActivationBatchManifest,
  role: "guard" | "postcondition"
): unknown[] {
  const tuple = bypassTrustSurfaceTuple(manifest.trustSurface);
  if (role === "postcondition") return [tuple];
  const safe = manifest.safe.toLowerCase();
  const { freshVault, freshPolicy, inventory } = manifest.proofSnapshot;
  const includeVault =
    freshVault.owner.toLowerCase() !== safe &&
    freshVault.pendingOwner.toLowerCase() === safe;
  const includePolicy =
    freshPolicy.owner.toLowerCase() !== safe &&
    freshPolicy.pendingOwner.toLowerCase() === safe;
  return [
    tuple,
    includeVault,
    includePolicy,
    bypassInventoryTupleArgs(inventory),
  ];
}

async function assertBypassContractIdentity(
  hre: HardhatRuntimeEnvironment,
  manifest: BypassActivationBatchManifest,
  identity: ContractIdentity,
  role: "guard" | "postcondition",
  blockNumber: number
): Promise<void> {
  const artifactName =
    role === "guard"
      ? "DisputeBypassCutoverGuard"
      : "DisputeBypassCutoverPostcondition";
  if (identity.artifactName !== artifactName) {
    throw new Error(`${role} artifact name mismatch`);
  }
  const artifact = await hre.deployments.getExtendedArtifact(artifactName);
  const immutableReferences = (artifact.evm?.deployedBytecode
    ?.immutableReferences || {}) as Record<
    string,
    Array<{ start: number; length: number }>
  >;
  const receipt = await hre.ethers.provider.getTransactionReceipt(
    identity.deployTransactionHash
  );
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${role} deployment receipt is not successful`);
  }
  if (
    !receipt.contractAddress ||
    receipt.contractAddress.toLowerCase() !== identity.address.toLowerCase()
  ) {
    throw new Error(`${role} deployment receipt contractAddress mismatch`);
  }
  const deploymentTransaction = await hre.ethers.provider.getTransaction(
    identity.deployTransactionHash
  );
  if (!deploymentTransaction)
    throw new Error(`${role} deployment transaction missing`);
  if (!artifact.bytecode || !artifact.deployedBytecode) {
    throw new Error(`${role} artifact lacks bytecode`);
  }
  const encodedArgs = new ethers.utils.Interface(artifact.abi).encodeDeploy(
    deriveBypassConstructorArgs(manifest, role)
  );
  const recordedArgs = new ethers.utils.Interface(artifact.abi).encodeDeploy(
    identity.constructorArgs
  );
  if (recordedArgs.toLowerCase() !== encodedArgs.toLowerCase()) {
    throw new Error(`${role} recorded constructor arguments mismatch`);
  }
  if (
    deploymentTransaction.data.toLowerCase() !==
    `${artifact.bytecode}${encodedArgs.slice(2)}`.toLowerCase()
  ) {
    throw new Error(`${role} deployment initcode mismatch`);
  }
  const runtime = await hre.ethers.provider.getCode(
    identity.address,
    blockNumber
  );
  const artifactRuntime = zeroImmutableValues(
    artifact.deployedBytecode,
    immutableReferences
  );
  if (
    runtime === "0x" ||
    zeroImmutableValues(runtime, immutableReferences) !== artifactRuntime ||
    ethers.utils.keccak256(runtime).toLowerCase() !==
      identity.runtimeCodeHash.toLowerCase()
  ) {
    throw new Error(`${role} runtime identity mismatch`);
  }
}

export async function verifyBypassActivationCandidate(
  hre: HardhatRuntimeEnvironment,
  input: {
    batch: unknown;
    manifest: unknown;
    mode: BypassActivationGitMode;
    repositoryRoot: string;
    forkRpcUrl: string;
    artifactPaths: { batch: string; sidecar: string };
    lane?: BypassActivationLaneBindings;
  }
): Promise<void> {
  let batch = input.batch;
  let manifestValue = input.manifest;
  if (input.mode === "artifact-child") {
    const pair = assertSafeArtifactPairConsistent(
      input.artifactPaths.batch,
      input.artifactPaths.sidecar
    );
    batch = pair.batch;
    manifestValue = pair.manifest;
  }
  validateBypassActivationBatchManifest(manifestValue);
  const manifest = manifestValue;
  if (manifest.safe.toLowerCase() !== BASE_SAFE.toLowerCase()) {
    throw new Error("Safe manifest does not target the pinned ZKP2P Base Safe");
  }
  assertBatchMatchesBypassActivationManifest(batch, manifest);
  assertBypassArtifactGitState(
    input.repositoryRoot,
    manifest.sourceSha,
    input.mode
  );
  if (!input.forkRpcUrl) {
    throw new Error(
      "BASE_FORK_RPC_URL is required for Safe artifact verification"
    );
  }
  const provider =
    (hre as VerificationRuntimeEnvironment)
      .__methodScopedVerificationProvider ||
    new ethers.providers.JsonRpcProvider(input.forkRpcUrl);
  const verificationHre = liveHre(hre, provider);
  const network = await provider.getNetwork();
  if (network.chainId !== manifest.chainId) {
    throw new Error("Safe manifest chain ID drifted");
  }
  const block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("Could not pin the verification block");
  if (block.number < manifest.simulationBlockNumber) {
    throw new Error("Verification block predates the simulation block");
  }
  const proofBlock = await provider.getBlock(manifest.proofBlock.number);
  if (!proofBlock?.hash) {
    throw new Error("Manifest proof block is unavailable from the chain");
  }
  if (
    proofBlock.hash.toLowerCase() !== manifest.proofBlock.hash.toLowerCase()
  ) {
    throw new Error("Manifest proof block hash does not match the chain");
  }
  const safe = new ethers.Contract(
    BASE_SAFE,
    ["function nonce() view returns (uint256)"],
    provider
  );
  if (!(await safe.nonce({ blockTag: block.number })).eq(manifest.safeNonce)) {
    throw new Error("Safe nonce drifted from the manifest");
  }

  const lane: BypassActivationLaneBindings =
    input.lane || require("../deploy/46_activate_bypass_dispute_stack.ts");
  await lane.loadBypassActivationContext(verificationHre, "base");
  const expected = lane.expectedBypassActivationState("base");
  const safeAddress = manifest.safe.toLowerCase();
  const { freshVault, freshPolicy } = manifest.proofSnapshot;
  const includeVault =
    freshVault.owner.toLowerCase() !== safeAddress &&
    freshVault.pendingOwner.toLowerCase() === safeAddress;
  const includePolicy =
    freshPolicy.owner.toLowerCase() !== safeAddress &&
    freshPolicy.pendingOwner.toLowerCase() === safeAddress;
  assertBypassCanonicalTransactions(
    manifest.transactions,
    expected,
    manifest.guard.address,
    includeVault,
    includePolicy
  );
  if (
    manifest.proofSnapshot.inventory.escrow.toLowerCase() !==
    expected.addresses.escrow.toLowerCase()
  ) {
    throw new Error(
      "Manifest inventory escrow does not match canonical Base escrow"
    );
  }
  await assertBypassContractIdentity(
    verificationHre,
    manifest,
    manifest.guard,
    "guard",
    block.number
  );
  await assertBypassContractIdentity(
    verificationHre,
    manifest,
    manifest.postcondition,
    "postcondition",
    block.number
  );
  const snapshot = await lane.readBypassActivationSnapshot(
    verificationHre,
    "base",
    block.number
  );
  if (
    canonicalJson(buildBypassTrustSurface(expected, snapshot)) !==
    canonicalJson(manifest.trustSurface)
  ) {
    throw new Error("Manifest trust surface does not match Base expectations");
  }
  assertBypassGuardExpectationsUnchanged(manifest.proofSnapshot, snapshot);
  const reduction = reduceBypassActivation(snapshot, expected);
  if (reduction.phase !== "deployed" || !snapshot.inventory.ok) {
    throw new Error("Verification state is not deployed with inventory ok");
  }
  await lane.runPinnedSimulation(manifest, input.forkRpcUrl);
}

async function main(): Promise<void> {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "artifact-child";
  if (mode !== "generation" && mode !== "artifact-child") {
    throw new Error(`Unknown Git-state mode ${mode}`);
  }
  const repositoryRoot = resolve(__dirname, "..");
  const artifactPaths = {
    batch: resolve(repositoryRoot, BYPASS_ACTIVATION_BATCH_PATHS.batch),
    sidecar: resolve(repositoryRoot, BYPASS_ACTIVATION_BATCH_PATHS.sidecar),
  };
  const pair = assertSafeArtifactPairConsistent(
    artifactPaths.batch,
    artifactPaths.sidecar
  );
  const hre: HardhatRuntimeEnvironment = require("hardhat");
  await verifyBypassActivationCandidate(hre, {
    batch: pair.batch,
    manifest: pair.manifest,
    mode,
    repositoryRoot,
    forkRpcUrl: process.env.BASE_FORK_RPC_URL || "",
    artifactPaths,
  });
  console.log(`Verified dispute bypass cutover artifact in ${mode} mode`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
