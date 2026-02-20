import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

export const CHIME_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("chime");

export const CHIME_CURRENCIES: any = [
  Currency.USD,
];

export const CHIME_PROVIDER_CONFIG = {
  paymentMethodHash: CHIME_PAYMENT_METHOD_HASH,
  currencies: CHIME_CURRENCIES
};
