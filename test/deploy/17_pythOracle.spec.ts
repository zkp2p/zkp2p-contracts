import "module-alias/register";

import { deployments } from "hardhat";

import {
  PythOracleAdapter__factory,
  PythMock__factory,
} from "../../typechain";

import {
  getAccounts,
  getWaffleExpect,
} from "../../utils/test";
import {
  Account
} from "../../utils/test/types";

import {
  PYTH_CONTRACT,
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("Pyth Oracle Deployment", () => {
  let deployer: Account;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();
  });

  describe("PythMock (localhost only)", async () => {
    it("should be deployed on localhost", async () => {
      if (network !== "localhost" && network !== "hardhat") {
        return; // skip on non-local networks
      }

      const address = getDeployedContractAddress(network, "PythMock");
      expect(address).to.not.eq("0x0000000000000000000000000000000000000000");
    });
  });

  describe("PythOracleAdapter", async () => {
    it("should be deployed", async () => {
      const address = getDeployedContractAddress(network, "PythOracleAdapter");
      expect(address).to.not.eq("0x0000000000000000000000000000000000000000");
    });

    it("should have the correct pyth address", async () => {
      const adapterAddress = getDeployedContractAddress(network, "PythOracleAdapter");
      const adapter = new PythOracleAdapter__factory(deployer.wallet).attach(adapterAddress);

      const configuredPyth = PYTH_CONTRACT[network];
      const expectedPyth = configuredPyth && configuredPyth !== ""
        ? configuredPyth
        : getDeployedContractAddress(network, "PythMock");

      expect(await adapter.pyth()).to.eq(expectedPyth);
    });
  });
});
