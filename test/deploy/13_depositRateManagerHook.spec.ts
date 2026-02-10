import "module-alias/register";

import { deployments } from "hardhat";

import {
  DepositRateManagerHookV1__factory,
} from "../../typechain";

import {
  getAccounts,
  getWaffleExpect,
} from "../../utils/test";
import {
  Account
} from "../../utils/test/types";

const expect = getWaffleExpect();

describe("DepositRateManagerHookV1 Deployment", () => {
  let deployer: Account;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();
  });

  it("should deploy DepositRateManagerHookV1 with correct registry", async () => {
    const hookAddress = getDeployedContractAddress(network, "DepositRateManagerHookV1");
    const hook = new DepositRateManagerHookV1__factory(deployer.wallet).attach(hookAddress);

    const registryAddress = getDeployedContractAddress(network, "ManualRateManagerRegistry");

    expect(await hook.registry()).to.eq(registryAddress);
  });
});
