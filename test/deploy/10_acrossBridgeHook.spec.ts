import "module-alias/register";

import { deployments } from "hardhat";

import {
  AcrossBridgeHook__factory,
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

import {
  ACROSS_SPOKE_POOL,
  MULTI_SIG,
  USDC,
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("Across Bridge Hook Deployment", () => {
  let deployer: Account;
  let multiSig: Address;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();
    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;
  });

  it("should deploy AcrossBridgeHook with correct params", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHook");
    const hook = new AcrossBridgeHook__factory(deployer.wallet).attach(hookAddress);

    const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
    const usdcAddress = USDC[network]
      ? USDC[network]
      : getDeployedContractAddress(network, "USDCMock");

    const configuredSpokePool = ACROSS_SPOKE_POOL[network];
    const spokePoolAddress = configuredSpokePool && configuredSpokePool !== ""
      ? configuredSpokePool
      : getDeployedContractAddress(network, "AcrossSpokePoolMock");

    expect(await hook.orchestrator()).to.eq(orchestratorAddress);
    expect(await hook.inputToken()).to.eq(usdcAddress);
    expect(await hook.spokePool()).to.eq(spokePoolAddress);
  });

  it("should transfer ownership to multisig", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHook");
    const hook = new AcrossBridgeHook__factory(deployer.wallet).attach(hookAddress);

    expect(await hook.owner()).to.eq(multiSig);
  });

  it("should whitelist the hook in the post intent hook registry", async () => {
    const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHook");
    const registryAddress = getDeployedContractAddress(network, "PostIntentHookRegistry");

    const registry = new PostIntentHookRegistry__factory(deployer.wallet).attach(registryAddress);
    expect(await registry.isWhitelistedHook(hookAddress)).to.eq(true);
  });
});
