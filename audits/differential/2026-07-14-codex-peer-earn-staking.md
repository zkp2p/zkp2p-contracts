# Differential Security Review

| Field | Value |
|-------|-------|
| Date | 2026-07-14 |
| Base | `origin/main` at `8d84f51` |
| Head | `codex/peer-earn-staking` at `363013c` |
| PR | Not opened at review time |
| Files Changed | 24 (12 contract/interface/mock files and 12 deployment/test/support files) |
| Lines Changed | +4,267 / -8 |

## Methodology

This review used the repository audit skill in differential mode and examined `origin/main...HEAD`. The named Trail of Bits differential-review and context-building subskills, and the corresponding local static-analysis binaries, were not available in this environment. The review therefore used a direct adversarial differential analysis of every changed production contract, its inherited lifecycle, interfaces, deployment wiring, and the Hardhat and Foundry tests. Trust assumptions were checked against the existing EscrowV2 and UnifiedPaymentVerifier implementations rather than assumed from comments.

## Risk Classification

| File | Risk | Reason |
|------|------|--------|
| `contracts/OrchestratorV3.sol` | High | Adds fail-closed admission, fail-open terminal callbacks, persistent settlement state, required post-hooks, and new lifecycle ordering around escrow transfers. |
| `contracts/RiskTierManager.sol` | Critical surface | Decides admission and collateral mode, owns position state, reconciles fail-open callbacks, computes deadlines, and authorizes slashing. |
| `contracts/StakeVault.sol` | Critical surface | Custodies all membership stake, deferred proceeds, and maker compensation, and implements controller migration and exits. |
| `contracts/hooks/DeferredPayoutHook.sol` | High | Atomically moves fulfilled proceeds into custody and registers the liability. |
| `contracts/interfaces/*.sol` | Medium | Defines the lifecycle and event contract relied upon by hooks, clients, and the indexer. |
| `deploy/26_deploy_stake_risk_system.ts` | High | Irreversibly wires custody, controller, risk verifier, platform policy, and ownership. |
| `test/staking/*`, `test-foundry/unit/*`, `test/deploy/*` | Medium | Broad example coverage exists, but the adversarial transition and migration cases below are absent. |

## Findings

### Critical

No critical findings were identified.

### High

#### H-01: Fallback maturity can release collateral while the underlying intent is still live and later settle unprotected

**Affected code:**

- `contracts/RiskTierManager.sol:175-180` assigns a fallback release time based only on configuration and the creation timestamp.
- `contracts/RiskTierManager.sol:305-320` permits anyone to mark an `ACTIVE` position `RELEASED` once that timestamp is reached, without checking durable settlement state or whether the Orchestrator/Escrow intent is gone.
- `contracts/OrchestratorV3.sol:211-223` and `contracts/OrchestratorV3.sol:263-272` deliberately fail open when the now-released manager position rejects a late terminal callback.
- Existing `contracts/EscrowV2.sol:826-865` does not reject `unlockAndTransferFunds` merely because the stored expiry timestamp has passed. Expiry cleanup is lazy, so an expired-but-unpruned intent remains settleable.

**Exploit/failure scenario:**

1. A taker signals a chargebackable, stake-backed intent. The manager reserves the required stake and records a fallback release time.
2. Nobody prunes or settles the intent. Passing Escrow expiry does not automatically delete either copy of the intent.
3. At the fallback release time, anyone calls `releaseMaturedPosition`. The manager marks the position `RELEASED` and the vault frees all collateral even though the Orchestrator still reports a live intent.
4. The taker then submits a valid payment proof, or the maker manually releases. UnifiedPaymentVerifier binds the proof to the intent snapshot but does not enforce that fulfillment occurs before Escrow expiry.
5. OrchestratorV3 records the settlement and invokes the risk callback. RiskTierManager reverts with `PositionNotActive`, but OrchestratorV3 emits `RiskHookCallbackFailed` and continues by design.
6. Escrow funds are delivered with no active reservation or deferred payout. A subsequent chargeback cannot be compensated because the position is already `RELEASED` and reconciliation is rejected.

This breaks the core invariant that every successful late settlement remains covered for its snapshotted risk window. Correctly setting `maxIntentLifetime` to EscrowV2's nominal maximum does not close the issue because expiry is not an automatic terminal state and late settlement is still accepted.

**Recommendation:**

Persist an explicit terminal state in OrchestratorV3 (`ACTIVE`, `CANCELLED`, `SETTLED`) independently of the pruned intent body, or use the existing durable settlement plus absence of `getRiskIntent(...).owner` as the cancellation/prune proof. Before fallback release, RiskTierManager should first reconcile a durable settlement if one exists; only then should it re-check maturity against the potentially recomputed exact `releaseTime`. If there is no settlement, it should require proof that the intent was cancelled/pruned and is no longer settleable. Never mark an unsettled, still-live Orchestrator intent `RELEASED` based on elapsed time alone. Add a regression test that reaches fallback maturity with an unpruned intent, rejects release, then performs a late settlement and confirms the full chargeback window remains collateralized.

#### H-02: Controller handover strands reservations owned by the previous RiskTierManager

**Affected code:**

- `contracts/StakeVault.sol:294-307` and `contracts/StakeVault.sol:312-338` allow only the single current `controller` to release or slash a stake reservation.
- `contracts/StakeVault.sol:426-438` replaces that controller globally after the delay, without checking or migrating outstanding reservations.
- `contracts/RiskTierManager.sol:199-218` stores the authoritative per-intent position only in the manager that created it.

**Exploit/failure scenario:**

1. RiskTierManager A creates one or more stake-backed positions, and StakeVault records reservations for them.
2. Governance performs the advertised delayed controller migration to RiskTierManager B.
3. When an old intent cancels, settles, matures, or receives a chargeback, manager A calls the vault and is rejected by `onlyController`.
4. Manager B is authorized at the vault but has no corresponding `riskPositions` state and therefore cannot safely issue the release or slash.
5. The old reservations remain in `reservedStake`. Affected takers cannot complete full exit even after every economic obligation has ended. Rotating back to A after another governance delay is the only built-in recovery, and doing so disables B's positions in the same way.

The handover is therefore not a safe upgrade mechanism while any stake-backed position exists. This can lock an unbounded number of user stakes and makes emergency controller replacement operationally unsafe.

**Recommendation:**

Define and enforce a migration invariant. The simplest safe option is to track a global active-reservation count/value and forbid controller acceptance until it reaches zero. A more flexible design should snapshot the creating controller in each reservation and allow that controller to resolve only its pre-handover reservations while only the current controller may create new ones, or provide an explicit audited per-position migration protocol. Deferred mode needs an admission-time per-intent controller marker because no token-backed vault record exists until settlement; globally authorizing every previous controller would let a retired controller create new liabilities after rotation. Add tests that migrate with active, settled, exiting, and chargeback-pending positions and prove each can still register/release/slash exactly once.

### Medium

#### M-01: The first partial chargeback permanently closes the position and releases all remaining coverage

**Affected code:**

- `contracts/RiskTierManager.sol:353-367` caps the first slash, then unconditionally marks the position `SLASHED` and zeroes its reservation.
- `contracts/StakeVault.sol:320-329` deletes the entire stake reservation even when `_amount` is smaller than `reservation.amount`.
- `contracts/StakeVault.sol:380-386` preserves the unslashed deferred payout, but the manager's `SLASHED` status prevents any subsequent valid claim against it.

**Exploit/failure scenario:**

A $500 covered settlement receives a valid $1 partial chargeback attestation early in the risk window. The system pays $1, marks the whole position `SLASHED`, and releases (stake mode) or makes permanently unclaimable (deferred mode) the remaining $499 of coverage. A later final chargeback for the remaining amount is rejected with `PositionNotActive`, even with a fresh nonce and valid witness signatures.

This is safe only under an undocumented and externally enforced assumption that every accepted attestation is the single final chargeback outcome for an intent. The attestation schema has an amount, validity interval, evidence ID, and nonce, but no finality field; the code and tests explicitly allow a slash below the reserved amount.

**Recommendation:**

Either support cumulative claims until the deadline by tracking `totalSlashed`, retaining the remaining reservation/payout, and consuming unique nonces, or extend the signed attestation with an explicit finality commitment and reject non-final claims if the product requires one-shot settlement. Add tests for two valid partial claims, cumulative bounds, nonce replay, and a final claim that releases only the remaining excess.

#### M-02: The vault reservation pause admits new deferred intents but makes their terminal settlement revert

**Affected code:**

- `contracts/RiskTierManager.sol:175-197` admits deferred-payout positions without touching StakeVault or checking its reservation pause.
- `contracts/StakeVault.sol:343-350` applies `reservationsPaused` when the already-admitted intent later records its deferred payout.
- `contracts/hooks/DeferredPayoutHook.sol:83-84` makes token custody and registration mandatory and atomic, so this vault revert bubbles up through the required post-hook.

**Exploit/failure scenario:**

1. Governance pauses vault reservations during an incident but does not separately pause RiskTierManager admission (the controls are independent transactions/contracts).
2. A taker with insufficient free stake signals a deferred-payout intent. No vault call occurs at admission, so signaling succeeds while reservations are paused.
3. Fulfillment or maker manual release later reaches DeferredPayoutHook. Tokens are tentatively transferred, but `recordDeferredPayout` reverts with `CustodyActionPaused`; the entire settlement reverts.
4. The intent cannot settle until governance unpauses. The same behavior blocks terminal settlement of deferred intents admitted before the emergency pause.

This makes a control described as pausing *new* custody actions freeze completion of existing economic obligations, and its split-brain admission behavior can create additional stuck intents during the pause.

**Recommendation:**

Use one authoritative admission pause for deferred mode and check it synchronously in `onIntentCreated`. Treat recording proceeds for a position already admitted before the pause as terminal settlement, not new admission, so it remains available alongside release/slash/withdraw operations. If governance wants a hard settlement freeze, expose and document that as a separate control. Add tests for both pre-existing and newly attempted deferred intents under every pause combination.

#### M-03: Deployment wires chargeback slashing to the stale single-witness verifier instead of the current verifier

**Affected code:**

- `deploy/26_deploy_stake_risk_system.ts:55` resolves `SimpleAttestationVerifier` and line 95 makes it the initial authority over all chargeback slashes.
- `test/deploy/26_stakeRiskSystem.spec.ts:136-139` asserts this wiring, entrenching it as expected behavior.
- Existing `deploy/24_deploy_multi_attestation_verifier.ts:36-53` deploys and wires `MultiAttestationVerifier` as the current modular verifier for V2 payment attestations.
- `deployments/parameters.ts:54-68` shows that the Base Simple witness and the configured current Base multi-verifier witness are different addresses.

**Exploit/failure scenario:**

Once governance adds the intentionally absent production tier parameters and enables this script, the new risk system trusts the legacy Simple verifier. Current attestor signatures may fail, preventing legitimate maker compensation, while the older Simple witness key retains unilateral authority to slash every active position. Staging also loses the broader configured witness set because Simple recognizes only one address.

**Recommendation:**

Wire the explicitly configured current `MultiAttestationVerifier` (or a dedicated chargeback verifier ratified by governance), add it as a deployment dependency, and verify its witness set/threshold before ownership transfer. The deployment test should exercise an actual EIP-712 chargeback signature from configured witnesses and reject a Simple-only/retired witness.

### Low / Informational

#### L-01: `settlementBuffer` is not snapshotted for active positions

`contracts/RiskTierManager.sol:585-586` computes the final release time with the current global `settlementBuffer`, while `contracts/RiskTierManager.sol:453-457` lets governance change that value after admission. The `RiskPosition` snapshots `riskWindow` and `reserveBps` but not the buffer. An increase can unexpectedly extend existing users' locks; a decrease changes previously presented release terms. Store the buffer in each position at admission and use that snapshot for both fallback and exact settlement timing, or explicitly document and test retroactive timing governance.

#### L-02: The risk-hook interface documents terminal state availability opposite to actual callback ordering

`contracts/interfaces/IIntentRiskHook.sol:8-9` says terminal callbacks occur before the intent is deleted, but OrchestratorV3 prunes first at `contracts/OrchestratorV3.sol:166-172`, `contracts/OrchestratorV3.sol:214-223`, and `contracts/OrchestratorV3.sol:265-272`. A third-party hook written to the interface may call `getRiskIntent` during a terminal callback, receive zeroed state, and revert. The fail-open Orchestrator then continues without that hook's accounting. Correct the NatSpec and expose the exact durable terminal data a hook may safely read, or invoke the callback before deletion while preserving CEI/reentrancy safety.

## Blast Radius

- **Intent admission:** `OrchestratorV3.signalIntent`, `RiskTierManager.onIntentCreated`, tier caps, concurrency checks, stake/deferred mode selection, and emergency pause behavior.
- **Terminal lifecycle:** `cancelIntent`, `fulfillIntent`, `releaseFundsToPayer`, Escrow-driven `pruneIntents`, orphan cleanup, callback gas failure, and settlement reconciliation.
- **Custody and exits:** every stake reservation, full exit, deferred payout, compensation credit, and controller handover in StakeVault.
- **Chargebacks:** EIP-712 digest binding, verifier selection, nonce use, deadline checks, one-shot/partial semantics, and maker compensation.
- **Operations/indexing:** platform configuration and lifecycle events, deployment dependency/witness assumptions, and event consumers that infer reservation or tier state.

## Test Coverage

The added Hardhat suite provides useful positive and revert coverage for tier derivation, caps, concurrency, immediate exit blocking, stake-backed reservation, cancellation, partial fulfillment, manual release, durable settlement reconciliation, deferred custody, deadline exclusivity, vault liability accounting, and basic controller delay. The Foundry tests duplicate several core unit paths and include limited fuzzing of stake amounts.

The following security-critical cases are missing:

1. Fallback maturity while the Orchestrator/Escrow intent remains live, followed by late proof fulfillment or manual release.
2. Controller migration with active reservations, deferred payouts, exits, failed callbacks, and positions in each terminal state.
3. Multiple partial chargebacks for one intent, cumulative bounds, nonce replay, wrong domain/chain/manager/orchestrator/method, and real witness signatures.
4. Deferred admission and terminal settlement under each independent manager/vault pause combination.
5. Invariants over arbitrary sequences: `reservedStake <= stakeBalance`, `totalLiabilities <= token.balanceOf(vault)`, one terminal state per position, and no successful settlement without coverage through its slash deadline.
6. Deployment against the current MultiAttestationVerifier, including witness/threshold assertions and a real signed chargeback.
7. Third-party hook behavior under the documented terminal callback ordering and deliberately exhausted callback gas.

## Recommendation

**BLOCK** until H-01 and H-02 are fixed and covered by regression tests. M-01 must be resolved either in code or by making the signed one-shot-finality invariant explicit and enforceable. M-02 and M-03 should be corrected before any production deployment because they affect settlement liveness and the authority that can slash user funds.
