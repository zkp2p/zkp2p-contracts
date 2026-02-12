import "module-alias/register";

import { deployments, ethers } from "hardhat";

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

  it("should deploy DepositRateManagerHookV1", async () => {
    const hookAddress = getDeployedContractAddress(network, "DepositRateManagerHookV1");
    const hook = new DepositRateManagerHookV1__factory(deployer.wallet).attach(hookAddress);

    expect(hook.address).to.not.eq(ethers.constants.AddressZero);
    expect(await ethers.provider.getCode(hook.address)).to.not.eq("0x");
  });
});
