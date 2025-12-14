import { BigNumber, ethers } from "ethers";
import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

export const N26_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("n26");

export const N26_CURRENCIES: any = [
  Currency.EUR,
];

export const N26_PROVIDER_CONFIG = {
  paymentMethodHash: N26_PAYMENT_METHOD_HASH,
  currencies: N26_CURRENCIES
};
