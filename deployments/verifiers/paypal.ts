import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

export const PAYPAL_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("paypal");

export const PAYPAL_CURRENCIES: any = [
  Currency.USD,
  Currency.EUR,
  Currency.GBP,
  Currency.SGD,
  Currency.NZD,
  Currency.AUD,
  Currency.CAD
];

export const PAYPAL_PROVIDER_CONFIG = {
  paymentMethodHash: PAYPAL_PAYMENT_METHOD_HASH,
  currencies: PAYPAL_CURRENCIES
};
