import { spawnSync } from "child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { dirname, resolve } from "path";
import { BigNumber, BigNumberish, providers } from "ethers";
import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  ACTIVE_PAYMENT_METHODS,
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  MULTI_SIG,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  PREDECESSOR_DISPUTE_STACKS,
  assertHistoricalDisputeStack,
} from "./32_deploy_and_activate_dispute_lifecycle_stack";
import { paymentBindingCutoverReady } from "./31_deploy_v3_payment_binding_stack";
import {
  DisputeSafeBatchManifest,
  NormalizedSafeBatchTransaction,
  canonicalTransactionHash,
  normalizeSafeTransactions,
  validateSafeBatchManifest,
} from "../deployments/safeBatchManifest";
import {
  BASE_SAFE,
  BASE_SAFE_RUNTIME_HASH,
  buildBasePostconditionConfig,
} from "../scripts/simulate-dispute-opt-in-safe-batch";
import {
  DISPUTE_SAFE_BATCH_PATH,
  DISPUTE_SAFE_SIDECAR_PATH,
  assertBatchMatchesManifest,
  assertSafeArtifactGitState,
} from "../scripts/verify-dispute-opt-in-safe-batch";

export const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);

export const LOCAL_DISPUTE_DEPLOYMENT_NAMES = [
  "DisputeNullifierRegistry",
  "DisputeVerifier",
  "StakeVaultOptIn",
  "DisputeProtectionPolicyOptIn",
  "IntentLifecycleHookV1OptIn",
] as const;

export const LIVE_SUCCESSOR_DEPLOYMENT_NAMES = [
  "StakeVaultOptIn",
  "DisputeProtectionPolicyOptIn",
  "IntentLifecycleHookV1OptIn",
] as const;

type LiveNetwork = "base" | "base_staging";
type DeploymentName = (typeof LOCAL_DISPUTE_DEPLOYMENT_NAMES)[number];
type LivePhaseInput = {
  artifacts: number;
  configured: boolean;
  currentHook: "predecessor" | "successor" | "other";
  writers: "predecessor" | "both" | "successor" | "other";
};
type PrefixPhase = "absent" | "partial" | "prepared";
type LiveValidationMode = "deploy-only" | "activation";
export type StagingActivationAction =
  | "add-fresh-writer"
  | "set-fresh-hook"
  | "remove-predecessor-writer";

const ARTIFACT_NAMES: Record<DeploymentName, string> = {
  DisputeNullifierRegistry: "NullifierRegistry",
  DisputeVerifier: "DisputeVerifier",
  StakeVaultOptIn: "StakeVault",
  DisputeProtectionPolicyOptIn: "DisputeProtectionPolicy",
  IntentLifecycleHookV1OptIn: "IntentLifecycleHookV1",
};

const COMMON_DEPLOY_ONLY_STEPS = [
  "deploy-vault",
  "deploy-policy",
  "deploy-hook",
  "initialize-controller",
  "authorize-hook",
  ...DISPUTABLE_PAYMENT_METHODS.map((method) => `set-risk-window:${method}`),
] as const;

export const DEPLOY_ONLY_STEP_KINDS: Record<LiveNetwork, readonly string[]> = {
  base_staging: [...COMMON_DEPLOY_ONLY_STEPS],
  base: [
    ...COMMON_DEPLOY_ONLY_STEPS,
    "transfer-vault-owner",
    "transfer-policy-owner",
    "cancel-predecessor-vault-owner",
    "cancel-predecessor-policy-owner",
  ],
};

export const EXPECTED_LIVE: Record<
  LiveNetwork,
  {
    deployer: string;
    orchestratorRegistry: string;
    orchestratorRegistryCodeHash: string;
    whitelistPolicy: string;
    whitelistPolicyCodeHash: string;
    orchestrator: string;
    orchestratorCodeHash: string;
    nullifierRegistryV2: string;
    nullifierRegistryV2CodeHash: string;
    attestationVerifier: string;
    attestationVerifierCodeHash: string;
    attestationWitnesses: string[];
    escrowRegistry: string;
    paymentVerifierRegistry: string;
    relayerRegistry: string;
    addressGroupRegistry: string;
    protocolFeeRecipient: string;
    stakeToken: string;
  }
> = {
  base: {
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    orchestratorRegistry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
    orchestratorRegistryCodeHash:
      "0xf0d132d621ac03181a6fade6a93bd0968d33830c8bf393793236787e7978aee1",
    whitelistPolicy: "0xBC53641b4B2504f0061D6a9426C61B8eBE9B4Ff0",
    whitelistPolicyCodeHash:
      "0xa3cf0fdf3835887de432cbac9c192edf6c93a8589748aa93f8294333d57024b2",
    orchestrator: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
    orchestratorCodeHash:
      "0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9",
    nullifierRegistryV2: "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB",
    nullifierRegistryV2CodeHash:
      "0x423e2a2183ecd538864079b6268f41957028c25514d1de57bd3d0e70fa6b9bd4",
    attestationVerifier: "0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5",
    attestationVerifierCodeHash:
      "0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a",
    attestationWitnesses: [
      "0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754",
      "0xE078D93bFdd87A8c5C5cCA5905DCbA0Dd7A1F0BD",
    ],
    escrowRegistry: "0xeD0e847B101abc96E796260AC358e12BAa2f5B21",
    paymentVerifierRegistry: "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e",
    relayerRegistry: "0xEbA979889a9c97382A92472fF3703786fF180083",
    addressGroupRegistry: "0x39F80118f9eB619135f116171b6Cb91D372C5AF2",
    protocolFeeRecipient: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    stakeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  base_staging: {
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    orchestratorRegistry: "0xfA6384EB6176cfEC049540526A3d2126C3666d8A",
    orchestratorRegistryCodeHash:
      "0xf0d132d621ac03181a6fade6a93bd0968d33830c8bf393793236787e7978aee1",
    whitelistPolicy: "0x7d9277cb8bb78a51eeaafB7CFF306E7DA4C972fD",
    whitelistPolicyCodeHash:
      "0x917965fdc75580147ad0787c86f8b2a0f0185ef6e101567b82dc1245d6eb63bc",
    orchestrator: "0x2b5E8Ab562e45fA89D73802605E145ED3E3EeF4f",
    orchestratorCodeHash:
      "0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9",
    nullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
    nullifierRegistryV2CodeHash:
      "0xd9d2f4b8bbca6fe26d7a0dfd7e0d6a6d63823ab2a1fe12971e752cf33dee72a0",
    attestationVerifier: "0x9855a39aC5975069632e91160d8712CBfF19e864",
    attestationVerifierCodeHash:
      "0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a",
    attestationWitnesses: [
      "0x66649F896521b0fb487fE2077b4FBDA283d7f19a",
      "0x4ab950AE1e3326578Bf7e643a2031E858aBa2927",
    ],
    escrowRegistry: "0xc545f336eC77E69bf115729acCbf2e557A00ac91",
    paymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
    relayerRegistry: "0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E",
    addressGroupRegistry: "0x54Ff7788Cb42B46FE2F016a65Fd0f654Bb9BcF3D",
    protocolFeeRecipient: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    stakeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function paymentMethodHash(method: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(method));
}

export function classifyDeployOnlyPrefix(
  network: LiveNetwork,
  completed: readonly boolean[]
): { phase: PrefixPhase; nextStep: number | null } {
  const steps = DEPLOY_ONLY_STEP_KINDS[network];
  if (completed.length !== steps.length) {
    throw new Error(`Deploy-only state length mismatch for ${network}`);
  }
  const firstMissing = completed.indexOf(false);
  if (firstMissing >= 0 && completed.slice(firstMissing + 1).some(Boolean)) {
    throw new Error("Deploy-only state is not a contiguous prefix");
  }
  if (firstMissing === -1) return { phase: "prepared", nextStep: null };
  return {
    phase: firstMissing === 0 ? "absent" : "partial",
    nextStep: firstMissing,
  };
}

export function classifyLiveDisputePhase(
  input: LivePhaseInput
): "absent" | "partial" | "deployed" | "prepared" | "active" {
  if (
    input.artifacts === 0 &&
    !input.configured &&
    input.currentHook === "predecessor" &&
    input.writers === "predecessor"
  )
    return "absent";
  if (
    (input.artifacts === 1 || input.artifacts === 2) &&
    !input.configured &&
    input.currentHook === "predecessor" &&
    input.writers === "predecessor"
  )
    return "partial";
  if (
    input.artifacts === 3 &&
    !input.configured &&
    input.currentHook === "predecessor" &&
    input.writers === "predecessor"
  )
    return "deployed";
  if (
    input.artifacts === 3 &&
    input.configured &&
    input.currentHook === "predecessor" &&
    (input.writers === "predecessor" || input.writers === "both")
  )
    return "prepared";
  if (
    input.artifacts === 3 &&
    input.configured &&
    input.currentHook === "successor" &&
    (input.writers === "both" || input.writers === "successor")
  )
    return "active";
  throw new Error("Invalid live dispute phase");
}

export function nextStagingActivationAction(state: {
  predecessorWriter: boolean;
  freshWriter: boolean;
  hook: "predecessor" | "successor" | "other";
}): StagingActivationAction | null {
  if (
    state.predecessorWriter &&
    !state.freshWriter &&
    state.hook === "predecessor"
  ) {
    return "add-fresh-writer";
  }
  if (
    state.predecessorWriter &&
    state.freshWriter &&
    state.hook === "predecessor"
  ) {
    return "set-fresh-hook";
  }
  if (
    state.predecessorWriter &&
    state.freshWriter &&
    state.hook === "successor"
  ) {
    return "remove-predecessor-writer";
  }
  if (
    !state.predecessorWriter &&
    state.freshWriter &&
    state.hook === "successor"
  )
    return null;
  throw new Error("Unrecognized Base staging activation state");
}

export function requireActivationPreconditions(input: {
  activation: boolean;
  downstreamReady: boolean;
  predecessorDrained: boolean;
  paymentBindingReady: boolean;
}): void {
  if (!input.activation) throw new Error("Missing activation confirmation");
  if (!input.downstreamReady)
    throw new Error("Missing downstream-ready confirmation");
  if (!input.predecessorDrained)
    throw new Error("Missing predecessor-drained confirmation");
  if (!input.paymentBindingReady)
    throw new Error("V3 payment binding is not fully cut over");
}

type OwnershipSnapshot = {
  address: string;
  owner: string;
  pendingOwner: string;
};
type BaseGovernanceSnapshot = {
  safe: string;
  verifier: OwnershipSnapshot;
  vault: OwnershipSnapshot;
  policy: OwnershipSnapshot;
  registry: { address: string; owner: string; writers: string[] };
  predecessorPolicy: string;
  orchestrator: { address: string; owner: string; currentHook: string };
  predecessorHook: string;
  freshHook: string;
};

const ownershipInterface = new ethers.utils.Interface([
  "function acceptOwnership()",
]);
const writerInterface = new ethers.utils.Interface([
  "function addWritePermission(address writer)",
  "function removeWritePermission(address writer)",
]);
const lifecycleInterface = new ethers.utils.Interface([
  "function setLifecycleHook(address hook)",
]);

export function buildBaseGovernanceTransactions(
  snapshot: BaseGovernanceSnapshot
): NormalizedSafeBatchTransaction[] {
  const safe = snapshot.safe.toLowerCase();
  const transactions: Array<{
    to: string;
    value: string;
    data: string;
    operation: number;
  }> = [];
  const appendOwnershipAcceptance = (
    contract: OwnershipSnapshot,
    label: string,
    optional: boolean
  ): void => {
    if (contract.owner.toLowerCase() === safe) {
      if (!sameAddress(contract.pendingOwner, ethers.constants.AddressZero)) {
        throw new Error(`${label} is Safe-owned with a pending takeover`);
      }
      return;
    }
    if (contract.pendingOwner.toLowerCase() !== safe) {
      if (optional)
        throw new Error(
          `${label} ownership is neither held nor pending for the Safe`
        );
      throw new Error(`${label} ownership acceptance is not prepared`);
    }
    transactions.push({
      to: contract.address,
      value: "0",
      data: ownershipInterface.encodeFunctionData("acceptOwnership"),
      operation: 0,
    });
  };

  appendOwnershipAcceptance(snapshot.verifier, "DisputeVerifier", true);
  appendOwnershipAcceptance(snapshot.vault, "StakeVaultOptIn", false);
  appendOwnershipAcceptance(
    snapshot.policy,
    "DisputeProtectionPolicyOptIn",
    false
  );
  if (snapshot.registry.owner.toLowerCase() !== safe)
    throw new Error("Dispute registry is not Safe-owned");
  if (
    snapshot.registry.writers.length !== 1 ||
    !sameAddress(snapshot.registry.writers[0], snapshot.predecessorPolicy)
  )
    throw new Error(
      "Base dispute writer set is not the exact predecessor state"
    );
  if (snapshot.orchestrator.owner.toLowerCase() !== safe)
    throw new Error("OrchestratorV3 is not Safe-owned");
  if (
    !sameAddress(snapshot.orchestrator.currentHook, snapshot.predecessorHook)
  ) {
    throw new Error("OrchestratorV3 is not on the predecessor lifecycle hook");
  }
  transactions.push(
    {
      to: snapshot.registry.address,
      value: "0",
      data: writerInterface.encodeFunctionData("addWritePermission", [
        snapshot.policy.address,
      ]),
      operation: 0,
    },
    {
      to: snapshot.registry.address,
      value: "0",
      data: writerInterface.encodeFunctionData("removeWritePermission", [
        snapshot.predecessorPolicy,
      ]),
      operation: 0,
    },
    {
      to: snapshot.orchestrator.address,
      value: "0",
      data: lifecycleInterface.encodeFunctionData("setLifecycleHook", [
        snapshot.freshHook,
      ]),
      operation: 0,
    }
  );
  return normalizeSafeTransactions(transactions);
}

type StagingActivationSnapshot = {
  registry: string;
  predecessorPolicy: string;
  freshPolicy: string;
  orchestrator: string;
  freshHook: string;
};

export function buildStagingActivationTransaction(
  action: StagingActivationAction,
  snapshot: StagingActivationSnapshot
): NormalizedSafeBatchTransaction {
  if (action === "add-fresh-writer") {
    return normalizeSafeTransactions([
      {
        to: snapshot.registry,
        value: "0",
        data: writerInterface.encodeFunctionData("addWritePermission", [
          snapshot.freshPolicy,
        ]),
        operation: 0,
      },
    ])[0];
  }
  if (action === "set-fresh-hook") {
    return normalizeSafeTransactions([
      {
        to: snapshot.orchestrator,
        value: "0",
        data: lifecycleInterface.encodeFunctionData("setLifecycleHook", [
          snapshot.freshHook,
        ]),
        operation: 0,
      },
    ])[0];
  }
  return normalizeSafeTransactions([
    {
      to: snapshot.registry,
      value: "0",
      data: writerInterface.encodeFunctionData("removeWritePermission", [
        snapshot.predecessorPolicy,
      ]),
      operation: 0,
    },
  ])[0];
}

export function requirePredecessorDrainedForWriterRemoval(
  action: StagingActivationAction,
  totalStaked: BigNumberish,
  totalClaimable: BigNumberish
): void {
  if (
    action === "remove-predecessor-writer" &&
    (!ethers.BigNumber.from(totalStaked).isZero() ||
      !ethers.BigNumber.from(totalClaimable).isZero())
  ) {
    throw new Error(
      "Predecessor StakeVault accounting is nonzero; writer removal refused"
    );
  }
}

const OBSOLETE_BASE_BATCH_TARGETS = [
  PREDECESSOR_DISPUTE_STACKS.base.contracts.DisputeVerifier.address,
  PREDECESSOR_DISPUTE_STACKS.base.contracts.StakeVault.address,
  PREDECESSOR_DISPUTE_STACKS.base.contracts.DisputeProtectionPolicy.address,
  EXPECTED_LIVE.base.orchestrator,
] as const;

export function assertObsoleteBaseBatchShape(
  batch: any
): NormalizedSafeBatchTransaction[] {
  const expectedData = [
    ownershipInterface.encodeFunctionData("acceptOwnership"),
    ownershipInterface.encodeFunctionData("acceptOwnership"),
    ownershipInterface.encodeFunctionData("acceptOwnership"),
    lifecycleInterface.encodeFunctionData("setLifecycleHook", [
      PREDECESSOR_DISPUTE_STACKS.base.contracts.IntentLifecycleHookV1.address,
    ]),
  ];
  if (
    batch?.version !== "1.0" ||
    batch?.chainId !== "8453" ||
    !sameAddress(batch?.meta?.createdFromSafeAddress || "", BASE_SAFE) ||
    !Array.isArray(batch?.transactions) ||
    batch.transactions.length !== OBSOLETE_BASE_BATCH_TARGETS.length
  )
    throw new Error("Obsolete Base dispute batch shape drifted");
  const transactions = normalizeSafeTransactions(
    batch.transactions.map((transaction: any) => ({
      ...transaction,
      operation: transaction.operation ?? 0,
    }))
  );
  for (let index = 0; index < transactions.length; index += 1) {
    if (
      !sameAddress(
        transactions[index].to,
        OBSOLETE_BASE_BATCH_TARGETS[index]
      ) ||
      transactions[index].value !== "0" ||
      transactions[index].data !== expectedData[index].toLowerCase() ||
      transactions[index].operation !== 0
    )
      throw new Error("Obsolete Base dispute batch transaction drifted");
  }
  return transactions;
}

async function assertRuntimeHash(
  address: string,
  expectedHash: string,
  label: string
): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || ethers.utils.keccak256(code) !== expectedHash) {
    throw new Error(`${label} runtime bytecode hash mismatch`);
  }
}

async function assertCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} has no runtime bytecode`);
  }
}

async function assertDeploymentAddress(
  hre: HardhatRuntimeEnvironment,
  name: string,
  expectedAddress: string
): Promise<any> {
  const deployment = await hre.deployments.get(name);
  if (!sameAddress(deployment.address, expectedAddress)) {
    throw new Error(`${name} deployment address mismatch`);
  }
  return deployment;
}

function zeroImmutableValues(
  bytecode: string,
  immutableReferences: Record<string, Array<{ start: number; length: number }>>
): string {
  let normalized = bytecode.slice(2).toLowerCase();
  for (const references of Object.values(immutableReferences)) {
    for (const reference of references) {
      const start = reference.start * 2;
      const length = reference.length * 2;
      normalized = `${normalized.slice(0, start)}${"0".repeat(
        length
      )}${normalized.slice(start + length)}`;
    }
  }
  return `0x${normalized}`;
}

async function assertCanonicalDeployment(
  hre: HardhatRuntimeEnvironment,
  deployment: any,
  name: DeploymentName
): Promise<void> {
  const artifact = await hre.deployments.getExtendedArtifact(
    ARTIFACT_NAMES[name]
  );
  const code = await ethers.provider.getCode(deployment.address);
  if (
    code === "0x" ||
    typeof deployment.deployedBytecode !== "string" ||
    typeof deployment.solcInputHash !== "string" ||
    typeof artifact.deployedBytecode !== "string" ||
    deployment.solcInputHash !== artifact.solcInputHash
  ) {
    throw new Error(`${name} lacks canonical deployment evidence`);
  }
  const immutableReferences =
    artifact.evm?.deployedBytecode?.immutableReferences || {};
  const normalized = zeroImmutableValues(code, immutableReferences);
  if (
    normalized !==
      zeroImmutableValues(deployment.deployedBytecode, immutableReferences) ||
    normalized !==
      zeroImmutableValues(artifact.deployedBytecode, immutableReferences)
  ) {
    throw new Error(`${name} runtime bytecode is not the canonical build`);
  }
}

async function assertLiveSharedState(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork,
  mode: LiveValidationMode = "deploy-only",
  successorHook?: string
): Promise<void> {
  const expected = EXPECTED_LIVE[network];
  const [deployer] = await hre.getUnnamedAccounts();
  if (!sameAddress(deployer, expected.deployer)) {
    throw new Error("Deployment signer does not match the approved deployer");
  }
  if (!sameAddress(USDC[network], expected.stakeToken)) {
    throw new Error("StakeVault token does not match the approved USDC target");
  }
  if (!STAKE_VAULT_CONTROLLER_CHANGE_DELAY.eq(172_800)) {
    throw new Error("StakeVault controller delay drifted from 172800 seconds");
  }

  await assertHistoricalDisputeStack(hre as any);
  await assertDeploymentAddress(
    hre,
    "OrchestratorRegistry",
    expected.orchestratorRegistry
  );
  await assertDeploymentAddress(
    hre,
    "WhitelistPolicy",
    expected.whitelistPolicy
  );
  await assertDeploymentAddress(hre, "OrchestratorV3", expected.orchestrator);
  await assertDeploymentAddress(
    hre,
    "NullifierRegistryV2",
    expected.nullifierRegistryV2
  );
  await assertDeploymentAddress(
    hre,
    "MultiAttestationVerifier",
    expected.attestationVerifier
  );
  await assertDeploymentAddress(hre, "EscrowRegistry", expected.escrowRegistry);
  await assertDeploymentAddress(
    hre,
    "PaymentVerifierRegistry",
    expected.paymentVerifierRegistry
  );
  await assertDeploymentAddress(
    hre,
    "RelayerRegistry",
    expected.relayerRegistry
  );
  await assertDeploymentAddress(
    hre,
    "AddressGroupRegistry",
    expected.addressGroupRegistry
  );
  await Promise.all([
    assertRuntimeHash(
      expected.orchestratorRegistry,
      expected.orchestratorRegistryCodeHash,
      "OrchestratorRegistry"
    ),
    assertRuntimeHash(
      expected.whitelistPolicy,
      expected.whitelistPolicyCodeHash,
      "WhitelistPolicy"
    ),
    assertRuntimeHash(
      expected.orchestrator,
      expected.orchestratorCodeHash,
      "OrchestratorV3"
    ),
    assertRuntimeHash(
      expected.nullifierRegistryV2,
      expected.nullifierRegistryV2CodeHash,
      "NullifierRegistryV2"
    ),
    assertRuntimeHash(
      expected.attestationVerifier,
      expected.attestationVerifierCodeHash,
      "MultiAttestationVerifier"
    ),
    assertCode(expected.stakeToken, "USDC"),
  ]);

  const predecessor = PREDECESSOR_DISPUTE_STACKS[network];
  const verifier = await ethers.getContractAt(
    "DisputeVerifier",
    predecessor.contracts.DisputeVerifier.address
  );
  const governance = MULTI_SIG[network] || deployer;
  if (
    !sameAddress(
      await verifier.nullifierRegistry(),
      expected.nullifierRegistryV2
    ) ||
    !sameAddress(
      await verifier.attestationVerifier(),
      expected.attestationVerifier
    )
  ) {
    throw new Error("Reused DisputeVerifier dependency mismatch");
  }
  const verifierOwner = await verifier.owner();
  const verifierPendingOwner = await verifier.pendingOwner();
  const verifierIsDeployOnly =
    sameAddress(verifierOwner, deployer) &&
    (network === "base"
      ? sameAddress(verifierPendingOwner, governance)
      : sameAddress(verifierPendingOwner, ethers.constants.AddressZero));
  const verifierIsActivated =
    network === "base" &&
    sameAddress(verifierOwner, governance) &&
    sameAddress(verifierPendingOwner, ethers.constants.AddressZero);
  if (
    !verifierIsDeployOnly &&
    !(mode === "activation" && verifierIsActivated)
  ) {
    throw new Error("Reused DisputeVerifier ownership state drifted");
  }

  const attestationVerifier = await ethers.getContractAt(
    "MultiAttestationVerifier",
    expected.attestationVerifier
  );
  const witnesses: string[] = await attestationVerifier.witnesses();
  if (
    !sameAddress(await attestationVerifier.owner(), governance) ||
    !(await attestationVerifier.requiredSignatures()).eq(1) ||
    witnesses.length !== expected.attestationWitnesses.length ||
    witnesses.some(
      (witness, index) =>
        !sameAddress(witness, expected.attestationWitnesses[index])
    )
  )
    throw new Error("MultiAttestationVerifier mutable configuration drifted");

  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    expected.orchestrator
  );
  const currentLifecycleHook = await orchestrator.lifecycleHook();
  const lifecycleHookAllowed =
    sameAddress(
      currentLifecycleHook,
      predecessor.activeLifecycleHook.address
    ) ||
    (mode === "activation" &&
      typeof successorHook === "string" &&
      sameAddress(currentLifecycleHook, successorHook));
  if (!lifecycleHookAllowed)
    throw new Error("OrchestratorV3 lifecycle hook drifted");

  const predecessorVault = await ethers.getContractAt(
    "StakeVault",
    predecessor.contracts.StakeVault.address
  );
  const stakeToken = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    expected.stakeToken
  );
  const predecessorBalances = await Promise.all([
    predecessorVault.totalStaked(),
    predecessorVault.totalClaimable(),
    predecessorVault.totalAccounted(),
    predecessorVault.unaccountedBalance(),
    stakeToken.balanceOf(predecessorVault.address),
  ]);
  if (
    mode === "deploy-only" &&
    predecessorBalances.some((balance) => !balance.isZero())
  ) {
    throw new Error("Predecessor StakeVault is not empty");
  }
  if (
    !sameAddress(await predecessorVault.stakeToken(), expected.stakeToken) ||
    !(await predecessorVault.controllerChangeDelay()).eq(
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY
    ) ||
    !sameAddress(
      await predecessorVault.controller(),
      predecessor.contracts.DisputeProtectionPolicy.address
    ) ||
    !sameAddress(
      await predecessorVault.pendingController(),
      ethers.constants.AddressZero
    ) ||
    !(await predecessorVault.pendingControllerValidAt()).isZero()
  )
    throw new Error("Predecessor StakeVault configuration drifted");

  const predecessorPolicy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    predecessor.contracts.DisputeProtectionPolicy.address
  );
  if (
    (await predecessorPolicy.admissionsPaused()) ||
    !sameAddress(
      await predecessorPolicy.stakeVault(),
      predecessorVault.address
    ) ||
    !sameAddress(
      await predecessorPolicy.disputeVerifier(),
      predecessor.contracts.DisputeVerifier.address
    ) ||
    !sameAddress(
      await predecessorPolicy.disputeNullifierRegistry(),
      predecessor.contracts.DisputeNullifierRegistry.address
    ) ||
    !(await predecessorPolicy.isLifecycleHookAuthorized(
      predecessor.contracts.IntentLifecycleHookV1.address
    ))
  )
    throw new Error("Predecessor dispute policy configuration drifted");

  const disputeRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    predecessor.contracts.DisputeNullifierRegistry.address
  );
  const writers: string[] = await disputeRegistry.getWriters();
  const successorPolicy =
    mode === "activation"
      ? (await hre.deployments.get("DisputeProtectionPolicyOptIn")).address
      : undefined;
  const writerSetAllowed =
    writers.length > 0 &&
    writers.length <= 2 &&
    writers.every(
      (writer) =>
        sameAddress(writer, predecessorPolicy.address) ||
        (typeof successorPolicy === "string" &&
          sameAddress(writer, successorPolicy))
    ) &&
    new Set(writers.map((writer) => writer.toLowerCase())).size ===
      writers.length;
  if (
    !sameAddress(await disputeRegistry.owner(), governance) ||
    (mode === "deploy-only"
      ? writers.length !== 1 ||
        !sameAddress(writers[0], predecessorPolicy.address)
      : !writerSetAllowed)
  )
    throw new Error("Predecessor dispute registry owner or writer set drifted");

  if (
    !sameAddress(await orchestrator.owner(), governance) ||
    (await orchestrator.paused()) ||
    !(await orchestrator.chainId()).eq(8453) ||
    !sameAddress(
      await orchestrator.escrowRegistry(),
      expected.escrowRegistry
    ) ||
    !sameAddress(
      await orchestrator.paymentVerifierRegistry(),
      expected.paymentVerifierRegistry
    ) ||
    !sameAddress(
      await orchestrator.relayerRegistry(),
      expected.relayerRegistry
    ) ||
    !(await orchestrator.protocolFee()).isZero() ||
    !sameAddress(
      await orchestrator.protocolFeeRecipient(),
      expected.protocolFeeRecipient
    ) ||
    (await orchestrator.allowMultipleIntents())
  )
    throw new Error("OrchestratorV3 governance state drifted");
  const orchestratorRegistry = await ethers.getContractAt(
    "OrchestratorRegistry",
    expected.orchestratorRegistry
  );
  if (!(await orchestratorRegistry.isOrchestrator(orchestrator.address))) {
    throw new Error("OrchestratorV3 is not registered");
  }
  const whitelistPolicy = await ethers.getContractAt(
    "WhitelistPolicy",
    expected.whitelistPolicy
  );
  if (
    !sameAddress(await whitelistPolicy.owner(), governance) ||
    !sameAddress(
      await whitelistPolicy.groupRegistry(),
      expected.addressGroupRegistry
    ) ||
    !sameAddress(
      await whitelistPolicy.escrowRegistry(),
      expected.escrowRegistry
    ) ||
    !sameAddress(
      await whitelistPolicy.orchestratorRegistry(),
      expected.orchestratorRegistry
    )
  )
    throw new Error("WhitelistPolicy mutable configuration drifted");

  if (network === "base_staging") {
    for (const [label, contract] of [
      ["Predecessor StakeVault", predecessorVault],
      ["Predecessor policy", predecessorPolicy],
    ] as const) {
      if (
        !sameAddress(await contract.owner(), deployer) ||
        !sameAddress(
          await contract.pendingOwner(),
          ethers.constants.AddressZero
        )
      )
        throw new Error(`${label} ownership state drifted`);
    }
  }
}

async function readBasePredecessorCancellationState(
  network: LiveNetwork,
  deployer: string,
  governance: string
): Promise<boolean[]> {
  if (network !== "base") return [];
  const predecessor = PREDECESSOR_DISPUTE_STACKS.base;
  const vault = await ethers.getContractAt(
    "StakeVault",
    predecessor.contracts.StakeVault.address
  );
  const policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    predecessor.contracts.DisputeProtectionPolicy.address
  );
  const completed: boolean[] = [];
  for (const [label, contract] of [
    ["Predecessor StakeVault", vault],
    ["Predecessor policy", policy],
  ] as const) {
    if (!sameAddress(await contract.owner(), deployer)) {
      throw new Error(
        `${label} owner drifted before obsolete transfer cancellation`
      );
    }
    const pendingOwner = await contract.pendingOwner();
    if (sameAddress(pendingOwner, ethers.constants.AddressZero))
      completed.push(true);
    else if (sameAddress(pendingOwner, governance)) completed.push(false);
    else throw new Error(`${label} pending owner drifted before cancellation`);
  }
  return completed;
}

export async function getSuccessorDeployments(
  hre: HardhatRuntimeEnvironment
): Promise<Array<any | null>> {
  const records = await Promise.all(
    LIVE_SUCCESSOR_DEPLOYMENT_NAMES.map((name) =>
      hre.deployments.getOrNull(name)
    )
  );
  const deployments = records.map((deployment) => deployment ?? null);
  const firstMissing = deployments.findIndex(
    (deployment) => deployment === null
  );
  if (
    firstMissing >= 0 &&
    deployments
      .slice(firstMissing + 1)
      .some((deployment) => deployment !== null)
  ) {
    throw new Error(
      "Successor deployment artifacts are not a contiguous prefix"
    );
  }
  for (let index = 0; index < deployments.length; index += 1) {
    if (deployments[index]) {
      await assertCanonicalDeployment(
        hre,
        deployments[index],
        LIVE_SUCCESSOR_DEPLOYMENT_NAMES[index]
      );
    }
  }
  return deployments;
}

export function ownershipStepState(
  owner: string,
  pendingOwner: string,
  deployer: string,
  governance: string,
  label: string
): boolean {
  if (
    sameAddress(owner, governance) &&
    sameAddress(pendingOwner, ethers.constants.AddressZero)
  )
    return true;
  if (
    !sameAddress(deployer, governance) &&
    sameAddress(owner, deployer) &&
    sameAddress(pendingOwner, governance)
  )
    return true;
  if (
    sameAddress(owner, deployer) &&
    sameAddress(pendingOwner, ethers.constants.AddressZero)
  )
    return false;
  throw new Error(`${label} owner or pending owner drifted`);
}

export function requireLocalPaymentBindingReady(ready: boolean): void {
  if (!ready) {
    throw new Error(
      "Local V3 payment binding must be fully cut over before dispute activation"
    );
  }
}

async function assertOnlySuccessorHookAuthorization(
  policy: any,
  deployment: any,
  hook: string
): Promise<boolean> {
  const fromBlock = deployment.receipt?.blockNumber;
  if (typeof fromBlock !== "number" || !Number.isSafeInteger(fromBlock)) {
    throw new Error(
      "DisputeProtectionPolicyOptIn lacks deployment block evidence"
    );
  }
  const logs = await policy.queryFilter(
    policy.filters.LifecycleHookAuthorizationUpdated(),
    fromBlock,
    await ethers.provider.getBlockNumber()
  );
  const authorization = new Map<string, boolean>();
  for (const log of logs) {
    const authorizedHook = log.args?.hook || log.args?.[0];
    const isAuthorized = log.args?.isAuthorized ?? log.args?.[1];
    if (!authorizedHook || typeof isAuthorized !== "boolean") {
      throw new Error("Unable to decode lifecycle-hook authorization history");
    }
    authorization.set(authorizedHook.toLowerCase(), isAuthorized);
  }
  const active = [...authorization.entries()]
    .filter(([, value]) => value)
    .map(([address]) => address);
  if (active.some((address) => address !== hook.toLowerCase())) {
    throw new Error("Successor policy authorized an unexpected lifecycle hook");
  }
  return active.length === 1;
}

async function assertFreshStackUnused(
  hre: HardhatRuntimeEnvironment,
  deployments: any[]
): Promise<void> {
  if (deployments.some((deployment) => !deployment)) return;
  const vault = await ethers.getContractAt(
    "StakeVault",
    deployments[0].address
  );
  const policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    deployments[1].address
  );
  const stakeToken = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    await vault.stakeToken()
  );
  const balances = await Promise.all([
    vault.totalStaked(),
    vault.totalClaimable(),
    vault.totalAccounted(),
    vault.unaccountedBalance(),
    stakeToken.balanceOf(vault.address),
  ]);
  if (balances.some((balance) => !balance.isZero())) {
    throw new Error("Fresh StakeVault is not empty before activation");
  }

  const fromBlocks = deployments.map(
    (deployment) => deployment.receipt?.blockNumber
  );
  if (fromBlocks.some((blockNumber) => typeof blockNumber !== "number")) {
    throw new Error("Fresh successor artifacts lack deployment block evidence");
  }
  const fromBlock = Math.min(...fromBlocks);
  const currentBlock = await ethers.provider.getBlockNumber();
  const policyTopics = [
    "DisputeProtectionIntentOpened(bytes32,address,address,address,bytes32,uint256,uint64)",
    "DisputeProtectionIntentCancelled(bytes32,address,uint256)",
    "DisputeProtectionIntentSettled(bytes32,address,address,uint256,uint64,bool)",
    "DisputeProtectionIntentReleased(bytes32,address,uint256)",
    "DisputeResolved(bytes32,address,address,uint256,bytes32)",
    "DisputeProtectionEnabledUpdated(address,uint256,bool)",
  ].map(ethers.utils.id);
  const vaultTopics = [
    "StakeDeposited(address,uint256,uint256)",
    "StakeWithdrawn(address,uint256,uint256)",
    "TakerAuthorizationUpdated(address,address,bool)",
    "StakeOwnerSelected(address,address,address)",
    "StakeLocked(bytes32,address,uint256,uint64,uint256)",
    "LockFunded(bytes32,address,uint256,uint256)",
    "StakeLockIncreased(bytes32,address,uint256,uint256,uint256)",
    "StakeLockResized(bytes32,address,uint256,uint256,uint64,uint64,uint256)",
    "StakeUnlocked(bytes32,address,uint256,uint256)",
    "StakeLockResolved(bytes32,address,uint256,uint256,uint256,uint256)",
    "ClaimCreated(bytes32,address,uint256,uint256)",
    "ClaimWithdrawn(address,uint256)",
  ].map(ethers.utils.id);
  const [policyLogs, vaultLogs] = await Promise.all([
    ethers.provider.getLogs({
      address: policy.address,
      fromBlock,
      toBlock: currentBlock,
      topics: [policyTopics],
    }),
    ethers.provider.getLogs({
      address: vault.address,
      fromBlock,
      toBlock: currentBlock,
      topics: [vaultTopics],
    }),
  ]);
  if (policyLogs.length !== 0 || vaultLogs.length !== 0) {
    throw new Error("Fresh successor stack has preactivation activity");
  }
}

async function readLiveDeployOnlyPrefix(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork,
  mode: LiveValidationMode = "deploy-only"
): Promise<{
  completed: boolean[];
  deployments: any[];
  contracts?: { vault: any; policy: any; hook: any };
}> {
  const successorDeployments = await getSuccessorDeployments(hre);
  if (
    mode === "activation" &&
    successorDeployments.some((deployment) => deployment === null)
  ) {
    throw new Error("Successor stack is incomplete before activation");
  }
  const successorHook = successorDeployments[2]?.address;
  await assertLiveSharedState(hre, network, mode, successorHook);
  const completed = successorDeployments.map(Boolean);
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const cancellationState = await readBasePredecessorCancellationState(
    network,
    deployer,
    governance
  );
  if (successorDeployments.some((deployment) => deployment === null)) {
    completed.push(
      ...DEPLOY_ONLY_STEP_KINDS[network].slice(3).map(() => false)
    );
    if (network === "base") completed.splice(-2, 2, ...cancellationState);

    const [vaultDeployment, policyDeployment, hookDeployment] =
      successorDeployments;
    if (vaultDeployment) {
      const vault = await ethers.getContractAt(
        "StakeVault",
        vaultDeployment.address
      );
      if (
        !sameAddress(
          await vault.stakeToken(),
          EXPECTED_LIVE[network].stakeToken
        ) ||
        !(await vault.controllerChangeDelay()).eq(
          STAKE_VAULT_CONTROLLER_CHANGE_DELAY
        ) ||
        !sameAddress(await vault.controller(), ethers.constants.AddressZero) ||
        !sameAddress(
          await vault.pendingController(),
          ethers.constants.AddressZero
        ) ||
        !(await vault.pendingControllerValidAt()).isZero() ||
        !sameAddress(await vault.owner(), deployer) ||
        !sameAddress(
          await vault.pendingOwner(),
          ethers.constants.AddressZero
        ) ||
        !(await vault.totalStaked()).isZero() ||
        !(await vault.totalClaimable()).isZero()
      )
        throw new Error("Partial successor StakeVault state drifted");
    }
    if (policyDeployment) {
      if (!vaultDeployment)
        throw new Error("Successor policy exists before its vault");
      const policy = await ethers.getContractAt(
        "DisputeProtectionPolicy",
        policyDeployment.address
      );
      const predecessor = PREDECESSOR_DISPUTE_STACKS[network];
      if (
        !sameAddress(await policy.stakeVault(), vaultDeployment.address) ||
        !sameAddress(
          await policy.disputeVerifier(),
          predecessor.contracts.DisputeVerifier.address
        ) ||
        !sameAddress(
          await policy.disputeNullifierRegistry(),
          predecessor.contracts.DisputeNullifierRegistry.address
        ) ||
        (await policy.admissionsPaused()) ||
        !sameAddress(await policy.owner(), deployer) ||
        !sameAddress(await policy.pendingOwner(), ethers.constants.AddressZero)
      )
        throw new Error("Partial successor policy state drifted");
      for (const method of ACTIVE_PAYMENT_METHODS) {
        if (!(await policy.getRiskWindow(paymentMethodHash(method))).isZero()) {
          throw new Error(
            `Partial successor risk window exists before hook deployment: ${method}`
          );
        }
      }
    }
    if (hookDeployment) {
      if (!policyDeployment)
        throw new Error("Successor hook exists before its policy");
      const hook: any = await ethers.getContractAt(
        "IntentLifecycleHookV1",
        hookDeployment.address
      );
      if (
        !sameAddress(
          await hook.orchestratorRegistry(),
          EXPECTED_LIVE[network].orchestratorRegistry
        ) ||
        !sameAddress(
          await hook.whitelistPolicy(),
          EXPECTED_LIVE[network].whitelistPolicy
        ) ||
        !sameAddress(
          await hook.disputeProtectionPolicy(),
          policyDeployment.address
        )
      )
        throw new Error("Partial successor lifecycle hook state drifted");
    }
    classifyDeployOnlyPrefix(network, completed);
    return { completed, deployments: successorDeployments };
  }

  const [vaultDeployment, policyDeployment, hookDeployment] =
    successorDeployments as any[];
  const vault = await ethers.getContractAt(
    "StakeVault",
    vaultDeployment.address
  );
  const policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    policyDeployment.address
  );
  const hook: any = await ethers.getContractAt(
    "IntentLifecycleHookV1",
    hookDeployment.address
  );
  const expected = EXPECTED_LIVE[network];
  const predecessor = PREDECESSOR_DISPUTE_STACKS[network];

  if (
    !sameAddress(await vault.stakeToken(), expected.stakeToken) ||
    !(await vault.controllerChangeDelay()).eq(
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY
    ) ||
    !sameAddress(
      await vault.pendingController(),
      ethers.constants.AddressZero
    ) ||
    !(await vault.pendingControllerValidAt()).isZero()
  )
    throw new Error(
      "Successor StakeVault dependency or controller state drifted"
    );
  if (
    !sameAddress(await policy.stakeVault(), vault.address) ||
    !sameAddress(
      await policy.disputeVerifier(),
      predecessor.contracts.DisputeVerifier.address
    ) ||
    !sameAddress(
      await policy.disputeNullifierRegistry(),
      predecessor.contracts.DisputeNullifierRegistry.address
    ) ||
    (await policy.admissionsPaused())
  )
    throw new Error("Successor policy dependency state drifted");
  if (
    !sameAddress(
      await hook.orchestratorRegistry(),
      expected.orchestratorRegistry
    ) ||
    !sameAddress(await hook.whitelistPolicy(), expected.whitelistPolicy) ||
    !sameAddress(await hook.disputeProtectionPolicy(), policy.address)
  )
    throw new Error("Successor lifecycle hook dependency state drifted");

  if (mode === "deploy-only")
    await assertFreshStackUnused(hre, successorDeployments as any[]);
  const registry = await ethers.getContractAt(
    "NullifierRegistry",
    predecessor.contracts.DisputeNullifierRegistry.address
  );
  const writers: string[] = await registry.getWriters();
  const allowedActivationWriters =
    mode === "activation" &&
    writers.length > 0 &&
    writers.length <= 2 &&
    writers.every(
      (writer) =>
        sameAddress(
          writer,
          predecessor.contracts.DisputeProtectionPolicy.address
        ) || sameAddress(writer, policy.address)
    ) &&
    new Set(writers.map((writer) => writer.toLowerCase())).size ===
      writers.length;
  if (
    mode === "deploy-only"
      ? writers.length !== 1 ||
        !sameAddress(
          writers[0],
          predecessor.contracts.DisputeProtectionPolicy.address
        )
      : !allowedActivationWriters
  ) {
    throw new Error("Deploy-only dispute writer set drifted");
  }

  const controller = await vault.controller();
  if (
    !sameAddress(controller, ethers.constants.AddressZero) &&
    !sameAddress(controller, policy.address)
  ) {
    throw new Error("Successor StakeVault controller drifted");
  }
  completed.push(sameAddress(controller, policy.address));
  completed.push(
    await assertOnlySuccessorHookAuthorization(
      policy,
      policyDeployment,
      hook.address
    )
  );

  const disputableMethods = new Set(DISPUTABLE_PAYMENT_METHODS);
  for (const method of ACTIVE_PAYMENT_METHODS) {
    const actual = await policy.getRiskWindow(paymentMethodHash(method));
    const expectedWindow = disputableMethods.has(method)
      ? DISPUTE_RISK_WINDOW[network]
      : ethers.constants.Zero;
    if (!actual.isZero() && !actual.eq(expectedWindow)) {
      throw new Error(`Successor risk window drifted for ${method}`);
    }
  }
  for (const method of DISPUTABLE_PAYMENT_METHODS) {
    completed.push(
      (await policy.getRiskWindow(paymentMethodHash(method))).eq(
        DISPUTE_RISK_WINDOW[network]
      )
    );
  }

  if (network === "base") {
    completed.push(
      ownershipStepState(
        await vault.owner(),
        await vault.pendingOwner(),
        deployer,
        governance,
        "Successor StakeVault"
      )
    );
    completed.push(
      ownershipStepState(
        await policy.owner(),
        await policy.pendingOwner(),
        deployer,
        governance,
        "Successor policy"
      )
    );
    completed.push(...cancellationState);
  } else if (
    !sameAddress(await vault.owner(), deployer) ||
    !sameAddress(await vault.pendingOwner(), ethers.constants.AddressZero) ||
    !sameAddress(await policy.owner(), deployer) ||
    !sameAddress(await policy.pendingOwner(), ethers.constants.AddressZero)
  ) {
    throw new Error("Base staging successor ownership drifted");
  }

  classifyDeployOnlyPrefix(network, completed);
  return {
    completed,
    deployments: successorDeployments as any[],
    contracts: { vault, policy, hook },
  };
}

async function deployLiveSuccessor(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork
): Promise<void> {
  const flag =
    network === "base"
      ? "ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT"
      : "ENABLE_STAGING_V3_DISPUTE_OPT_IN_DEPLOYMENT";
  if (process.env[flag] !== "true")
    throw new Error(`${network} successor deployment requires ${flag}=true`);

  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  while (true) {
    const state = await readLiveDeployOnlyPrefix(hre, network);
    const prefix = classifyDeployOnlyPrefix(network, state.completed);
    if (prefix.nextStep === null) {
      console.log(
        `=== ${network} opt-in dispute successor deployed passively ===`
      );
      return;
    }
    const step = DEPLOY_ONLY_STEP_KINDS[network][prefix.nextStep];
    const predecessor = PREDECESSOR_DISPUTE_STACKS[network];
    const expected = EXPECTED_LIVE[network];

    if (step === "deploy-vault") {
      const deployment = await hre.deployments.deploy("StakeVaultOptIn", {
        contract: "StakeVault",
        from: deployer,
        args: [
          deployer,
          expected.stakeToken,
          ethers.constants.AddressZero,
          STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
        ],
        log: true,
      });
      if (!deployment.newlyDeployed)
        throw new Error("StakeVaultOptIn was not freshly deployed");
    } else if (step === "deploy-policy") {
      const vault = await hre.deployments.get("StakeVaultOptIn");
      const deployment = await hre.deployments.deploy(
        "DisputeProtectionPolicyOptIn",
        {
          contract: "DisputeProtectionPolicy",
          from: deployer,
          args: [
            deployer,
            vault.address,
            predecessor.contracts.DisputeVerifier.address,
            predecessor.contracts.DisputeNullifierRegistry.address,
          ],
          log: true,
        }
      );
      if (!deployment.newlyDeployed)
        throw new Error(
          "DisputeProtectionPolicyOptIn was not freshly deployed"
        );
    } else if (step === "deploy-hook") {
      const policy = await hre.deployments.get("DisputeProtectionPolicyOptIn");
      const deployment = await hre.deployments.deploy(
        "IntentLifecycleHookV1OptIn",
        {
          contract: "IntentLifecycleHookV1",
          from: deployer,
          args: [
            expected.orchestratorRegistry,
            expected.whitelistPolicy,
            policy.address,
          ],
          log: true,
        }
      );
      if (!deployment.newlyDeployed)
        throw new Error("IntentLifecycleHookV1OptIn was not freshly deployed");
    } else {
      if (!state.contracts)
        throw new Error(`Missing successor contracts for ${step}`);
      if (step === "initialize-controller") {
        await (
          await state.contracts.vault.initializeController(
            state.contracts.policy.address
          )
        ).wait();
      } else if (step === "authorize-hook") {
        await (
          await state.contracts.policy.setLifecycleHookAuthorization(
            state.contracts.hook.address,
            true
          )
        ).wait();
      } else if (step.startsWith("set-risk-window:")) {
        const method = step.slice("set-risk-window:".length);
        await (
          await state.contracts.policy.setRiskWindow(
            paymentMethodHash(method),
            DISPUTE_RISK_WINDOW[network]
          )
        ).wait();
      } else if (step === "transfer-vault-owner") {
        await (
          await state.contracts.vault.transferOwnership(governance)
        ).wait();
      } else if (step === "transfer-policy-owner") {
        await (
          await state.contracts.policy.transferOwnership(governance)
        ).wait();
      } else if (step === "cancel-predecessor-vault-owner") {
        const vault = await ethers.getContractAt(
          "StakeVault",
          predecessor.contracts.StakeVault.address
        );
        await (
          await vault.transferOwnership(ethers.constants.AddressZero)
        ).wait();
      } else if (step === "cancel-predecessor-policy-owner") {
        const policy = await ethers.getContractAt(
          "DisputeProtectionPolicy",
          predecessor.contracts.DisputeProtectionPolicy.address
        );
        await (
          await policy.transferOwnership(ethers.constants.AddressZero)
        ).wait();
      } else {
        throw new Error(`Unknown deploy-only step ${step}`);
      }
    }
    await waitForDeploymentDelay(hre);
  }
}

const STAGING_PREPARE_FLAG = "PREPARE_STAGING_V3_DISPUTE_OPT_IN_ACTIVATION";
const STAGING_EXECUTE_FLAG = "ENABLE_STAGING_V3_DISPUTE_OPT_IN_ACTIVATION";
const BASE_PREPARE_FLAG =
  "ENABLE_BASE_V3_DISPUTE_OPT_IN_GOVERNANCE_PREPARATION";

function activationConfirmation(network: LiveNetwork, suffix: string): boolean {
  const prefix = network === "base" ? "BASE" : "STAGING";
  return (
    process.env[`CONFIRM_${prefix}_V3_DISPUTE_OPT_IN_${suffix}`] === "true"
  );
}

async function requireLiveActivationPreconditions(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork
): Promise<void> {
  requireActivationPreconditions({
    activation: activationConfirmation(network, "ACTIVATION"),
    downstreamReady: activationConfirmation(network, "DOWNSTREAM_READY"),
    predecessorDrained: activationConfirmation(network, "PREDECESSOR_DRAINED"),
    paymentBindingReady: await paymentBindingCutoverReady(hre),
  });
}

async function readStagingActivationAction(
  hre: HardhatRuntimeEnvironment
): Promise<{
  action: StagingActivationAction | null;
  transaction?: NormalizedSafeBatchTransaction;
  predecessorAccounting: { totalStaked: BigNumber; totalClaimable: BigNumber };
}> {
  const state = await readLiveDeployOnlyPrefix(
    hre,
    "base_staging",
    "activation"
  );
  if (
    classifyDeployOnlyPrefix("base_staging", state.completed).nextStep !==
      null ||
    !state.contracts
  ) {
    throw new Error("Base staging successor stack is not passively prepared");
  }
  const predecessor = PREDECESSOR_DISPUTE_STACKS.base_staging;
  const registry = await ethers.getContractAt(
    "NullifierRegistry",
    predecessor.contracts.DisputeNullifierRegistry.address
  );
  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    EXPECTED_LIVE.base_staging.orchestrator
  );
  const writers: string[] = await registry.getWriters();
  const predecessorWriter = writers.some((writer) =>
    sameAddress(writer, predecessor.contracts.DisputeProtectionPolicy.address)
  );
  const freshWriter = writers.some((writer) =>
    sameAddress(writer, state.contracts!.policy.address)
  );
  const currentHook = await orchestrator.lifecycleHook();
  const hook = sameAddress(currentHook, predecessor.activeLifecycleHook.address)
    ? "predecessor"
    : sameAddress(currentHook, state.contracts.hook.address)
    ? "successor"
    : "other";
  const action = nextStagingActivationAction({
    predecessorWriter,
    freshWriter,
    hook,
  });
  const predecessorVault = await ethers.getContractAt(
    "StakeVault",
    predecessor.contracts.StakeVault.address
  );
  const [totalStaked, totalClaimable] = await Promise.all([
    predecessorVault.totalStaked(),
    predecessorVault.totalClaimable(),
  ]);
  const predecessorAccounting = { totalStaked, totalClaimable };
  if (action === null) return { action, predecessorAccounting };

  if (action === "add-fresh-writer" || action === "set-fresh-hook") {
    await assertFreshStackUnused(hre, state.deployments);
  }
  return {
    action,
    predecessorAccounting,
    transaction: buildStagingActivationTransaction(action, {
      registry: registry.address,
      predecessorPolicy: predecessor.contracts.DisputeProtectionPolicy.address,
      freshPolicy: state.contracts.policy.address,
      orchestrator: orchestrator.address,
      freshHook: state.contracts.hook.address,
    }),
  };
}

async function preflightStagingTransaction(
  transaction: NormalizedSafeBatchTransaction
): Promise<{
  request: providers.TransactionRequest;
  nonce: number;
  gasLimit: BigNumber;
}> {
  const deployer = EXPECTED_LIVE.base_staging.deployer;
  const signer = await ethers.getSigner(deployer);
  const nonce = await ethers.provider.getTransactionCount(deployer, "pending");
  const [balance, feeData] = await Promise.all([
    ethers.provider.getBalance(deployer),
    ethers.provider.getFeeData(),
  ]);
  const baseRequest: providers.TransactionRequest = {
    from: deployer,
    to: transaction.to,
    value: transaction.value,
    data: transaction.data,
    nonce,
  };
  await ethers.provider.call(baseRequest);
  const gasLimit = await signer.estimateGas(baseRequest);
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  if (!gasPrice)
    throw new Error("Base staging RPC did not return a usable gas price");
  if (balance.lt(gasLimit.mul(gasPrice))) {
    throw new Error(
      "Base staging deployer balance is insufficient for the next activation call"
    );
  }
  const request: providers.TransactionRequest = { ...baseRequest, gasLimit };
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    request.maxFeePerGas = feeData.maxFeePerGas;
    request.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    request.type = 2;
  } else {
    request.gasPrice = gasPrice;
  }
  return { request, nonce, gasLimit };
}

export function requireStableStagingNonce(
  initialNonce: number,
  executionNonce: number
): void {
  if (executionNonce !== initialNonce) {
    throw new Error("Base staging deployer nonce changed after preflight");
  }
}

async function prepareOrExecuteStagingActivation(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const preparing = process.env[STAGING_PREPARE_FLAG] === "true";
  const executing = process.env[STAGING_EXECUTE_FLAG] === "true";
  if (preparing === executing) {
    throw new Error(
      `Set exactly one of ${STAGING_PREPARE_FLAG}=true or ${STAGING_EXECUTE_FLAG}=true`
    );
  }
  await requireLiveActivationPreconditions(hre, "base_staging");
  const before = await readStagingActivationAction(hre);
  if (before.action === null) {
    console.log(
      "=== Base staging opt-in dispute lifecycle is already active ==="
    );
    return;
  }
  if (!before.transaction)
    throw new Error("Missing next Base staging activation transaction");
  requirePredecessorDrainedForWriterRemoval(
    before.action,
    before.predecessorAccounting.totalStaked,
    before.predecessorAccounting.totalClaimable
  );
  const preflight = await preflightStagingTransaction(before.transaction);
  console.log(
    `Base staging next activation call: ${before.action}; nonce=${
      preflight.nonce
    }; gas=${preflight.gasLimit.toString()}`
  );
  if (!executing) return;

  const executionState = await readStagingActivationAction(hre);
  if (executionState.action !== before.action || !executionState.transaction) {
    throw new Error("Base staging activation state changed after preflight");
  }
  requirePredecessorDrainedForWriterRemoval(
    executionState.action,
    executionState.predecessorAccounting.totalStaked,
    executionState.predecessorAccounting.totalClaimable
  );
  if (
    JSON.stringify(executionState.transaction) !==
    JSON.stringify(before.transaction)
  ) {
    throw new Error(
      "Base staging activation transaction changed after preflight"
    );
  }
  const executionPreflight = await preflightStagingTransaction(
    executionState.transaction
  );
  requireStableStagingNonce(preflight.nonce, executionPreflight.nonce);

  const signer = await ethers.getSigner(EXPECTED_LIVE.base_staging.deployer);
  const response = await signer.sendTransaction(executionPreflight.request);
  await response.wait();
  await waitForDeploymentDelay(hre);
  if (!(await paymentBindingCutoverReady(hre))) {
    throw new Error(
      "V3 payment binding drifted after Base staging activation call"
    );
  }
  const after = await readStagingActivationAction(hre);
  const expectedNext: Record<
    StagingActivationAction,
    StagingActivationAction | null
  > = {
    "add-fresh-writer": "set-fresh-hook",
    "set-fresh-hook": "remove-predecessor-writer",
    "remove-predecessor-writer": null,
  };
  if (after.action !== expectedNext[before.action]) {
    throw new Error(
      "Base staging activation did not advance by exactly one state"
    );
  }
  console.log(
    `Base staging activation advanced exactly one step: ${before.action}`
  );
}

function safeBatchJson(
  transactions: NormalizedSafeBatchTransaction[],
  createdAt: number
): any {
  return {
    version: "1.0",
    chainId: "8453",
    createdAt,
    meta: {
      name: "ZKP2P opt-in dispute lifecycle activation - base",
      description:
        "Atomic ownership, writer, and OrchestratorV3 lifecycle-hook cutover",
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: BASE_SAFE,
      createdFromOwnerAddress: "",
    },
    transactions: transactions.map((transaction) => ({
      ...transaction,
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
}

function writeSafeArtifactPair(
  batchPath: string,
  batchContents: string,
  sidecarPath: string,
  sidecarContents: string
): void {
  const batchExists = existsSync(batchPath);
  const sidecarExists = existsSync(sidecarPath);
  if (batchExists !== sidecarExists)
    throw new Error(
      "Safe batch and sidecar must either both exist or both be absent"
    );
  if (batchExists) {
    if (
      readFileSync(batchPath, "utf8") !== batchContents ||
      readFileSync(sidecarPath, "utf8") !== sidecarContents
    ) {
      throw new Error(
        "Existing deterministic Safe artifacts differ from the freshly simulated pair"
      );
    }
    return;
  }

  mkdirSync(dirname(batchPath), { recursive: true });
  const batchTemporary = `${batchPath}.tmp-${process.pid}`;
  const sidecarTemporary = `${sidecarPath}.tmp-${process.pid}`;
  const opened: number[] = [];
  let batchPublished = false;
  let sidecarPublished = false;
  try {
    for (const [temporary, contents] of [
      [batchTemporary, batchContents],
      [sidecarTemporary, sidecarContents],
    ] as const) {
      const descriptor = openSync(temporary, "wx", 0o600);
      opened.push(descriptor);
      writeSync(descriptor, contents);
      fsyncSync(descriptor);
      closeSync(descriptor);
      opened.pop();
    }
    renameSync(batchTemporary, batchPath);
    batchPublished = true;
    renameSync(sidecarTemporary, sidecarPath);
    sidecarPublished = true;
    const directoryDescriptor = openSync(dirname(batchPath), "r");
    opened.push(directoryDescriptor);
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    opened.pop();
  } catch (error) {
    for (const descriptor of opened) closeSync(descriptor);
    for (const temporary of [batchTemporary, sidecarTemporary]) {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    if (batchPublished && existsSync(batchPath)) unlinkSync(batchPath);
    if (sidecarPublished && existsSync(sidecarPath)) unlinkSync(sidecarPath);
    throw error;
  }
}

function runPinnedBaseSafeSimulation(
  manifest: DisputeSafeBatchManifest,
  postconditions: Awaited<ReturnType<typeof buildBasePostconditionConfig>>,
  forkRpcUrl: string
): void {
  const repositoryRoot = resolve(__dirname, "..");
  const hardhatCli = require.resolve("hardhat/internal/cli/cli");
  const simulationScript = resolve(
    repositoryRoot,
    "scripts/simulate-dispute-opt-in-safe-batch.ts"
  );
  const result = spawnSync(
    process.execPath,
    [
      hardhatCli,
      "run",
      "--network",
      "hardhat",
      "--no-compile",
      simulationScript,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_FORK_RPC_URL: forkRpcUrl,
        DISPUTE_SAFE_SIMULATION_PAYLOAD: JSON.stringify({
          manifest,
          postconditions,
        }),
      },
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Pinned Base Safe simulation failed:\n${result.stdout || ""}${
        result.stderr || ""
      }`
    );
  }
}

async function prepareBaseGovernanceBatch(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  if (process.env[BASE_PREPARE_FLAG] !== "true") {
    throw new Error(
      `Base governance preparation requires ${BASE_PREPARE_FLAG}=true`
    );
  }
  await requireLiveActivationPreconditions(hre, "base");
  const state = await readLiveDeployOnlyPrefix(hre, "base");
  if (
    classifyDeployOnlyPrefix("base", state.completed).nextStep !== null ||
    !state.contracts
  ) {
    throw new Error("Base successor stack is not passively prepared");
  }
  const repositoryRoot = resolve(__dirname, "..");
  const sourceSha = (
    process.env.CONFIRM_BASE_V3_DISPUTE_OPT_IN_RELEASE_READY_SHA || ""
  ).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(
      "Base governance preparation requires an exact release-ready source SHA confirmation"
    );
  }
  assertSafeArtifactGitState(repositoryRoot, sourceSha, "generation");
  const forkRpcUrl = process.env.BASE_FORK_RPC_URL || "";
  if (!forkRpcUrl)
    throw new Error(
      "BASE_FORK_RPC_URL is required for Base governance preparation"
    );

  await assertRuntimeHash(BASE_SAFE, BASE_SAFE_RUNTIME_HASH, "Safe v1.3.0");
  const predecessor = PREDECESSOR_DISPUTE_STACKS.base;
  const verifier = await ethers.getContractAt(
    "DisputeVerifier",
    predecessor.contracts.DisputeVerifier.address
  );
  const registry = await ethers.getContractAt(
    "NullifierRegistry",
    predecessor.contracts.DisputeNullifierRegistry.address
  );
  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    EXPECTED_LIVE.base.orchestrator
  );
  const safe = await ethers.getContractAt(
    [
      "function VERSION() view returns (string)",
      "function nonce() view returns (uint256)",
    ],
    BASE_SAFE
  );
  if ((await safe.VERSION()) !== "1.3.0")
    throw new Error("Unsupported Base Safe version");
  const transactions = buildBaseGovernanceTransactions({
    safe: BASE_SAFE,
    verifier: {
      address: verifier.address,
      owner: await verifier.owner(),
      pendingOwner: await verifier.pendingOwner(),
    },
    vault: {
      address: state.contracts.vault.address,
      owner: await state.contracts.vault.owner(),
      pendingOwner: await state.contracts.vault.pendingOwner(),
    },
    policy: {
      address: state.contracts.policy.address,
      owner: await state.contracts.policy.owner(),
      pendingOwner: await state.contracts.policy.pendingOwner(),
    },
    registry: {
      address: registry.address,
      owner: await registry.owner(),
      writers: await registry.getWriters(),
    },
    predecessorPolicy: predecessor.contracts.DisputeProtectionPolicy.address,
    orchestrator: {
      address: orchestrator.address,
      owner: await orchestrator.owner(),
      currentHook: await orchestrator.lifecycleHook(),
    },
    predecessorHook: predecessor.activeLifecycleHook.address,
    freshHook: state.contracts.hook.address,
  });
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 8453)
    throw new Error("Base governance preparation is on the wrong chain");
  const blockNumber = await ethers.provider.getBlockNumber();
  const block = await ethers.provider.getBlock(blockNumber);
  if (!block?.hash)
    throw new Error(
      "Base governance preparation could not pin the simulation block"
    );
  const manifest: DisputeSafeBatchManifest = {
    version: 1,
    chainId: 8453,
    safe: BASE_SAFE.toLowerCase(),
    safeNonce: (await safe.nonce()).toString(),
    sourceSha,
    simulationBlockNumber: block.number,
    simulationBlockHash: block.hash.toLowerCase(),
    simulationResult: "success",
    transactions,
    transactionsSha256: canonicalTransactionHash(transactions),
  };
  validateSafeBatchManifest(manifest, manifest);
  const batch = safeBatchJson(transactions, block.timestamp * 1000);
  assertBatchMatchesManifest(batch, manifest);
  const postconditions = await buildBasePostconditionConfig(hre);
  runPinnedBaseSafeSimulation(manifest, postconditions, forkRpcUrl);

  const batchPath = resolve(repositoryRoot, DISPUTE_SAFE_BATCH_PATH);
  const sidecarPath = resolve(repositoryRoot, DISPUTE_SAFE_SIDECAR_PATH);
  writeSafeArtifactPair(
    batchPath,
    `${JSON.stringify(batch, null, 2)}\n`,
    sidecarPath,
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  console.log(
    `Prepared and simulated Base Safe batch: ${DISPUTE_SAFE_BATCH_PATH}`
  );
  console.log("No Safe transaction was signed, proposed, or executed.");
}

async function deployLocalSuccessor(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  requireLocalPaymentBindingReady(await paymentBindingCutoverReady(hre));
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const stakeToken =
    USDC[network] || (await hre.deployments.get("USDCMock")).address;
  const nullifierRegistryV2 = await hre.deployments.get("NullifierRegistryV2");
  const attestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));
  const orchestratorRegistry = await hre.deployments.get(
    "OrchestratorRegistry"
  );
  const whitelistPolicy = await hre.deployments.get("WhitelistPolicy");
  const orchestratorDeployment = await hre.deployments.get("OrchestratorV3");

  const deploy = async (
    name: DeploymentName,
    options: Record<string, unknown>
  ): Promise<any> => {
    const existing = await hre.deployments.getOrNull(name);
    if (existing) {
      await assertCanonicalDeployment(hre, existing, name);
      return existing;
    }
    const deployment = await hre.deployments.deploy(name, options as any);
    if (!deployment.newlyDeployed)
      throw new Error(`${name} was not freshly deployed`);
    await waitForDeploymentDelay(hre);
    await assertCanonicalDeployment(hre, deployment, name);
    return deployment;
  };

  const disputeRegistry = await deploy("DisputeNullifierRegistry", {
    contract: "NullifierRegistry",
    from: deployer,
    args: [],
    log: true,
  });
  const disputeVerifier = await deploy("DisputeVerifier", {
    contract: "DisputeVerifier",
    from: deployer,
    args: [deployer, nullifierRegistryV2.address, attestationVerifier.address],
    log: true,
  });
  const vaultDeployment = await deploy("StakeVaultOptIn", {
    contract: "StakeVault",
    from: deployer,
    args: [
      deployer,
      stakeToken,
      ethers.constants.AddressZero,
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ],
    log: true,
  });
  const policyDeployment = await deploy("DisputeProtectionPolicyOptIn", {
    contract: "DisputeProtectionPolicy",
    from: deployer,
    args: [
      deployer,
      vaultDeployment.address,
      disputeVerifier.address,
      disputeRegistry.address,
    ],
    log: true,
  });
  const hookDeployment = await deploy("IntentLifecycleHookV1OptIn", {
    contract: "IntentLifecycleHookV1",
    from: deployer,
    args: [
      orchestratorRegistry.address,
      whitelistPolicy.address,
      policyDeployment.address,
    ],
    log: true,
  });

  const vault = await ethers.getContractAt(
    "StakeVault",
    vaultDeployment.address
  );
  const policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    policyDeployment.address
  );
  const hook = await ethers.getContractAt(
    "IntentLifecycleHookV1",
    hookDeployment.address
  );
  const registry = await ethers.getContractAt(
    "NullifierRegistry",
    disputeRegistry.address
  );
  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    orchestratorDeployment.address
  );
  if (sameAddress(await vault.controller(), ethers.constants.AddressZero)) {
    await (await vault.initializeController(policy.address)).wait();
  }
  if (!(await registry.isWriter(policy.address))) {
    await (await registry.addWritePermission(policy.address)).wait();
  }
  if (!(await policy.isLifecycleHookAuthorized(hook.address))) {
    await (
      await policy.setLifecycleHookAuthorization(hook.address, true)
    ).wait();
  }
  for (const method of DISPUTABLE_PAYMENT_METHODS) {
    const methodHash = paymentMethodHash(method);
    if (
      !(await policy.getRiskWindow(methodHash)).eq(DISPUTE_RISK_WINDOW[network])
    ) {
      await (
        await policy.setRiskWindow(methodHash, DISPUTE_RISK_WINDOW[network])
      ).wait();
    }
  }
  if (!sameAddress(await orchestrator.lifecycleHook(), hook.address)) {
    await (await orchestrator.setLifecycleHook(hook.address)).wait();
  }
  const writers: string[] = await registry.getWriters();
  if (
    writers.length !== 1 ||
    !sameAddress(writers[0], policy.address) ||
    !sameAddress(await vault.controller(), policy.address) ||
    !sameAddress(await orchestrator.lifecycleHook(), hook.address)
  )
    throw new Error(
      "Local opt-in dispute lifecycle activation verification failed"
    );
}

export async function optInDisputeStackPrepared(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  if (network !== "base" && network !== "base_staging") return false;
  const state = await readLiveDeployOnlyPrefix(hre, network);
  return classifyDeployOnlyPrefix(network, state.completed).nextStep === null;
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (network === "base") {
    if (process.env[BASE_PREPARE_FLAG] === "true")
      await prepareBaseGovernanceBatch(hre);
    else await deployLiveSuccessor(hre, network);
    return;
  }
  if (network === "base_staging") {
    if (
      process.env[STAGING_PREPARE_FLAG] === "true" ||
      process.env[STAGING_EXECUTE_FLAG] === "true"
    )
      await prepareOrExecuteStagingActivation(hre);
    else await deployLiveSuccessor(hre, network);
    return;
  }
  await deployLocalSuccessor(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (network === "base" || network === "base_staging") {
    const governanceSelected =
      network === "base"
        ? process.env[BASE_PREPARE_FLAG] === "true"
        : process.env[STAGING_PREPARE_FLAG] === "true" ||
          process.env[STAGING_EXECUTE_FLAG] === "true";
    if (governanceSelected) return false;
    const flag =
      network === "base"
        ? "ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT"
        : "ENABLE_STAGING_V3_DISPUTE_OPT_IN_DEPLOYMENT";
    const artifacts = await Promise.all(
      LIVE_SUCCESSOR_DEPLOYMENT_NAMES.map((name) =>
        hre.deployments.getOrNull(name)
      )
    );
    const explicitlySelected =
      process.env.DEPLOY_ACTIVE_TAG ===
      "34_deploy_opt_in_dispute_lifecycle_stack";
    if (
      process.env[flag] !== "true" &&
      !explicitlySelected &&
      !artifacts.some(Boolean)
    )
      return true;
    return optInDisputeStackPrepared(hre);
  }
  return false;
};

func.tags = ["34_deploy_opt_in_dispute_lifecycle_stack", "V3DisputeOptInStack"];
func.dependencies = [];

export default func;
