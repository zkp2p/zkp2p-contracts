/** Exact client-side counterparts of RiskManager's integer formulas. */

export type IntegerLike = bigint | number | string | { toString(): string };

export interface GriefingTerms {
  maxIntentPeriod: IntegerLike;
  griefingCliff: IntegerLike;
  griefingPenaltyBpsPerHour: IntegerLike;
}

export interface RiskCapacity {
  /** null means this disabled curve does not constrain capacity. */
  griefingCapacity: bigint | null;
  /** null means this disabled curve does not constrain capacity. */
  chargebackCapacity: bigint | null;
  /** null means both curves are disabled and bonded capacity is unbounded. */
  bondedTakingCapacity: bigint | null;
}

export interface GriefingPenalty {
  penalty: bigint;
  effectiveElapsed: bigint;
}

export const RISK_BPS_DENOMINATOR = 10_000n;
export const RISK_SECONDS_PER_HOUR = 3_600n;
export const RISK_GRIEFING_DENOMINATOR = RISK_BPS_DENOMINATOR * RISK_SECONDS_PER_HOUR;

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

/** max(intent amount - reusable base unbonded amount, 0). */
export function calculateBondedAmount(amount: IntegerLike, baseUnbondedAmount: IntegerLike): bigint {
  const intentAmount = integer(amount, "amount");
  const baseAmount = integer(baseUnbondedAmount, "baseUnbondedAmount");
  return intentAmount > baseAmount ? intentAmount - baseAmount : 0n;
}

/** ceil(A * s * (T - C) / (10_000 * 1 hour)); returns zero when the curve is disabled. */
export function calculateMaxGriefingBond(amount: IntegerLike, terms: GriefingTerms): bigint {
  const bondedAmount = integer(amount, "amount");
  const maxIntentPeriod = integer(terms.maxIntentPeriod, "maxIntentPeriod");
  const griefingCliff = integer(terms.griefingCliff, "griefingCliff");
  const slope = integer(terms.griefingPenaltyBpsPerHour, "griefingPenaltyBpsPerHour");
  if (slope === 0n || maxIntentPeriod <= griefingCliff) return 0n;
  return ceilDiv(
    bondedAmount * slope * (maxIntentPeriod - griefingCliff),
    RISK_GRIEFING_DENOMINATOR,
  );
}

/** ceil(A * r / 10_000); returns zero when chargeback coverage is disabled. */
export function calculateChargebackReserve(amount: IntegerLike, reserveBps: IntegerLike): bigint {
  const bondedAmount = integer(amount, "amount");
  const reserveRatio = integer(reserveBps, "reserveBps");
  if (reserveRatio > RISK_BPS_DENOMINATOR) throw new RangeError("reserveBps cannot exceed 10,000");
  return ceilDiv(bondedAmount * reserveRatio, RISK_BPS_DENOMINATOR);
}

/** max(maxGriefingBond, chargebackReserve), never their sum. */
export function calculateRequiredReservation(
  amount: IntegerLike,
  terms: GriefingTerms,
  reserveBps: IntegerLike,
  baseUnbondedAmount: IntegerLike,
): bigint {
  const griefingBond = calculateMaxGriefingBond(calculateBondedAmount(amount, baseUnbondedAmount), terms);
  const chargebackReserve = calculateChargebackReserve(amount, reserveBps);
  return griefingBond > chargebackReserve ? griefingBond : chargebackReserve;
}

/**
 * Deferred settlement is funded by the future gross Escrow release, so admission reserves only the
 * pending-intent griefing bond. Fees become contingent claims against gross deferred stake at settlement.
 */
export function calculateDeferredAdmissionReservation(
  amount: IntegerLike,
  terms: GriefingTerms,
  baseUnbondedAmount: IntegerLike = 0n,
): bigint {
  return calculateMaxGriefingBond(calculateBondedAmount(amount, baseUnbondedAmount), terms);
}

/** Capped, upward-rounded time-linear penalty used for cancellation and reconciliation. */
export function calculateGriefingPenalty(
  amount: IntegerLike,
  createdAt: IntegerLike,
  cancelledAt: IntegerLike,
  terms: GriefingTerms,
): GriefingPenalty {
  const bondedAmount = integer(amount, "amount");
  const created = integer(createdAt, "createdAt");
  const cancelled = integer(cancelledAt, "cancelledAt");
  const maxIntentPeriod = integer(terms.maxIntentPeriod, "maxIntentPeriod");
  const griefingCliff = integer(terms.griefingCliff, "griefingCliff");
  const slope = integer(terms.griefingPenaltyBpsPerHour, "griefingPenaltyBpsPerHour");
  if (cancelled <= created) return { penalty: 0n, effectiveElapsed: 0n };

  const elapsed = cancelled - created;
  const effectiveElapsed = elapsed < maxIntentPeriod ? elapsed : maxIntentPeriod;
  if (slope === 0n || effectiveElapsed <= griefingCliff) {
    return { penalty: 0n, effectiveElapsed };
  }

  const chargeableTime = effectiveElapsed - griefingCliff;
  return {
    penalty: ceilDiv(bondedAmount * slope * chargeableTime, RISK_GRIEFING_DENOMINATOR),
    effectiveElapsed,
  };
}

/**
 * Inverts the exact rounded reservation curves. A null capacity denotes a disabled constraint.
 * Because ceil(A*n/d) <= S iff A*n <= S*d, each inverse uses floor(S*d/n).
 */
export function calculateBondedTakingCapacity(
  freeStake: IntegerLike,
  terms: GriefingTerms,
  reserveBps: IntegerLike,
): RiskCapacity {
  const available = integer(freeStake, "freeStake");
  const maxIntentPeriod = integer(terms.maxIntentPeriod, "maxIntentPeriod");
  const griefingCliff = integer(terms.griefingCliff, "griefingCliff");
  const slope = integer(terms.griefingPenaltyBpsPerHour, "griefingPenaltyBpsPerHour");
  const reserveRatio = integer(reserveBps, "reserveBps");
  if (reserveRatio > RISK_BPS_DENOMINATOR) throw new RangeError("reserveBps cannot exceed 10,000");

  const griefingRateNumerator = maxIntentPeriod > griefingCliff
    ? slope * (maxIntentPeriod - griefingCliff)
    : 0n;
  const griefingCapacity = griefingRateNumerator === 0n
    ? null
    : (available * RISK_GRIEFING_DENOMINATOR) / griefingRateNumerator;
  const chargebackCapacity = reserveRatio === 0n
    ? null
    : (available * RISK_BPS_DENOMINATOR) / reserveRatio;

  let bondedTakingCapacity: bigint | null;
  if (griefingCapacity === null) bondedTakingCapacity = chargebackCapacity;
  else if (chargebackCapacity === null) bondedTakingCapacity = griefingCapacity;
  else bondedTakingCapacity = griefingCapacity < chargebackCapacity ? griefingCapacity : chargebackCapacity;

  return { griefingCapacity, chargebackCapacity, bondedTakingCapacity };
}

/** Adds the reusable base tranche to a finite bonded capacity; null remains unbounded. */
export function calculateTotalTakingCapacity(
  bondedTakingCapacity: IntegerLike | null,
  baseUnbondedAmount: IntegerLike,
): bigint | null {
  if (bondedTakingCapacity === null) return null;
  return integer(bondedTakingCapacity, "bondedTakingCapacity")
    + integer(baseUnbondedAmount, "baseUnbondedAmount");
}
