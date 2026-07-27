import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  MULTI_SIG,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  CALLBACK_GAS_LIMIT,
} from "../deployments/parameters";
import {
  addEscrowToRegistry,
  addOrchestratorToRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";
import type { WhitelistPolicy__factory } from "../typechain";

async function executeOrQueueGovernanceCall(
  hre: HardhatRuntimeEnvironment,
  contract: any,
  functionName: string,
  args: any[],
  description: string,
): Promise<void> {
  const owner: string = await contract.owner();
  const availableAccounts = (await hre.getUnnamedAccounts()).map((account) => account.toLowerCase());
  const data = contract.interface.encodeFunctionData(functionName, args);

  if (availableAccounts.includes(owner.toLowerCase())) {
    const signer = await ethers.getSigner(owner);
    await (await contract.connect(signer)[functionName](...args)).wait();
    await waitForDeploymentDelay(hre);
    return;
  }

  safeBatchCollector.add(contract.address, data, description);
}

async function systemFullyWired(network: string): Promise<boolean> {
  const registryAddress = getDeployedContractAddress(network, "AddressGroupRegistry");
  const policyAddress = getDeployedContractAddress(network, "WhitelistPolicy");
  const hookAddress = getDeployedContractAddress(network, "IntentLifecycleHookV1");
  const orchestratorAddress = getDeployedContractAddress(network, "OrchestratorV3");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  const policy = await ethers.getContractAt("WhitelistPolicy", policyAddress);
  const hook = await ethers.getContractAt("IntentLifecycleHookV1", hookAddress);
  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorAddress);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);

  // Capability probe for the deposit-scoped policy schema. The currently deployed policy is maker-scoped and
  // exposes enabled(address) rather than enabled(address,uint256), so this call reverts against stale bytecode
  // (argument-count mismatch) and forces hardhat-deploy to process the changed policy/hook wiring.
  await policy.enabled(ethers.constants.AddressZero, 0);

  if ((await policy.groupRegistry()).toLowerCase() !== registryAddress.toLowerCase()) return false;
  if ((await policy.escrowRegistry()).toLowerCase() !== escrowRegistryAddress.toLowerCase()) return false;
  if ((await hook.whitelistPolicy()).toLowerCase() !== policyAddress.toLowerCase()) return false;
  if ((await hook.orchestratorRegistry()).toLowerCase() !== orchestratorRegistryAddress.toLowerCase()) return false;
  if ((await orchestrator.lifecycleHook()).toLowerCase() !== hookAddress.toLowerCase()) return false;
  if (!(await orchestratorRegistry.isOrchestrator(orchestratorAddress))) return false;
  if (!(await escrowRegistry.isWhitelistedEscrow(escrowV2Address))) return false;

  return true;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  console.log("=== Deploying minimal OrchestratorV3 deposit whitelist risk system ===");

  const boundedCall = await deploy("BoundedCall", {
    from: deployer,
    args: [],
  });
  if (boundedCall.newlyDeployed) await waitForDeploymentDelay(hre);

  const postIntentHookExecutor = await deploy("PostIntentHookExecutor", {
    from: deployer,
    args: [],
  });
  if (postIntentHookExecutor.newlyDeployed) await waitForDeploymentDelay(hre);

  const riskSettlementExecutor = await deploy("LifecycleSettlementExecutor", {
    from: deployer,
    libraries: { BoundedCall: boundedCall.address },
    args: [],
  });
  if (riskSettlementExecutor.newlyDeployed) await waitForDeploymentDelay(hre);

  const feeSettlementLib = await deploy("FeeSettlementLib", {
    from: deployer,
    libraries: {
      PostIntentHookExecutor: postIntentHookExecutor.address,
      LifecycleSettlementExecutor: riskSettlementExecutor.address,
    },
    args: [],
  });
  if (feeSettlementLib.newlyDeployed) await waitForDeploymentDelay(hre);

  const orchestratorV3 = await deploy("OrchestratorV3", {
    from: deployer,
    libraries: {
      BoundedCall: boundedCall.address,
      FeeSettlementLib: feeSettlementLib.address,
    },
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      ORCHESTRATOR_V2_PROTOCOL_FEE[network],
      ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network] || deployer,
      CALLBACK_GAS_LIMIT,
    ],
  });
  if (orchestratorV3.newlyDeployed) {
    console.log("OrchestratorV3 deployed at", orchestratorV3.address);
    await waitForDeploymentDelay(hre);
  }

  const addressGroupRegistry = await deploy("AddressGroupRegistry", {
    from: deployer,
    args: [],
  });
  if (addressGroupRegistry.newlyDeployed) {
    console.log("AddressGroupRegistry deployed at", addressGroupRegistry.address);
    await waitForDeploymentDelay(hre);
  }

  const whitelistPolicyArgs: Parameters<WhitelistPolicy__factory["deploy"]> = [
    addressGroupRegistry.address,
    escrowRegistryAddress,
  ];

  const whitelistPolicy = await deploy("WhitelistPolicy", {
    from: deployer,
    args: whitelistPolicyArgs,
  });
  if (whitelistPolicy.newlyDeployed) {
    console.log("WhitelistPolicy deployed at", whitelistPolicy.address);
    await waitForDeploymentDelay(hre);
  }

  const intentLifecycleHook = await deploy("IntentLifecycleHookV1", {
    from: deployer,
    args: [orchestratorRegistryAddress, whitelistPolicy.address],
  });
  if (intentLifecycleHook.newlyDeployed) {
    console.log("IntentLifecycleHookV1 deployed at", intentLifecycleHook.address);
    await waitForDeploymentDelay(hre);
  }

  const orchestratorV3Contract = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  if ((await orchestratorV3Contract.lifecycleHook()).toLowerCase() !== intentLifecycleHook.address.toLowerCase()) {
    await executeOrQueueGovernanceCall(
      hre,
      orchestratorV3Contract,
      "setLifecycleHook",
      [intentLifecycleHook.address],
      `OrchestratorV3.setLifecycleHook(${intentLifecycleHook.address})`,
    );
  }

  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV3.address);
  await addEscrowToRegistry(hre, escrowRegistry, escrowV2Address);

  const whitelistPolicyContract = await ethers.getContractAt("WhitelistPolicy", whitelistPolicy.address);
  await setNewOwner(hre, whitelistPolicyContract, governance);
  await setNewOwner(hre, orchestratorV3Contract, governance);

  console.log("=== Minimal V3 deposit whitelist risk system deployment prepared ===");
  console.log("OrchestratorV3:", orchestratorV3.address);
  console.log("AddressGroupRegistry:", addressGroupRegistry.address);
  console.log("WhitelistPolicy:", whitelistPolicy.address);
  console.log("IntentLifecycleHookV1:", intentLifecycleHook.address);
  console.log("EscrowV2 reused without redeployment:", escrowV2Address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "base") return true;
  if (
    network !== "localhost"
    && network !== "hardhat"
    && network !== "base_staging"
  ) {
    return true;
  }
  if (process.env.FORCE_RERUN_MINIMAL_V3_RISK_SYSTEM === "true") return false;

  try {
    return await systemFullyWired(network);
  } catch {
    return false;
  }
};

func.tags = ["29_deploy_maker_group_risk_system"];
func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
