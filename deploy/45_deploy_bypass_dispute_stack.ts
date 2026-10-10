import { BigNumber, constants, utils } from "ethers";
import type { Contract } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";

import {
  BYPASS_ARTIFACT_NAMES,
  BYPASS_DEPLOYMENT_NAMES,
  BYPASS_EXPECTED_LIVE,
  BYPASS_PREDECESSOR_DEPLOYMENT_NAMES,
  BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  LANE_45_STEP_KINDS,
  LANE_45_TAG,
  classifyLane45Prefix,
  expectedPaymentMethodCurrencies,
  isBypassLiveNetwork,
  paymentMethodHash,
} from "../deployments/bypassDisputeStack";
import type {
  BypassDeploymentName,
  BypassNetwork,
} from "../deployments/bypassDisputeStack";
import {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
} from "../deployments/canonicalDeployment";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  ACTIVE_PAYMENT_METHODS,
  DISPUTABLE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  RETIRED_DISPUTABLE_PAYMENT_METHODS,
  USDC,
} from "../deployments/parameters";
import { assertPaymentBindingReady } from "./31_deploy_v3_payment_binding_stack";
import {
  EXPECTED_LIVE,
  assertOrchestratorGovernanceState,
  classifyFreshStackActivity,
  decodeFreshStackLogs,
  ownershipStepState,
} from "./37_deploy_method_scoped_dispute_lifecycle_stack";

export { LANE_45_STEP_KINDS, classifyLane45Prefix };
export const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);
export const LIVE_FLAGS: Record<BypassNetwork, string> = {
  base_staging: "ENABLE_STAGING_V3_DISPUTE_BYPASS_STACK_DEPLOYMENT",
  base: "ENABLE_BASE_V3_DISPUTE_BYPASS_STACK_DEPLOYMENT",
};

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameList(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => sameAddress(value, expected[index]))
  );
}

function requireState(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function deploymentBlock(deployment: Deployment): number {
  const block = deployment.receipt?.blockNumber;
  if (typeof block !== "number" || !Number.isSafeInteger(block) || block < 0) {
    throw new Error(
      "DisputeProtectionPolicyBypass lacks deployment block evidence"
    );
  }
  return block;
}

async function assertFreshPolicyUnused(
  hre: HardhatRuntimeEnvironment,
  deployment: Deployment | null
): Promise<void> {
  if (!deployment) return;
  const artifact = await hre.deployments.getExtendedArtifact(
    "DisputeProtectionPolicy"
  );
  const logs = await hre.ethers.provider.getLogs({
    address: deployment.address,
    fromBlock: deploymentBlock(deployment),
    toBlock: await hre.ethers.provider.getBlockNumber(),
  });
  classifyFreshStackActivity({
    policyEvents: decodeFreshStackLogs(
      new utils.Interface(artifact.abi),
      logs,
      "DisputeProtectionPolicyBypass"
    ),
  });
}

async function assertOnlySuccessorHookAuthorization(
  hre: HardhatRuntimeEnvironment,
  policy: Contract,
  deployment: Deployment,
  freshHook: string
): Promise<boolean> {
  const logs = await policy.queryFilter(
    policy.filters.LifecycleHookAuthorizationUpdated(),
    deploymentBlock(deployment),
    await hre.ethers.provider.getBlockNumber()
  );
  const authorization = new Map<string, boolean>();
  for (const log of logs) {
    const hook = log.args?.hook || log.args?.[0];
    const authorized = log.args?.isAuthorized ?? log.args?.[1];
    if (typeof hook !== "string" || typeof authorized !== "boolean") {
      throw new Error("Unable to decode lifecycle-hook authorization history");
    }
    authorization.set(hook.toLowerCase(), authorized);
  }
  const active = [...authorization.entries()]
    .filter(([, authorized]) => authorized)
    .map(([hook]) => hook);
  requireState(
    active.every((hook) => sameAddress(hook, freshHook)),
    "Fresh policy authorized an unexpected lifecycle hook"
  );
  const authorized: boolean = await policy.isLifecycleHookAuthorized(freshHook);
  requireState(
    authorized === (active.length === 1),
    "Fresh lifecycle-hook authorization history mismatch"
  );
  return authorized;
}

async function assertUntransferredOwnership(
  contract: Contract,
  deployer: string,
  label: string
): Promise<void> {
  requireState(
    sameAddress(await contract.owner(), deployer) &&
      sameAddress(await contract.pendingOwner(), constants.AddressZero),
    `${label} ownership advanced before its resumable step`
  );
}

export async function assertLiveSharedState(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<void> {
  const pins = BYPASS_EXPECTED_LIVE[network];
  const expected = EXPECTED_LIVE[network];
  const [deployer] = await hre.getUnnamedAccounts();
  requireState(
    (await hre.ethers.provider.getNetwork()).chainId === pins.chainId,
    "Bypass deployment chain ID mismatch"
  );
  requireState(
    sameAddress(deployer, pins.deployer),
    "Deployment signer does not match the approved deployer"
  );
  requireState(
    sameAddress(USDC[network], pins.stakeToken),
    "StakeVault token does not match the approved USDC target"
  );
  requireState(
    await assertPaymentBindingReady(hre),
    "V3 payment binding artifacts are missing"
  );
  const legacyNullifierRegistry = await hre.ethers.getContractAt(
    "NullifierRegistry",
    (
      await hre.deployments.get("NullifierRegistry")
    ).address
  );
  requireState(
    sameAddress(await legacyNullifierRegistry.owner(), pins.governance),
    "Legacy NullifierRegistry owner drifted"
  );
  requireState(
    (await legacyNullifierRegistry.getWriters()).length === 0,
    "Retired legacy nullifier writers remain"
  );

  const records: Array<[string, string, string, string | undefined]> = [
    [
      "OrchestratorRegistry",
      "OrchestratorRegistry",
      expected.orchestratorRegistry,
      expected.orchestratorRegistryCodeHash,
    ],
    [
      "OrchestratorV3",
      "OrchestratorV3",
      expected.orchestrator,
      expected.orchestratorCodeHash,
    ],
    [
      "NullifierRegistryV2",
      "NullifierRegistryV2",
      expected.nullifierRegistryV2,
      expected.nullifierRegistryV2CodeHash,
    ],
    [
      "MultiAttestationVerifier",
      "MultiAttestationVerifier",
      expected.attestationVerifier,
      expected.attestationVerifierCodeHash,
    ],
    ["EscrowV2", "EscrowV2", pins.escrow, undefined],
    [
      "UnifiedPaymentVerifierV3",
      "UnifiedPaymentVerifierV3",
      pins.unifiedPaymentVerifierV3.address,
      pins.unifiedPaymentVerifierV3.runtimeCodeHash,
    ],
    [
      "PaymentVerifierRegistry",
      "PaymentVerifierRegistry",
      pins.paymentVerifierRegistry.address,
      pins.paymentVerifierRegistry.runtimeCodeHash,
    ],
    [
      "DisputeVerifier",
      "DisputeVerifier",
      pins.disputeVerifier.address,
      pins.disputeVerifier.runtimeCodeHash,
    ],
    [
      "DisputeNullifierRegistry",
      "NullifierRegistry",
      pins.disputeNullifierRegistry.address,
      pins.disputeNullifierRegistry.runtimeCodeHash,
    ],
    [
      "WhitelistPolicyMethodScoped",
      "WhitelistPolicy",
      pins.whitelistPolicy.address,
      pins.whitelistPolicy.runtimeCodeHash,
    ],
    [
      BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.vault,
      "StakeVault",
      pins.predecessorVault.address,
      pins.predecessorVault.runtimeCodeHash,
    ],
    [
      BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.policy,
      "DisputeProtectionPolicy",
      pins.predecessorPolicy.address,
      pins.predecessorPolicy.runtimeCodeHash,
    ],
    [
      BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.hook,
      "IntentLifecycleHookV1",
      pins.predecessorHook.address,
      pins.predecessorHook.runtimeCodeHash,
    ],
  ];
  for (const [name, artifact, address, hash] of records) {
    const record = await hre.deployments.get(name);
    requireState(
      sameAddress(record.address, address),
      `${name} deployment address mismatch`
    );
    await assertDeploymentMatchesChain(hre, record, name, artifact);
    const code = await hre.ethers.provider.getCode(address);
    requireState(
      code !== "0x" && (hash === undefined || utils.keccak256(code) === hash),
      `${name} runtime bytecode hash mismatch`
    );
  }
  requireState(
    (await hre.ethers.provider.getCode(pins.stakeToken)) !== "0x",
    "USDC has no runtime bytecode"
  );
  const orchestrator = await hre.ethers.getContractAt(
    "OrchestratorV3",
    expected.orchestrator
  );
  await assertOrchestratorGovernanceState(
    orchestrator,
    pins.governance,
    expected
  );
  requireState(
    sameAddress(
      await orchestrator.lifecycleHook(),
      pins.predecessorHook.address
    ),
    "OrchestratorV3 lifecycle hook drifted"
  );
  const orchestratorRegistry = await hre.ethers.getContractAt(
    "OrchestratorRegistry",
    expected.orchestratorRegistry
  );
  requireState(
    await orchestratorRegistry.isOrchestrator(expected.orchestrator),
    "OrchestratorV3 is not registered"
  );

  const disputeRegistry = await hre.ethers.getContractAt(
    "NullifierRegistry",
    pins.disputeNullifierRegistry.address
  );
  requireState(
    sameAddress(await disputeRegistry.owner(), pins.governance) &&
      sameList(await disputeRegistry.getWriters(), [
        pins.predecessorPolicy.address,
      ]),
    "Predecessor dispute registry owner or writer set drifted"
  );
  const nullifierRegistry = await hre.ethers.getContractAt(
    "NullifierRegistryV2",
    expected.nullifierRegistryV2
  );
  requireState(
    sameAddress(await nullifierRegistry.owner(), pins.governance) &&
      sameList(await nullifierRegistry.getWriters(), [
        pins.unifiedPaymentVerifierV3.address,
      ]),
    "NullifierRegistryV2 owner or writer set drifted"
  );
  const registry = await hre.ethers.getContractAt(
    "PaymentVerifierRegistry",
    pins.paymentVerifierRegistry.address
  );
  requireState(
    sameAddress(await registry.owner(), pins.governance),
    "PaymentVerifierRegistry owner drifted"
  );
  requireState(
    sameList(
      await registry.getPaymentMethods(),
      pins.paymentMethods.map(paymentMethodHash)
    ),
    "PaymentVerifierRegistry method order drifted"
  );
  for (const method of pins.paymentMethods) {
    const hash = paymentMethodHash(method);
    requireState(
      sameAddress(
        await registry.getVerifier(hash),
        pins.unifiedPaymentVerifierV3.address
      ),
      `Payment verifier route drifted for ${method}`
    );
    requireState(
      sameList(
        await registry.getCurrencies(hash),
        expectedPaymentMethodCurrencies(method).map(paymentMethodHash)
      ),
      `Payment currencies drifted for ${method}`
    );
  }
  const retiredVerifier = await hre.ethers.getContractAt(
    "UnifiedPaymentVerifierV3",
    pins.unifiedPaymentVerifierV3.address
  );
  requireState(
    sameAddress(await retiredVerifier.owner(), pins.governance),
    "UnifiedPaymentVerifierV3 owner drifted"
  );
  const policy = await hre.ethers.getContractAt(
    "DisputeProtectionPolicy",
    pins.predecessorPolicy.address
  );
  requireState(
    sameAddress(await policy.owner(), pins.governance) &&
      sameAddress(await policy.pendingOwner(), constants.AddressZero) &&
      sameAddress(await policy.stakeVault(), pins.predecessorVault.address) &&
      sameAddress(
        await policy.disputeVerifier(),
        pins.disputeVerifier.address
      ) &&
      sameAddress(
        await policy.disputeNullifierRegistry(),
        pins.disputeNullifierRegistry.address
      ) &&
      !(await policy.admissionsPaused()) &&
      (await policy.isLifecycleHookAuthorized(pins.predecessorHook.address)),
    "Predecessor policy configuration drifted"
  );
  for (const method of new Set([
    ...pins.paymentMethods,
    ...RETIRED_DISPUTABLE_PAYMENT_METHODS,
  ])) {
    requireState(
      BigNumber.from(await policy.getRiskWindow(paymentMethodHash(method))).eq(
        pins.riskWindows[method] || "0"
      ),
      `Predecessor risk window drifted for ${method}`
    );
  }
  const vault = await hre.ethers.getContractAt(
    "StakeVault",
    pins.predecessorVault.address
  );
  requireState(
    sameAddress(await vault.owner(), pins.governance) &&
      sameAddress(await vault.controller(), pins.predecessorPolicy.address) &&
      sameAddress(await vault.pendingController(), constants.AddressZero) &&
      BigNumber.from(await vault.controllerChangeDelay()).eq(
        pins.predecessorControllerChangeDelay
      ) &&
      sameAddress(await vault.stakeToken(), pins.stakeToken),
    "Predecessor vault configuration drifted"
  );
  const disputeVerifier = await hre.ethers.getContractAt(
    "DisputeVerifier",
    pins.disputeVerifier.address
  );
  requireState(
    sameAddress(await disputeVerifier.owner(), pins.governance) &&
      sameAddress(
        await disputeVerifier.pendingOwner(),
        constants.AddressZero
      ) &&
      sameAddress(
        await disputeVerifier.nullifierRegistry(),
        expected.nullifierRegistryV2
      ) &&
      sameAddress(
        await disputeVerifier.attestationVerifier(),
        expected.attestationVerifier
      ),
    "DisputeVerifier configuration drifted"
  );
  const whitelist = await hre.ethers.getContractAt(
    "WhitelistPolicy",
    pins.whitelistPolicy.address
  );
  const whitelistOwner: string = await whitelist.owner();
  requireState(
    pins.allowedWhitelistPolicyOwners.some((owner) =>
      sameAddress(owner, whitelistOwner)
    ) &&
      sameAddress(
        await whitelist.groupRegistry(),
        expected.addressGroupRegistry
      ) &&
      sameAddress(await whitelist.escrowRegistry(), expected.escrowRegistry) &&
      sameAddress(
        await whitelist.orchestratorRegistry(),
        expected.orchestratorRegistry
      ),
    "WhitelistPolicyMethodScoped configuration drifted"
  );
  const attestationVerifier = await hre.ethers.getContractAt(
    "MultiAttestationVerifier",
    expected.attestationVerifier
  );
  requireState(
    sameAddress(await attestationVerifier.owner(), pins.governance) &&
      BigNumber.from(await attestationVerifier.requiredSignatures()).eq(1) &&
      sameList(
        await attestationVerifier.witnesses(),
        expected.attestationWitnesses
      ),
    "MultiAttestationVerifier configuration drifted"
  );
}

type StackContext = {
  deployer: string;
  governance: string;
  stakeToken: string;
  disputeVerifier: string;
  disputeNullifierRegistry: string;
  orchestratorRegistry: string;
  whitelistPolicy: string;
  nullifierRegistryV2: string;
  attestationVerifier: string;
  paymentMethods: string[];
  riskWindows: Record<string, string>;
  transferOwnership: boolean;
};

type Lane45State = {
  completed: boolean[];
  deployments: Array<Deployment | null>;
  contracts: {
    vault?: Contract;
    policy?: Contract;
    hook?: Contract;
    verifier?: Contract;
  };
};

function liveContext(network: BypassNetwork): StackContext {
  const pins = BYPASS_EXPECTED_LIVE[network];
  const expected = EXPECTED_LIVE[network];
  return {
    deployer: pins.deployer,
    governance: pins.governance,
    stakeToken: pins.stakeToken,
    disputeVerifier: pins.disputeVerifier.address,
    disputeNullifierRegistry: pins.disputeNullifierRegistry.address,
    orchestratorRegistry: expected.orchestratorRegistry,
    whitelistPolicy: pins.whitelistPolicy.address,
    nullifierRegistryV2: expected.nullifierRegistryV2,
    attestationVerifier: expected.attestationVerifier,
    paymentMethods: pins.paymentMethods.map(paymentMethodHash),
    riskWindows: Object.fromEntries(
      [
        ...new Set([
          ...pins.paymentMethods,
          ...RETIRED_DISPUTABLE_PAYMENT_METHODS,
        ]),
      ].map((method) => [
        paymentMethodHash(method),
        pins.riskWindows[method] || "0",
      ])
    ),
    transferOwnership: network === "base",
  };
}

async function readFreshState(
  hre: HardhatRuntimeEnvironment,
  context: StackContext
): Promise<{
  deployments: Array<Deployment | null>;
  contracts: Lane45State["contracts"];
  completed: Record<string, boolean>;
}> {
  const deployments = await Promise.all(
    BYPASS_DEPLOYMENT_NAMES.map((name) => hre.deployments.getOrNull(name))
  );
  const firstMissing = deployments.indexOf(null);
  requireState(
    firstMissing < 0 ||
      deployments.slice(firstMissing + 1).every((record) => record === null),
    "Bypass deployment artifacts are not a contiguous prefix"
  );
  for (let index = 0; index < deployments.length; index += 1) {
    const record = deployments[index];
    if (!record) continue;
    const name = BYPASS_DEPLOYMENT_NAMES[index];
    await assertDeploymentMatchesChain(
      hre,
      record,
      name,
      BYPASS_ARTIFACT_NAMES[name]
    );
    await assertCanonicalDeployment(
      hre,
      record,
      name,
      BYPASS_ARTIFACT_NAMES[name]
    );
  }
  const [vaultRecord, policyRecord, hookRecord, verifierRecord] = deployments;
  await assertFreshPolicyUnused(hre, policyRecord);
  const contracts: Lane45State["contracts"] = {};
  const completed: Record<string, boolean> = {
    "deploy-vault": Boolean(vaultRecord),
    "deploy-policy": Boolean(policyRecord),
    "deploy-hook": Boolean(hookRecord),
    "deploy-verifier": Boolean(verifierRecord),
  };
  if (vaultRecord) {
    const vault = (contracts.vault = await hre.ethers.getContractAt(
      "StakeVault",
      vaultRecord.address
    ));
    requireState(
      sameAddress(await vault.stakeToken(), context.stakeToken) &&
        BigNumber.from(await vault.controllerChangeDelay()).eq(
          BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY
        ),
      "Fresh StakeVaultBypass dependency state drifted"
    );
    const controller: string = await vault.controller();
    requireState(
      sameAddress(controller, constants.AddressZero) ||
        Boolean(policyRecord && sameAddress(controller, policyRecord.address)),
      "Fresh StakeVaultBypass controller drifted"
    );
    const pendingController: string = await vault.pendingController();
    requireState(
      (sameAddress(pendingController, constants.AddressZero) &&
        BigNumber.from(await vault.pendingControllerValidAt()).isZero()) ||
        (sameAddress(controller, constants.AddressZero) &&
          Boolean(
            policyRecord && sameAddress(pendingController, policyRecord.address)
          )),
      "Fresh StakeVaultBypass pending controller drifted"
    );
    completed["initialize-controller"] = Boolean(
      policyRecord && sameAddress(controller, policyRecord.address)
    );
    if (context.transferOwnership) {
      completed["transfer-vault-owner"] = ownershipStepState(
        await vault.owner(),
        await vault.pendingOwner(),
        context.deployer,
        context.governance,
        "StakeVaultBypass"
      );
    } else {
      await assertUntransferredOwnership(
        vault,
        context.deployer,
        "StakeVaultBypass"
      );
    }
  }
  if (policyRecord) {
    const policy = (contracts.policy = await hre.ethers.getContractAt(
      "DisputeProtectionPolicy",
      policyRecord.address
    ));
    requireState(
      sameAddress(await policy.stakeVault(), vaultRecord!.address) &&
        sameAddress(await policy.disputeVerifier(), context.disputeVerifier) &&
        sameAddress(
          await policy.disputeNullifierRegistry(),
          context.disputeNullifierRegistry
        ) &&
        !(await policy.admissionsPaused()),
      "Fresh bypass policy dependency state drifted"
    );
    completed["authorize-hook"] = await assertOnlySuccessorHookAuthorization(
      hre,
      policy,
      policyRecord,
      hookRecord?.address || constants.AddressZero
    );
    requireState(
      Boolean(hookRecord) || !completed["authorize-hook"],
      "Fresh policy authorized a hook before deployment"
    );
    for (const [method, window] of Object.entries(context.riskWindows)) {
      const actual = BigNumber.from(await policy.getRiskWindow(method));
      requireState(
        actual.isZero() || actual.eq(window),
        `Fresh bypass risk window drifted for ${method}`
      );
      completed[`set-risk-window:${method}`] = actual.eq(window);
    }
    if (context.transferOwnership) {
      completed["transfer-policy-owner"] = ownershipStepState(
        await policy.owner(),
        await policy.pendingOwner(),
        context.deployer,
        context.governance,
        "DisputeProtectionPolicyBypass"
      );
    } else {
      await assertUntransferredOwnership(
        policy,
        context.deployer,
        "DisputeProtectionPolicyBypass"
      );
    }
  }
  if (hookRecord) {
    const hook = (contracts.hook = await hre.ethers.getContractAt(
      "IntentLifecycleHookV1",
      hookRecord.address
    ));
    requireState(
      sameAddress(
        await hook.orchestratorRegistry(),
        context.orchestratorRegistry
      ) &&
        sameAddress(await hook.whitelistPolicy(), context.whitelistPolicy) &&
        sameAddress(
          await hook.disputeProtectionPolicy(),
          policyRecord!.address
        ),
      "Fresh bypass lifecycle hook state drifted"
    );
  }
  if (verifierRecord) {
    const verifier = (contracts.verifier = await hre.ethers.getContractAt(
      "UnifiedPaymentVerifierV4",
      verifierRecord.address
    ));
    requireState(
      sameAddress(
        await verifier.orchestratorRegistry(),
        context.orchestratorRegistry
      ) &&
        sameAddress(
          await verifier.nullifierRegistry(),
          context.nullifierRegistryV2
        ) &&
        sameAddress(
          await verifier.attestationVerifier(),
          context.attestationVerifier
        ),
      "Fresh UnifiedPaymentVerifierV4 dependency state drifted"
    );
    const methods: string[] = await verifier.getPaymentMethods();
    requireState(
      methods.length <= context.paymentMethods.length &&
        sameList(methods, context.paymentMethods.slice(0, methods.length)),
      "Fresh UnifiedPaymentVerifierV4 method prefix drifted"
    );
    context.paymentMethods.forEach((method, index) => {
      completed[`add-verifier-method:${method}`] = index < methods.length;
    });
    const owner: string = await verifier.owner();
    requireState(
      sameAddress(owner, context.deployer) ||
        (context.transferOwnership && sameAddress(owner, context.governance)),
      "Fresh UnifiedPaymentVerifierV4 owner drifted"
    );
    completed["transfer-verifier-owner"] =
      context.transferOwnership && sameAddress(owner, context.governance);
  }
  return { completed, deployments, contracts };
}

export async function readLane45State(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<Lane45State> {
  await assertLiveSharedState(hre, network);
  const state = await readFreshState(hre, liveContext(network));
  const completed = LANE_45_STEP_KINDS[network].map((step) => {
    if (
      step.startsWith("set-risk-window:") ||
      step.startsWith("add-verifier-method:")
    ) {
      const [kind, method] = step.split(":");
      return state.completed[`${kind}:${paymentMethodHash(method)}`] || false;
    }
    return state.completed[step] || false;
  });
  classifyLane45Prefix(network, completed);
  return { ...state, completed };
}

/** Recover permissionless deposit griefing through a zero-delay handover. */
async function initializeBypassController(
  vault: Contract,
  policy: Contract
): Promise<void> {
  const controller: string = await vault.controller();
  const pendingController: string = await vault.pendingController();
  if (sameAddress(controller, policy.address)) {
    requireState(
      sameAddress(pendingController, constants.AddressZero) &&
        BigNumber.from(await vault.pendingControllerValidAt()).isZero(),
      "Fresh StakeVaultBypass pending controller drifted"
    );
    return;
  }
  requireState(
    sameAddress(controller, constants.AddressZero),
    "Fresh StakeVaultBypass controller drifted"
  );
  if (sameAddress(pendingController, constants.AddressZero)) {
    requireState(
      BigNumber.from(await vault.pendingControllerValidAt()).isZero(),
      "Fresh StakeVaultBypass pending controller drifted"
    );
    if (
      BigNumber.from(await vault.totalStaked()).isZero() &&
      BigNumber.from(await vault.totalClaimable()).isZero()
    ) {
      await (await vault.initializeController(policy.address)).wait();
    } else {
      console.log(
        "StakeVaultBypass liabilities forced the zero-delay handover"
      );
      await (await vault.proposeController(policy.address)).wait();
    }
    return;
  }
  requireState(
    sameAddress(pendingController, policy.address),
    "Fresh StakeVaultBypass pending controller drifted"
  );
  await (await policy.acceptVaultController()).wait();
}

async function deployLiveBypassStack(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<void> {
  requireState(
    process.env[LIVE_FLAGS[network]] === "true",
    `${network} bypass deployment requires ${LIVE_FLAGS[network]}=true`
  );
  const context = liveContext(network);
  while (true) {
    const state = await readLane45State(hre, network);
    const prefix = classifyLane45Prefix(network, state.completed);
    if (prefix.nextStep === null) {
      await assertFreshPolicyUnused(hre, state.deployments[1]);
      console.log(`=== ${network} bypass dispute stack prepared ===`);
      return;
    }
    const step = LANE_45_STEP_KINDS[network][prefix.nextStep];
    if (step === "deploy-vault") {
      await deployFresh(hre, "StakeVaultBypass", context.deployer, [
        context.deployer,
        context.stakeToken,
        constants.AddressZero,
        BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
      ]);
    } else if (step === "deploy-policy") {
      await deployFresh(
        hre,
        "DisputeProtectionPolicyBypass",
        context.deployer,
        [
          context.deployer,
          state.contracts.vault!.address,
          context.disputeVerifier,
          context.disputeNullifierRegistry,
        ]
      );
    } else if (step === "initialize-controller") {
      await initializeBypassController(
        state.contracts.vault!,
        state.contracts.policy!
      );
    } else if (step === "deploy-hook") {
      await deployFresh(hre, "IntentLifecycleHookV1Bypass", context.deployer, [
        context.orchestratorRegistry,
        context.whitelistPolicy,
        state.contracts.policy!.address,
      ]);
    } else if (step === "authorize-hook") {
      await (
        await state.contracts.policy!.setLifecycleHookAuthorization(
          state.contracts.hook!.address,
          true
        )
      ).wait();
    } else if (step.startsWith("set-risk-window:")) {
      const method = paymentMethodHash(step.slice("set-risk-window:".length));
      await (
        await state.contracts.policy!.setRiskWindow(
          method,
          context.riskWindows[method]
        )
      ).wait();
    } else if (step === "deploy-verifier") {
      await deployFresh(hre, "UnifiedPaymentVerifierV4", context.deployer, [
        context.orchestratorRegistry,
        context.nullifierRegistryV2,
        context.attestationVerifier,
      ]);
    } else if (step.startsWith("add-verifier-method:")) {
      const verifier = state.contracts.verifier!;
      await (
        await verifier.addPaymentMethod(
          paymentMethodHash(step.slice("add-verifier-method:".length))
        )
      ).wait();
    } else if (step === "transfer-vault-owner") {
      await (
        await state.contracts.vault!.transferOwnership(context.governance)
      ).wait();
    } else if (step === "transfer-policy-owner") {
      await (
        await state.contracts.policy!.transferOwnership(context.governance)
      ).wait();
    } else if (step === "transfer-verifier-owner") {
      await (
        await state.contracts.verifier!.transferOwnership(context.governance)
      ).wait();
    } else {
      throw new Error(`Unknown deploy-only step ${step}`);
    }
    await waitForDeploymentDelay(hre);
  }
}

async function deployFresh(
  hre: HardhatRuntimeEnvironment,
  name: BypassDeploymentName,
  deployer: string,
  args: unknown[]
): Promise<Deployment> {
  const deployment = await hre.deployments.deploy(name, {
    contract: BYPASS_ARTIFACT_NAMES[name],
    from: deployer,
    args,
    log: true,
  });
  requireState(
    Boolean(deployment.newlyDeployed),
    `${name} was not freshly deployed`
  );
  return deployment;
}

async function deployLocalBypassStack(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const predecessorVault = await hre.deployments.get(
    BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.vault
  );
  const predecessorPolicy = await hre.deployments.get(
    BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.policy
  );
  await hre.deployments.get(BYPASS_PREDECESSOR_DEPLOYMENT_NAMES.hook);
  const policy = await hre.ethers.getContractAt(
    "DisputeProtectionPolicy",
    predecessorPolicy.address
  );
  requireState(
    sameAddress(await policy.stakeVault(), predecessorVault.address),
    "Local predecessor policy vault mismatch"
  );
  const registry = await hre.ethers.getContractAt(
    "PaymentVerifierRegistry",
    (
      await hre.deployments.get("PaymentVerifierRegistry")
    ).address
  );
  const methods: string[] = await registry.getPaymentMethods();
  requireState(
    new Set(methods.map((method) => method.toLowerCase())).size ===
      methods.length,
    "Local payment method catalog contains duplicates"
  );
  const windows: Record<string, string> = {};
  const protectedMethods = DISPUTABLE_PAYMENT_METHODS.map(paymentMethodHash);
  const checkedMethods = new Set([
    ...methods,
    ...ACTIVE_PAYMENT_METHODS.map(paymentMethodHash),
    ...RETIRED_DISPUTABLE_PAYMENT_METHODS.map(paymentMethodHash),
    ...protectedMethods,
  ]);
  for (const method of checkedMethods) {
    const window = BigNumber.from(await policy.getRiskWindow(method));
    const expected = protectedMethods.some((hash) => sameAddress(hash, method))
      ? DISPUTE_RISK_WINDOW[network]
      : constants.Zero;
    requireState(
      window.eq(expected),
      `Local predecessor risk window mismatch for ${method}`
    );
    windows[method] = window.toString();
  }
  const context: StackContext = {
    deployer,
    governance: deployer,
    stakeToken:
      USDC[network] || (await hre.deployments.get("USDCMock")).address,
    disputeVerifier: (await hre.deployments.get("DisputeVerifier")).address,
    disputeNullifierRegistry: (
      await hre.deployments.get("DisputeNullifierRegistry")
    ).address,
    orchestratorRegistry: (await hre.deployments.get("OrchestratorRegistry"))
      .address,
    whitelistPolicy: (await hre.deployments.get("WhitelistPolicyMethodScoped"))
      .address,
    nullifierRegistryV2: (await hre.deployments.get("NullifierRegistryV2"))
      .address,
    attestationVerifier: (
      (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
      (await hre.deployments.get("SimpleAttestationVerifier"))
    ).address,
    paymentMethods: methods,
    riskWindows: windows,
    transferOwnership: false,
  };
  const deploy = async (
    name: BypassDeploymentName,
    args: unknown[]
  ): Promise<Deployment> => {
    const existing = await hre.deployments.getOrNull(name);
    if (existing) {
      await assertCanonicalDeployment(
        hre,
        existing,
        name,
        BYPASS_ARTIFACT_NAMES[name]
      );
      return existing;
    }
    const result = await deployFresh(hre, name, deployer, args);
    await waitForDeploymentDelay(hre);
    await assertCanonicalDeployment(
      hre,
      result,
      name,
      BYPASS_ARTIFACT_NAMES[name]
    );
    return result;
  };
  await readFreshState(hre, context);
  const vaultRecord = await deploy("StakeVaultBypass", [
    deployer,
    context.stakeToken,
    constants.AddressZero,
    BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  ]);
  const policyRecord = await deploy("DisputeProtectionPolicyBypass", [
    deployer,
    vaultRecord.address,
    context.disputeVerifier,
    context.disputeNullifierRegistry,
  ]);
  let state = await readFreshState(hre, context);
  while (!state.completed["initialize-controller"]) {
    await initializeBypassController(
      state.contracts.vault!,
      state.contracts.policy!
    );
    await waitForDeploymentDelay(hre);
    state = await readFreshState(hre, context);
  }
  const hookRecord = await deploy("IntentLifecycleHookV1Bypass", [
    context.orchestratorRegistry,
    context.whitelistPolicy,
    policyRecord.address,
  ]);
  state = await readFreshState(hre, context);
  if (!state.completed["authorize-hook"]) {
    await (
      await state.contracts.policy!.setLifecycleHookAuthorization(
        hookRecord.address,
        true
      )
    ).wait();
    await waitForDeploymentDelay(hre);
  }
  for (const method of protectedMethods) {
    state = await readFreshState(hre, context);
    if (!state.completed[`set-risk-window:${method}`]) {
      await (
        await state.contracts.policy!.setRiskWindow(method, windows[method])
      ).wait();
      await waitForDeploymentDelay(hre);
    }
  }
  await deploy("UnifiedPaymentVerifierV4", [
    context.orchestratorRegistry,
    context.nullifierRegistryV2,
    context.attestationVerifier,
  ]);
  for (const method of methods) {
    state = await readFreshState(hre, context);
    if (!state.completed[`add-verifier-method:${method}`]) {
      const verifier = state.contracts.verifier!;
      await (await verifier.addPaymentMethod(method)).wait();
      await waitForDeploymentDelay(hre);
    }
  }
  state = await readFreshState(hre, context);
  const expectedSteps = [
    "deploy-vault",
    "deploy-policy",
    "initialize-controller",
    "deploy-hook",
    "authorize-hook",
    ...protectedMethods.map((method) => `set-risk-window:${method}`),
    "deploy-verifier",
    ...methods.map((method) => `add-verifier-method:${method}`),
  ];
  requireState(
    expectedSteps.every((step) => state.completed[step]),
    "Local bypass stack preparation verification failed"
  );
}

export async function bypassDisputeStackPrepared(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  if (!isBypassLiveNetwork(network)) return false;
  const state = await readLane45State(hre, network);
  return classifyLane45Prefix(network, state.completed).nextStep === null;
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return;
  if (isBypassLiveNetwork(network)) {
    requireState(
      process.env[LIVE_FLAGS[network]] === "true",
      `${network} bypass deployment requires ${LIVE_FLAGS[network]}=true`
    );
    await deployLiveBypassStack(hre, network);
    return;
  }
  await deployLocalBypassStack(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (!isBypassLiveNetwork(network)) return false;
  if (process.env.DEPLOY_ACTIVE_TAG !== LANE_45_TAG) return true;
  const records = await Promise.all(
    BYPASS_DEPLOYMENT_NAMES.map((name) => hre.deployments.getOrNull(name))
  );
  if (!records.some(Boolean) && process.env[LIVE_FLAGS[network]] !== "true") {
    throw new Error(
      `${network} bypass deployment requires ${LIVE_FLAGS[network]}=true; set the flag and retry`
    );
  }
  return bypassDisputeStackPrepared(hre);
};

func.tags = [LANE_45_TAG, "V3DisputeBypassStack"];
func.dependencies = [];
export default func;
