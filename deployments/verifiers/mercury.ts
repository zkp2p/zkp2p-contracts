import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

export const MERCURY_PAYMENT_METHOD_HASH =
  calculatePaymentMethodHash("mercury");

export const MERCURY_CURRENCIES: string[] = [Currency.USD];

export const MERCURY_PROVIDER_CONFIG = {
  paymentMethodHash: MERCURY_PAYMENT_METHOD_HASH,
  currencies: MERCURY_CURRENCIES,
};
