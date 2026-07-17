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
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  addWritePermission,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import {
  chargebackWitnessConfigForNetwork,
  stakeRiskPlatformPolicyForNetwork,
} from "./26_deploy_stake_risk_system";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

export const PAYMENT_ID_RISK_DEPLOYMENT_NAMES = [
  "PaymentVerifierRegistryV3",
  "UnifiedPaymentVerifierV3",
  "BoundedCallPaymentId",
  "OrchestratorV3ValidationPaymentId",
  "OrchestratorV3FeeLibPaymentId",
  "RiskCallbackRecorderPaymentId",
  "OrchestratorV3RiskLibPaymentId",
  "OrchestratorV3PaymentId",
  "StakeVaultPaymentId",
  "ChargebackAttestationVerifierPaymentId",
  "RiskManagerPaymentId",
  "DeferredPayoutHookPaymentId",
] as const;

export async function assertFreshNonLocalPaymentIdRiskDeployment(
  network: string,
  getDeployment: (name: string) => Promise<unknown | null>,
) {
  if (network === "localhost" || network === "hardhat") return;
  const existing: string[] = [];
  for (const name of PAYMENT_ID_RISK_DEPLOYMENT_NAMES) {
    if (await getDeployment(name)) existing.push(name);
  }
  if (existing.length !== 0) {
    throw new Error(
      `${network} already has payment-ID risk deployment records (${existing.join(", ")}); `
      + "use a new governance-reviewed version",
    );
  }
}

export async function requireHistoricalPostIntentHookExecutor(
  network: string,
  getDeployment: (name: string) => Promise<{ address: string } | null>,
): Promise<string> {
  const deployment = await getDeployment("PostIntentHookExecutor");
  if (!deployment) {
    throw new Error(
      `${network} requires the historical PostIntentHookExecutor deployment before the payment-ID risk lane`,
    );
  }
  return deployment.address;
}

function normalize(values: string[]): string[] {
  return values.map((value) => value.toLowerCase()).sort();
}

function equalValues(left: string[], right: string[]): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
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

async function loadLegacyPaymentConfiguration(network: string) {
  const registryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const legacyVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
  const registry = await ethers.getContractAt("PaymentVerifierRegistry", registryAddress);
  const legacyVerifier = await ethers.getContractAt("UnifiedPaymentVerifier", legacyVerifierAddress);
  const methods: string[] = await registry.getPaymentMethods();
  if (methods.length === 0 || new Set(normalize(methods)).size !== methods.length) {
    throw new Error("Legacy payment verifier registry must have a nonempty unique method set");
  }

  const configurations: Array<{ method: string; currencies: string[] }> = [];
  for (const method of methods) {
    const verifier = await registry.getVerifier(method);
    if (verifier.toLowerCase() !== legacyVerifierAddress.toLowerCase()) {
      throw new Error(`Legacy payment method ${method} is not routed to UnifiedPaymentVerifierV2`);
    }
    const currencies: string[] = await registry.getCurrencies(method);
    if (
      currencies.length === 0
      || new Set(normalize(currencies)).size !== currencies.length
      || currencies.some((currency) => currency === ethers.constants.HashZero)
    ) {
      throw new Error(`Legacy payment method ${method} has invalid currencies`);
    }
    configurations.push({ method, currencies });
  }

  const paymentAttestationVerifierAddress = await legacyVerifier.attestationVerifier();
  const paymentAttestationVerifier = await ethers.getContractAt(
    "MultiAttestationVerifier",
    paymentAttestationVerifierAddress,
  );
  const paymentWitnesses: string[] = await paymentAttestationVerifier.witnesses();
  if (paymentWitnesses.length === 0) {
    throw new Error("Live payment attestation witness set must be nonempty");
  }

  return {
    registry,
    legacyVerifier,
    legacyVerifierAddress,
    configurations,
    paymentAttestationVerifierAddress,
    paymentWitnesses,
  };
}

async function assertRegistryParity(
  legacyConfigurations: Array<{ method: string; currencies: string[] }>,
  newRegistry: any,
  newVerifier: any,
) {
  const expectedMethods = legacyConfigurations.map(({ method }) => method);
  const actualRegistryMethods: string[] = await newRegistry.getPaymentMethods();
  const actualVerifierMethods: string[] = await newVerifier.getPaymentMethods();
  if (!equalValues(actualRegistryMethods, expectedMethods) || !equalValues(actualVerifierMethods, expectedMethods)) {
    throw new Error("Payment-ID lane method set does not match the legacy lane");
  }
  for (const { method, currencies } of legacyConfigurations) {
    if ((await newRegistry.getVerifier(method)).toLowerCase() !== newVerifier.address.toLowerCase()) {
      throw new Error(`Payment-ID lane verifier mismatch for ${method}`);
    }
    if (!equalValues(await newRegistry.getCurrencies(method), currencies)) {
      throw new Error(`Payment-ID lane currency mismatch for ${method}`);
    }
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  await assertFreshNonLocalPaymentIdRiskDeployment(
    network,
    hre.deployments.getOrNull.bind(hre.deployments),
  );
  const { reversible: reversibleConfig, nonChargebackable: nonChargebackableConfig } =
    stakeRiskPlatformPolicyForNetwork(network);
  const legacy = await loadLegacyPaymentConfiguration(network);
  const chargebackWitnessConfig = chargebackWitnessConfigForNetwork(
    network,
    process.env.CHARGEBACK_WITNESS_ADDRESSES,
    legacy.paymentWitnesses,
  );
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] || deployer;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const nullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
  const postIntentHookExecutorAddress = await requireHistoricalPostIntentHookExecutor(
    network,
    hre.deployments.getOrNull.bind(hre.deployments),
  );
  const stakeTokenAddress = USDC[network] || getDeployedContractAddress(network, "USDCMock");

  const paymentVerifierRegistryV3 = await deploy("PaymentVerifierRegistryV3", {
    contract: "PaymentVerifierRegistry",
    from: deployer,
    args: [],
  });
  const unifiedPaymentVerifierV3 = await deploy("UnifiedPaymentVerifierV3", {
    from: deployer,
    args: [
      orchestratorRegistryAddress,
      nullifierRegistryAddress,
      legacy.paymentAttestationVerifierAddress,
    ],
  });
  const newRegistry = await ethers.getContractAt("PaymentVerifierRegistry", paymentVerifierRegistryV3.address);
  const newVerifier = await ethers.getContractAt("UnifiedPaymentVerifierV3", unifiedPaymentVerifierV3.address);
  for (const { method, currencies } of legacy.configurations) {
    await addPaymentMethodToUnifiedVerifier(hre, newVerifier, method);
    await addPaymentMethodToRegistry(hre, newRegistry, method, newVerifier.address, currencies);
  }
  await assertRegistryParity(legacy.configurations, newRegistry, newVerifier);

  const boundedCall = await deploy("BoundedCallPaymentId", {
    contract: "BoundedCall",
    from: deployer,
    args: [],
  });
  const orchestratorV3Validation = await deploy("OrchestratorV3ValidationPaymentId", {
    contract: "OrchestratorV3Validation",
    from: deployer,
    args: [],
  });
  const orchestratorV3FeeLib = await deploy("OrchestratorV3FeeLibPaymentId", {
    contract: "OrchestratorV3FeeLib",
    from: deployer,
    args: [],
  });
  const riskCallbackRecorder = await deploy("RiskCallbackRecorderPaymentId", {
    contract: "RiskCallbackRecorder",
    from: deployer,
    args: [],
  });
  const orchestratorV3RiskLib = await deploy("OrchestratorV3RiskLibPaymentId", {
    contract: "OrchestratorV3RiskLib",
    from: deployer,
    libraries: {
      BoundedCall: boundedCall.address,
      RiskCallbackRecorder: riskCallbackRecorder.address,
    },
    args: [],
  });
  const orchestratorV3 = await deploy("OrchestratorV3PaymentId", {
    contract: "OrchestratorV3",
    from: deployer,
    libraries: {
      BoundedCall: boundedCall.address,
      PostIntentHookExecutor: postIntentHookExecutorAddress,
      OrchestratorV3Validation: orchestratorV3Validation.address,
      OrchestratorV3FeeLib: orchestratorV3FeeLib.address,
      OrchestratorV3RiskLib: orchestratorV3RiskLib.address,
    },
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryV3.address,
      relayerRegistryAddress,
      ORCHESTRATOR_V2_PROTOCOL_FEE[network],
      ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network] || deployer,
      RISK_CALLBACK_GAS_LIMIT,
    ],
  });
  const stakeVault = await deploy("StakeVaultPaymentId", {
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
  const chargebackAttestationVerifier = await deploy("ChargebackAttestationVerifierPaymentId", {
    contract: "MultiAttestationVerifier",
    from: deployer,
    args: [chargebackWitnessConfig.witnesses, chargebackWitnessConfig.threshold],
  });
  const riskManager = await deploy("RiskManagerPaymentId", {
    contract: "RiskManager",
    from: deployer,
    args: [deployer, orchestratorV3.address, stakeVault.address, chargebackAttestationVerifier.address],
  });
  const deferredPayoutHook = await deploy("DeferredPayoutHookPaymentId", {
    contract: "DeferredPayoutHook",
    from: deployer,
    args: [stakeTokenAddress, stakeVault.address, riskManager.address, orchestratorRegistryAddress],
  });

  const vault = await ethers.getContractAt("StakeVault", stakeVault.address);
  const manager = await ethers.getContractAt("RiskManager", riskManager.address);
  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const chargebackVerifier = await ethers.getContractAt(
    "MultiAttestationVerifier",
    chargebackAttestationVerifier.address,
  );
  if ((await vault.controller()) === ethers.constants.AddressZero) {
    await (await vault.initializeController(manager.address)).wait();
    await waitForDeploymentDelay(hre);
  } else if ((await vault.controller()).toLowerCase() !== manager.address.toLowerCase()) {
    throw new Error("Payment-ID StakeVault controller mismatch");
  }
  if ((await manager.deferredPayoutHook()).toLowerCase() !== deferredPayoutHook.address.toLowerCase()) {
    await (await manager.setDeferredPayoutHook(deferredPayoutHook.address)).wait();
  }
  if (!(await orchestrator.allowMultipleIntents())) {
    await (await orchestrator.setAllowMultipleIntents(true)).wait();
  }
  for (const paymentMethod of [PAYPAL, VENMO]) {
    if (!platformRiskConfigMatches(await manager.getPlatformRiskConfig(paymentMethod), reversibleConfig)) {
      await (await manager.setPlatformRiskConfig(paymentMethod, reversibleConfig)).wait();
    }
  }
  if (!platformRiskConfigMatches(await manager.getPlatformRiskConfig(ZELLE), nonChargebackableConfig)) {
    await (await manager.setPlatformRiskConfig(ZELLE, nonChargebackableConfig)).wait();
  }

  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const nullifierRegistry = await ethers.getContractAt("NullifierRegistry", nullifierRegistryAddress);
  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestrator.address);
  await addWritePermission(hre, nullifierRegistry, newVerifier.address);
  if (!(await nullifierRegistry.isWriter(legacy.legacyVerifierAddress))) {
    throw new Error("Legacy UnifiedPaymentVerifierV2 must remain a shared nullifier writer");
  }

  await setNewOwner(hre, newRegistry, multiSig);
  await setNewOwner(hre, newVerifier, multiSig);
  await setNewOwner(hre, orchestrator, multiSig);
  await setNewOwner(hre, vault, multiSig);
  await setNewOwner(hre, manager, multiSig);
  await setNewOwner(hre, chargebackVerifier, multiSig);
};

func.tags = ["PaymentIdRiskSystem"];
func.dependencies = ["27_remove_legacy_zelle_payment_methods"];
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  if (process.env.DEPLOY_PAYMENT_ID_RISK_SYSTEM !== "true") return true;
  stakeRiskPlatformPolicyForNetwork(network);
  await assertFreshNonLocalPaymentIdRiskDeployment(
    network,
    hre.deployments.getOrNull.bind(hre.deployments),
  );
  return false;
};

export default func;
