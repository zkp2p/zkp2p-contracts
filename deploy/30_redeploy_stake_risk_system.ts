import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  STAKE_RISK_PLATFORM_POLICY,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import {
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const OLD_STAKE_VAULT: Record<string, string> = {
  base_staging: "0xD7c468ABbc5e265EDdc362F8858C34CaC1c14A62",
};

const OLD_RISK_MANAGER: Record<string, string> = {
  base_staging: "0x3AC412E433D28a3D7Adb961A1F25146C93F8fC54",
};

const CHARGEBACKABLE_PAYMENT_METHODS = new Set([
  "paypal",
  "venmo",
  "cashapp",
  "zelle",
  "chime",
].map((name) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name))));

interface PlatformRiskConfig {
  enabled: boolean;
  chargeback: {
    chargebackable: boolean;
    deferredPayoutEnabled: boolean;
    riskWindow: ethers.BigNumberish;
  };
}

function platformRiskConfigMatches(
  actual: PlatformRiskConfig,
  expected: PlatformRiskConfig,
): boolean {
  return actual.enabled === expected.enabled
    && actual.chargeback.chargebackable === expected.chargeback.chargebackable
    && actual.chargeback.deferredPayoutEnabled === expected.chargeback.deferredPayoutEnabled
    && ethers.BigNumber.from(actual.chargeback.riskWindow).eq(expected.chargeback.riskWindow);
}

function riskPlatformPolicyForNetwork(network: string): {
  reversible: PlatformRiskConfig;
  nonChargebackable: PlatformRiskConfig;
} {
  const policy = STAKE_RISK_PLATFORM_POLICY[network];
  if (!policy) {
    throw new Error(`No governance-ratified stake-risk platform policy for network: ${network}`);
  }
  return policy;
}

async function redeployFullyWired(network: string): Promise<boolean> {
  const policy = STAKE_RISK_PLATFORM_POLICY[network];
  if (!policy) return false;

  const stakeVaultAddress = getDeployedContractAddress(network, "StakeVault");
  const riskManagerAddress = getDeployedContractAddress(network, "RiskManager");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");

  const stakeVault = await ethers.getContractAt("StakeVault", stakeVaultAddress);
  const riskManager = await ethers.getContractAt("RiskManager", riskManagerAddress);
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    paymentVerifierRegistryAddress,
  );

  const controller: string = await stakeVault.controller();
  if (controller.toLowerCase() !== riskManagerAddress.toLowerCase()) return false;

  const paymentMethods: string[] = await paymentVerifierRegistry.getPaymentMethods();
  for (const paymentMethod of paymentMethods) {
    const expectedConfig = CHARGEBACKABLE_PAYMENT_METHODS.has(paymentMethod)
      ? policy.reversible
      : policy.nonChargebackable;
    const actualConfig: PlatformRiskConfig = await riskManager.getPlatformRiskConfig(paymentMethod);
    if (!platformRiskConfigMatches(actualConfig, expectedConfig)) return false;
  }

  // Do not check owner(): Ownable2Step keeps the deployer as owner until the multisig accepts ownership.
  return true;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy, save } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] || deployer;
  const policy = riskPlatformPolicyForNetwork(network);

  const orchestratorV3Address = getDeployedContractAddress(network, "OrchestratorV3");
  const riskAttestationVerifierAddress = getDeployedContractAddress(network, "RiskAttestationVerifier");
  const nullifierRegistryV2Address = getDeployedContractAddress(network, "NullifierRegistryV2");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const stakeToken = USDC[network];
  if (!stakeToken) {
    throw new Error(`No stake token configured for network: ${network}`);
  }

  console.log("=== Redeploying StakeVault + RiskManager ===");
  console.log("Old StakeVault:", OLD_STAKE_VAULT[network]);
  console.log("Old RiskManager:", OLD_RISK_MANAGER[network]);

  const stakeVault = await deploy("StakeVault", {
    contract: "StakeVault",
    from: deployer,
    args: [
      deployer,
      stakeToken,
      ethers.constants.AddressZero,
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ],
  });
  console.log("New StakeVault deployed at", stakeVault.address);
  await waitForDeploymentDelay(hre);
  await save("StakeVaultRiskSettlement", stakeVault);

  const riskManager = await deploy("RiskManager", {
    from: deployer,
    args: [
      deployer,
      orchestratorV3Address,
      stakeVault.address,
      riskAttestationVerifierAddress,
      nullifierRegistryV2Address,
    ],
  });
  console.log("New RiskManager deployed at", riskManager.address);
  await waitForDeploymentDelay(hre);

  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const riskManagerContract = await ethers.getContractAt("RiskManager", riskManager.address);
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    paymentVerifierRegistryAddress,
  );

  const currentController: string = await stakeVaultContract.controller();
  if (currentController === ethers.constants.AddressZero) {
    await (await stakeVaultContract.initializeController(riskManager.address)).wait();
    console.log("StakeVault controller initialized to", riskManager.address);
    await waitForDeploymentDelay(hre);
  } else if (currentController.toLowerCase() !== riskManager.address.toLowerCase()) {
    throw new Error(`StakeVault controller mismatch: expected ${riskManager.address}, found ${currentController}`);
  }

  const paymentMethods: string[] = await paymentVerifierRegistry.getPaymentMethods();
  for (const paymentMethod of paymentMethods) {
    const expectedConfig = CHARGEBACKABLE_PAYMENT_METHODS.has(paymentMethod)
      ? policy.reversible
      : policy.nonChargebackable;
    const actualConfig: PlatformRiskConfig = await riskManagerContract.getPlatformRiskConfig(paymentMethod);
    if (!platformRiskConfigMatches(actualConfig, expectedConfig)) {
      await (await riskManagerContract.setPlatformRiskConfig(paymentMethod, expectedConfig)).wait();
      console.log(
        "Platform risk config set for",
        paymentMethod,
        CHARGEBACKABLE_PAYMENT_METHODS.has(paymentMethod) ? "(reversible)" : "(non-chargebackable)",
      );
      await waitForDeploymentDelay(hre);
    }
  }

  await setNewOwner(hre, stakeVaultContract, multiSig);
  console.log("StakeVault ownership transferred to", multiSig);

  await setNewOwner(hre, riskManagerContract, multiSig);
  console.log("RiskManager ownership transferred to", multiSig);

  console.log("=== Stake-risk system redeployment finished ===");
  console.log("StakeVault:", stakeVault.address);
  console.log("RiskManager:", riskManager.address);
};

// Skip only once both generations have been replaced; FORCE_RERUN_STAKE_RISK_REDEPLOY=true forces completion of partial wiring.
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  if (process.env.FORCE_RERUN_STAKE_RISK_REDEPLOY === "true") return false;

  const network = hre.deployments.getNetworkName();
  const oldStakeVault = OLD_STAKE_VAULT[network];
  if (!oldStakeVault) return true;

  try {
    const currentStakeVault = getDeployedContractAddress(network, "StakeVault");
    const currentRiskManager = getDeployedContractAddress(network, "RiskManager");
    const bothAddressesReplaced = (
      currentStakeVault.toLowerCase() !== oldStakeVault.toLowerCase() &&
      currentRiskManager.toLowerCase() !== OLD_RISK_MANAGER[network].toLowerCase()
    );
    if (!bothAddressesReplaced) return false;

    return await redeployFullyWired(network);
  } catch (error) {
    return false;
  }
};

func.tags = ["30_redeploy_stake_risk_system"];
func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
