import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  CHARGEBACK_RISK_WINDOW,
  CHARGEBACKABLE_PAYMENT_METHODS,
  MULTI_SIG,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import {
  addWritePermission,
  removeWritePermission,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging"]);
const RETIRED_STAGING_STAKE_VAULT = "0xaA82e422B3755eA6a1352eB6B2828324740ee5af";
const RETIRED_STAGING_CHARGEBACK_POLICY = "0xa5fdc112BB69ee2141b99Fdcb94364256Dc34377";
const RETIRED_STAGING_LIFECYCLE_HOOK = "0x4874063A76C3549641883ad0BB169D6b41a0E2c3";

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

async function assertFunctionSelector(address: string, signature: string, label: string): Promise<void> {
  const selector = ethers.utils.id(signature).slice(2, 10).toLowerCase();
  const bytecode = (await ethers.provider.getCode(address)).toLowerCase();
  if (!bytecode.includes(selector)) {
    throw new Error(`${label} does not implement ${signature}; redeploy the V3 lifecycle stack first`);
  }
}

async function assertActivePaymentVerifiersUseRegistry(
  hre: HardhatRuntimeEnvironment,
  expectedRegistry: string,
): Promise<void> {
  if (hre.deployments.getNetworkName() !== "base_staging") return;

  const paymentVerifierRegistryAddress = (await hre.deployments.get("PaymentVerifierRegistry")).address;
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    paymentVerifierRegistryAddress,
  );
  const nullifierRegistryAbi = ["function nullifierRegistry() view returns (address)"];

  for (const methodName of CHARGEBACKABLE_PAYMENT_METHODS) {
    const method = paymentMethodHash(methodName);
    const verifierAddress = await paymentVerifierRegistry.getVerifier(method);
    await assertCode(verifierAddress, `${methodName} payment verifier`);
    const verifier = new ethers.Contract(verifierAddress, nullifierRegistryAbi, ethers.provider);
    const configuredRegistry = await verifier.nullifierRegistry();
    if (!sameAddress(configuredRegistry, expectedRegistry)) {
      throw new Error(
        `${methodName} payment verifier uses ${configuredRegistry}; expected NullifierRegistryV2 ${expectedRegistry}`,
      );
    }
  }
}

async function assertRetiredLiabilitiesZero(): Promise<void> {
  await assertCode(RETIRED_STAGING_STAKE_VAULT, "Retired StakeVault");
  const retiredVault = await ethers.getContractAt("StakeVault", RETIRED_STAGING_STAKE_VAULT);
  const totalStaked = await retiredVault.totalStaked();
  const totalClaimable = await retiredVault.totalClaimable();
  if (!totalStaked.isZero() || !totalClaimable.isZero()) {
    throw new Error(
      `Retired StakeVault still has liabilities: totalStaked=${totalStaked.toString()}, `
      + `totalClaimable=${totalClaimable.toString()}`,
    );
  }
}

async function systemFullyWired(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  try {
    const network = hre.deployments.getNetworkName();
    const [deployer] = await hre.getUnnamedAccounts();
    const governance = MULTI_SIG[network] || deployer;
    const stakeTokenAddress = USDC[network] || (await hre.deployments.get("USDCMock")).address;
    const vaultDeployment = await hre.deployments.get("StakeVault");
    const policyDeployment = await hre.deployments.get("ChargebackPolicy");
    const hookDeployment = await hre.deployments.get("IntentLifecycleHookV1");
    const orchestratorDeployment = await hre.deployments.get("OrchestratorV3");
    const whitelistPolicyDeployment = await hre.deployments.get("WhitelistPolicy");
    const registryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
    const verifierAddress = (await hre.deployments.get("ChargebackVerifier")).address;
    const paymentNullifierRegistryAddress = (await hre.deployments.get("NullifierRegistryV2")).address;
    const nullifierRegistryAddress = (await hre.deployments.get("ChargebackNullifierRegistry")).address;

    const vault = await ethers.getContractAt("StakeVault", vaultDeployment.address);
    const policy = await ethers.getContractAt("ChargebackPolicy", policyDeployment.address);
    const hook = await ethers.getContractAt("IntentLifecycleHookV1", hookDeployment.address);
    const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorDeployment.address);
    const paymentNullifierRegistry = await ethers.getContractAt(
      "NullifierRegistryV2",
      paymentNullifierRegistryAddress,
    );
    const chargebackVerifier = await ethers.getContractAt("ChargebackVerifier", verifierAddress);
    const nullifierRegistry = await ethers.getContractAt("NullifierRegistry", nullifierRegistryAddress);

    await assertFunctionSelector(
      orchestrator.address,
      "releaseFundsToPayer(bytes32,bytes32)",
      "OrchestratorV3",
    );
    await assertActivePaymentVerifiersUseRegistry(hre, paymentNullifierRegistryAddress);

    if (!sameAddress(await vault.stakeToken(), stakeTokenAddress)) return false;
    if (!sameAddress(await vault.controller(), policy.address)) return false;
    if (!(await vault.controllerChangeDelay()).eq(STAKE_VAULT_CONTROLLER_CHANGE_DELAY)) return false;
    if (!sameAddress(await policy.stakeVault(), vault.address)) return false;
    if (!sameAddress(await policy.paymentNullifierRegistry(), paymentNullifierRegistryAddress)) return false;
    if (!sameAddress(await policy.chargebackVerifier(), verifierAddress)) return false;
    if (!sameAddress(await chargebackVerifier.nullifierRegistry(), paymentNullifierRegistryAddress)) return false;
    if (!sameAddress(await policy.chargebackNullifierRegistry(), nullifierRegistryAddress)) return false;
    if (!sameAddress(await hook.orchestratorRegistry(), registryAddress)) return false;
    if (!sameAddress(await hook.whitelistPolicy(), whitelistPolicyDeployment.address)) return false;
    if (!sameAddress(await hook.chargebackPolicy(), policy.address)) return false;
    if (!(await policy.isLifecycleHookAuthorized(hook.address))) return false;
    if (!(await paymentNullifierRegistry.isWriter(policy.address))) return false;
    if (!(await nullifierRegistry.isWriter(policy.address))) return false;
    if (!sameAddress(await orchestrator.lifecycleHook(), hook.address)) return false;
    if (!sameAddress(await vault.owner(), governance)) return false;
    if (!sameAddress(await policy.owner(), governance)) return false;

    for (const methodName of CHARGEBACKABLE_PAYMENT_METHODS) {
      const riskWindow = await policy.getRiskWindow(paymentMethodHash(methodName));
      if (!riskWindow.eq(CHARGEBACK_RISK_WINDOW[network])) return false;
    }
    if (
      network === "base_staging"
      && await nullifierRegistry.isWriter(RETIRED_STAGING_CHARGEBACK_POLICY)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const stakeTokenAddress = USDC[network] || (await hre.deployments.get("USDCMock")).address;

  const existingVault = await hre.deployments.getOrNull("StakeVault");
  const existingPolicy = await hre.deployments.getOrNull("ChargebackPolicy");
  const existingHook = await hre.deployments.getOrNull("IntentLifecycleHookV1");
  if (network === "base_staging") {
    if (existingVault && sameAddress(existingVault.address, RETIRED_STAGING_STAKE_VAULT)) {
      throw new Error("Move the retired StakeVault artifact aside before lane 31");
    }
    if (existingPolicy && sameAddress(existingPolicy.address, RETIRED_STAGING_CHARGEBACK_POLICY)) {
      throw new Error("Move the retired ChargebackPolicy artifact aside before lane 31");
    }
    if (existingHook && sameAddress(existingHook.address, RETIRED_STAGING_LIFECYCLE_HOOK)) {
      throw new Error("Move the retired IntentLifecycleHookV1 artifact aside before lane 31");
    }
    await assertRetiredLiabilitiesZero();
  }
  if (existingVault || existingPolicy || existingHook) {
    throw new Error(
      "Move the StakeVault, ChargebackPolicy, and IntentLifecycleHookV1 artifacts aside before lane 31",
    );
  }

  const orchestratorRegistryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
  const whitelistPolicyAddress = (await hre.deployments.get("WhitelistPolicy")).address;
  const whitelistHookAddress = (await hre.deployments.get("WhitelistLifecycleHook")).address;
  const orchestratorAddress = (await hre.deployments.get("OrchestratorV3")).address;

  let chargebackNullifierRegistryDeployment = await hre.deployments.getOrNull(
    "ChargebackNullifierRegistry",
  );
  let paymentNullifierRegistryDeployment = await hre.deployments.getOrNull("NullifierRegistryV2");
  if (!paymentNullifierRegistryDeployment) {
    paymentNullifierRegistryDeployment = await hre.deployments.deploy("NullifierRegistryV2", {
      from: deployer,
      args: [(await hre.deployments.get("NullifierRegistry")).address],
      log: true,
    });
  }
  let chargebackVerifierDeployment = await hre.deployments.getOrNull("ChargebackVerifier");
  if (network !== "base_staging" && !chargebackNullifierRegistryDeployment) {
    chargebackNullifierRegistryDeployment = await hre.deployments.deploy("ChargebackNullifierRegistry", {
      contract: "NullifierRegistry",
      from: deployer,
      args: [],
      log: true,
    });
  }
  if (network !== "base_staging" && !chargebackVerifierDeployment) {
    const attestationVerifier =
      await hre.deployments.getOrNull("MultiAttestationVerifier")
      || await hre.deployments.get("SimpleAttestationVerifier");
    chargebackVerifierDeployment = await hre.deployments.deploy("ChargebackVerifier", {
      from: deployer,
      args: [deployer, paymentNullifierRegistryDeployment.address, attestationVerifier.address],
      log: true,
    });
  }
  if (!chargebackVerifierDeployment || !chargebackNullifierRegistryDeployment) {
    throw new Error("ChargebackVerifier and ChargebackNullifierRegistry must already exist on staging");
  }
  const chargebackVerifierAddress = chargebackVerifierDeployment.address;
  const chargebackNullifierRegistryAddress = chargebackNullifierRegistryDeployment.address;
  const paymentNullifierRegistryAddress = paymentNullifierRegistryDeployment.address;

  await assertCode(whitelistPolicyAddress, "WhitelistPolicy");
  await assertCode(whitelistHookAddress, "WhitelistLifecycleHook");
  await assertCode(orchestratorAddress, "OrchestratorV3");
  await assertCode(chargebackVerifierAddress, "ChargebackVerifier");
  await assertCode(paymentNullifierRegistryAddress, "NullifierRegistryV2");
  await assertCode(chargebackNullifierRegistryAddress, "ChargebackNullifierRegistry");
  await assertFunctionSelector(
    orchestratorAddress,
    "releaseFundsToPayer(bytes32,bytes32)",
    "OrchestratorV3",
  );
  await assertActivePaymentVerifiersUseRegistry(hre, paymentNullifierRegistryAddress);

  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorAddress);
  if (!sameAddress(await orchestrator.lifecycleHook(), whitelistHookAddress)) {
    throw new Error("Lane 31 requires the lane-30 OrchestratorV3 to still use WhitelistLifecycleHook");
  }

  console.log("=== Deploying chargeback lifecycle stack ===");
  console.log("Reusing OrchestratorV3:", orchestratorAddress);
  console.log("Reusing WhitelistPolicy:", whitelistPolicyAddress);
  console.log("Reusing ChargebackVerifier:", chargebackVerifierAddress);
  console.log("Reusing NullifierRegistryV2:", paymentNullifierRegistryAddress);
  console.log("Reusing ChargebackNullifierRegistry:", chargebackNullifierRegistryAddress);

  const vaultDeployment = await hre.deployments.deploy("StakeVault", {
    from: deployer,
    args: [deployer, stakeTokenAddress, ethers.constants.AddressZero, STAKE_VAULT_CONTROLLER_CHANGE_DELAY],
    log: true,
  });
  if (!vaultDeployment.newlyDeployed) throw new Error("StakeVault was not freshly deployed");
  await waitForDeploymentDelay(hre);

  const policyDeployment = await hre.deployments.deploy("ChargebackPolicy", {
    from: deployer,
    args: [
      deployer,
      vaultDeployment.address,
      paymentNullifierRegistryAddress,
      chargebackVerifierAddress,
      chargebackNullifierRegistryAddress,
    ],
    log: true,
  });
  if (!policyDeployment.newlyDeployed) throw new Error("ChargebackPolicy was not freshly deployed");
  await waitForDeploymentDelay(hre);

  const hookDeployment = await hre.deployments.deploy("IntentLifecycleHookV1", {
    from: deployer,
    args: [orchestratorRegistryAddress, whitelistPolicyAddress, policyDeployment.address],
    log: true,
  });
  if (!hookDeployment.newlyDeployed) throw new Error("IntentLifecycleHookV1 was not freshly deployed");
  await waitForDeploymentDelay(hre);

  const vault = await ethers.getContractAt("StakeVault", vaultDeployment.address);
  const policy = await ethers.getContractAt("ChargebackPolicy", policyDeployment.address);
  const hook = await ethers.getContractAt("IntentLifecycleHookV1", hookDeployment.address);
  const paymentNullifierRegistry = await ethers.getContractAt(
    "NullifierRegistryV2",
    paymentNullifierRegistryAddress,
  );
  const nullifierRegistry = await ethers.getContractAt("NullifierRegistry", chargebackNullifierRegistryAddress);

  await (await vault.initializeController(policy.address)).wait();
  await waitForDeploymentDelay(hre);
  await addWritePermission(hre, paymentNullifierRegistry, policy.address);
  await addWritePermission(hre, nullifierRegistry, policy.address);

  await (await policy.setLifecycleHookAuthorization(hook.address, true)).wait();
  await waitForDeploymentDelay(hre);
  for (const methodName of CHARGEBACKABLE_PAYMENT_METHODS) {
    await (
      await policy.setRiskWindow(paymentMethodHash(methodName), CHARGEBACK_RISK_WINDOW[network])
    ).wait();
    await waitForDeploymentDelay(hre);
  }

  await (await orchestrator.setLifecycleHook(hook.address)).wait();
  await waitForDeploymentDelay(hre);
  if (network === "base_staging") {
    await removeWritePermission(hre, nullifierRegistry, RETIRED_STAGING_CHARGEBACK_POLICY);
  }

  await setNewOwner(hre, vault, governance);
  await setNewOwner(hre, policy, governance);

  if (!await systemFullyWired(hre)) throw new Error("Chargeback lifecycle stack verification failed");

  console.log("=== Chargeback lifecycle stack verified ===");
  console.log("StakeVault:", vault.address);
  console.log("ChargebackPolicy:", policy.address);
  console.log("IntentLifecycleHookV1:", hook.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (await systemFullyWired(hre)) return true;
  if (network === "base_staging" && process.env.ENABLE_STAGING_V3_CHARGEBACK_CUTOVER !== "true") return true;
  return false;
};

func.tags = ["31_deploy_chargeback_lifecycle_stack", "V3ChargebackLifecycleStack"];
func.dependencies = ["30_deploy_v3_lifecycle_stack"];

export default func;
