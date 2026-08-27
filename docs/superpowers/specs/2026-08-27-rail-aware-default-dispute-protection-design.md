# Rail-aware default dispute protection

Date: 2026-08-27
Status: design approved in chat; Claude + Codex convergence ran 5 rounds
(all findings accepted or explicitly rejected below, none unresolved);
pending user spec review
Scope: `DisputeProtectionPolicy` default semantics, its NatSpec, Foundry tests,
lane-37 event scan, documentation; companion indexer/curator changes are
listed as rollout dependencies, not implemented here
Builds on: `2026-08-27-method-scoped-policy-successor-lanes-design.md`,
PR #278 (`(escrow, depositId, paymentMethod)` scoping)
Supersedes the default rule of: `2026-08-20-dispute-protection-opt-in-cutover-design.md`
(which itself reversed PR #257's all-rails default-on)

## Goal

Every deposit is protected by stake-backed dispute protection **by default on
chargebackable rails**, and only there. A depositor can still opt a
`(deposit, paymentMethod)` tuple out. "Chargebackable" is not a new concept:
it is exactly "the payment method has a nonzero governance risk window", which
today is `paypal`, `venmo`, and `cashapp` (`DISPUTABLE_PAYMENT_METHODS`).

## Decision

Represent the depositor's choice as a single boolean **opt-out** flag and make
the effective state rail-aware:

```solidity
/// @dev Whether the depositor opted a deposit payment method out of default dispute protection.
mapping(address => mapping(uint256 => mapping(bytes32 => bool))) internal isDisputeProtectionDisabledByPaymentMethod;

function isDisputeProtectionEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod)
    external view returns (bool)
{
    return !isDisputeProtectionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod]
        && paymentMethodRiskWindow[_paymentMethod] != 0;
}

function setDisputeProtectionEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _isEnabled)
    external onlyDepositor(_escrow, _depositId)
{
    isDisputeProtectionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod] = !_isEnabled;
    emit DisputeProtectionEnabledUpdated(_escrow, _depositId, _paymentMethod, _isEnabled);
}
```

Two layers enforce this, and they must not be confused:

1. **Route selection.** `IntentLifecycleHookV1.onIntentSignaled` calls the
   effective getter. `false` means the intent never reaches the policy: an
   enabled whitelist rejects a non-member with `TakerNotWhitelisted`, a
   disabled whitelist admits openly. This is the canonical path; after an
   opt-out, integration tests expect `TakerNotWhitelisted` or open admission,
   never `DisputeProtectionNotEnabled`.
2. **Defense in depth.** `_validateIntentAdmission` still reverts
   `DisputeProtectionNotEnabled` when the opt-out flag is set. On the
   canonical path it is unreachable (the getter already said `false`); it
   protects against an authorized hook that routes without consulting the
   getter. `onIntentSignaled`'s `riskWindow == 0` early return precedes it,
   so a zero-window rail is never admission-checked by the policy.

A tri-state override (DEFAULT / ENABLED / DISABLED) was considered and
rejected: with a rail-aware default, an explicit "enabled" has the same effect
as "untouched", so the third state would only buy grandfathering if the
default rule changed later. Accepted trade-off: if that rule ever changes,
every non-opted-out tuple follows it.

## ABI

Byte-for-byte unchanged from PR #278: `setDisputeProtectionEnabled(address,uint256,bytes32,bool)`,
`isDisputeProtectionEnabled(address,uint256,bytes32)`,
`DisputeProtectionEnabledUpdated(address,uint256,bytes32,bool)`, and
`DisputeProtectionNotEnabled(address,uint256,bytes32)` keep their exact
signatures. Only storage layout, NatSpec, and behavior change. The
`isDisputeProtectionEnabled` name remains the effective query; there is no raw
"was it explicitly set" query, by design.

Two sharp edges of the unchanged ABI must be documented in NatSpec and
respected by consumers:

- The getter validates nothing: it returns `true` for any escrow, any deposit
  id (including nonexistent ones), and any `bytes32` that has a nonzero risk
  window. Callers that need existence or registration checks perform them
  separately; the orchestrator already does before calling the hook.
- The event's `isDisputeProtectionEnabled` boolean is the **requested
  depositor setting**, not effective state. `(…, true)` can be emitted on a
  rail with no risk window while the getter keeps returning `false`.
  Consumers must combine the latest event with the rail's current risk
  window and must never treat the event boolean alone as effective.

## Behavior

For a deposit whose depositor has not called the setter:

| Whitelist | Taker | Rail | Result |
| --- | --- | --- | --- |
| enabled | allowed | any | direct admission, no stake |
| enabled | not allowed | risk window > 0 | stake-backed admission (was: revert `TakerNotWhitelisted`) |
| enabled | not allowed | risk window == 0 | revert `TakerNotWhitelisted` (unchanged) |
| disabled | any | risk window > 0 | stake-backed admission for every taker (was: open) |
| disabled | any | risk window == 0 | open (unchanged) |

After `setDisputeProtectionEnabled(…, false)` the tuple behaves as today's
untouched deposit (whitelist is a hard gate, or open). After
`setDisputeProtectionEnabled(…, true)` it behaves as untouched, i.e. the
setter with `true` only undoes an opt-out.

Behavior that changes for **explicitly opted-in** tuples from PR #278: on a
zero-window rail, the hook used to route the intent into the policy, which
returned early without a stake, so a whitelist-enabled deposit admitted a
non-member unstaked. Under the rail-aware rule the effective state is `false`
whenever the window is zero, so the whitelist remains a hard gate. This is a
deliberate fix, not a regression.

Consequences carried over from PR #257 and accepted again:

1. On chargebackable rails, an enabled whitelist becomes a skip-staking fast
   lane, not a hard gate; any staked taker is admitted.
2. Non-USDC deposits revert `IntentTokenMismatch` for non-whitelisted takers on
   chargebackable rails until the depositor opts out. Misconfiguration stays
   loud rather than silently open.
3. `admissionsPaused` is a kill switch for every intent **routed through the
   policy**: non-whitelisted takers on non-opted-out tuples with a nonzero
   window. It is not consulted for whitelisted takers, zero-window rails, or
   opted-out tuples (which stay gated by the whitelist or open, even while
   paused).
4. Governance must set a rail's risk window deliberately: a nonzero window
   routes every future non-whitelisted admission on non-opted-out tuples of
   that rail through the policy; zero routes none of them (and restores the
   whitelist as a hard gate). It changes **future admissions only** — intents
   already admitted keep the window snapshotted at `onIntentSignaled`, so
   zeroing a window neither unprotects pending or settled intents nor
   shortens their coverage, and raising it does not extend them.
   `setRiskWindow` accepts any `bytes32` without checking that it is an active
   payment method; the governance runbook must derive the hash from a known
   method name, print it, and confirm registry membership before submitting.
   Contract-level validation is intentionally out of scope here.

Nothing changes on Base or Base staging until the method-scoped activation
lane flips `OrchestratorV3.lifecycleHook()`; lane 37 is passive.

## Predecessor depositor choices at activation

The replacement is a reset, not a migration: the method-scoped policy starts
with every tuple untouched. Explicit choices recorded on the predecessor
policy are not carried over. The predecessor differs per network and the
inventory scans the address pinned in
`METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network]`, never a name:

- **Base**: the lane-34 `DisputeProtectionPolicyOptIn` (`0xcEc4…87aA`,
  opt-in semantics) and `StakeVaultOptIn` (`0x4d16…bCEB`). It has emitted
  exactly two `DisputeProtectionEnabledUpdated` events since deployment, both
  `true` (deposits `0x1048` and `0x105e` on `0x7777…00ef`); under the new
  default those deposits are protected anyway.
- **Base staging**: the lane-32 stack — policy `0x2151…5020` (deployed from
  PR #257-era default-on source, so an explicit `false` there was already an
  opt-out) and vault `0xEc9f…8f43`. The staging `*OptIn` trio was never
  activated and is not the predecessor; its one config event is irrelevant.
- No live predecessor holds any explicit opt-out today.

This is a deliberate product decision, and it is safe today because that
inventory is empty.

The setter is depositor-only, so governance cannot replay choices on a
depositor's behalf. The activation lane's gate therefore re-runs this
inventory from chain and requires, before the hook flip:

1. **explicit predecessor opt-outs**: deposits that have at least one
   predecessor `DisputeProtectionEnabledUpdated` event and whose latest such
   event — ordered by `(blockNumber, transactionIndex, logIndex)` — requested
   `false`. Untouched deposits (no predecessor event) are deliberately
   excluded: the predecessor's default was `false` only because it was
   opt-in, and resetting those to the new default is the point of this
   design. The predecessor setting is deposit-wide while the successor is
   tuple-scoped, so the gate requires a successor opt-out on **each** active
   chargebackable `(escrow, depositId, paymentMethod)` tuple of that deposit,
   verified by the successor's latest setter event for that tuple being
   `false` — not by the effective getter, which also reads `false` when the
   rail's window is zero;
2. for every active deposit whose token is not the stake token and that has
   an active chargebackable method: the same per-tuple successor opt-out
   (their non-whitelisted takers would otherwise revert
   `IntentTokenMismatch` after activation);
3. **successor vault readiness**: stake is taker-owned and is not migrated
   from the predecessor vault, so the activation runbook publishes a staking
   window during which takers withdraw from the predecessor vault, deposit
   into `StakeVaultMethodScoped`, and restore their taker authorizations and
   stake-owner selections there. The gate reports the successor vault's
   `totalStaked` and the predecessor's, and activation is a conscious call
   on those numbers. Takers who have not staked on the successor by the flip
   cannot take protected rails until they do; that residual outage is
   inherent to a non-migrated, taker-owned vault and is accepted.

"Chargebackable" in this inventory means `successorRiskWindow != 0` for the
tuple's payment method. The whole inventory — deposit state, active methods,
both policies' risk windows, and both policies' events — is read at one
finalized block, and the gate records that block number and hash alongside
the counts.

This is an **operational snapshot with an accepted race**, not an enforceable
freeze: the depositor setters on both policies are permissionless, active
methods can change, and governance can change windows between the snapshot
and the Safe execution. No freeze guard is added (it would require a pause
that itself blocks depositors). Mitigation: the inventory is re-run
immediately before the Safe transaction is executed and again in postflight;
a postflight difference is reported as a follow-up for the affected
depositors, not as a rollback trigger.

There is deliberately **no governance write path** into depositor settings:
the policy is non-upgradeable, its opt-out mapping is internal, and only the
depositor setter mutates it. A `bootstrapOptOuts`-style owner function is
rejected — it would give governance the power to strip a depositor's
protection and cannot be retrofitted after lane 37 executes anyway. The
resolution order at activation is therefore fixed now:

1. affected depositors opt out themselves on the new policy (the setter is
   live from lane-37 deployment onward, and lane 37 tolerates it — see
   below); activation stays blocked until the re-run inventory is clear;
2. if the inventory is non-trivial and depositors cannot be reached, the
   method-scoped stack is not activated; a successor lane with whatever
   contract change is then warranted replaces it. That is the repository's
   normal mechanism, and cheaper than carrying a speculative governance
   power in every future policy.

## Deployment and tooling

- No new lane. Lanes 36 and 37 have not executed on any live network — verified
  on 2026-08-27, not inferred: `deployments/base` and `deployments/base_staging`
  contain no `*MethodScoped` record, no live `OrchestratorV3` references a
  method-scoped hook, and the lane-37 tag has never been accepted by the
  runner on a live network (its `ENABLE_*` flags are unset everywhere). The
  implementation PR re-checks both deployment directories before editing
  lane 37, because the lane becomes immutable the moment it executes.
- `deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts` currently
  treats `DisputeProtectionEnabledUpdated` as "stack used" in
  `assertFreshStackUnused`, which would make a depositor's pre-activation
  opt-out (exactly what non-USDC depositors must do) flip the deploy-only
  prefix out of `prepared`. The same rule blocks takers from pre-funding the
  successor vault, which under a default-on policy would turn the hook flip
  into an outage for every non-whitelisted taker on chargebackable rails.
  Redefine "fresh" as **no lifecycle or lock activity**, not "untouched":
  - allowed before activation: `DisputeProtectionEnabledUpdated` on the
    policy; `StakeDeposited`, `StakeWithdrawn`, `TakerAuthorizationUpdated`,
    `StakeOwnerSelected` on the vault (pure taker collateral management, which
    cannot create a lock while no intent routes through the policy);
  - forbidden before activation: the policy's intent opened/cancelled/
    settled/released and `DisputeResolved`; the vault's `StakeLocked`,
    `LockFunded`, `StakeLockIncreased`, `StakeLockResized`, `StakeUnlocked`,
    `StakeLockResolved`, `ClaimCreated`, `ClaimWithdrawn`.
  - accounting is **phase-gated**, because `StakeVault.initializeController`
    reverts `ControllerInitializationWithLiabilities` while `totalStaked` or
    `totalClaimable` is nonzero, and `depositStake` is permissionless — a
    one-unit deposit before step four would brick the lane permanently:
    - while `controller == address(0)` (steps `deploy-vault` through
      `initialize-controller`): require `totalStaked == 0` and
      `totalClaimable == 0`, and treat any stake-deposit event as a
      non-contiguous, unrecoverable prefix (fail closed with a message that
      names the depositor's transaction hash);
    - once `controller == policy`: allow `totalStaked > 0`; require
      `totalClaimable == 0` and no lock or claim event. The helper classifies
      each `StakeDeposited` / `TakerAuthorizationUpdated` /
      `StakeOwnerSelected` event against the vault's `ControllerInitialized`
      event by `(blockNumber, transactionIndex, logIndex)`: an event ordered
      before it is the pre-controller failure above (named by transaction
      hash), one after it is permitted.
    Drop the `totalAccounted`, `unaccountedBalance`, and raw `balanceOf` zero
    checks in both phases (griefable by a dust transfer and not load-bearing).
  Deployment, controller, and ownership events that lane 37 itself emits
  (`RiskWindowUpdated`, `DisputeVerifierUpdated`,
  `LifecycleHookAuthorizationUpdated`, `AdmissionsPausedUpdated`,
  `ControllerInitialized`, `ControllerProposed`, `ControllerAccepted`,
  `ControllerProposalCancelled`, `OwnershipTransferStarted`,
  `OwnershipTransferred`) form a third, explicitly expected list per
  contract. The classifier is fail-closed: every event decoded from a
  policy or vault log must belong to exactly one of that contract's
  allowed / expected / forbidden lists, and a log the ABI cannot decode
  is an error, so a future event cannot slip past the guard. A test
  derives the event names from the compiled artifacts and asserts the
  three lists partition them. Add deployment-helper tests proving: a configuration
  event after deployment leaves the stack `prepared`; a stake deposit or
  taker authorization **after** controller initialization leaves it
  `prepared`; a stake deposit **before** controller initialization fails the
  prefix; a lock or claim event fails it in either phase.
  The staking window (see the activation gate) is published only after lane
  37 reports `prepared` on that network, i.e. after `controller == policy`.
  Pre-activation opt-outs and post-preparation staking are expected and
  supported. `2026-08-27-method-scoped-policy-successor-lanes-design.md`
  gets a one-line amendment pointing here for the fresh-vault rule.
- Event decoding stays ABI-derived; the scan reads every log of each fresh
  contract without a topic filter and classifies it through the per-contract
  allowed / expected / forbidden lists instead of one "any activity" list.
- `deployments/dispute-stack-evidence.json` `sentinel`
  (`escrow 0x…01, depositId 0, expected false`) is a static shape check with no
  payment method. It stays as is for this PR; the activation PR that refreshes
  the evidence should restate it per rail (`expected: riskWindow != 0`).
- Lane 34's `*OptIn` stack keeps opt-in semantics until it is replaced; the
  package's Base and Base-staging addresses still point at it, and the
  published ABI already matches (unchanged signatures).

## Rollout dependencies (separate PRs, required before activation)

- **zkp2p-indexer** (`resolveDisputeProtectionProjection`): a missing
  `DepositDisputeProtectionConfig` row must resolve to
  `riskWindow != 0`; explicit `enabled: false` → `false`; explicit
  `enabled: true` → `riskWindow != 0`. `disputeProtectionOptedIn` and
  `disputeProtectionRequiresStake` therefore always agree, and the event
  boolean is never used alone. Preferred shape: persist the raw per-tuple
  setting and one current risk-window record per policy and rail, and compute
  the effective value at projection/query time, so a `RiskWindowUpdated`
  event is a one-row write. If the denormalized `QuoteCandidate` /
  `OrderbookEntry` columns must be kept, the rail-wide refresh has to be an
  idempotent, block-versioned job that does not mark the event processed
  until every row on the rail is updated. Setter and `RiskWindowUpdated`
  must project correctly in either arrival order. Companion of
  zkp2p-indexer PR #262; the choice between the two shapes is made there.
- **Indexer predecessor/successor cutover.** The indexer already keys
  `DepositDisputeProtectionConfig` and `DisputeProtectionRiskWindow` by
  policy address and projects only the environment's configured active
  policy (the opt-in cutover design made active-policy identity an explicit
  per-environment setting, not a chain-id inference). Today's config and
  risk-window handlers, however, fan projections out using the **emitting**
  policy address without consulting that setting
  (`src/handlers/v3/dispute_protection_policy.ts`), so successor events would
  move projections before the flip. The indexer PR must: always write raw
  config/risk-window rows for any followed policy (shadow state from the
  successor's deployment block); suppress projection fan-out unless
  `event.srcAddress == activePolicyAddress`; and on activation flip the
  configured active policy address with the reindex that change already
  implies, converging every affected row idempotently (not "exactly once" —
  the pipeline is at-least-once) and leaving predecessor rows out of
  projection. The indexer PR proves: successor events do not move projections
  pre-flip; the flip converges rows to the successor state; events emitted
  before the indexer started following the successor are backfilled.
- **curator**: verify eligibility treats `disputeProtectionRequiresStake` as a
  stake route (row stays fillable by staked takers), never as a privacy gate
  that hides the row. The August regression that hid every
  paypal/venmo/cashapp row came from treating "protected" as "private".
- Activation order is unchanged from the successor-lanes design: deploy-only
  lanes 36/37 → bootstrap tuple policy → indexer/package/curator ready →
  activation lane.

## Tests

Test-first, smallest Foundry targets:

`test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol`
- untouched tuple: `true` for a rail with a nonzero window, `false` for a
  zero-window rail, `false` for a nonexistent deposit on a zero-window rail,
  `true` on a windowed rail (the getter does not validate deposit existence);
- `setDisputeProtectionEnabled(false)` → `false`; `(true)` → back to the
  rail-aware value; event emitted with the passed bool; depositor-only;
- `setRiskWindow` flips the effective value for untouched and opted-in tuples
  and leaves opted-out tuples `false`;
- `onIntentSignaled` (called directly as the authorized hook) on an opted-out
  windowed rail reverts `DisputeProtectionNotEnabled` — defense-in-depth
  coverage, explicitly labeled as non-canonical; on an untouched windowed
  rail it admits and snapshots configuration; on a zero-window rail it
  returns without state;
- zeroing or raising a rail's window after admission leaves a pending
  intent's and a settled intent's snapshotted window, release eligibility,
  and lock untouched.

`test-foundry/deterministic/integration/{DisputeLifecycleHook,IntentLifecycleHookV1}OrchestratorV3.t.sol`
- the five rows of the behavior table;
- after an opt-out on a windowed rail: whitelist-enabled rejects a non-member
  with `TakerNotWhitelisted`; whitelist-disabled admits openly with no dispute
  intent and no stake, including while `admissionsPaused` is set;
- explicit opt-in on a zero-window rail no longer bypasses an enabled
  whitelist;
- `admissionsPaused` blocks a non-whitelisted taker on an untouched windowed
  rail and does not block whitelisted takers or zero-window rails;
- a whitelisted taker on an untouched windowed rail is admitted unstaked
  even though the effective getter reports enabled;
- non-USDC deposit on an untouched windowed rail reverts
  `IntentTokenMismatch` for a non-whitelisted taker;
- the getter's no-validation precondition (nonexistent deposit on a windowed
  rail reads `true`) is asserted once, as documentation of the API contract.

`scripts/test-method-scoped-deployment.cjs`
- a configuration event after deployment leaves lane 37 `prepared`; a stake
  deposit or taker authorization after controller initialization leaves it
  `prepared` (`totalStaked > 0`, `totalClaimable == 0`); a stake deposit
  before controller initialization fails the prefix; a lifecycle, lock, or
  claim event fails it in either phase.

Rename tests whose names encode "opt-in" (`test_onIntentSignaledRequiresExplicitOptIn…`,
`test_isDisputeProtectionEnabledDefaultsFalse…`,
`test_DisputeProtectionOptInIsScopedToPaymentMethod`) to describe the new rule.
Coverage floors are global; keep them green.

## Documentation

- NatSpec on the contract title, storage, setter, getter, and
  `IDisputeProtectionPolicy` (replace "requires explicit depositor opt-in" /
  "Returns false until the depositor explicitly opts in" with the rail-aware
  rule).
- `IntentLifecycleHookV1` NatSpec: replace "opt-in stake-backed dispute
  protection … only after the depositor opts in", and delete the sentence
  "Non-disputable payment methods give every taker direct access … regardless
  of whitelist or dispute protection configuration" — it is already false for
  an untouched deposit with an enabled whitelist, and under this design a
  zero-window rail always leaves the whitelist as the gate.
- README dispute-protection section and the lane-37 paragraph; AGENTS.md
  wording that describes lane 37's stack as opt-in.
- `2026-08-27-method-scoped-policy-successor-lanes-design.md` gets a one-line
  pointer to this spec.

## Non-goals

- No change to `StakeVault`, `DisputeVerifier`, the dispute nullifier
  registry, `IntentLifecycleHookV1` logic, or `WhitelistPolicy`.
- No new deployment lane, no artifact, output, evidence, or manifest change.
- No indexer or curator code in this repository.
- No migration of predecessor policy or vault state on either network; the
  Base lane-34 `*OptIn` stack keeps opt-in semantics and the staging lane-32
  stack keeps its semantics until replaced.
