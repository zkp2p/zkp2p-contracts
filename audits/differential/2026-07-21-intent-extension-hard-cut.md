# Differential Security Review — IntentExtensionConfig Hard Cut

| Field | Value |
|-------|-------|
| Date | 2026-07-21 |
| Base | `origin/main` at `8fb117e` |
| Head | uncommitted working tree on `codex/intent-extension-risk-manager` |
| PR | n/a (pre-PR working-tree review) |
| Files Changed | 20 |
| Lines Changed | +1,361 / -1,177 |

## Scope and Method

Full read of the working-tree diff plus complete current sources of `RiskManager.sol`,
`StakeVault.sol`, both interfaces, `OrchestratorV3.sol` callback paths,
`EscrowV2.extendIntentExpiry`/prune/lock, mocks, deploy 28, `utils/riskMath.ts`, and all
changed tests. Traced token/allowance transitions, stake/reservation/compensation/fee
liabilities, extension+chargeback and extension+deferred composition, delegation/exit/
pause/controller-handover, rounding/boundary behavior, reentrancy and nonstandard-ERC20
behavior, callback-failure reconciliation, indexer ABI surface, and EIP-170.

Verification executed: `forge build --sizes`, Foundry unit (15 pass), fuzz (7 pass),
invariant (7 pass) suites, and Hardhat staking suites (126 pass).

## Risk Classification

| File | Risk | Reason |
|------|------|--------|
| contracts/RiskManager.sol | HIGH | New permissionless entry points, stake reservation and slash flows |
| contracts/StakeVault.sol | HIGH | New token-pulling controller function (`depositAndReserveStake`) |
| contracts/interfaces/* | MEDIUM | Hard-cut ABI/event surface for indexers |
| deploy/28, parameters.ts | MEDIUM | Sets global EscrowV2 expiry to 1 hour |
| tests / utils / mocks | LOW | Coverage and client math |

## Findings

### Critical

None.

### High

None.

### Medium

**M-1. Base-tranche liquidity can be locked for 5 days for free (taker) or dust (any third party)**

- `contracts/RiskManager.sol:421` — extension price is computed from `position.bondedAmount = max(A - U, 0)`.
- With the shipped non-chargebackable policy (`baseUnbondedAmount = 500 USDC`, slope 10 bps/h):
  - Intent ≤ 500 USDC ⇒ `B = 0` ⇒ `extendIntent` reserves nothing and charges nothing; a
    zero-stake taker extends the Escrow lock from 1 hour to 5 days + 1 hour at zero cost,
    with zero LP compensation, repeatably and concurrently (base is stateless).
  - Intent = base + 1 unit ⇒ `B = 1` ⇒ `stakeAndExtendIntent` lets *any address* extend a
    ~500 USDC LP lock to 5 days for 1e-6 USDC total (permissionless, no taker consent).
- Regression vs `main`: previously the base tranche's lock exposure ended at the Escrow
  period and `extendIntentExpiry` was exclusively LP-side (guardian = maker delegate).
  This diff hands extension rights to takers/sponsors while pricing on `B`, not on the
  locked amount, so the LP's cost-of-capital on the base tranche is uncompensated.
- Fix options: floor the charge on `intentAmount` (or add `minExtensionChargePerHour`);
  and/or cap total extension time when `B == 0`; and/or require taker/LP-consented
  sponsorship below a charge floor.

### Low / Informational

**L-1. `MAX_TOTAL_EXTENSION_TIME` mismatches EscrowV2's lifetime ceiling**

- `contracts/RiskManager.sol:417` caps *cumulative extension* at 5 days on top of
  `baseIntentExpiry = createdAt + intentExpirationPeriod`; `contracts/EscrowV2.sol:894`
  caps *total lifetime* at `intent.timestamp + 5 days`.
- The last `intentExpirationPeriod` (1 hour at target config) of the advertised extension
  budget always reverts inside `escrow.extendIntentExpiry` (atomic, no accounting damage,
  but a confusing revert after the RiskManager check passed). The constant's comment
  ("matching EscrowV2's total intent lifetime ceiling") and the slope validation both
  assume the full 5 days is purchasable. Test harness escrows
  (`RiskManagerEscrowHarness`, `RiskInvariantEscrow`) omit the Escrow cap, so no test
  catches this.
- Fix: bound `newExpiry <= escrowIntent.timestamp + 5 days` in `_extendIntent` (read the
  Escrow constant or snapshot the budget at admission), and mirror the cap in the mocks.

**L-2. Top-up extensions bypass `reservationsPaused` and the exiting-staker check**

- `contracts/StakeVault.sol:514` `updateReservation` enforces neither `reservationsPaused`
  nor `exitRequests[staker].exiting`, while first-time `reserveStake` (:412/:415) and
  `depositAndReserveStake` (:436/:439) enforce both. Consequently `extendIntent` top-ups
  on an existing extension reservation keep locking new taker stake during an
  incident-response reservation pause (and while the taker is exiting).
- `updateReservation` must stay pause-exempt for settlement resizes, so add the gating in
  `RiskManager._extendIntent` (or a dedicated increase entry point) instead.

**L-3. `RiskPositionCancelled.penalty` re-specification can double-count LP compensation in indexers**

- `contracts/interfaces/IRiskManager.sol:210` — the field named `penalty` now carries the
  extension penalty, which is *also* emitted in the same transaction via
  `IntentExtensionCharged.penalty`, and it is slashed from a different reservation than
  the one reported by `releasedReservation` (the old relation
  `penalty + releasedReservation == initialReservation` no longer holds). A naive indexer
  summing penalties across both events double-counts LP compensation.
- Hard cut permits re-specification; recommend renaming the field (e.g.
  `extensionPenalty`) so old decoders break loudly, and documenting that
  `IntentExtensionCharged` is the canonical charge record.

**L-4. Deploy 28 changes the global EscrowV2 expiry for every deposit**

- `deploy/28_deploy_risk_settlement_system.ts:819-832` sets
  `EscrowV2.setIntentExpirationPeriod(1 hour)` (directly or via Safe batch) on the shared
  EscrowV2. This shortens the intent window for *all* deposits and payment methods on
  that Escrow, including flows that do not use RiskManager. Intended for this rollout,
  but confirm downstream clients/quotes on the target network before executing the batch.

## Fund-Flow Invariants Verified

1. `stakeAndExtendIntent` pulls exactly `additionalReservation` from the sponsor via
   `depositAndReserveStake` (balance-delta checked, fee-on-transfer rejected), credits it
   to the taker's `stakeBalance`, and reserves it in the same call; it can never consume
   pre-existing taker stake (`extendIntent` is taker-gated; sponsorship path reverts on
   zero incremental charge).
2. Extension reservations live under `keccak256(abi.encode(NAMESPACE, intentHash))` —
   domain-separated from chargeback (`intentHash`) and deferred keys; no operation on one
   resizes/releases/slashes the other (verified in code and by the new invariant).
3. Cumulative reservation is monotonic with a single upward rounding
   (`cost(newTotal) - cost(prevTotal)`, snapshotted `B` and slope ⇒ no underflow);
   terminal penalty = `cost(min(terminal - baseExpiry, purchased))` ≤ reservation on
   every path (cancel, fulfill, manual release, reconcile) — identical at equal
   timestamps.
4. Every terminal path routes through `_chargeIntentExtension` exactly once (guarded by
   `PENDING` status); unused reservation is released to taker free stake in the same
   transaction; `IntentExtensionCharged` emitted iff time was purchased.
5. Failed cancellation callbacks stay fail-open: orchestrator records the durable
   `cancelledAt`; `reconcileCancellation` charges the same curve at that recorded
   timestamp (test-verified), never the reconciliation timestamp.
6. Deferred settlement: gross pulled Orchestrator→StakeVault with delta check, credited
   as fully reserved taker stake, fees contingent; chargeback slashes gross and cancels
   fees; clean maturity leaves `net free stake + claimable fees == gross`. Extension
   charge is applied before deferred funding and never touches the gross reservation.
7. RiskManager retains no tokens on any path; `StakeVault` solvency
   (`balanceOf == totalStaked + totalClaimableCompensation + totalClaimableFees`) holds
   across deposit-and-reserve, slash, release, deferred fund/vest/slash (invariant suite
   asserts it).
8. Admission binds `deposit.intentGuardian == RiskManager`; the guardian is immutable per
   deposit (set only at creation, EscrowV2.sol:1164), and the expiry-equality check
   (`currentExpiry == baseIntentExpiry + totalExtensionTime`) holds because only the
   guardian can extend.
9. Controller handover: terminal charge/release/slash use the reservation-snapshotted
   controller and continue to work after handover; new first-time extensions correctly
   fail closed (`onlyController`).
10. EIP-170: RiskManager 21,709 B (Hardhat profile) / 22,121 B (Foundry profile);
    StakeVault 17,329 B / 17,479 B — both comfortably under 24,576.

## Test Coverage

Strong: extension/cancel/settle parity, sponsorship atomic rollback, isolation from
chargeback coverage, reconcile-with-recorded-timestamp, cumulative rounding, invariant
solvency and per-staker deposit/slash ledgers. Gaps: no test exercises the EscrowV2
5-day lifetime cap against extensions (mocks omit it — L-1), and no test covers top-up
extensions while reservations are paused or the taker is exiting (L-2).

## Recommendation

**REQUEST CHANGES** — no fund-loss path found; accounting, isolation, and atomicity are
sound and well-tested. Address M-1 (economic griefing pricing) before deployment and the
L-1/L-2 hardening plus L-3 indexer note alongside it.
