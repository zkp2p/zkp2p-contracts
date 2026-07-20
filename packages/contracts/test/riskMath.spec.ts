import {
  calculateChargebackReserve,
  calculateChargebackTakingCapacity,
  calculateIntentExtensionFee,
  calculateIntentExtensionFeeDelta,
} from "../../../utils/riskMath";

const HOUR = 3_600n;

describe("riskMath", () => {
  it("rounds chargeback coverage upward", () => {
    expect(calculateChargebackReserve(101n, 5_000)).toBe(51n);
  });

  it("rejects an invalid chargeback reserve ratio", () => {
    expect(() => calculateChargebackReserve(100n, 10_001)).toThrow("reserveBps");
  });

  it("calculates chargeback taking capacity", () => {
    expect(calculateChargebackTakingCapacity(1_000_000_000n, 10_000)).toBe(1_000_000_000n);
    expect(calculateChargebackTakingCapacity(1_000_000_000n, 0)).toBeNull();
  });

  it("calculates the 119-hour extension at 20 percent APR", () => {
    expect(calculateIntentExtensionFee(1_000_000_000n, 2_000, 119n * HOUR)).toBe(2_716_895n);
  });

  it("makes cumulative pricing independent of call splitting", () => {
    const firstDuration = 48n * HOUR;
    const firstFee = calculateIntentExtensionFeeDelta(1_000_000_000n, 2_000, 0, 0, firstDuration);
    const secondFee = calculateIntentExtensionFeeDelta(
      1_000_000_000n,
      2_000,
      firstDuration,
      firstFee,
      71n * HOUR,
    );
    expect(firstFee + secondFee).toBe(2_716_895n);
  });

  it("allows a rounding-only zero marginal fee", () => {
    const firstFee = calculateIntentExtensionFee(1n, 10_000, 1n);
    expect(calculateIntentExtensionFeeDelta(1n, 10_000, 1n, firstFee, 1n)).toBe(0n);
  });

  it("rejects unsafe number inputs", () => {
    expect(() => calculateChargebackReserve(Number.MAX_VALUE, 100)).toThrow("safe integer");
  });
});
