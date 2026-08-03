import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  MULTI_SIG,
  ORCHESTRATOR_V3_PROTOCOL_FEE,
  ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT,
} from "../deployments/parameters";
import {
  addOrchestratorToRegistry,
  removeOrchestratorFromRegistry,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging"]);
const RETIRED_STAGING_WHITELIST_POLICY = "0xe3d3E798AbF1c021730d951d0589bCa63d9CB3F0";
const RETIRED_STAGING_ORCHESTRATORS = [
  "0xF9CEE6365fB4F6354a19e95d35aaeF877CF1179d",
  "0x1734f5C9956D0DA1f48E27cd1C6167aA81F27869",
];

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function assertCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} has no bytecode: ${address}`);
  }
}

async function systemFullyWired(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  try {
    const network = hre.deployments.getNetworkName();
    const [deployer] = await hre.getUnnamedAccounts();
    const governance = MULTI_SIG[network] || deployer;
    const policyDeployment = await hre.deployments.get("WhitelistPolicy");
    const hookDeployment = await hre.deployments.get("WhitelistLifecycleHook");
    const orchestratorDeployment = await hre.deployments.get("OrchestratorV3");
    const registryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
    const policy = await ethers.getContractAt("WhitelistPolicy", policyDeployment.address);
    const hook = await ethers.getContractAt("WhitelistLifecycleHook", hookDeployment.address);
    const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorDeployment.address);
    const registry = await ethers.getContractAt("OrchestratorRegistry", registryAddress);

    if (!sameAddress(await hook.orchestratorRegistry(), registryAddress)) return false;
    if (!sameAddress(await hook.whitelistPolicy(), policy.address)) return false;
    if (!sameAddress(await orchestrator.lifecycleHook(), hook.address)) return false;
    if (!sameAddress(await orchestrator.owner(), governance)) return false;
    if (!sameAddress(await policy.owner(), governance)) return false;
    if (!(await registry.isOrchestrator(orchestrator.address))) return false;

    if (network === "base_staging") {
      if (sameAddress(policy.address, RETIRED_STAGING_WHITELIST_POLICY)) return false;
      for (const retired of RETIRED_STAGING_ORCHESTRATORS) {
        if (await registry.isOrchestrator(retired)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;

  const policyDeployment = await hre.deployments.get("WhitelistPolicy");
  const existingHook = await hre.deployments.getOrNull("WhitelistLifecycleHook");
  const existingOrchestrator = await hre.deployments.getOrNull("OrchestratorV3");
  if (network === "base_staging" && sameAddress(policyDeployment.address, RETIRED_STAGING_WHITELIST_POLICY)) {
    throw new Error("Move the retired WhitelistPolicy artifact aside so lane 29 deploys a fresh policy");
  }
  if (existingHook || existingOrchestrator) {
    throw new Error(
      "Move the WhitelistLifecycleHook and OrchestratorV3 artifacts aside before the fresh lane-30 cutover",
    );
  }

  const orchestratorRegistryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
  const escrowRegistryAddress = (await hre.deployments.get("EscrowRegistry")).address;
  const paymentVerifierRegistryAddress = (await hre.deployments.get("PaymentVerifierRegistry")).address;
  const relayerRegistryAddress = (await hre.deployments.get("RelayerRegistry")).address;
  const addressGroupRegistryAddress = (await hre.deployments.get("AddressGroupRegistry")).address;

  await assertCode(addressGroupRegistryAddress, "AddressGroupRegistry");
  let unifiedPaymentVerifierV3Address = "not deployed on local rehearsal";
  let nullifierRegistryV2Address = "not deployed on local rehearsal";
  if (network === "base_staging") {
    unifiedPaymentVerifierV3Address = (await hre.deployments.get("UnifiedPaymentVerifierV3")).address;
    nullifierRegistryV2Address = (await hre.deployments.get("NullifierRegistryV2")).address;
    await assertCode(unifiedPaymentVerifierV3Address, "UnifiedPaymentVerifierV3");
    await assertCode(nullifierRegistryV2Address, "NullifierRegistryV2");
  }

  const registry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const registeredPredecessors: string[] = [];
  if (network === "base_staging") {
    for (const retired of RETIRED_STAGING_ORCHESTRATORS) {
      await assertCode(retired, "Retired OrchestratorV3");
      if (await registry.isOrchestrator(retired)) registeredPredecessors.push(retired);
    }
    if (
      registeredPredecessors.length > 0
      && process.env.CONFIRM_STAGING_V3_PREDECESSORS_DRAINED !== "true"
    ) {
      throw new Error(
        "Set CONFIRM_STAGING_V3_PREDECESSORS_DRAINED=true only after the external read-only drain check",
      );
    }
  }

  console.log("=== Deploying whitelist-only V3 groups stack ===");
  console.log("Reusing WhitelistPolicy:", policyDeployment.address);
  console.log("Reusing UnifiedPaymentVerifierV3:", unifiedPaymentVerifierV3Address);
  console.log("Reusing NullifierRegistryV2:", nullifierRegistryV2Address);

  const hookDeployment = await hre.deployments.deploy("WhitelistLifecycleHook", {
    from: deployer,
    args: [orchestratorRegistryAddress, policyDeployment.address],
    log: true,
  });
  if (!hookDeployment.newlyDeployed) throw new Error("WhitelistLifecycleHook was not freshly deployed");
  await waitForDeploymentDelay(hre);

  const orchestratorDeployment = await hre.deployments.deploy("OrchestratorV3", {
    from: deployer,
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      relayerRegistryAddress,
      ORCHESTRATOR_V3_PROTOCOL_FEE[network],
      ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT[network] || deployer,
    ],
    log: true,
  });
  if (!orchestratorDeployment.newlyDeployed) throw new Error("OrchestratorV3 was not freshly deployed");
  await waitForDeploymentDelay(hre);

  const hook = await ethers.getContractAt("WhitelistLifecycleHook", hookDeployment.address);
  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorDeployment.address);
  await (await orchestrator.setLifecycleHook(hook.address)).wait();
  await waitForDeploymentDelay(hre);

  await addOrchestratorToRegistry(hre, registry, orchestrator.address);
  for (const predecessor of registeredPredecessors) {
    await removeOrchestratorFromRegistry(hre, registry, predecessor);
  }
  await setNewOwner(hre, orchestrator, governance);

  if (!sameAddress(await hook.orchestratorRegistry(), registry.address)) {
    throw new Error("WhitelistLifecycleHook registry mismatch");
  }
  if (!sameAddress(await hook.whitelistPolicy(), policyDeployment.address)) {
    throw new Error("WhitelistLifecycleHook policy mismatch");
  }
  if (!sameAddress(await orchestrator.lifecycleHook(), hook.address)) {
    throw new Error("OrchestratorV3 whitelist lifecycle hook mismatch");
  }
  if (!(await registry.isOrchestrator(orchestrator.address))) {
    throw new Error("Fresh OrchestratorV3 is not registered");
  }
  for (const predecessor of registeredPredecessors) {
    if (await registry.isOrchestrator(predecessor)) {
      throw new Error(`Retired OrchestratorV3 remains registered: ${predecessor}`);
    }
  }
  if (!await systemFullyWired(hre)) throw new Error("Whitelist-only V3 groups stack verification failed");

  console.log("=== Whitelist-only V3 groups stack verified ===");
  console.log("WhitelistPolicy:", policyDeployment.address);
  console.log("WhitelistLifecycleHook:", hook.address);
  console.log("OrchestratorV3:", orchestrator.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (await systemFullyWired(hre)) return true;
  if (network === "base_staging" && process.env.ENABLE_STAGING_V3_GROUPS_CUTOVER !== "true") return true;
  return false;
};

func.tags = ["30_deploy_v3_lifecycle_stack", "V3LifecycleStack", "OrchestratorV3"];
func.dependencies = ["29_deploy_whitelist_policy"];

export default func;
