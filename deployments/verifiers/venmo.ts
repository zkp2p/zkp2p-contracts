import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

// 0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268
export const VENMO_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("venmo");


export const VENMO_CURRENCIES: any = [
  Currency.USD,
];

export const VENMO_PROVIDER_CONFIG = {
  paymentMethodHash: VENMO_PAYMENT_METHOD_HASH,
  currencies: VENMO_CURRENCIES
};
