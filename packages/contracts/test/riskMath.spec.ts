import {
  calculateIntentExtensionCost,
  calculateRequiredCoverage,
  calculateStakeBackedCapacity,
  selectRiskMode,
} from "../../../utils/riskMath";

const HOUR = 3_600n;

describe("risk math", () => {
  it("calculates cumulative extension collateral with upward rounding", () => {
    expect(calculateIntentExtensionCost(1_000_000_000n, 23n * HOUR, 10n)).toBe(23_000_000n);
    expect(calculateIntentExtensionCost(1n, 1n, 1n)).toBe(1n);
    expect(calculateIntentExtensionCost(1_000_000n, HOUR, 0n)).toBe(0n);
  });

  it("prices extensions on the full locked intent amount", () => {
    expect(calculateIntentExtensionCost(500_000_000n, HOUR, 10n)).toBe(500_000n);
  });

  it("requires full-gross chargeback coverage", () => {
    expect(calculateRequiredCoverage(1_000_000_001n, true)).toBe(1_000_000_001n);
    expect(calculateRequiredCoverage(1_000_000_001n, false)).toBe(0n);
    expect(calculateStakeBackedCapacity(1_000_000n)).toBe(1_000_000n);
  });

  it("selects the same admission mode as RiskManager", () => {
    expect(selectRiskMode(1_000_000n, 0n, false, false)).toBe("UNBONDED");
    expect(selectRiskMode(1_000_000n, 1_000_000n, true, true)).toBe("STAKE_BACKED");
    expect(selectRiskMode(1_000_000n, 999_999n, true, true)).toBe("DEFERRED_PAYOUT");
    expect(() => selectRiskMode(1_000_000n, 999_999n, true, false)).toThrow(RangeError);
  });

  it("rejects unsafe numbers", () => {
    expect(() => calculateIntentExtensionCost(Number.MAX_SAFE_INTEGER + 1, HOUR, 1)).toThrow(RangeError);
    expect(() => calculateRequiredCoverage(-1, true)).toThrow(RangeError);
  });
});
