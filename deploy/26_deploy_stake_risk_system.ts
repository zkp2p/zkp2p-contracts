import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  RISK_CALLBACK_GAS_LIMIT,
  STAKE_RISK_PLATFORM_POLICY,
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
const LOCAL_CHARGEBACK_WITNESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

export function chargebackWitnessConfigForNetwork(
  network: string,
  configuredWitnesses = process.env.CHARGEBACK_WITNESS_ADDRESSES,
) {
  const witnesses = network === "localhost" || network === "hardhat"
    ? LOCAL_CHARGEBACK_WITNESSES
    : (configuredWitnesses ?? "").split(",").map((address) => address.trim()).filter(Boolean);

  if (witnesses.length !== 3) {
    throw new Error(`${network} chargeback authorization requires exactly three dedicated witnesses`);
  }
  if (new Set(witnesses.map((address) => address.toLowerCase())).size !== witnesses.length) {
    throw new Error(`${network} chargeback witnesses must be unique`);
  }
  if (witnesses.some((address) => !ethers.utils.isAddress(address))) {
    throw new Error(`${network} has an invalid chargeback witness address`);
  }

  return { witnesses, threshold: 2 };
}

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

export function stakeRiskPlatformPolicyForNetwork(network: string): any {
  const policy = STAKE_RISK_PLATFORM_POLICY[network];
  if (!policy) {
    throw new Error(`No governance-ratified stake risk platform policy for network: ${network}`);
  }
  return policy;
}

/**
 * Deploys the continuous stake-risk system against the existing EscrowV2 and registries.
 * Non-local execution requires both an explicit opt-in and a network-keyed, governance-ratified policy.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const { reversible: reversibleConfig, nonChargebackable: nonChargebackableConfig } =
    stakeRiskPlatformPolicyForNetwork(network);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;
  const chargebackWitnessConfig = chargebackWitnessConfigForNetwork(network);

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const stakeTokenAddress = USDC[network]
    ? USDC[network]
    : getDeployedContractAddress(network, "USDCMock");

  const boundedCall = await deploy("BoundedCall", { from: deployer, args: [] });
  console.log("BoundedCall deployed at", boundedCall.address);
  if (boundedCall.newlyDeployed) await waitForDeploymentDelay(hre);

  const postIntentHookExecutor = await deploy("PostIntentHookExecutor", { from: deployer, args: [] });
  console.log("PostIntentHookExecutor deployed at", postIntentHookExecutor.address);
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
  console.log("OrchestratorV3 deployed at", orchestratorV3.address);
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
  console.log("StakeVault deployed at", stakeVault.address);
  if (stakeVault.newlyDeployed) await waitForDeploymentDelay(hre);

  const chargebackAttestationVerifier = await deploy("ChargebackAttestationVerifier", {
    contract: "MultiAttestationVerifier",
    from: deployer,
    args: [chargebackWitnessConfig.witnesses, chargebackWitnessConfig.threshold],
  });
  console.log("ChargebackAttestationVerifier deployed at", chargebackAttestationVerifier.address);
  if (chargebackAttestationVerifier.newlyDeployed) await waitForDeploymentDelay(hre);

  const riskManager = await deploy("RiskManager", {
    from: deployer,
    args: [deployer, orchestratorV3.address, stakeVault.address, chargebackAttestationVerifier.address],
  });
  console.log("RiskManager deployed at", riskManager.address);
  if (riskManager.newlyDeployed) await waitForDeploymentDelay(hre);

  const deferredPayoutHook = await deploy("DeferredPayoutHook", {
    from: deployer,
    args: [stakeTokenAddress, stakeVault.address, riskManager.address, orchestratorRegistryAddress],
  });
  console.log("DeferredPayoutHook deployed at", deferredPayoutHook.address);
  if (deferredPayoutHook.newlyDeployed) await waitForDeploymentDelay(hre);

  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const chargebackAttestationVerifierContract = await ethers.getContractAt(
    "MultiAttestationVerifier",
    chargebackAttestationVerifier.address,
  );
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
  await setNewOwner(hre, chargebackAttestationVerifierContract, multiSig);
  console.log("Stake risk system ownership transferred to", multiSig);
};

func.tags = ["StakeRiskSystem"];
func.dependencies = ["16_configure_v2_payment_methods", "MultiAttestationVerifier"];
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  if (process.env.DEPLOY_STAKE_RISK_SYSTEM !== "true") return true;
  stakeRiskPlatformPolicyForNetwork(network);
  return false;
};

export default func;
