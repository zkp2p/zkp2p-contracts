# Stake-Funded Intent Extensions and Chargeback Coverage

## Status

Hard-cut contract specification. The active ABI uses `IntentExtensionConfig`; deployment and downstream consumers must not retain compatibility fields or accounting from the removed pending-intent bond model.

## Summary

Stake now funds two independent liabilities:

1. A taker or its delegated stake owner can purchase additional intent time after the Escrow's initial free expiry. The maximum charge is reserved from the economic owner's stake, and the elapsed charge is paid to the LP whether the intent is fulfilled or cancelled.
2. A chargebackable payment reserves coverage after settlement. Coverage comes from existing membership stake or from gross deferred settlement proceeds converted into payout-recipient-owned stake.

Admission reserves only chargeback coverage. Merely signaling an intent does not reserve a pending-intent penalty. The Escrow's initial expiration period is the free interval; an intent must explicitly purchase any additional time before its current expiry.

The two liabilities use different StakeVault reservation identifiers and are never netted against each other.

## Trust and Custody Boundaries

- The depositor selects `RiskManager` as both the intent risk hook and the Escrow `intentGuardian`.
- Orchestrator snapshots the selected risk hook when the intent is admitted.
- RiskManager is the only contract allowed to extend the Escrow intent expiry.
- StakeVault is the only token custody and accounting boundary. RiskManager never retains tokens.
- Extension stake remains owned and withdrawable only by the stake owner; delegation gives the taker reservation authority, not custody rights.
- Ordinary post-intent hooks remain selected by the onramper and are independent of the risk policy.
- Curator and onramper clients must accept only known RiskManager addresses before paying fiat.

RiskManager rejects admission unless the deposit's `intentGuardian` is the same RiskManager. This binds the quoted extension policy to the only contract able to change the on-chain expiry.

## Terminology

- `A`: complete intent amount.
- `R`: gross amount actually released by Escrow at settlement.
- `E`: executable settlement amount after protocol, referral, and manager fees.
- `F`: independently rounded contingent fees, `R - E`.
- `s`: extension charge in basis points per hour.
- `Tbase`: original Escrow intent expiry snapshotted at admission.
- `Tpurchased`: cumulative additional time purchased for the intent.
- `Tterminal`: fulfillment, manual-release, or cancellation timestamp.
- `r`: chargeback reserve ratio in basis points.

## Platform Configuration

```solidity
struct ChargebackConfig {
    bool chargebackable;
    bool deferredPayoutEnabled;
    uint16 reserveBps;
    uint64 riskWindow;
}

struct IntentExtensionConfig {
    uint32 extensionPenaltyBpsPerHour;
}

struct PlatformRiskConfig {
    bool enabled;
    ChargebackConfig chargeback;
    IntentExtensionConfig intentExtension;
}
```

Configuration rules:

- `chargeback.reserveBps` is between `0` and `10_000`.
- A chargebackable method requires `reserveBps == 10_000` and a nonzero bounded risk window.
- A non-chargebackable method requires `reserveBps == 0` and disables deferred payout.
- Across the five-day total intent-lifetime ceiling, the configured slope cannot charge more than 100% of `A`.
- An enabled platform requires a nonzero extension slope, preventing accidental free extensions.

Governance changes affect only future admissions. Each position snapshots its full intent amount, extension slope, chargeback ratio, and risk window.

## Initial Expiry and Extension Curve

At admission:

```text
Tbase = createdAt + Escrow.intentExpirationPeriod()
```

No extension stake is reserved at admission.

For cumulative purchased time `Tpurchased`, the required extension reservation is:

```text
Qextension = ceil(
    A * s * Tpurchased
    / (10_000 * 1 hour)
)
```

Each extension reserves only the increase from the previously required cumulative reservation. Computing from cumulative time avoids rounding drift across repeated small extensions.

At any terminal outcome:

```text
elapsedAfterBase = max(Tterminal - Tbase, 0)
chargeableTime = min(elapsedAfterBase, Tpurchased)

Pextension = ceil(
    A * s * chargeableTime
    / (10_000 * 1 hour)
)
```

`Pextension` is slashed to LP compensation. Every unused unit of the extension reservation is immediately released as reusable stake of the snapshotted extension stake owner.

Consequences:

- Fulfillment and cancellation at the same timestamp produce the same extension charge.
- A terminal outcome at or before `Tbase` charges zero even if time was purchased early.
- A terminal outcome after the purchased interval cannot charge more than `Qextension`.
- Reconciliation uses Orchestrator's durable original cancellation timestamp, not the later reconciliation timestamp.

## Extension Calls

### `extendIntent(intentHash, additionalTime)`

- Callable by the intent taker or the exact delegated stake owner selected for the extension.
- On the first extension, resolves `StakeVault.stakeOwnerOf(taker)` and snapshots that address as `extensionStakeOwner` for the intent's complete extension lifecycle.
- Uses the snapshotted owner's existing free membership stake. Funding and authorization happen beforehand through `depositStake`, `depositStakeFor`, or `setTakerAuthorization`; no tokens move during `extendIntent`.
- Creates or increases the isolated extension reservation.
- Calls Escrow as the intent guardian only after the reservation succeeds.
- require a pending, unexpired intent;
- fail closed while StakeVault reservations are paused or the extension stake owner is exiting;
- validate that Escrow's current expiry equals `Tbase + Tpurchased`;
- reject zero added time and any extension that would move final expiry beyond five days from the original intent timestamp;
- cannot revive an already-expired intent;
- update RiskManager state only if the StakeVault reservation and Escrow guardian call both succeed.

Delegation changes cannot move an active reservation between economic owners. If the stake owner revokes the taker after the first extension, the taker cannot add exposure, but the snapshotted owner can still add time from its own stake. Terminal penalties and unused releases always settle against that original owner.

## Isolated Reservations

Chargeback coverage uses the intent hash as its StakeVault position identifier. Extension collateral uses:

```text
extensionReservationId = keccak256(
    abi.encode(EXTENSION_RESERVATION_NAMESPACE, intentHash)
)
```

This domain separation is mandatory. A payment method may require both liabilities at once:

```text
active reservation under intentHash
    = chargeback coverage

active reservation under extensionReservationId(intentHash)
    = maximum purchased-time charge
```

Charging or releasing one reservation cannot resize, release, or slash the other.

## Chargeback Coverage

For chargebackable settlement:

```text
Qchargeback = ceil(R * r / 10_000)
```

Current policy requires `r = 10_000`, so coverage equals the gross Escrow release.

### Stake-backed mode

- Admission reserves `ceil(A * r / 10_000)` from the delegated stake owner.
- Settlement first charges the independent extension stake owner's reservation.
- The independent chargeback reservation is then resized to `Qchargeback`.
- No settlement tokens are consumed by RiskManager.

### Deferred-payout mode

- Admission authorizes future deferred stake but reserves no nonexistent proceeds.
- Settlement first charges the taker's extension reservation.
- RiskManager then pulls the complete gross release directly from Orchestrator into StakeVault.
- StakeVault credits `R` to the payout recipient and reserves the full amount through the chargeback window.
- The fee slice `F` remains contingent; neither the payout recipient nor any fee recipient can withdraw it while coverage is live.

On a valid chargeback, the complete gross reservation compensates the LP and all contingent fees are cancelled. On clean maturity, `F` becomes pull-based fee claims and `E` becomes free reusable payout-recipient stake.

Deferred payment therefore becomes stake at settlement. It is not a separate balance class: gross proceeds increase `stakeBalance`, remain fully reserved during the risk window, and leave net proceeds as ordinary reusable stake after clean maturity.

## Admission and Capacity

Admission computes chargeback capacity only:

```text
chargebackAdmissionReserve = ceil(A * r / 10_000)
```

- If it is zero, the position is `UNBONDED`.
- If existing delegated stake covers it, the position is `STAKE_BACKED`.
- If existing stake is insufficient and deferred payout is enabled, the position is `DEFERRED_PAYOUT`.
- Otherwise admission fails.

Extension capacity is not pre-reserved and does not constrain initial quote capacity. Additional time succeeds only when its caller can fund the incremental extension reservation.

For non-chargebackable methods, RiskManager therefore places no stake-derived limit on the initial intent amount. Escrow deposit limits and off-chain admission policy continue to bound the quote. Any extension is priced on the complete amount of LP liquidity that remains locked.

## Settlement Ordering

For fulfillment and manual release:

```text
Escrow -> Orchestrator: R
Orchestrator -> RiskManager.settleIntent(fee plan, R, E)
RiskManager -> StakeVault: charge elapsed extension time, release unused extension reserve
RiskManager -> StakeVault: establish chargeback coverage, or release/no-op if non-chargebackable
```

After the risk callback:

- a zero-consumption stake-backed or unbonded callback lets Orchestrator execute fees and ordinary payout handling;
- an exact-gross deferred callback skips immediate fees, post-intent-hook execution, and direct payout because the entire fee plan is contingent in StakeVault.

Partial token consumption, token mismatch, amount mismatch, callback failure, or allowance mismatch reverts the complete settlement.

## Position and Event Surface

The hard-cut ABI:

- uses `IntentExtensionConfig` in `PlatformRiskConfig`;
- snapshots `intentAmount`, `baseIntentExpiry`, and `extensionPenaltyBpsPerHour` at admission;
- snapshots `extensionStakeOwner` on the first extension and tracks `totalExtensionTime`, `extensionReservation`, and terminal `extensionPenalty`;
- exposes `extendIntent`, extension cost/penalty math, and `extensionReservationId`;
- emits `IntentExtended` for each purchase and `IntentExtensionCharged` at every extended intent's terminal outcome;
- keeps extension events separate from chargeback and deferred-settlement events.

Indexers must use the emitted extension reservation identifier and must not combine extension collateral with `reservedAmount`, which remains chargeback coverage.

## Core Invariants

1. Admission requires `deposit.intentGuardian == RiskManager`.
2. Every extension cost is calculated from the full `intentAmount`.
3. Admission reserves chargeback coverage only; `extensionReservation == 0` initially.
4. The active extension reservation equals the position's `extensionReservation` and is keyed by the domain-separated identifier.
5. The extension reservation staker is the `extensionStakeOwner` snapshotted from current delegation on the first extension.
6. Cumulative extension reservation is monotonic and uses one upward rounding over cumulative purchased time.
7. Terminal extension charge is identical for cancellation, proof fulfillment, and manual release at the same timestamp.
8. Terminal extension charge never exceeds the purchased-time reservation; all excess is released.
9. A chargeback reservation and extension reservation can coexist without either operation mutating the other.
10. Delegated extension authority never changes stake ownership or grants the taker withdrawal rights.
11. Revocation blocks new taker-authorized exposure but does not strand or reassign the existing owner's reservation.
12. Deferred settlement increases payout-recipient stake and chargeback reservation by exactly the gross release.
13. Every slash decreases stake and reserved stake by the same amount and increases LP compensation by that amount.
14. Clean deferred maturity leaves `net free stake + claimable fees == gross release`.
15. Across every lifecycle transition, `token balance in StakeVault == total liabilities`.

## Illustrative Policy

```text
Escrow initial intent period:             1 hour
intentExtension.extensionPenaltyBpsPerHour: 10
maximum total intent lifetime:             5 days
```

For a 1,000 USDC intent:

```text
purchase 1 hour  => reserve 1.00 USDC
purchase 3 hours => cumulative reserve 3.00 USDC

terminal 30 minutes after initial expiry => charge 0.50 USDC, release 2.50 USDC
terminal 2 hours after initial expiry     => charge 2.00 USDC, release 1.00 USDC
terminal after all 3 purchased hours      => charge 3.00 USDC, release 0
```

The same table applies whether the terminal action is fulfillment or cancellation.

## Rollout

1. Deploy/configure RiskManager and set it as the deposit risk hook and intent guardian.
2. Set the Escrow initial expiration period to the intended free interval (one hour for the initial rollout).
3. Configure `IntentExtensionConfig` and chargeback policy per payment method.
4. Publish the hard-cut ABI and risk math.
5. Migrate the indexer to extension-owner snapshots, delegated reservations, and terminal charges.
6. Update curator and quote clients to recognize only approved risk hooks and the new extension fields.

`EscrowV2.setIntentExpirationPeriod` is a global Escrow setting, not a per-deposit or
per-payment-method policy. Executing step 2 shortens the initial window for every existing
deposit on that Escrow, including deposits that do not use RiskManager. The Safe batch must be
coordinated with quote clients, curators, indexers, and operators before execution. Existing
deposits must also be recreated if they need RiskManager as their immutable intent guardian.

The deployment command must export the freshly deployed ABI bundle and regenerate the contracts
package in the same successful pipeline. Consumers must not publish or ingest an older exported
`RiskManager` ABI after deploy 28 has executed.

Historical deployment artifacts remain immutable. Active contracts and downstream consumers do not expose legacy aliases or dual accounting.
