# Paid Intent Expiry Extensions

## Status

Hard-cut contract specification. Cancellation penalties and griefing bonds are removed from the active ABI. Historical deployment scripts and artifacts remain immutable.

## Policy

- The initial intent period is free. The proposed deployment value is one hour.
- An active intent's owner may buy more time through `OrchestratorV3`.
- Total intent lifetime is capped at five days by the orchestrator and may be capped lower by the payment method's risk configuration.
- The proposed extension price is 20% APR on the complete locked intent amount.
- Extension fees come from the stake owner's free stake and compensate the affected liquidity provider.
- Cancellation and expiry cleanup do not slash stake.
- Paid extension fees are final even if the intent is later cancelled, expired, or fulfilled.
- Chargeback coverage remains a separate post-settlement risk policy.

## Architecture

```text
intent owner
    |
    | extendIntentExpiry(intentHash, extensionSeconds)
    v
OrchestratorV3
    |
    | bounded, fail-closed extension callback
    v
deposit-selected risk hook (RiskManager)
    |
    | spend free stake; credit LP compensation
    v
StakeVault
    |
    | fee charged successfully
    v
EscrowV2 extends the intent expiry
```

The orchestrator owns the generic extension flow. `RiskManager` is only one implementation of the optional extension hook, so a depositor can select a different risk mechanism through the existing deposit risk-hook setting.

The fee is charged before Escrow mutates the expiry. Any hook or Escrow failure reverts the entire transaction.

## Configuration

```solidity
struct IntentExtensionConfig {
    uint16 feeBps;
    uint64 maxIntentLifetime;
}

struct PlatformRiskConfig {
    bool enabled;
    ChargebackConfig chargeback;
    IntentExtensionConfig extension;
}
```

Configuration rules:

- `feeBps` is an annual rate from zero to 10,000 basis points.
- A nonzero rate requires a maximum lifetime longer than Escrow's initial intent period.
- A zero rate requires a zero maximum lifetime and disables paid extensions for the payment method.
- The effective lifetime cap is the lower of the orchestrator's five-day cap and the risk hook's snapshotted cap.
- Configuration changes affect only newly admitted intents.

## Fee Math

For intent amount `A`, annual rate `r`, and total purchased extension time `t`:

```text
cumulativeFee(t) = ceil(A * r * t / (10,000 * 365 days))
feeForThisExtension = cumulativeFee(newT) - feesAlreadyPaid
```

Charging the cumulative difference makes splitting one extension into many transactions cost exactly the same as buying it once. All division rounds upward.

At 20% APR, a 1,000 USDC intent costs approximately:

```text
1 hour:  0.022832 USDC
24 hours: 0.547946 USDC
```

The fee uses the complete intent amount. It does not depend on whether the payment method is chargebackable or on any historical base-cap policy.

## Stake Rules

The extension fee may use only free stake:

```text
free stake = active stake
           - reserved stake
           - pending withdrawal amount
```

Stake already exiting, reserved for chargeback coverage, or pending withdrawal cannot fund an extension.

When the intent owner and stake owner differ, the stake owner must explicitly authorize that intent owner to spend free stake on extension fees. Self-funded intents require no delegation.

An extension does not resize or create a stake reservation. The fee is spent immediately and credited to LP compensation.

## Lifecycle

### Admission

- The intent receives the initial free expiry from Escrow.
- A non-chargebackable intent reserves no stake.
- A chargebackable intent reserves only its configured chargeback coverage.
- Deferred payout admission does not add a cancellation bond.
- The position snapshots the extension rate, lifetime cap, and initial intent period.

### Extension

1. The intent owner asks `OrchestratorV3` for additional time.
2. The orchestrator rejects zero-duration, expired, non-owner, or over-cap requests.
3. The selected extension hook calculates the cumulative fee.
4. `RiskManager` verifies authorization, exit state, and sufficient free stake.
5. `StakeVault` spends the fee and credits the LP.
6. Escrow updates the expiry.

### Cancellation or expiry

- The pending position closes and releases its complete reservation.
- No cancellation penalty is calculated or slashed.
- Previously paid extension fees are not refunded.

### Fulfillment

- Non-chargebackable positions close without a stake reservation.
- Ordinary chargebackable positions retain the configured post-settlement coverage.
- Deferred payout positions continue through the existing deferred lifecycle.

## No-Chargeback Base-Cap Edge Case

The former 500 USDC base-unbonded tranche is not part of this model. A non-chargebackable intent of any size gets the same free initial period and reserves zero stake during that period.

If its owner wants more time, the fee is charged on the full locked amount. For example, extending a 500 USDC intent for one hour at 20% APR costs approximately 0.011416 USDC. Without sufficient opted-in free stake, the extension fails and the original expiry remains unchanged.

This removes the wallet-reusable subsidy boundary and directly prices only the extra liquidity-lock time requested by the buyer.

## Core Invariants

1. Cancellation and expiry never slash stake.
2. Only the intent owner can request an extension.
3. An expired intent cannot be revived.
4. Total intent lifetime never exceeds either configured cap.
5. Split extensions cost the same as one combined extension.
6. Extension fees cannot use reserved, exiting, or pending-withdrawal stake.
7. A delegated buyer cannot spend another depositor's stake without explicit authorization.
8. Escrow expiry changes only after the extension fee succeeds.
9. Extension fees do not reduce chargeback reservations or coverage.
10. Depositors retain control of which risk hook applies to their deposits.

## Deployment

The ABI change requires fresh immutable contract deployments. Historical scripts and deployment artifacts must not be edited to simulate compatibility. A live rollout should use a new numbered deployment script and migrate package, indexer, curator, and client consumers as a coordinated hard cut.
