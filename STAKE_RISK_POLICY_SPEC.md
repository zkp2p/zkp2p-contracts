# Stake-Based Risk Curves and Configurable Free Takes

## Status

Draft for final product and protocol review. This document defines the intended behavior before implementation.

## Summary

The protocol uses stake for two distinct purposes:

1. A **griefing bond** compensates an LP when a taker locks liquidity and later cancels or lets the intent expire. The penalty increases linearly with the time the liquidity was locked after a configured cliff.
2. **Chargeback coverage** reserves stake for a configured period after a chargebackable payment settles. A valid chargeback can slash that reservation to compensate the LP.

For a pending bonded intent, the protocol reserves the larger of these two requirements, not their sum. Only one risk can materialize:

- A cancelled intent can incur a griefing penalty but never creates chargeback exposure.
- A fulfilled intent incurs no griefing penalty and transitions into chargeback coverage when the platform is chargebackable.

Each stake owner also receives a configurable number of lifetime free intents on each configured non-chargebackable platform. A free intent is an onboarding subsidy and reserves no stake.

The protocol does not impose tiers, cooldowns, stake-derived intent-count limits, maximum individual intent amounts, or protocol-wide exposure limits.

## Goals

- Express risk policy using simple formulas instead of hardcoded tiers.
- Make reservation and slashing behavior easy to read and audit.
- Make stake the shared resource backing all of a stake owner's active risk positions.
- Compensate LPs for long-lived cancelled intents.
- Cover chargebacks for a clear, snapshotted period.
- Let new onrampers try small non-chargebackable transactions once without staking.
- Keep LPs responsible for selecting and pricing the risk they accept.

## Non-goals

- Establishing an on-chain reputation or identity system.
- Preventing wallets from sybilling the configured free intents.
- Underwriting aggregate platform losses with protocol funds.
- Protecting LPs from chargebacks after the configured coverage window.
- Limiting how an LP prices, advertises, or allocates its liquidity.
- Replacing Escrow's operational bounds used to protect loops and gas usage.

## Terminology

- **Taker**: The address that signals an intent.
- **Stake owner**: The address whose stake backs the taker. This may be a Safe or another owner that authorized a relayer to use its stake.
- **LP**: The depositor whose escrow liquidity is locked by an intent.
- **Pending intent**: An intent that has been signaled but has not been fulfilled, released, cancelled, or pruned.
- **Bonded amount**: The intent amount to which stake-based policy applies.
- **Free intent**: One of a stake owner's configured lifetime non-chargebackable allowances that reserves no stake.
- **Griefing bond**: The maximum cancellation penalty reserved while an intent is pending.
- **Chargeback coverage**: Stake reserved after settlement and slashable during the chargeback coverage window.

## Platform Configuration

Each payment platform has a risk configuration containing at least:

```solidity
/// @notice Controls post-settlement chargeback protection for a payment platform.
struct ChargebackConfig {
    bool chargebackable;           // Whether fulfilled payments can be charged back.
    bool deferredPayoutEnabled;    // Whether proceeds can replace stake as chargeback protection.
    uint16 reserveBps;             // Portion of the fulfilled amount reserved from stake, in basis points.
    uint64 riskWindow;             // Time after settlement during which a valid chargeback can slash coverage.
}

/// @notice Controls pending-intent liquidity-lock penalties and onboarding free intents.
struct GriefingConfig {
    uint64 griefingCliff;                 // Cancellation grace period after signaling, in seconds.
    uint32 griefingPenaltyBpsPerHour;     // Linear penalty slope applied after the cliff.
    uint32 freeTakeCount;                 // Number of lifetime unbonded intents available to each stake owner.
    uint256 freeTakeAmount;               // Maximum amount of each unbonded intent.
}

/// @notice Combines admission status with the independent chargeback and griefing policies for a platform.
struct PlatformRiskConfig {
    bool enabled;                         // Whether the risk manager admits new intents for the platform.
    ChargebackConfig chargeback;          // Post-settlement chargeback policy.
    GriefingConfig griefing;              // Pre-settlement cancellation and onboarding policy.
}
```

The exact Solidity types may change during implementation if narrower types improve packing without reducing clarity or safe configuration ranges.

### Configuration rules

- `chargeback.reserveBps` is between `0` and `10_000`.
- A platform with `chargeback.chargebackable == true` has a nonzero `chargeback.reserveBps` and a nonzero `chargeback.riskWindow`.
- A platform with `chargeback.chargebackable == false` has `chargeback.reserveBps == 0` and `chargeback.deferredPayoutEnabled == false`.
- `griefing.griefingCliff` must be shorter than the Escrow intent period used by the position.
- The griefing penalty derived at the maximum intent period cannot exceed 100% of the intent amount.
- `griefing.freeTakeCount` and `griefing.freeTakeAmount` must both be zero when `chargeback.chargebackable == true`.
- A platform must configure both `griefing.freeTakeCount` and `griefing.freeTakeAmount`, or set both to zero.
- Zero free-take values disable free intents for that platform.
- A zero `griefing.griefingPenaltyBpsPerHour` disables the griefing bond for that platform.

## Snapshotted Position Terms

The following values are snapshotted when an intent is admitted:

- Stake owner.
- LP.
- Payment platform.
- Intent amount.
- Creation timestamp.
- Escrow maximum intent period.
- Griefing cliff.
- Griefing penalty slope.
- Chargeback reserve ratio.
- Chargeback coverage window.
- Whether the position consumed a free intent.
- Maximum griefing bond.
- Initial reservation.

Governance changes affect only subsequently created positions.

The risk manager currently reads the maximum intent period from the intent's Escrow:

```solidity
IEscrowV2(intent.escrow).intentExpirationPeriod()
```

The getter must be declared on the interface. Escrow already exposes it through its public state variable.

The risk manager snapshots the value because Escrow governance can change it. A future protocol version may move the maximum intent period into the risk manager without changing the formulas or position lifecycle defined here.

## Curve One: Time-Based Griefing Bond

### Inputs

For a platform and intent:

```text
A = bonded intent amount
t = elapsed time since intent creation
T = snapshotted maximum intent period
C = griefing.griefingCliff
s = griefing.griefingPenaltyBpsPerHour
```

### Chargeable time

Elapsed time is capped at the snapshotted maximum intent period. Intent guardian extensions do not increase the taker's maximum liability.

```text
effectiveElapsed = min(t, T)

chargeableTime =
    0                              when effectiveElapsed <= C
    effectiveElapsed - C           when effectiveElapsed > C
```

### Accrued cancellation penalty

```text
griefingPenalty(A, t) =
    ceil(
        A
        * s
        * chargeableTime
        / (10_000 * 1 hour)
    )
```

The penalty is zero at or before the cliff. Upward rounding makes every cancellation after the cliff liable for at least one smallest token unit.

### Maximum griefing bond

The maximum possible penalty is reserved when the intent is admitted:

```text
maxChargeableTime = T - C

maxGriefingBond(A) =
    ceil(
        A
        * s
        * maxChargeableTime
        / (10_000 * 1 hour)
    )
```

The reservation is based on the predefined intent period, not on a separately configured maximum penalty. If an intent guardian extends an intent beyond `T`, the penalty stops accruing at `T`.

For a fixed intent amount, the penalty is linear in time after the cliff. For a fixed elapsed time, it is linear in the intent amount.

## Curve Two: Chargeback Coverage

For a chargebackable platform:

```text
r = chargeback.reserveBps

chargebackReserve(A) =
    ceil(A * r / 10_000)
```

At `chargeback.reserveBps == 10_000`, one unit of stake covers one unit of taking. At a lower reserve ratio, the LP accepts partial coverage:

```text
reserveBps = 10_000   =>   100% covered
reserveBps = 5_000    =>    50% covered
reserveBps = 2_000    =>    20% covered
```

Chargeback coverage is not a penalty. The stake is returned if no valid chargeback is submitted during the coverage window.

## Capacity Form of the Two Curves

The formulas above calculate required stake from an intent amount. The same curves can be inverted to calculate maximum bonded taking from currently free stake.

For one platform:

```text
S = free stake

maximumGriefingBondRate =
    s * (T - C) / (10_000 * 1 hour)

chargebackReserveRate =
    chargeback.reserveBps / 10_000

griefingCapacity(S) =
    S / maximumGriefingBondRate

chargebackCapacity(S) =
    S / chargebackReserveRate

bondedTakingCapacity(S) =
    min(griefingCapacity(S), chargebackCapacity(S))
```

A disabled curve does not constrain capacity. Chargeback coverage is disabled on a non-chargebackable platform, and a zero griefing slope disables the griefing curve.

At 100% chargeback coverage, `chargebackCapacity(S) == S`. When that curve dominates, a stake owner with 1,000 USDC of free stake can have at most 1,000 USDC of additional stake-backed taking admitted.

If the stake owner has unused free intents, its total immediate capacity on an eligible non-chargebackable platform is:

```text
remainingFreeTakes = griefing.freeTakeCount - freeTakesUsed
freeTakingCapacity = remainingFreeTakes * griefing.freeTakeAmount

up to remainingFreeTakes separate intents,
each no larger than griefing.freeTakeAmount
+ bonded intents up to bondedTakingCapacity(S)
```

Each free allowance is a separate intent rather than a partial tranche, so free amounts cannot be combined with each other or with bonded capacity inside one intent. All remaining free intents may be used concurrently. Across multiple platforms, capacity must be evaluated using the shared portfolio reservation constraint rather than adding each platform's standalone capacity.

## Admission Reservation

For a normal stake-backed intent:

```text
requiredReservation(A) =
    max(
        maxGriefingBond(A),
        chargebackReserve(A)
    )
```

For a non-chargebackable platform, `chargebackReserve(A) == 0`, so the griefing bond controls admission.

For a chargebackable platform with 100% coverage, chargeback coverage normally dominates the smaller griefing bond.

The manager admits the intent only when:

```text
requiredReservation(A) <= freeStake(stakeOwner)
```

The manager reserves the maximum rather than adding both amounts because cancellation and fulfillment are mutually exclusive outcomes.

## Portfolio Constraint

Stake is shared across all platforms and all intents belonging to the same stake owner.

At all times:

```text
sum(pending intent reservations)
+ sum(settled chargeback reservations)
<= eligible stake
```

The taker can use available capacity in one intent or split it across multiple intents. The economic policy does not care about the number of intents.

Escrow may retain structural intent-count bounds to protect iteration and gas usage. Those bounds are operational safeguards, not stake tiers or taker risk policy.

## Configurable Free Intents

### Purpose

Free intents let a new onramper try a configured number of small transactions without first acquiring or depositing stake.

### Eligibility

A free intent is available only when all of the following are true:

- The platform is enabled.
- The platform is non-chargebackable.
- `griefing.freeTakeCount` and `griefing.freeTakeAmount` are nonzero.
- The stake owner has consumed fewer than `griefing.freeTakeCount` free intents for that platform.
- The entire intent amount is less than or equal to `griefing.freeTakeAmount`.

Eligibility is keyed by stake owner and payment platform:

```solidity
mapping(address stakeOwner => mapping(bytes32 paymentMethod => uint32)) freeTakesUsed;
```

Using the stake owner prevents multiple authorized relayers for one Safe from receiving separate allowances.

### Consumption

One allowance is consumed when a free intent is successfully signaled:

```text
freeTakesUsed[stakeOwner][paymentMethod] += 1
```

The consumed allowance is not restored when the intent is cancelled, expires, or fails to fulfill. This prevents repeated cost-free liquidity locking beyond the configured count.

If signaling reverts, all state changes revert and the allowance remains available.

### No partial free tranche

The protocol does not apply the free amount as an unbonded tranche inside a larger intent.

```text
intent amount <= griefing.freeTakeAmount
and freeTakesUsed < griefing.freeTakeCount
    => entire intent is free

otherwise
    => entire intent follows the bonded policy
```

A staked taker may use any remaining free intents alongside separate bonded intents, subject to the shared stake constraint.

### Sybil behavior

Free intents are intentionally wallet-sybilable. They are a small onboarding subsidy, not a security boundary. Both the count and amount should remain small, and indexer and client surfaces should identify each intent as unbonded.

## Lifecycle

### Free, non-chargebackable intent

- Reserves no stake.
- Consumes one lifetime free allowance at successful signaling.
- Fulfillment, cancellation, or expiry makes the position terminal.
- No allowance is restored.

### Bonded, non-chargebackable intent

At admission:

```text
reservation = maxGriefingBond(intentAmount)
```

On fulfillment:

- Release the entire griefing reservation.
- Charge no griefing penalty.
- Make the position terminal.

On cancellation or expiry:

- Calculate the penalty using the snapshotted creation and cancellation timestamps.
- Slash the accrued penalty to the LP.
- Release the unused remainder of the reservation.
- Make the position terminal.

### Stake-backed, chargebackable intent

At admission:

```text
reservation = max(maxGriefingBond(intentAmount), chargebackReserve(intentAmount))
```

On cancellation or expiry:

- Calculate and slash the accrued griefing penalty to the LP.
- Release the remainder of the reservation.
- Make the position terminal.

On fulfillment or manual release:

- Charge no griefing penalty.
- Resize the reservation to the chargeback reserve calculated from the exact released amount.
- Start the chargeback coverage window at settlement.
- Retain the reservation until a valid chargeback consumes it or the coverage window matures.

On a valid chargeback:

- Slash up to the remaining covered amount to the LP.
- Preserve any remaining coverage if the chargeback uses only part of the reservation.

On maturity:

- Release the remaining chargeback reservation.
- Make the position terminal.

The LP bears chargeback losses above the covered amount and all chargebacks submitted after the coverage deadline.

### Deferred-payout chargebackable intent

Deferred payout remains an alternative when stake can cover the griefing bond but cannot cover the chargeback reservation.

At admission:

```text
freeStake >= maxGriefingBond(intentAmount)
freeStake < max(maxGriefingBond(intentAmount), chargebackReserve(intentAmount))
deferred payout is enabled and the required post-intent hook is selected
```

The manager reserves only the maximum griefing bond while the intent is pending.

On cancellation or expiry:

- Slash the accrued griefing penalty to the LP.
- Release the unused griefing reservation.

On fulfillment:

- Release the griefing reservation without penalty.
- Hold the payout through the deferred-payout mechanism for the chargeback coverage window.

Free intents do not apply to chargebackable deferred-payout intents.

## Cancellation Semantics and Callback Failure

Every cancellation after the cliff is liable, including taker cancellation and expiry cleanup. A cancellation reason is therefore unnecessary for determining liability.

The penalty must use the time when liquidity stopped being locked, not the time of a later reconciliation transaction.

Orchestrator V3 currently treats terminal risk callbacks as best-effort so a broken hook cannot block cancellation or escrow cleanup. Financial enforcement must preserve that liveness while preventing callback failure from avoiding a penalty:

1. Record the cancellation timestamp when the terminal callback fails.
2. Keep the maximum griefing bond reserved.
3. Allow anyone to reconcile the failed cancellation.
4. Calculate the penalty using the recorded cancellation timestamp.
5. Slash the penalty and release the unused reservation.

The implementation must not calculate a larger penalty from the later reconciliation timestamp.

## LP Risk Model

The LP opts into the risk hook for its deposit. The protocol provides enforcement and accounting but does not underwrite the LP's aggregate risk.

The protocol helps the LP by:

- Reserving taker stake.
- Penalizing long-lived cancelled intents.
- Compensating valid chargebacks during the coverage window.
- Supporting deferred payout when configured.
- Emitting the data required to measure current and historical exposure.

The LP remains responsible for:

- Deciding whether to use the risk hook.
- Accepting the configured reserve ratio and coverage window.
- Measuring its own outstanding exposure.
- Pricing partial coverage and post-coverage chargeback tail risk.
- Managing its deposit liquidity.

There is no protocol-wide maximum exposure. One LP's activity must not prevent another LP from accepting otherwise valid intents.

## Events and Indexer Requirements

Events should remain simple and describe economic state changes. The final event shapes should allow the indexer to derive at least:

- The snapshotted platform policy for each position.
- Maximum griefing bond reserved.
- Accrued griefing penalty charged.
- Reservation released after cancellation or fulfillment.
- Chargeback coverage amount and expiry.
- Chargeback amount requested, amount compensated, and remaining coverage.
- Whether an intent consumed a free allowance.
- Free allowances used and remaining for each stake owner and platform.
- LP exposure grouped by platform and coverage-expiry bucket.
- Protected, uncovered, matured, and deferred-payout exposure.

Suggested semantic events include:

```solidity
event FreeTakeConsumed(
    bytes32 indexed intentHash,
    address indexed stakeOwner,
    bytes32 indexed paymentMethod,
    uint256 amount,
    uint32 freeTakesUsed,
    uint32 freeTakeCount
);

event GriefingPenaltyCharged(
    bytes32 indexed intentHash,
    address indexed stakeOwner,
    address indexed lp,
    uint256 penalty,
    uint256 elapsedTime
);
```

Existing reservation, settlement, chargeback, and maturity events should be reused or adjusted rather than duplicated where they already convey the required transition clearly.

## Core Invariants

1. Free intents are available only on a non-chargebackable platform.
2. A stake owner cannot consume more than the platform's configured free-take count.
3. A free intent reserves and slashes no stake.
4. A bonded pending intent reserves exactly the larger of its maximum griefing bond and chargeback reserve.
5. A cancellation can slash no more than the maximum griefing bond reserved for that intent.
6. A guardian extension cannot increase the griefing penalty beyond the snapshotted maximum intent period.
7. Fulfillment never charges a griefing penalty.
8. A chargeback can slash no more than the remaining position coverage.
9. Position policy changes cannot apply retroactively.
10. All reservations across all platforms share the same stake owner's free-stake balance.
11. Failed terminal callbacks cannot create an unreserved liability or allow a reserved liability to be silently released.
12. The LP, not the protocol, bears uncovered and post-coverage chargeback risk.

## Illustrative Configurations

These values demonstrate the formulas and are not final launch recommendations.

### Non-chargebackable platform

```text
chargeback:
  chargebackable:                false
  deferredPayoutEnabled:         false
  reserveBps:                    0
  riskWindow:                    0
griefing:
  griefingCliff:                 15 minutes
  griefingPenaltyBpsPerHour:     10
  freeTakeCount:                 3
  freeTakeAmount:                20 USDC
Escrow maximum intent period:    6 hours
```

For a bonded 1,000 USDC intent:

```text
maximum chargeable time = 5.75 hours
maximum griefing rate   = 57.5 bps
maximum griefing bond   = 5.75 USDC
```

A stake owner with no stake can signal up to three lifetime free intents of no more than 20 USDC each. The allowances may be used concurrently. All subsequent intents require a griefing bond.

### Chargebackable platform

```text
chargeback:
  chargebackable:                true
  deferredPayoutEnabled:         true
  reserveBps:                    10,000
  riskWindow:                    30 days
griefing:
  griefingCliff:                 15 minutes
  griefingPenaltyBpsPerHour:     10
  freeTakeCount:                 0
  freeTakeAmount:                0
Escrow maximum intent period:    6 hours
```

For a 1,000 USDC intent:

```text
maximum griefing bond = 5.75 USDC
chargeback reserve    = 1,000 USDC
admission reservation = max(5.75, 1,000) = 1,000 USDC
```

If the taker cancels two hours after creation, the chargeable time is 1.75 hours and the griefing penalty is 1.75 USDC. The LP receives 1.75 USDC and the remaining 998.25 USDC is released.

If the intent fulfills, no griefing penalty is charged. The exact released amount remains reserved for the 30-day chargeback window.

## Explicitly Removed Tier Behavior

The implementation should remove contract-level dependencies on:

- Named taker tiers.
- Tier stake thresholds.
- Tier-specific amount caps.
- Tier-specific concurrency limits.
- Tier-derived fee discounts.
- Tier-derived cooldowns.

Clients may derive product labels from continuous stake or capacity values, but those labels have no protocol authority.

## Review Decisions Required Before Implementation

The following values must be selected for each launch platform before deployment, but do not change the model:

- `griefing.freeTakeCount` and `griefing.freeTakeAmount` for each eligible non-chargebackable platform.
- `griefing.griefingCliff`.
- `griefing.griefingPenaltyBpsPerHour`.
- `chargeback.reserveBps` for each chargebackable platform.
- `chargeback.riskWindow` for each chargebackable platform.
