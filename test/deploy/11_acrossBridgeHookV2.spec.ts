import "module-alias/register";

import { deployments } from "hardhat";

import {
  AcrossBridgeHookV2__factory,
  PostIntentHookRegistry__factory,
} from "../../typechain";

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
  ACROSS_ALLOWED_EXCHANGES,
  ACROSS_SPOKE_POOL,
  ACROSS_SPOKE_POOL_PERIPHERY,
  MULTI_SIG,
  USDC,
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("Across Bridge Hook V2 Deployment", () => {
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

  function _parseAllowedExchanges(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  function _getExpectedSpokePoolPeriphery(network: string, defaultAddress: string | undefined): string {
    if (defaultAddress) {
      return defaultAddress;
    }
    if (network === "localhost" || network === "hardhat") {
      return getDeployedContractAddress(network, "AcrossSpokePoolPeripheryMock");
    }
    throw new Error(`Missing AcrossSpokePoolPeriphery for network ${network}`);
  }

  before(async () => {
    [deployer] = await getAccounts();
    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;
    if (!fs.existsSync(path.resolve(__dirname, `../../deployments/${network}/AcrossBridgeHookV2.json`))) {
      isDeployed = false;
    }
  });

  beforeEach(function () {
    if (!isDeployed) this.skip();
  });

  it("should deploy AcrossBridgeHookV2 with correct params", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHookV2");
    const hook = new AcrossBridgeHookV2__factory(deployer.wallet).attach(hookAddress);

    const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
    const usdcAddress = USDC[network]
      ? USDC[network]
      : getDeployedContractAddress(network, "USDCMock");

    const configuredSpokePool = ACROSS_SPOKE_POOL[network];
    const spokePoolAddress = configuredSpokePool && configuredSpokePool !== ""
      ? configuredSpokePool
      : getDeployedContractAddress(network, "AcrossSpokePoolMock");

    const configuredSpokePoolPeriphery = ACROSS_SPOKE_POOL_PERIPHERY[network];
    const spokePoolPeripheryAddress = _getExpectedSpokePoolPeriphery(
      network,
      configuredSpokePoolPeriphery && configuredSpokePoolPeriphery !== ""
        ? configuredSpokePoolPeriphery
        : undefined
    );

    expect(await hook.orchestrator()).to.eq(orchestratorAddress);
    expect(await hook.inputToken()).to.eq(usdcAddress);
    expect(await hook.spokePool()).to.eq(spokePoolAddress);
    expect(await hook.spokePoolPeriphery()).to.eq(spokePoolPeripheryAddress);
    const rawAllowedExchanges = ACROSS_ALLOWED_EXCHANGES[network] || "";
    const expectedAllowedExchanges = _parseAllowedExchanges(rawAllowedExchanges);
    const fallbackAllowedExchanges = (expectedAllowedExchanges.length === 0 && (network === "localhost" || network === "hardhat"))
      ? [deployer.address]
      : expectedAllowedExchanges;

    if (fallbackAllowedExchanges.length > 0) {
      expect(await hook.allowedExchanges(fallbackAllowedExchanges[0])).to.eq(true);
    }
  });

  it("should transfer ownership to multisig", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHookV2");
    const hook = new AcrossBridgeHookV2__factory(deployer.wallet).attach(hookAddress);

    expect(await hook.owner()).to.eq(multiSig);
  });

  it("should whitelist the hook in the post intent hook registry", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHookV2");
    const registryAddress = getDeployedContractAddress(network, "PostIntentHookRegistry");

    const registry = new PostIntentHookRegistry__factory(deployer.wallet).attach(registryAddress);
    expect(await registry.isWhitelistedHook(hookAddress)).to.eq(true);
  });
});
