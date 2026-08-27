import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ethers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Deployment } from "hardhat-deploy/types";

import {
  ACTIVATION_BATCH_PATHS,
  type ActivationBatchKind,
  type ActivationBatchManifest,
  type ContractIdentity,
  assertBatchMatchesActivationManifest,
  canonicalJson,
  validateActivationBatchManifest,
} from "../deployments/activationBatchManifest";
import {
  VAULT_ACTIVATION_BATCH_PATHS,
  type VaultActivationBatchManifest,
  type ContractIdentity as VaultContractIdentity,
  assertBatchMatchesVaultActivationManifest,
  canonicalJson as vaultCanonicalJson,
  validateVaultActivationBatchManifest,
} from "../deployments/vaultActivationBatchManifest";
import { zeroImmutableValues } from "../deployments/canonicalDeployment";
import {
  assertGuardExpectationsUnchanged,
  buildTrustSurface,
  reduceActivation,
  type TrustSurfaceInput,
} from "../deployments/methodScopedActivation";
import {
  assertVaultGuardExpectationsUnchanged,
  buildVaultTrustSurface,
  reduceVaultActivation,
  type VaultActivationBatchKind,
  type VaultActivationSnapshot,
  type VaultExpectedActivationState,
  type VaultTrustSurfaceInput,
} from "../deployments/vaultMethodScopedActivation";
import { assertSafeArtifactPairConsistent } from "../deployments/safeArtifacts";
import { EXPECTED_LIVE } from "../deploy/37_deploy_method_scoped_dispute_lifecycle_stack";
import { BASE_SAFE } from "./simulate-dispute-opt-in-safe-batch";

export type ActivationGitMode = "generation" | "artifact-child";
type VerificationRuntimeEnvironment = HardhatRuntimeEnvironment & {
  __methodScopedVerificationProvider?: ethers.providers.Provider;
};
type AnyActivationBatchKind = ActivationBatchKind | VaultActivationBatchKind;

export type VaultActivationLaneBindings = {
  readVaultActivationSnapshot: (
    hre: HardhatRuntimeEnvironment,
    network: "base",
    blockNumber: number
  ) => Promise<VaultActivationSnapshot>;
  loadVaultActivationContext: (
    hre: HardhatRuntimeEnvironment,
    network: "base"
  ) => Promise<unknown>;
  expectedVaultActivationState: (
    network: "base"
  ) => VaultExpectedActivationState;
  runPinnedSimulation: (
    manifest: VaultActivationBatchManifest,
    forkRpcUrl: string
  ) => Promise<void>;
};

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export function assertActivationArtifactGitState(
  repositoryRoot: string,
  sourceSha: string,
  mode: ActivationGitMode,
  allowedPaths: readonly string[]
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
    `${sourceSha}..${head}`,
  ])
    .split("\n")
    .filter(Boolean);
  const allowed = (path: string): boolean =>
    allowedPaths.some((candidate) =>
      candidate.endsWith("*")
        ? path.startsWith(candidate.slice(0, -1))
        : path === candidate
    );
  const unexpected = changed.filter((path) => !allowed(path));
  if (unexpected.length > 0) {
    throw new Error(
      `Artifact child contains unrelated paths: ${unexpected.join(", ")}`
    );
  }
}

function trustSurfaceTuple(surface: TrustSurfaceInput): unknown[] {
  return [
    surface.safe,
    surface.disputeRegistry,
    surface.orchestrator,
    surface.orchestratorRegistry,
    surface.escrowRegistry,
    surface.paymentVerifierRegistry,
    surface.relayerRegistry,
    surface.protocolFeeRecipient,
    surface.allowMultipleIntents,
    surface.freshHook,
    surface.whitelistPolicy,
    surface.groupRegistry,
    surface.attestationVerifier,
    surface.witnesses,
    surface.disputeVerifier,
    surface.nullifierRegistryV2,
    surface.predecessorPolicy,
    surface.freshPolicy,
    surface.vault,
    surface.predecessorHook,
    surface.paymentMethods,
    surface.riskWindows,
  ];
}

function vaultTrustSurfaceTuple(surface: VaultTrustSurfaceInput): unknown[] {
  return [
    surface.safe,
    surface.disputeRegistry,
    surface.orchestrator,
    surface.orchestratorRegistry,
    surface.escrowRegistry,
    surface.paymentVerifierRegistry,
    surface.relayerRegistry,
    surface.protocolFeeRecipient,
    surface.allowMultipleIntents,
    surface.freshHook,
    surface.whitelistPolicy,
    surface.groupRegistry,
    surface.attestationVerifier,
    surface.witnesses,
    surface.disputeVerifier,
    surface.nullifierRegistryV2,
    surface.predecessorPolicy,
    surface.freshPolicy,
    [surface.vaults.freshVault, surface.vaults.predecessorVault],
    surface.predecessorHook,
    surface.paymentMethods,
    surface.riskWindows,
  ];
}

export function deriveActivationConstructorArgs(
  manifest: ActivationBatchManifest,
  role: "guard" | "postcondition"
): unknown[] {
  const trustSurface = trustSurfaceTuple(manifest.trustSurface);
  if (manifest.kind === "rotation") {
    if (role === "postcondition") {
      return [trustSurface, manifest.proofSnapshot.vault.controllerChangeDelay];
    }
    const owner = manifest.proofSnapshot.freshPolicy.owner.toLowerCase();
    const pendingOwner =
      manifest.proofSnapshot.freshPolicy.pendingOwner.toLowerCase();
    const includeAcceptOwnership =
      owner !== manifest.safe.toLowerCase() &&
      pendingOwner === manifest.safe.toLowerCase();
    return [
      trustSurface,
      includeAcceptOwnership,
      EXPECTED_LIVE.base.deployer.toLowerCase(),
    ];
  }
  if (role === "postcondition") return [trustSurface];
  return [
    trustSurface,
    manifest.proofSnapshot.lockProof.intents.map((intent) => intent.intentHash),
    manifest.proofSnapshot.inventory.tuples.map((tuple) => [
      tuple.escrow,
      tuple.depositId,
      tuple.paymentMethod,
    ]),
    manifest.proofSnapshot.inventory.escrow,
    manifest.proofSnapshot.inventory.depositCounter,
  ];
}

export function deriveVaultActivationConstructorArgs(
  manifest: VaultActivationBatchManifest,
  role: "guard" | "postcondition"
): unknown[] {
  const trustSurface = vaultTrustSurfaceTuple(manifest.trustSurface);
  if (role === "postcondition") return [trustSurface];
  if (manifest.kind === "vault-writer-removal") {
    return [
      trustSurface,
      manifest.proofSnapshot.lockProof.intents.map(
        (intent) => intent.intentHash
      ),
    ];
  }
  const safe = manifest.safe.toLowerCase();
  const vault = manifest.proofSnapshot.freshVault;
  const policy = manifest.proofSnapshot.freshPolicy;
  const expectVaultAcceptOwnership =
    vault.owner.toLowerCase() !== safe &&
    vault.pendingOwner.toLowerCase() === safe;
  const expectPolicyAcceptOwnership =
    policy.owner.toLowerCase() !== safe &&
    policy.pendingOwner.toLowerCase() === safe;
  return [
    trustSurface,
    expectVaultAcceptOwnership,
    expectPolicyAcceptOwnership,
    manifest.proofSnapshot.inventory.tuples.map((tuple) => [
      tuple.escrow,
      tuple.depositId,
      tuple.paymentMethod,
    ]),
    manifest.proofSnapshot.inventory.escrow,
    manifest.proofSnapshot.inventory.depositCounter,
  ];
}

function expectedArtifactName(
  kind: ActivationBatchKind,
  role: "guard" | "postcondition"
): string {
  const title = kind === "rotation" ? "Rotation" : "Cutover";
  return `DisputeMethodScoped${title}${
    role === "guard" ? "Guard" : "Postcondition"
  }`;
}

function expectedVaultArtifactName(
  kind: VaultActivationBatchKind,
  role: "guard" | "postcondition"
): string {
  const title =
    kind === "vault-cutover" ? "VaultCutover" : "VaultWriterRemoval";
  return `DisputeMethodScoped${title}${
    role === "guard" ? "Guard" : "Postcondition"
  }`;
}

async function assertContractIdentity(
  hre: HardhatRuntimeEnvironment,
  manifest: ActivationBatchManifest,
  identity: ContractIdentity,
  role: "guard" | "postcondition",
  blockNumber: number
): Promise<void> {
  const artifactName = expectedArtifactName(manifest.kind, role);
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
  const transaction = await hre.ethers.provider.getTransaction(
    identity.deployTransactionHash
  );
  if (!transaction) throw new Error(`${role} deployment transaction missing`);
  if (!artifact.bytecode || !artifact.deployedBytecode) {
    throw new Error(`${role} artifact lacks bytecode`);
  }
  const encodedArgs = new ethers.utils.Interface(artifact.abi).encodeDeploy(
    deriveActivationConstructorArgs(manifest, role)
  );
  const recordedArgs = new ethers.utils.Interface(artifact.abi).encodeDeploy(
    identity.constructorArgs
  );
  if (recordedArgs.toLowerCase() !== encodedArgs.toLowerCase()) {
    throw new Error(`${role} recorded constructor arguments mismatch`);
  }
  const expectedInitcode = `${artifact.bytecode}${encodedArgs.slice(2)}`;
  if (transaction.data.toLowerCase() !== expectedInitcode.toLowerCase()) {
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
  const runtimeHash = ethers.utils.keccak256(runtime).toLowerCase();
  if (
    runtime === "0x" ||
    zeroImmutableValues(runtime, immutableReferences) !== artifactRuntime ||
    runtimeHash !== identity.runtimeCodeHash.toLowerCase()
  ) {
    throw new Error(`${role} runtime identity mismatch`);
  }
}

async function assertVaultContractIdentity(
  hre: HardhatRuntimeEnvironment,
  manifest: VaultActivationBatchManifest,
  identity: VaultContractIdentity,
  role: "guard" | "postcondition",
  blockNumber: number
): Promise<void> {
  const artifactName = expectedVaultArtifactName(manifest.kind, role);
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
    deriveVaultActivationConstructorArgs(manifest, role)
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

function liveHre(
  hre: HardhatRuntimeEnvironment,
  provider: ethers.providers.Provider
): HardhatRuntimeEnvironment {
  const original = hre.ethers;
  const baseDeployment = async (name: string): Promise<Deployment | null> => {
    try {
      return JSON.parse(
        readFileSync(
          resolve(__dirname, `../deployments/base/${name}.json`),
          "utf8"
        )
      );
    } catch (error: unknown) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  };
  return {
    ...hre,
    getUnnamedAccounts: async () => [EXPECTED_LIVE.base.deployer],
    deployments: {
      ...hre.deployments,
      getArtifact: hre.deployments.getArtifact.bind(hre.deployments),
      getExtendedArtifact: hre.deployments.getExtendedArtifact.bind(
        hre.deployments
      ),
      getOrNull: baseDeployment,
      get: async (name: string) => {
        const deployment = await baseDeployment(name);
        if (!deployment) throw new Error(`${name} deployment record missing`);
        return deployment;
      },
    },
    ethers: {
      ...original,
      provider,
      getContractAt: async (artifactOrAbi: unknown, address: string) => {
        if (
          typeof artifactOrAbi !== "string" &&
          !Array.isArray(artifactOrAbi)
        ) {
          throw new Error(
            "Contract identifier must be an artifact name or ABI"
          );
        }
        const abi =
          typeof artifactOrAbi === "string"
            ? (await hre.deployments.getArtifact(artifactOrAbi)).abi
            : artifactOrAbi;
        return new ethers.Contract(address, abi, provider);
      },
    },
  } as HardhatRuntimeEnvironment;
}

export async function verifyActivationCandidate(
  hre: VerificationRuntimeEnvironment,
  input: {
    kind: ActivationBatchKind;
    batch: unknown;
    manifest: unknown;
    mode: ActivationGitMode;
    repositoryRoot: string;
    forkRpcUrl: string;
    artifactPaths: { batch: string; sidecar: string };
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
  validateActivationBatchManifest(manifestValue, { kind: input.kind });
  const manifest = manifestValue as ActivationBatchManifest;
  if (manifest.safe.toLowerCase() !== BASE_SAFE.toLowerCase()) {
    throw new Error("Safe manifest does not target the pinned ZKP2P Base Safe");
  }
  assertBatchMatchesActivationManifest(batch, manifest);
  const pathConfig = ACTIVATION_BATCH_PATHS[input.kind];
  assertActivationArtifactGitState(
    input.repositoryRoot,
    manifest.sourceSha,
    input.mode,
    [
      pathConfig.batch,
      pathConfig.sidecar,
      `${pathConfig.supersededDir}/base_method_scoped_${input.kind}_*`,
    ]
  );
  if (!input.forkRpcUrl) {
    throw new Error(
      "BASE_FORK_RPC_URL is required for Safe artifact verification"
    );
  }
  const injectedProvider = hre.__methodScopedVerificationProvider;
  const provider =
    injectedProvider || new ethers.providers.JsonRpcProvider(input.forkRpcUrl);
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
  const lane = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");
  await lane.loadActivationContext(verificationHre, "base");
  const expected = lane.expectedActivationState("base");
  if (
    manifest.proofSnapshot.inventory.escrow.toLowerCase() !==
    expected.addresses.escrow.toLowerCase()
  ) {
    throw new Error(
      "Manifest inventory escrow does not match canonical Base escrow"
    );
  }
  await assertContractIdentity(
    verificationHre,
    manifest,
    manifest.guard,
    "guard",
    block.number
  );
  await assertContractIdentity(
    verificationHre,
    manifest,
    manifest.postcondition,
    "postcondition",
    block.number
  );
  const snapshot = await lane.readActivationSnapshot(
    verificationHre,
    "base",
    block.number
  );
  if (
    canonicalJson(buildTrustSurface(expected)) !==
    canonicalJson(manifest.trustSurface)
  ) {
    throw new Error("Manifest trust surface does not match Base expectations");
  }
  assertGuardExpectationsUnchanged(
    manifest.kind,
    manifest.proofSnapshot,
    snapshot
  );
  const reduction = reduceActivation(snapshot, expected);
  const requiredPhase =
    manifest.kind === "rotation" ? "deployed" : "rotation-proposed";
  if (reduction.phase !== requiredPhase || reduction.waiting !== null) {
    throw new Error(
      `Verification state is not ${requiredPhase} with no waiting condition`
    );
  }
  await lane.runPinnedSimulation(manifest, input.forkRpcUrl);
}

export async function verifyVaultActivationCandidate(
  hre: VerificationRuntimeEnvironment,
  input: {
    kind: VaultActivationBatchKind;
    batch: unknown;
    manifest: unknown;
    mode: ActivationGitMode;
    repositoryRoot: string;
    forkRpcUrl: string;
    artifactPaths: { batch: string; sidecar: string };
    lane?: VaultActivationLaneBindings;
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
  validateVaultActivationBatchManifest(manifestValue, { kind: input.kind });
  const manifest = manifestValue as VaultActivationBatchManifest;
  if (manifest.safe.toLowerCase() !== BASE_SAFE.toLowerCase()) {
    throw new Error("Safe manifest does not target the pinned ZKP2P Base Safe");
  }
  assertBatchMatchesVaultActivationManifest(batch, manifest);
  const pathConfig = VAULT_ACTIVATION_BATCH_PATHS[input.kind];
  assertActivationArtifactGitState(
    input.repositoryRoot,
    manifest.sourceSha,
    input.mode,
    [
      pathConfig.batch,
      pathConfig.sidecar,
      `${pathConfig.supersededDir}/base_method_scoped_${input.kind.replace(
        /-/g,
        "_"
      )}_*`,
    ]
  );
  if (!input.forkRpcUrl) {
    throw new Error(
      "BASE_FORK_RPC_URL is required for Safe artifact verification"
    );
  }
  const provider =
    hre.__methodScopedVerificationProvider ||
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

  const lane: VaultActivationLaneBindings =
    input.lane || require("../deploy/40_activate_method_scoped_vault_stack.ts");
  await lane.loadVaultActivationContext(verificationHre, "base");
  const expected = lane.expectedVaultActivationState("base");
  if (
    manifest.proofSnapshot.inventory.escrow.toLowerCase() !==
    expected.addresses.escrow.toLowerCase()
  ) {
    throw new Error(
      "Manifest inventory escrow does not match canonical Base escrow"
    );
  }
  await assertVaultContractIdentity(
    verificationHre,
    manifest,
    manifest.guard,
    "guard",
    block.number
  );
  await assertVaultContractIdentity(
    verificationHre,
    manifest,
    manifest.postcondition,
    "postcondition",
    block.number
  );
  const snapshot = await lane.readVaultActivationSnapshot(
    verificationHre,
    "base",
    block.number
  );
  if (
    vaultCanonicalJson(buildVaultTrustSurface(expected)) !==
    vaultCanonicalJson(manifest.trustSurface)
  ) {
    throw new Error("Manifest trust surface does not match Base expectations");
  }
  assertVaultGuardExpectationsUnchanged(
    manifest.kind,
    manifest.proofSnapshot,
    snapshot
  );
  const reduction = reduceVaultActivation(snapshot, expected);
  const requiredPhase =
    manifest.kind === "vault-cutover" ? "deployed" : "active";
  if (reduction.phase !== requiredPhase || reduction.waiting !== null) {
    throw new Error(
      `Verification state is not ${requiredPhase} with no waiting condition`
    );
  }
  await lane.runPinnedSimulation(manifest, input.forkRpcUrl);
}

export async function verifyMethodScopedSafeArtifacts(
  hre: HardhatRuntimeEnvironment,
  kind: AnyActivationBatchKind,
  mode: ActivationGitMode,
  repositoryRoot: string,
  forkRpcUrl: string
): Promise<void> {
  if (kind === "vault-cutover" || kind === "vault-writer-removal") {
    const paths = VAULT_ACTIVATION_BATCH_PATHS[kind];
    const artifactPaths = {
      batch: resolve(repositoryRoot, paths.batch),
      sidecar: resolve(repositoryRoot, paths.sidecar),
    };
    await verifyVaultActivationCandidate(hre, {
      kind,
      batch: undefined,
      manifest: undefined,
      mode,
      repositoryRoot,
      forkRpcUrl,
      artifactPaths,
    });
    return;
  }
  const paths = ACTIVATION_BATCH_PATHS[kind];
  const artifactPaths = {
    batch: resolve(repositoryRoot, paths.batch),
    sidecar: resolve(repositoryRoot, paths.sidecar),
  };
  await verifyActivationCandidate(hre, {
    kind,
    batch: undefined,
    manifest: undefined,
    mode,
    repositoryRoot,
    forkRpcUrl,
    artifactPaths,
  });
}

async function main(): Promise<void> {
  const kindIndex = process.argv.indexOf("--batch");
  const modeIndex = process.argv.indexOf("--mode");
  const kind = process.argv[kindIndex + 1] as AnyActivationBatchKind;
  const mode = (
    modeIndex >= 0 ? process.argv[modeIndex + 1] : "artifact-child"
  ) as ActivationGitMode;
  if (
    kind !== "rotation" &&
    kind !== "cutover" &&
    kind !== "vault-cutover" &&
    kind !== "vault-writer-removal"
  ) {
    throw new Error(
      "--batch must be rotation, cutover, vault-cutover, or vault-writer-removal"
    );
  }
  if (mode !== "generation" && mode !== "artifact-child") {
    throw new Error(`Unknown Git-state mode ${mode}`);
  }
  const repositoryRoot = resolve(__dirname, "..");
  const hre: HardhatRuntimeEnvironment = require("hardhat");
  await verifyMethodScopedSafeArtifacts(
    hre,
    kind,
    mode,
    repositoryRoot,
    process.env.BASE_FORK_RPC_URL || ""
  );
  console.log(`Verified ${kind} activation artifact in ${mode} mode`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
