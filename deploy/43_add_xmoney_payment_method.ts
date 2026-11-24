import "module-alias/register";

import { createStagingPaymentMethodLane } from "../deployments/paymentMethodActivation";
import { XMONEY_PROVIDER_CONFIG } from "../deployments/verifiers/xmoney";

export default createStagingPaymentMethodLane({
  tag: "43_add_xmoney_payment_method",
  tags: [],
  prepareFlag: "PREPARE_STAGING_XMONEY_PAYMENT_METHOD",
  executeFlag: "EXECUTE_STAGING_XMONEY_PAYMENT_METHOD",
  method: { label: "X Money", key: "xmoney", ...XMONEY_PROVIDER_CONFIG },
});
