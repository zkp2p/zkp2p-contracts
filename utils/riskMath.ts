/** Exact client-side counterparts of RiskManager's integer formulas. */

export type IntegerLike = bigint | number | string | { toString(): string };

export const RISK_BPS_DENOMINATOR = 10_000n;
export const RISK_SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
export const RISK_EXTENSION_FEE_DENOMINATOR = RISK_BPS_DENOMINATOR * RISK_SECONDS_PER_YEAR;

function integer(value: IntegerLike, label: string): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  const parsed = BigInt(value.toString());
  if (parsed < 0n) throw new RangeError(`${label} must be non-negative`);
  return parsed;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator === 0n) return 0n;
  return ((numerator - 1n) / denominator) + 1n;
}

/** ceil(A * r / 10_000); returns zero when chargeback coverage is disabled. */
export function calculateChargebackReserve(amount: IntegerLike, reserveBps: IntegerLike): bigint {
  const grossAmount = integer(amount, "amount");
  const reserveRatio = integer(reserveBps, "reserveBps");
  if (reserveRatio > RISK_BPS_DENOMINATOR) throw new RangeError("reserveBps cannot exceed 10,000");
  return ceilDiv(grossAmount * reserveRatio, RISK_BPS_DENOMINATOR);
}

/** Maximum gross chargebackable intent amount supported by the supplied free stake. */
export function calculateChargebackTakingCapacity(
  freeStake: IntegerLike,
  reserveBps: IntegerLike,
): bigint | null {
  const available = integer(freeStake, "freeStake");
  const reserveRatio = integer(reserveBps, "reserveBps");
  if (reserveRatio > RISK_BPS_DENOMINATOR) throw new RangeError("reserveBps cannot exceed 10,000");
  if (reserveRatio === 0n) return null;
  return (available * RISK_BPS_DENOMINATOR) / reserveRatio;
}

/** ceil(A * annualFeeBps * seconds / (10_000 * 365 days)). */
export function calculateIntentExtensionFee(
  amount: IntegerLike,
  annualFeeBps: IntegerLike,
  extensionSeconds: IntegerLike,
): bigint {
  const grossAmount = integer(amount, "amount");
  const annualRate = integer(annualFeeBps, "annualFeeBps");
  const duration = integer(extensionSeconds, "extensionSeconds");
  if (annualRate > RISK_BPS_DENOMINATOR) {
    throw new RangeError("annualFeeBps cannot exceed 10,000");
  }
  return ceilDiv(grossAmount * annualRate * duration, RISK_EXTENSION_FEE_DENOMINATOR);
}

/** Split-invariant marginal charge for additional purchased extension seconds. */
export function calculateIntentExtensionFeeDelta(
  amount: IntegerLike,
  annualFeeBps: IntegerLike,
  purchasedExtensionSeconds: IntegerLike,
  extensionFeesPaid: IntegerLike,
  additionalExtensionSeconds: IntegerLike,
): bigint {
  const purchased = integer(purchasedExtensionSeconds, "purchasedExtensionSeconds");
  const paid = integer(extensionFeesPaid, "extensionFeesPaid");
  const additional = integer(additionalExtensionSeconds, "additionalExtensionSeconds");
  const cumulativeFee = calculateIntentExtensionFee(amount, annualFeeBps, purchased + additional);
  if (paid > cumulativeFee) throw new RangeError("extensionFeesPaid exceeds cumulative fee");
  return cumulativeFee - paid;
}
