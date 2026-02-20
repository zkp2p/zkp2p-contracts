import "module-alias/register";

import { deployments, ethers } from "hardhat";

import {
  UnifiedPaymentVerifier,
  PaymentVerifierRegistry,
  Escrow,
} from "../../utils/contracts";
import {
  UnifiedPaymentVerifier__factory,
  Escrow__factory,
  PaymentVerifierRegistry__factory,
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
  MULTI_SIG,
} from "../../deployments/parameters";
import { LUXON_PROVIDER_CONFIG } from "../../deployments/verifiers/luxon";
import { LUXON_PAYMENT_METHOD_HASH } from "../../deployments/verifiers/luxon";

const expect = getWaffleExpect();

describe("Luxon Payment Method Configuration", () => {
  let deployer: Account;
  let multiSig: Address;
  let escrowAddress: string;

  let escrow: Escrow;
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

    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;

    escrowAddress = getDeployedContractAddress(network, "Escrow");
    escrow = new Escrow__factory(deployer.wallet).attach(escrowAddress);

    const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
    paymentVerifierRegistry = new PaymentVerifierRegistry__factory(deployer.wallet).attach(paymentVerifierRegistryAddress);

    const unifiedPaymentVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
    unifiedPaymentVerifier = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(unifiedPaymentVerifierAddress);
  });

  describe("Payment Method Registry", async () => {
    it("should add Luxon payment method to the registry", async () => {
      const isPaymentMethod = await paymentVerifierRegistry.isPaymentMethod(LUXON_PAYMENT_METHOD_HASH);
      expect(isPaymentMethod).to.be.true;
    });

    it("should add Luxon currencies to the registry", async () => {
      const currencies = await paymentVerifierRegistry.getCurrencies(LUXON_PAYMENT_METHOD_HASH);
      expect(currencies).to.deep.eq(LUXON_PROVIDER_CONFIG.currencies);
    });

    it("should support USD, EUR, and GBP for Luxon", async () => {
      const currencies = await paymentVerifierRegistry.getCurrencies(LUXON_PAYMENT_METHOD_HASH);
      expect(currencies.length).to.eq(3);
      expect(currencies[0]).to.eq(LUXON_PROVIDER_CONFIG.currencies[0]);
      expect(currencies[1]).to.eq(LUXON_PROVIDER_CONFIG.currencies[1]);
      expect(currencies[2]).to.eq(LUXON_PROVIDER_CONFIG.currencies[2]);
    });
  });

  describe("Unified Verifier Configuration", async () => {
    it("should add Luxon payment method to unified verifier", async () => {
      const paymentMethods = await unifiedPaymentVerifier.getPaymentMethods();
      expect(paymentMethods).to.include(LUXON_PAYMENT_METHOD_HASH);
    });
  });
});
