import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  addOrchestratorToRegistry,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import {
  CHARGEBACK_ATTESTOR_ADDRESSES,
  IDENTITY_ATTESTOR_ADDRESSES,
  MULTI_SIG,
  OPEN_ORCHESTRATOR_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
  USDC,
} from "../deployments/parameters";
import { safeBatchCollector } from "../deployments/safeBatchCollector";
import { ALIPAY_PAYMENT_METHOD_HASH } from "../deployments/verifiers/alipay";
import { CASHAPP_PAYMENT_METHOD_HASH } from "../deployments/verifiers/cashapp";
import { CHIME_PAYMENT_METHOD_HASH } from "../deployments/verifiers/chime";
import { LUXON_PAYMENT_METHOD_HASH } from "../deployments/verifiers/luxon";
import { MERCADOPAGO_PAYMENT_METHOD_HASH } from "../deployments/verifiers/mercadopago";
import { MONZO_PAYMENT_METHOD_HASH } from "../deployments/verifiers/monzo";
import { N26_PAYMENT_METHOD_HASH } from "../deployments/verifiers/n26";
import { PAYPAL_PAYMENT_METHOD_HASH } from "../deployments/verifiers/paypal";
import { REVOLUT_PAYMENT_METHOD_HASH } from "../deployments/verifiers/revolut";
import { VENMO_PAYMENT_METHOD_HASH } from "../deployments/verifiers/venmo";
import { WISE_PAYMENT_METHOD_HASH } from "../deployments/verifiers/wise";
import {
  ZELLE_BOFA_PAYMENT_METHOD_HASH,
  ZELLE_CHASE_PAYMENT_METHOD_HASH,
  ZELLE_CITI_PAYMENT_METHOD_HASH,
  ZELLE_PAYMENT_METHOD_HASH,
} from "../deployments/verifiers/zelle";
import { usdc } from "../utils/common";

const SEVEN_DAYS = 7 * 24 * 60 * 60;
const THIRTY_DAYS = 30 * 24 * 60 * 60;
const ONE_HUNDRED_EIGHTY_DAYS = 180 * 24 * 60 * 60;
const IDENTITY_ACTION_TYPES = [
  "register_venmo",
  "register_paypal",
  "register_wise",
  "register_cashapp",
].map((actionType) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(actionType)));

const CHARGEBACKABLE_METHODS = [
  VENMO_PAYMENT_METHOD_HASH,
  CASHAPP_PAYMENT_METHOD_HASH,
  CHIME_PAYMENT_METHOD_HASH,
  PAYPAL_PAYMENT_METHOD_HASH,
  ZELLE_PAYMENT_METHOD_HASH,
  ZELLE_CITI_PAYMENT_METHOD_HASH,
  ZELLE_CHASE_PAYMENT_METHOD_HASH,
  ZELLE_BOFA_PAYMENT_METHOD_HASH,
];

const IRREVERSIBLE_METHODS = [
  REVOLUT_PAYMENT_METHOD_HASH,
  WISE_PAYMENT_METHOD_HASH,
  MONZO_PAYMENT_METHOD_HASH,
  MERCADOPAGO_PAYMENT_METHOD_HASH,
  LUXON_PAYMENT_METHOD_HASH,
  N26_PAYMENT_METHOD_HASH,
  ALIPAY_PAYMENT_METHOD_HASH,
];

/**
 * Opt-in deployment for the additive onchain risk system.
 *
 * Production/staging execution is intentionally gated by DEPLOY_ONCHAIN_RISK=true.
 * Review the generated Safe batch and deployment runbook before enabling it. The script deploys
 * a new orchestrator and reuses the existing EscrowV2, so maker deposits are not migrated.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] || deployer;

  const orchestratorRegistryAddress = (await hre.deployments.get("OrchestratorRegistry")).address;
  const escrowRegistryAddress = (await hre.deployments.get("EscrowRegistry")).address;
  const paymentVerifierRegistryAddress = (await hre.deployments.get("PaymentVerifierRegistry")).address;
  const relayerRegistryAddress = (await hre.deployments.get("RelayerRegistry")).address;
  const stakeTokenAddress = USDC[network] || (await hre.deployments.get("USDCMock")).address;

  const identityRegistry = await deploy("IdentityRegistry", {
    from: deployer,
    args: [deployer],
  });
  const reputationRegistry = await deploy("ReputationRegistry", {
    from: deployer,
    args: [deployer, identityRegistry.address],
  });
  const stakeVault = await deploy("StakeVault", {
    from: deployer,
    args: [deployer, stakeTokenAddress],
  });
  const protocolRiskManager = await deploy("ProtocolRiskManager", {
    from: deployer,
    args: [
      deployer,
      orchestratorRegistryAddress,
      identityRegistry.address,
      reputationRegistry.address,
      stakeVault.address,
    ],
  });
  const openOrchestrator = await deploy("OpenOrchestratorV2", {
    contract: "OrchestratorV2",
    from: deployer,
    args: [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      relayerRegistryAddress,
      OPEN_ORCHESTRATOR_PROTOCOL_FEE[network] ?? OPEN_ORCHESTRATOR_PROTOCOL_FEE.localhost,
      ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network] || deployer,
    ],
  });

  const identityRegistryContract = await ethers.getContractAt("IdentityRegistry", identityRegistry.address);
  const reputationRegistryContract = await ethers.getContractAt("ReputationRegistry", reputationRegistry.address);
  const stakeVaultContract = await ethers.getContractAt("StakeVault", stakeVault.address);
  const protocolRiskManagerContract = await ethers.getContractAt(
    "ProtocolRiskManager",
    protocolRiskManager.address,
  );
  const openOrchestratorContract = await ethers.getContractAt("OrchestratorV2", openOrchestrator.address);
  const orchestratorRegistryContract = await ethers.getContractAt(
    "OrchestratorRegistry",
    orchestratorRegistryAddress,
  );

  const ownerCallOrQueue = async (
    contract: any,
    functionName: string,
    args: any[],
    description: string,
  ): Promise<void> => {
    const currentOwner = (await contract.owner()).toLowerCase();
    const data = contract.interface.encodeFunctionData(functionName, args);
    if (currentOwner === deployer.toLowerCase()) {
      await contract[functionName](...args);
      return;
    }
    if (currentOwner === multiSig.toLowerCase()) {
      safeBatchCollector.add(contract.address, data, description);
      return;
    }
    throw new Error(
      `${description}: owner ${currentOwner} is neither deployer ${deployer} nor multisig ${multiSig}`,
    );
  };

  if (!(await reputationRegistryContract.authorizedUpdaters(protocolRiskManager.address))) {
    await ownerCallOrQueue(
      reputationRegistryContract,
      "setAuthorizedUpdater",
      [protocolRiskManager.address, true],
      "Authorize ProtocolRiskManager in ReputationRegistry",
    );
  }
  if (!(await stakeVaultContract.authorizedManagers(protocolRiskManager.address))) {
    await ownerCallOrQueue(
      stakeVaultContract,
      "setAuthorizedManager",
      [protocolRiskManager.address, true],
      "Authorize ProtocolRiskManager in StakeVault",
    );
  }
  if ((await openOrchestratorContract.riskManager()).toLowerCase() !== protocolRiskManager.address.toLowerCase()) {
    await ownerCallOrQueue(
      openOrchestratorContract,
      "setRiskManager",
      [protocolRiskManager.address],
      "Set OpenOrchestratorV2 risk manager",
    );
  }
  // Dark deployment invariant: registry authorization must never make the new path callable
  // before downstream indexing, Attestor, and client stake/identity flows are ready.
  if (!(await openOrchestratorContract.paused())) {
    const currentOwner = (await openOrchestratorContract.owner()).toLowerCase();
    if (currentOwner === deployer.toLowerCase()) {
      await ownerCallOrQueue(
        openOrchestratorContract,
        "pauseOrchestrator",
        [],
        "Pause OpenOrchestratorV2",
      );
    } else {
      console.warn(
        `OpenOrchestratorV2 ${openOrchestrator.address} is already multisig-owned and unpaused; `
          + "the deploy retry will not queue a production pause",
      );
    }
  }

  for (const attestor of IDENTITY_ATTESTOR_ADDRESSES[network] || []) {
    if (!(await identityRegistryContract.trustedAttestors(attestor))) {
      await ownerCallOrQueue(
        identityRegistryContract,
        "setTrustedAttestor",
        [attestor, true],
        `Trust identity Attestor ${attestor}`,
      );
    }
  }
  for (const attestor of CHARGEBACK_ATTESTOR_ADDRESSES[network] || []) {
    if (!(await protocolRiskManagerContract.trustedChargebackAttestors(attestor))) {
      await ownerCallOrQueue(
        protocolRiskManagerContract,
        "setTrustedChargebackAttestor",
        [attestor, true],
        `Trust chargeback Attestor ${attestor}`,
      );
    }
  }
  for (const actionType of IDENTITY_ACTION_TYPES) {
    if (!(await identityRegistryContract.acceptedActionTypes(actionType))) {
      await ownerCallOrQueue(
        identityRegistryContract,
        "setAcceptedActionType",
        [actionType, true],
        `Accept identity action type ${actionType}`,
      );
    }
  }

  const sharedConfig = {
    configured: true,
    enabled: false, // Enable in the reviewed cutover Safe batch, never during dark deployment.
    identityRequired: true,
    makerIdentityRequired: false, // Enable only after existing makers have registered.
    minReputation: -100,
    abandonmentSlashBps: 5_000,
    signalBond: usdc(1),
  };
  for (const paymentMethod of CHARGEBACKABLE_METHODS) {
    const config = {
      ...sharedConfig,
      chargebackable: true,
      baseStakeBps: 10_000,
      maturitySchedule: {
        cliffSeconds: SEVEN_DAYS,
        stepTwoSeconds: THIRTY_DAYS,
        finalMaturitySeconds: ONE_HUNDRED_EIGHTY_DAYS,
        retentionBpsAfterCliff: 10_000,
        retentionBpsAfterStepTwo: 10_000,
      },
    };
    const current = await protocolRiskManagerContract.platformRiskConfigs(paymentMethod);
    if (!current.configured) {
      await ownerCallOrQueue(
        protocolRiskManagerContract,
        "setPlatformRiskConfig",
        [paymentMethod, config],
        `Configure disabled chargeback policy ${paymentMethod}`,
      );
    }
  }
  for (const paymentMethod of IRREVERSIBLE_METHODS) {
    const config = {
      ...sharedConfig,
      chargebackable: false,
      baseStakeBps: 0,
      maturitySchedule: {
        cliffSeconds: 0,
        stepTwoSeconds: 0,
        finalMaturitySeconds: 0,
        retentionBpsAfterCliff: 0,
        retentionBpsAfterStepTwo: 0,
      },
    };
    const current = await protocolRiskManagerContract.platformRiskConfigs(paymentMethod);
    if (!current.configured) {
      await ownerCallOrQueue(
        protocolRiskManagerContract,
        "setPlatformRiskConfig",
        [paymentMethod, config],
        `Configure disabled irreversible policy ${paymentMethod}`,
      );
    }
  }

  await addOrchestratorToRegistry(hre, orchestratorRegistryContract, openOrchestrator.address);

  await setNewOwner(hre, identityRegistryContract, multiSig);
  await setNewOwner(hre, reputationRegistryContract, multiSig);
  await setNewOwner(hre, stakeVaultContract, multiSig);
  await setNewOwner(hre, protocolRiskManagerContract, multiSig);
  await setNewOwner(hre, openOrchestratorContract, multiSig);

  await waitForDeploymentDelay(hre);
};

func.skip = async (): Promise<boolean> => process.env.DEPLOY_ONCHAIN_RISK !== "true";
func.tags = ["26_deploy_onchain_risk_system"];
func.dependencies = ["25_add_generic_zelle_payment_method"];

export default func;
