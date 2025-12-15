import { BigNumber, ethers } from "ethers";
import { calculatePaymentMethodHash, Currency } from "@utils/protocolUtils";

export const ALIPAY_PAYMENT_METHOD_HASH = calculatePaymentMethodHash("alipay");

export const ALIPAY_CURRENCIES: any = [
  Currency.CNY,
];

export const ALIPAY_PROVIDER_CONFIG = {
  paymentMethodHash: ALIPAY_PAYMENT_METHOD_HASH,
  currencies: ALIPAY_CURRENCIES
};
