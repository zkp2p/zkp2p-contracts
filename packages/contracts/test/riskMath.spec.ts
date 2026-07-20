import {
  calculateChargebackReserve,
  calculateIntentExtensionCost,
  calculateIntentExtensionPenalty,
  calculateRequiredReservation,
  calculateTakingCapacity,
} from "../../../utils/riskMath";

const HOUR = 3_600n;

describe("risk math", () => {
  it("calculates cumulative extension collateral with upward rounding", () => {
    expect(calculateIntentExtensionCost(1_000_000_000n, 23n * HOUR, 10n)).toBe(23_000_000n);
    expect(calculateIntentExtensionCost(1n, 1n, 1n)).toBe(1n);
    expect(calculateIntentExtensionCost(1_000_000n, HOUR, 0n)).toBe(0n);
  });

  it("charges only elapsed purchased time after the original expiry", () => {
    expect(calculateIntentExtensionPenalty(1_000_000_000n, 10_000n, 9_999n, 2n * HOUR, 10n))
      .toEqual({ penalty: 0n, chargeableTime: 0n });
    expect(calculateIntentExtensionPenalty(1_000_000_000n, 10_000n, 10_000n + HOUR, 2n * HOUR, 10n))
      .toEqual({ penalty: 1_000_000n, chargeableTime: HOUR });
    expect(calculateIntentExtensionPenalty(1_000_000_000n, 10_000n, 10_000n + 3n * HOUR, 2n * HOUR, 10n))
      .toEqual({ penalty: 2_000_000n, chargeableTime: 2n * HOUR });
  });

  it("prices extensions on the full locked intent amount", () => {
    expect(calculateIntentExtensionCost(500_000_000n, HOUR, 10n)).toBe(500_000n);
  });

  it("reserves chargeback coverage only at admission", () => {
    expect(calculateChargebackReserve(1_000_000_001n, 10_000n)).toBe(1_000_000_001n);
    expect(calculateRequiredReservation(1_000_000_001n, 10_000n)).toBe(1_000_000_001n);
    expect(calculateRequiredReservation(1_000_000_001n, 0n)).toBe(0n);
  });

  it("derives admission capacity only from chargeback reserve", () => {
    expect(calculateTakingCapacity(1_000_000n, 10_000n)).toEqual({
      chargebackCapacity: 1_000_000n,
      totalTakingCapacity: 1_000_000n,
    });
    expect(calculateTakingCapacity(1_000_000n, 0n)).toEqual({
      chargebackCapacity: null,
      totalTakingCapacity: null,
    });
  });

  it("rejects unsafe numbers and reserve ratios", () => {
    expect(() => calculateIntentExtensionCost(Number.MAX_SAFE_INTEGER + 1, HOUR, 1)).toThrow(RangeError);
    expect(() => calculateChargebackReserve(1n, 10_001n)).toThrow(RangeError);
  });
});
