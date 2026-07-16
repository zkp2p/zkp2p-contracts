import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  MULTI_WITNESS_ADDRESSES,
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
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
];
const STAKE_RISK_DEPLOYMENT_NAMES = [
  "BoundedCall",
  "PostIntentHookExecutor",
  "SettlementHookExecutor",
  "OrchestratorV3",
  "StakeVault",
  "ChargebackAttestationVerifier",
  "RiskManager",
  "DeferredPayoutHook",
] as const;

export function chargebackWitnessConfigForNetwork(
  network: string,
  configuredWitnesses = process.env.CHARGEBACK_WITNESS_ADDRESSES,
  paymentWitnesses = MULTI_WITNESS_ADDRESSES[network]
    ?? (process.env.PAYMENT_ATTESTATION_WITNESS_ADDRESSES ?? "")
      .split(",").map((address) => address.trim()).filter(Boolean),
) {
  // Fresh-deployment guard only: a future migration must read the live payment-verifier
  // witness set onchain and compare it before governance executes the migration.
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
  if (paymentWitnesses.length === 0) {
    throw new Error(`${network} payment witnesses must be explicit before configuring chargeback witnesses`);
  }
  const paymentWitnessSet = new Set(paymentWitnesses.map((address) => address.toLowerCase()));
  if (witnesses.some((address) => paymentWitnessSet.has(address.toLowerCase()))) {
    throw new Error(`${network} chargeback witnesses must be disjoint from payment witnesses`);
  }

  return { witnesses, threshold: 2 };
}

/**
 * Existing named deployments need an explicit versioned migration. Refusing before `deploy()` is
 * called prevents source-metadata drift from silently replacing OrchestratorV3 and then discovering
 * that the one-time StakeVault controller is already bound to the previous RiskManager.
 */
export async function assertFreshNonLocalStakeRiskDeployment(
  network: string,
  getDeployment: (name: string) => Promise<unknown | null>,
) {
  if (network === "localhost" || network === "hardhat") return;
  const existing: string[] = [];
  for (const name of STAKE_RISK_DEPLOYMENT_NAMES) {
    if (await getDeployment(name)) existing.push(name);
  }
  if (existing.length !== 0) {
    throw new Error(
      `${network} already has stake-risk deployment records (${existing.join(", ")}); `
      + "use a separately named, governance-reviewed migration",
    );
  }
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
  await assertFreshNonLocalStakeRiskDeployment(network, hre.deployments.getOrNull.bind(hre.deployments));
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

  const settlementHookExecutor = await deploy("SettlementHookExecutor", { from: deployer, args: [] });
  console.log("SettlementHookExecutor deployed at", settlementHookExecutor.address);
  if (settlementHookExecutor.newlyDeployed) await waitForDeploymentDelay(hre);

  const orchestratorV3 = await deploy("OrchestratorV3", {
    from: deployer,
    libraries: {
      BoundedCall: boundedCall.address,
      SettlementHookExecutor: settlementHookExecutor.address,
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
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  if (process.env.DEPLOY_STAKE_RISK_SYSTEM !== "true") return true;
  stakeRiskPlatformPolicyForNetwork(network);
  await assertFreshNonLocalStakeRiskDeployment(network, hre.deployments.getOrNull.bind(hre.deployments));
  return false;
};

export default func;
