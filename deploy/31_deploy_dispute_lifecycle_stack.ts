import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  DISPUTE_RISK_WINDOW,
  DISPUTABLE_PAYMENT_METHODS,
  MULTI_SIG,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
  USDC_YIELD_VAULT,
} from "../deployments/parameters";
import {
  addWritePermission,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging"]);

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

async function getSettlementTokenAddress(hre: HardhatRuntimeEnvironment): Promise<string> {
  const network = hre.deployments.getNetworkName();
  const configuredAddress = USDC[network];
  if (configuredAddress) return configuredAddress;

  return (await hre.deployments.get("USDCMock")).address;
}

async function getCollateralVaultAddress(hre: HardhatRuntimeEnvironment): Promise<string> {
  const network = hre.deployments.getNetworkName();
  const configuredAddress = USDC_YIELD_VAULT[network];
  if (configuredAddress) return configuredAddress;

  return (await hre.deployments.get("USDCYieldVault")).address;
}

export async function disputeStackReady(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  try {
    const network = hre.deployments.getNetworkName();
    const [deployer] = await hre.getUnnamedAccounts();
    const governance = MULTI_SIG[network] || deployer;
    const settlementTokenAddress = await getSettlementTokenAddress(hre);
    const collateralVaultAddress = await getCollateralVaultAddress(hre);

    const registryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
    const whitelistPolicyAddress = (await hre.deployments.get("WhitelistPolicy")).address;
    const nullifierRegistryV2Address = (await hre.deployments.get("NullifierRegistryV2")).address;
    const attestationVerifier =
      await hre.deployments.getOrNull("MultiAttestationVerifier")
      || await hre.deployments.get("SimpleAttestationVerifier");
    const disputeNullifierRegistryAddress =
      (await hre.deployments.get("DisputeNullifierRegistry")).address;
    const verifierAddress = (await hre.deployments.get("DisputeVerifier")).address;
    const vaultAddress = (await hre.deployments.get("StakeVault")).address;
    const policyAddress = (await hre.deployments.get("DisputePolicy")).address;
    const hookAddress = (await hre.deployments.get("IntentLifecycleHookV1")).address;

    const disputeNullifierRegistry = await ethers.getContractAt(
      "NullifierRegistry",
      disputeNullifierRegistryAddress,
    );
    const verifier = await ethers.getContractAt("DisputeVerifier", verifierAddress);
    const vault = await ethers.getContractAt("StakeVault", vaultAddress);
    const policy = await ethers.getContractAt("DisputePolicy", policyAddress);
    const hook = await ethers.getContractAt("IntentLifecycleHookV1", hookAddress);

    if (!sameAddress(await disputeNullifierRegistry.owner(), governance)) return false;
    if (!sameAddress(await verifier.nullifierRegistry(), nullifierRegistryV2Address)) return false;
    if (!sameAddress(await verifier.attestationVerifier(), attestationVerifier.address)) return false;
    if (!sameAddress(await verifier.owner(), governance)) return false;
    if (!sameAddress(await vault.stakeToken(), collateralVaultAddress)) return false;
    if (!sameAddress(await vault.controller(), policyAddress)) return false;
    if (!(await vault.controllerChangeDelay()).eq(STAKE_VAULT_CONTROLLER_CHANGE_DELAY)) return false;
    if (!sameAddress(await vault.owner(), governance)) return false;
    if (!sameAddress(await policy.stakeVault(), vaultAddress)) return false;
    if (!sameAddress(await policy.settlementToken(), settlementTokenAddress)) return false;
    if (!sameAddress(await policy.collateralVault(), collateralVaultAddress)) return false;
    if (!sameAddress(await policy.disputeVerifier(), verifierAddress)) return false;
    if (!sameAddress(await policy.disputeNullifierRegistry(), disputeNullifierRegistryAddress)) return false;
    if (!(await policy.isLifecycleHookAuthorized(hookAddress))) return false;
    if (!sameAddress(await policy.owner(), governance)) return false;
    if (!(await disputeNullifierRegistry.isWriter(policyAddress))) return false;
    if (!sameAddress(await hook.orchestratorRegistry(), registryAddress)) return false;
    if (!sameAddress(await hook.whitelistPolicy(), whitelistPolicyAddress)) return false;
    if (!sameAddress(await hook.disputePolicy(), policyAddress)) return false;

    for (const methodName of DISPUTABLE_PAYMENT_METHODS) {
      const riskWindow = await policy.getRiskWindow(paymentMethodHash(methodName));
      if (!riskWindow.eq(DISPUTE_RISK_WINDOW[network])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const settlementTokenAddress = await getSettlementTokenAddress(hre);
  let collateralVaultAddress: string;
  if (USDC_YIELD_VAULT[network]) {
    collateralVaultAddress = await getCollateralVaultAddress(hre);
  } else {
    const collateralVaultDeployment = await hre.deployments.deploy("USDCYieldVault", {
      contract: "ERC4626Mock",
      from: deployer,
      args: [settlementTokenAddress],
      log: true,
    });
    await waitForDeploymentDelay(hre);
    collateralVaultAddress = collateralVaultDeployment.address;
  }

  const orchestratorRegistryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
  const whitelistPolicyAddress = (await hre.deployments.get("WhitelistPolicy")).address;
  let nullifierRegistryV2Deployment = await hre.deployments.getOrNull("NullifierRegistryV2");
  if (!nullifierRegistryV2Deployment) {
    if (network === "base_staging") {
      throw new Error("NullifierRegistryV2 must already exist on staging");
    }
    nullifierRegistryV2Deployment = await hre.deployments.deploy("NullifierRegistryV2", {
      from: deployer,
      args: [(await hre.deployments.get("NullifierRegistry")).address],
      log: true,
    });
    await waitForDeploymentDelay(hre);
  }
  const nullifierRegistryV2Address = nullifierRegistryV2Deployment.address;
  const attestationVerifier =
    await hre.deployments.getOrNull("MultiAttestationVerifier")
    || await hre.deployments.get("SimpleAttestationVerifier");

  await assertCode(orchestratorRegistryAddress, "OrchestratorRegistry");
  await assertCode(whitelistPolicyAddress, "WhitelistPolicy");
  await assertCode(nullifierRegistryV2Address, "NullifierRegistryV2");
  await assertCode(attestationVerifier.address, "AttestationVerifier");
  await assertCode(settlementTokenAddress, "SettlementToken");
  await assertCode(collateralVaultAddress, "USDCYieldVault");

  const disputeNullifierRegistryDeployment = await hre.deployments.deploy(
    "DisputeNullifierRegistry",
    {
      contract: "NullifierRegistry",
      from: deployer,
      args: [],
      log: true,
    },
  );
  await waitForDeploymentDelay(hre);

  const disputeVerifierDeployment = await hre.deployments.deploy("DisputeVerifier", {
    from: deployer,
    args: [deployer, nullifierRegistryV2Address, attestationVerifier.address],
    log: true,
  });
  await waitForDeploymentDelay(hre);

  const vaultDeployment = await hre.deployments.deploy("StakeVault", {
    from: deployer,
    args: [deployer, collateralVaultAddress, ethers.constants.AddressZero, STAKE_VAULT_CONTROLLER_CHANGE_DELAY],
    log: true,
  });
  await waitForDeploymentDelay(hre);

  const policyDeployment = await hre.deployments.deploy("DisputePolicy", {
    from: deployer,
    args: [
      deployer,
      settlementTokenAddress,
      collateralVaultAddress,
      vaultDeployment.address,
      disputeVerifierDeployment.address,
      disputeNullifierRegistryDeployment.address,
    ],
    log: true,
  });
  await waitForDeploymentDelay(hre);

  const hookDeployment = await hre.deployments.deploy("IntentLifecycleHookV1", {
    from: deployer,
    args: [orchestratorRegistryAddress, whitelistPolicyAddress, policyDeployment.address],
    log: true,
  });
  await waitForDeploymentDelay(hre);

  const disputeNullifierRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    disputeNullifierRegistryDeployment.address,
  );
  const disputeVerifier = await ethers.getContractAt(
    "DisputeVerifier",
    disputeVerifierDeployment.address,
  );
  const vault = await ethers.getContractAt("StakeVault", vaultDeployment.address);
  const policy = await ethers.getContractAt("DisputePolicy", policyDeployment.address);

  if (sameAddress(await vault.controller(), ethers.constants.AddressZero)) {
    await (await vault.initializeController(policy.address)).wait();
    await waitForDeploymentDelay(hre);
  }
  await addWritePermission(hre, disputeNullifierRegistry, policy.address);

  if (!(await policy.isLifecycleHookAuthorized(hookDeployment.address))) {
    await (await policy.setLifecycleHookAuthorization(hookDeployment.address, true)).wait();
    await waitForDeploymentDelay(hre);
  }
  for (const methodName of DISPUTABLE_PAYMENT_METHODS) {
    const paymentMethod = paymentMethodHash(methodName);
    const riskWindow = DISPUTE_RISK_WINDOW[network];
    if (!(await policy.getRiskWindow(paymentMethod)).eq(riskWindow)) {
      await (await policy.setRiskWindow(paymentMethod, riskWindow)).wait();
      await waitForDeploymentDelay(hre);
    }
  }

  await setNewOwner(hre, disputeNullifierRegistry, governance);
  await setNewOwner(hre, disputeVerifier, governance);
  await setNewOwner(hre, vault, governance);
  await setNewOwner(hre, policy, governance);

  if (!await disputeStackReady(hre)) {
    throw new Error("Dispute lifecycle stack verification failed");
  }

  console.log("=== Fresh dispute lifecycle stack deployed ===");
  console.log("DisputeNullifierRegistry:", disputeNullifierRegistry.address);
  console.log("DisputeVerifier:", disputeVerifier.address);
  console.log("USDCYieldVault:", collateralVaultAddress);
  console.log("StakeVault:", vault.address);
  console.log("DisputePolicy:", policy.address);
  console.log("IntentLifecycleHookV1:", hookDeployment.address);
  console.log("OrchestratorV3 lifecycle hook was not changed");
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (await disputeStackReady(hre)) return true;
  return network === "base_staging"
    && process.env.ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT !== "true";
};

func.tags = ["31_deploy_dispute_lifecycle_stack", "V3DisputeLifecycleStack"];

export default func;
