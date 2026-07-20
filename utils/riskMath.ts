/** Exact client-side counterparts of RiskManager's integer formulas. */

export type IntegerLike = bigint | number | string | { toString(): string };

export interface IntentExtensionTerms {
  extensionPenaltyBpsPerHour: IntegerLike;
}

export interface RiskCapacity {
  /** null means chargeback coverage is disabled and admission is unbounded by stake. */
  chargebackCapacity: bigint | null;
  /** Admission capacity equals chargeback capacity; extensions are funded only when purchased. */
  totalTakingCapacity: bigint | null;
}

export interface IntentExtensionPenalty {
  penalty: bigint;
  chargeableTime: bigint;
}

export const RISK_BPS_DENOMINATOR = 10_000n;
export const RISK_SECONDS_PER_HOUR = 3_600n;
export const RISK_EXTENSION_DENOMINATOR = RISK_BPS_DENOMINATOR * RISK_SECONDS_PER_HOUR;

function integer(value: IntegerLike, label: string): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  const parsed = BigInt(value.toString());
  if (parsed < 0n) throw new RangeError(`${label} must be non-negative`);
  return parsed;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  if (numerator === 0n) return 0n;
  return ((numerator - 1n) / denominator) + 1n;
}

/** ceil(A * s * T / (10_000 * 1 hour)); returns zero when the curve is disabled. */
export function calculateIntentExtensionCost(
  intentAmount: IntegerLike,
  extensionTime: IntegerLike,
  extensionPenaltyBpsPerHour: IntegerLike,
): bigint {
  const amount = integer(intentAmount, "intentAmount");
  const duration = integer(extensionTime, "extensionTime");
  const slope = integer(extensionPenaltyBpsPerHour, "extensionPenaltyBpsPerHour");
  return ceilDiv(amount * slope * duration, RISK_EXTENSION_DENOMINATOR);
}

/** Charges elapsed post-expiry time, capped by the exact duration purchased. */
export function calculateIntentExtensionPenalty(
  intentAmount: IntegerLike,
  baseIntentExpiry: IntegerLike,
  terminalAt: IntegerLike,
  totalExtensionTime: IntegerLike,
  extensionPenaltyBpsPerHour: IntegerLike,
): IntentExtensionPenalty {
  const baseExpiry = integer(baseIntentExpiry, "baseIntentExpiry");
  const terminal = integer(terminalAt, "terminalAt");
  const purchasedTime = integer(totalExtensionTime, "totalExtensionTime");
  if (terminal <= baseExpiry || purchasedTime === 0n) return { penalty: 0n, chargeableTime: 0n };

  const elapsed = terminal - baseExpiry;
  const chargeableTime = elapsed < purchasedTime ? elapsed : purchasedTime;
  return {
    penalty: calculateIntentExtensionCost(
      intentAmount,
      chargeableTime,
      extensionPenaltyBpsPerHour,
    ),
    chargeableTime,
  };
}

/** ceil(A * r / 10_000); returns zero when chargeback coverage is disabled. */
export function calculateChargebackReserve(amount: IntegerLike, reserveBps: IntegerLike): bigint {
  const intentAmount = integer(amount, "amount");
  const reserveRatio = integer(reserveBps, "reserveBps");
  if (reserveRatio > RISK_BPS_DENOMINATOR) throw new RangeError("reserveBps cannot exceed 10,000");
  return ceilDiv(intentAmount * reserveRatio, RISK_BPS_DENOMINATOR);
}

/** Admission reserves chargeback coverage only; extension collateral is added when time is purchased. */
export function calculateRequiredReservation(amount: IntegerLike, reserveBps: IntegerLike): bigint {
  return calculateChargebackReserve(amount, reserveBps);
}

/** Inverts the exact rounded admission reserve. A null capacity is unbounded. */
export function calculateTakingCapacity(
  freeStake: IntegerLike,
  reserveBps: IntegerLike,
): RiskCapacity {
  const available = integer(freeStake, "freeStake");
  const reserveRatio = integer(reserveBps, "reserveBps");
  if (reserveRatio > RISK_BPS_DENOMINATOR) throw new RangeError("reserveBps cannot exceed 10,000");

  const chargebackCapacity = reserveRatio === 0n
    ? null
    : (available * RISK_BPS_DENOMINATOR) / reserveRatio;
  return { chargebackCapacity, totalTakingCapacity: chargebackCapacity };
}
