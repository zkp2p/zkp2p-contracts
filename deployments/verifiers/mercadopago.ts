import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

export const MERCADOPAGO_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("mercadopago");

export const MERCADOPAGO_CURRENCIES: any = [
  Currency.ARS
];

export const MERCADOPAGO_PROVIDER_CONFIG = {
  paymentMethodHash: MERCADOPAGO_PAYMENT_METHOD_HASH,
  currencies: MERCADOPAGO_CURRENCIES
};
