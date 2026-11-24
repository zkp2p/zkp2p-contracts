import "module-alias/register";

import { createStagingPaymentMethodLane } from "../deployments/paymentMethodActivation";
import { UPI_PROVIDER_CONFIG } from "../deployments/verifiers/upi";

export default createStagingPaymentMethodLane({
  tag: "41_add_upi_payment_method",
  tags: ["UpiPaymentMethod"],
  prepareFlag: "PREPARE_STAGING_UPI_PAYMENT_METHOD",
  executeFlag: "EXECUTE_STAGING_UPI_PAYMENT_METHOD",
  method: { label: "UPI", key: "upi", ...UPI_PROVIDER_CONFIG },
});
