import { ethers, network } from "hardhat";

import { assertGroupsCutoverWiring } from "../deploy/31_redeploy_staging_groups_stack";

async function main() {
  await assertGroupsCutoverWiring(require("hardhat"));

  const contractNames = ["OrchestratorV3", "WhitelistPolicy", "WhitelistLifecycleHook"];
  const deploymentHashes: string[] = [];
  for (const contractName of contractNames) {
    const deployment = await require("hardhat").deployments.get(contractName);
    if (!deployment.transactionHash) {
      throw new Error(`${contractName} deployment artifact has no creation transaction`);
    }
    const receipt = await ethers.provider.getTransactionReceipt(deployment.transactionHash);
    if (!receipt || receipt.status !== 1 || !receipt.contractAddress) {
      throw new Error(`${contractName} creation transaction is missing or unsuccessful`);
    }
    if (receipt.contractAddress.toLowerCase() !== deployment.address.toLowerCase()) {
      throw new Error(`${contractName} creation receipt does not match its canonical artifact`);
    }
    deploymentHashes.push(deployment.transactionHash.toLowerCase());
  }
  if (new Set(deploymentHashes).size !== contractNames.length) {
    throw new Error("The groups cutover artifacts do not point to exactly three distinct creations");
  }

  console.log(`Verified exactly three fresh groups-cutover deployments on ${network.name}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
