import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  RISK_CALLBACK_GAS_LIMIT,
  STAKE_VAULT_BASE_EXIT_DELAY,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import {
  addOrchestratorToRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

const FIVE_DAYS = 5 * 24 * 60 * 60;
const TWENTY_PERCENT_APR_BPS = 2_000;

const INITIAL_PAID_EXTENSION_POLICY = {
  reversible: {
    enabled: true,
    chargeback: {
      chargebackable: true,
      deferredPayoutEnabled: true,
      reserveBps: 10_000,
      riskWindow: 30 * 24 * 60 * 60,
    },
    extension: {
      feeBps: TWENTY_PERCENT_APR_BPS,
      maxIntentLifetime: FIVE_DAYS,
    },
  },
  nonChargebackable: {
    enabled: true,
    chargeback: {
      chargebackable: false,
      deferredPayoutEnabled: false,
      reserveBps: 0,
      riskWindow: 0,
    },
    extension: {
      feeBps: TWENTY_PERCENT_APR_BPS,
      maxIntentLifetime: FIVE_DAYS,
    },
  },
};

const PAID_EXTENSION_POLICY: Record<string, typeof INITIAL_PAID_EXTENSION_POLICY> = {
  localhost: INITIAL_PAID_EXTENSION_POLICY,
  hardhat: INITIAL_PAID_EXTENSION_POLICY,
  base_staging: INITIAL_PAID_EXTENSION_POLICY,
};

function platformRiskConfigMatches(actual: any, expected: any): boolean {
  return actual.enabled === expected.enabled
    && actual.chargeback.chargebackable === expected.chargeback.chargebackable
    && actual.chargeback.deferredPayoutEnabled === expected.chargeback.deferredPayoutEnabled
    && ethers.BigNumber.from(actual.chargeback.reserveBps).eq(expected.chargeback.reserveBps)
    && ethers.BigNumber.from(actual.chargeback.riskWindow).eq(expected.chargeback.riskWindow)
    && ethers.BigNumber.from(actual.extension.feeBps).eq(expected.extension.feeBps)
    && ethers.BigNumber.from(actual.extension.maxIntentLifetime).eq(expected.extension.maxIntentLifetime);
}

export function paidExtensionPolicyForNetwork(network: string): typeof INITIAL_PAID_EXTENSION_POLICY {
  const policy = PAID_EXTENSION_POLICY[network];
  if (!policy) {
    throw new Error(`No governance-ratified paid-extension policy for network: ${network}`);
  }
  return policy;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const { reversible: reversibleConfig, nonChargebackable: nonChargebackableConfig } =
    paidExtensionPolicyForNetwork(network);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] || deployer;

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const attestationVerifierAddress = getDeployedContractAddress(network, "MultiAttestationVerifier");
  const stakeTokenAddress = USDC[network] || getDeployedContractAddress(network, "USDCMock");

  const boundedCall = await deploy("BoundedCall", { from: deployer, args: [] });
  if (boundedCall.newlyDeployed) await waitForDeploymentDelay(hre);

  const postIntentHookExecutor = await deploy("PostIntentHookExecutor", { from: deployer, args: [] });
  if (postIntentHookExecutor.newlyDeployed) await waitForDeploymentDelay(hre);

  const orchestratorV3 = await deploy("OrchestratorV3", {
    from: deployer,
    libraries: {
      BoundedCall: boundedCall.address,
      PostIntentHookExecutor: postIntentHookExecutor.address,
    },
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      relayerRegistryAddress,
      ORCHESTRATOR_V2_PROTOCOL_FEE[network],
      ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network] || deployer,
      RISK_CALLBACK_GAS_LIMIT,
    ],
  });
  if (orchestratorV3.newlyDeployed) await waitForDeploymentDelay(hre);

  const stakeVault = await deploy("StakeVault", {
    from: deployer,
    args: [
      deployer,
      stakeTokenAddress,
      ethers.constants.AddressZero,
      STAKE_VAULT_BASE_EXIT_DELAY,
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ],
  });
  if (stakeVault.newlyDeployed) await waitForDeploymentDelay(hre);

  const riskManager = await deploy("RiskManager", {
    from: deployer,
    args: [deployer, orchestratorV3.address, stakeVault.address, attestationVerifierAddress],
  });
  if (riskManager.newlyDeployed) await waitForDeploymentDelay(hre);

  const deferredPayoutHook = await deploy("DeferredPayoutHook", {
    from: deployer,
    args: [stakeTokenAddress, stakeVault.address, riskManager.address, orchestratorRegistryAddress],
  });
  if (deferredPayoutHook.newlyDeployed) await waitForDeploymentDelay(hre);

  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const riskManagerContract = await ethers.getContractAt("RiskManager", riskManager.address);
  const orchestratorV3Contract = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);

  const currentController = await stakeVaultContract.controller();
  if (currentController === ethers.constants.AddressZero) {
    await (await stakeVaultContract.initializeController(riskManager.address)).wait();
    await waitForDeploymentDelay(hre);
  } else if (currentController.toLowerCase() !== riskManager.address.toLowerCase()) {
    throw new Error(`StakeVault controller mismatch: expected ${riskManager.address}, found ${currentController}`);
  }

  if ((await riskManagerContract.deferredPayoutHook()).toLowerCase() !== deferredPayoutHook.address.toLowerCase()) {
    await (await riskManagerContract.setDeferredPayoutHook(deferredPayoutHook.address)).wait();
    await waitForDeploymentDelay(hre);
  }

  if (!(await orchestratorV3Contract.allowMultipleIntents())) {
    await (await orchestratorV3Contract.setAllowMultipleIntents(true)).wait();
    await waitForDeploymentDelay(hre);
  }

  for (const paymentMethod of [PAYPAL, VENMO]) {
    if (!platformRiskConfigMatches(await riskManagerContract.getPlatformRiskConfig(paymentMethod), reversibleConfig)) {
      await (await riskManagerContract.setPlatformRiskConfig(paymentMethod, reversibleConfig)).wait();
      await waitForDeploymentDelay(hre);
    }
  }

  if (!platformRiskConfigMatches(await riskManagerContract.getPlatformRiskConfig(ZELLE), nonChargebackableConfig)) {
    await (await riskManagerContract.setPlatformRiskConfig(ZELLE, nonChargebackableConfig)).wait();
    await waitForDeploymentDelay(hre);
  }

  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV3.address);
  await setNewOwner(hre, orchestratorV3Contract, multiSig);
  await setNewOwner(hre, riskManagerContract, multiSig);
  await setNewOwner(hre, stakeVaultContract, multiSig);
};

func.tags = ["PaidExtensionStakeRiskSystem"];
func.dependencies = ["16_configure_v2_payment_methods", "MultiAttestationVerifier"];
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  if (process.env.DEPLOY_PAID_EXTENSION_STAKE_RISK_SYSTEM !== "true") return true;
  paidExtensionPolicyForNetwork(network);
  return false;
};

export default func;
