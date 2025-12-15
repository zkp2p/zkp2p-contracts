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
import { ALIPAY_PROVIDER_CONFIG } from "../../deployments/verifiers/alipay";
import { ALIPAY_PAYMENT_METHOD_HASH } from "../../deployments/verifiers/alipay";

const expect = getWaffleExpect();

describe("Alipay Payment Method Configuration", () => {
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
    it("should add Alipay payment method to the registry", async () => {
      const isPaymentMethod = await paymentVerifierRegistry.isPaymentMethod(ALIPAY_PAYMENT_METHOD_HASH);
      expect(isPaymentMethod).to.be.true;
    });

    it("should add Alipay currencies to the registry", async () => {
      const currencies = await paymentVerifierRegistry.getCurrencies(ALIPAY_PAYMENT_METHOD_HASH);
      expect(currencies).to.deep.eq(ALIPAY_PROVIDER_CONFIG.currencies);
    });

    it("should only support CNY currency for Alipay", async () => {
      const currencies = await paymentVerifierRegistry.getCurrencies(ALIPAY_PAYMENT_METHOD_HASH);
      // Alipay only supports CNY
      expect(currencies.length).to.eq(1);
      expect(currencies[0]).to.eq(ALIPAY_PROVIDER_CONFIG.currencies[0]);
    });
  });

  describe("Unified Verifier Configuration", async () => {
    it("should add Alipay payment method to unified verifier", async () => {
      const paymentMethods = await unifiedPaymentVerifier.getPaymentMethods();
      expect(paymentMethods).to.include(ALIPAY_PAYMENT_METHOD_HASH);
    });
  });
});
