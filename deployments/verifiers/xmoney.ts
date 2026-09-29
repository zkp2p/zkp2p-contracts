import {
  calculatePaymentMethodHash,
  Currency,
} from "../../utils/protocolUtils";

export const XMONEY_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("xmoney");

export const XMONEY_CURRENCIES: string[] = [Currency.USD];

export const XMONEY_PROVIDER_CONFIG = {
  paymentMethodHash: XMONEY_PAYMENT_METHOD_HASH,
  currencies: XMONEY_CURRENCIES,
};
