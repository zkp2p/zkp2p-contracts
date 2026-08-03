import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  CHARGEBACK_RISK_WINDOW,
  CHARGEBACKABLE_PAYMENT_METHODS,
  MULTI_SIG,
  ORCHESTRATOR_V3_PROTOCOL_FEE,
  ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import {
  addOrchestratorToRegistry,
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  addWritePermission,
  getDeployedContractAddress,
  removeOrchestratorFromRegistry,
  removePaymentMethodFromRegistry,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base", "base_staging"]);
const OLD_ORCHESTRATOR_V3: Record<string, string> = {
  base_staging: "0x6Db9dDb38a19Be0c614C0Ad9e78Baf73f93c35dF",
};

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function paymentMethodHash(name: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
}

async function systemFullyWired(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  const orchestratorV3 = await hre.deployments.getOrNull("OrchestratorV3");
  const lifecycleHook = await hre.deployments.getOrNull("IntentLifecycleHookV1");
  const chargebackPolicy = await hre.deployments.getOrNull("ChargebackPolicy");
  const stakeVault = await hre.deployments.getOrNull("StakeVault");
  if (!orchestratorV3 || !lifecycleHook || !chargebackPolicy || !stakeVault) return false;

  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const unifiedPaymentVerifierV3Address = getDeployedContractAddress(network, "UnifiedPaymentVerifierV3");

  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    paymentVerifierRegistryAddress,
  );
  const orchestratorV3Contract = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const chargebackPolicyContract = await ethers.getContractAt("ChargebackPolicy", chargebackPolicy.address);

  if (!(await orchestratorRegistry.isOrchestrator(orchestratorV3.address))) return false;

  const oldOrchestratorV3 = OLD_ORCHESTRATOR_V3[network];
  if (oldOrchestratorV3 && (await orchestratorRegistry.isOrchestrator(oldOrchestratorV3))) return false;

  if (!sameAddress(await orchestratorV3Contract.lifecycleHook(), lifecycleHook.address)) return false;
  if (!sameAddress(await stakeVaultContract.controller(), chargebackPolicy.address)) return false;
  if (!(await chargebackPolicyContract.isLifecycleHookAuthorized(lifecycleHook.address))) return false;

  const activePaymentMethods: string[] = await paymentVerifierRegistry.getPaymentMethods();
  const activePaymentMethodSet = new Set(activePaymentMethods);
  for (const methodName of CHARGEBACKABLE_PAYMENT_METHODS) {
    const method = paymentMethodHash(methodName);
    if (
      activePaymentMethodSet.has(method)
      && !(await chargebackPolicyContract.getRiskWindow(method)).eq(CHARGEBACK_RISK_WINDOW[network])
    ) {
      return false;
    }
  }

  for (const method of activePaymentMethods) {
    if (!sameAddress(await paymentVerifierRegistry.getVerifier(method), unifiedPaymentVerifierV3Address)) {
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

  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const legacyNullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
  const multiAttestationVerifierAddress = getDeployedContractAddress(network, "MultiAttestationVerifier");
  const whitelistPolicyAddress = getDeployedContractAddress(network, "WhitelistPolicy");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");
  if (network === "base_staging" && !USDC[network]) {
    throw new Error(`No stake token configured for network ${network}`);
  }
  const stakeTokenAddress = USDC[network] || getDeployedContractAddress(network, "USDCMock");

  console.log("=== Deploying V3 lifecycle stack ===");
  console.log("Reusing EscrowV2:", escrowV2Address);
  console.log("Reusing WhitelistPolicy:", whitelistPolicyAddress);
  console.log("Stake token:", stakeTokenAddress);

  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    paymentVerifierRegistryAddress,
  );
  const activePaymentMethods: Array<{ method: string; currencies: string[]; verifier: string }> = [];
  for (const method of await paymentVerifierRegistry.getPaymentMethods()) {
    activePaymentMethods.push({
      method,
      currencies: await paymentVerifierRegistry.getCurrencies(method),
      verifier: await paymentVerifierRegistry.getVerifier(method),
    });
  }

  let nullifierRegistryV2 = await hre.deployments.getOrNull("NullifierRegistryV2");
  let nullifierRegistryV2NewlyDeployed = false;
  if (!nullifierRegistryV2) {
    const deployment = await deploy("NullifierRegistryV2", {
      from: deployer,
      args: [legacyNullifierRegistryAddress],
      log: true,
    });
    nullifierRegistryV2 = deployment;
    nullifierRegistryV2NewlyDeployed = deployment.newlyDeployed;
    if (nullifierRegistryV2NewlyDeployed) {
      await waitForDeploymentDelay(hre);
    }
  }

  let unifiedPaymentVerifierV3 = await hre.deployments.getOrNull("UnifiedPaymentVerifierV3");
  let unifiedPaymentVerifierV3NewlyDeployed = false;
  if (!unifiedPaymentVerifierV3) {
    const deployment = await deploy("UnifiedPaymentVerifierV3", {
      from: deployer,
      args: [
        orchestratorRegistryAddress,
        nullifierRegistryV2.address,
        multiAttestationVerifierAddress,
      ],
      log: true,
    });
    unifiedPaymentVerifierV3 = deployment;
    unifiedPaymentVerifierV3NewlyDeployed = deployment.newlyDeployed;
    if (unifiedPaymentVerifierV3NewlyDeployed) {
      await waitForDeploymentDelay(hre);
    }
  }

  const nullifierRegistryV2Contract = await ethers.getContractAt(
    "NullifierRegistryV2",
    nullifierRegistryV2.address,
  );
  const unifiedPaymentVerifierV3Contract = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3",
    unifiedPaymentVerifierV3.address,
  );
  for (const { method } of activePaymentMethods) {
    await addPaymentMethodToUnifiedVerifier(hre, unifiedPaymentVerifierV3Contract, method);
  }
  await addWritePermission(hre, nullifierRegistryV2Contract, unifiedPaymentVerifierV3.address);

  for (const { method, currencies, verifier } of activePaymentMethods) {
    if (sameAddress(verifier, unifiedPaymentVerifierV3.address)) continue;

    await removePaymentMethodFromRegistry(hre, paymentVerifierRegistry, method);
    await addPaymentMethodToRegistry(
      hre,
      paymentVerifierRegistry,
      method,
      unifiedPaymentVerifierV3.address,
      currencies,
    );
  }

  const orchestratorV3 = await deploy("OrchestratorV3", {
    from: deployer,
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      relayerRegistryAddress,
      ORCHESTRATOR_V3_PROTOCOL_FEE[network],
      ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT[network] != ""
        ? ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT[network]
        : deployer,
    ],
    log: true,
  });
  if (orchestratorV3.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const stakeVault = await deploy("StakeVault", {
    from: deployer,
    args: [
      deployer,
      stakeTokenAddress,
      ethers.constants.AddressZero,
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ],
    log: true,
  });
  if (stakeVault.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const chargebackNullifierRegistry = await deploy("ChargebackNullifierRegistry", {
    contract: "NullifierRegistry",
    from: deployer,
    args: [],
    log: true,
  });
  if (chargebackNullifierRegistry.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const chargebackVerifier = await deploy("ChargebackVerifier", {
    from: deployer,
    args: [
      deployer,
      nullifierRegistryV2.address,
      multiAttestationVerifierAddress,
    ],
    log: true,
  });
  if (chargebackVerifier.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const chargebackPolicy = await deploy("ChargebackPolicy", {
    from: deployer,
    args: [
      deployer,
      stakeVault.address,
      chargebackVerifier.address,
      chargebackNullifierRegistry.address,
    ],
    log: true,
  });
  if (chargebackPolicy.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const lifecycleHook = await deploy("IntentLifecycleHookV1", {
    from: deployer,
    args: [
      orchestratorRegistryAddress,
      whitelistPolicyAddress,
      chargebackPolicy.address,
    ],
    log: true,
  });
  if (lifecycleHook.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const chargebackNullifierRegistryContract = await ethers.getContractAt(
    "NullifierRegistry",
    chargebackNullifierRegistry.address,
  );
  const chargebackVerifierContract = await ethers.getContractAt("ChargebackVerifier", chargebackVerifier.address);
  const chargebackPolicyContract = await ethers.getContractAt("ChargebackPolicy", chargebackPolicy.address);
  const orchestratorV3Contract = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);

  const currentController = await stakeVaultContract.controller();
  if (sameAddress(currentController, ethers.constants.AddressZero)) {
    await (await stakeVaultContract.initializeController(chargebackPolicy.address)).wait();
    await waitForDeploymentDelay(hre);
  } else if (!sameAddress(currentController, chargebackPolicy.address)) {
    throw new Error(
      `StakeVault controller mismatch: expected ${chargebackPolicy.address}, found ${currentController}`,
    );
  }

  await addWritePermission(hre, chargebackNullifierRegistryContract, chargebackPolicy.address);

  if (!(await chargebackPolicyContract.isLifecycleHookAuthorized(lifecycleHook.address))) {
    await (await chargebackPolicyContract.setLifecycleHookAuthorization(lifecycleHook.address, true)).wait();
    await waitForDeploymentDelay(hre);
  }

  const activePaymentMethodSet = new Set(activePaymentMethods.map(({ method }) => method));
  for (const methodName of CHARGEBACKABLE_PAYMENT_METHODS) {
    const method = paymentMethodHash(methodName);
    if (
      activePaymentMethodSet.has(method)
      && !(await chargebackPolicyContract.getRiskWindow(method)).eq(CHARGEBACK_RISK_WINDOW[network])
    ) {
      await (await chargebackPolicyContract.setRiskWindow(method, CHARGEBACK_RISK_WINDOW[network])).wait();
      await waitForDeploymentDelay(hre);
    }
  }

  if (!sameAddress(await orchestratorV3Contract.lifecycleHook(), lifecycleHook.address)) {
    await (await orchestratorV3Contract.setLifecycleHook(lifecycleHook.address)).wait();
    await waitForDeploymentDelay(hre);
  }

  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV3.address);
  const oldOrchestratorV3 = OLD_ORCHESTRATOR_V3[network];
  if (oldOrchestratorV3 && (await orchestratorRegistry.isOrchestrator(oldOrchestratorV3))) {
    await removeOrchestratorFromRegistry(hre, orchestratorRegistry, oldOrchestratorV3);
  }

  await setNewOwner(hre, orchestratorV3Contract, governance);
  await setNewOwner(hre, stakeVaultContract, governance);
  await setNewOwner(hre, chargebackPolicyContract, governance);
  await setNewOwner(hre, chargebackVerifierContract, governance);
  await setNewOwner(hre, chargebackNullifierRegistryContract, governance);
  if (nullifierRegistryV2NewlyDeployed) {
    await setNewOwner(hre, nullifierRegistryV2Contract, governance);
  }
  if (unifiedPaymentVerifierV3NewlyDeployed) {
    await setNewOwner(hre, unifiedPaymentVerifierV3Contract, governance);
  }

  console.log("=== V3 lifecycle stack deployment prepared ===");
  console.log("NullifierRegistryV2:", nullifierRegistryV2.address);
  console.log("UnifiedPaymentVerifierV3:", unifiedPaymentVerifierV3.address);
  console.log("OrchestratorV3:", orchestratorV3.address);
  console.log("StakeVault:", stakeVault.address);
  console.log("ChargebackNullifierRegistry:", chargebackNullifierRegistry.address);
  console.log("ChargebackVerifier:", chargebackVerifier.address);
  console.log("ChargebackPolicy:", chargebackPolicy.address);
  console.log("IntentLifecycleHookV1:", lifecycleHook.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  // The whitelist-only cutover in lane 31 intentionally supersedes this chargeback lifecycle
  // composition without replacing its verifier, nullifier, staking, or chargeback deployments.
  // Once its canonical hook artifact exists, only lane 31 may resume or repair the active wiring.
  if (
    (network === "base_staging" || process.env.ENABLE_STAGING_GROUPS_CUTOVER_TEST === "true")
    && await hre.deployments.getOrNull("WhitelistLifecycleHook")
  ) return true;
  if (process.env.FORCE_RERUN_V3_LIFECYCLE_STACK === "true") return false;

  try {
    return await systemFullyWired(hre);
  } catch {
    return false;
  }
};

func.tags = ["30_deploy_v3_lifecycle_stack", "V3LifecycleStack", "OrchestratorV3"];
func.dependencies = ["29_deploy_whitelist_policy"];

export default func;
