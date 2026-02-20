import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

// 0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d
export const CASHAPP_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("cashapp");

export const CASHAPP_CURRENCIES: any = [
  Currency.USD,
];

export const CASHAPP_PROVIDER_CONFIG = {
  paymentMethodHash: CASHAPP_PAYMENT_METHOD_HASH,
  currencies: CASHAPP_CURRENCIES
};
