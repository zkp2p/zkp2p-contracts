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

import { VENMO_PROVIDER_CONFIG } from "../../deployments/verifiers/venmo";
import { REVOLUT_PROVIDER_CONFIG } from "../../deployments/verifiers/revolut";
import { CASHAPP_PROVIDER_CONFIG } from "../../deployments/verifiers/cashapp";
import { WISE_PROVIDER_CONFIG } from "../../deployments/verifiers/wise";
import { MERCADOPAGO_PROVIDER_CONFIG } from "../../deployments/verifiers/mercadopago";
import { ZELLE_PROVIDER_CONFIG } from "../../deployments/verifiers/zelle";
import { PAYPAL_PROVIDER_CONFIG } from "../../deployments/verifiers/paypal";
import { MONZO_PROVIDER_CONFIG } from "../../deployments/verifiers/monzo";
import { ALIPAY_PROVIDER_CONFIG } from "../../deployments/verifiers/alipay";
import { CHIME_PROVIDER_CONFIG } from "../../deployments/verifiers/chime";

const expect = getWaffleExpect();

const ALL_PAYMENT_METHODS = [
  { name: "Venmo", config: VENMO_PROVIDER_CONFIG },
  { name: "Revolut", config: REVOLUT_PROVIDER_CONFIG },
  { name: "CashApp", config: CASHAPP_PROVIDER_CONFIG },
  { name: "Wise", config: WISE_PROVIDER_CONFIG },
  { name: "MercadoPago", config: MERCADOPAGO_PROVIDER_CONFIG },
  { name: "Zelle", config: ZELLE_PROVIDER_CONFIG },
  { name: "PayPal", config: PAYPAL_PROVIDER_CONFIG },
  { name: "Monzo", config: MONZO_PROVIDER_CONFIG },
  { name: "Alipay", config: ALIPAY_PROVIDER_CONFIG },
  { name: "Chime", config: CHIME_PROVIDER_CONFIG },
];

describe("V2 Payment Methods Configuration", () => {
  let deployer: Account;

  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;
  let v2VerifierAddress: string;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();

    const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
    paymentVerifierRegistry = new PaymentVerifierRegistry__factory(deployer.wallet).attach(paymentVerifierRegistryAddress);

    v2VerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    unifiedPaymentVerifierV2 = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(v2VerifierAddress);
  });

  for (const { name, config } of ALL_PAYMENT_METHODS) {
    describe(`${name}`, async () => {
      it("should be registered in PaymentVerifierRegistry", async () => {
        const isPaymentMethod = await paymentVerifierRegistry.isPaymentMethod(config.paymentMethodHash);
        expect(isPaymentMethod).to.be.true;
      });

      it("should point to V2 verifier", async () => {
        const verifier = await paymentVerifierRegistry.getVerifier(config.paymentMethodHash);
        expect(verifier).to.eq(v2VerifierAddress);
      });

      it("should have correct currencies", async () => {
        const currencies = await paymentVerifierRegistry.getCurrencies(config.paymentMethodHash);
        expect(currencies).to.deep.eq(config.currencies);
      });

      it("should be registered in V2 unified verifier", async () => {
        const paymentMethods = await unifiedPaymentVerifierV2.getPaymentMethods();
        expect(paymentMethods).to.include(config.paymentMethodHash);
      });
    });
  }
});
