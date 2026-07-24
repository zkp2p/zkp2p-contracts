/** Exact client-side counterparts of IntentGuardian and RiskManager integer formulas. */

export type IntegerLike = bigint | number | string | { toString(): string };

export type RiskMode = "UNBONDED" | "STAKE_BACKED" | "DEFERRED_PAYOUT";

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

/** Exact counterpart of IntentGuardian's ceil(A * s * T / (10_000 * 1 hour)) quote. */
export function quoteIntentGuardianExtensionCost(
  intentAmount: IntegerLike,
  extensionTime: IntegerLike,
  extensionFeeBpsPerHour: IntegerLike,
): bigint {
  const amount = integer(intentAmount, "intentAmount");
  const duration = integer(extensionTime, "extensionTime");
  const fee = integer(extensionFeeBpsPerHour, "extensionFeeBpsPerHour");
  return ceilDiv(amount * fee * duration, RISK_EXTENSION_DENOMINATOR);
}

/** Backwards-compatible RiskManager name for the same integer pricing formula. */
export function calculateIntentExtensionCost(
  intentAmount: IntegerLike,
  extensionTime: IntegerLike,
  extensionPenaltyBpsPerHour: IntegerLike,
): bigint {
  return quoteIntentGuardianExtensionCost(
    intentAmount,
    extensionTime,
    extensionPenaltyBpsPerHour,
  );
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

/** Full-gross coverage required at admission; zero when chargebacks are disabled. */
export function calculateRequiredCoverage(
  amount: IntegerLike,
  chargebackable: boolean,
): bigint {
  return chargebackable ? integer(amount, "amount") : 0n;
}

/** Maximum chargebackable intent amount that can use existing stake. */
export function calculateStakeBackedCapacity(freeStake: IntegerLike): bigint {
  return integer(freeStake, "freeStake");
}

/** Exact admission mode selected by RiskManager's full-gross policy. */
export function selectRiskMode(
  amount: IntegerLike,
  freeStake: IntegerLike,
  chargebackable: boolean,
  deferredPayoutEnabled: boolean,
): RiskMode {
  const required = calculateRequiredCoverage(amount, chargebackable);
  if (!chargebackable) return "UNBONDED";
  if (integer(freeStake, "freeStake") >= required) return "STAKE_BACKED";
  if (deferredPayoutEnabled) return "DEFERRED_PAYOUT";
  throw new RangeError("insufficient collateral and deferred payout is disabled");
}
