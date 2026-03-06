import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  ESCROW_V2_INTENT_EXPIRATION_PERIOD,
  ESCROW_V2_MAX_INTENTS_PER_DEPOSIT,
  ESCROW_V2_DUST_THRESHOLD,
  ESCROW_V2_DUST_RECIPIENT,
} from "../deployments/parameters";
import {
  addEscrowToRegistry,
  removeEscrowFromRegistry,
  getDeployedContractAddress,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";

// Old addresses being replaced (deployed by script 14/15, before rate-floor refactor)
const OLD_ESCROW_V2: any = {
  // "base" handled by script 19 (vanity deployer)
  "base_staging": "0xA36Eab7cB39fCc874bEA5e7e0C934abcD253562f",
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  // Resolve existing infrastructure addresses
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");

  const oldEscrowV2 = OLD_ESCROW_V2[network];
  if (!oldEscrowV2) throw new Error(`No old EscrowV2 address configured for network ${network}`);

  console.log("=== Redeploying EscrowV2 and RateManagerV1 (rate-floor refactor) ===");
  console.log("Old EscrowV2:", oldEscrowV2);

  // 1. Deploy new EscrowV2
  const escrowV2 = await deploy("EscrowV2", {
    from: deployer,
    args: [
      deployer,
      chainId,
      orchestratorRegistryAddress,
      paymentVerifierRegistryAddress,
      ESCROW_V2_DUST_RECIPIENT[network] != ""
        ? ESCROW_V2_DUST_RECIPIENT[network]
        : deployer,
      ESCROW_V2_DUST_THRESHOLD[network],
      ESCROW_V2_MAX_INTENTS_PER_DEPOSIT[network],
      ESCROW_V2_INTENT_EXPIRATION_PERIOD[network],
    ],
  });
  console.log("New EscrowV2 deployed at", escrowV2.address);
  await waitForDeploymentDelay(hre);

  // 2. Deploy new RateManagerV1
  const rateManagerV1 = await deploy("RateManagerV1", {
    from: deployer,
    args: [escrowRegistryAddress],
  });
  console.log("New RateManagerV1 deployed at", rateManagerV1.address);
  await waitForDeploymentDelay(hre);

  // 3. Wire EscrowRegistry: add new EscrowV2, remove old EscrowV2
  const escrowRegistryContract = await ethers.getContractAt("EscrowRegistry", escrowRegistryAddress);
  await addEscrowToRegistry(hre, escrowRegistryContract, escrowV2.address);
  console.log("New EscrowV2 added to EscrowRegistry");

  await removeEscrowFromRegistry(hre, escrowRegistryContract, oldEscrowV2);
  console.log("Old EscrowV2 removed from EscrowRegistry");

  // 4. Transfer ownership to multiSig
  const escrowV2Contract = await ethers.getContractAt("EscrowV2", escrowV2.address);
  await setNewOwner(hre, escrowV2Contract, multiSig);
  console.log("EscrowV2 ownership transferred to", multiSig);

  const rateManagerV1Contract = await ethers.getContractAt("RateManagerV1", rateManagerV1.address);
  await setNewOwner(hre, rateManagerV1Contract, multiSig);
  console.log("RateManagerV1 ownership transferred to", multiSig);

  console.log("=== Redeployment finished ===");
  await waitForDeploymentDelay(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.network.name;
  const oldAddress = OLD_ESCROW_V2[network];
  if (!oldAddress) return true; // Skip networks without old addresses
  try {
    const currentEscrowV2 = getDeployedContractAddress(network, "EscrowV2");
    return currentEscrowV2 !== oldAddress;
  } catch (e) {
    return false;
  }
};

func.dependencies = ["15_deploy_v2_periphery"];

export default func;
