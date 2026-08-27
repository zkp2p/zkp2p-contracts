import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction, Deployment } from "hardhat-deploy/types";

import {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
} from "../deployments/canonicalDeployment";
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
import {
  ALLOWED_POLICY_CONFIGURATION_EVENTS,
  EXPECTED_LIVE,
  EXPECTED_POLICY_GOVERNANCE_EVENTS,
  FORBIDDEN_POLICY_LIFECYCLE_EVENTS,
  assertOrchestratorGovernanceState,
  decodeFreshStackLogs,
  getRiskWindowPaymentMethods,
  ownershipStepState,
  requireLocalPaymentBindingReady,
} from "./37_deploy_method_scoped_dispute_lifecycle_stack";

export { EXPECTED_LIVE, getRiskWindowPaymentMethods };

type LiveNetwork = "base" | "base_staging";
type PrefixPhase = "absent" | "partial" | "prepared";

export const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);

export const LIVE_SUCCESSOR_DEPLOYMENT_NAMES = [
  "StakeVaultMethodScoped",
  "DisputeProtectionPolicyMethodScopedStaked",
  "IntentLifecycleHookV1MethodScopedStaked",
] as const;

type DeploymentName = (typeof LIVE_SUCCESSOR_DEPLOYMENT_NAMES)[number];

export const ARTIFACT_NAMES: Record<DeploymentName, string> = {
  StakeVaultMethodScoped: "StakeVault",
  DisputeProtectionPolicyMethodScopedStaked: "DisputeProtectionPolicy",
  IntentLifecycleHookV1MethodScopedStaked: "IntentLifecycleHookV1",
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

const LIVE_FLAGS: Record<LiveNetwork, string> = {
  base_staging: "ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT",
  base: "ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT",
};

export const STAGING_PREDECESSOR_PENDING_CONTROLLER =
  "0x0173CaA95ecfC1c314C26766FB037d44cc71B42d";

function isLiveNetwork(network: string): network is LiveNetwork {
  return network === "base" || network === "base_staging";
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function paymentMethodHash(method: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(method));
}

function includes(list: readonly string[], name: string): boolean {
  return list.includes(name);
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

export function assertPredecessorVaultTransitionState(
  network: LiveNetwork,
  pendingController: string,
  pendingControllerValidAt: unknown,
  admissionsPaused: boolean
): void {
  const validAt = ethers.BigNumber.from(pendingControllerValidAt);
  if (network === "base") {
    if (
      !sameAddress(pendingController, ethers.constants.AddressZero) ||
      !validAt.isZero()
    ) {
      throw new Error("Base predecessor vault pending controller drifted");
    }
    return;
  }
  if (!sameAddress(pendingController, STAGING_PREDECESSOR_PENDING_CONTROLLER)) {
    throw new Error(
      "Base staging predecessor vault pending controller drifted"
    );
  }
  if (validAt.isZero()) {
    throw new Error(
      "Base staging predecessor vault pending controller validity drifted"
    );
  }
  if (!admissionsPaused) {
    throw new Error("Base staging predecessor admissions must remain paused");
  }
}

function classifyFreshStackActivity(policyEvents: FreshStackEvent[]): void {
  for (const event of policyEvents) {
    if (includes(FORBIDDEN_POLICY_LIFECYCLE_EVENTS, event.name)) {
      throw new Error(
        `Fresh DisputeProtectionPolicyMethodScopedStaked has lifecycle activity: ${event.name} in ${event.transactionHash}`
      );
    }
    if (
      !includes(ALLOWED_POLICY_CONFIGURATION_EVENTS, event.name) &&
      !includes(EXPECTED_POLICY_GOVERNANCE_EVENTS, event.name)
    ) {
      throw new Error(
        `DisputeProtectionPolicyMethodScopedStaked emitted an unclassified event: ${event.name} in ${event.transactionHash}`
      );
    }
  }
}

type FreshStackEvent = {
  name: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
};

function deploymentBlock(deployment: Deployment, label: string): number {
  const blockNumber = deployment.receipt?.blockNumber;
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber)) {
    throw new Error(`${label} lacks deployment block evidence`);
  }
  return blockNumber;
}

async function assertFreshPolicyUnused(
  hre: HardhatRuntimeEnvironment,
  policyDeployment: Deployment | null
): Promise<void> {
  if (!policyDeployment) return;
  const policyArtifact = await hre.deployments.getExtendedArtifact(
    "DisputeProtectionPolicy"
  );
  const logs = await ethers.provider.getLogs({
    address: policyDeployment.address,
    fromBlock: deploymentBlock(
      policyDeployment,
      "DisputeProtectionPolicyMethodScopedStaked"
    ),
    toBlock: await ethers.provider.getBlockNumber(),
  });
  const policyEvents = decodeFreshStackLogs(
    new ethers.utils.Interface(policyArtifact.abi),
    logs,
    "DisputeProtectionPolicyMethodScopedStaked"
  );
  classifyFreshStackActivity(policyEvents);
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
  await assertDeploymentMatchesChain(
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
  await Promise.all([
    assertDeploymentAddress(
      hre,
      "OrchestratorRegistry",
      expected.orchestratorRegistry
    ),
    assertDeploymentAddress(hre, "OrchestratorV3", expected.orchestrator),
    assertDeploymentAddress(
      hre,
      "NullifierRegistryV2",
      expected.nullifierRegistryV2
    ),
    assertDeploymentAddress(
      hre,
      "MultiAttestationVerifier",
      expected.attestationVerifier
    ),
    assertDeploymentAddress(hre, "EscrowRegistry", expected.escrowRegistry),
    assertDeploymentAddress(
      hre,
      "PaymentVerifierRegistry",
      expected.paymentVerifierRegistry
    ),
    assertDeploymentAddress(hre, "RelayerRegistry", expected.relayerRegistry),
    assertDeploymentAddress(
      hre,
      "AddressGroupRegistry",
      expected.addressGroupRegistry
    ),
  ]);
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
  const predecessorVault = await ethers.getContractAt(
    "StakeVault",
    predecessor.contracts.StakeVault.address
  );
  const predecessorPolicy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    predecessor.contracts.DisputeProtectionPolicy.address
  );
  if (
    !sameAddress(
      await predecessorVault.controller(),
      predecessor.contracts.DisputeProtectionPolicy.address
    ) ||
    !sameAddress(await predecessorVault.owner(), governance) ||
    !(await predecessorVault.controllerChangeDelay()).eq(
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY
    ) ||
    !sameAddress(await predecessorVault.stakeToken(), expected.stakeToken)
  ) {
    throw new Error("Predecessor StakeVault mutable configuration drifted");
  }
  assertPredecessorVaultTransitionState(
    network,
    await predecessorVault.pendingController(),
    await predecessorVault.pendingControllerValidAt(),
    await predecessorPolicy.admissionsPaused()
  );

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

  await assertOrchestratorGovernanceState(orchestrator, governance, expected);
  const orchestratorRegistry = await ethers.getContractAt(
    "OrchestratorRegistry",
    expected.orchestratorRegistry
  );
  if (!(await orchestratorRegistry.isOrchestrator(orchestrator.address))) {
    throw new Error("OrchestratorV3 is not registered");
  }
  return assertWhitelistPolicy(hre, network, governance);
}

async function getSuccessorDeployments(
  hre: HardhatRuntimeEnvironment
): Promise<Array<Deployment | null>> {
  const records = await Promise.all(
    LIVE_SUCCESSOR_DEPLOYMENT_NAMES.map((name) =>
      hre.deployments.getOrNull(name)
    )
  );
  const firstMissing = records.findIndex((record) => record === null);
  if (
    firstMissing >= 0 &&
    records.slice(firstMissing + 1).some((record) => record !== null)
  ) {
    throw new Error(
      "Method-scoped vault deployment artifacts are not a contiguous prefix"
    );
  }
  for (let index = 0; index < records.length; index += 1) {
    const deployment = records[index];
    if (!deployment) continue;
    const name = LIVE_SUCCESSOR_DEPLOYMENT_NAMES[index];
    await assertDeploymentMatchesChain(
      hre,
      deployment,
      name,
      ARTIFACT_NAMES[name]
    );
    await assertCanonicalDeployment(
      hre,
      deployment,
      name,
      ARTIFACT_NAMES[name]
    );
  }
  return records;
}

async function assertOnlySuccessorHookAuthorization(
  policy: any,
  deployment: Deployment,
  freshHook: string
): Promise<boolean> {
  const logs = await policy.queryFilter(
    policy.filters.LifecycleHookAuthorizationUpdated(),
    deploymentBlock(deployment, "DisputeProtectionPolicyMethodScopedStaked"),
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
  if (active.some((address) => address !== freshHook.toLowerCase())) {
    throw new Error("Fresh policy authorized an unexpected lifecycle hook");
  }
  return (
    active.length === 1 && (await policy.isLifecycleHookAuthorized(freshHook))
  );
}

async function assertUntransferredOwnership(
  contract: any,
  deployer: string,
  label: string
): Promise<void> {
  if (
    !sameAddress(await contract.owner(), deployer) ||
    !sameAddress(await contract.pendingOwner(), ethers.constants.AddressZero)
  ) {
    throw new Error(`${label} ownership advanced before its resumable step`);
  }
}

async function readLiveDeployOnlyPrefix(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork
): Promise<{
  completed: boolean[];
  deployments: Array<Deployment | null>;
  contracts?: { vault: any; policy: any; hook: any };
}> {
  const deployments = await getSuccessorDeployments(hre);
  const whitelistPolicy = await assertLiveSharedState(hre, network);
  const completed = deployments.map(Boolean);
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const expected = EXPECTED_LIVE[network];
  const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network];
  const [vaultDeployment, policyDeployment, hookDeployment] = deployments;

  await assertFreshPolicyUnused(hre, policyDeployment);
  if (!vaultDeployment) {
    completed.push(
      ...DEPLOY_ONLY_STEP_KINDS[network].slice(3).map(() => false)
    );
    classifyDeployOnlyPrefix(network, completed);
    return { completed, deployments };
  }

  const vault = await ethers.getContractAt(
    "StakeVault",
    vaultDeployment.address
  );
  if (
    !sameAddress(await vault.stakeToken(), expected.stakeToken) ||
    !(await vault.controllerChangeDelay()).eq(
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY
    )
  ) {
    throw new Error("Fresh StakeVaultMethodScoped dependency state drifted");
  }
  const vaultController = await vault.controller();
  if (!policyDeployment) {
    if (!sameAddress(vaultController, ethers.constants.AddressZero)) {
      throw new Error(
        "Fresh StakeVaultMethodScoped controller set before policy"
      );
    }
    await assertUntransferredOwnership(
      vault,
      deployer,
      "StakeVaultMethodScoped"
    );
    completed.push(
      ...DEPLOY_ONLY_STEP_KINDS[network].slice(3).map(() => false)
    );
    classifyDeployOnlyPrefix(network, completed);
    return { completed, deployments };
  }

  const policy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    policyDeployment.address
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
  ) {
    throw new Error("Fresh method-scoped policy dependency state drifted");
  }
  if (!hookDeployment) {
    if (!sameAddress(vaultController, ethers.constants.AddressZero)) {
      throw new Error(
        "Fresh StakeVaultMethodScoped controller set before hook"
      );
    }
    await assertUntransferredOwnership(
      vault,
      deployer,
      "StakeVaultMethodScoped"
    );
    await assertUntransferredOwnership(
      policy,
      deployer,
      "DisputeProtectionPolicyMethodScopedStaked"
    );
    for (const method of getRiskWindowPaymentMethods(network)) {
      if (!(await policy.getRiskWindow(paymentMethodHash(method))).isZero()) {
        throw new Error(`Fresh risk window exists before hook: ${method}`);
      }
    }
    completed.push(
      ...DEPLOY_ONLY_STEP_KINDS[network].slice(3).map(() => false)
    );
    classifyDeployOnlyPrefix(network, completed);
    return { completed, deployments };
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
    !sameAddress(await hook.disputeProtectionPolicy(), policy.address)
  ) {
    throw new Error("Fresh method-scoped lifecycle hook state drifted");
  }

  if (
    !sameAddress(vaultController, ethers.constants.AddressZero) &&
    !sameAddress(vaultController, policy.address)
  ) {
    throw new Error("Fresh StakeVaultMethodScoped controller drifted");
  }
  completed.push(sameAddress(vaultController, policy.address));
  completed.push(
    await assertOnlySuccessorHookAuthorization(
      policy,
      policyDeployment,
      hook.address
    )
  );

  const disputableMethods = new Set(DISPUTABLE_PAYMENT_METHODS);
  for (const method of getRiskWindowPaymentMethods(network)) {
    const actual = await policy.getRiskWindow(paymentMethodHash(method));
    const expectedWindow = disputableMethods.has(method)
      ? DISPUTE_RISK_WINDOW[network]
      : ethers.constants.Zero;
    if (!actual.isZero() && !actual.eq(expectedWindow)) {
      throw new Error(`Fresh method-scoped risk window drifted for ${method}`);
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
        "DisputeProtectionPolicyMethodScopedStaked"
      )
    );
  } else if (
    !sameAddress(await vault.owner(), deployer) ||
    !sameAddress(await vault.pendingOwner(), ethers.constants.AddressZero) ||
    !sameAddress(await policy.owner(), deployer) ||
    !sameAddress(await policy.pendingOwner(), ethers.constants.AddressZero)
  ) {
    throw new Error("Base staging fresh-stack ownership drifted");
  }

  classifyDeployOnlyPrefix(network, completed);
  return {
    completed,
    deployments,
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
      await assertFreshPolicyUnused(hre, state.deployments[1]);
      console.log(`=== ${network} method-scoped vault stack prepared ===`);
      return;
    }
    const step = DEPLOY_ONLY_STEP_KINDS[network][prefix.nextStep];
    const predecessor = METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network];
    const expected = EXPECTED_LIVE[network];

    if (step === "deploy-vault") {
      await deployFresh(hre, "StakeVaultMethodScoped", deployer, [
        deployer,
        expected.stakeToken,
        ethers.constants.AddressZero,
        STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
      ]);
    } else if (step === "deploy-policy") {
      const vault = await hre.deployments.get("StakeVaultMethodScoped");
      await deployFresh(
        hre,
        "DisputeProtectionPolicyMethodScopedStaked",
        deployer,
        [
          deployer,
          vault.address,
          predecessor.contracts.DisputeVerifier.address,
          predecessor.contracts.DisputeNullifierRegistry.address,
        ]
      );
    } else if (step === "deploy-hook") {
      const policy = await hre.deployments.get(
        "DisputeProtectionPolicyMethodScopedStaked"
      );
      const whitelistPolicy = await hre.deployments.get(
        METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME
      );
      await deployFresh(
        hre,
        "IntentLifecycleHookV1MethodScopedStaked",
        deployer,
        [expected.orchestratorRegistry, whitelistPolicy.address, policy.address]
      );
    } else {
      if (!state.contracts) {
        throw new Error(`Missing method-scoped vault contracts for ${step}`);
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
    await assertFreshPolicyUnused(hre, (await getSuccessorDeployments(hre))[1]);
  }
}

async function deployFresh(
  hre: HardhatRuntimeEnvironment,
  name: DeploymentName,
  deployer: string,
  args: unknown[]
): Promise<Deployment> {
  const deployment = await hre.deployments.deploy(name, {
    contract: ARTIFACT_NAMES[name],
    from: deployer,
    args,
    log: true,
  });
  if (!deployment.newlyDeployed) {
    throw new Error(`${name} was not freshly deployed`);
  }
  return deployment;
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
    name: string,
    artifact: string,
    args: unknown[]
  ): Promise<Deployment> => {
    const existing = await hre.deployments.getOrNull(name);
    if (existing) {
      await assertCanonicalDeployment(hre, existing, name, artifact);
      return existing;
    }
    const deployment = await hre.deployments.deploy(name, {
      contract: artifact,
      from: deployer,
      args,
      log: true,
    });
    if (!deployment.newlyDeployed) {
      throw new Error(`${name} was not freshly deployed`);
    }
    await waitForDeploymentDelay(hre);
    await assertCanonicalDeployment(hre, deployment, name, artifact);
    return deployment;
  };

  const disputeRegistry = await deploy(
    "DisputeNullifierRegistry",
    "NullifierRegistry",
    []
  );
  const disputeVerifier = await deploy("DisputeVerifier", "DisputeVerifier", [
    deployer,
    nullifierRegistryV2.address,
    attestationVerifier.address,
  ]);
  const vaultDeployment = await deploy("StakeVaultMethodScoped", "StakeVault", [
    deployer,
    stakeToken,
    ethers.constants.AddressZero,
    STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  ]);
  const policyDeployment = await deploy(
    "DisputeProtectionPolicyMethodScopedStaked",
    "DisputeProtectionPolicy",
    [
      deployer,
      vaultDeployment.address,
      disputeVerifier.address,
      disputeRegistry.address,
    ]
  );
  await assertFreshPolicyUnused(hre, policyDeployment);
  const hookDeployment = await deploy(
    "IntentLifecycleHookV1MethodScopedStaked",
    "IntentLifecycleHookV1",
    [
      orchestratorRegistry.address,
      whitelistPolicy.address,
      policyDeployment.address,
    ]
  );

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
    !sameAddress(await vault.owner(), deployer) ||
    !sameAddress(await vault.pendingOwner(), ethers.constants.AddressZero) ||
    !sameAddress(await policy.owner(), deployer) ||
    !sameAddress(await policy.pendingOwner(), ethers.constants.AddressZero) ||
    !sameAddress(await orchestrator.lifecycleHook(), hook.address) ||
    !(await assertOnlySuccessorHookAuthorization(
      policy,
      policyDeployment,
      hook.address
    ))
  ) {
    throw new Error(
      "Local method-scoped vault stack activation verification failed"
    );
  }
  await assertFreshPolicyUnused(hre, policyDeployment);
}

export async function methodScopedVaultStackPrepared(
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
        `${network} method-scoped vault deployment requires ${LIVE_FLAGS[network]}=true`
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
  if (process.env.DEPLOY_ACTIVE_TAG !== "39_deploy_method_scoped_vault_stack") {
    return true;
  }

  const artifacts = await Promise.all(
    LIVE_SUCCESSOR_DEPLOYMENT_NAMES.map((name) =>
      hre.deployments.getOrNull(name)
    )
  );
  if (!artifacts.some(Boolean) && process.env[LIVE_FLAGS[network]] !== "true") {
    throw new Error(
      `${network} method-scoped vault deployment requires ${LIVE_FLAGS[network]}=true; set the flag and retry`
    );
  }
  return methodScopedVaultStackPrepared(hre);
};

func.tags = [
  "39_deploy_method_scoped_vault_stack",
  "V3DisputeMethodScopedVaultStack",
];
func.dependencies = [];

export default func;
