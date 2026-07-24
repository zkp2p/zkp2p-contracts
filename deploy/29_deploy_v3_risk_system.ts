import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR,
  MULTI_SIG,
  MULTI_WITNESS_ADDRESSES,
  MULTI_WITNESS_THRESHOLD,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  RISK_CALLBACK_GAS_LIMIT,
  RISK_MAKER_INIT,
  STAKE_RISK_PLATFORM_POLICY,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import {
  addEscrowToRegistry,
  addOrchestratorToRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

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

function platformRiskConfigMatches(actual: PlatformRiskConfig, expected: PlatformRiskConfig): boolean {
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

async function v3RiskSystemFullyWired(network: string): Promise<boolean> {
  const policy = riskPlatformPolicyForNetwork(network);
  const extensionFeeBps = INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network];
  if (extensionFeeBps === undefined) {
    throw new Error(`No IntentGuardian extension fee configured for network: ${network}`);
  }

  const stakeVaultAddress = getDeployedContractAddress(network, "StakeVault");
  const riskManagerAddress = getDeployedContractAddress(network, "RiskManager");
  const orchestratorV3Address = getDeployedContractAddress(network, "OrchestratorV3");
  const intentGuardianAddress = getDeployedContractAddress(network, "IntentGuardian");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");

  const stakeVault = await ethers.getContractAt("StakeVault", stakeVaultAddress);
  const riskManager = await ethers.getContractAt("RiskManager", riskManagerAddress);
  const orchestratorV3 = await ethers.getContractAt("OrchestratorV3", orchestratorV3Address);
  const intentGuardian = await ethers.getContractAt("IntentGuardian", intentGuardianAddress);
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    paymentVerifierRegistryAddress
  );
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);

  if ((await stakeVault.controller()).toLowerCase() !== riskManagerAddress.toLowerCase()) {
    return false;
  }

  const paymentMethods = await paymentVerifierRegistry.getPaymentMethods();
  for (const paymentMethod of paymentMethods) {
    const expectedConfig = CHARGEBACKABLE_PAYMENT_METHODS.has(paymentMethod)
      ? policy.reversible
      : policy.nonChargebackable;
    const actualConfig = await riskManager.getPlatformRiskConfig(paymentMethod);
    if (!platformRiskConfigMatches(actualConfig, expectedConfig)) {
      return false;
    }
  }

  if (!(await riskManager.makerConfigsInitialized())) {
    return false;
  }
  if ((await orchestratorV3.defaultRiskHook()).toLowerCase() !== riskManagerAddress.toLowerCase()) {
    return false;
  }
  if (!(await orchestratorRegistry.isOrchestrator(orchestratorV3Address))) {
    return false;
  }
  if (!(await intentGuardian.extensionFeeBpsPerHour()).eq(extensionFeeBps)) {
    return false;
  }

  // owner() is deliberately not checked because Ownable2Step keeps the deployer as owner
  // until the multisig accepts ownership.
  return true;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy, save, getOrNull } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] || deployer;
  const policy = riskPlatformPolicyForNetwork(network);

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");
  const legacyNullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
  const stakeToken = USDC[network]
    ? USDC[network]
    : getDeployedContractAddress(network, "USDCMock");
  const extensionFeeBps = INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network];
  if (extensionFeeBps === undefined) {
    throw new Error(`No IntentGuardian extension fee configured for network: ${network}`);
  }

  const existingNullifierRegistryV2 = await getOrNull("NullifierRegistryV2");
  const nullifierRegistryV2 = existingNullifierRegistryV2 ?? await deploy("NullifierRegistryV2", {
    from: deployer,
    args: [legacyNullifierRegistryAddress],
  });
  if (!existingNullifierRegistryV2) {
    console.log("NullifierRegistryV2 deployed at", nullifierRegistryV2.address);
    await waitForDeploymentDelay(hre);
  }

  const riskWitnesses = MULTI_WITNESS_ADDRESSES[network];
  const riskWitnessThreshold = MULTI_WITNESS_THRESHOLD[network];
  if (!riskWitnesses || riskWitnesses.length === 0) {
    throw new Error(`No RiskAttestationVerifier witnesses configured for ${network}`);
  }
  if (!riskWitnessThreshold) {
    throw new Error(`No RiskAttestationVerifier threshold configured for ${network}`);
  }

  const existingRiskAttestationVerifier = await getOrNull("RiskAttestationVerifier");
  const riskAttestationVerifier = existingRiskAttestationVerifier ?? await deploy("RiskAttestationVerifier", {
    contract: "MultiAttestationVerifier",
    from: deployer,
    args: [riskWitnesses, riskWitnessThreshold],
  });
  if (!existingRiskAttestationVerifier) {
    console.log("RiskAttestationVerifier deployed at", riskAttestationVerifier.address);
    await waitForDeploymentDelay(hre);
  }

  const boundedCall = await deploy("BoundedCall", {
    from: deployer,
    args: [],
  });
  if (boundedCall.newlyDeployed) {
    console.log("BoundedCall deployed at", boundedCall.address);
    await waitForDeploymentDelay(hre);
  }

  const postIntentHookExecutor = await deploy("PostIntentHookExecutor", {
    from: deployer,
    args: [],
  });
  if (postIntentHookExecutor.newlyDeployed) {
    console.log("PostIntentHookExecutor deployed at", postIntentHookExecutor.address);
    await waitForDeploymentDelay(hre);
  }

  const riskSettlementExecutor = await deploy("RiskSettlementExecutor", {
    from: deployer,
    libraries: { BoundedCall: boundedCall.address },
    args: [],
  });
  if (riskSettlementExecutor.newlyDeployed) {
    console.log("RiskSettlementExecutor deployed at", riskSettlementExecutor.address);
    await waitForDeploymentDelay(hre);
  }

  const feeSettlementLib = await deploy("FeeSettlementLib", {
    from: deployer,
    libraries: {
      PostIntentHookExecutor: postIntentHookExecutor.address,
      RiskSettlementExecutor: riskSettlementExecutor.address,
    },
    args: [],
  });
  if (feeSettlementLib.newlyDeployed) {
    console.log("FeeSettlementLib deployed at", feeSettlementLib.address);
    await waitForDeploymentDelay(hre);
  }

  const addressGroupRegistry = await deploy("AddressGroupRegistry", {
    from: deployer,
    args: [],
  });
  if (addressGroupRegistry.newlyDeployed) {
    console.log("AddressGroupRegistry deployed at", addressGroupRegistry.address);
    await waitForDeploymentDelay(hre);
  }

  const orchestratorV3 = await deploy("OrchestratorV3", {
    from: deployer,
    libraries: {
      BoundedCall: boundedCall.address,
      FeeSettlementLib: feeSettlementLib.address,
    },
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      ORCHESTRATOR_V2_PROTOCOL_FEE[network],
      ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network] || deployer,
      RISK_CALLBACK_GAS_LIMIT,
    ],
  });
  if (orchestratorV3.newlyDeployed) {
    console.log("OrchestratorV3 deployed at", orchestratorV3.address);
    await waitForDeploymentDelay(hre);
  }

  const stakeVault = await deploy("StakeVaultV3", {
    contract: "StakeVault",
    from: deployer,
    args: [deployer, stakeToken, ethers.constants.AddressZero, STAKE_VAULT_CONTROLLER_CHANGE_DELAY],
  });
  if (stakeVault.newlyDeployed) {
    console.log("StakeVaultV3 deployed at", stakeVault.address);
    await waitForDeploymentDelay(hre);
  }
  await save("StakeVault", stakeVault);

  const riskManager = await deploy("RiskManager", {
    from: deployer,
    args: [
      deployer,
      orchestratorV3.address,
      stakeVault.address,
      riskAttestationVerifier.address,
      nullifierRegistryV2.address,
      addressGroupRegistry.address,
    ],
  });
  if (riskManager.newlyDeployed) {
    console.log("RiskManager deployed at", riskManager.address);
    await waitForDeploymentDelay(hre);
  }

  const intentGuardian = await deploy("IntentGuardian", {
    from: deployer,
    args: [deployer, escrowRegistryAddress],
  });
  if (intentGuardian.newlyDeployed) {
    console.log("IntentGuardian deployed at", intentGuardian.address);
    await waitForDeploymentDelay(hre);
  }

  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const riskManagerContract = await ethers.getContractAt("RiskManager", riskManager.address);
  const orchestratorV3Contract = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const intentGuardianContract = await ethers.getContractAt("IntentGuardian", intentGuardian.address);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    paymentVerifierRegistryAddress
  );

  const currentController = await stakeVaultContract.controller();
  if (currentController === ethers.constants.AddressZero) {
    await (await stakeVaultContract.initializeController(riskManager.address)).wait();
    console.log("StakeVault controller initialized to", riskManager.address);
    await waitForDeploymentDelay(hre);
  } else if (currentController.toLowerCase() !== riskManager.address.toLowerCase()) {
    throw new Error(
      `StakeVault controller ${currentController} does not match RiskManager ${riskManager.address}`
    );
  }

  const paymentMethods = await paymentVerifierRegistry.getPaymentMethods();
  for (const paymentMethod of paymentMethods) {
    const expectedConfig = CHARGEBACKABLE_PAYMENT_METHODS.has(paymentMethod)
      ? policy.reversible
      : policy.nonChargebackable;
    const actualConfig = await riskManagerContract.getPlatformRiskConfig(paymentMethod);
    if (!platformRiskConfigMatches(actualConfig, expectedConfig)) {
      await (await riskManagerContract.setPlatformRiskConfig(paymentMethod, expectedConfig)).wait();
      console.log("RiskManager platform policy configured for", paymentMethod);
      await waitForDeploymentDelay(hre);
    }
  }

  if (!(await riskManagerContract.makerConfigsInitialized())) {
    const makerInits = RISK_MAKER_INIT[network] ?? [];
    await (await riskManagerContract.initializeMakerConfigs(makerInits)).wait();
    console.log(`RiskManager maker configs initialized with ${makerInits.length} maker(s)`);
    await waitForDeploymentDelay(hre);
  }

  if ((await orchestratorV3Contract.defaultRiskHook()).toLowerCase() !== riskManager.address.toLowerCase()) {
    await (await orchestratorV3Contract.setDefaultRiskHook(riskManager.address)).wait();
    console.log("OrchestratorV3 default risk hook set to", riskManager.address);
    await waitForDeploymentDelay(hre);
  }

  // A zero fee disables extensions entirely.
  if (!(await intentGuardianContract.extensionFeeBpsPerHour()).eq(extensionFeeBps)) {
    await (await intentGuardianContract.setExtensionFeeBpsPerHour(extensionFeeBps)).wait();
    console.log("IntentGuardian extension fee set to", extensionFeeBps, "bps per hour");
    await waitForDeploymentDelay(hre);
  }

  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV3.address);
  console.log("OrchestratorV3 added to OrchestratorRegistry");
  await addEscrowToRegistry(hre, escrowRegistry, escrowV2Address);
  console.log("EscrowV2 added to EscrowRegistry");

  // MULTI_SIG.base_staging is empty, so multiSig resolves to the deployer there.
  await setNewOwner(hre, stakeVaultContract, multiSig);
  await setNewOwner(hre, riskManagerContract, multiSig);
  await setNewOwner(hre, orchestratorV3Contract, multiSig);
  await setNewOwner(hre, intentGuardianContract, multiSig);

  console.log("============================================================");
  console.log("V3 risk system deployment summary");
  console.log("AddressGroupRegistry:", addressGroupRegistry.address);
  console.log("OrchestratorV3:", orchestratorV3.address);
  console.log("StakeVault:", stakeVault.address);
  console.log("RiskManager:", riskManager.address);
  console.log("************************************************************");
  console.log("INTENT GUARDIAN:", intentGuardian.address);
  console.log("Makers must pass this address as the deposit intentGuardian at deposit creation.");
  console.log("EscrowV2 only accepts the intentGuardian at creation time.");
  console.log("************************************************************");
  console.log("============================================================");
};

func.skip = async (hre) => {
  if (process.env.FORCE_RERUN_V3_RISK_DEPLOY === "true") return false;
  const network = hre.deployments.getNetworkName();
  if (!STAKE_RISK_PLATFORM_POLICY[network]) return true;
  try {
    return await v3RiskSystemFullyWired(network);
  } catch (error) {
    return false;
  }
};

func.tags = ["29_deploy_v3_risk_system"];
func.dependencies = ["16_configure_v2_payment_methods"];

export default func;
