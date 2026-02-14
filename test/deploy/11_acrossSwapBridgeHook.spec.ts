import "module-alias/register";

import { deployments } from "hardhat";
import { Contract } from "ethers";
import { ethers } from "hardhat";

import {
  getAccounts,
  getWaffleExpect,
} from "../../utils/test";
import {
  Account
} from "../../utils/test/types";
import {
  Address
} from "../../utils/types";
import * as fs from "fs";
import * as path from "path";

import {
  ACROSS_SPOKE_POOL,
  ACROSS_SPOKE_POOL_PERIPHERY,
  MULTI_SIG,
  USDC,
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("Across Swap Bridge Hook Deployment", () => {
  let deployer: Account;
  let multiSig: Address;
  let isDeployed = true;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    if (!fs.existsSync(path.resolve(__dirname, `../../deployments/${network}/${contractName}.json`))) {
      throw new Error(`Deployment artifact missing for ${contractName} on ${network}`);
    }
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();
    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;
    if (!fs.existsSync(path.resolve(__dirname, `../../deployments/${network}/AcrossSwapBridgeHook.json`))) {
      isDeployed = false;
    }
  });

  beforeEach(function () {
    if (!isDeployed) this.skip();
  });

  it("should deploy AcrossSwapBridgeHook with correct params", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossSwapBridgeHook");
    const hook = (await ethers.getContractAt("AcrossSwapBridgeHook", hookAddress)) as Contract;

    const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
    const usdcAddress = USDC[network]
      ? USDC[network]
      : getDeployedContractAddress(network, "USDCMock");

    const configuredSpokePool = ACROSS_SPOKE_POOL[network];
    const spokePoolAddress = configuredSpokePool && configuredSpokePool !== ""
      ? configuredSpokePool
      : getDeployedContractAddress(network, "AcrossSpokePoolMock");

    const configuredSpokePoolPeriphery = ACROSS_SPOKE_POOL_PERIPHERY[network];
    const spokePoolPeripheryAddress = configuredSpokePoolPeriphery && configuredSpokePoolPeriphery !== ""
      ? configuredSpokePoolPeriphery
      : getDeployedContractAddress(network, "AcrossSpokePoolPeripheryMock");

    expect(await hook.orchestrator()).to.eq(orchestratorAddress);
    expect(await hook.inputToken()).to.eq(usdcAddress);
    expect(await hook.spokePool()).to.eq(spokePoolAddress);
    expect(await hook.spokePoolPeriphery()).to.eq(spokePoolPeripheryAddress);
  });

  it("should transfer ownership to multisig", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossSwapBridgeHook");
    const hook = (await ethers.getContractAt("AcrossSwapBridgeHook", hookAddress)) as Contract;

    expect(await hook.owner()).to.eq(multiSig);
  });

  it("should whitelist the hook in the post intent hook registry", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossSwapBridgeHook");
    const registryAddress = getDeployedContractAddress(network, "PostIntentHookRegistry");

    const registry = (await ethers.getContractAt("PostIntentHookRegistry", registryAddress)) as Contract;
    expect(await registry.isWhitelistedHook(hookAddress)).to.eq(true);
  });
});
