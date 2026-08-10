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

export async function disputeStackReady(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  try {
    const network = hre.deployments.getNetworkName();
    const [deployer] = await hre.getUnnamedAccounts();
    const governance = MULTI_SIG[network] || deployer;
    const stakeTokenAddress = USDC[network] || (await hre.deployments.get("USDCMock")).address;

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
    const disputeProtectionPolicyAddress =
      (await hre.deployments.get("DisputeProtectionPolicy")).address;
    const hookAddress = (await hre.deployments.get("IntentLifecycleHookV1")).address;

    const disputeNullifierRegistry = await ethers.getContractAt(
      "NullifierRegistry",
      disputeNullifierRegistryAddress,
    );
    const verifier = await ethers.getContractAt("DisputeVerifier", verifierAddress);
    const vault = await ethers.getContractAt("StakeVault", vaultAddress);
    const disputeProtectionPolicy = await ethers.getContractAt(
      "DisputeProtectionPolicy",
      disputeProtectionPolicyAddress,
    );
    const hook = await ethers.getContractAt("IntentLifecycleHookV1", hookAddress);

    if (!sameAddress(await disputeNullifierRegistry.owner(), governance)) return false;
    if (!sameAddress(await verifier.nullifierRegistry(), nullifierRegistryV2Address)) return false;
    if (!sameAddress(await verifier.attestationVerifier(), attestationVerifier.address)) return false;
    if (!sameAddress(await verifier.owner(), governance)) return false;
    if (!sameAddress(await vault.stakeToken(), stakeTokenAddress)) return false;
    if (!sameAddress(await vault.controller(), disputeProtectionPolicyAddress)) return false;
    if (!(await vault.controllerChangeDelay()).eq(STAKE_VAULT_CONTROLLER_CHANGE_DELAY)) return false;
    if (!sameAddress(await vault.owner(), governance)) return false;
    if (!sameAddress(await disputeProtectionPolicy.stakeVault(), vaultAddress)) return false;
    if (!sameAddress(await disputeProtectionPolicy.disputeVerifier(), verifierAddress)) return false;
    if (!sameAddress(
      await disputeProtectionPolicy.disputeNullifierRegistry(),
      disputeNullifierRegistryAddress,
    )) return false;
    if (!(await disputeProtectionPolicy.isLifecycleHookAuthorized(hookAddress))) return false;
    if (!sameAddress(await disputeProtectionPolicy.owner(), governance)) return false;
    if (!(await disputeNullifierRegistry.isWriter(disputeProtectionPolicyAddress))) return false;
    if (!sameAddress(await hook.orchestratorRegistry(), registryAddress)) return false;
    if (!sameAddress(await hook.whitelistPolicy(), whitelistPolicyAddress)) return false;
    if (!sameAddress(await hook.disputeProtectionPolicy(), disputeProtectionPolicyAddress)) return false;

    for (const methodName of DISPUTABLE_PAYMENT_METHODS) {
      const riskWindow = await disputeProtectionPolicy.getRiskWindow(paymentMethodHash(methodName));
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
  const stakeTokenAddress = USDC[network] || (await hre.deployments.get("USDCMock")).address;

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
    args: [deployer, stakeTokenAddress, ethers.constants.AddressZero, STAKE_VAULT_CONTROLLER_CHANGE_DELAY],
    log: true,
  });
  await waitForDeploymentDelay(hre);

  const disputeProtectionPolicyDeployment = await hre.deployments.deploy("DisputeProtectionPolicy", {
    from: deployer,
    args: [
      deployer,
      vaultDeployment.address,
      disputeVerifierDeployment.address,
      disputeNullifierRegistryDeployment.address,
    ],
    log: true,
  });
  await waitForDeploymentDelay(hre);

  const hookDeployment = await hre.deployments.deploy("IntentLifecycleHookV1", {
    from: deployer,
    args: [orchestratorRegistryAddress, whitelistPolicyAddress, disputeProtectionPolicyDeployment.address],
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
  const disputeProtectionPolicy = await ethers.getContractAt(
    "DisputeProtectionPolicy",
    disputeProtectionPolicyDeployment.address,
  );

  if (sameAddress(await vault.controller(), ethers.constants.AddressZero)) {
    await (await vault.initializeController(disputeProtectionPolicy.address)).wait();
    await waitForDeploymentDelay(hre);
  }
  await addWritePermission(hre, disputeNullifierRegistry, disputeProtectionPolicy.address);

  if (!(await disputeProtectionPolicy.isLifecycleHookAuthorized(hookDeployment.address))) {
    await (await disputeProtectionPolicy.setLifecycleHookAuthorization(hookDeployment.address, true)).wait();
    await waitForDeploymentDelay(hre);
  }
  for (const methodName of DISPUTABLE_PAYMENT_METHODS) {
    const paymentMethod = paymentMethodHash(methodName);
    const riskWindow = DISPUTE_RISK_WINDOW[network];
    if (!(await disputeProtectionPolicy.getRiskWindow(paymentMethod)).eq(riskWindow)) {
      await (await disputeProtectionPolicy.setRiskWindow(paymentMethod, riskWindow)).wait();
      await waitForDeploymentDelay(hre);
    }
  }

  await setNewOwner(hre, disputeNullifierRegistry, governance);
  await setNewOwner(hre, disputeVerifier, governance);
  await setNewOwner(hre, vault, governance);
  await setNewOwner(hre, disputeProtectionPolicy, governance);

  if (!await disputeStackReady(hre)) {
    throw new Error("Dispute lifecycle stack verification failed");
  }

  console.log("=== Fresh dispute lifecycle stack deployed ===");
  console.log("DisputeNullifierRegistry:", disputeNullifierRegistry.address);
  console.log("DisputeVerifier:", disputeVerifier.address);
  console.log("StakeVault:", vault.address);
  console.log("DisputeProtectionPolicy:", disputeProtectionPolicy.address);
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
