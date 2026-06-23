import "module-alias/register";

import { deployments } from "hardhat";

import {
  UnifiedPaymentVerifier,
  PaymentVerifierRegistry,
} from "../../utils/contracts";
import {
  UnifiedPaymentVerifier__factory,
  PaymentVerifierRegistry__factory,
} from "../../typechain";

import {
  getAccounts,
  getWaffleExpect,
} from "../../utils/test";
import {
  Account
} from "../../utils/test/types";

import { N26_PAYMENT_METHOD_HASH } from "../../deployments/verifiers/n26";

const expect = getWaffleExpect();

describe("N26 Payment Method Configuration", () => {
  let deployer: Account;

  let unifiedPaymentVerifier: UnifiedPaymentVerifier;
  let paymentVerifierRegistry: PaymentVerifierRegistry;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [
      deployer,
    ] = await getAccounts();

    const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
    paymentVerifierRegistry = new PaymentVerifierRegistry__factory(deployer.wallet).attach(paymentVerifierRegistryAddress);

    const unifiedPaymentVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
    unifiedPaymentVerifier = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(unifiedPaymentVerifierAddress);
  });

  describe("Payment Method Registry", async () => {
    it("should remove N26 payment method from the registry", async () => {
      const isPaymentMethod = await paymentVerifierRegistry.isPaymentMethod(N26_PAYMENT_METHOD_HASH);
      expect(isPaymentMethod).to.be.false;
    });

    it("should remove N26 currencies from the registry", async () => {
      const currencies = await paymentVerifierRegistry.getCurrencies(N26_PAYMENT_METHOD_HASH);
      expect(currencies).to.deep.eq([]);
    });
  });

  describe("Unified Verifier Configuration", async () => {
    it("should remove N26 payment method from unified verifier", async () => {
      const paymentMethods = await unifiedPaymentVerifier.getPaymentMethods();
      expect(paymentMethods).to.not.include(N26_PAYMENT_METHOD_HASH);
    });
  });
});
