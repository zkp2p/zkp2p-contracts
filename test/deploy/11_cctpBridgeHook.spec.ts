import "module-alias/register";

import { deployments } from "hardhat";

import {
  CctpBridgeHook__factory,
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
  CCTP_SOURCE_DOMAIN,
  CCTP_TOKEN_MESSENGER_V2,
  MULTI_SIG,
  USDC,
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("CCTP Bridge Hook Deployment", () => {
  let deployer: Account;
  let multiSig: Address;

  const network: string = deployments.getNetworkName();

  async function getDeployedContractAddress(network: string, contractName: string): Promise<string> {
    if (network === "hardhat") {
      const deployment = await deployments.get(contractName);
      return deployment.address;
    }
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();
    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;
    if (network === "hardhat") {
      await deployments.fixture(["system", "cctp"]);
    }
  });

  it("should deploy CctpBridgeHook with correct params", async () => {
    const hookAddress = await getDeployedContractAddress(network, "CctpBridgeHook");
    const hook = new CctpBridgeHook__factory(deployer.wallet).attach(hookAddress);

    const orchestratorAddress = await getDeployedContractAddress(network, "Orchestrator");
    const usdcAddress = USDC[network]
      ? USDC[network]
      : await getDeployedContractAddress(network, "USDCMock");

    const configuredMessenger = CCTP_TOKEN_MESSENGER_V2[network];
    const messengerAddress = configuredMessenger && configuredMessenger !== ""
      ? configuredMessenger
      : await getDeployedContractAddress(network, "TokenMessengerV2Mock");

    expect(await hook.orchestrator()).to.eq(orchestratorAddress);
    expect(await hook.inputToken()).to.eq(usdcAddress);
    expect(await hook.tokenMessenger()).to.eq(messengerAddress);
    expect(await hook.sourceDomain()).to.eq(CCTP_SOURCE_DOMAIN[network]);
    expect(await hook.maxFeeBps()).to.eq(10);
  });

  it("should transfer ownership to multisig", async () => {
    const hookAddress = await getDeployedContractAddress(network, "CctpBridgeHook");
    const hook = new CctpBridgeHook__factory(deployer.wallet).attach(hookAddress);

    expect(await hook.owner()).to.eq(multiSig);
  });

  it("should whitelist the hook in the post intent hook registry", async () => {
    const hookAddress = await getDeployedContractAddress(network, "CctpBridgeHook");
    const registryAddress = await getDeployedContractAddress(network, "PostIntentHookRegistry");

    const registry = new PostIntentHookRegistry__factory(deployer.wallet).attach(registryAddress);
    expect(await registry.isWhitelistedHook(hookAddress)).to.eq(true);
  });
});
