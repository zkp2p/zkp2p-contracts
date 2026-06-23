import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";
// Provider hashes are verified off-chain in the attestation service

export const ZELLE_CURRENCIES: any = [
  Currency.USD
];

// Payment method hashes
export const ZELLE_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("zelle");
export const ZELLE_CITI_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("zelle-citi");
export const ZELLE_CHASE_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("zelle-chase");
export const ZELLE_BOFA_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("zelle-bofa");

export const ZELLE_PROVIDER_CONFIG = {
  paymentMethodHash: ZELLE_PAYMENT_METHOD_HASH,
  currencies: ZELLE_CURRENCIES
};

export const ZELLE_CITI_PROVIDER_CONFIG = {
  paymentMethodHash: ZELLE_CITI_PAYMENT_METHOD_HASH,
  currencies: ZELLE_CURRENCIES
};

export const ZELLE_CHASE_PROVIDER_CONFIG = {
  paymentMethodHash: ZELLE_CHASE_PAYMENT_METHOD_HASH,
  currencies: ZELLE_CURRENCIES
};

export const ZELLE_BOFA_PROVIDER_CONFIG = {
  paymentMethodHash: ZELLE_BOFA_PAYMENT_METHOD_HASH,
  currencies: ZELLE_CURRENCIES
};
