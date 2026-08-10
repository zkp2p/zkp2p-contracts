import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  ACTIVE_PAYMENT_METHODS,
  DISPUTE_RISK_WINDOW,
  DISPUTABLE_PAYMENT_METHODS,
  MULTI_SIG,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import {
  addWritePermission,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";
import { paymentBindingCutoverReady } from "./31_deploy_v3_payment_binding_stack";

const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);
const STACK_DEPLOYMENT_NAMES = [
  "DisputeNullifierRegistry",
  "DisputeVerifier",
  "StakeVault",
  "DisputeProtectionPolicy",
  "IntentLifecycleHookV1",
] as const;
const STACK_ARTIFACT_NAMES: Record<
  (typeof STACK_DEPLOYMENT_NAMES)[number],
  string
> = {
  DisputeNullifierRegistry: "NullifierRegistry",
  DisputeVerifier: "DisputeVerifier",
  StakeVault: "StakeVault",
  DisputeProtectionPolicy: "DisputeProtectionPolicy",
  IntentLifecycleHookV1: "IntentLifecycleHookV1",
};
export const EXPECTED_ORCHESTRATOR: Record<
  string,
  {
    address: string;
    runtimeCodeHash: string;
    predecessorHook: string;
    predecessorHookCodeHash: string;
    protocolFeeRecipient: string;
    chainId: number;
  }
> = {
  base: {
    address: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
    runtimeCodeHash:
      "0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9",
    predecessorHook: "0x251d78fb6bBb4071995Bce74bAfC9E4168638622",
    predecessorHookCodeHash:
      "0x03d02863ed5eaa096d4089cb1e126681c0621d99409124f4af5be7ed83e341fe",
    protocolFeeRecipient: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    chainId: 8453,
  },
  base_staging: {
    address: "0x2b5E8Ab562e45fA89D73802605E145ED3E3EeF4f",
    runtimeCodeHash:
      "0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9",
    predecessorHook: "0xE8Fe714f848fAf7ecff7960AfD0C395771C22AA1",
    predecessorHookCodeHash:
      "0xfe6624ddbdcca7a2469af6ad6aecd50eda492aae017ad959093b3db1fd7f298a",
    protocolFeeRecipient: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    chainId: 8453,
  },
};
const EXPECTED_ATTESTATION_VERIFIER: Record<
  string,
  {
    address: string;
    runtimeCodeHash: string;
    witnesses: [string, string];
    requiredSignatures: number;
  }
> = {
  base: {
    address: "0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5",
    runtimeCodeHash:
      "0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a",
    witnesses: [
      "0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754",
      "0xE078D93bFdd87A8c5C5cCA5905DCbA0Dd7A1F0BD",
    ],
    requiredSignatures: 1,
  },
  base_staging: {
    address: "0x9855a39aC5975069632e91160d8712CBfF19e864",
    runtimeCodeHash:
      "0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a",
    witnesses: [
      "0x66649F896521b0fb487fE2077b4FBDA283d7f19a",
      "0x4ab950AE1e3326578Bf7e643a2031E858aBa2927",
    ],
    requiredSignatures: 1,
  },
};
export const EXPECTED_NETWORK_DEPENDENCIES: Record<
  string,
  {
    deployer: string;
    orchestratorRegistry: string;
    escrowRegistry: string;
    paymentVerifierRegistry: string;
    relayerRegistry: string;
    whitelistPolicy: string;
    addressGroupRegistry: string;
    nullifierRegistryV2: string;
    stakeToken: string;
    controllerChangeDelay: number;
  }
> = {
  base: {
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    orchestratorRegistry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
    escrowRegistry: "0xeD0e847B101abc96E796260AC358e12BAa2f5B21",
    paymentVerifierRegistry: "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e",
    relayerRegistry: "0xEbA979889a9c97382A92472fF3703786fF180083",
    whitelistPolicy: "0xBC53641b4B2504f0061D6a9426C61B8eBE9B4Ff0",
    addressGroupRegistry: "0x39F80118f9eB619135f116171b6Cb91D372C5AF2",
    nullifierRegistryV2: "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB",
    stakeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    controllerChangeDelay: 172_800,
  },
  base_staging: {
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    orchestratorRegistry: "0xfA6384EB6176cfEC049540526A3d2126C3666d8A",
    escrowRegistry: "0xc545f336eC77E69bf115729acCbf2e557A00ac91",
    paymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
    relayerRegistry: "0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E",
    whitelistPolicy: "0x7d9277cb8bb78a51eeaafB7CFF306E7DA4C972fD",
    addressGroupRegistry: "0x54Ff7788Cb42B46FE2F016a65Fd0f654Bb9BcF3D",
    nullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
    stakeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    controllerChangeDelay: 172_800,
  },
};
const STAGING_PREDECESSOR = {
  fromBlock: 49_316_251,
  orchestratorFromBlock: 49_486_337,
  owner: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
  hook: {
    address: "0xE8Fe714f848fAf7ecff7960AfD0C395771C22AA1",
    runtimeCodeHash:
      "0xfe6624ddbdcca7a2469af6ad6aecd50eda492aae017ad959093b3db1fd7f298a",
  },
  policy: {
    address: "0xC1E16Bf824fA7cee8770Fb72F49349091D4e583B",
    runtimeCodeHash:
      "0x427e40f30c699f0b69e430233ebfa5e14fec2ae725d69dd0cf121df1207b8cad",
  },
  vault: {
    address: "0x224a45C65eB9A4D1dB00eD6Bfe21aD7Ec0a9b0E4",
    runtimeCodeHash:
      "0x77d59eb29bff6ca33dfa666c8074f907e10c4ad4ac6664989e5174ad2e2061b8",
  },
  verifier: {
    address: "0xd297CD116D7F6EFb807f855237A2EF72C0854579",
    runtimeCodeHash:
      "0x8668eb54450b595143a0bab37774fd5b08802e5b4346d7e09633525086ad8ec2",
  },
  nullifierRegistry: {
    address: "0xaDa339E7d3542ee636FA2cda6BFbFE5720F0EEF5",
    runtimeCodeHash:
      "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
  },
  retiredDepositSetting: {
    escrow: "0x77e8f808FE201075e0bD651CD46fdF239fc83265",
    depositId: 87,
    events: [
      {
        blockNumber: 49_612_788,
        transactionHash:
          "0xb2f56cd2d74fdc660132c5e13966302a7a4f67d94945fa908b132c63f00019ff",
        isEnabled: true,
      },
      {
        blockNumber: 49_612_804,
        transactionHash:
          "0x455c91175c36ec8c9d616e7b2977f5d39130d3559e76aeca8881ce07dd491649",
        isEnabled: false,
      },
    ],
    closedBlockNumber: 49_612_806,
    closedTransactionHash:
      "0xbd5a4ce4c32de20a1cb0f8fb2f29a56de6aca99c8377ad0afd13d0b0433937dc",
  },
} as const;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameAddressArray(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((address, index) => sameAddress(address, expected[index]))
  );
}

export function assertStagingRetiredDepositSettingEvidence(
  logs: Array<{
    escrow: string;
    depositId: number;
    isEnabled: boolean;
    blockNumber: number;
    transactionHash: string;
  }>,
  tombstone: {
    canonicalEscrow: string;
    allZeroDeposit: boolean;
    depositCounterGreater: boolean;
    paymentMethodsEmpty: boolean;
    intentHashesEmpty: boolean;
    closedBlockNumber?: number;
    closedTransactionHash?: string;
  }
): void {
  const expected = STAGING_PREDECESSOR.retiredDepositSetting;
  if (
    !sameAddress(tombstone.canonicalEscrow, expected.escrow) ||
    logs.length !== expected.events.length ||
    logs.some((log, index) => {
      const expectedEvent = expected.events[index];
      return (
        !sameAddress(log.escrow, expected.escrow) ||
        log.depositId !== expected.depositId ||
        log.isEnabled !== expectedEvent.isEnabled ||
        log.blockNumber !== expectedEvent.blockNumber ||
        log.transactionHash.toLowerCase() !== expectedEvent.transactionHash
      );
    })
  ) {
    throw new Error("Staging predecessor deposit setting history drifted");
  }
  if (
    !tombstone.allZeroDeposit ||
    !tombstone.depositCounterGreater ||
    !tombstone.paymentMethodsEmpty ||
    !tombstone.intentHashesEmpty
  ) {
    throw new Error(
      "Staging predecessor deposit setting belongs to a live or nonempty deposit"
    );
  }
  if (
    tombstone.closedBlockNumber !== expected.closedBlockNumber ||
    tombstone.closedTransactionHash?.toLowerCase() !==
      expected.closedTransactionHash
  ) {
    throw new Error("Staging predecessor deposit tombstone evidence drifted");
  }
}

export function assertLifecycleHookPhase(
  currentHook: string,
  predecessorHook: string,
  freshHook: string,
  phase: "prepared" | "ready"
): void {
  const expectedHook = phase === "prepared" ? predecessorHook : freshHook;
  if (!sameAddress(currentHook, expectedHook)) {
    throw new Error(
      `OrchestratorV3 lifecycle hook is not in the expected ${phase} phase`
    );
  }
}

function paymentMethodHash(name: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
}

async function assertCode(address: string, label: string): Promise<string> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(`${label} has no bytecode: ${address}`);
  }
  return code;
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
      normalized =
        normalized.slice(0, start) +
        "0".repeat(length) +
        normalized.slice(start + length);
    }
  }
  return `0x${normalized}`;
}

async function assertDeploymentRuntime(
  hre: HardhatRuntimeEnvironment,
  deployment: any,
  label: (typeof STACK_DEPLOYMENT_NAMES)[number]
): Promise<void> {
  const code = await assertCode(deployment.address, label);
  const artifact = await hre.deployments.getExtendedArtifact(
    STACK_ARTIFACT_NAMES[label]
  );
  if (
    typeof deployment.deployedBytecode !== "string" ||
    deployment.deployedBytecode === "0x" ||
    typeof deployment.solcInputHash !== "string" ||
    deployment.solcInputHash.length === 0
  ) {
    throw new Error(
      `${label} artifact lacks reviewed bytecode/source evidence`
    );
  }
  if (deployment.solcInputHash !== artifact.solcInputHash) {
    throw new Error(
      `${label} artifact does not match the approved compiler input`
    );
  }
  const immutableReferences =
    artifact.evm?.deployedBytecode?.immutableReferences || {};
  const normalizedCode = zeroImmutableValues(code, immutableReferences);
  if (
    normalizedCode !==
      zeroImmutableValues(deployment.deployedBytecode, immutableReferences) ||
    normalizedCode !==
      zeroImmutableValues(artifact.deployedBytecode, immutableReferences)
  ) {
    throw new Error(`${label} runtime bytecode is not the canonical build`);
  }
}

async function assertExpectedAttestationVerifier(
  hre: HardhatRuntimeEnvironment,
  deployment: any,
  governance: string
): Promise<void> {
  const expected =
    EXPECTED_ATTESTATION_VERIFIER[hre.deployments.getNetworkName()];
  if (!expected) return;
  if (!sameAddress(deployment.address, expected.address)) {
    throw new Error("MultiAttestationVerifier address mismatch");
  }
  const code = await assertCode(deployment.address, "MultiAttestationVerifier");
  if (ethers.utils.keccak256(code) !== expected.runtimeCodeHash) {
    throw new Error("MultiAttestationVerifier runtime bytecode mismatch");
  }
  const contract = await ethers.getContractAt(
    "MultiAttestationVerifier",
    deployment.address
  );
  if (!sameAddress(await contract.owner(), governance)) {
    throw new Error("MultiAttestationVerifier owner mismatch");
  }
  if (
    !sameAddressArray(await contract.witnesses(), expected.witnesses) ||
    !(await contract.requiredSignatures()).eq(expected.requiredSignatures)
  ) {
    throw new Error("MultiAttestationVerifier witness configuration mismatch");
  }
}

async function assertExpectedNetworkDependencies(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const expected =
    EXPECTED_NETWORK_DEPENDENCIES[hre.deployments.getNetworkName()];
  if (!expected) return;
  const [deployer] = await hre.getUnnamedAccounts();
  if (!sameAddress(deployer, expected.deployer)) {
    throw new Error("Deployment signer does not match the approved deployer");
  }
  const configuredStakeToken =
    USDC[hre.deployments.getNetworkName()] ||
    (await hre.deployments.get("USDCMock")).address;
  if (!sameAddress(configuredStakeToken, expected.stakeToken)) {
    throw new Error("StakeVault token does not match the approved USDC target");
  }
  if (!STAKE_VAULT_CONTROLLER_CHANGE_DELAY.eq(expected.controllerChangeDelay)) {
    throw new Error("StakeVault controller delay drifted from 172800 seconds");
  }
  await assertCode(expected.stakeToken, "USDC");
  const names: Array<
    [
      (
        | "orchestratorRegistry"
        | "escrowRegistry"
        | "paymentVerifierRegistry"
        | "relayerRegistry"
        | "whitelistPolicy"
        | "addressGroupRegistry"
        | "nullifierRegistryV2"
      ),
      (
        | "OrchestratorRegistry"
        | "EscrowRegistry"
        | "PaymentVerifierRegistry"
        | "RelayerRegistry"
        | "WhitelistPolicy"
        | "AddressGroupRegistry"
        | "NullifierRegistryV2"
      )
    ]
  > = [
    ["orchestratorRegistry", "OrchestratorRegistry"],
    ["escrowRegistry", "EscrowRegistry"],
    ["paymentVerifierRegistry", "PaymentVerifierRegistry"],
    ["relayerRegistry", "RelayerRegistry"],
    ["whitelistPolicy", "WhitelistPolicy"],
    ["addressGroupRegistry", "AddressGroupRegistry"],
    ["nullifierRegistryV2", "NullifierRegistryV2"],
  ];
  for (const [key, deploymentName] of names) {
    const deployment = await hre.deployments.get(deploymentName);
    if (!sameAddress(deployment.address, expected[key])) {
      throw new Error(`${deploymentName} artifact address mismatch`);
    }
  }
  const governance =
    MULTI_SIG[hre.deployments.getNetworkName()] || expected.deployer;
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
  ) {
    throw new Error("WhitelistPolicy configuration mismatch");
  }
}

async function getStackDeployments(
  hre: HardhatRuntimeEnvironment,
  allowPartial = false
): Promise<Record<string, any> | null> {
  const entries = await Promise.all(
    STACK_DEPLOYMENT_NAMES.map(
      async (name) => [name, await hre.deployments.getOrNull(name)] as const
    )
  );
  const present = entries.filter(([, deployment]) => deployment != null);
  if (present.length === 0) return null;
  if (!allowPartial && present.length !== STACK_DEPLOYMENT_NAMES.length) {
    throw new Error(
      `Partial dispute deployment artifacts found: ${present
        .map(([name]) => name)
        .join(", ")}`
    );
  }
  return Object.fromEntries(present) as Record<string, any>;
}

function completeStackExists(
  deployments: Record<string, any> | null
): deployments is Record<string, any> {
  return (
    deployments !== null &&
    STACK_DEPLOYMENT_NAMES.every((name) => deployments[name] != null)
  );
}

function assertContiguousStackPrefix(
  deployments: Record<string, any> | null
): void {
  if (!deployments) return;
  let foundMissing = false;
  for (const name of STACK_DEPLOYMENT_NAMES) {
    if (!deployments[name]) {
      foundMissing = true;
    } else if (foundMissing) {
      throw new Error(
        `Dispute deployment artifacts are not a contiguous recognized prefix: unexpected ${name}`
      );
    }
  }
}

async function ownershipIsResumable(
  contract: any,
  deployer: string,
  governance: string
): Promise<boolean> {
  const owner = await contract.owner();
  const pendingOwner = await contract.pendingOwner();
  return (
    (sameAddress(owner, deployer) || sameAddress(owner, governance)) &&
    (sameAddress(pendingOwner, ethers.constants.AddressZero) ||
      sameAddress(pendingOwner, governance))
  );
}

async function getStackContracts(
  hre: HardhatRuntimeEnvironment,
  deployments: Record<string, any>
) {
  const disputeNullifierRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    deployments.DisputeNullifierRegistry.address
  );
  const disputeVerifier = await ethers.getContractAt(
    "DisputeVerifier",
    deployments.DisputeVerifier.address
  );
  const vault = await ethers.getContractAt(
    "StakeVault",
    deployments.StakeVault.address
  );
  const disputeProtectionPolicy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    deployments.DisputeProtectionPolicy.address
  );
  const hook = await ethers.getContractAt(
    "IntentLifecycleHookV1",
    deployments.IntentLifecycleHookV1.address
  );
  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    (
      await hre.deployments.get("OrchestratorV3")
    ).address
  );
  return {
    disputeNullifierRegistry,
    disputeVerifier,
    vault,
    disputeProtectionPolicy,
    hook,
    orchestrator,
  };
}

async function assertPartialStackIsResumable(
  hre: HardhatRuntimeEnvironment,
  deployments: Record<string, any> | null
): Promise<void> {
  if (!deployments) return;
  assertContiguousStackPrefix(deployments);

  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const stakeTokenAddress =
    USDC[network] || (await hre.deployments.get("USDCMock")).address;
  const orchestratorRegistryAddress = (
    await hre.deployments.get("OrchestratorRegistry")
  ).address;
  const whitelistPolicyAddress = (await hre.deployments.get("WhitelistPolicy"))
    .address;
  const nullifierRegistryV2Address = (
    await hre.deployments.get("NullifierRegistryV2")
  ).address;
  const attestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));
  await assertExpectedAttestationVerifier(hre, attestationVerifier, governance);

  for (const name of STACK_DEPLOYMENT_NAMES) {
    if (deployments[name]) {
      await assertDeploymentRuntime(hre, deployments[name], name);
    }
  }

  const disputeNullifierRegistry = deployments.DisputeNullifierRegistry
    ? await ethers.getContractAt(
        "NullifierRegistry",
        deployments.DisputeNullifierRegistry.address
      )
    : null;
  const disputeVerifier = deployments.DisputeVerifier
    ? await ethers.getContractAt(
        "DisputeVerifier",
        deployments.DisputeVerifier.address
      )
    : null;
  const vault = deployments.StakeVault
    ? await ethers.getContractAt("StakeVault", deployments.StakeVault.address)
    : null;
  const policy = deployments.DisputeProtectionPolicy
    ? await ethers.getContractAt(
        "DisputeProtectionPolicy",
        deployments.DisputeProtectionPolicy.address
      )
    : null;
  const hook = deployments.IntentLifecycleHookV1
    ? await ethers.getContractAt(
        "IntentLifecycleHookV1",
        deployments.IntentLifecycleHookV1.address
      )
    : null;

  if (disputeNullifierRegistry) {
    const registryOwner = await disputeNullifierRegistry.owner();
    if (
      !sameAddress(registryOwner, deployer) &&
      !sameAddress(registryOwner, governance)
    ) {
      throw new Error("Partial DisputeNullifierRegistry owner mismatch");
    }
    const writers: string[] = await disputeNullifierRegistry.getWriters();
    if (
      writers.length > 1 ||
      (writers.length === 1 &&
        (!policy || !sameAddress(writers[0], policy.address)))
    ) {
      throw new Error("Partial DisputeNullifierRegistry writer mismatch");
    }
  }

  if (disputeVerifier) {
    if (
      !sameAddress(
        await disputeVerifier.nullifierRegistry(),
        nullifierRegistryV2Address
      ) ||
      !sameAddress(
        await disputeVerifier.attestationVerifier(),
        attestationVerifier.address
      ) ||
      !(await ownershipIsResumable(disputeVerifier, deployer, governance))
    ) {
      throw new Error("Partial DisputeVerifier configuration mismatch");
    }
  }

  if (vault) {
    const ownerIsRecognized = await ownershipIsResumable(
      vault,
      deployer,
      governance
    );
    const expectedController = policy?.address || ethers.constants.AddressZero;
    const actualController = await vault.controller();
    if (
      !ownerIsRecognized ||
      !sameAddress(await vault.stakeToken(), stakeTokenAddress) ||
      !(await vault.controllerChangeDelay()).eq(
        STAKE_VAULT_CONTROLLER_CHANGE_DELAY
      ) ||
      (!sameAddress(actualController, ethers.constants.AddressZero) &&
        !sameAddress(actualController, expectedController)) ||
      !sameAddress(
        await vault.pendingController(),
        ethers.constants.AddressZero
      ) ||
      !(await vault.pendingControllerValidAt()).isZero()
    ) {
      throw new Error("Partial StakeVault configuration mismatch");
    }
  }

  if (policy) {
    const ownerIsRecognized = await ownershipIsResumable(
      policy,
      deployer,
      governance
    );
    if (
      !ownerIsRecognized ||
      (await policy.admissionsPaused()) ||
      !sameAddress(await policy.stakeVault(), vault?.address || "") ||
      !sameAddress(
        await policy.disputeVerifier(),
        disputeVerifier?.address || ""
      ) ||
      !sameAddress(
        await policy.disputeNullifierRegistry(),
        disputeNullifierRegistry?.address || ""
      )
    ) {
      throw new Error("Partial DisputeProtectionPolicy configuration mismatch");
    }
    const disputableMethods = new Set(DISPUTABLE_PAYMENT_METHODS);
    for (const methodName of ACTIVE_PAYMENT_METHODS) {
      const riskWindow = await policy.getRiskWindow(
        paymentMethodHash(methodName)
      );
      const expectedRiskWindow = disputableMethods.has(methodName)
        ? DISPUTE_RISK_WINDOW[network]
        : ethers.constants.Zero;
      if (!riskWindow.isZero() && !riskWindow.eq(expectedRiskWindow)) {
        throw new Error(`Partial risk window mismatch for ${methodName}`);
      }
    }
    const fromBlock = deployments.DisputeProtectionPolicy.receipt?.blockNumber;
    if (typeof fromBlock !== "number" || !Number.isSafeInteger(fromBlock)) {
      throw new Error(
        "Partial DisputeProtectionPolicy lacks deployment-block evidence"
      );
    }
    const authorizationLogs = await policy.queryFilter(
      policy.filters.LifecycleHookAuthorizationUpdated(),
      fromBlock,
      await ethers.provider.getBlockNumber()
    );
    const authorization = new Map<string, boolean>();
    for (const log of authorizationLogs) {
      const authorizedHook = log.args?.hook || log.args?.[0];
      const isAuthorized = log.args?.isAuthorized ?? log.args?.[1];
      if (!authorizedHook || typeof isAuthorized !== "boolean") {
        throw new Error(
          "Unable to decode partial lifecycle-hook authorization history"
        );
      }
      authorization.set(authorizedHook.toLowerCase(), isAuthorized);
    }
    const expectedHook = hook?.address.toLowerCase();
    if (
      [...authorization.entries()].some(
        ([authorizedHook, isAuthorized]) =>
          isAuthorized && authorizedHook !== expectedHook
      )
    ) {
      throw new Error(
        "Partial DisputeProtectionPolicy has an unexpected authorized hook"
      );
    }
  }

  if (
    hook &&
    (!sameAddress(
      await hook.orchestratorRegistry(),
      orchestratorRegistryAddress
    ) ||
      !sameAddress(await hook.whitelistPolicy(), whitelistPolicyAddress) ||
      !sameAddress(await hook.disputeProtectionPolicy(), policy?.address || ""))
  ) {
    throw new Error("Partial IntentLifecycleHookV1 configuration mismatch");
  }
}

async function assertExpectedOrchestratorCore(
  hre: HardhatRuntimeEnvironment,
  orchestrator: any
): Promise<(typeof EXPECTED_ORCHESTRATOR)[string] | null> {
  const network = hre.deployments.getNetworkName();
  const expected = EXPECTED_ORCHESTRATOR[network];
  if (!expected) return null;

  if (!sameAddress(orchestrator.address, expected.address)) {
    throw new Error("OrchestratorV3 address does not match the audited target");
  }
  const code = await ethers.provider.getCode(orchestrator.address);
  if (ethers.utils.keccak256(code) !== expected.runtimeCodeHash) {
    throw new Error("OrchestratorV3 runtime bytecode hash mismatch");
  }
  const governance =
    MULTI_SIG[network] || EXPECTED_NETWORK_DEPENDENCIES[network].deployer;
  if (!sameAddress(await orchestrator.owner(), governance)) {
    throw new Error("OrchestratorV3 owner mismatch");
  }
  const orchestratorRegistry = await ethers.getContractAt(
    "OrchestratorRegistry",
    (
      await hre.deployments.get("OrchestratorRegistry")
    ).address
  );
  if (!(await orchestratorRegistry.isOrchestrator(orchestrator.address))) {
    throw new Error("OrchestratorV3 is not registered");
  }
  if (await orchestrator.paused()) {
    throw new Error("OrchestratorV3 is paused");
  }
  const [chain, escrowRegistry, paymentVerifierRegistry, relayerRegistry] =
    await Promise.all([
      ethers.provider.getNetwork(),
      hre.deployments.get("EscrowRegistry"),
      hre.deployments.get("PaymentVerifierRegistry"),
      hre.deployments.get("RelayerRegistry"),
    ]);
  if (
    chain.chainId !== expected.chainId ||
    !(await orchestrator.chainId()).eq(expected.chainId) ||
    !sameAddress(await orchestrator.escrowRegistry(), escrowRegistry.address) ||
    !sameAddress(
      await orchestrator.paymentVerifierRegistry(),
      paymentVerifierRegistry.address
    ) ||
    !sameAddress(
      await orchestrator.relayerRegistry(),
      relayerRegistry.address
    ) ||
    !(await orchestrator.protocolFee()).isZero() ||
    !sameAddress(
      await orchestrator.protocolFeeRecipient(),
      expected.protocolFeeRecipient
    ) ||
    (await orchestrator.allowMultipleIntents())
  ) {
    throw new Error("OrchestratorV3 mutable configuration mismatch");
  }
  return expected;
}

async function assertExpectedOrchestrator(
  hre: HardhatRuntimeEnvironment,
  contracts: Awaited<ReturnType<typeof getStackContracts>>
): Promise<void> {
  const expected = await assertExpectedOrchestratorCore(
    hre,
    contracts.orchestrator
  );
  if (!expected) return;
  const currentHook = await contracts.orchestrator.lifecycleHook();
  if (
    !sameAddress(currentHook, expected.predecessorHook) &&
    !sameAddress(currentHook, contracts.hook.address)
  ) {
    throw new Error(
      "OrchestratorV3 lifecycle hook drifted from the audited predecessor"
    );
  }
  const hook = new ethers.Contract(
    currentHook,
    ["function whitelistPolicy() view returns (address)"],
    ethers.provider
  );
  if (
    !sameAddress(
      await hook.whitelistPolicy(),
      EXPECTED_NETWORK_DEPENDENCIES[hre.deployments.getNetworkName()]
        .whitelistPolicy
    )
  ) {
    throw new Error("Active lifecycle hook whitelist policy mismatch");
  }
}

async function assertOrchestratorPreflight(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const expected = EXPECTED_ORCHESTRATOR[hre.deployments.getNetworkName()];
  if (!expected) return;
  const deployment = await hre.deployments.get("OrchestratorV3");
  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    deployment.address
  );
  await assertExpectedOrchestratorCore(hre, orchestrator);
  assertLifecycleHookPhase(
    await orchestrator.lifecycleHook(),
    expected.predecessorHook,
    ethers.constants.AddressZero,
    "prepared"
  );
  const predecessorCode = await assertCode(
    expected.predecessorHook,
    "PredecessorLifecycleHook"
  );
  if (
    ethers.utils.keccak256(predecessorCode) !== expected.predecessorHookCodeHash
  ) {
    throw new Error("Predecessor lifecycle hook runtime bytecode mismatch");
  }
  const predecessorHook = new ethers.Contract(
    expected.predecessorHook,
    ["function whitelistPolicy() view returns (address)"],
    ethers.provider
  );
  if (
    !sameAddress(
      await predecessorHook.whitelistPolicy(),
      EXPECTED_NETWORK_DEPENDENCIES[hre.deployments.getNetworkName()]
        .whitelistPolicy
    )
  ) {
    throw new Error("Predecessor hook whitelist policy mismatch");
  }
}

async function assertOrchestratorStillOnPredecessor(
  hre: HardhatRuntimeEnvironment,
  contracts: Awaited<ReturnType<typeof getStackContracts>>
): Promise<void> {
  const expected = EXPECTED_ORCHESTRATOR[hre.deployments.getNetworkName()];
  if (!expected) return;
  assertLifecycleHookPhase(
    await contracts.orchestrator.lifecycleHook(),
    expected.predecessorHook,
    contracts.hook.address,
    "prepared"
  );
}

export async function assertStagingPredecessorDrained(
  hre: HardhatRuntimeEnvironment,
  contracts: Awaited<ReturnType<typeof getStackContracts>>
): Promise<void> {
  if (hre.deployments.getNetworkName() !== "base_staging") return;
  const governance = STAGING_PREDECESSOR.owner;
  const currentBlock = await ethers.provider.getBlockNumber();

  for (const [label, expected] of Object.entries({
    predecessorHook: STAGING_PREDECESSOR.hook,
    predecessorPolicy: STAGING_PREDECESSOR.policy,
    predecessorVault: STAGING_PREDECESSOR.vault,
    predecessorVerifier: STAGING_PREDECESSOR.verifier,
    predecessorNullifierRegistry: STAGING_PREDECESSOR.nullifierRegistry,
  })) {
    const code = await assertCode(expected.address, label);
    if (ethers.utils.keccak256(code) !== expected.runtimeCodeHash) {
      throw new Error(`${label} runtime bytecode hash mismatch`);
    }
  }

  const policy = new ethers.Contract(
    STAGING_PREDECESSOR.policy.address,
    [
      "function owner() view returns (address)",
      "function pendingOwner() view returns (address)",
      "function admissionsPaused() view returns (bool)",
      "function stakeVault() view returns (address)",
      "function chargebackVerifier() view returns (address)",
      "function chargebackNullifierRegistry() view returns (address)",
      "function isLifecycleHookAuthorized(address) view returns (bool)",
    ],
    ethers.provider
  );
  const vault = new ethers.Contract(
    STAGING_PREDECESSOR.vault.address,
    [
      "function owner() view returns (address)",
      "function pendingOwner() view returns (address)",
      "function controller() view returns (address)",
      "function pendingController() view returns (address)",
      "function pendingControllerValidAt() view returns (uint64)",
      "function controllerChangeDelay() view returns (uint256)",
      "function stakeToken() view returns (address)",
      "function totalStaked() view returns (uint256)",
      "function totalClaimable() view returns (uint256)",
      "function totalAccounted() view returns (uint256)",
      "function unaccountedBalance() view returns (uint256)",
    ],
    ethers.provider
  );
  const verifier = new ethers.Contract(
    STAGING_PREDECESSOR.verifier.address,
    [
      "function owner() view returns (address)",
      "function pendingOwner() view returns (address)",
      "function nullifierRegistry() view returns (address)",
      "function attestationVerifier() view returns (address)",
    ],
    ethers.provider
  );
  const nullifierRegistry = new ethers.Contract(
    STAGING_PREDECESSOR.nullifierRegistry.address,
    [
      "function owner() view returns (address)",
      "function getWriters() view returns (address[])",
    ],
    ethers.provider
  );
  const hook = new ethers.Contract(
    STAGING_PREDECESSOR.hook.address,
    [
      "function orchestratorRegistry() view returns (address)",
      "function whitelistPolicy() view returns (address)",
      "function chargebackPolicy() view returns (address)",
    ],
    ethers.provider
  );
  const usdc = new ethers.Contract(
    USDC.base_staging,
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider
  );
  const expectedOrchestratorRegistry = (
    await hre.deployments.get("OrchestratorRegistry")
  ).address;
  const expectedWhitelistPolicy = (await hre.deployments.get("WhitelistPolicy"))
    .address;
  const expectedNullifierRegistryV2 = (
    await hre.deployments.get("NullifierRegistryV2")
  ).address;
  const expectedEscrowV2 = (await hre.deployments.get("EscrowV2")).address;
  const expectedAttestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));

  if (
    !sameAddress(
      await hook.orchestratorRegistry(),
      expectedOrchestratorRegistry
    ) ||
    !sameAddress(await hook.whitelistPolicy(), expectedWhitelistPolicy) ||
    !sameAddress(await hook.chargebackPolicy(), policy.address)
  ) {
    throw new Error("Staging predecessor hook dependency mismatch");
  }
  if (
    !sameAddress(await policy.owner(), governance) ||
    !sameAddress(await policy.pendingOwner(), ethers.constants.AddressZero) ||
    !sameAddress(await policy.stakeVault(), vault.address) ||
    !sameAddress(await policy.chargebackVerifier(), verifier.address) ||
    !sameAddress(
      await policy.chargebackNullifierRegistry(),
      nullifierRegistry.address
    ) ||
    !(await policy.isLifecycleHookAuthorized(hook.address))
  ) {
    throw new Error("Staging predecessor policy configuration mismatch");
  }
  if (await policy.admissionsPaused()) {
    throw new Error("Staging predecessor policy pause state drifted");
  }
  if (
    !sameAddress(await verifier.owner(), governance) ||
    !sameAddress(await verifier.pendingOwner(), ethers.constants.AddressZero) ||
    !sameAddress(
      await verifier.nullifierRegistry(),
      expectedNullifierRegistryV2
    ) ||
    !sameAddress(
      await verifier.attestationVerifier(),
      expectedAttestationVerifier.address
    )
  ) {
    throw new Error("Staging predecessor verifier configuration mismatch");
  }
  if (
    !sameAddress(await vault.owner(), governance) ||
    !sameAddress(await vault.pendingOwner(), ethers.constants.AddressZero) ||
    !sameAddress(await vault.controller(), policy.address) ||
    !sameAddress(
      await vault.pendingController(),
      ethers.constants.AddressZero
    ) ||
    !(await vault.pendingControllerValidAt()).isZero() ||
    !(await vault.controllerChangeDelay()).eq(
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY
    ) ||
    !sameAddress(await vault.stakeToken(), USDC.base_staging)
  ) {
    throw new Error("Staging predecessor vault configuration mismatch");
  }
  const vaultBalances = await Promise.all([
    vault.totalStaked(),
    vault.totalClaimable(),
    vault.totalAccounted(),
    vault.unaccountedBalance(),
    usdc.balanceOf(vault.address),
  ]);
  if (vaultBalances.some((value) => !value.isZero())) {
    throw new Error("Staging predecessor vault is not drained");
  }
  const writers: string[] = await nullifierRegistry.getWriters();
  if (
    !sameAddress(await nullifierRegistry.owner(), governance) ||
    writers.length !== 1 ||
    !sameAddress(writers[0], policy.address)
  ) {
    throw new Error("Staging predecessor nullifier registry drifted");
  }

  const policyLifecycleTopics = [
    "ChargebackIntentOpened(bytes32,address,address,address,bytes32,uint256,uint64)",
    "ChargebackIntentCancelled(bytes32,address,uint256)",
    "ChargebackIntentSettled(bytes32,address,address,uint256,uint64,bool)",
    "ChargebackIntentReleased(bytes32,address,uint256)",
    "ChargebackSettled(bytes32,address,address,uint256,bytes32)",
  ].map(ethers.utils.id);
  const authorizationInterface = new ethers.utils.Interface([
    "event LifecycleHookAuthorizationUpdated(address indexed hook,bool isAuthorized)",
  ]);
  const chargebackEnabledInterface = new ethers.utils.Interface([
    "event ChargebackEnabledUpdated(address indexed escrow,uint256 indexed depositId,bool isChargebackEnabled)",
  ]);
  const [
    policyLifecycleLogs,
    chargebackEnabledLogs,
    authorizationLogs,
    nullifierLogs,
    signaledLogs,
  ] = await Promise.all([
    ethers.provider.getLogs({
      address: policy.address,
      fromBlock: STAGING_PREDECESSOR.fromBlock,
      toBlock: currentBlock,
      topics: [policyLifecycleTopics],
    }),
    ethers.provider.getLogs({
      address: policy.address,
      fromBlock: STAGING_PREDECESSOR.fromBlock,
      toBlock: currentBlock,
      topics: [
        ethers.utils.id("ChargebackEnabledUpdated(address,uint256,bool)"),
      ],
    }),
    ethers.provider.getLogs({
      address: policy.address,
      fromBlock: STAGING_PREDECESSOR.fromBlock,
      toBlock: currentBlock,
      topics: [
        ethers.utils.id("LifecycleHookAuthorizationUpdated(address,bool)"),
      ],
    }),
    ethers.provider.getLogs({
      address: nullifierRegistry.address,
      fromBlock: STAGING_PREDECESSOR.fromBlock,
      toBlock: currentBlock,
      topics: [ethers.utils.id("NullifierAdded(bytes32,address)")],
    }),
    contracts.orchestrator.queryFilter(
      contracts.orchestrator.filters.IntentSignaled(),
      STAGING_PREDECESSOR.orchestratorFromBlock,
      currentBlock
    ),
  ]);
  if (policyLifecycleLogs.length !== 0) {
    throw new Error("Staging predecessor policy has lifecycle activity");
  }
  const retiredSetting = STAGING_PREDECESSOR.retiredDepositSetting;
  const normalizedSettingLogs = chargebackEnabledLogs.map((log) => {
    const decoded = chargebackEnabledInterface.parseLog(log);
    return {
      escrow: decoded.args.escrow as string,
      depositId: decoded.args.depositId.toNumber(),
      isEnabled: decoded.args.isChargebackEnabled as boolean,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    };
  });
  const retiredEscrow = await ethers.getContractAt(
    "EscrowV2",
    retiredSetting.escrow
  );
  const retiredDeposit = await retiredEscrow.getDeposit(
    retiredSetting.depositId
  );
  const retiredPaymentMethods = await retiredEscrow.getDepositPaymentMethods(
    retiredSetting.depositId
  );
  const retiredIntentHashes = await retiredEscrow.getDepositIntentHashes(
    retiredSetting.depositId
  );
  const closedEvents = await retiredEscrow.queryFilter(
    retiredEscrow.filters.DepositClosed(),
    retiredSetting.events[retiredSetting.events.length - 1].blockNumber,
    currentBlock
  );
  const matchingClose: any = closedEvents.find(
    (event: any) =>
      event.args?.depositId?.eq(retiredSetting.depositId) &&
      event.blockNumber === retiredSetting.closedBlockNumber &&
      event.transactionHash.toLowerCase() ===
        retiredSetting.closedTransactionHash
  );
  assertStagingRetiredDepositSettingEvidence(normalizedSettingLogs, {
    canonicalEscrow: expectedEscrowV2,
    allZeroDeposit:
      sameAddress(retiredDeposit.depositor, ethers.constants.AddressZero) &&
      sameAddress(retiredDeposit.delegate, ethers.constants.AddressZero) &&
      sameAddress(retiredDeposit.token, ethers.constants.AddressZero) &&
      retiredDeposit.intentAmountRange.min.isZero() &&
      retiredDeposit.intentAmountRange.max.isZero() &&
      !retiredDeposit.acceptingIntents &&
      retiredDeposit.remainingDeposits.isZero() &&
      retiredDeposit.outstandingIntentAmount.isZero() &&
      sameAddress(
        retiredDeposit.intentGuardian,
        ethers.constants.AddressZero
      ) &&
      !retiredDeposit.retainOnEmpty,
    depositCounterGreater: (await retiredEscrow.depositCounter()).gt(
      retiredSetting.depositId
    ),
    paymentMethodsEmpty: retiredPaymentMethods.length === 0,
    intentHashesEmpty: retiredIntentHashes.length === 0,
    closedBlockNumber: matchingClose?.blockNumber,
    closedTransactionHash: matchingClose?.transactionHash,
  });
  const authorization = new Map<string, boolean>();
  for (const log of authorizationLogs) {
    const decoded = authorizationInterface.parseLog(log);
    authorization.set(
      decoded.args.hook.toLowerCase(),
      decoded.args.isAuthorized
    );
  }
  const activeHooks = [...authorization.entries()]
    .filter(([, isAuthorized]) => isAuthorized)
    .map(([authorizedHook]) => authorizedHook);
  if (
    activeHooks.length !== 1 ||
    activeHooks[0] !== STAGING_PREDECESSOR.hook.address.toLowerCase()
  ) {
    throw new Error("Staging predecessor has unexpected authorized hooks");
  }
  if (nullifierLogs.length !== 0) {
    throw new Error(
      "Staging predecessor registry has dispute nullifier activity"
    );
  }
  if (!(await contracts.orchestrator.intentCounter()).eq(signaledLogs.length)) {
    throw new Error(
      "Staging OrchestratorV3 intent event history is incomplete"
    );
  }
  for (const log of signaledLogs) {
    const intentHash = log.args?.intentHash || log.args?.[0];
    if (!intentHash) throw new Error("Unable to decode staging intent hash");
    if (
      !sameAddress(
        await contracts.orchestrator.getIntentLifecycleHook(intentHash),
        ethers.constants.AddressZero
      )
    ) {
      throw new Error(`Staging predecessor still owns intent ${intentHash}`);
    }
  }
  console.log(
    `=== Staging predecessor drained through block ${currentBlock} ===`
  );
}

export async function assertFreshStackUnusedBeforeActivation(
  hre: HardhatRuntimeEnvironment,
  deployments: Record<string, any>,
  contracts: Awaited<ReturnType<typeof getStackContracts>>
): Promise<void> {
  const deploymentBlocks = STACK_DEPLOYMENT_NAMES.map(
    (name) => deployments[name].receipt?.blockNumber
  );
  if (
    deploymentBlocks.some(
      (blockNumber) =>
        typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber)
    )
  ) {
    throw new Error("Fresh dispute artifacts lack deployment-block evidence");
  }
  const fromBlock = Math.min(...(deploymentBlocks as number[]));
  const currentBlock = await ethers.provider.getBlockNumber();
  const policyLifecycleTopics = [
    "DisputeProtectionIntentOpened(bytes32,address,address,address,bytes32,uint256,uint64)",
    "DisputeProtectionIntentCancelled(bytes32,address,uint256)",
    "DisputeProtectionIntentSettled(bytes32,address,address,uint256,uint64,bool)",
    "DisputeProtectionIntentReleased(bytes32,address,uint256)",
    "DisputeResolved(bytes32,address,address,uint256,bytes32)",
    "DisputeProtectionEnabledUpdated(address,uint256,bool)",
  ].map(ethers.utils.id);
  const vaultFinancialTopics = [
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
  const [policyLogs, nullifierLogs, vaultLogs] = await Promise.all([
    ethers.provider.getLogs({
      address: contracts.disputeProtectionPolicy.address,
      fromBlock,
      toBlock: currentBlock,
      topics: [policyLifecycleTopics],
    }),
    ethers.provider.getLogs({
      address: contracts.disputeNullifierRegistry.address,
      fromBlock,
      toBlock: currentBlock,
      topics: [ethers.utils.id("NullifierAdded(bytes32,address)")],
    }),
    ethers.provider.getLogs({
      address: contracts.vault.address,
      fromBlock,
      toBlock: currentBlock,
      topics: [vaultFinancialTopics],
    }),
  ]);
  if (policyLogs.length !== 0 || nullifierLogs.length !== 0) {
    throw new Error(
      "Fresh dispute stack has pre-activation lifecycle activity"
    );
  }
  if (vaultLogs.length !== 0) {
    throw new Error("Fresh StakeVault has pre-activation financial activity");
  }
  const stakeTokenAddress =
    USDC[hre.deployments.getNetworkName()] ||
    (await hre.deployments.get("USDCMock")).address;
  const stakeToken = new ethers.Contract(
    stakeTokenAddress,
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider
  );
  const balances = await Promise.all([
    contracts.vault.totalStaked(),
    contracts.vault.totalClaimable(),
    contracts.vault.totalAccounted(),
    contracts.vault.unaccountedBalance(),
    stakeToken.balanceOf(contracts.vault.address),
  ]);
  if (balances.some((balance) => !balance.isZero())) {
    throw new Error("Fresh StakeVault is not empty before activation");
  }
}

async function assertOnlyExpectedLifecycleHookAuthorized(
  deployments: Record<string, any>,
  contracts: Awaited<ReturnType<typeof getStackContracts>>,
  requireExpected: boolean
): Promise<void> {
  const fromBlock = deployments.DisputeProtectionPolicy.receipt?.blockNumber;
  if (typeof fromBlock !== "number" || !Number.isSafeInteger(fromBlock)) {
    throw new Error("DisputeProtectionPolicy lacks deployment-block evidence");
  }
  const logs = await contracts.disputeProtectionPolicy.queryFilter(
    contracts.disputeProtectionPolicy.filters.LifecycleHookAuthorizationUpdated(),
    fromBlock,
    await ethers.provider.getBlockNumber()
  );
  const authorization = new Map<string, boolean>();
  for (const log of logs) {
    const hook = log.args?.hook || log.args?.[0];
    const isAuthorized = log.args?.isAuthorized ?? log.args?.[1];
    if (!hook || typeof isAuthorized !== "boolean") {
      throw new Error("Unable to decode lifecycle-hook authorization history");
    }
    authorization.set(hook.toLowerCase(), isAuthorized);
  }
  const activeHooks = [...authorization.entries()]
    .filter(([, isAuthorized]) => isAuthorized)
    .map(([hook]) => hook);
  const expectedHook = contracts.hook.address.toLowerCase();
  if (
    activeHooks.some((hook) => hook !== expectedHook) ||
    (requireExpected &&
      (activeHooks.length !== 1 || activeHooks[0] !== expectedHook))
  ) {
    throw new Error(
      "DisputeProtectionPolicy has an unexpected authorized hook"
    );
  }
}

async function assertStackDependenciesAreResumable(
  hre: HardhatRuntimeEnvironment,
  deployments: Record<string, any>
): Promise<Awaited<ReturnType<typeof getStackContracts>>> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const stakeTokenAddress =
    USDC[network] || (await hre.deployments.get("USDCMock")).address;
  const orchestratorRegistryAddress = (
    await hre.deployments.get("OrchestratorRegistry")
  ).address;
  const whitelistPolicyAddress = (await hre.deployments.get("WhitelistPolicy"))
    .address;
  const nullifierRegistryV2Address = (
    await hre.deployments.get("NullifierRegistryV2")
  ).address;
  const attestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));
  await assertExpectedAttestationVerifier(hre, attestationVerifier, governance);
  const contracts = await getStackContracts(hre, deployments);

  for (const name of STACK_DEPLOYMENT_NAMES) {
    await assertDeploymentRuntime(hre, deployments[name], name);
  }
  await assertOnlyExpectedLifecycleHookAuthorized(
    deployments,
    contracts,
    false
  );
  await assertExpectedOrchestrator(hre, contracts);
  if (
    !sameAddress(
      await contracts.disputeVerifier.nullifierRegistry(),
      nullifierRegistryV2Address
    ) ||
    !sameAddress(
      await contracts.disputeVerifier.attestationVerifier(),
      attestationVerifier.address
    )
  ) {
    throw new Error("DisputeVerifier constructor dependency mismatch");
  }
  if (
    !sameAddress(await contracts.vault.stakeToken(), stakeTokenAddress) ||
    !(await contracts.vault.controllerChangeDelay()).eq(
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY
    ) ||
    !sameAddress(
      await contracts.vault.pendingController(),
      ethers.constants.AddressZero
    ) ||
    !(await contracts.vault.pendingControllerValidAt()).isZero()
  ) {
    throw new Error("StakeVault constructor dependency mismatch");
  }
  const currentController = await contracts.vault.controller();
  if (
    !sameAddress(currentController, ethers.constants.AddressZero) &&
    !sameAddress(currentController, contracts.disputeProtectionPolicy.address)
  ) {
    throw new Error("StakeVault has an unexpected controller");
  }
  if (
    (await contracts.disputeProtectionPolicy.admissionsPaused()) ||
    !sameAddress(
      await contracts.disputeProtectionPolicy.stakeVault(),
      contracts.vault.address
    ) ||
    !sameAddress(
      await contracts.disputeProtectionPolicy.disputeVerifier(),
      contracts.disputeVerifier.address
    ) ||
    !sameAddress(
      await contracts.disputeProtectionPolicy.disputeNullifierRegistry(),
      contracts.disputeNullifierRegistry.address
    )
  ) {
    throw new Error("DisputeProtectionPolicy constructor dependency mismatch");
  }
  if (
    !sameAddress(
      await contracts.hook.orchestratorRegistry(),
      orchestratorRegistryAddress
    ) ||
    !sameAddress(
      await contracts.hook.whitelistPolicy(),
      whitelistPolicyAddress
    ) ||
    !sameAddress(
      await contracts.hook.disputeProtectionPolicy(),
      contracts.disputeProtectionPolicy.address
    )
  ) {
    throw new Error("IntentLifecycleHookV1 constructor dependency mismatch");
  }

  const registryOwner = await contracts.disputeNullifierRegistry.owner();
  if (
    !sameAddress(registryOwner, deployer) &&
    !sameAddress(registryOwner, governance)
  ) {
    throw new Error("DisputeNullifierRegistry has an unexpected owner");
  }
  for (const contract of [
    contracts.disputeVerifier,
    contracts.vault,
    contracts.disputeProtectionPolicy,
  ]) {
    const owner = await contract.owner();
    if (!sameAddress(owner, deployer) && !sameAddress(owner, governance)) {
      throw new Error(`Unexpected owner on ${contract.address}`);
    }
    const pendingOwner = await contract.pendingOwner();
    if (
      !sameAddress(pendingOwner, ethers.constants.AddressZero) &&
      !sameAddress(pendingOwner, governance)
    ) {
      throw new Error(`Unexpected pending owner on ${contract.address}`);
    }
  }
  const writers: string[] =
    await contracts.disputeNullifierRegistry.getWriters();
  if (
    writers.length > 1 ||
    (writers.length === 1 &&
      !sameAddress(writers[0], contracts.disputeProtectionPolicy.address))
  ) {
    throw new Error("DisputeNullifierRegistry has an unexpected writer");
  }
  const disputableMethods = new Set(DISPUTABLE_PAYMENT_METHODS);
  for (const methodName of ACTIVE_PAYMENT_METHODS) {
    const riskWindow = await contracts.disputeProtectionPolicy.getRiskWindow(
      paymentMethodHash(methodName)
    );
    const expectedRiskWindow = disputableMethods.has(methodName)
      ? DISPUTE_RISK_WINDOW[network]
      : ethers.constants.Zero;
    if (!riskWindow.isZero() && !riskWindow.eq(expectedRiskWindow)) {
      throw new Error(`Unexpected resumable risk window for ${methodName}`);
    }
  }
  return contracts;
}

async function assertStackConfiguration(
  hre: HardhatRuntimeEnvironment,
  deployments: Record<string, any>
): Promise<Awaited<ReturnType<typeof getStackContracts>>> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const stakeTokenAddress =
    USDC[network] || (await hre.deployments.get("USDCMock")).address;
  const orchestratorRegistryAddress = (
    await hre.deployments.get("OrchestratorRegistry")
  ).address;
  const whitelistPolicyAddress = (await hre.deployments.get("WhitelistPolicy"))
    .address;
  const nullifierRegistryV2Address = (
    await hre.deployments.get("NullifierRegistryV2")
  ).address;
  const attestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));
  await assertExpectedAttestationVerifier(hre, attestationVerifier, governance);
  const contracts = await getStackContracts(hre, deployments);

  for (const name of STACK_DEPLOYMENT_NAMES) {
    await assertDeploymentRuntime(hre, deployments[name], name);
  }
  await assertOnlyExpectedLifecycleHookAuthorized(deployments, contracts, true);
  await assertExpectedOrchestrator(hre, contracts);
  if (
    !sameAddress(
      await contracts.disputeVerifier.nullifierRegistry(),
      nullifierRegistryV2Address
    )
  ) {
    throw new Error("DisputeVerifier nullifier registry mismatch");
  }
  if (
    !sameAddress(
      await contracts.disputeVerifier.attestationVerifier(),
      attestationVerifier.address
    )
  ) {
    throw new Error("DisputeVerifier attestation verifier mismatch");
  }
  if (!sameAddress(await contracts.vault.stakeToken(), stakeTokenAddress)) {
    throw new Error("StakeVault token mismatch");
  }
  if (
    !sameAddress(
      await contracts.vault.controller(),
      contracts.disputeProtectionPolicy.address
    ) ||
    !sameAddress(
      await contracts.vault.pendingController(),
      ethers.constants.AddressZero
    ) ||
    !(await contracts.vault.pendingControllerValidAt()).isZero()
  ) {
    throw new Error("StakeVault controller mismatch");
  }
  if (
    !(await contracts.vault.controllerChangeDelay()).eq(
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY
    )
  ) {
    throw new Error("StakeVault controller change delay mismatch");
  }
  if (
    (await contracts.disputeProtectionPolicy.admissionsPaused()) ||
    !sameAddress(
      await contracts.disputeProtectionPolicy.stakeVault(),
      contracts.vault.address
    )
  ) {
    throw new Error("DisputeProtectionPolicy vault mismatch");
  }
  if (
    !sameAddress(
      await contracts.disputeProtectionPolicy.disputeVerifier(),
      contracts.disputeVerifier.address
    )
  ) {
    throw new Error("DisputeProtectionPolicy verifier mismatch");
  }
  if (
    !sameAddress(
      await contracts.disputeProtectionPolicy.disputeNullifierRegistry(),
      contracts.disputeNullifierRegistry.address
    )
  ) {
    throw new Error("DisputeProtectionPolicy dispute registry mismatch");
  }
  if (
    !(await contracts.disputeProtectionPolicy.isLifecycleHookAuthorized(
      contracts.hook.address
    ))
  ) {
    throw new Error(
      "IntentLifecycleHookV1 is not authorized by DisputeProtectionPolicy"
    );
  }
  const writers: string[] =
    await contracts.disputeNullifierRegistry.getWriters();
  if (
    writers.length !== 1 ||
    !sameAddress(writers[0], contracts.disputeProtectionPolicy.address)
  ) {
    throw new Error(
      "DisputeNullifierRegistry writers must contain only DisputeProtectionPolicy"
    );
  }
  if (
    !sameAddress(
      await contracts.hook.orchestratorRegistry(),
      orchestratorRegistryAddress
    )
  ) {
    throw new Error("IntentLifecycleHookV1 orchestrator registry mismatch");
  }
  if (
    !sameAddress(await contracts.hook.whitelistPolicy(), whitelistPolicyAddress)
  ) {
    throw new Error("IntentLifecycleHookV1 whitelist policy mismatch");
  }
  if (
    !sameAddress(
      await contracts.hook.disputeProtectionPolicy(),
      contracts.disputeProtectionPolicy.address
    )
  ) {
    throw new Error("IntentLifecycleHookV1 dispute policy mismatch");
  }

  const disputableMethods = new Set(DISPUTABLE_PAYMENT_METHODS);
  for (const methodName of ACTIVE_PAYMENT_METHODS) {
    const actualRiskWindow =
      await contracts.disputeProtectionPolicy.getRiskWindow(
        paymentMethodHash(methodName)
      );
    const expectedRiskWindow = disputableMethods.has(methodName)
      ? DISPUTE_RISK_WINDOW[network]
      : ethers.constants.Zero;
    if (!actualRiskWindow.eq(expectedRiskWindow)) {
      throw new Error(`Unexpected dispute risk window for ${methodName}`);
    }
  }
  return contracts;
}

async function assertNoPendingGovernanceTakeovers(
  governance: string,
  contracts: Awaited<ReturnType<typeof getStackContracts>>
): Promise<void> {
  for (const contract of [
    contracts.disputeVerifier,
    contracts.vault,
    contracts.disputeProtectionPolicy,
  ]) {
    if (
      sameAddress(await contract.owner(), governance) &&
      !sameAddress(await contract.pendingOwner(), ethers.constants.AddressZero)
    ) {
      throw new Error(
        `Governance-owned contract has a pending ownership takeover: ${contract.address}`
      );
    }
  }
}

export async function disputeStackReady(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const deployments = await getStackDeployments(hre, true);
  if (!completeStackExists(deployments)) return false;
  await assertExpectedNetworkDependencies(hre);
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const contracts = await assertStackConfiguration(hre, deployments);
  await assertNoPendingGovernanceTakeovers(governance, contracts);

  if (
    !sameAddress(await contracts.disputeNullifierRegistry.owner(), governance)
  )
    return false;
  if (!sameAddress(await contracts.disputeVerifier.owner(), governance))
    return false;
  if (!sameAddress(await contracts.vault.owner(), governance)) return false;
  if (!sameAddress(await contracts.disputeProtectionPolicy.owner(), governance))
    return false;
  return sameAddress(
    await contracts.orchestrator.lifecycleHook(),
    contracts.hook.address
  );
}

export async function disputeStackPrepared(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const deployments = await getStackDeployments(hre, true);
  if (!completeStackExists(deployments)) return false;
  await assertExpectedNetworkDependencies(hre);
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const contracts = await assertStackConfiguration(hre, deployments);
  await assertOrchestratorStillOnPredecessor(hre, contracts);
  await assertNoPendingGovernanceTakeovers(governance, contracts);

  return (
    sameAddress(await contracts.disputeNullifierRegistry.owner(), governance) &&
    sameAddress(await contracts.disputeVerifier.owner(), governance) &&
    sameAddress(await contracts.vault.owner(), governance) &&
    sameAddress(await contracts.disputeProtectionPolicy.owner(), governance)
  );
}

export function stagingDisputeActivationRequested(
  stackWasPreparedAtStart: boolean
): boolean {
  const requested = process.env.ENABLE_STAGING_V3_DISPUTE_ACTIVATION === "true";
  if (!requested) return false;
  if (!stackWasPreparedAtStart) {
    throw new Error(
      "Base staging dispute activation requires a prior completed deploy-only run so fresh addresses can be reviewed and propagated downstream"
    );
  }
  if (process.env.CONFIRM_STAGING_V3_DISPUTE_DOWNSTREAM_READY !== "true") {
    throw new Error(
      "Base staging dispute activation requires CONFIRM_STAGING_V3_DISPUTE_DOWNSTREAM_READY=true"
    );
  }
  if (process.env.CONFIRM_STAGING_V3_DISPUTE_PREDECESSOR_DRAINED !== "true") {
    throw new Error(
      "Base staging dispute activation requires CONFIRM_STAGING_V3_DISPUTE_PREDECESSOR_DRAINED=true"
    );
  }
  return true;
}

async function assertStackPreparedForGovernance(
  governance: string,
  contracts: Awaited<ReturnType<typeof getStackContracts>>
): Promise<void> {
  if (
    !sameAddress(await contracts.disputeNullifierRegistry.owner(), governance)
  ) {
    throw new Error(
      "DisputeNullifierRegistry ownership transfer did not complete"
    );
  }
  for (const contract of [
    contracts.disputeVerifier,
    contracts.vault,
    contracts.disputeProtectionPolicy,
  ]) {
    const owner = await contract.owner();
    const pendingOwner = await contract.pendingOwner();
    if (sameAddress(owner, governance)) {
      if (!sameAddress(pendingOwner, ethers.constants.AddressZero)) {
        throw new Error(
          `Governance-owned contract has a pending ownership takeover: ${contract.address}`
        );
      }
    } else {
      if (!sameAddress(pendingOwner, governance)) {
        throw new Error(
          `Ownership is neither held nor pending for governance on ${contract.address}`
        );
      }
      const acceptData =
        contract.interface.encodeFunctionData("acceptOwnership");
      if (!safeBatchCollector.hasQueued(contract.address, acceptData)) {
        throw new Error(
          `Missing Safe acceptOwnership call for ${contract.address}`
        );
      }
    }
  }

  if (
    !sameAddress(
      await contracts.orchestrator.lifecycleHook(),
      contracts.hook.address
    )
  ) {
    const activationData = contracts.orchestrator.interface.encodeFunctionData(
      "setLifecycleHook",
      [contracts.hook.address]
    );
    if (
      !safeBatchCollector.hasQueued(
        contracts.orchestrator.address,
        activationData
      )
    ) {
      throw new Error("Missing Safe lifecycle-hook activation call");
    }
  }
}

async function activateLifecycleHook(
  hre: HardhatRuntimeEnvironment,
  orchestrator: any,
  hookAddress: string
): Promise<void> {
  if (sameAddress(await orchestrator.lifecycleHook(), hookAddress)) return;
  const owner = await orchestrator.owner();
  const activationData = orchestrator.interface.encodeFunctionData(
    "setLifecycleHook",
    [hookAddress]
  );
  if (
    (await hre.getUnnamedAccounts()).some((account) =>
      sameAddress(account, owner)
    )
  ) {
    await (await orchestrator.setLifecycleHook(hookAddress)).wait();
    await waitForDeploymentDelay(hre);
  } else {
    safeBatchCollector.add(
      orchestrator.address,
      activationData,
      `OrchestratorV3.setLifecycleHook(${hookAddress})`
    );
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  await assertExpectedNetworkDependencies(hre);
  await assertOrchestratorPreflight(hre);
  if (!(await paymentBindingCutoverReady(hre))) {
    throw new Error(
      "V3 payment binding must be fully cut over before the dispute stack is deployed"
    );
  }
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const safeTransactionsBefore = safeBatchCollector.count();
  const stakeTokenAddress =
    USDC[network] || (await hre.deployments.get("USDCMock")).address;
  const orchestratorRegistryAddress = (
    await hre.deployments.get("OrchestratorRegistry")
  ).address;
  const whitelistPolicyAddress = (await hre.deployments.get("WhitelistPolicy"))
    .address;
  const nullifierRegistryV2Address = (
    await hre.deployments.get("NullifierRegistryV2")
  ).address;
  const attestationVerifier =
    (await hre.deployments.getOrNull("MultiAttestationVerifier")) ||
    (await hre.deployments.get("SimpleAttestationVerifier"));
  await assertExpectedAttestationVerifier(hre, attestationVerifier, governance);

  await assertCode(orchestratorRegistryAddress, "OrchestratorRegistry");
  await assertCode(whitelistPolicyAddress, "WhitelistPolicy");
  await assertCode(nullifierRegistryV2Address, "NullifierRegistryV2");
  await assertCode(attestationVerifier.address, "AttestationVerifier");

  let deployments = await getStackDeployments(hre, true);
  await assertPartialStackIsResumable(hre, deployments);
  const stackExistedAtStart = completeStackExists(deployments);
  let stagingStackWasPreparedAtStart = false;
  if (
    network === "base_staging" &&
    process.env.ENABLE_STAGING_V3_DISPUTE_ACTIVATION === "true" &&
    stackExistedAtStart
  ) {
    stagingStackWasPreparedAtStart = await disputeStackPrepared(hre);
  }
  const activateNow =
    network === "base_staging"
      ? stagingDisputeActivationRequested(stagingStackWasPreparedAtStart)
      : true;
  if (
    network === "base_staging" &&
    !stackExistedAtStart &&
    process.env.ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT !== "true"
  ) {
    throw new Error(
      "Base staging dispute deployment or partial-deployment resume requires ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT=true"
    );
  }
  if (
    network === "base" &&
    !stackExistedAtStart &&
    process.env.ENABLE_BASE_V3_DISPUTE_DEPLOYMENT !== "true"
  ) {
    throw new Error(
      "Base dispute deployment or partial-deployment resume requires ENABLE_BASE_V3_DISPUTE_DEPLOYMENT=true"
    );
  }

  const deployMissing = async (
    name: string,
    options: Record<string, unknown>
  ): Promise<any> => {
    const existing = await hre.deployments.getOrNull(name);
    if (existing) {
      await assertDeploymentRuntime(
        hre,
        existing,
        name as (typeof STACK_DEPLOYMENT_NAMES)[number]
      );
      return existing;
    }
    const deployment = await hre.deployments.deploy(name, options as any);
    if (!deployment.newlyDeployed) {
      throw new Error(`${name} was neither persisted nor freshly deployed`);
    }
    await waitForDeploymentDelay(hre);
    await assertPartialStackIsResumable(
      hre,
      await getStackDeployments(hre, true)
    );
    return deployment;
  };

  if (!stackExistedAtStart) {
    const disputeNullifierRegistry = await deployMissing(
      "DisputeNullifierRegistry",
      {
        contract: "NullifierRegistry",
        from: deployer,
        args: [],
        log: true,
      }
    );
    const disputeVerifier = await deployMissing("DisputeVerifier", {
      from: deployer,
      args: [deployer, nullifierRegistryV2Address, attestationVerifier.address],
      log: true,
    });
    const vault = await deployMissing("StakeVault", {
      from: deployer,
      args: [
        deployer,
        stakeTokenAddress,
        ethers.constants.AddressZero,
        STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
      ],
      log: true,
    });
    const disputeProtectionPolicy = await deployMissing(
      "DisputeProtectionPolicy",
      {
        from: deployer,
        args: [
          deployer,
          vault.address,
          disputeVerifier.address,
          disputeNullifierRegistry.address,
        ],
        log: true,
      }
    );
    await deployMissing("IntentLifecycleHookV1", {
      from: deployer,
      args: [
        orchestratorRegistryAddress,
        whitelistPolicyAddress,
        disputeProtectionPolicy.address,
      ],
      log: true,
    });
    deployments = await getStackDeployments(hre);
    if (!deployments)
      throw new Error(
        "Complete dispute deployment artifacts were not persisted"
      );
  }

  if (!deployments || !completeStackExists(deployments)) {
    throw new Error(
      "Dispute deployment resume did not produce a complete stack"
    );
  }
  const contracts = await assertStackDependenciesAreResumable(hre, deployments);
  await assertOrchestratorStillOnPredecessor(hre, contracts);
  await assertFreshStackUnusedBeforeActivation(hre, deployments, contracts);
  if (activateNow) {
    await assertStagingPredecessorDrained(hre, contracts);
  }
  if (
    sameAddress(
      await contracts.vault.controller(),
      ethers.constants.AddressZero
    )
  ) {
    await (
      await contracts.vault.initializeController(
        contracts.disputeProtectionPolicy.address
      )
    ).wait();
    await waitForDeploymentDelay(hre);
  }
  await addWritePermission(
    hre,
    contracts.disputeNullifierRegistry,
    contracts.disputeProtectionPolicy.address
  );
  if (
    !(await contracts.disputeProtectionPolicy.isLifecycleHookAuthorized(
      contracts.hook.address
    ))
  ) {
    await (
      await contracts.disputeProtectionPolicy.setLifecycleHookAuthorization(
        contracts.hook.address,
        true
      )
    ).wait();
    await waitForDeploymentDelay(hre);
  }
  for (const methodName of DISPUTABLE_PAYMENT_METHODS) {
    const paymentMethod = paymentMethodHash(methodName);
    if (
      !(
        await contracts.disputeProtectionPolicy.getRiskWindow(paymentMethod)
      ).eq(DISPUTE_RISK_WINDOW[network])
    ) {
      await (
        await contracts.disputeProtectionPolicy.setRiskWindow(
          paymentMethod,
          DISPUTE_RISK_WINDOW[network]
        )
      ).wait();
      await waitForDeploymentDelay(hre);
    }
  }

  await assertStackConfiguration(hre, deployments);
  await setNewOwner(hre, contracts.disputeNullifierRegistry, governance);
  for (const contract of [
    contracts.disputeVerifier,
    contracts.vault,
    contracts.disputeProtectionPolicy,
  ]) {
    await setNewOwner(hre, contract, governance);
    await setNewOwner(hre, contract, governance);
  }
  if (activateNow) {
    await activateLifecycleHook(
      hre,
      contracts.orchestrator,
      contracts.hook.address
    );
  }

  const queuedSafeTransactions =
    safeBatchCollector.count() - safeTransactionsBefore;
  if (queuedSafeTransactions > 0) {
    await assertStackPreparedForGovernance(governance, contracts);
    if (network === "base" && queuedSafeTransactions !== 4) {
      throw new Error(
        `Fresh Base dispute preparation must queue exactly 4 calls, queued ${queuedSafeTransactions}`
      );
    }
    console.log(
      "=== Fresh dispute lifecycle stack deployed; Safe activation batch prepared ==="
    );
  } else if (activateNow && !(await disputeStackReady(hre))) {
    throw new Error(
      "Dispute lifecycle stack deployment and activation verification failed"
    );
  } else if (!activateNow && !(await disputeStackPrepared(hre))) {
    throw new Error("Dispute lifecycle stack preparation verification failed");
  } else if (!activateNow) {
    console.log(
      "=== Fresh dispute lifecycle stack deployed and prepared; activation remains gated ==="
    );
  } else {
    console.log("=== Fresh dispute lifecycle stack deployed and activated ===");
  }
  console.log(
    "DisputeNullifierRegistry:",
    contracts.disputeNullifierRegistry.address
  );
  console.log("DisputeVerifier:", contracts.disputeVerifier.address);
  console.log("StakeVault:", contracts.vault.address);
  console.log(
    "DisputeProtectionPolicy:",
    contracts.disputeProtectionPolicy.address
  );
  console.log("IntentLifecycleHookV1:", contracts.hook.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (await disputeStackReady(hre)) {
    if (!(await paymentBindingCutoverReady(hre))) {
      throw new Error(
        "Dispute stack is active while the V3 payment binding is not cut over"
      );
    }
    return true;
  }
  if (network === "base") {
    return process.env.ENABLE_BASE_V3_DISPUTE_DEPLOYMENT !== "true";
  }
  if (network === "base_staging") {
    const deployments = await getStackDeployments(hre, true);
    if (!completeStackExists(deployments)) {
      return process.env.ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT !== "true";
    }
    if (process.env.ENABLE_STAGING_V3_DISPUTE_ACTIVATION === "true") {
      return false;
    }
    if (!(await disputeStackPrepared(hre))) {
      throw new Error(
        "Existing Base staging dispute stack is neither prepared nor active"
      );
    }
    return true;
  }
  return false;
};

func.tags = [
  "32_deploy_and_activate_dispute_lifecycle_stack",
  "V3DisputeLifecycleStack",
];
func.dependencies = ["V3PaymentBindingStack"];

export default func;
