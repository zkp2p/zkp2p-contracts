import { execFileSync } from "child_process";
import { resolve } from "path";
import { ethers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  O4_ACTIVATION_BATCH_PATHS,
  type O4ActivationBatchManifest,
  type ContractIdentity,
  assertBatchMatchesO4ActivationManifest,
  canonicalJson,
  validateO4ActivationBatchManifest,
} from "../deployments/orchestratorV4ActivationBatchManifest";
import {
  type O4ActivationSnapshot,
  type O4ExpectedActivationState,
  assertO4CanonicalTransactions,
  assertO4GuardExpectationsUnchanged,
  buildO4TrustSurface,
  o4TrustSurfaceTuple,
  reduceO4Activation,
} from "../deployments/orchestratorV4Activation";
import { zeroImmutableValues } from "../deployments/canonicalDeployment";
import { assertSafeArtifactPairConsistent } from "../deployments/safeArtifacts";
import { BASE_SAFE } from "./simulate-dispute-opt-in-safe-batch";
import { liveHre } from "./verify-method-scoped-safe-batch";

export type O4ActivationGitMode = "generation" | "artifact-child";
export const O4_ACTIVATION_PROTECTED_PATHS: readonly string[] = [
  "deploy/45_*",
  "deploy/46_*",
  "deployments/orchestratorV4Stack.ts",
  "deployments/orchestratorV4Activation.ts",
  "deployments/orchestratorV4ActivationBatchManifest.ts",
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
  "scripts/verify-orchestrator-v4-safe-batch.ts",
  "scripts/verify-method-scoped-safe-batch.ts",
  "scripts/simulate-orchestrator-v4-safe-batch.ts",
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

export type O4ActivationLaneBindings = {
  loadO4ActivationContext: (
    hre: HardhatRuntimeEnvironment,
    network: "base"
  ) => Promise<void>;
  expectedO4ActivationState: (
    network: "base"
  ) => O4ExpectedActivationState;
  readO4ActivationSnapshot: (
    hre: HardhatRuntimeEnvironment,
    network: "base",
    blockTag: number
  ) => Promise<O4ActivationSnapshot>;
  runPinnedSimulation: (
    manifest: O4ActivationBatchManifest,
    forkRpcUrl: string
  ) => Promise<void>;
};

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export function assertO4ArtifactGitState(
  repositoryRoot: string,
  sourceSha: string,
  mode: O4ActivationGitMode
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
    O4_ACTIVATION_PROTECTED_PATHS.some((candidate) => {
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

export function deriveO4ConstructorArgs(
  manifest: O4ActivationBatchManifest,
  role: "guard" | "postcondition"
): unknown[] {
  const tuple = o4TrustSurfaceTuple(manifest.trustSurface);
  if (role === "postcondition") return [tuple];
  const safe = manifest.safe.toLowerCase();
  const { freshVault, freshPolicy } = manifest.proofSnapshot;
  const includeVault =
    freshVault.owner.toLowerCase() !== safe &&
    freshVault.pendingOwner.toLowerCase() === safe;
  const includePolicy =
    freshPolicy.owner.toLowerCase() !== safe &&
    freshPolicy.pendingOwner.toLowerCase() === safe;
  return [tuple, includeVault, includePolicy];
}

async function assertO4ContractIdentity(
  hre: HardhatRuntimeEnvironment,
  manifest: O4ActivationBatchManifest,
  identity: ContractIdentity,
  role: "guard" | "postcondition",
  blockNumber: number
): Promise<void> {
  const artifactName =
    role === "guard"
      ? "OrchestratorV4CutoverGuard"
      : "OrchestratorV4CutoverPostcondition";
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
    deriveO4ConstructorArgs(manifest, role)
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

export async function verifyO4ActivationCandidate(
  hre: HardhatRuntimeEnvironment,
  input: {
    batch: unknown;
    manifest: unknown;
    mode: O4ActivationGitMode;
    repositoryRoot: string;
    forkRpcUrl: string;
    artifactPaths: { batch: string; sidecar: string };
    lane?: O4ActivationLaneBindings;
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
  validateO4ActivationBatchManifest(manifestValue);
  const manifest = manifestValue;
  if (manifest.safe.toLowerCase() !== BASE_SAFE.toLowerCase()) {
    throw new Error("Safe manifest does not target the pinned ZKP2P Base Safe");
  }
  assertBatchMatchesO4ActivationManifest(batch, manifest);
  assertO4ArtifactGitState(
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

  const lane: O4ActivationLaneBindings =
    input.lane || require("../deploy/46_activate_orchestrator_v4_stack.ts");
  await lane.loadO4ActivationContext(verificationHre, "base");
  const expected = lane.expectedO4ActivationState("base");
  const safeAddress = manifest.safe.toLowerCase();
  const { freshVault, freshPolicy } = manifest.proofSnapshot;
  const includeVault =
    freshVault.owner.toLowerCase() !== safeAddress &&
    freshVault.pendingOwner.toLowerCase() === safeAddress;
  const includePolicy =
    freshPolicy.owner.toLowerCase() !== safeAddress &&
    freshPolicy.pendingOwner.toLowerCase() === safeAddress;
  assertO4CanonicalTransactions(
    manifest.transactions,
    expected,
    manifest.guard.address,
    includeVault,
    includePolicy
  );
  await assertO4ContractIdentity(
    verificationHre,
    manifest,
    manifest.guard,
    "guard",
    block.number
  );
  await assertO4ContractIdentity(
    verificationHre,
    manifest,
    manifest.postcondition,
    "postcondition",
    block.number
  );
  const snapshot = await lane.readO4ActivationSnapshot(
    verificationHre,
    "base",
    block.number
  );
  if (
    canonicalJson(buildO4TrustSurface(expected, snapshot)) !==
    canonicalJson(manifest.trustSurface)
  ) {
    throw new Error("Manifest trust surface does not match Base expectations");
  }
  assertO4GuardExpectationsUnchanged(manifest.proofSnapshot, snapshot);
  const reduction = reduceO4Activation(snapshot, expected);
  if (reduction.phase !== "deployed") {
    throw new Error("Verification state is not deployed");
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
    batch: resolve(repositoryRoot, O4_ACTIVATION_BATCH_PATHS.batch),
    sidecar: resolve(repositoryRoot, O4_ACTIVATION_BATCH_PATHS.sidecar),
  };
  const pair = assertSafeArtifactPairConsistent(
    artifactPaths.batch,
    artifactPaths.sidecar
  );
  const hre: HardhatRuntimeEnvironment = require("hardhat");
  await verifyO4ActivationCandidate(hre, {
    batch: pair.batch,
    manifest: pair.manifest,
    mode,
    repositoryRoot,
    forkRpcUrl: process.env.BASE_FORK_RPC_URL || "",
    artifactPaths,
  });
  console.log(`Verified OrchestratorV4 cutover artifact in ${mode} mode`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
