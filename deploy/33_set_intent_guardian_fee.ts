import "module-alias/register";

import type { Contract } from "ethers";
import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR,
  MULTI_SIG,
} from "../deployments/parameters";
import {
  getDeployedContractAddress,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";

const SUPPORTED_NETWORKS = new Set(["localhost", "hardhat", "base_staging", "base"]);

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export async function setIntentGuardianFee(
  hre: HardhatRuntimeEnvironment,
  guardian: Contract,
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  const targetFee = INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network];
  const currentFee = await guardian.extensionFeeBpsPerHour();
  if (currentFee.eq(targetFee)) return;

  const accounts = await hre.getUnnamedAccounts();
  const deployer = accounts[0];
  const expectedOwner = MULTI_SIG[network] || deployer;
  const owner = await guardian.owner();
  if (!sameAddress(owner, expectedOwner)) {
    throw new Error(`IntentGuardian owner mismatch: expected ${expectedOwner}, found ${owner}`);
  }

  const data = guardian.interface.encodeFunctionData("setExtensionFeeBpsPerHour", [targetFee]);
  if (accounts.some((account) => sameAddress(account, owner))) {
    const signer = await hre.ethers.getSigner(owner);
    await (await guardian.connect(signer).setExtensionFeeBpsPerHour(targetFee)).wait();
    await waitForDeploymentDelay(hre);
    return;
  }

  safeBatchCollector.add(
    guardian.address,
    data,
    `IntentGuardian.setExtensionFeeBpsPerHour(${targetFee})`,
  );
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  const guardianAddress = getDeployedContractAddress(network, "IntentGuardian");
  const guardian = await ethers.getContractAt("IntentGuardian", guardianAddress);

  await setIntentGuardianFee(hre, guardian);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;

  const guardianAddress = getDeployedContractAddress(network, "IntentGuardian");
  const guardian = await ethers.getContractAt("IntentGuardian", guardianAddress);
  return (await guardian.extensionFeeBpsPerHour()).eq(
    INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network],
  );
};

func.tags = ["33_set_intent_guardian_fee", "IntentGuardianFee"];
func.dependencies = ["28_deploy_intent_guardian"];

export default func;
