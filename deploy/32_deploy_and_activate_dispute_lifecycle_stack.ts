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

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function paymentMethodHash(name: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
}

async function assertCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} has no bytecode: ${address}`);
  }
}

async function getStackDeployments(
  hre: HardhatRuntimeEnvironment
): Promise<Record<string, any> | null> {
  const entries = await Promise.all(
    STACK_DEPLOYMENT_NAMES.map(
      async (name) => [name, await hre.deployments.getOrNull(name)] as const
    )
  );
  const present = entries.filter(([, deployment]) => deployment != null);
  if (present.length === 0) return null;
  if (present.length !== STACK_DEPLOYMENT_NAMES.length) {
    throw new Error(
      `Partial dispute deployment artifacts found: ${present
        .map(([name]) => name)
        .join(", ")}`
    );
  }
  return Object.fromEntries(entries) as Record<string, any>;
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

async function assertStackConfiguration(
  hre: HardhatRuntimeEnvironment,
  deployments: Record<string, any>
): Promise<Awaited<ReturnType<typeof getStackContracts>>> {
  const network = hre.deployments.getNetworkName();
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
  const contracts = await getStackContracts(hre, deployments);

  for (const name of STACK_DEPLOYMENT_NAMES) {
    await assertCode(deployments[name].address, name);
  }
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
    )
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

async function ownerOrPendingOwnerIs(
  contract: any,
  expectedOwner: string
): Promise<boolean> {
  if (sameAddress(await contract.owner(), expectedOwner)) return true;
  try {
    return sameAddress(await contract.pendingOwner(), expectedOwner);
  } catch {
    return false;
  }
}

export async function disputeStackReady(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const deployments = await getStackDeployments(hre);
  if (!deployments) return false;
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const contracts = await assertStackConfiguration(hre, deployments);

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
    if (!(await ownerOrPendingOwnerIs(contract, governance))) {
      throw new Error(
        `Ownership is neither held nor pending for governance on ${contract.address}`
      );
    }
    if (!sameAddress(await contract.owner(), governance)) {
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

  await assertCode(orchestratorRegistryAddress, "OrchestratorRegistry");
  await assertCode(whitelistPolicyAddress, "WhitelistPolicy");
  await assertCode(nullifierRegistryV2Address, "NullifierRegistryV2");
  await assertCode(attestationVerifier.address, "AttestationVerifier");

  let deployments = await getStackDeployments(hre);
  if (!deployments) {
    const disputeNullifierRegistry = await hre.deployments.deploy(
      "DisputeNullifierRegistry",
      {
        contract: "NullifierRegistry",
        from: deployer,
        args: [],
        log: true,
      }
    );
    if (!disputeNullifierRegistry.newlyDeployed) {
      throw new Error("DisputeNullifierRegistry was not freshly deployed");
    }
    await waitForDeploymentDelay(hre);

    const disputeVerifier = await hre.deployments.deploy("DisputeVerifier", {
      from: deployer,
      args: [deployer, nullifierRegistryV2Address, attestationVerifier.address],
      log: true,
    });
    if (!disputeVerifier.newlyDeployed)
      throw new Error("DisputeVerifier was not freshly deployed");
    await waitForDeploymentDelay(hre);

    const vault = await hre.deployments.deploy("StakeVault", {
      from: deployer,
      args: [
        deployer,
        stakeTokenAddress,
        ethers.constants.AddressZero,
        STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
      ],
      log: true,
    });
    if (!vault.newlyDeployed)
      throw new Error("StakeVault was not freshly deployed");
    await waitForDeploymentDelay(hre);

    const disputeProtectionPolicy = await hre.deployments.deploy(
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
    if (!disputeProtectionPolicy.newlyDeployed) {
      throw new Error("DisputeProtectionPolicy was not freshly deployed");
    }
    await waitForDeploymentDelay(hre);

    const hook = await hre.deployments.deploy("IntentLifecycleHookV1", {
      from: deployer,
      args: [
        orchestratorRegistryAddress,
        whitelistPolicyAddress,
        disputeProtectionPolicy.address,
      ],
      log: true,
    });
    if (!hook.newlyDeployed)
      throw new Error("IntentLifecycleHookV1 was not freshly deployed");
    await waitForDeploymentDelay(hre);
    deployments = await getStackDeployments(hre);
    if (!deployments)
      throw new Error("Fresh dispute deployment artifacts were not persisted");
  }

  const contracts = await getStackContracts(hre, deployments);
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
  await activateLifecycleHook(
    hre,
    contracts.orchestrator,
    contracts.hook.address
  );

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
  } else if (!(await disputeStackReady(hre))) {
    throw new Error(
      "Dispute lifecycle stack deployment and activation verification failed"
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
    return process.env.ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT !== "true";
  }
  return false;
};

func.tags = [
  "32_deploy_and_activate_dispute_lifecycle_stack",
  "V3DisputeLifecycleStack",
];
func.dependencies = ["V3PaymentBindingStack"];

export default func;
