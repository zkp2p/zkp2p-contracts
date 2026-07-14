import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";
// Provider hashes are verified off-chain in the attestation service

export const ZELLE_CURRENCIES: any = [
  Currency.USD
];

// Payment method hashes
export const ZELLE_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("zelle");

export const ZELLE_PROVIDER_CONFIG = {
  paymentMethodHash: ZELLE_PAYMENT_METHOD_HASH,
  currencies: ZELLE_CURRENCIES
};
