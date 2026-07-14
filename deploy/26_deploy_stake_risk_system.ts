import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  REVERSIBLE_PLATFORM_RESERVE_BPS,
  REVERSIBLE_PLATFORM_RISK_WINDOW,
  RISK_MAX_INTENT_LIFETIME,
  RISK_CALLBACK_GAS_LIMIT,
  RISK_SETTLEMENT_BUFFER,
  STAKE_RISK_CONCURRENCY_LIMITS,
  STAKE_RISK_TIER_THRESHOLDS,
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

/**
 * Deploys the stake-based taker risk system against the existing EscrowV2 and registries.
 * Production execution is opt-in because positive stake thresholds require governance approval.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const tierThresholds = STAKE_RISK_TIER_THRESHOLDS[network];
  const concurrencyLimits = STAKE_RISK_CONCURRENCY_LIMITS[network];
  if (!tierThresholds || !concurrencyLimits) {
    throw new Error(
      `Stake risk launch policy is not configured for ${network}; governance must ratify thresholds before deployment`,
    );
  }

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const attestationVerifierAddress = getDeployedContractAddress(network, "MultiAttestationVerifier");
  const stakeTokenAddress = USDC[network]
    ? USDC[network]
    : getDeployedContractAddress(network, "USDCMock");

  const boundedCall = await deploy("BoundedCall", {
    from: deployer,
    args: [],
  });
  console.log("BoundedCall deployed at", boundedCall.address);
  await waitForDeploymentDelay(hre);

  const postIntentHookExecutor = await deploy("PostIntentHookExecutor", {
    from: deployer,
    args: [],
  });
  console.log("PostIntentHookExecutor deployed at", postIntentHookExecutor.address);
  await waitForDeploymentDelay(hre);

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
  console.log("OrchestratorV3 deployed at", orchestratorV3.address);
  await waitForDeploymentDelay(hre);

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
  console.log("StakeVault deployed at", stakeVault.address);
  await waitForDeploymentDelay(hre);

  const riskTierManager = await deploy("RiskTierManager", {
    from: deployer,
    args: [
      deployer,
      orchestratorV3.address,
      stakeVault.address,
      attestationVerifierAddress,
      tierThresholds,
      concurrencyLimits,
      RISK_MAX_INTENT_LIFETIME,
      RISK_SETTLEMENT_BUFFER,
    ],
  });
  console.log("RiskTierManager deployed at", riskTierManager.address);
  await waitForDeploymentDelay(hre);

  const deferredPayoutHook = await deploy("DeferredPayoutHook", {
    from: deployer,
    args: [
      stakeTokenAddress,
      stakeVault.address,
      riskTierManager.address,
      orchestratorRegistryAddress,
    ],
  });
  console.log("DeferredPayoutHook deployed at", deferredPayoutHook.address);
  await waitForDeploymentDelay(hre);

  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const riskTierManagerContract = await ethers.getContractAt("RiskTierManager", riskTierManager.address);
  const orchestratorV3Contract = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);

  await (await stakeVaultContract.initializeController(riskTierManager.address)).wait();
  await (await riskTierManagerContract.setDeferredPayoutHook(deferredPayoutHook.address)).wait();
  await (await orchestratorV3Contract.setAllowMultipleIntents(true)).wait();

  await (await riskTierManagerContract.setPlatformRiskConfig(PAYPAL, {
    enabled: true,
    chargebackable: true,
    deferredPayoutEnabled: true,
    reserveBps: REVERSIBLE_PLATFORM_RESERVE_BPS,
    riskWindow: REVERSIBLE_PLATFORM_RISK_WINDOW,
    tierCaps: [0, 0, 750e6, 1_875e6, 3_750e6],
  })).wait();
  await (await riskTierManagerContract.setPlatformRiskConfig(VENMO, {
    enabled: true,
    chargebackable: true,
    deferredPayoutEnabled: true,
    reserveBps: REVERSIBLE_PLATFORM_RESERVE_BPS,
    riskWindow: REVERSIBLE_PLATFORM_RISK_WINDOW,
    tierCaps: [0, 0, 1_000e6, 2_500e6, 5_000e6],
  })).wait();

  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV3.address);
  console.log("OrchestratorV3 added to OrchestratorRegistry");

  await setNewOwner(hre, orchestratorV3Contract, multiSig);
  await setNewOwner(hre, riskTierManagerContract, multiSig);
  await setNewOwner(hre, stakeVaultContract, multiSig);
  console.log("Stake risk system ownership transferred to", multiSig);
};

func.tags = ["StakeRiskSystem"];
func.dependencies = ["16_configure_v2_payment_methods", "MultiAttestationVerifier"];
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  return process.env.DEPLOY_STAKE_RISK_SYSTEM !== "true";
};

export default func;
