# StakeVault and RiskManager Policy

## Status

Hard-cut specification for the simplified stake ledger and its initial RiskManager. No predecessor RiskManager has been deployed, so this version has no legacy migration surface.

## Contract boundaries

`StakeVault` is the only token custody and accounting boundary. It knows nothing about intents, chargebacks, fees, or extension policy. It stores:

- stake balances and per-owner locked totals;
- one lock per `bytes32` identifier;
- immediately withdrawable claims;
- Safe-to-taker authorizations and each taker's selected Safe;
- one global controller with a delayed handover.

`RiskManager` owns all business policy. It decides why stake is locked, when a lock resolves, and who receives claims. It never retains tokens.

`OrchestratorV3` snapshots the depositor-selected risk hook per intent. Admission and settlement are fail-closed. Cancellation is fail-open and records the original cancellation timestamp for later reconciliation.

## StakeVault ledger

For every stake owner:

```text
freeStake = stakeBalance - lockedStake
```

Global accounting must always satisfy:

```text
stakeToken.balanceOf(StakeVault) >= totalStaked + totalClaimable
```

The implementation rejects fee-on-transfer deposits and deferred funding so accepted transfers preserve exact accounting.

### User operations

- `depositStake(amount)` credits the caller's stake.
- `withdrawStake(amount)` withdraws only free stake.
- `claim()` withdraws the caller's complete claimable balance.
- `setTakerAuthorization(taker, authorized)` grants or revokes access to the caller's stake.
- `selectStakeOwner(stakeOwner)` lets a taker explicitly select one authorizing Safe.
- `clearStakeOwner()` restores the taker's own stake as the fallback.

Authorization never transfers ownership or custody. Revocation clears an active selection, and later reauthorization does not restore it automatically.

### Controller operations

- `lockStake(owner, id, amount, maturity)` moves free stake into a new lock.
- `fundLock(owner, id, amount, maturity)` accounts already-transferred, previously unaccounted tokens as a new locked stake balance.
- `increaseLock(id, amount)` adds free stake to a non-matured lock.
- `resizeLock(id, newAmount, newMaturity)` only reduces a non-matured lock and updates its maturity.
- `unlockStake(id)` deletes a lock and makes its complete amount free immediately.
- `resolveLock(id, claims)` deletes a lock, converts the specified portion into immediate claims, and leaves the remainder as free stake.

Lock maturity is a policy timestamp, not an autonomous transition. Only the current controller can mutate or resolve locks.

## Delegation and squatting resistance

Each Safe may authorize any number of takers, and each taker selects at most one authorizing Safe:

```text
authorizedTakers[safe][taker] = true
selectedStakeOwner[taker] = safe
```

`stakeOwnerOf(taker)` returns the selected Safe only while the authorization remains live; otherwise it returns the taker. An unrelated account authorizing a taker cannot select itself, replace another selection, block self-staking, or consume the legitimate Safe's stake. Takers can always deposit additional stake for themselves.

## Platform configuration

```solidity
struct ChargebackConfig {
    bool chargebackable;
    bool deferredPayoutEnabled;
    uint64 riskWindow;
}

struct PlatformRiskConfig {
    bool enabled;
    ChargebackConfig chargeback;
    uint32 extensionPenaltyBpsPerHour;
}
```

Rules:

- a chargebackable method requires a nonzero `riskWindow` no greater than 365 days;
- a non-chargebackable method must disable deferred payout and use a zero risk window;
- a zero extension slope disables extensions;
- the configured slope cannot charge more than 100% of an intent across the five-day maximum lifetime;
- each position snapshots its risk window and extension slope at admission.

`riskTakingPaused` blocks new admissions and extensions. Cancellation, settlement, reconciliation, maturity release, and chargeback remain live.

## Admission modes

Admission requires the configured payment method to be enabled, the Escrow token to equal the Vault token, and `deposit.intentGuardian == RiskManager`.

For an intent amount `A`:

- `UNBONDED`: chargebacks are disabled; no coverage lock is created.
- `STAKE_BACKED`: the selected Safe or taker has at least `A` free stake; the raw intent hash locks the full `A` with `NEVER_MATURES`.
- `DEFERRED_PAYOUT`: chargebacks are enabled, free stake is insufficient, and deferred payout is enabled; admission creates no Vault state. Settlement later funds a gross lock owned by the payout recipient.

Deferred admission rejects any nonzero post-intent hook. A deferred settlement consumes the full gross amount, so allowing a hook would silently skip its payout behavior.

## Intent extensions

The original Escrow expiry is free:

```text
baseExpiry = createdAt + Escrow.intentExpirationPeriod()
```

For intent amount `A`, hourly slope `s`, and cumulative purchased time `T`:

```text
extensionCost = ceil(A * s * T / (10_000 * 1 hour))
```

Extensions use a separate never-maturing lock:

```text
extensionLockId = keccak256(
    abi.encode(keccak256("ZKP2P_INTENT_EXTENSION"), intentHash)
)
```

The first extension snapshots its stake owner. Later extensions only increase that lock by the difference between the old and new cumulative costs. Computing from cumulative time prevents rounding drift.

The taker may extend while its current selection still matches the snapshotted extension owner. The snapshotted owner may always add exposure from its own stake. Revocation prevents the taker from adding further sponsor exposure without preventing the sponsor from acting voluntarily.

At cancellation or settlement time `terminalAt`:

```text
chargeableTime = min(max(terminalAt - baseExpiry, 0), totalPurchasedTime)
penalty = ceil(A * s * chargeableTime / (10_000 * 1 hour))
```

The extension lock resolves into an immediate LP claim for `penalty`; the unused remainder becomes free stake. Failed-cancellation reconciliation uses Orchestrator's recorded cancellation timestamp.

## Settlement

Orchestrator transfers the gross Escrow release `R` to itself, computes exact fee allocations, and invokes the snapshotted RiskManager before distributing funds.

### Unbonded

- RiskManager records the position as released.
- It consumes zero tokens.
- Orchestrator pays fees and the net payout normally, including any post-intent hook.

### Stake-backed

- RiskManager resolves the extension lock.
- The raw intent lock is reduced from admitted amount `A` to gross release `R` and receives `coverageDeadline = settlementTime + riskWindow`.
- It consumes zero tokens.
- Orchestrator pays fees and the net payout normally, including any post-intent hook.

### Deferred payout

- RiskManager resolves the extension lock.
- It pulls exactly `R` from Orchestrator directly into StakeVault.
- StakeVault funds one raw-intent lock of `R` owned by the payout recipient until the coverage deadline.
- RiskManager stores the exact nonzero fee allocations.
- Orchestrator observes exact-gross consumption and performs no immediate fee or payout transfers.

Partial token consumption, token mismatch, recipient mismatch, invalid fee totals, callback failure, or transfer mismatch reverts the complete settlement.

## Maturity and chargeback

Anyone may call `releaseMaturedPosition` at or after the half-open coverage deadline.

- Stake-backed maturity unlocks the sponsor's raw-intent lock.
- Deferred maturity resolves the raw-intent lock into immediate fee claims; the net remains free stake of the payout recipient.

A valid chargeback before the deadline resolves the complete gross coverage lock into one immediate LP claim. Deferred fee allocations are deleted, so no fee claim survives a chargeback.

Chargeback evidence is bound by:

- the RiskManager EIP-712 domain;
- `intentHash` and `dataHash`;
- a payment-method-scoped dispute nullifier;
- bidirectional payment-nullifier binding for proof-based fulfillment;
- the attestation verifier. Manual release has no payment nullifier and relies on the attestation witness set.

## Controller handover

StakeVault has one global controller. Governance proposes a successor, waits the configured delay, and the successor accepts. Acceptance immediately transfers authority over every Vault lock.

Because Orchestrator snapshots a RiskManager per active intent, governance must not hand over the Vault while that manager still has positions that may require Vault mutation. This initial release contains no predecessor/migration path because no previous RiskManager has been deployed. A future upgrade must either drain active positions before handover or ship an explicit adoption/read-through procedure in the successor.

## Core invariants

1. Vault token balance covers `totalStaked + totalClaimable`.
2. For every owner, `lockedStake <= stakeBalance`.
3. Every active RiskManager amount matches its corresponding Vault lock.
4. Coverage and extension locks use different identifiers.
5. Only the current Vault controller can mutate locks.
6. Delegation cannot change stake ownership or be selected by the sponsor.
7. Stake-backed and deferred coverage always equal the gross release.
8. Extension penalty never exceeds the extension reservation.
9. Chargeback and clean maturity cannot both resolve the same coverage lock.
10. Pause never blocks a terminal path.
