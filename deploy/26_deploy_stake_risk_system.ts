import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  NON_CHARGEBACKABLE_FREE_TAKE_AMOUNT,
  NON_CHARGEBACKABLE_FREE_TAKE_COUNT,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  REVERSIBLE_PLATFORM_RESERVE_BPS,
  REVERSIBLE_PLATFORM_RISK_WINDOW,
  RISK_CALLBACK_GAS_LIMIT,
  RISK_GRIEFING_CLIFF,
  RISK_GRIEFING_PENALTY_BPS_PER_HOUR,
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

function platformRiskConfigMatches(actual: any, expected: any): boolean {
  return actual.enabled === expected.enabled
    && actual.chargeback.chargebackable === expected.chargeback.chargebackable
    && actual.chargeback.deferredPayoutEnabled === expected.chargeback.deferredPayoutEnabled
    && ethers.BigNumber.from(actual.chargeback.reserveBps).eq(expected.chargeback.reserveBps)
    && ethers.BigNumber.from(actual.chargeback.riskWindow).eq(expected.chargeback.riskWindow)
    && ethers.BigNumber.from(actual.griefing.griefingCliff).eq(expected.griefing.griefingCliff)
    && ethers.BigNumber.from(actual.griefing.griefingPenaltyBpsPerHour)
      .eq(expected.griefing.griefingPenaltyBpsPerHour)
    && ethers.BigNumber.from(actual.griefing.freeTakeCount).eq(expected.griefing.freeTakeCount)
    && ethers.BigNumber.from(actual.griefing.freeTakeAmount).eq(expected.griefing.freeTakeAmount);
}

const reversibleConfig = {
  enabled: true,
  chargeback: {
    chargebackable: true,
    deferredPayoutEnabled: true,
    reserveBps: REVERSIBLE_PLATFORM_RESERVE_BPS,
    riskWindow: REVERSIBLE_PLATFORM_RISK_WINDOW,
  },
  griefing: {
    griefingCliff: RISK_GRIEFING_CLIFF,
    griefingPenaltyBpsPerHour: RISK_GRIEFING_PENALTY_BPS_PER_HOUR,
    freeTakeCount: 0,
    freeTakeAmount: 0,
  },
};

const nonChargebackableConfig = {
  enabled: true,
  chargeback: {
    chargebackable: false,
    deferredPayoutEnabled: false,
    reserveBps: 0,
    riskWindow: 0,
  },
  griefing: {
    griefingCliff: RISK_GRIEFING_CLIFF,
    griefingPenaltyBpsPerHour: RISK_GRIEFING_PENALTY_BPS_PER_HOUR,
    freeTakeCount: NON_CHARGEBACKABLE_FREE_TAKE_COUNT,
    freeTakeAmount: NON_CHARGEBACKABLE_FREE_TAKE_AMOUNT,
  },
};

/**
 * Deploys the continuous stake-risk system against the existing EscrowV2 and registries.
 * Non-local execution remains explicitly opt-in until launch platform values are ratified.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const attestationVerifierAddress = getDeployedContractAddress(network, "MultiAttestationVerifier");
  const stakeTokenAddress = USDC[network]
    ? USDC[network]
    : getDeployedContractAddress(network, "USDCMock");

  const boundedCall = await deploy("BoundedCall", { from: deployer, args: [] });
  console.log("BoundedCall deployed at", boundedCall.address);
  await waitForDeploymentDelay(hre);

  const postIntentHookExecutor = await deploy("PostIntentHookExecutor", { from: deployer, args: [] });
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

  const riskManager = await deploy("RiskManager", {
    from: deployer,
    args: [deployer, orchestratorV3.address, stakeVault.address, attestationVerifierAddress],
  });
  console.log("RiskManager deployed at", riskManager.address);
  await waitForDeploymentDelay(hre);

  const deferredPayoutHook = await deploy("DeferredPayoutHook", {
    from: deployer,
    args: [stakeTokenAddress, stakeVault.address, riskManager.address, orchestratorRegistryAddress],
  });
  console.log("DeferredPayoutHook deployed at", deferredPayoutHook.address);
  await waitForDeploymentDelay(hre);

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
    const actual = await riskManagerContract.getPlatformRiskConfig(paymentMethod);
    if (!platformRiskConfigMatches(actual, reversibleConfig)) {
      await (await riskManagerContract.setPlatformRiskConfig(paymentMethod, reversibleConfig)).wait();
      await waitForDeploymentDelay(hre);
    }
  }

  if (!platformRiskConfigMatches(await riskManagerContract.getPlatformRiskConfig(ZELLE), nonChargebackableConfig)) {
    await (await riskManagerContract.setPlatformRiskConfig(ZELLE, nonChargebackableConfig)).wait();
    await waitForDeploymentDelay(hre);
  }

  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV3.address);
  console.log("OrchestratorV3 added to OrchestratorRegistry");

  await setNewOwner(hre, orchestratorV3Contract, multiSig);
  await setNewOwner(hre, riskManagerContract, multiSig);
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
