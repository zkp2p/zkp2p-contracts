// Lane 41 retires dispute protection for governance-selected payment methods by zeroing their risk windows.
// Local and EOA-owned policies execute directly; Safe-owned policies emit queued governance calls.
// DISPUTABLE_PAYMENT_METHODS and dispute-stack evidence flip only in a recording PR after every network executes.

import { ethers } from "ethers";
import type { BigNumber, Contract } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  MULTI_SIG,
  RETIRED_DISPUTABLE_PAYMENT_METHODS,
  getActivePaymentMethods,
} from "../deployments/parameters";
import {
  getDeployedContractAddress,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";

export const TAG = "41_retire_dispute_risk_windows";
export const POLICY_DEPLOYMENT_NAME =
  "DisputeProtectionPolicyMethodScopedStaked";

const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);

function isLiveNetwork(network: string): boolean {
  return network === "base" || network === "base_staging";
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function paymentMethodHash(method: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(method));
}

export function assertRetiredMethodsActive(
  network: string,
  retired: readonly string[] = RETIRED_DISPUTABLE_PAYMENT_METHODS
): void {
  if (retired.length === 0) {
    throw new Error("Retired disputable payment methods must not be empty");
  }
  const activeMethods = getActivePaymentMethods(network);
  for (const method of retired) {
    if (!activeMethods.includes(method)) {
      throw new Error(
        `Retired disputable payment method is not active on ${network}: ${method}`
      );
    }
  }
}

export async function readRetiredRiskWindows(
  policy: Contract,
  network: string
): Promise<Array<{ method: string; hash: string; window: BigNumber }>> {
  assertRetiredMethodsActive(network);
  return Promise.all(
    RETIRED_DISPUTABLE_PAYMENT_METHODS.map(async (method) => {
      const hash = paymentMethodHash(method);
      return {
        method,
        hash,
        window: await policy.getRiskWindow(hash),
      };
    })
  );
}

export async function retireDisputeRiskWindows(
  hre: HardhatRuntimeEnvironment,
  policy: Contract
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  const windows = await readRetiredRiskWindows(policy, network);
  const drifted = windows.filter(({ window }) => !window.isZero());
  if (drifted.length === 0) return;

  const accounts = await hre.getUnnamedAccounts();
  const deployer = accounts[0];
  const expectedOwner = MULTI_SIG[network] || deployer;
  const owner = await policy.owner();
  if (!sameAddress(owner, expectedOwner)) {
    throw new Error(
      `${POLICY_DEPLOYMENT_NAME} owner mismatch: expected ${expectedOwner}, found ${owner}`
    );
  }

  if (accounts.some((account) => sameAddress(account, owner))) {
    const signer = await hre.ethers.getSigner(owner);
    for (const { hash } of drifted) {
      await (await policy.connect(signer).setRiskWindow(hash, 0)).wait();
      await waitForDeploymentDelay(hre);
    }
    for (const { method, hash } of drifted) {
      if (!(await policy.getRiskWindow(hash)).isZero()) {
        throw new Error(
          `${POLICY_DEPLOYMENT_NAME} risk window still set for ${method}`
        );
      }
    }
    return;
  }

  for (const { method, hash } of drifted) {
    safeBatchCollector.add(
      policy.address,
      policy.interface.encodeFunctionData("setRiskWindow", [hash, 0]),
      `${POLICY_DEPLOYMENT_NAME}.setRiskWindow(${method}, 0)`
    );
  }
}

export async function retiredRiskWindowsCleared(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  const policy = await hre.ethers.getContractAt(
    "DisputeProtectionPolicy",
    getDeployedContractAddress(network, POLICY_DEPLOYMENT_NAME)
  );
  const windows = await readRetiredRiskWindows(policy, network);
  return windows.every(({ window }) => window.isZero());
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  const policy = await hre.ethers.getContractAt(
    "DisputeProtectionPolicy",
    getDeployedContractAddress(network, POLICY_DEPLOYMENT_NAME)
  );
  await retireDisputeRiskWindows(hre, policy);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (isLiveNetwork(network) && process.env.DEPLOY_ACTIVE_TAG !== TAG) {
    return true;
  }
  return retiredRiskWindowsCleared(hre);
};

func.tags = [TAG, "DisputeRiskWindowRetirement"];
func.dependencies = ["39_deploy_method_scoped_vault_stack"];

export default func;
