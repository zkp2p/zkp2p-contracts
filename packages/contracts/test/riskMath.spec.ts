import {
  calculateBondedTakingCapacity,
  calculateBondedAmount,
  calculateChargebackReserve,
  calculateDeferredFeeGapUpperBound,
  calculateGriefingPenalty,
  calculateHybridDeferredReservation,
  calculateMaxGriefingBond,
  calculateRequiredReservation,
  calculateTotalTakingCapacity,
} from "../utils/riskMath";

const HOUR = 3_600n;
const terms = {
  maxIntentPeriod: 6n * HOUR,
  griefingCliff: 15n * 60n,
  griefingPenaltyBpsPerHour: 10n,
};

describe("riskMath", () => {
  it("subtracts the reusable base without underflow", () => {
    expect(calculateBondedAmount(700_000_000n, 500_000_000n)).toBe(200_000_000n);
    expect(calculateBondedAmount(500_000_000n, 500_000_000n)).toBe(0n);
    expect(calculateBondedAmount(400_000_000n, 500_000_000n)).toBe(0n);
  });

  it("rounds the maximum griefing bond upward", () => {
    expect(calculateMaxGriefingBond(1_000_000_001n, terms)).toBe(5_750_001n);
  });

  it("returns zero maximum griefing bond for a disabled slope", () => {
    expect(calculateMaxGriefingBond(1_000_000n, { ...terms, griefingPenaltyBpsPerHour: 0 })).toBe(0n);
  });

  it("rounds chargeback coverage upward", () => {
    expect(calculateChargebackReserve(101n, 5_000)).toBe(51n);
  });

  it("rejects an invalid chargeback reserve ratio", () => {
    expect(() => calculateChargebackReserve(100n, 10_001)).toThrow("reserveBps");
  });

  it("takes the maximum of griefing and chargeback requirements", () => {
    expect(calculateRequiredReservation(1_000_000_000n, terms, 10_000, 0)).toBe(1_000_000_000n);
  });

  it("floors the aggregate deferred fee-gap upper bound in token units", () => {
    expect(calculateDeferredFeeGapUpperBound(700_000_000n, 30_000_000_000_000_000n)).toBe(21_000_000n);
    expect(calculateDeferredFeeGapUpperBound(700_000_000n, 1n)).toBe(0n);
  });

  it("reserves the maximum rather than summing griefing and deferred fee-gap exposure", () => {
    expect(calculateHybridDeferredReservation(
      700_000_000n,
      terms,
      30_000_000_000_000_000n,
    )).toBe(21_000_000n);
    expect(calculateHybridDeferredReservation(700_000_000n, terms, 0n)).toBe(4_025_000n);
  });

  it("rejects a deferred fee rate above 100 percent", () => {
    expect(() => calculateDeferredFeeGapUpperBound(100n, 1_000_000_000_000_000_001n))
      .toThrow("totalFeeRate");
  });

  it("charges nothing at the griefing cliff", () => {
    expect(calculateGriefingPenalty(1_000_000_000n, 1_000, 1_000n + 15n * 60n, terms)).toEqual({
      penalty: 0n,
      effectiveElapsed: 15n * 60n,
    });
  });

  it("charges one smallest unit immediately after the cliff when division has a remainder", () => {
    expect(calculateGriefingPenalty(1n, 1_000, 1_000n + 15n * 60n + 1n, terms).penalty).toBe(1n);
  });

  it("caps grievance accrual at the maximum intent period", () => {
    const late = calculateGriefingPenalty(1_000_000_000n, 1_000, 1_000n + 30n * HOUR, terms);
    expect(late.effectiveElapsed).toBe(6n * HOUR);
    expect(late.penalty).toBe(5_750_000n);
  });

  it("returns zero for a cancellation timestamp before creation", () => {
    expect(calculateGriefingPenalty(1_000n, 2_000, 1_000, terms)).toEqual({
      penalty: 0n,
      effectiveElapsed: 0n,
    });
  });

  it("uses the constraining chargeback curve for bonded capacity", () => {
    const capacity = calculateBondedTakingCapacity(1_000_000_000n, terms, 10_000);
    expect(capacity.chargebackCapacity).toBe(1_000_000_000n);
    expect(capacity.bondedTakingCapacity).toBe(1_000_000_000n);
  });

  it("treats disabled curves as unbounded", () => {
    const capacity = calculateBondedTakingCapacity(1_000n, {
      ...terms,
      griefingPenaltyBpsPerHour: 0,
    }, 0);
    expect(capacity).toEqual({
      griefingCapacity: null,
      chargebackCapacity: null,
      bondedTakingCapacity: null,
    });
  });

  it("adds the reusable base to finite bonded capacity", () => {
    expect(calculateTotalTakingCapacity(200_000_000n, 500_000_000n)).toBe(700_000_000n);
    expect(calculateTotalTakingCapacity(null, 500_000_000n)).toBeNull();
  });

  it("rejects unsafe number inputs", () => {
    expect(() => calculateChargebackReserve(Number.MAX_VALUE, 100)).toThrow("safe integer");
  });
});
