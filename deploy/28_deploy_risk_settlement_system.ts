import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { ONE_HOUR_IN_SECONDS } from "../utils/constants";

import {
  MULTI_SIG,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  RISK_CALLBACK_GAS_LIMIT,
  RISK_WITNESS_ADDRESSES,
  RISK_WITNESS_THRESHOLD,
  STAKE_RISK_PLATFORM_POLICY,
  STAKE_VAULT_BASE_EXIT_DELAY,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import {
  addOrchestratorToRegistry,
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  addWritePermission,
  getDeployedContractAddress,
  removeOrchestratorFromRegistry,
  removePaymentMethodFromRegistry,
  removeWritePermission,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";
import { LUXON_PROVIDER_CONFIG } from "../deployments/verifiers/luxon";
import { N26_PROVIDER_CONFIG } from "../deployments/verifiers/n26";
import {
  ZELLE_BOFA_PROVIDER_CONFIG,
  ZELLE_CHASE_PROVIDER_CONFIG,
  ZELLE_CITI_PROVIDER_CONFIG,
  ZELLE_PROVIDER_CONFIG,
} from "../deployments/verifiers/zelle";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));
const RETIRED_PAYMENT_METHODS = [
  N26_PROVIDER_CONFIG.paymentMethodHash,
  LUXON_PROVIDER_CONFIG.paymentMethodHash,
  ZELLE_CITI_PROVIDER_CONFIG.paymentMethodHash,
  ZELLE_CHASE_PROVIDER_CONFIG.paymentMethodHash,
  ZELLE_BOFA_PROVIDER_CONFIG.paymentMethodHash,
];

function platformRiskConfigMatches(actual: any, expected: any): boolean {
  return actual.enabled === expected.enabled
    && actual.chargeback.chargebackable === expected.chargeback.chargebackable
    && actual.chargeback.deferredPayoutEnabled === expected.chargeback.deferredPayoutEnabled
    && ethers.BigNumber.from(actual.chargeback.reserveBps).eq(expected.chargeback.reserveBps)
    && ethers.BigNumber.from(actual.chargeback.riskWindow).eq(expected.chargeback.riskWindow)
    && ethers.BigNumber.from(actual.intentExtension.extensionPenaltyBpsPerHour)
      .eq(expected.intentExtension.extensionPenaltyBpsPerHour);
}

export function riskSettlementPlatformPolicyForNetwork(network: string): any {
  const policy = STAKE_RISK_PLATFORM_POLICY[network];
  if (!policy) {
    throw new Error(`No governance-ratified risk-settlement platform policy for network: ${network}`);
  }
  return policy;
}

export function riskWitnessConfigForNetwork(network: string): { witnesses: string[]; threshold: number } {
  const witnesses = RISK_WITNESS_ADDRESSES[network];
  const threshold = RISK_WITNESS_THRESHOLD[network];
  if (!witnesses || witnesses.length === 0 || !threshold || threshold > witnesses.length) {
    throw new Error(`No governance-ratified chargeback witness policy for network: ${network}`);
  }
  return { witnesses, threshold };
}

/**
 * Fresh, one-way payment-binding and risk-settlement cutover.
 *
 * The retired staging-only script 26 has been removed from the active source tree. Historical
 * deployment artifacts remain immutable. This script deploys a new vault generation, removes every
 * legacy-nullifier writer, rotates the shared payment registry to UPV3, and installs OrchestratorV3
 * without the retired DeferredPayoutHook path.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy, getOrNull, save } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const { reversible: reversibleConfig, nonChargebackable: nonChargebackableConfig } =
    riskSettlementPlatformPolicyForNetwork(network);
  const riskWitnessConfig = riskWitnessConfigForNetwork(network);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] || deployer;

  const legacyNullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");
  const paymentAttestationVerifierAddress = getDeployedContractAddress(network, "MultiAttestationVerifier");
  const stakeTokenAddress = USDC[network]
    ? USDC[network]
    : getDeployedContractAddress(network, "USDCMock");

  const previousOrchestrator = await getOrNull("OrchestratorV3");
  const paymentVerifierRegistry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    paymentVerifierRegistryAddress,
  );
  const activePaymentMethods: Array<{ method: string; currencies: string[]; verifier: string }> = [];
  for (const method of await paymentVerifierRegistry.getPaymentMethods()) {
    if (RETIRED_PAYMENT_METHODS.includes(method)) continue;
    activePaymentMethods.push({
      method,
      currencies: await paymentVerifierRegistry.getCurrencies(method),
      verifier: await paymentVerifierRegistry.getVerifier(method),
    });
  }
  if (!activePaymentMethods.some(({ method }) => method === ZELLE_PROVIDER_CONFIG.paymentMethodHash)) {
    activePaymentMethods.push({
      method: ZELLE_PROVIDER_CONFIG.paymentMethodHash,
      currencies: ZELLE_PROVIDER_CONFIG.currencies,
      verifier: ethers.constants.AddressZero,
    });
  }
  if (activePaymentMethods.length === 0) throw new Error("PaymentVerifierRegistry has no active methods");

  const nullifierRegistryV2 = await deploy("NullifierRegistryV2", {
    from: deployer,
    args: [legacyNullifierRegistryAddress],
  });
  console.log("NullifierRegistryV2 deployed at", nullifierRegistryV2.address);
  if (nullifierRegistryV2.newlyDeployed) await waitForDeploymentDelay(hre);

  const unifiedPaymentVerifierV3 = await deploy("UnifiedPaymentVerifierV3", {
    from: deployer,
    args: [
      orchestratorRegistryAddress,
      nullifierRegistryV2.address,
      paymentAttestationVerifierAddress,
    ],
  });
  console.log("UnifiedPaymentVerifierV3 deployed at", unifiedPaymentVerifierV3.address);
  if (unifiedPaymentVerifierV3.newlyDeployed) await waitForDeploymentDelay(hre);

  const riskAttestationVerifier = await deploy("RiskAttestationVerifier", {
    contract: "MultiAttestationVerifier",
    from: deployer,
    args: [riskWitnessConfig.witnesses, riskWitnessConfig.threshold],
  });
  console.log("RiskAttestationVerifier deployed at", riskAttestationVerifier.address);
  if (riskAttestationVerifier.newlyDeployed) await waitForDeploymentDelay(hre);

  const nullifierRegistryV2Contract = await ethers.getContractAt(
    "NullifierRegistryV2",
    nullifierRegistryV2.address,
  );
  const unifiedPaymentVerifierV3Contract = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3",
    unifiedPaymentVerifierV3.address,
  );
  for (const { method } of activePaymentMethods) {
    await addPaymentMethodToUnifiedVerifier(hre, unifiedPaymentVerifierV3Contract, method);
  }

  const boundedCall = await deploy("BoundedCall", { from: deployer, args: [] });
  console.log("BoundedCall deployed at", boundedCall.address);
  if (boundedCall.newlyDeployed) await waitForDeploymentDelay(hre);

  const postIntentHookExecutor = await deploy("PostIntentHookExecutor", { from: deployer, args: [] });
  console.log("PostIntentHookExecutor deployed at", postIntentHookExecutor.address);
  if (postIntentHookExecutor.newlyDeployed) await waitForDeploymentDelay(hre);

  const riskSettlementExecutor = await deploy("RiskSettlementExecutor", {
    from: deployer,
    libraries: { BoundedCall: boundedCall.address },
    args: [],
  });
  console.log("RiskSettlementExecutor deployed at", riskSettlementExecutor.address);
  if (riskSettlementExecutor.newlyDeployed) await waitForDeploymentDelay(hre);

  const feeSettlementLib = await deploy("FeeSettlementLib", {
    from: deployer,
    libraries: {
      PostIntentHookExecutor: postIntentHookExecutor.address,
      RiskSettlementExecutor: riskSettlementExecutor.address,
    },
    args: [],
  });
  console.log("FeeSettlementLib deployed at", feeSettlementLib.address);
  if (feeSettlementLib.newlyDeployed) await waitForDeploymentDelay(hre);

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
      relayerRegistryAddress,
      ORCHESTRATOR_V2_PROTOCOL_FEE[network],
      ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network] || deployer,
      RISK_CALLBACK_GAS_LIMIT,
    ],
  });
  console.log("OrchestratorV3 deployed at", orchestratorV3.address);
  if (orchestratorV3.newlyDeployed) await waitForDeploymentDelay(hre);

  // The legacy staging vault may already have an immutable controller. Deploy under a fresh name,
  // then save the new generation as the canonical StakeVault artifact for downstream exports.
  const stakeVault = await deploy("StakeVaultRiskSettlement", {
    contract: "StakeVault",
    from: deployer,
    args: [
      deployer,
      stakeTokenAddress,
      ethers.constants.AddressZero,
      STAKE_VAULT_BASE_EXIT_DELAY,
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ],
  });
  await save("StakeVault", stakeVault);
  console.log("StakeVault deployed at", stakeVault.address);
  if (stakeVault.newlyDeployed) await waitForDeploymentDelay(hre);

  const riskManager = await deploy("RiskManager", {
    from: deployer,
    args: [
      deployer,
      orchestratorV3.address,
      stakeVault.address,
      riskAttestationVerifier.address,
      nullifierRegistryV2.address,
    ],
  });
  console.log("RiskManager deployed at", riskManager.address);
  if (riskManager.newlyDeployed) await waitForDeploymentDelay(hre);

  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const riskManagerContract = await ethers.getContractAt("RiskManager", riskManager.address);
  const orchestratorV3Contract = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const escrowV2Contract = await ethers.getContractAt("EscrowV2", escrowV2Address);
  const riskAttestationVerifierContract = await ethers.getContractAt(
    "MultiAttestationVerifier",
    riskAttestationVerifier.address,
  );

  const currentController = await stakeVaultContract.controller();
  if (currentController === ethers.constants.AddressZero) {
    await (await stakeVaultContract.initializeController(riskManager.address)).wait();
    await waitForDeploymentDelay(hre);
  } else if (currentController.toLowerCase() !== riskManager.address.toLowerCase()) {
    throw new Error(`StakeVault controller mismatch: expected ${riskManager.address}, found ${currentController}`);
  }

  if (!(await orchestratorV3Contract.allowMultipleIntents())) {
    await (await orchestratorV3Contract.setAllowMultipleIntents(true)).wait();
    await waitForDeploymentDelay(hre);
  }

  if (!(await escrowV2Contract.intentExpirationPeriod()).eq(ONE_HOUR_IN_SECONDS)) {
    const escrowOwner = await escrowV2Contract.owner();
    const ownerIsLocalSigner = (await hre.getUnnamedAccounts()).includes(escrowOwner);
    if (ownerIsLocalSigner) {
      await (await escrowV2Contract.setIntentExpirationPeriod(ONE_HOUR_IN_SECONDS)).wait();
      await waitForDeploymentDelay(hre);
    } else {
      safeBatchCollector.add(
        escrowV2Contract.address,
        escrowV2Contract.interface.encodeFunctionData("setIntentExpirationPeriod", [ONE_HOUR_IN_SECONDS]),
        "EscrowV2.setIntentExpirationPeriod(1 hour)",
      );
    }
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
  if (previousOrchestrator && previousOrchestrator.address.toLowerCase() !== orchestratorV3.address.toLowerCase()) {
    await removeOrchestratorFromRegistry(hre, orchestratorRegistry, previousOrchestrator.address);
  }

  // Transfer the new registry first so authorization, legacy revocation, and route rotation are one
  // governance batch on live networks. The new registry is not live until the final route changes.
  await setNewOwner(hre, nullifierRegistryV2Contract, multiSig);
  await addWritePermission(hre, nullifierRegistryV2Contract, unifiedPaymentVerifierV3.address);

  // One-way replay cutover: authorize UPV3, close every legacy writer, then route every active method.
  // On live networks these calls are emitted in this exact order in one Safe batch.
  const legacyNullifierRegistry = await ethers.getContractAt(
    "NullifierRegistry",
    legacyNullifierRegistryAddress,
  );
  for (const legacyWriter of await legacyNullifierRegistry.getWriters()) {
    await removeWritePermission(hre, legacyNullifierRegistry, legacyWriter);
  }

  const registryOwner = await paymentVerifierRegistry.owner();
  const registryOwnerIsLocalSigner = (await hre.getUnnamedAccounts()).includes(registryOwner);
  for (const retiredMethod of RETIRED_PAYMENT_METHODS) {
    await removePaymentMethodFromRegistry(hre, paymentVerifierRegistry, retiredMethod);
  }
  for (const { method, currencies, verifier } of activePaymentMethods) {
    if (verifier.toLowerCase() === unifiedPaymentVerifierV3.address.toLowerCase()) continue;

    await removePaymentMethodFromRegistry(hre, paymentVerifierRegistry, method);
    if (!registryOwnerIsLocalSigner) {
      const addCalldata = paymentVerifierRegistry.interface.encodeFunctionData("addPaymentMethod", [
        method,
        unifiedPaymentVerifierV3.address,
        currencies,
      ]);
      safeBatchCollector.add(
        paymentVerifierRegistry.address,
        addCalldata,
        `PaymentVerifierRegistry.addPaymentMethod(${method.slice(0, 10)}..., ${unifiedPaymentVerifierV3.address})`,
      );
    } else {
      await addPaymentMethodToRegistry(
        hre,
        paymentVerifierRegistry,
        method,
        unifiedPaymentVerifierV3.address,
        currencies,
      );
    }
  }

  await setNewOwner(hre, orchestratorV3Contract, multiSig);
  await setNewOwner(hre, riskManagerContract, multiSig);
  await setNewOwner(hre, stakeVaultContract, multiSig);
  await setNewOwner(hre, unifiedPaymentVerifierV3Contract, multiSig);
  await setNewOwner(hre, nullifierRegistryV2Contract, multiSig);
  await setNewOwner(hre, riskAttestationVerifierContract, multiSig);
  console.log("Payment-binding and risk-settlement system ownership transferred to", multiSig);
};

func.tags = ["RiskSettlementSystem"];
func.dependencies = ["16_configure_v2_payment_methods", "MultiAttestationVerifier"];
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  if (process.env.DEPLOY_RISK_SETTLEMENT_SYSTEM !== "true") return true;
  riskSettlementPlatformPolicyForNetwork(network);
  riskWitnessConfigForNetwork(network);
  return false;
};

export default func;
