import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

// keccak256("luxon")
export const LUXON_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("luxon");

export const LUXON_CURRENCIES: any = [
  Currency.USD,
  Currency.EUR,
  Currency.GBP,
];

export const LUXON_PROVIDER_CONFIG = {
  paymentMethodHash: LUXON_PAYMENT_METHOD_HASH,
  currencies: LUXON_CURRENCIES
};
