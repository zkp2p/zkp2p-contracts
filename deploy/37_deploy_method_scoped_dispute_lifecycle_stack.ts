import type { BigNumberish, providers, utils } from "ethers";
import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction, Deployment } from "hardhat-deploy/types";

import { assertCanonicalDeployment } from "../deployments/canonicalDeployment";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS,
  assertHistoricalDisputeStack,
} from "../deployments/predecessorDisputeStack";
import {
  ACTIVE_PAYMENT_METHODS,
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  MULTI_SIG,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import { paymentBindingCutoverReady } from "./31_deploy_v3_payment_binding_stack";
import { METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME } from "./36_deploy_method_scoped_whitelist_policy";

export const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);

export const LOCAL_DISPUTE_DEPLOYMENT_NAMES = [
  "DisputeNullifierRegistry",
  "DisputeVerifier",
  "StakeVaultMethodScoped",
  "DisputeProtectionPolicyMethodScoped",
  "IntentLifecycleHookV1MethodScoped",
] as const;

export const LIVE_SUCCESSOR_DEPLOYMENT_NAMES = [
  "StakeVaultMethodScoped",
  "DisputeProtectionPolicyMethodScoped",
  "IntentLifecycleHookV1MethodScoped",
] as const;

type LiveNetwork = "base" | "base_staging";
type DeploymentName = (typeof LOCAL_DISPUTE_DEPLOYMENT_NAMES)[number];
type PrefixPhase = "absent" | "partial" | "prepared";

export const ARTIFACT_NAMES: Record<DeploymentName, string> = {
  DisputeNullifierRegistry: "NullifierRegistry",
  DisputeVerifier: "DisputeVerifier",
  StakeVaultMethodScoped: "StakeVault",
  DisputeProtectionPolicyMethodScoped: "DisputeProtectionPolicy",
  IntentLifecycleHookV1MethodScoped: "IntentLifecycleHookV1",
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
  ],
};

export const EXPECTED_LIVE: Record<
  LiveNetwork,
  {
    deployer: string;
    orchestratorRegistry: string;
    orchestratorRegistryCodeHash: string;
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

const LIVE_FLAGS: Record<LiveNetwork, string> = {
  base_staging: "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_DEPLOYMENT",
  base: "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_DEPLOYMENT",
};

export type FreshStackEvent = {
  name: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
};

export type FreshStackInput = {
  controllerInitialized: FreshStackEvent | null;
  policyEvents: FreshStackEvent[];
  vaultEvents: FreshStackEvent[];
  totalStaked: BigNumberish;
  totalClaimable: BigNumberish;
};

export const ALLOWED_POLICY_CONFIGURATION_EVENTS = [
  "DisputeProtectionEnabledUpdated",
] as const;

export const EXPECTED_POLICY_GOVERNANCE_EVENTS = [
  "RiskWindowUpdated",
  "DisputeVerifierUpdated",
  "LifecycleHookAuthorizationUpdated",
  "AdmissionsPausedUpdated",
  "OwnershipTransferStarted",
  "OwnershipTransferred",
] as const;

export const FORBIDDEN_POLICY_LIFECYCLE_EVENTS = [
  "DisputeProtectionIntentOpened",
  "DisputeProtectionIntentCancelled",
  "DisputeProtectionIntentSettled",
  "DisputeProtectionIntentReleased",
  "DisputeResolved",
] as const;

export const ALLOWED_VAULT_COLLATERAL_EVENTS = [
  "StakeDeposited",
  "StakeWithdrawn",
  "TakerAuthorizationUpdated",
  "StakeOwnerSelected",
] as const;

export const EXPECTED_VAULT_GOVERNANCE_EVENTS = [
  "ControllerInitialized",
  "ControllerProposed",
  "ControllerAccepted",
  "ControllerProposalCancelled",
  "OwnershipTransferStarted",
  "OwnershipTransferred",
] as const;

export const FORBIDDEN_VAULT_LOCK_EVENTS = [
  "StakeLocked",
  "LockFunded",
  "StakeLockIncreased",
  "StakeLockResized",
  "StakeUnlocked",
  "StakeLockResolved",
  "ClaimCreated",
  "ClaimWithdrawn",
] as const;

function eventOrder(event: FreshStackEvent): [number, number, number] {
  return [event.blockNumber, event.transactionIndex, event.logIndex];
}

function isBefore(left: FreshStackEvent, right: FreshStackEvent): boolean {
  const [lb, lt, ll] = eventOrder(left);
  const [rb, rt, rl] = eventOrder(right);
  return lb !== rb ? lb < rb : lt !== rt ? lt < rt : ll < rl;
}

function includes(list: readonly string[], name: string): boolean {
  return list.includes(name);
}

export function classifyFreshStackActivity(input: FreshStackInput): void {
  for (const event of input.policyEvents) {
    if (includes(FORBIDDEN_POLICY_LIFECYCLE_EVENTS, event.name)) {
      throw new Error(
        `Fresh DisputeProtectionPolicyMethodScoped has lifecycle activity: ${event.name} in ${event.transactionHash}`
      );
    }
    if (
      !includes(ALLOWED_POLICY_CONFIGURATION_EVENTS, event.name) &&
      !includes(EXPECTED_POLICY_GOVERNANCE_EVENTS, event.name)
    ) {
      throw new Error(
        `DisputeProtectionPolicyMethodScoped emitted an unclassified event: ${event.name} in ${event.transactionHash}`
      );
    }
  }
  for (const event of input.vaultEvents) {
    if (includes(FORBIDDEN_VAULT_LOCK_EVENTS, event.name)) {
      throw new Error(
        `Fresh StakeVaultMethodScoped has lock or claim activity: ${event.name} in ${event.transactionHash}`
      );
    }
    if (includes(ALLOWED_VAULT_COLLATERAL_EVENTS, event.name)) {
      if (
        !input.controllerInitialized ||
        isBefore(event, input.controllerInitialized)
      ) {
        throw new Error(
          `StakeVaultMethodScoped received collateral activity before controller initialization (${event.name} in ${event.transactionHash}); the lane cannot initialize the controller and must be superseded`
        );
      }
    } else if (!includes(EXPECTED_VAULT_GOVERNANCE_EVENTS, event.name)) {
      throw new Error(
        `StakeVaultMethodScoped emitted an unclassified event: ${event.name} in ${event.transactionHash}`
      );
    }
  }
  if (!ethers.BigNumber.from(input.totalClaimable).isZero()) {
    throw new Error(
      "StakeVaultMethodScoped totalClaimable must be zero before activation"
    );
  }
  if (
    !input.controllerInitialized &&
    !ethers.BigNumber.from(input.totalStaked).isZero()
  ) {
    throw new Error(
      "StakeVaultMethodScoped totalStaked must be zero before controller initialization"
    );
  }
}

export function decodeFreshStackLogs(
  contractInterface: utils.Interface,
  logs: providers.Log[],
  label: string
): FreshStackEvent[] {
  return logs.map((log) => {
    let name: string;
    try {
      name = contractInterface.getEvent(log.topics[0]).name;
    } catch {
      throw new Error(
        `${label} emitted a log this ABI cannot decode: ${log.topics[0]} in ${log.transactionHash}`
      );
    }
    return {
      name,
      blockNumber: log.blockNumber,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
    };
  });
}

function isLiveNetwork(network: string): network is LiveNetwork {
  return network === "base" || network === "base_staging";
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function paymentMethodHash(method: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(method));
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
): Promise<Deployment> {
  const deployment = await hre.deployments.get(name);
  if (!sameAddress(deployment.address, expectedAddress)) {
    throw new Error(`${name} deployment address mismatch`);
  }
  return deployment;
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

export async function getSuccessorDeployments(
  hre: HardhatRuntimeEnvironment
): Promise<Array<Deployment | null>> {
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
      "Method-scoped successor deployment artifacts are not a contiguous prefix"
    );
  }
  for (let index = 0; index < deployments.length; index += 1) {
    const deployment = deployments[index];
    if (deployment) {
      const name = LIVE_SUCCESSOR_DEPLOYMENT_NAMES[index];
      await assertCanonicalDeployment(
        hre,
        deployment,
        name,
        ARTIFACT_NAMES[name]
      );
    }
  }
  return deployments;
}

async function assertOnlySuccessorHookAuthorization(
  policy: any,
  deployment: Deployment,
  freshHook: string,
  predecessorHook?: string
): Promise<boolean> {
  const fromBlock = deployment.receipt?.blockNumber;
  if (typeof fromBlock !== "number" || !Number.isSafeInteger(fromBlock)) {
    throw new Error(
      "DisputeProtectionPolicyMethodScoped lacks deployment block evidence"
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
  if (
    active.some((address) => address !== freshHook.toLowerCase()) ||
    (predecessorHook &&
      (await policy.isLifecycleHookAuthorized(predecessorHook)))
  ) {
    throw new Error("Fresh policy authorized an unexpected lifecycle hook");
  }
  return (
    active.length === 1 && (await policy.isLifecycleHookAuthorized(freshHook))
  );
}

function deploymentBlock(deployment: Deployment, label: string): number {
  const blockNumber = deployment.receipt?.blockNumber;
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber)) {
    throw new Error(`${label} lacks deployment block evidence`);
  }
  return blockNumber;
}

async function assertFreshStackUnused(
  hre: HardhatRuntimeEnvironment,
  deployments: Array<Deployment | null>
): Promise<void> {
  const [vaultDeployment, policyDeployment] = deployments;
  const latestBlock = await ethers.provider.getBlockNumber();
  let controllerInitialized: FreshStackEvent | null = null;
  let vaultEvents: FreshStackEvent[] = [];
  let totalStaked: BigNumberish = 0;
  let totalClaimable: BigNumberish = 0;

  if (vaultDeployment) {
    const vault = await ethers.getContractAt(
      "StakeVault",
      vaultDeployment.address
    );
    [totalStaked, totalClaimable] = await Promise.all([
      vault.totalStaked(),
      vault.totalClaimable(),
    ]);
    const vaultArtifact = await hre.deployments.getExtendedArtifact(
      "StakeVault"
    );
    const logs = await ethers.provider.getLogs({
      address: vault.address,
      fromBlock: deploymentBlock(vaultDeployment, "StakeVaultMethodScoped"),
      toBlock: latestBlock,
    });
    vaultEvents = decodeFreshStackLogs(
      new ethers.utils.Interface(vaultArtifact.abi),
      logs,
      "StakeVaultMethodScoped"
    );
    const controllerEvents = vaultEvents.filter(
      (event) => event.name === "ControllerInitialized"
    );
    if (controllerEvents.length > 1) {
      throw new Error(
        "StakeVaultMethodScoped emitted more than one ControllerInitialized event"
      );
    }
    controllerInitialized = controllerEvents[0] ?? null;
  }

  let policyEvents: FreshStackEvent[] = [];
  if (policyDeployment) {
    const policyArtifact = await hre.deployments.getExtendedArtifact(
      "DisputeProtectionPolicy"
    );
    const logs = await ethers.provider.getLogs({
      address: policyDeployment.address,
      fromBlock: deploymentBlock(
        policyDeployment,
        "DisputeProtectionPolicyMethodScoped"
      ),
      toBlock: latestBlock,
    });
    policyEvents = decodeFreshStackLogs(
      new ethers.utils.Interface(policyArtifact.abi),
      logs,
      "DisputeProtectionPolicyMethodScoped"
    );
  }

  classifyFreshStackActivity({
    controllerInitialized,
    policyEvents,
    vaultEvents,
    totalStaked,
    totalClaimable,
  });
}

async function assertWhitelistPolicy(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork,
  governance: string
): Promise<Deployment> {
  const expected = EXPECTED_LIVE[network];
  const deployment = await hre.deployments.getOrNull(
    METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME
  );
  if (!deployment) {
    throw new Error(
      "WhitelistPolicyMethodScoped record missing; run lane 36 first"
    );
  }
  await assertCanonicalDeployment(
    hre,
    deployment,
    METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME,
    "WhitelistPolicy"
  );
  const policy = await ethers.getContractAt(
    "WhitelistPolicy",
    deployment.address
  );
  if (
    !sameAddress(await policy.owner(), governance) ||
    !sameAddress(await policy.groupRegistry(), expected.addressGroupRegistry) ||
    !sameAddress(await policy.escrowRegistry(), expected.escrowRegistry) ||
    !sameAddress(
      await policy.orchestratorRegistry(),
      expected.orchestratorRegistry
    )
  ) {
    throw new Error("WhitelistPolicyMethodScoped configuration drifted");
  }
  return deployment;
}

async function assertLiveSharedState(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork
): Promise<Deployment> {
  const expected = EXPECTED_LIVE[network];
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  if (!sameAddress(deployer, expected.deployer)) {
    throw new Error("Deployment signer does not match the approved deployer");
  }
  if (!sameAddress(USDC[network], expected.stakeToken)) {
    throw new Error("StakeVault token does not match the approved USDC target");
  }
  if (!STAKE_VAULT_CONTROLLER_CHANGE_DELAY.eq(172_800)) {
    throw new Error("StakeVault controller delay drifted from 172800 seconds");
  }

  await assertHistoricalDisputeStack(
    hre,
    METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS
  );
  await assertDeploymentAddress(
    hre,
    "OrchestratorRegistry",
    expected.orchestratorRegistry
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

  const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network];
  const verifier = await ethers.getContractAt(
    "DisputeVerifier",
    predecessor.contracts.DisputeVerifier.address
  );
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
  if (!verifierIsDeployOnly && !verifierIsActivated) {
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
  ) {
    throw new Error("MultiAttestationVerifier mutable configuration drifted");
  }

  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    expected.orchestrator
  );
  if (
    !sameAddress(
      await orchestrator.lifecycleHook(),
      predecessor.activeLifecycleHook.address
    )
  ) {
    throw new Error("OrchestratorV3 lifecycle hook drifted");
  }
  const disputeRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    predecessor.contracts.DisputeNullifierRegistry.address
  );
  const writers: string[] = await disputeRegistry.getWriters();
  if (
    !sameAddress(await disputeRegistry.owner(), governance) ||
    writers.length !== 1 ||
    !sameAddress(
      writers[0],
      predecessor.contracts.DisputeProtectionPolicy.address
    )
  ) {
    throw new Error("Predecessor dispute registry owner or writer set drifted");
  }

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
  ) {
    throw new Error("OrchestratorV3 governance state drifted");
  }
  const orchestratorRegistry = await ethers.getContractAt(
    "OrchestratorRegistry",
    expected.orchestratorRegistry
  );
  if (!(await orchestratorRegistry.isOrchestrator(orchestrator.address))) {
    throw new Error("OrchestratorV3 is not registered");
  }

  return assertWhitelistPolicy(hre, network, governance);
}

async function readLiveDeployOnlyPrefix(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork
): Promise<{
  completed: boolean[];
  deployments: Array<Deployment | null>;
  contracts?: { vault: any; policy: any; hook: any };
}> {
  const successorDeployments = await getSuccessorDeployments(hre);
  const whitelistPolicy = await assertLiveSharedState(hre, network);
  const completed = successorDeployments.map(Boolean);
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const expected = EXPECTED_LIVE[network];
  const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network];

  await assertFreshStackUnused(hre, successorDeployments);
  if (successorDeployments.some((deployment) => deployment === null)) {
    completed.push(
      ...DEPLOY_ONLY_STEP_KINDS[network].slice(3).map(() => false)
    );
    const [vaultDeployment, policyDeployment, hookDeployment] =
      successorDeployments;
    if (vaultDeployment) {
      const vault = await ethers.getContractAt(
        "StakeVault",
        vaultDeployment.address
      );
      if (
        !sameAddress(await vault.stakeToken(), expected.stakeToken) ||
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
        !sameAddress(await vault.pendingOwner(), ethers.constants.AddressZero)
      ) {
        throw new Error("Partial method-scoped StakeVault state drifted");
      }
    }
    if (policyDeployment) {
      if (!vaultDeployment) {
        throw new Error("Method-scoped policy exists before its vault");
      }
      const policy = await ethers.getContractAt(
        "DisputeProtectionPolicy",
        policyDeployment.address
      );
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
      ) {
        throw new Error("Partial method-scoped policy state drifted");
      }
      for (const method of ACTIVE_PAYMENT_METHODS) {
        if (!(await policy.getRiskWindow(paymentMethodHash(method))).isZero()) {
          throw new Error(
            `Partial method-scoped risk window exists before hook deployment: ${method}`
          );
        }
      }
    }
    if (hookDeployment) {
      if (!policyDeployment) {
        throw new Error("Method-scoped hook exists before its policy");
      }
      const hook = await ethers.getContractAt(
        "IntentLifecycleHookV1",
        hookDeployment.address
      );
      if (
        !sameAddress(
          await hook.orchestratorRegistry(),
          expected.orchestratorRegistry
        ) ||
        !sameAddress(await hook.whitelistPolicy(), whitelistPolicy.address) ||
        !sameAddress(
          await hook.disputeProtectionPolicy(),
          policyDeployment.address
        )
      ) {
        throw new Error("Partial method-scoped lifecycle hook state drifted");
      }
    }
    classifyDeployOnlyPrefix(network, completed);
    return { completed, deployments: successorDeployments };
  }

  const [vaultDeployment, policyDeployment, hookDeployment] =
    successorDeployments as Deployment[];
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
  ) {
    throw new Error("Method-scoped StakeVault dependency state drifted");
  }
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
  ) {
    throw new Error("Method-scoped policy dependency state drifted");
  }
  if (
    !sameAddress(
      await hook.orchestratorRegistry(),
      expected.orchestratorRegistry
    ) ||
    !sameAddress(await hook.whitelistPolicy(), whitelistPolicy.address) ||
    !sameAddress(await hook.disputeProtectionPolicy(), policy.address)
  ) {
    throw new Error("Method-scoped lifecycle hook dependency state drifted");
  }

  const disputeRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    predecessor.contracts.DisputeNullifierRegistry.address
  );
  const writers: string[] = await disputeRegistry.getWriters();
  if (
    writers.length !== 1 ||
    !sameAddress(
      writers[0],
      predecessor.contracts.DisputeProtectionPolicy.address
    )
  ) {
    throw new Error("Deploy-only dispute writer set drifted");
  }

  const controller = await vault.controller();
  if (
    !sameAddress(controller, ethers.constants.AddressZero) &&
    !sameAddress(controller, policy.address)
  ) {
    throw new Error("Method-scoped StakeVault controller drifted");
  }
  completed.push(sameAddress(controller, policy.address));
  completed.push(
    await assertOnlySuccessorHookAuthorization(
      policy,
      policyDeployment,
      hook.address,
      predecessor.activeLifecycleHook.address
    )
  );

  const disputableMethods = new Set(DISPUTABLE_PAYMENT_METHODS);
  for (const method of ACTIVE_PAYMENT_METHODS) {
    const actual = await policy.getRiskWindow(paymentMethodHash(method));
    const expectedWindow = disputableMethods.has(method)
      ? DISPUTE_RISK_WINDOW[network]
      : ethers.constants.Zero;
    if (!actual.isZero() && !actual.eq(expectedWindow)) {
      throw new Error(`Method-scoped risk window drifted for ${method}`);
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
        "StakeVaultMethodScoped"
      )
    );
    completed.push(
      ownershipStepState(
        await policy.owner(),
        await policy.pendingOwner(),
        deployer,
        governance,
        "DisputeProtectionPolicyMethodScoped"
      )
    );
  } else if (
    !sameAddress(await vault.owner(), deployer) ||
    !sameAddress(await vault.pendingOwner(), ethers.constants.AddressZero) ||
    !sameAddress(await policy.owner(), deployer) ||
    !sameAddress(await policy.pendingOwner(), ethers.constants.AddressZero)
  ) {
    throw new Error("Base staging method-scoped ownership drifted");
  }

  classifyDeployOnlyPrefix(network, completed);
  return {
    completed,
    deployments: successorDeployments,
    contracts: { vault, policy, hook },
  };
}

async function deployLiveSuccessor(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork
): Promise<void> {
  const flag = LIVE_FLAGS[network];
  if (process.env[flag] !== "true") {
    throw new Error(`${network} successor deployment requires ${flag}=true`);
  }
  if (!(await paymentBindingCutoverReady(hre))) {
    throw new Error("V3 payment binding is not fully cut over");
  }

  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  while (true) {
    const state = await readLiveDeployOnlyPrefix(hre, network);
    const prefix = classifyDeployOnlyPrefix(network, state.completed);
    if (prefix.nextStep === null) {
      await assertFreshStackUnused(hre, state.deployments);
      console.log(`=== ${network} method-scoped dispute stack prepared ===`);
      return;
    }
    const step = DEPLOY_ONLY_STEP_KINDS[network][prefix.nextStep];
    const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network];
    const expected = EXPECTED_LIVE[network];

    if (step === "deploy-vault") {
      const name = "StakeVaultMethodScoped";
      const deployment = await hre.deployments.deploy(name, {
        contract: ARTIFACT_NAMES[name],
        from: deployer,
        args: [
          deployer,
          expected.stakeToken,
          ethers.constants.AddressZero,
          STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
        ],
        log: true,
      });
      if (!deployment.newlyDeployed) {
        throw new Error(`${name} was not freshly deployed`);
      }
    } else if (step === "deploy-policy") {
      const name = "DisputeProtectionPolicyMethodScoped";
      const vault = await hre.deployments.get("StakeVaultMethodScoped");
      const deployment = await hre.deployments.deploy(name, {
        contract: ARTIFACT_NAMES[name],
        from: deployer,
        args: [
          deployer,
          vault.address,
          predecessor.contracts.DisputeVerifier.address,
          predecessor.contracts.DisputeNullifierRegistry.address,
        ],
        log: true,
      });
      if (!deployment.newlyDeployed) {
        throw new Error(`${name} was not freshly deployed`);
      }
    } else if (step === "deploy-hook") {
      const name = "IntentLifecycleHookV1MethodScoped";
      const policy = await hre.deployments.get(
        "DisputeProtectionPolicyMethodScoped"
      );
      const whitelistPolicy = await hre.deployments.get(
        METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME
      );
      const deployment = await hre.deployments.deploy(name, {
        contract: ARTIFACT_NAMES[name],
        from: deployer,
        args: [
          expected.orchestratorRegistry,
          whitelistPolicy.address,
          policy.address,
        ],
        log: true,
      });
      if (!deployment.newlyDeployed) {
        throw new Error(`${name} was not freshly deployed`);
      }
    } else {
      if (!state.contracts) {
        throw new Error(`Missing method-scoped contracts for ${step}`);
      }
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
      } else {
        throw new Error(`Unknown deploy-only step ${step}`);
      }
    }
    await waitForDeploymentDelay(hre);
    await assertFreshStackUnused(hre, await getSuccessorDeployments(hre));
  }
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
  const whitelistPolicy = await hre.deployments.getOrNull(
    METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME
  );
  if (!whitelistPolicy) {
    throw new Error(
      "WhitelistPolicyMethodScoped record missing; run lane 36 first"
    );
  }
  await assertCanonicalDeployment(
    hre,
    whitelistPolicy,
    METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME,
    "WhitelistPolicy"
  );
  const orchestratorDeployment = await hre.deployments.get("OrchestratorV3");

  const deploy = async (
    name: DeploymentName,
    options: Record<string, unknown>
  ): Promise<Deployment> => {
    const existing = await hre.deployments.getOrNull(name);
    if (existing) {
      await assertCanonicalDeployment(
        hre,
        existing,
        name,
        ARTIFACT_NAMES[name]
      );
      return existing;
    }
    const deployment = await hre.deployments.deploy(name, options as any);
    if (!deployment.newlyDeployed) {
      throw new Error(`${name} was not freshly deployed`);
    }
    await waitForDeploymentDelay(hre);
    await assertCanonicalDeployment(
      hre,
      deployment,
      name,
      ARTIFACT_NAMES[name]
    );
    return deployment;
  };

  const disputeRegistry = await deploy("DisputeNullifierRegistry", {
    contract: ARTIFACT_NAMES.DisputeNullifierRegistry,
    from: deployer,
    args: [],
    log: true,
  });
  const disputeVerifier = await deploy("DisputeVerifier", {
    contract: ARTIFACT_NAMES.DisputeVerifier,
    from: deployer,
    args: [deployer, nullifierRegistryV2.address, attestationVerifier.address],
    log: true,
  });
  const vaultDeployment = await deploy("StakeVaultMethodScoped", {
    contract: ARTIFACT_NAMES.StakeVaultMethodScoped,
    from: deployer,
    args: [
      deployer,
      stakeToken,
      ethers.constants.AddressZero,
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ],
    log: true,
  });
  await assertFreshStackUnused(hre, [vaultDeployment, null, null]);
  const policyDeployment = await deploy("DisputeProtectionPolicyMethodScoped", {
    contract: ARTIFACT_NAMES.DisputeProtectionPolicyMethodScoped,
    from: deployer,
    args: [
      deployer,
      vaultDeployment.address,
      disputeVerifier.address,
      disputeRegistry.address,
    ],
    log: true,
  });
  await assertFreshStackUnused(hre, [vaultDeployment, policyDeployment, null]);
  const hookDeployment = await deploy("IntentLifecycleHookV1MethodScoped", {
    contract: ARTIFACT_NAMES.IntentLifecycleHookV1MethodScoped,
    from: deployer,
    args: [
      orchestratorRegistry.address,
      whitelistPolicy.address,
      policyDeployment.address,
    ],
    log: true,
  });
  const successorDeployments = [
    vaultDeployment,
    policyDeployment,
    hookDeployment,
  ];
  await assertFreshStackUnused(hre, successorDeployments);

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
  const disputableMethods = new Set(DISPUTABLE_PAYMENT_METHODS);
  for (const method of ACTIVE_PAYMENT_METHODS) {
    const expectedWindow = disputableMethods.has(method)
      ? DISPUTE_RISK_WINDOW[network]
      : ethers.constants.Zero;
    if (
      !(await policy.getRiskWindow(paymentMethodHash(method))).eq(
        expectedWindow
      )
    ) {
      throw new Error(`Local method-scoped risk window mismatch for ${method}`);
    }
  }
  if (
    writers.length !== 1 ||
    !sameAddress(writers[0], policy.address) ||
    !sameAddress(await vault.controller(), policy.address) ||
    !sameAddress(await orchestrator.lifecycleHook(), hook.address) ||
    !(await assertOnlySuccessorHookAuthorization(
      policy,
      policyDeployment,
      hook.address
    ))
  ) {
    throw new Error(
      "Local method-scoped dispute lifecycle activation verification failed"
    );
  }
  await assertFreshStackUnused(hre, successorDeployments);
}

export async function methodScopedDisputeStackPrepared(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  if (!isLiveNetwork(network)) return false;
  const state = await readLiveDeployOnlyPrefix(hre, network);
  return classifyDeployOnlyPrefix(network, state.completed).nextStep === null;
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (isLiveNetwork(network)) {
    if (process.env[LIVE_FLAGS[network]] !== "true") {
      throw new Error(
        `${network} method-scoped dispute deployment requires ${LIVE_FLAGS[network]}=true`
      );
    }
    await deployLiveSuccessor(hre, network);
    return;
  }
  await deployLocalSuccessor(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (!isLiveNetwork(network)) return false;

  const artifacts = await Promise.all(
    LIVE_SUCCESSOR_DEPLOYMENT_NAMES.map((name) =>
      hre.deployments.getOrNull(name)
    )
  );
  if (!artifacts.some(Boolean) && process.env[LIVE_FLAGS[network]] !== "true") {
    if (
      process.env.DEPLOY_ACTIVE_TAG ===
      "37_deploy_method_scoped_dispute_lifecycle_stack"
    ) {
      throw new Error(
        `${network} method-scoped dispute deployment requires ${LIVE_FLAGS[network]}=true; set the flag and retry`
      );
    }
    return true;
  }
  return methodScopedDisputeStackPrepared(hre);
};

func.tags = [
  "37_deploy_method_scoped_dispute_lifecycle_stack",
  "V3DisputeMethodScopedStack",
];
// Keep tagged runs from pulling lane 16 through 29 -> 28; full local ordering comes from filenames.
func.dependencies = [];

export default func;
