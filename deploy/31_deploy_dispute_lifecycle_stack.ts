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
    const policyDeployment = await hre.deployments.get("DisputePolicy");
    const hookDeployment = await hre.deployments.get("IntentLifecycleHookV1");
    const orchestratorDeployment = await hre.deployments.get("OrchestratorV3");
    const whitelistPolicyDeployment = await hre.deployments.get("WhitelistPolicy");
    const registryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
    const verifierAddress = (await hre.deployments.get("DisputeVerifier")).address;
    const nullifierRegistryAddress = (await hre.deployments.get("ChargebackNullifierRegistry")).address;

    const vault = await ethers.getContractAt("StakeVault", vaultDeployment.address);
    const policy = await ethers.getContractAt("DisputePolicy", policyDeployment.address);
    const verifier = await ethers.getContractAt("DisputeVerifier", verifierAddress);
    const hook = await ethers.getContractAt("IntentLifecycleHookV1", hookDeployment.address);
    const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorDeployment.address);
    const nullifierRegistry = await ethers.getContractAt("NullifierRegistry", nullifierRegistryAddress);

    if (!sameAddress(await vault.stakeToken(), stakeTokenAddress)) return false;
    if (!sameAddress(await vault.controller(), policy.address)) return false;
    if (!(await vault.controllerChangeDelay()).eq(STAKE_VAULT_CONTROLLER_CHANGE_DELAY)) return false;
    if (!sameAddress(await policy.stakeVault(), vault.address)) return false;
    if (!sameAddress(await policy.disputeVerifier(), verifierAddress)) return false;
    if (!sameAddress(await policy.chargebackNullifierRegistry(), nullifierRegistryAddress)) return false;
    if (!sameAddress(await hook.orchestratorRegistry(), registryAddress)) return false;
    if (!sameAddress(await hook.whitelistPolicy(), whitelistPolicyDeployment.address)) return false;
    if (!sameAddress(await hook.disputePolicy(), policy.address)) return false;
    if (!(await policy.isLifecycleHookAuthorized(hook.address))) return false;
    if (!(await nullifierRegistry.isWriter(policy.address))) return false;
    if (!sameAddress(await orchestrator.lifecycleHook(), hook.address)) return false;
    if (!sameAddress(await vault.owner(), governance)) return false;
    if (!sameAddress(await policy.owner(), governance)) return false;
    if (!sameAddress(await verifier.owner(), governance)) return false;

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
  const existingPolicy = await hre.deployments.getOrNull("DisputePolicy");
  const existingHook = await hre.deployments.getOrNull("IntentLifecycleHookV1");
  if (network === "base_staging") {
    if (existingVault && sameAddress(existingVault.address, RETIRED_STAGING_STAKE_VAULT)) {
      throw new Error("Move the retired StakeVault artifact aside before lane 31");
    }
    if (existingPolicy && sameAddress(existingPolicy.address, RETIRED_STAGING_CHARGEBACK_POLICY)) {
      throw new Error("Move the retired DisputePolicy artifact aside before lane 31");
    }
    if (existingHook && sameAddress(existingHook.address, RETIRED_STAGING_LIFECYCLE_HOOK)) {
      throw new Error("Move the retired IntentLifecycleHookV1 artifact aside before lane 31");
    }
    await assertRetiredLiabilitiesZero();
  }
  if (existingVault || existingPolicy || existingHook) {
    throw new Error(
      "Move the StakeVault, DisputePolicy, and IntentLifecycleHookV1 artifacts aside before lane 31",
    );
  }

  const orchestratorRegistryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
  const whitelistPolicyAddress = (await hre.deployments.get("WhitelistPolicy")).address;
  const whitelistHookAddress = (await hre.deployments.get("WhitelistLifecycleHook")).address;
  const orchestratorAddress = (await hre.deployments.get("OrchestratorV3")).address;

  let chargebackNullifierRegistryDeployment = await hre.deployments.getOrNull(
    "ChargebackNullifierRegistry",
  );
  let disputeVerifierDeployment = await hre.deployments.getOrNull("DisputeVerifier");
  if (network !== "base_staging" && !chargebackNullifierRegistryDeployment) {
    chargebackNullifierRegistryDeployment = await hre.deployments.deploy("ChargebackNullifierRegistry", {
      contract: "NullifierRegistry",
      from: deployer,
      args: [],
      log: true,
    });
  }
  if (!disputeVerifierDeployment) {
    let nullifierRegistryV2 = await hre.deployments.getOrNull("NullifierRegistryV2");
    if (!nullifierRegistryV2) {
      if (network === "base_staging") {
        throw new Error("NullifierRegistryV2 must already exist on staging");
      }
      nullifierRegistryV2 = await hre.deployments.deploy("NullifierRegistryV2", {
        from: deployer,
        args: [(await hre.deployments.get("NullifierRegistry")).address],
        log: true,
      });
    }
    const attestationVerifier =
      await hre.deployments.getOrNull("MultiAttestationVerifier")
      || await hre.deployments.get("SimpleAttestationVerifier");
    disputeVerifierDeployment = await hre.deployments.deploy("DisputeVerifier", {
      from: deployer,
      args: [deployer, nullifierRegistryV2.address, attestationVerifier.address],
      log: true,
    });
  }
  if (!disputeVerifierDeployment || !chargebackNullifierRegistryDeployment) {
    throw new Error("Dispute lifecycle dependencies are unavailable");
  }
  const disputeVerifierAddress = disputeVerifierDeployment.address;
  const chargebackNullifierRegistryAddress = chargebackNullifierRegistryDeployment.address;

  await assertCode(whitelistPolicyAddress, "WhitelistPolicy");
  await assertCode(whitelistHookAddress, "WhitelistLifecycleHook");
  await assertCode(orchestratorAddress, "OrchestratorV3");
  await assertCode(disputeVerifierAddress, "DisputeVerifier");
  await assertCode(chargebackNullifierRegistryAddress, "ChargebackNullifierRegistry");

  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorAddress);
  if (!sameAddress(await orchestrator.lifecycleHook(), whitelistHookAddress)) {
    throw new Error("Lane 31 requires the lane-30 OrchestratorV3 to still use WhitelistLifecycleHook");
  }

  console.log("=== Deploying dispute lifecycle stack ===");
  console.log("Reusing OrchestratorV3:", orchestratorAddress);
  console.log("Reusing WhitelistPolicy:", whitelistPolicyAddress);
  console.log("DisputeVerifier:", disputeVerifierAddress);
  console.log("Reusing ChargebackNullifierRegistry:", chargebackNullifierRegistryAddress);

  const vaultDeployment = await hre.deployments.deploy("StakeVault", {
    from: deployer,
    args: [deployer, stakeTokenAddress, ethers.constants.AddressZero, STAKE_VAULT_CONTROLLER_CHANGE_DELAY],
    log: true,
  });
  if (!vaultDeployment.newlyDeployed) throw new Error("StakeVault was not freshly deployed");
  await waitForDeploymentDelay(hre);

  const policyDeployment = await hre.deployments.deploy("DisputePolicy", {
    from: deployer,
    args: [
      deployer,
      vaultDeployment.address,
      disputeVerifierAddress,
      chargebackNullifierRegistryAddress,
    ],
    log: true,
  });
  if (!policyDeployment.newlyDeployed) throw new Error("DisputePolicy was not freshly deployed");
  await waitForDeploymentDelay(hre);

  const hookDeployment = await hre.deployments.deploy("IntentLifecycleHookV1", {
    from: deployer,
    args: [orchestratorRegistryAddress, whitelistPolicyAddress, policyDeployment.address],
    log: true,
  });
  if (!hookDeployment.newlyDeployed) throw new Error("IntentLifecycleHookV1 was not freshly deployed");
  await waitForDeploymentDelay(hre);

  const vault = await ethers.getContractAt("StakeVault", vaultDeployment.address);
  const policy = await ethers.getContractAt("DisputePolicy", policyDeployment.address);
  const disputeVerifier = await ethers.getContractAt("DisputeVerifier", disputeVerifierAddress);
  const hook = await ethers.getContractAt("IntentLifecycleHookV1", hookDeployment.address);
  const nullifierRegistry = await ethers.getContractAt("NullifierRegistry", chargebackNullifierRegistryAddress);

  await (await vault.initializeController(policy.address)).wait();
  await waitForDeploymentDelay(hre);
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
  await setNewOwner(hre, disputeVerifier, governance);

  if (!await systemFullyWired(hre)) throw new Error("Dispute lifecycle stack verification failed");

  console.log("=== Dispute lifecycle stack verified ===");
  console.log("StakeVault:", vault.address);
  console.log("DisputePolicy:", policy.address);
  console.log("IntentLifecycleHookV1:", hook.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (await systemFullyWired(hre)) return true;
  if (network === "base_staging" && process.env.ENABLE_STAGING_V3_DISPUTE_CUTOVER !== "true") return true;
  return false;
};

func.tags = ["31_deploy_dispute_lifecycle_stack", "V3DisputeLifecycleStack"];
func.dependencies = ["30_deploy_v3_lifecycle_stack"];

export default func;
