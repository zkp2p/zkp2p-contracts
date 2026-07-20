# Stake Risk Curves and Reusable Base-Unbonded Capacity

## Status

Hard-cut contract specification. The contract implementation follows this model; deployment and downstream consumers must migrate to the new ABI without compatibility aliases.

## Summary

The protocol uses stake for two independent risks:

1. A griefing bond compensates an LP when a taker locks liquidity and later cancels or lets the intent expire.
2. Chargeback coverage protects an LP for a configured period after a chargebackable payment settles.

For non-chargebackable payment methods, every intent receives a reusable base-unbonded tranche. Only the amount above that base enters the griefing curve. The base is stateless: there is no lifetime count, usage mapping, or consumed allowance.

For chargebackable payment methods, the base must be zero and the full intent amount remains subject to the existing chargeback policy.

Settlement ownership is a hard cut. The depositor selects a risk hook for future intents; Orchestrator snapshots that hook at admission and calls it only after Escrow funds arrive and protocol, referral, and manager fees are paid. The risk hook receives an exact temporary allowance for the post-fee executable amount. It may consume zero or all of that amount—never a partial amount. Ordinary post-intent hooks remain selected by the onramper and are independent of risk policy.

## Security Boundary

The reusable base is economic policy, not identity or Sybil protection. The contract intentionally does not approximate account identity with wallet-local counters.

If admission must be limited to one stable platform account, that constraint belongs in the platform-account gating or proof layer. Once an intent reaches `RiskManager`, the contract applies the configured base to every eligible intent, including concurrent intents.

The model therefore accepts that base-only capacity can be reused without contract state. LPs and admission systems must price or gate that exposure explicitly.

## Terminology

- `A`: complete intent amount.
- `R`: gross amount actually released by Escrow for fulfillment or manual release.
- `E`: executable settlement amount after protocol, referral, and manager fees.
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
- A chargebackable method requires a nonzero reserve ratio, a nonzero bounded risk window, and `griefing.baseUnbondedAmount == 0`.
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

For stake-backed coverage on a chargebackable method:

```text
Qstake = ceil(R * r / 10_000)
```

For deferred coverage:

```text
Qdeferred = ceil(E * r / 10_000)
```

V1 policy requires `r = 10_000`, so stake-backed coverage equals the gross Escrow release and deferred coverage equals the complete post-fee amount placed in custody. The base-unbonded policy never reduces post-settlement chargeback coverage.

## Admission Reservation

For an ordinary position:

```text
requiredReservation = max(Gmax, ceil(A * r / 10_000))
```

Cancellation and settlement are mutually exclusive outcomes, so the liabilities are not added.

This admission value determines whether membership stake can fully back the intent. If it cannot, deferred mode may be selected when enabled and the stake owner can still cover `Gmax`. Deferred proceeds do not exist at admission and are not counted as membership stake.

## Modes

- `UNBONDED`: `B == 0`; reserves and slashes no stake.
- `STAKE_BACKED`: `B > 0` and ordinary stake backs the position.
- `DEFERRED_PAYOUT`: RiskManager pulls the complete executable amount from Orchestrator into segregated StakeVault custody at settlement; pending membership stake covers only griefing exposure.

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
- Uses the stake-backed or risk-manager-funded deferred-payout lifecycle selected at admission.
- Cancellation charges only accrued griefing exposure.
- Stake-backed settlement consumes zero payout funds and covers `R`.
- Deferred settlement consumes exactly `E`, records exactly `E` in StakeVault, and skips normal payout execution.
- Manual release uses the same settlement callback and custody invariant as verified fulfillment.

## Settlement Flow and Fee Invariant

For both fulfillment and manual release:

```text
Escrow -> Orchestrator: R
Orchestrator -> protocol/referral/manager recipients: fees(R)
E = R - fees(R)
Orchestrator -> snapshotted risk hook: temporary allowance(E), settleIntent(context)
```

The hook may consume either zero or exactly `E`. Orchestrator clears the allowance after a successful callback and checks its token balance delta:

- zero consumption continues ordinary payout handling;
- exact consumption marks risk settlement complete and skips the ordinary post-intent hook/direct payout;
- partial consumption, over-pull, balance increase, missing hook code, callback failure, or allowance failure reverts the complete release transaction.

RiskManager consumes zero for unbonded and stake-backed positions. In deferred mode it transfers exactly `E` directly from Orchestrator to StakeVault and records the same `E` as both deferred custody and, under the required 100% reserve policy, chargeback coverage. Protocol, referral, and manager fees are paid exactly as in the ordinary flow and are never clawed into deferred custody. This is the chosen invariant: the beneficiary's entire executable payout—not the gross release—is held, covered, matured, and eventually claimed or used for LP compensation.

Deferred balances are segregated from `stakeBalance` and cannot authorize new intent admission, satisfy stake reservations, or be withdrawn through the membership-stake path.

## Position and Event Surface

The hard-cut ABI:

- replaces risk mode `FREE` with `UNBONDED`;
- replaces `freeTakeCount` and `freeTakeAmount` with `baseUnbondedAmount`;
- removes `freeTakesUsed` and the consumption event;
- removes the consumed-allowance flag from positions;
- adds snapshotted `bondedAmount` to positions and `RiskPositionCreated`;
- emits `baseUnbondedAmount` in platform configuration updates.
- removes risk-admission return values and every `requiresPostIntentHook` / deferred-hook coupling;
- snapshots only the depositor-selected risk hook for each intent;
- adds `settleIntent(RiskSettlementContext)` and `IntentRiskSettlementExecuted`;
- replaces deferred-hook registration events with `DeferredPayoutFunded` emitted by RiskManager;
- records and emits both gross and executable settlement amounts plus the selected covered amount.

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
11. Risk settlement consumes either zero or exactly the executable amount, and its allowance is zero afterward.
12. Deferred custody, deferred accounting, and deferred chargeback coverage are all exactly the post-fee executable amount.
13. Deferred proceeds never increase reusable membership stake or taking capacity.
14. Token-bearing settlement failures revert fulfillment or manual release; cancellation reconciliation remains independently fail-open and timestamp-safe.

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

For a 1,000 USDC intent, the maximum griefing bond is 5.75 USDC and ordinary chargeback coverage is 1,000 USDC, so ordinary admission reserves 1,000 USDC. If deferred mode is selected and settlement fees total 1.5 USDC, StakeVault instead receives, covers, and records exactly 998.5 USDC.

## Rollout

This ABI is a hard cut. A release requires:

1. A fresh `NullifierRegistryV2`, `UnifiedPaymentVerifierV3`, OrchestratorV3, StakeVault, and RiskManager deployment, plus a governance-ratified chargeback witness set that is disjoint from payment-attestation witnesses.
2. A one-way governance batch that removes every legacy-registry writer and routes the shared payment registry to UPV3; rollback to a legacy writer/verifier is forbidden.
3. Depositors explicitly select RiskManager as their risk hook for deposits that require this policy. They continue selecting ordinary post-intent hooks independently.
4. A contracts package release containing the hard-cut ABIs and risk math.
5. Indexer migration to the new intent-risk snapshot, settlement, and position event shapes.
6. Curator and client migration from usage-based capacity to `base + bonded capacity`, with no DeferredPayoutHook selection.

Historical deployment artifacts remain immutable. No legacy fields, aliases, or dual event decoding are added to the active contract.
