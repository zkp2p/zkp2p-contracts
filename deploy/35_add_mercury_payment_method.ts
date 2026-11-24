import "module-alias/register";

import { createStagingPaymentMethodLane } from "../deployments/paymentMethodActivation";
import { MERCURY_PROVIDER_CONFIG } from "../deployments/verifiers/mercury";

export default createStagingPaymentMethodLane({
  tag: "35_add_mercury_payment_method",
  tags: ["MercuryPaymentMethod"],
  prepareFlag: "PREPARE_STAGING_MERCURY_PAYMENT_METHOD",
  executeFlag: "EXECUTE_STAGING_MERCURY_PAYMENT_METHOD",
  method: { label: "Mercury", key: "mercury", ...MERCURY_PROVIDER_CONFIG },
});
