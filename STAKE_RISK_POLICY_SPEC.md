# Stake Risk Curves and Reusable Base-Unbonded Capacity

## Status

Hard-cut contract specification. The contract implementation follows this model; deployment and downstream consumers must migrate to the new ABI without compatibility aliases.

## Summary

The protocol uses stake for two independent risks:

1. A griefing bond compensates an LP when a taker locks liquidity and later cancels or lets the intent expire.
2. Chargeback coverage protects an LP for a configured period after a chargebackable payment settles.

For non-chargebackable payment methods, every intent receives a reusable base-unbonded tranche. Only the amount above that base enters the griefing curve. The base is stateless: there is no lifetime count, usage mapping, or consumed allowance.

For chargebackable payment methods, the base must be zero and the full intent amount remains subject to the existing chargeback policy.

## Security Boundary

The reusable base is economic policy, not identity or Sybil protection. The contract intentionally does not approximate account identity with wallet-local counters.

If admission must be limited to one stable platform account, that constraint belongs in the platform-account gating or proof layer. Once an intent reaches `RiskManager`, the contract applies the configured base to every eligible intent, including concurrent intents.

The model therefore accepts that base-only capacity can be reused without contract state. LPs and admission systems must price or gate that exposure explicitly.

## Terminology

- `A`: complete intent amount.
- `U`: reusable base-unbonded amount configured for the payment method.
- `B`: bonded amount, `max(A - U, 0)`.
- `S`: currently free stake for the selected stake owner.
- `T`: snapshotted maximum intent period.
- `C`: snapshotted griefing cliff.
- `s`: griefing penalty slope in basis points per hour.
- `r`: chargeback reserve ratio in basis points.

## Platform Configuration

```solidity
struct ChargebackConfig {
    bool chargebackable;
    bool deferredPayoutEnabled;
    uint16 reserveBps;
    uint64 riskWindow;
}

struct GriefingConfig {
    uint64 griefingCliff;
    uint32 griefingPenaltyBpsPerHour;
    uint256 baseUnbondedAmount;
}

struct PlatformRiskConfig {
    bool enabled;
    ChargebackConfig chargeback;
    GriefingConfig griefing;
}
```

Configuration rules:

- `chargeback.reserveBps` is between `0` and `10_000`.
- A chargebackable method requires full coverage, a nonzero bounded risk window, and `griefing.baseUnbondedAmount == 0`.
- A non-chargebackable method requires `reserveBps == 0` and disables deferred payout.
- The griefing cliff must be shorter than the Escrow intent period.
- The maximum griefing rate cannot exceed 100% of the bonded amount.
- A zero griefing slope disables the griefing curve.

## Bonded Amount

For every admission:

```text
B = max(A - U, 0)
```

Because chargebackable methods require `U = 0`, their bonded amount is the full intent amount.

The position snapshots both `intentAmount` and `bondedAmount`. Later policy changes cannot alter the amount used for cancellation accounting.

## Griefing Curve

The maximum griefing bond is:

```text
chargeableMaximum = max(T - C, 0)

Gmax = ceil(
    B * s * chargeableMaximum
    / (10_000 * 1 hour)
)
```

At cancellation:

```text
effectiveElapsed = min(cancelledAt - createdAt, T)
chargeableElapsed = max(effectiveElapsed - C, 0)

Gcancel = ceil(
    B * s * chargeableElapsed
    / (10_000 * 1 hour)
)
```

Rounding is upward. If `B == 0`, both values are zero at every timestamp.

## Chargeback Curve

For a chargebackable method:

```text
Q = ceil(A * r / 10_000)
```

Chargeback coverage is calculated from the complete intent amount. The base-unbonded policy never reduces post-settlement chargeback coverage.

## Admission Reservation

For an ordinary position:

```text
requiredReservation = max(Gmax, Q)
```

Cancellation and settlement are mutually exclusive outcomes, so the liabilities are not added.

For deferred payout, the pending stake reservation continues to cover the greater of griefing exposure and the maximum settlement fee gap:

```text
Fmax = floor(A * aggregateFeeRate / 1e18)
deferredRequiredReservation = max(Gmax, Fmax)
```

The exact net deferred proceeds and retained stake must compose to the required gross chargeback coverage at settlement.

## Modes

- `UNBONDED`: `B == 0`; reserves and slashes no stake.
- `STAKE_BACKED`: `B > 0` and ordinary stake backs the position.
- `DEFERRED_PAYOUT`: the configured deferred hook backs settlement while pending stake covers `max(Gmax, Fmax)`.

There is no count-based or lifetime-subsidy mode.

## Capacity Math

For a non-chargebackable method with a nonzero griefing rate:

```text
griefingRateNumerator = s * (T - C)

bondedTakingCapacity(S) = floor(
    S * 10_000 * 1 hour
    / griefingRateNumerator
)

maximumIntentAmount(S) = U + bondedTakingCapacity(S)
```

For a chargebackable method, `U = 0` and the existing chargeback capacity also constrains admission:

```text
chargebackCapacity(S) = floor(S * 10_000 / r)

maximumIntentAmount(S) = min(
    griefingCapacity(S),
    chargebackCapacity(S)
)
```

A disabled curve does not constrain capacity. If every applicable curve is disabled, capacity is unbounded by `RiskManager`; other protocol and LP limits still apply.

Across multiple active positions, admission remains subject to the shared portfolio invariant:

```text
sum(active stake reservations) <= eligible stake
```

The reusable base itself is not reserved and does not create a portfolio counter. Multiple base-only intents can be open concurrently.

## Lifecycle

### Base-only non-chargebackable intent

- Snapshots `bondedAmount = 0` and mode `UNBONDED`.
- Reserves no stake.
- Cancellation or expiry charges zero.
- Settlement creates no chargeback position.
- A later intent receives the same configured base.

### Partially bonded non-chargebackable intent

- Snapshots `bondedAmount = A - U`.
- Reserves `Gmax` calculated only from that excess.
- Cancellation slashes the accrued excess-only penalty and releases the remainder.
- Settlement releases the complete pending reservation.

### Chargebackable intent

- Requires `U = 0`, so `B = A`.
- Uses the existing stake-backed or deferred-payout lifecycle.
- Cancellation charges only accrued griefing exposure.
- Settlement transitions to complete configured chargeback coverage.

## Position and Event Surface

The hard-cut ABI:

- replaces risk mode `FREE` with `UNBONDED`;
- replaces `freeTakeCount` and `freeTakeAmount` with `baseUnbondedAmount`;
- removes `freeTakesUsed` and the consumption event;
- removes the consumed-allowance flag from positions;
- adds snapshotted `bondedAmount` to positions and `RiskPositionCreated`;
- emits `baseUnbondedAmount` in platform configuration updates.

Indexers must derive unbonded versus bonded exposure from the position mode and `bondedAmount`. They must not reconstruct removed usage counters.

## Core Invariants

1. Chargebackable methods configure a zero base-unbonded amount.
2. `bondedAmount == max(intentAmount - baseUnbondedAmount, 0)` at admission.
3. An unbonded position reserves and slashes zero stake.
4. A pending ordinary position reserves exactly `max(Gmax, Q)`.
5. Cancellation penalty never exceeds the snapshotted maximum griefing bond.
6. Cancellation uses the snapshotted bonded amount and maximum intent period.
7. Fulfillment never charges a griefing penalty.
8. A chargeback never consumes more than the remaining position coverage.
9. Governance changes affect only future positions.
10. All stake-backed positions share the same stake-owner portfolio balance.

## Illustrative Non-Chargebackable Policy

```text
chargeback:
  chargebackable:                false
  deferredPayoutEnabled:         false
  reserveBps:                    0
  riskWindow:                    0
griefing:
  griefingCliff:                 15 minutes
  griefingPenaltyBpsPerHour:     10
  baseUnbondedAmount:            500 USDC
Escrow maximum intent period:    6 hours
```

Examples:

```text
A = 500 USDC  => B =   0 USDC => Gmax = 0
A = 700 USDC  => B = 200 USDC => Gmax = 1.15 USDC
A = 1,000 USDC => B = 500 USDC => Gmax = 2.875 USDC
```

The 500 USDC base is reusable for every admitted intent. It is not a one-time allowance and is not Sybil resistance.

## Illustrative Chargebackable Policy

```text
chargeback:
  chargebackable:                true
  deferredPayoutEnabled:         true
  reserveBps:                    10,000
  riskWindow:                    30 days
griefing:
  griefingCliff:                 15 minutes
  griefingPenaltyBpsPerHour:     10
  baseUnbondedAmount:            0
Escrow maximum intent period:    6 hours
```

For a 1,000 USDC intent, the maximum griefing bond is 5.75 USDC and ordinary chargeback coverage is 1,000 USDC, so ordinary admission reserves 1,000 USDC.

## Rollout

This ABI is a hard cut. A release requires:

1. A fresh `RiskManager` deployment and explicit platform configuration.
2. A contracts package release containing the new ABI and risk math.
3. Indexer migration to the new config and position event shapes.
4. Curator and client migration from usage-based capacity to `base + bonded capacity`.

Historical deployment artifacts remain immutable. No legacy fields, aliases, or dual event decoding are added to the active contract.
