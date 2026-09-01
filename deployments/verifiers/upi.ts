import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

export const UPI_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("upi");

export const UPI_CURRENCIES: string[] = [Currency.INR];

export const UPI_PROVIDER_CONFIG = {
  paymentMethodHash: UPI_PAYMENT_METHOD_HASH,
  currencies: UPI_CURRENCIES,
};
