import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  MULTI_SIG,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  RISK_CALLBACK_GAS_LIMIT,
} from "../deployments/parameters";
import {
  addEscrowToRegistry,
  addOrchestratorToRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";

export const CANONICAL_ADDRESS_GROUPS = [
  { id: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("peers")), name: "Peers" },
  { id: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("peer-pluses")), name: "Peer Pluses" },
  { id: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("peer-merchants")), name: "Peer Merchants" },
] as const;

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
  const policyAddress = getDeployedContractAddress(network, "MakerGroupPolicy");
  const hookAddress = getDeployedContractAddress(network, "MakerGroupRiskHook");
  const orchestratorAddress = getDeployedContractAddress(network, "OrchestratorV3");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");

  const registry = await ethers.getContractAt("AddressGroupRegistry", registryAddress);
  const policy = await ethers.getContractAt("MakerGroupPolicy", policyAddress);
  const hook = await ethers.getContractAt("MakerGroupRiskHook", hookAddress);
  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorAddress);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);

  if ((await policy.groupRegistry()).toLowerCase() !== registryAddress.toLowerCase()) return false;
  if ((await hook.makerGroupPolicy()).toLowerCase() !== policyAddress.toLowerCase()) return false;
  if ((await hook.groupRegistry()).toLowerCase() !== registryAddress.toLowerCase()) return false;
  if ((await hook.orchestrator()).toLowerCase() !== orchestratorAddress.toLowerCase()) return false;
  if ((await orchestrator.riskHook()).toLowerCase() !== hookAddress.toLowerCase()) return false;
  if (!(await orchestratorRegistry.isOrchestrator(orchestratorAddress))) return false;
  if (!(await escrowRegistry.isWhitelistedEscrow(escrowV2Address))) return false;

  for (const group of CANONICAL_ADDRESS_GROUPS) {
    if (!(await registry.groupExists(group.id)) || !(await registry.isGroupActive(group.id))) {
      return false;
    }
  }
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

  console.log("=== Deploying minimal OrchestratorV3 maker-group risk system ===");

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

  const riskSettlementExecutor = await deploy("RiskSettlementExecutor", {
    from: deployer,
    libraries: { BoundedCall: boundedCall.address },
    args: [],
  });
  if (riskSettlementExecutor.newlyDeployed) await waitForDeploymentDelay(hre);

  const feeSettlementLib = await deploy("FeeSettlementLib", {
    from: deployer,
    libraries: {
      PostIntentHookExecutor: postIntentHookExecutor.address,
      RiskSettlementExecutor: riskSettlementExecutor.address,
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
      RISK_CALLBACK_GAS_LIMIT,
    ],
  });
  if (orchestratorV3.newlyDeployed) {
    console.log("OrchestratorV3 deployed at", orchestratorV3.address);
    await waitForDeploymentDelay(hre);
  }

  const addressGroupRegistry = await deploy("AddressGroupRegistry", {
    from: deployer,
    args: [deployer],
  });
  if (addressGroupRegistry.newlyDeployed) {
    console.log("AddressGroupRegistry deployed at", addressGroupRegistry.address);
    await waitForDeploymentDelay(hre);
  }

  const registry = await ethers.getContractAt("AddressGroupRegistry", addressGroupRegistry.address);
  for (const group of CANONICAL_ADDRESS_GROUPS) {
    if (!(await registry.groupExists(group.id))) {
      await executeOrQueueGovernanceCall(
        hre,
        registry,
        "registerGroup",
        [group.id, group.name, governance],
        `AddressGroupRegistry.registerGroup(${group.name}, curator=${governance})`,
      );
    }
  }

  const makerGroupPolicy = await deploy("MakerGroupPolicy", {
    from: deployer,
    args: [addressGroupRegistry.address],
  });
  if (makerGroupPolicy.newlyDeployed) {
    console.log("MakerGroupPolicy deployed at", makerGroupPolicy.address);
    await waitForDeploymentDelay(hre);
  }

  const makerGroupRiskHook = await deploy("MakerGroupRiskHook", {
    from: deployer,
    args: [
      orchestratorV3.address,
      makerGroupPolicy.address,
      addressGroupRegistry.address,
    ],
  });
  if (makerGroupRiskHook.newlyDeployed) {
    console.log("MakerGroupRiskHook deployed at", makerGroupRiskHook.address);
    await waitForDeploymentDelay(hre);
  }

  const orchestratorV3Contract = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  if ((await orchestratorV3Contract.riskHook()).toLowerCase() !== makerGroupRiskHook.address.toLowerCase()) {
    await executeOrQueueGovernanceCall(
      hre,
      orchestratorV3Contract,
      "setRiskHook",
      [makerGroupRiskHook.address],
      `OrchestratorV3.setRiskHook(${makerGroupRiskHook.address})`,
    );
  }

  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV3.address);
  await addEscrowToRegistry(hre, escrowRegistry, escrowV2Address);

  await setNewOwner(hre, registry, governance);
  await setNewOwner(hre, orchestratorV3Contract, governance);

  console.log("=== Minimal V3 risk system deployment prepared ===");
  console.log("OrchestratorV3:", orchestratorV3.address);
  console.log("AddressGroupRegistry:", addressGroupRegistry.address);
  console.log("MakerGroupPolicy:", makerGroupPolicy.address);
  console.log("MakerGroupRiskHook:", makerGroupRiskHook.address);
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
