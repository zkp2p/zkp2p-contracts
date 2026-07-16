import "module-alias/register";

import { BigNumber } from "ethers";
import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  RISK_CALLBACK_GAS_LIMIT,
  STAKE_VAULT_BASE_EXIT_DELAY,
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
  USDC,
} from "../deployments/parameters";
import { getDeployedContractAddress, waitForDeploymentDelay } from "../deployments/helpers";

export const CHARGEBACK_E2E_DEPLOYER = "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929";
export const PAYMENT_WITNESS_THRESHOLD = 2;
export const CHARGEBACK_WITNESS_THRESHOLD = 2;
export const REQUIRED_WITNESS_COUNT = 3;

export const CHARGEBACK_E2E_DEPLOYMENTS = {
  paymentAttestationVerifier: "PaymentAttestationVerifierChargebackE2E",
  boundedCall: "BoundedCallChargebackE2E",
  postIntentHookExecutor: "PostIntentHookExecutorChargebackE2E",
  orchestrator: "OrchestratorV3ChargebackE2E",
  unifiedPaymentVerifier: "UnifiedPaymentVerifierChargebackE2E",
  chargebackAttestationVerifier: "ChargebackAttestationVerifierE2E",
  stakeVault: "StakeVaultChargebackE2E",
  riskManager: "RiskManagerChargebackE2E",
} as const;

export type IsolatedWitnessConfig = {
  paymentWitnesses: string[];
  paymentThreshold: number;
  chargebackWitnesses: string[];
  chargebackThreshold: number;
};

function normalizeWitnesses(label: string, value: string | undefined): string[] {
  const witnesses = (value ?? "").split(",").map((address) => address.trim()).filter(Boolean);
  if (witnesses.length !== REQUIRED_WITNESS_COUNT) {
    throw new Error(`${label} requires exactly ${REQUIRED_WITNESS_COUNT} public witness addresses`);
  }
  if (witnesses.some((address) => !ethers.utils.isAddress(address))) {
    throw new Error(`${label} contains an invalid public witness address`);
  }
  const normalized = witnesses.map((address) => ethers.utils.getAddress(address));
  if (new Set(normalized.map((address) => address.toLowerCase())).size !== normalized.length) {
    throw new Error(`${label} witnesses must be unique`);
  }
  return normalized;
}

/**
 * Parses public addresses only. Signing material is deliberately outside the deployment interface.
 */
export function isolatedWitnessConfig(
  paymentCsv = process.env.CHARGEBACK_E2E_PAYMENT_WITNESS_ADDRESSES,
  chargebackCsv = process.env.CHARGEBACK_E2E_CHARGEBACK_WITNESS_ADDRESSES,
  livePaymentWitnesses: string[] = [],
): IsolatedWitnessConfig {
  const paymentWitnesses = normalizeWitnesses("payment attestation", paymentCsv);
  const chargebackWitnesses = normalizeWitnesses("chargeback attestation", chargebackCsv);
  const paymentSet = new Set(paymentWitnesses.map((address) => address.toLowerCase()));
  const chargebackSet = new Set(chargebackWitnesses.map((address) => address.toLowerCase()));
  const liveSet = new Set(livePaymentWitnesses.map((address) => address.toLowerCase()));

  if (chargebackWitnesses.some((address) => paymentSet.has(address.toLowerCase()))) {
    throw new Error("payment and chargeback witness sets must be disjoint");
  }
  if (paymentWitnesses.some((address) => liveSet.has(address.toLowerCase()))) {
    throw new Error("isolated payment witnesses must be disjoint from the live payment witness set");
  }
  if (chargebackWitnesses.some((address) => liveSet.has(address.toLowerCase()))) {
    throw new Error("isolated chargeback witnesses must be disjoint from the live payment witness set");
  }
  if (new Set([...paymentSet, ...chargebackSet]).size !== 2 * REQUIRED_WITNESS_COUNT) {
    throw new Error("all isolated witness credentials must be distinct");
  }

  return {
    paymentWitnesses,
    paymentThreshold: PAYMENT_WITNESS_THRESHOLD,
    chargebackWitnesses,
    chargebackThreshold: CHARGEBACK_WITNESS_THRESHOLD,
  };
}

export function assertChargebackE2ENetwork(network: string, chainId: number, deployer: string): void {
  if (network !== "base_staging") throw new Error("Chargeback E2E deployment is Base staging only");
  if (chainId !== 8453) throw new Error(`Chargeback E2E requires chain 8453; received ${chainId}`);
  if (deployer.toLowerCase() !== CHARGEBACK_E2E_DEPLOYER.toLowerCase()) {
    throw new Error(`Chargeback E2E requires deployer ${CHARGEBACK_E2E_DEPLOYER}; received ${deployer}`);
  }
}

async function requireCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${label} has no runtime code at ${address}`);
}

async function requireOwner(contractName: string, address: string, expectedOwner: string): Promise<void> {
  const contract = await ethers.getContractAt(contractName, address);
  const owner = await contract.owner();
  if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(`${contractName} owner mismatch: expected ${expectedOwner}, found ${owner}`);
  }
}

async function waitIfNew(hre: HardhatRuntimeEnvironment, newlyDeployed: boolean): Promise<void> {
  if (newlyDeployed) await waitForDeploymentDelay(hre);
}

/**
 * Deploys an isolated, versioned chargeback fixture. It never overwrites the canonical staging
 * records and never changes a production-like payment-method entry.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  const { chainId } = await ethers.provider.getNetwork();
  const [deployer] = await hre.getUnnamedAccounts();
  assertChargebackE2ENetwork(network, chainId, deployer);

  const dependencyNames = [
    "EscrowRegistry",
    "PaymentVerifierRegistry",
    "RelayerRegistry",
    "OrchestratorRegistry",
    "NullifierRegistry",
    "EscrowV2",
    "MultiAttestationVerifier",
  ];
  const dependencyAddresses: Record<string, string> = {};
  for (const name of dependencyNames) {
    const address = getDeployedContractAddress(network, name);
    await requireCode(address, name);
    dependencyAddresses[name] = address;
  }

  await requireOwner("PaymentVerifierRegistry", dependencyAddresses.PaymentVerifierRegistry, deployer);
  await requireOwner("NullifierRegistry", dependencyAddresses.NullifierRegistry, deployer);
  await requireOwner("OrchestratorRegistry", dependencyAddresses.OrchestratorRegistry, deployer);

  const escrow = await ethers.getContractAt("EscrowV2", dependencyAddresses.EscrowV2);
  const escrowOrchestratorRegistry = await escrow.orchestratorRegistry();
  if (escrowOrchestratorRegistry.toLowerCase() !== dependencyAddresses.OrchestratorRegistry.toLowerCase()) {
    throw new Error("EscrowV2 does not use the recorded OrchestratorRegistry");
  }

  const livePaymentVerifier = await ethers.getContractAt(
    "MultiAttestationVerifier",
    dependencyAddresses.MultiAttestationVerifier,
  );
  const livePaymentWitnesses: string[] = await livePaymentVerifier.witnesses();
  if (livePaymentWitnesses.length === 0) throw new Error("live payment witness set is empty");
  const witnesses = isolatedWitnessConfig(
    process.env.CHARGEBACK_E2E_PAYMENT_WITNESS_ADDRESSES,
    process.env.CHARGEBACK_E2E_CHARGEBACK_WITNESS_ADDRESSES,
    livePaymentWitnesses,
  );

  const usdcAddress = USDC[network];
  if (!usdcAddress) throw new Error(`USDC is not configured for ${network}`);
  await requireCode(usdcAddress, "USDC");
  const usdc = await ethers.getContractAt("IERC20", usdcAddress);
  const signerEth = await ethers.provider.getBalance(deployer);
  const signerUsdc: BigNumber = await usdc.balanceOf(deployer);
  if (signerEth.lt(ethers.utils.parseEther("0.005"))) throw new Error("deployer ETH balance is below 0.005 ETH");
  if (signerUsdc.lt(500_000)) throw new Error("deployer USDC balance is below the 500,000-unit fixture minimum");

  const { deploy } = hre.deployments;
  const paymentVerifier = await deploy(CHARGEBACK_E2E_DEPLOYMENTS.paymentAttestationVerifier, {
    contract: "MultiAttestationVerifier",
    from: deployer,
    args: [witnesses.paymentWitnesses, witnesses.paymentThreshold],
  });
  await waitIfNew(hre, paymentVerifier.newlyDeployed);

  const boundedCall = await deploy(CHARGEBACK_E2E_DEPLOYMENTS.boundedCall, {
    contract: "BoundedCall",
    from: deployer,
    args: [],
  });
  await waitIfNew(hre, boundedCall.newlyDeployed);

  const hookExecutor = await deploy(CHARGEBACK_E2E_DEPLOYMENTS.postIntentHookExecutor, {
    contract: "PostIntentHookExecutor",
    from: deployer,
    args: [],
  });
  await waitIfNew(hre, hookExecutor.newlyDeployed);

  const orchestrator = await deploy(CHARGEBACK_E2E_DEPLOYMENTS.orchestrator, {
    contract: "OrchestratorV3",
    from: deployer,
    libraries: {
      BoundedCall: boundedCall.address,
      PostIntentHookExecutor: hookExecutor.address,
    },
    args: [
      deployer,
      chainId,
      dependencyAddresses.EscrowRegistry,
      dependencyAddresses.PaymentVerifierRegistry,
      dependencyAddresses.RelayerRegistry,
      0,
      deployer,
      RISK_CALLBACK_GAS_LIMIT,
    ],
  });
  await waitIfNew(hre, orchestrator.newlyDeployed);

  const upv = await deploy(CHARGEBACK_E2E_DEPLOYMENTS.unifiedPaymentVerifier, {
    contract: "UnifiedPaymentVerifier",
    from: deployer,
    args: [
      dependencyAddresses.OrchestratorRegistry,
      dependencyAddresses.NullifierRegistry,
      paymentVerifier.address,
    ],
  });
  await waitIfNew(hre, upv.newlyDeployed);

  const chargebackVerifier = await deploy(CHARGEBACK_E2E_DEPLOYMENTS.chargebackAttestationVerifier, {
    contract: "MultiAttestationVerifier",
    from: deployer,
    args: [witnesses.chargebackWitnesses, witnesses.chargebackThreshold],
  });
  await waitIfNew(hre, chargebackVerifier.newlyDeployed);

  const stakeVault = await deploy(CHARGEBACK_E2E_DEPLOYMENTS.stakeVault, {
    contract: "StakeVault",
    from: deployer,
    args: [
      deployer,
      usdcAddress,
      ethers.constants.AddressZero,
      STAKE_VAULT_BASE_EXIT_DELAY,
      STAKE_VAULT_CONTROLLER_CHANGE_DELAY,
    ],
  });
  await waitIfNew(hre, stakeVault.newlyDeployed);

  const riskManager = await deploy(CHARGEBACK_E2E_DEPLOYMENTS.riskManager, {
    contract: "RiskManager",
    from: deployer,
    args: [deployer, orchestrator.address, stakeVault.address, chargebackVerifier.address],
  });
  await waitIfNew(hre, riskManager.newlyDeployed);

  const vaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const currentController = await vaultContract.controller();
  if (currentController === ethers.constants.AddressZero) {
    await (await vaultContract.initializeController(riskManager.address)).wait();
    await waitForDeploymentDelay(hre);
  } else if (currentController.toLowerCase() !== riskManager.address.toLowerCase()) {
    throw new Error(`isolated StakeVault controller mismatch: ${currentController}`);
  }

  const orchestratorContract = await ethers.getContractAt("OrchestratorV3", orchestrator.address);
  if (!(await orchestratorContract.allowMultipleIntents())) {
    await (await orchestratorContract.setAllowMultipleIntents(true)).wait();
    await waitForDeploymentDelay(hre);
  }

  const orchestratorRegistry = await ethers.getContractAt(
    "OrchestratorRegistry",
    dependencyAddresses.OrchestratorRegistry,
  );
  if (!(await orchestratorRegistry.isOrchestrator(orchestrator.address))) {
    await (await orchestratorRegistry.addOrchestrator(orchestrator.address)).wait();
    await waitForDeploymentDelay(hre);
  }

  const deployedPaymentVerifier = await ethers.getContractAt("MultiAttestationVerifier", paymentVerifier.address);
  const deployedChargebackVerifier = await ethers.getContractAt("MultiAttestationVerifier", chargebackVerifier.address);
  if (!(await deployedPaymentVerifier.requiredSignatures()).eq(PAYMENT_WITNESS_THRESHOLD)) {
    throw new Error("isolated payment verifier threshold drift");
  }
  if (!(await deployedChargebackVerifier.requiredSignatures()).eq(CHARGEBACK_WITNESS_THRESHOLD)) {
    throw new Error("isolated chargeback verifier threshold drift");
  }
  const deployedPaymentWitnesses: string[] = await deployedPaymentVerifier.witnesses();
  const deployedChargebackWitnesses: string[] = await deployedChargebackVerifier.witnesses();
  const normalized = (addresses: string[]) => addresses.map((address) => address.toLowerCase()).sort();
  if (JSON.stringify(normalized(deployedPaymentWitnesses)) !== JSON.stringify(normalized(witnesses.paymentWitnesses))) {
    throw new Error("isolated payment witness set drift");
  }
  if (
    JSON.stringify(normalized(deployedChargebackWitnesses))
      !== JSON.stringify(normalized(witnesses.chargebackWitnesses))
  ) {
    throw new Error("isolated chargeback witness set drift");
  }

  console.log("Chargeback E2E fixture deployed with public coordinates:");
  for (const [label, deployment] of Object.entries({
    paymentVerifier,
    boundedCall,
    hookExecutor,
    orchestrator,
    upv,
    chargebackVerifier,
    stakeVault,
    riskManager,
  })) {
    console.log(`${label}: ${deployment.address}${deployment.transactionHash ? ` tx=${deployment.transactionHash}` : ""}`);
  }
};

func.tags = ["ChargebackE2E"];
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  if (hre.deployments.getNetworkName() !== "base_staging") return true;
  return process.env.DEPLOY_CHARGEBACK_E2E !== "true";
};

export default func;
