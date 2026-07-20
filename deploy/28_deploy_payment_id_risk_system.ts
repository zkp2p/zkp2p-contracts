import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  Deployment,
  DeploymentSubmission,
  DeployFunction,
  DeployOptions,
} from "hardhat-deploy/types";
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
  removePaymentMethodFromRegistry,
  removeWritePermission,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import {
  chargebackWitnessConfigForNetwork,
  stakeRiskPlatformPolicyForNetwork,
} from "./26_deploy_stake_risk_system";
import { safeBatchCollector } from "../deployments/safeBatchCollector";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

export const PAYMENT_ID_RISK_DEPLOYMENT_NAMES = [
  "NullifierRegistryV2",
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

export const BASE_STAGING_FINAL_CANONICAL_ALIASES = [
  ["BoundedCall", "BoundedCallPaymentId", "BoundedCallPreFinalAffine"],
  ["OrchestratorV3Validation", "OrchestratorV3ValidationPaymentId", "OrchestratorV3ValidationPreFinalAffine"],
  ["OrchestratorV3FeeLib", "OrchestratorV3FeeLibPaymentId", "OrchestratorV3FeeLibPreFinalAffine"],
  ["RiskCallbackRecorder", "RiskCallbackRecorderPaymentId", "RiskCallbackRecorderPreFinalAffine"],
  ["OrchestratorV3RiskLib", "OrchestratorV3RiskLibPaymentId", "OrchestratorV3RiskLibPreFinalAffine"],
  ["OrchestratorV3", "OrchestratorV3PaymentId", "OrchestratorV3PreFinalAffine"],
  ["StakeVault", "StakeVaultPaymentId", "StakeVaultPreFinalAffine"],
  ["RiskManager", "RiskManagerPaymentId", "RiskManagerPreFinalAffine"],
  ["DeferredPayoutHook", "DeferredPayoutHookPaymentId", "DeferredPayoutHookPreFinalAffine"],
] as const;

type ExistingDeploymentStatus = "missing" | "matching" | "different";

export async function assertResumableNonLocalPaymentIdRiskDeployment(
  network: string,
  inspectDeployment: (name: typeof PAYMENT_ID_RISK_DEPLOYMENT_NAMES[number]) =>
    Promise<ExistingDeploymentStatus>,
) {
  if (network === "localhost" || network === "hardhat") return;
  let missingDependency = false;
  for (const name of PAYMENT_ID_RISK_DEPLOYMENT_NAMES) {
    const status = await inspectDeployment(name);
    if (status === "missing") {
      missingDependency = true;
      continue;
    }
    if (missingDependency) {
      throw new Error(`${network} has an impossible non-prefix payment-ID deployment record at ${name}`);
    }
    if (status === "different") {
      throw new Error(
        `${network} payment-ID deployment record ${name} differs from the reviewed bytecode, libraries, or arguments`,
      );
    }
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

export function paymentIdRiskPlatformPolicyForNetwork(network: string) {
  const policy = stakeRiskPlatformPolicyForNetwork(network);
  return {
    reversible: {
      ...policy.reversible,
      chargeback: {
        ...policy.reversible.chargeback,
        deferredPayoutEnabled: true,
      },
    },
    nonChargebackable: policy.nonChargebackable,
  };
}

export function assertCanonicalHardCutAuthorizations(state: {
  orchestratorRegistered: boolean;
  newVerifierWriter: boolean;
  legacyVerifierRevoked: boolean;
  paymentMethodsRouted: boolean;
  nullifierPredecessorMatches: boolean;
  managerNullifierRegistryMatches: boolean;
  orchestratorVerifierRegistryMatches: boolean;
  orchestratorEscrowRegistryMatches: boolean;
  escrowAuthorized: boolean;
  escrowOrchestratorRegistryMatches: boolean;
}) {
  if (!state.orchestratorRegistered) {
    throw new Error("Payment-ID OrchestratorV3 registry admission must be executed before canonical hard-cut");
  }
  if (!state.newVerifierWriter) {
    throw new Error("UnifiedPaymentVerifierV3 write permission must be executed before canonical hard-cut");
  }
  if (!state.legacyVerifierRevoked) {
    throw new Error("Retired UnifiedPaymentVerifierV2 legacy-registry write permission must be revoked");
  }
  if (!state.paymentMethodsRouted) {
    throw new Error("Every payment method must be routed to UnifiedPaymentVerifierV3");
  }
  if (!state.nullifierPredecessorMatches) {
    throw new Error("NullifierRegistryV2 predecessor mismatch");
  }
  if (!state.managerNullifierRegistryMatches) {
    throw new Error("RiskManager NullifierRegistryV2 mismatch");
  }
  if (!state.orchestratorVerifierRegistryMatches) {
    throw new Error("Payment-ID OrchestratorV3 verifier registry mismatch");
  }
  if (!state.orchestratorEscrowRegistryMatches) {
    throw new Error("Payment-ID OrchestratorV3 escrow registry mismatch");
  }
  if (!state.escrowAuthorized) {
    throw new Error("EscrowV2 must remain authorized before canonical hard-cut");
  }
  if (!state.escrowOrchestratorRegistryMatches) {
    throw new Error("EscrowV2 orchestrator registry mismatch");
  }
}

export async function saveCanonicalBaseStagingAliases(
  network: string,
  getDeployment: (name: string) => Promise<Deployment>,
  getDeploymentOrNull: (name: string) => Promise<Deployment | null>,
  saveDeployment: (name: string, deployment: DeploymentSubmission) => Promise<void>,
) {
  if (network !== "base_staging") return;

  const aliases: Array<{
    canonicalName: string;
    finalDeployment: Deployment;
    archiveName: string;
    canonicalDeployment: Deployment | null;
    archivedDeployment: Deployment | null;
  }> = [];
  for (const [canonicalName, finalName, archiveName] of BASE_STAGING_FINAL_CANONICAL_ALIASES) {
    const finalDeployment = await getDeployment(finalName);
    const canonicalDeployment = await getDeploymentOrNull(canonicalName);
    const archivedDeployment = archiveName ? await getDeploymentOrNull(archiveName) : null;
    if (
      archiveName
      && canonicalDeployment
      && canonicalDeployment.address.toLowerCase() !== finalDeployment.address.toLowerCase()
    ) {
      if (archivedDeployment && !sameDeploymentRecord(archivedDeployment, canonicalDeployment)) {
        throw new Error(`${archiveName} already preserves a different historical deployment`);
      }
    }
    aliases.push({ canonicalName, finalDeployment, archiveName, canonicalDeployment, archivedDeployment });
  }

  for (const { canonicalName, finalDeployment, archiveName, canonicalDeployment, archivedDeployment } of aliases) {
    if (
      archiveName
      && canonicalDeployment
      && canonicalDeployment.address.toLowerCase() !== finalDeployment.address.toLowerCase()
      && !archivedDeployment
    ) {
      await saveDeployment(archiveName, canonicalDeployment);
    }
    await saveDeployment(canonicalName, finalDeployment);
  }
}

function sameDeploymentRecord(left: Deployment, right: Deployment): boolean {
  const identity = (deployment: Deployment) => JSON.stringify({
    address: deployment.address.toLowerCase(),
    transactionHash: deployment.transactionHash?.toLowerCase() ?? null,
    args: deployment.args ?? [],
    libraries: Object.entries(deployment.libraries ?? {})
      .map(([name, address]) => [name, address.toLowerCase()])
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
    solcInputHash: deployment.solcInputHash ?? null,
    bytecode: deployment.bytecode ?? null,
    deployedBytecode: deployment.deployedBytecode ?? null,
  });
  return identity(left) === identity(right);
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
    && ethers.BigNumber.from(actual.griefing.baseUnbondedAmount).eq(expected.griefing.baseUnbondedAmount);
}

async function loadLegacyPaymentConfiguration(network: string, pendingNewVerifierAddress?: string) {
  const registryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const legacyVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
  const registry = await ethers.getContractAt("PaymentVerifierRegistry", registryAddress);
  const legacyVerifier = await ethers.getContractAt("UnifiedPaymentVerifier", legacyVerifierAddress);
  const methods: string[] = await registry.getPaymentMethods();
  if (methods.length === 0 || new Set(normalize(methods)).size !== methods.length) {
    throw new Error("Legacy payment verifier registry must have a nonempty unique method set");
  }

  const configurations: Array<{ method: string; currencies: string[] }> = [];
  const routedVerifiers = new Set<string>();
  for (const method of methods) {
    const verifier = await registry.getVerifier(method);
    const normalizedVerifier = verifier.toLowerCase();
    const normalizedLegacyVerifier = legacyVerifierAddress.toLowerCase();
    const normalizedNewVerifier = pendingNewVerifierAddress?.toLowerCase();
    if (normalizedVerifier !== normalizedLegacyVerifier && normalizedVerifier !== normalizedNewVerifier) {
      throw new Error(`Payment method ${method} is routed to an unexpected verifier ${verifier}`);
    }
    routedVerifiers.add(normalizedVerifier);
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
  if (routedVerifiers.size !== 1) {
    throw new Error("Payment verifier hard cut is partially executed; complete or correct the governance batch");
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
  registry: any,
  newVerifier: any,
) {
  const expectedMethods = legacyConfigurations.map(({ method }) => method);
  const actualRegistryMethods: string[] = await registry.getPaymentMethods();
  const actualVerifierMethods: string[] = await newVerifier.getPaymentMethods();
  if (!equalValues(actualRegistryMethods, expectedMethods) || !equalValues(actualVerifierMethods, expectedMethods)) {
    throw new Error("Payment-ID lane method set does not match the legacy lane");
  }
  for (const { method, currencies } of legacyConfigurations) {
    if ((await registry.getVerifier(method)).toLowerCase() !== newVerifier.address.toLowerCase()) {
      throw new Error(`Payment-ID lane verifier mismatch for ${method}`);
    }
    if (!equalValues(await registry.getCurrencies(method), currencies)) {
      throw new Error(`Payment-ID lane currency mismatch for ${method}`);
    }
  }
}

async function routePaymentMethodToUnifiedPaymentVerifierV3(
  hre: HardhatRuntimeEnvironment,
  registry: any,
  method: string,
  currencies: string[],
  retiredVerifierAddress: string,
  newVerifierAddress: string,
) {
  const currentVerifier: string = await registry.getVerifier(method);
  if (currentVerifier.toLowerCase() === newVerifierAddress.toLowerCase()) {
    if (!equalValues(await registry.getCurrencies(method), currencies)) {
      throw new Error(`Payment method ${method} currencies drifted after the verifier hard cut`);
    }
    return;
  }
  if (currentVerifier.toLowerCase() !== retiredVerifierAddress.toLowerCase()) {
    throw new Error(`Payment method ${method} cannot be cut over from unexpected verifier ${currentVerifier}`);
  }

  const owner: string = await registry.owner();
  const localAccounts = (await hre.getUnnamedAccounts()).map((address) => address.toLowerCase());
  if (localAccounts.includes(owner.toLowerCase())) {
    await removePaymentMethodFromRegistry(hre, registry, method);
    await addPaymentMethodToRegistry(hre, registry, method, newVerifierAddress, currencies);
    return;
  }

  safeBatchCollector.add(
    registry.address,
    registry.interface.encodeFunctionData("removePaymentMethod", [method]),
    `PaymentVerifierRegistry.removePaymentMethod(${method.slice(0, 10)}...)`,
  );
  safeBatchCollector.add(
    registry.address,
    registry.interface.encodeFunctionData("addPaymentMethod", [method, newVerifierAddress, currencies]),
    `PaymentVerifierRegistry.addPaymentMethod(${method.slice(0, 10)}..., ${newVerifierAddress})`,
  );
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const { reversible: reversibleConfig, nonChargebackable: nonChargebackableConfig } =
    paymentIdRiskPlatformPolicyForNetwork(network);
  const pendingNewVerifier = await hre.deployments.getOrNull("UnifiedPaymentVerifierV3");
  const legacy = await loadLegacyPaymentConfiguration(network, pendingNewVerifier?.address);
  const chargebackWitnessConfig = chargebackWitnessConfigForNetwork(
    network,
    process.env.CHARGEBACK_WITNESS_ADDRESSES,
    legacy.paymentWitnesses,
  );
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] || deployer;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const legacyNullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
  const postIntentHookExecutorAddress = await requireHistoricalPostIntentHookExecutor(
    network,
    hre.deployments.getOrNull.bind(hre.deployments),
  );
  const stakeTokenAddress = USDC[network] || getDeployedContractAddress(network, "USDCMock");

  type DeploymentName = typeof PAYMENT_ID_RISK_DEPLOYMENT_NAMES[number];
  type AddressOf = (name: DeploymentName) => string;
  const optionsFor: Record<DeploymentName, (addressOf: AddressOf) => DeployOptions> = {
    NullifierRegistryV2: () => ({
      contract: "NullifierRegistryV2",
      from: deployer,
      args: [legacyNullifierRegistryAddress],
    }),
    UnifiedPaymentVerifierV3: (addressOf) => ({
      contract: "UnifiedPaymentVerifierV3",
      from: deployer,
      args: [
        orchestratorRegistryAddress,
        addressOf("NullifierRegistryV2"),
        legacy.paymentAttestationVerifierAddress,
      ],
    }),
    BoundedCallPaymentId: () => ({
      contract: "BoundedCall",
      from: deployer,
      args: [],
    }),
    OrchestratorV3ValidationPaymentId: () => ({
      contract: "OrchestratorV3Validation",
      from: deployer,
      args: [],
    }),
    OrchestratorV3FeeLibPaymentId: () => ({
      contract: "OrchestratorV3FeeLib",
      from: deployer,
      args: [],
    }),
    RiskCallbackRecorderPaymentId: () => ({
      contract: "RiskCallbackRecorder",
      from: deployer,
      args: [],
    }),
    OrchestratorV3RiskLibPaymentId: (addressOf) => ({
      contract: "OrchestratorV3RiskLib",
      from: deployer,
      libraries: {
        BoundedCall: addressOf("BoundedCallPaymentId"),
        RiskCallbackRecorder: addressOf("RiskCallbackRecorderPaymentId"),
      },
      args: [],
    }),
    OrchestratorV3PaymentId: (addressOf) => ({
      contract: "OrchestratorV3",
      from: deployer,
      libraries: {
        PostIntentHookExecutor: postIntentHookExecutorAddress,
        OrchestratorV3Validation: addressOf("OrchestratorV3ValidationPaymentId"),
        OrchestratorV3FeeLib: addressOf("OrchestratorV3FeeLibPaymentId"),
        OrchestratorV3RiskLib: addressOf("OrchestratorV3RiskLibPaymentId"),
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
    }),
    StakeVaultPaymentId: () => ({
      contract: "StakeVault",
      from: deployer,
      args: [
        deployer,
        stakeTokenAddress,
        ethers.constants.AddressZero,
        STAKE_VAULT_BASE_EXIT_DELAY,
        STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
      ],
    }),
    ChargebackAttestationVerifierPaymentId: () => ({
      contract: "MultiAttestationVerifier",
      from: deployer,
      args: [chargebackWitnessConfig.witnesses, chargebackWitnessConfig.threshold],
    }),
    RiskManagerPaymentId: (addressOf) => ({
      contract: "RiskManager",
      from: deployer,
      args: [
        deployer,
        addressOf("OrchestratorV3PaymentId"),
        addressOf("StakeVaultPaymentId"),
        addressOf("ChargebackAttestationVerifierPaymentId"),
        addressOf("NullifierRegistryV2"),
      ],
    }),
    DeferredPayoutHookPaymentId: (addressOf) => ({
      contract: "DeferredPayoutHook",
      from: deployer,
      args: [
        stakeTokenAddress,
        addressOf("StakeVaultPaymentId"),
        addressOf("RiskManagerPaymentId"),
        orchestratorRegistryAddress,
      ],
    }),
  };

  const existingDeployments = new Map<DeploymentName, Deployment>();
  for (const name of PAYMENT_ID_RISK_DEPLOYMENT_NAMES) {
    const deployment = await hre.deployments.getOrNull(name);
    if (deployment) existingDeployments.set(name, deployment);
  }
  await assertResumableNonLocalPaymentIdRiskDeployment(network, async (name) => {
    const deployment = existingDeployments.get(name);
    if (!deployment) return "missing";
    const diff = await hre.deployments.fetchIfDifferent(name, optionsFor[name]((dependency) => {
      const dependencyDeployment = existingDeployments.get(dependency);
      if (!dependencyDeployment) {
        throw new Error(`${network} deployment record ${name} is missing dependency ${dependency}`);
      }
      return dependencyDeployment.address;
    }));
    return diff.differences ? "different" : "matching";
  });

  const resolvedDeployments = new Map<DeploymentName, Deployment>(existingDeployments);
  const addressOf: AddressOf = (name) => {
    const deployment = resolvedDeployments.get(name);
    if (!deployment) throw new Error(`Payment-ID deployment dependency ${name} is unavailable`);
    return deployment.address;
  };
  const deployOne = async (name: DeploymentName) => {
    const deployment = await deploy(name, optionsFor[name](addressOf));
    resolvedDeployments.set(name, deployment);
    return deployment;
  };

  const nullifierRegistryV2Deployment = await deployOne("NullifierRegistryV2");
  const unifiedPaymentVerifierV3 = await deployOne("UnifiedPaymentVerifierV3");
  const newVerifier = await ethers.getContractAt("UnifiedPaymentVerifierV3", unifiedPaymentVerifierV3.address);
  for (const { method, currencies } of legacy.configurations) {
    await addPaymentMethodToUnifiedVerifier(hre, newVerifier, method);
  }

  await deployOne("BoundedCallPaymentId");
  await deployOne("OrchestratorV3ValidationPaymentId");
  await deployOne("OrchestratorV3FeeLibPaymentId");
  await deployOne("RiskCallbackRecorderPaymentId");
  await deployOne("OrchestratorV3RiskLibPaymentId");
  const orchestratorV3 = await deployOne("OrchestratorV3PaymentId");
  const stakeVault = await deployOne("StakeVaultPaymentId");
  const chargebackAttestationVerifier = await deployOne("ChargebackAttestationVerifierPaymentId");
  const riskManager = await deployOne("RiskManagerPaymentId");
  const deferredPayoutHook = await deployOne("DeferredPayoutHookPaymentId");

  const vault = await ethers.getContractAt("StakeVault", stakeVault.address);
  const manager = await ethers.getContractAt("RiskManager", riskManager.address);
  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const nullifierRegistryV2 = await ethers.getContractAt(
    "NullifierRegistryV2",
    nullifierRegistryV2Deployment.address,
  );
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
  const legacyNullifierRegistry = await ethers.getContractAt("NullifierRegistry", legacyNullifierRegistryAddress);
  const escrowRegistry = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestrator.address);
  await addWritePermission(hre, nullifierRegistryV2, newVerifier.address);
  await removeWritePermission(hre, legacyNullifierRegistry, legacy.legacyVerifierAddress);
  for (const { method, currencies } of legacy.configurations) {
    await routePaymentMethodToUnifiedPaymentVerifierV3(
      hre,
      legacy.registry,
      method,
      currencies,
      legacy.legacyVerifierAddress,
      newVerifier.address,
    );
  }
  await assertRegistryParity(legacy.configurations, legacy.registry, newVerifier);
  const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");
  const escrowV2 = await ethers.getContractAt("EscrowV2", escrowV2Address);
  assertCanonicalHardCutAuthorizations({
    orchestratorRegistered: await orchestratorRegistry.isOrchestrator(orchestrator.address),
    newVerifierWriter: await nullifierRegistryV2.isWriter(newVerifier.address),
    legacyVerifierRevoked: !(await legacyNullifierRegistry.isWriter(legacy.legacyVerifierAddress)),
    paymentMethodsRouted: (await Promise.all(legacy.configurations.map(async ({ method }) =>
      (await legacy.registry.getVerifier(method)).toLowerCase() === newVerifier.address.toLowerCase()
    ))).every(Boolean),
    nullifierPredecessorMatches:
      (await nullifierRegistryV2.legacyNullifierRegistry()).toLowerCase()
      === legacyNullifierRegistry.address.toLowerCase(),
    managerNullifierRegistryMatches:
      (await manager.nullifierRegistry()).toLowerCase() === nullifierRegistryV2.address.toLowerCase(),
    orchestratorVerifierRegistryMatches:
      (await orchestrator.paymentVerifierRegistry()).toLowerCase() === legacy.registry.address.toLowerCase(),
    orchestratorEscrowRegistryMatches:
      (await orchestrator.escrowRegistry()).toLowerCase() === escrowRegistry.address.toLowerCase(),
    escrowAuthorized:
      await escrowRegistry.isWhitelistedEscrow(escrowV2Address)
      || await escrowRegistry.isAcceptingAllEscrows(),
    escrowOrchestratorRegistryMatches:
      (await escrowV2.orchestratorRegistry()).toLowerCase() === orchestratorRegistry.address.toLowerCase(),
  });

  await setNewOwner(hre, nullifierRegistryV2, multiSig);
  await setNewOwner(hre, newVerifier, multiSig);
  await setNewOwner(hre, orchestrator, multiSig);
  await setNewOwner(hre, vault, multiSig);
  await setNewOwner(hre, manager, multiSig);
  await setNewOwner(hre, chargebackVerifier, multiSig);

  await saveCanonicalBaseStagingAliases(
    network,
    hre.deployments.get.bind(hre.deployments),
    hre.deployments.getOrNull.bind(hre.deployments),
    hre.deployments.save.bind(hre.deployments),
  );
};

func.tags = ["PaymentIdRiskSystem"];
func.dependencies = ["27_remove_legacy_zelle_payment_methods"];
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  if (process.env.DEPLOY_PAYMENT_ID_RISK_SYSTEM !== "true") return true;
  paymentIdRiskPlatformPolicyForNetwork(network);
  return false;
};

export default func;
