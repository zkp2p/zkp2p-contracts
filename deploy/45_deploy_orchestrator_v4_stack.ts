import { BigNumber, constants, utils } from "ethers";
import type { Contract } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";

import {
  O4_ARTIFACT_NAMES,
  O4_DEPLOYMENT_NAMES,
  O4_EXPECTED_LIVE,
  O4_PREDECESSOR_DEPLOYMENT_NAMES,
  LANE_45_STEP_KINDS,
  LANE_45_TAG,
  assertO4DeploymentRecord,
  classifyLane45Prefix,
  expectedPaymentMethodCurrencies,
  isO4LiveNetwork,
  paymentMethodHash,
} from "../deployments/orchestratorV4Stack";
import type {
  O4DeploymentName,
  O4Network,
} from "../deployments/orchestratorV4Stack";
import {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
} from "../deployments/canonicalDeployment";
import { reduceO4Activation } from "../deployments/orchestratorV4Activation";
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
  type FreshStackEvent,
  assertOrchestratorGovernanceState,
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
export const LIVE_FLAGS: Record<O4Network, string> = {
  base_staging: "ENABLE_STAGING_ORCHESTRATOR_V4_STACK_DEPLOYMENT",
  base: "ENABLE_BASE_ORCHESTRATOR_V4_STACK_DEPLOYMENT",
};

export const O4_POLICY_GOVERNANCE_EVENTS = [
  "DisputeVerifierUpdated",
  "OwnershipTransferStarted",
  "OwnershipTransferred",
] as const;

export const O4_POLICY_LIFECYCLE_EVENTS = [
  "ProtectionOpened",
  "ProtectionReleased",
  "DisputeResolved",
] as const;

export function classifyO4PolicyActivity(
  events: FreshStackEvent[],
  beforeCutover: boolean
): void {
  const lifecycleEvents = events.filter((event) =>
    O4_POLICY_LIFECYCLE_EVENTS.some((name) => name === event.name)
  );
  if (beforeCutover && lifecycleEvents.length > 0) {
    const event = lifecycleEvents[0];
    throw new Error(
      `Fresh DisputeProtectionPolicyV2 has lifecycle activity before cutover: ` +
        `${event.name} in ${event.transactionHash}`
    );
  }
  for (const event of events.filter((event) => !lifecycleEvents.includes(event))) {
    if (!O4_POLICY_GOVERNANCE_EVENTS.some((name) => name === event.name)) {
      throw new Error(
        `DisputeProtectionPolicyV2 emitted an unclassified event: ${event.name} in ${event.transactionHash}`
      );
    }
  }
}

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
      "DisputeProtectionPolicyV2 lacks deployment block evidence"
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
    "DisputeProtectionPolicyV2"
  );
  const logs = await hre.ethers.provider.getLogs({
    address: deployment.address,
    fromBlock: deploymentBlock(deployment),
    toBlock: await hre.ethers.provider.getBlockNumber(),
  });
  classifyO4PolicyActivity(
    decodeFreshStackLogs(
      new utils.Interface(artifact.abi),
      logs,
      "DisputeProtectionPolicyV2"
    ),
    true
  );
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
  network: O4Network
): Promise<void> {
  const pins = O4_EXPECTED_LIVE[network];
  const expected = EXPECTED_LIVE[network];
  const [deployer] = await hre.getUnnamedAccounts();
  requireState(
    (await hre.ethers.provider.getNetwork()).chainId === pins.chainId,
    "O4 deployment chain ID mismatch"
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
  requireState(
    pins.allowMultipleIntents === expected.allowMultipleIntents,
    "Orchestrator allowMultipleIntents pin mismatch"
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
      O4_PREDECESSOR_DEPLOYMENT_NAMES.vault,
      "StakeVault",
      pins.predecessorVault.address,
      pins.predecessorVault.runtimeCodeHash,
    ],
    [
      O4_PREDECESSOR_DEPLOYMENT_NAMES.policy,
      "DisputeProtectionPolicy",
      pins.predecessorPolicy.address,
      pins.predecessorPolicy.runtimeCodeHash,
    ],
    [
      O4_PREDECESSOR_DEPLOYMENT_NAMES.hook,
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
  const orchestratorV3 = await hre.ethers.getContractAt(
    "OrchestratorV3",
    expected.orchestrator
  );
  await assertOrchestratorGovernanceState(
    orchestratorV3,
    pins.governance,
    expected
  );
  requireState(
    sameAddress(
      await orchestratorV3.lifecycleHook(),
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
      sameList(await disputeRegistry.getWriters(), pins.retainedDisputeWriters),
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
    "Retired verifier owner drifted"
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
        pins.predecessorRiskWindows[method] || "0"
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

export async function readWhitelistDependencies(
  hre: HardhatRuntimeEnvironment
): Promise<{
  predecessorWhitelistPolicy: string;
  groupRegistry: string;
  escrowRegistry: string;
  orchestratorRegistry: string;
}> {
  const record = await hre.deployments.get("WhitelistPolicyMethodScoped");
  const fields = ["groupRegistry", "escrowRegistry", "orchestratorRegistry"] as const;
  requireState(
    record.args?.length === fields.length &&
      record.args.every((arg) => typeof arg === "string" && utils.isAddress(arg)),
    "WhitelistPolicyMethodScoped constructor args are invalid"
  );
  const whitelist = await hre.ethers.getContractAt(
    "WhitelistPolicy", record.address
  );
  const network = hre.deployments.getNetworkName();
  const expected = isO4LiveNetwork(network) ? EXPECTED_LIVE[network] : null;
  const dependencies = {
    groupRegistry: record.args![0] as string,
    escrowRegistry: record.args![1] as string,
    orchestratorRegistry: record.args![2] as string,
  };
  for (const field of fields) {
    requireState(
      sameAddress(await whitelist[field](), dependencies[field]) &&
        (!expected || sameAddress(
          dependencies[field],
          field === "groupRegistry" ? expected.addressGroupRegistry : expected[field]
        )),
      `WhitelistPolicyMethodScoped ${field} constructor dependency drifted`
    );
  }
  return { predecessorWhitelistPolicy: record.address, ...dependencies };
}

type StackContext = {
  network: string;
  deployer: string;
  governance: string;
  stakeToken: string;
  disputeVerifier: string;
  disputeNullifierRegistry: string;
  orchestratorRegistry: string;
  predecessorWhitelistPolicy: string;
  nullifierRegistryV2: string;
  attestationVerifier: string;
  paymentMethods: string[];
  transferOwnership: boolean;
  chainId: number;
  escrowRegistry: string;
  paymentVerifierRegistry: string;
  relayerRegistry: string;
  protocolFee: string;
  protocolFeeRecipient: string;
  allowMultipleIntents: boolean;
};

type Lane45State = {
  completed: boolean[];
  deployments: Array<Deployment | null>;
  contracts: {
    groupRegistry?: Contract;
    whitelist?: Contract;
    vault?: Contract;
    policy?: Contract;
    verifier?: Contract;
    orchestrator?: Contract;
  };
};

function orchestratorArgs(
  context: StackContext,
  whitelistPolicy: string
): unknown[] {
  return [
    context.deployer,
    context.chainId,
    context.escrowRegistry,
    context.paymentVerifierRegistry,
    context.relayerRegistry,
    context.protocolFee,
    context.protocolFeeRecipient,
    whitelistPolicy,
  ];
}

async function liveContext(
  hre: HardhatRuntimeEnvironment,
  network: O4Network
): Promise<StackContext> {
  const pins = O4_EXPECTED_LIVE[network];
  const expected = EXPECTED_LIVE[network];
  return {
    network,
    deployer: pins.deployer,
    governance: pins.governance,
    stakeToken: pins.stakeToken,
    disputeVerifier: pins.disputeVerifier.address,
    disputeNullifierRegistry: pins.disputeNullifierRegistry.address,
    ...(await readWhitelistDependencies(hre)),
    nullifierRegistryV2: expected.nullifierRegistryV2,
    attestationVerifier: expected.attestationVerifier,
    paymentMethods: pins.paymentMethods.map(paymentMethodHash),
    transferOwnership: network === "base",
    chainId: pins.chainId,
    paymentVerifierRegistry: expected.paymentVerifierRegistry,
    relayerRegistry: expected.relayerRegistry,
    protocolFee: "0",
    protocolFeeRecipient: expected.protocolFeeRecipient,
    allowMultipleIntents: pins.allowMultipleIntents,
  };
}

export async function readFreshState(
  hre: HardhatRuntimeEnvironment,
  context: StackContext
): Promise<{
  deployments: Array<Deployment | null>;
  contracts: Lane45State["contracts"];
  completed: Record<string, boolean>;
}> {
  const deployments = await Promise.all(
    O4_DEPLOYMENT_NAMES.map(
      async (name) => (await hre.deployments.getOrNull(name)) ?? null
    )
  );
  const firstMissing = deployments.indexOf(null);
  requireState(
    firstMissing < 0 ||
      deployments.slice(firstMissing + 1).every((record) => record === null),
    "O4 deployment artifacts are not a contiguous prefix"
  );
  for (let index = 0; index < deployments.length; index += 1) {
    const record = deployments[index];
    if (!record) continue;
    const name = O4_DEPLOYMENT_NAMES[index];
    await assertO4DeploymentRecord(hre, context.network, name, record);
  }
  const [
    vaultRecord,
    groupRegistryRecord,
    whitelistRecord,
    policyRecord,
    verifierRecord,
    orchestratorRecord,
  ] = deployments;
  await assertFreshPolicyUnused(hre, policyRecord);
  const contracts: Lane45State["contracts"] = {};
  const completed: Record<string, boolean> = {
    "deploy-vault": Boolean(vaultRecord),
    "deploy-group-registry": Boolean(groupRegistryRecord),
    "deploy-whitelist": Boolean(whitelistRecord),
    "deploy-policy": Boolean(policyRecord),
    "deploy-verifier": Boolean(verifierRecord),
    "deploy-orchestrator": Boolean(orchestratorRecord),
  };
  if (groupRegistryRecord) {
    contracts.groupRegistry = await hre.ethers.getContractAt(
      "AddressGroupRegistry", groupRegistryRecord.address
    );
  }
  if (whitelistRecord) {
    requireState(
      !sameAddress(whitelistRecord.address, context.predecessorWhitelistPolicy),
      "WhitelistPolicyV4 reused WhitelistPolicyMethodScoped"
    );
    const whitelist = (contracts.whitelist = await hre.ethers.getContractAt(
      "WhitelistPolicy", whitelistRecord.address
    ));
    for (const [field, address] of [
      ["groupRegistry", groupRegistryRecord!.address],
      ["escrowRegistry", context.escrowRegistry],
      ["orchestratorRegistry", context.orchestratorRegistry],
    ] as const) {
      requireState(
        sameAddress(await whitelist[field](), address),
        `Fresh WhitelistPolicyV4 ${field} drifted`
      );
    }
    const owner: string = await whitelist.owner();
    requireState(
      sameAddress(owner, context.deployer) ||
        (context.transferOwnership && sameAddress(owner, context.governance)),
      "Fresh WhitelistPolicyV4 owner drifted"
    );
    completed["transfer-whitelist-owner"] =
      context.transferOwnership && sameAddress(owner, context.governance);
  }
  if (vaultRecord) {
    const vault = (contracts.vault = await hre.ethers.getContractAt(
      "StakeVaultV2",
      vaultRecord.address
    ));
    requireState(
      sameAddress(await vault.stakeToken(), context.stakeToken),
      "Fresh StakeVaultV2 dependency state drifted"
    );
    completed["authorize-controller"] = Boolean(
      policyRecord && (await vault.isController(policyRecord.address))
    );
    if (context.transferOwnership) {
      completed["transfer-vault-owner"] = ownershipStepState(
        await vault.owner(),
        await vault.pendingOwner(),
        context.deployer,
        context.governance,
        "StakeVaultV2"
      );
    } else {
      await assertUntransferredOwnership(
        vault,
        context.deployer,
        "StakeVaultV2"
      );
    }
  }
  if (policyRecord) {
    const policy = (contracts.policy = await hre.ethers.getContractAt(
      "DisputeProtectionPolicyV2",
      policyRecord.address
    ));
    requireState(
      sameAddress(await policy.stakeVault(), vaultRecord!.address) &&
        sameAddress(await policy.disputeVerifier(), context.disputeVerifier) &&
        sameAddress(
          await policy.disputeNullifierRegistry(),
          context.disputeNullifierRegistry
        ) &&
        sameAddress(
          await policy.orchestratorRegistry(),
          context.orchestratorRegistry
        ),
      "Fresh DisputeProtectionPolicyV2 dependency state drifted"
    );
    if (context.transferOwnership) {
      completed["transfer-policy-owner"] = ownershipStepState(
        await policy.owner(),
        await policy.pendingOwner(),
        context.deployer,
        context.governance,
        "DisputeProtectionPolicyV2"
      );
    } else {
      await assertUntransferredOwnership(
        policy,
        context.deployer,
        "DisputeProtectionPolicyV2"
      );
    }
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
  if (orchestratorRecord) {
    const orchestrator = (contracts.orchestrator =
      await hre.ethers.getContractAt(
        "OrchestratorV4",
        orchestratorRecord.address
      ));
    for (const field of [
      "escrowRegistry",
      "whitelistPolicy",
      "paymentVerifierRegistry",
      "relayerRegistry",
      "protocolFeeRecipient",
    ] as const) {
      requireState(
        sameAddress(
          await orchestrator[field](),
          field === "whitelistPolicy" ? whitelistRecord!.address : context[field]
        ),
        `Fresh OrchestratorV4 ${field} drifted`
      );
    }
    for (const field of ["chainId", "protocolFee"] as const) {
      requireState(
        BigNumber.from(await orchestrator[field]()).eq(context[field]),
        `Fresh OrchestratorV4 ${field} drifted`
      );
    }
    requireState(
      !(await orchestrator.paused()),
      "Fresh OrchestratorV4 paused state drifted"
    );
    const settlementPolicy = await orchestrator.settlementPolicy();
    requireState(
      sameAddress(settlementPolicy, constants.AddressZero) ||
        sameAddress(settlementPolicy, policyRecord!.address),
      "Fresh OrchestratorV4 settlement policy drifted"
    );
    completed["set-orchestrator-policy"] = sameAddress(
      settlementPolicy,
      policyRecord!.address
    );
    const multiple = await orchestrator.allowMultipleIntents();
    requireState(
      !multiple || context.allowMultipleIntents,
      "Fresh OrchestratorV4 allowMultipleIntents drifted"
    );
    completed["set-allow-multiple-intents"] = multiple;
    const owner = await orchestrator.owner();
    requireState(
      sameAddress(owner, context.deployer) ||
        (context.transferOwnership && sameAddress(owner, context.governance)),
      "Fresh OrchestratorV4 owner drifted"
    );
    completed["transfer-orchestrator-owner"] =
      context.transferOwnership && sameAddress(owner, context.governance);
    const registry = await hre.ethers.getContractAt(
      "OrchestratorRegistry",
      context.orchestratorRegistry
    );
    requireState(
      !(await registry.isOrchestrator(orchestrator.address)),
      "OrchestratorV4 registered before lane 46"
    );
  }
  return { completed, deployments, contracts };
}

export async function readLane45State(
  hre: HardhatRuntimeEnvironment,
  network: O4Network
): Promise<Lane45State> {
  await assertLiveSharedState(hre, network);
  const state = await readFreshState(hre, await liveContext(hre, network));
  const completed = LANE_45_STEP_KINDS[network].map((step) => {
    if (step.startsWith("add-verifier-method:")) {
      const [kind, method] = step.split(":");
      return state.completed[`${kind}:${paymentMethodHash(method)}`] || false;
    }
    return state.completed[step] || false;
  });
  classifyLane45Prefix(network, completed);
  return { ...state, completed };
}

/** Authorization remains possible if stake arrives before the policy is deployed. */
async function authorizePolicyController(
  vault: Contract,
  policy: Contract
): Promise<void> {
  if (!(await vault.isController(policy.address))) {
    await (await vault.setController(policy.address, true)).wait();
  }
}

async function deployLiveO4Stack(
  hre: HardhatRuntimeEnvironment,
  network: O4Network
): Promise<void> {
  requireState(
    process.env[LIVE_FLAGS[network]] === "true",
    `${network} O4 deployment requires ${LIVE_FLAGS[network]}=true`
  );
  const context = await liveContext(hre, network);
  while (true) {
    const state = await readLane45State(hre, network);
    const prefix = classifyLane45Prefix(network, state.completed);
    if (prefix.nextStep === null) {
      await assertFreshPolicyUnused(
        hre,
        state.deployments[O4_DEPLOYMENT_NAMES.indexOf("DisputeProtectionPolicyV2")]
      );
      console.log(`=== ${network} OrchestratorV4 stack prepared ===`);
      return;
    }
    const step = LANE_45_STEP_KINDS[network][prefix.nextStep];
    await executeLane45Step(hre, context, state, step);
    await waitForDeploymentDelay(hre);
  }
}

export async function executeLane45Step(
  hre: HardhatRuntimeEnvironment,
  context: StackContext,
  state: Lane45State,
  step: string
): Promise<void> {
  if (step === "deploy-vault") {
    await deployFresh(hre, "StakeVaultV2", context.deployer, [
      context.deployer,
      context.stakeToken,
    ]);
  } else if (step === "deploy-group-registry") {
    await deployFresh(hre, "AddressGroupRegistryV4", context.deployer, []);
  } else if (step === "deploy-whitelist") {
    await deployFresh(hre, "WhitelistPolicyV4", context.deployer, [
      state.contracts.groupRegistry!.address,
      context.escrowRegistry,
      context.orchestratorRegistry,
    ]);
  } else if (step === "deploy-policy") {
    await deployFresh(hre, "DisputeProtectionPolicyV2", context.deployer, [
      context.deployer,
      state.contracts.vault!.address,
      context.disputeVerifier,
      context.disputeNullifierRegistry,
      context.orchestratorRegistry,
    ]);
  } else if (step === "authorize-controller") {
    await authorizePolicyController(
      state.contracts.vault!,
      state.contracts.policy!
    );
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
  } else if (step === "deploy-orchestrator") {
    await deployFresh(
      hre,
      "OrchestratorV4",
      context.deployer,
      orchestratorArgs(context, state.contracts.whitelist!.address)
    );
  } else if (step === "set-orchestrator-policy") {
    await (
      await state.contracts.orchestrator!.setSettlementPolicy(
        state.contracts.policy!.address
      )
    ).wait();
  } else if (step === "set-allow-multiple-intents") {
    await (
      await state.contracts.orchestrator!.setAllowMultipleIntents(true)
    ).wait();
  } else if (step === "transfer-orchestrator-owner") {
    await (
      await state.contracts.orchestrator!.transferOwnership(context.governance)
    ).wait();
  } else if (step === "transfer-vault-owner") {
    await (
      await state.contracts.vault!.transferOwnership(context.governance)
    ).wait();
  } else if (step === "transfer-policy-owner") {
    await (
      await state.contracts.policy!.transferOwnership(context.governance)
    ).wait();
  } else if (step === "transfer-whitelist-owner") {
    await (
      await state.contracts.whitelist!.transferOwnership(context.governance)
    ).wait();
  } else if (step === "transfer-verifier-owner") {
    await (
      await state.contracts.verifier!.transferOwnership(context.governance)
    ).wait();
  } else {
    throw new Error(`Unknown deploy-only step ${step}`);
  }
}

async function deployFresh(
  hre: HardhatRuntimeEnvironment,
  name: O4DeploymentName,
  deployer: string,
  args: unknown[]
): Promise<Deployment> {
  const deployment = await hre.deployments.deploy(name, {
    contract: O4_ARTIFACT_NAMES[name],
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

async function localContext(
  hre: HardhatRuntimeEnvironment
): Promise<StackContext> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const predecessorVault = await hre.deployments.get(
    O4_PREDECESSOR_DEPLOYMENT_NAMES.vault
  );
  const predecessorPolicy = await hre.deployments.get(
    O4_PREDECESSOR_DEPLOYMENT_NAMES.policy
  );
  await hre.deployments.get(O4_PREDECESSOR_DEPLOYMENT_NAMES.hook);
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
  }
  const orchestratorV3 = await hre.ethers.getContractAt(
    "OrchestratorV3",
    (
      await hre.deployments.get("OrchestratorV3")
    ).address
  );
  const context: StackContext = {
    network,
    deployer,
    governance: deployer,
    stakeToken:
      USDC[network] || (await hre.deployments.get("USDCMock")).address,
    disputeVerifier: (await hre.deployments.get("DisputeVerifier")).address,
    disputeNullifierRegistry: (
      await hre.deployments.get("DisputeNullifierRegistry")
    ).address,
    ...(await readWhitelistDependencies(hre)),
    nullifierRegistryV2: (await hre.deployments.get("NullifierRegistryV2"))
      .address,
    attestationVerifier: (
      (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
      (await hre.deployments.get("SimpleAttestationVerifier"))
    ).address,
    paymentMethods: methods,
    transferOwnership: false,
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    paymentVerifierRegistry: await orchestratorV3.paymentVerifierRegistry(),
    relayerRegistry: await orchestratorV3.relayerRegistry(),
    protocolFee: (await orchestratorV3.protocolFee()).toString(),
    protocolFeeRecipient: await orchestratorV3.protocolFeeRecipient(),
    allowMultipleIntents: await orchestratorV3.allowMultipleIntents(),
  };
  requireState(
    sameAddress(context.escrowRegistry, await orchestratorV3.escrowRegistry()),
    "Local predecessor whitelist escrow registry differs from OrchestratorV3"
  );
  return context;
}

function localSteps(context: StackContext): string[] {
  return [
    "deploy-vault",
    "deploy-group-registry",
    "deploy-whitelist",
    "deploy-policy",
    "authorize-controller",
    "deploy-verifier",
    ...context.paymentMethods.map((method) => `add-verifier-method:${method}`),
    "deploy-orchestrator",
    "set-orchestrator-policy",
    ...(context.allowMultipleIntents ? ["set-allow-multiple-intents"] : []),
  ];
}

async function deployLocalO4Stack(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const context = await localContext(hre);
  const { network, deployer, paymentMethods: methods } = context;
  const deploy = async (
    name: O4DeploymentName,
    args: unknown[]
  ): Promise<Deployment> => {
    const existing = await hre.deployments.getOrNull(name);
    if (existing) {
      await assertO4DeploymentRecord(hre, network, name, existing);
      return existing;
    }
    const result = await deployFresh(hre, name, deployer, args);
    await waitForDeploymentDelay(hre);
    await assertCanonicalDeployment(
      hre,
      result,
      name,
      O4_ARTIFACT_NAMES[name]
    );
    return result;
  };
  await readFreshState(hre, context);
  const vaultRecord = await deploy("StakeVaultV2", [
    deployer,
    context.stakeToken,
  ]);
  const groupRegistryRecord = await deploy("AddressGroupRegistryV4", []);
  const whitelistRecord = await deploy("WhitelistPolicyV4", [
    groupRegistryRecord.address,
    context.escrowRegistry,
    context.orchestratorRegistry,
  ]);
  const policyRecord = await deploy("DisputeProtectionPolicyV2", [
    deployer,
    vaultRecord.address,
    context.disputeVerifier,
    context.disputeNullifierRegistry,
    context.orchestratorRegistry,
  ]);
  let state = await readFreshState(hre, context);
  while (!state.completed["authorize-controller"]) {
    await authorizePolicyController(
      state.contracts.vault!,
      state.contracts.policy!
    );
    await waitForDeploymentDelay(hre);
    state = await readFreshState(hre, context);
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
  await deploy("OrchestratorV4", orchestratorArgs(context, whitelistRecord.address));
  state = await readFreshState(hre, context);
  if (!state.completed["set-orchestrator-policy"]) {
    await (
      await state.contracts.orchestrator!.setSettlementPolicy(policyRecord.address)
    ).wait();
    await waitForDeploymentDelay(hre);
  }
  if (
    context.allowMultipleIntents &&
    !state.completed["set-allow-multiple-intents"]
  ) {
    await (
      await state.contracts.orchestrator!.setAllowMultipleIntents(true)
    ).wait();
    await waitForDeploymentDelay(hre);
  }
  state = await readFreshState(hre, context);
  const expectedSteps = localSteps(context);
  requireState(
    expectedSteps.every((step) => state.completed[step]),
    "Local O4 stack preparation verification failed"
  );
}

/** After activation starts, lane 46 verifies the stack and action prefix. */
export async function orchestratorV4StackPrepared(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return false;
  const live = isO4LiveNetwork(network);
  const records = await Promise.all(
    O4_DEPLOYMENT_NAMES.map((name) => hre.deployments.getOrNull(name))
  );
  if (records.every(Boolean)) {
    const registry = await hre.ethers.getContractAt(
      "NullifierRegistry",
      live
        ? O4_EXPECTED_LIVE[network].disputeNullifierRegistry.address
        : (
            await hre.deployments.get("DisputeNullifierRegistry")
          ).address
    );
    const policy =
      records[
        O4_DEPLOYMENT_NAMES.indexOf("DisputeProtectionPolicyV2")
      ]!;
    // Lane 46's first action authorizes the fresh policy as a dispute writer.
    if (await registry.isWriter(policy.address)) {
      // Lazy loading avoids a load-time dependency on lane 46 for lane 45.
      const lane46: typeof import("./46_activate_orchestrator_v4_stack") = require("./46_activate_orchestrator_v4_stack");
      await lane46.loadO4ActivationContext(
        hre,
        network as "base" | "base_staging" | "hardhat" | "localhost"
      );
      const block = await hre.ethers.provider.getBlockNumber();
      const snapshot = live
        ? await lane46.assertO4ActivationSharedState(hre, network, block)
        : await lane46.readO4ActivationSnapshot(
            hre,
            network as "hardhat" | "localhost",
            block
          );
      const { phase } = reduceO4Activation(
        snapshot,
        lane46.expectedO4ActivationState(
          network as "base" | "base_staging" | "hardhat" | "localhost"
        )
      );
      console.log(
        `=== ${network} OrchestratorV4 stack prepared; lane 46 activation is ${phase} ===`
      );
      return true;
    }
  }
  if (!live) {
    const context = await localContext(hre);
    const state = await readFreshState(hre, context);
    return localSteps(context).every((step) => state.completed[step]);
  }
  const state = await readLane45State(hre, network);
  return classifyLane45Prefix(network, state.completed).nextStep === null;
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return;
  if (isO4LiveNetwork(network)) {
    requireState(
      process.env[LIVE_FLAGS[network]] === "true",
      `${network} O4 deployment requires ${LIVE_FLAGS[network]}=true`
    );
    await deployLiveO4Stack(hre, network);
    return;
  }
  await deployLocalO4Stack(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (!isO4LiveNetwork(network)) return false;
  if (process.env.DEPLOY_ACTIVE_TAG !== LANE_45_TAG) return true;
  const records = await Promise.all(
    O4_DEPLOYMENT_NAMES.map((name) => hre.deployments.getOrNull(name))
  );
  if (!records.some(Boolean) && process.env[LIVE_FLAGS[network]] !== "true") {
    throw new Error(
      `${network} O4 deployment requires ${LIVE_FLAGS[network]}=true; set the flag and retry`
    );
  }
  return orchestratorV4StackPrepared(hre);
};

func.tags = [LANE_45_TAG, "OrchestratorV4Stack"];
func.dependencies = [];
export default func;
