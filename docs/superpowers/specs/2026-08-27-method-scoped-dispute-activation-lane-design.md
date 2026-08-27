# Method-scoped dispute activation lane (lane 38)

Date: 2026-08-27
Status: design approved in chat (revoke-in-cutover confirmed); Claude +
Codex convergence ran 5 rounds (all findings accepted, none unresolved);
pending user spec review
Scope: a new deploy lane that activates the method-scoped dispute stack
deployed by lanes 36/37 — Base-staging EOA transitions and two unsigned Base
Safe batches with pinned fork simulation — plus mechanical gates that hold
**at execution time**, not only at generation time. Repo-side cutover
artifacts (manifest flip, evidence refresh, package alias, lane-37/38
pinning and retirement) are specified here but land in recording PRs.
Builds on: `2026-08-27-method-scoped-policy-successor-lanes-design.md`,
`2026-08-27-rail-aware-default-dispute-protection-design.md`,
`2026-08-20-immutable-production-deployment-lanes-design.md`; lane 34
(`deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts`, immutable, retired)
is the template for shape and safety posture.

## Goal

Move Base staging and Base from the currently active dispute stack to the
method-scoped stack (`DisputeProtectionPolicyMethodScoped` +
`IntentLifecycleHookV1MethodScoped` on the **reused** predecessor
`StakeVault`) with no stake migration, no stranded lock, and no script ever
signing, proposing, or executing a Safe transaction.

## Live baseline (read 2026-08-27; the lane re-reads everything)

| | Base | Base staging |
| --- | --- | --- |
| predecessor policy (`METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS`) | `DisputeProtectionPolicyOptIn` `0xcEc4…87aA`, owner = Safe `0x0bC2…0227`, `admissionsPaused == false` | lane-32 policy `0x2151…5020`, owner = deployer EOA `0x84e1…1929`, not paused |
| reused vault | `StakeVaultOptIn` `0x4d16…bCEB`, owner = Safe, controller = predecessor policy, `controllerChangeDelay` 172800 s, `totalStaked` ≈ 3.1 USDC | lane-32 vault `0xEc9f…8f43`, owner = deployer, controller = predecessor policy, drained (0 / 0) |
| orchestrator hook | `IntentLifecycleHookV1OptIn` | lane-32 hook `0x19D9…6e65` |
| dispute registry writers | `[predecessor policy]` | `[predecessor policy]` |
| predecessor intents | 3 opened / 2 cancelled / 1 `SETTLED` with a coverage lock maturing ~2026-09-08 (needs the permissionless release afterwards) | none |
| successor records | none yet (lanes 36/37 unexecuted) | none yet |

Both predecessor policy ABIs expose `setAdmissionsPaused`,
`acceptVaultController`, `getDisputeProtectionIntent`,
`releaseMaturedDisputeProtectionIntents` (permissionless), `admissionsPaused`,
and emit `DisputeProtectionIntentOpened(bytes32 indexed intentHash, …)`.
`DisputeProtectionIntentStatus` is `{NONE, PENDING, CANCELLED, SETTLED,
RELEASED, DISPUTED}`; `SETTLED` keeps a resized lock until the
permissionless release moves it to `RELEASED` (or a dispute moves it to
`DISPUTED`). `NullifierRegistry` and `OrchestratorV3` are plain `Ownable`;
`StakeVault`, `DisputeProtectionPolicy`, and `DisputeVerifier` are
`Ownable2Step`.

## Decisions

1. **One lane, complete state machine.** A lane is immutable after its first
   live execution (the first staging transition), so every transition and
   both Base batches are in the lane before any execution.
2. **Pause the predecessor before rotating the controller.** Lock operations
   are controller-only; a lock created between the controller proposal and
   `acceptController` would be stranded. Pausing admissions on the
   predecessor policy makes its live-lock set monotone non-increasing.
   Cancellation, settlement, release, and dispute submission stay available
   while paused, so existing intents drain normally.
3. **Revoke the predecessor's registry write permission in the cutover batch**
   (user decision, 2026-08-27). The batch runs only when the on-chain guard
   proves zero live predecessor locks; a dispute can only be filed on an
   intent with a live lock, and after rotation the predecessor policy cannot
   act on the vault at all, so it has no remaining legitimate write.
4. **Enumerable gates are enforced by the transaction that executes; the
   rest are re-verified minutes before it.** Each Base batch begins with a
   call to a purpose-built, immutable **guard contract** deployed for that
   batch with the expectations baked into its constructor; if any
   expectation no longer holds when the Safe executes, the first call
   reverts and `MultiSendCallOnly` reverts the whole batch. The guard binds
   everything that is readable on-chain with a bounded number of calls:
   ownership, pause, controller/pending state, writer set, hook, hook
   authorization of the fresh and predecessor hooks, risk windows, verifier
   dependencies, orchestrator pause state, the complete pinned predecessor
   intent set, `depositCounter`, and every pinned inventory tuple. Two
   properties are **not** on-chain enumerable and remain generation-time
   snapshots re-derived by the verify script immediately before execution:
   "only the fresh hook is authorized" (event history) and the depositor
   inventory's completeness against methods *added to existing deposits*
   after generation (the guard sees new deposits via `depositCounter`, not
   new methods on old ones). Both are stated as accepted races below. Only
   downstream readiness (indexer, curator, package) cannot be proven at all
   and stays a `CONFIRM_*` flag, as in lane 34.
5. **Lane 37 is retired before activation begins, and lane 38 is pinned after
   its first live transition.** Lane 37's `skip` asserts the pre-activation
   controller/hook/writer state, so it would abort every untagged run from
   the first staging transition onward. Lane 38 itself is executed only
   through its tag and refuses activation flags on untagged runs.
6. **One snapshot, one reducer.** A single `ActivationSnapshot` type is read
   from chain by one function; a single pure reducer returns the recognized
   Base phase, the recognized next staging action, and an explicit list of
   invariant violations. Batch builders and the staging executor consume the
   reducer's output; there are no parallel classifiers to drift apart.
7. **Nothing repo-side flips in this PR.** Manifest, predecessor map,
   evidence, package alias, and lane pinning/retirement change in recording
   PRs after each execution, exactly as PR #269/#270 did for lane 34.

## Lane 38: `deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts`

Supported networks: `base_staging`, `base`. On `localhost`/`hardhat` the
lane skips (lane 37 already activates the local stack; there is no
predecessor to rotate from); the rotation logic is exercised by an
in-process Hardhat rehearsal (Tests). A tagged localhost run throws
`no predecessor stack on local networks`.

Tags: `38_activate_method_scoped_dispute_lifecycle_stack`,
`V3DisputeMethodScopedActivation`. Dependencies: none (lane-16 hazard).
`deploy/deploy_summary.ts` gains both tags. The lane throws if any of its
`ENABLE_*`/`PREPARE_*` flags is set while `DEPLOY_ACTIVE_TAG` is not its
own tag (untagged runs must never activate), and skips silently otherwise.

### Shared preflight (`assertActivationSharedState(hre, network)`)

Every read uses an explicit `blockTag` (the pinned block on Base, the
latest block captured once per run on staging). Fails closed on drift:

- deployer identity, chain id 8453, `paymentBindingCutoverReady` (lane 31);
- lane-36 record `WhitelistPolicyMethodScoped` and lane-37 records
  `DisputeProtectionPolicyMethodScoped`, `IntentLifecycleHookV1MethodScoped`
  present and verified against chain with `assertDeploymentMatchesChain`;
- fresh policy: `stakeVault() == predecessorVault`, verifier/registry
  dependencies as pinned, `isLifecycleHookAuthorized(freshHook)`, only the
  fresh hook authorized (lane-37 event scan), risk windows equal
  `DISPUTE_RISK_WINDOW[network]` for `DISPUTABLE_PAYMENT_METHODS` and zero for
  every other active method of that network, `admissionsPaused == false`,
  no lifecycle event since deployment (lane-37 `classifyFreshStackActivity`);
- fresh hook: `orchestratorRegistry`, `whitelistPolicy ==
  WhitelistPolicyMethodScoped`, `disputeProtectionPolicy == freshPolicy`;
- predecessor stack per `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS[network]`
  via `assertHistoricalDisputeStack`; vault `owner == governance` with
  `pendingOwner == 0`, `controllerChangeDelay == 172800`, `stakeToken == USDC`;
- registry `owner == governance`; orchestrator `owner == governance`,
  registered, not paused, protocol fee 0 and recipient as pinned (lane-34
  parity); `MultiAttestationVerifier` witness set as pinned;
- governance = `MULTI_SIG[network] || deployer` (Safe on Base, deployer on
  staging).

### Snapshot and reducer (pure, exported)

`ActivationSnapshot` fields (all read at one `blockTag`): `network`,
`freshPolicy.{owner, pendingOwner, admissionsPaused, disputeVerifier,
freshHookAuthorized, predecessorHookAuthorized, riskWindows[]}`,
`predecessorPolicy.{owner, pendingOwner, admissionsPaused}`,
`predecessorPolicy.disputeVerifier`, `disputeVerifier.{owner, pendingOwner,
attestationVerifier, nullifierRegistry}`, `vault.{controller,
pendingController, pendingControllerValidAt, owner, pendingOwner}`,
`registry.{owner, writers}`, `orchestrator.{hook, paused, owner,
escrowRegistry, paymentVerifierRegistry, relayerRegistry, protocolFee,
protocolFeeRecipient, allowMultipleIntents, registeredInOrchestratorRegistry}`,
`freshHook.{orchestratorRegistry, whitelistPolicy, disputeProtectionPolicy}`,
`whitelistPolicy.{owner, escrowRegistry, groupRegistry, orchestratorRegistry}`,
`attestationVerifier.{owner, requiredSignatures, witnesses[]}`,
`blockTimestamp`, and the lock proof and inventory as `{ok, detail}` values
where `detail` distinguishes `pending`, `settled-unmatured`,
`settled-matured` (releasable), and `terminal` intents. Every one of these
is a governance-mutable trust input; the reducer treats any deviation from
the pinned `EXPECTED_LIVE` / `DISPUTE_RISK_WINDOW` values as a violation,
and both guards bind the same fields at execution (below).

Every governance-owned `Ownable2Step` component — fresh policy,
predecessor policy, reused vault, `DisputeVerifier` — must read
`owner == governance` and `pendingOwner == 0` in every recognized state,
with the single documented exception of the fresh policy on Base in
`deployed`, where `owner == deployer && pendingOwner == Safe` (lane 37's
handover) is also recognized and is what batch 1 accepts.

`reduceActivation(snapshot)` returns `{ phase, nextStagingAction, waiting,
violations }` where

**Base phases** (`phase`):

| Phase | Condition |
| --- | --- |
| `deployed` | vault: controller == predecessor policy, pendingController == 0, owner == Safe, pendingOwner == 0; predecessor not paused; writers == [predecessor]; hook == predecessor hook; fresh policy either owner == Safe with pendingOwner == 0, **or** owner == deployer with pendingOwner == Safe |
| `rotation-proposed` | fresh policy owner == Safe, pendingOwner == 0; predecessor paused; vault pendingController == fresh policy with `validAt > 0`, controller still predecessor; writers == [predecessor]; hook == predecessor hook |
| `active` | vault controller == fresh policy, pendingController == 0, owner == Safe, pendingOwner == 0; fresh policy owner == Safe, pendingOwner == 0; writers == [fresh policy]; hook == fresh hook |
| `unrecognized` | anything else — every violated invariant is listed (stale proposal to a foreign address, a foreign pending owner anywhere, writer set of size 2, controller rotated but hook not swapped, …) |

On Base the lane acts only on `deployed` (rotation preparation) and
`rotation-proposed` (cutover preparation); `unrecognized` fails closed with
the violation list.

**Staging next action** (`nextStagingAction`, governance = deployer, so
ownership is never pending):

| # | action | recognized state | transaction |
| --- | --- | --- | --- |
| 1 | `pause-predecessor-admissions` | `deployed` | `predecessorPolicy.setAdmissionsPaused(true)` |
| 2 | `propose-controller` | predecessor paused, controller == predecessor, pendingController == 0, writers == [predecessor], hook == predecessor | `vault.proposeController(freshPolicy)` |
| 3 | `release-matured-predecessor-intents` | pendingController == fresh; the lock proof reports at least one `settled-matured` intent | `predecessorPolicy.releaseMaturedDisputeProtectionIntents(hashes)` (permissionless; repeatable; also offered on Base as a deployer-EOA helper, see below) |
| 4 | `accept-vault-controller` | pendingController == fresh, `now >= validAt`, predecessor paused, lock proof ok, inventory ok | `freshPolicy.acceptVaultController()` |
| w | *(no action, recognized)* | pendingController == fresh and (`now < validAt` → `waiting = "controller-delay"`, or lock proof has `pending` / `settled-unmatured` intents and none releasable → `waiting = "predecessor-drain"`) | none; the run reports the wait reason and the earliest timestamp that could change it |
| 5 | `add-fresh-writer` | controller == fresh, pendingController == 0, writers == [predecessor], hook == predecessor | `registry.addWritePermission(freshPolicy)` |
| 6 | `set-fresh-hook` | writers == [predecessor, fresh], hook == predecessor | `orchestrator.setLifecycleHook(freshHook)` |
| 7 | `remove-predecessor-writer` | hook == fresh, writers == [predecessor, fresh] | `registry.removeWritePermission(predecessorPolicy)` |
| — | `null` | `active` | — |

Any other combination is `unrecognized` and throws with the violation
list. Waiting states are recognized, not violations: a staging run that
lands in one exits 0 with the reason, and the post-send "advanced exactly
one step" check accepts a transition into a waiting state (e.g. step 2 →
`waiting: controller-delay`). Steps 5–7 are intentionally invalid Base
phases; the reducer keys the staging table on `network === "base_staging"`
so the two tables cannot be confused. The same waiting states gate the
Base cutover preparation (it refuses to generate while waiting).

### Base: two unsigned Safe batches, each guarded on-chain

Contracts under `contracts/mocks/` (deployed by the deployer EOA at
generation time on Base; their addresses and constructor arguments are
recorded in the sidecar; they hold no funds and no privileges):

- `DisputeMethodScopedRotationGuard(expected…)` — `assertReady()` reverts
  unless: vault controller == predecessor policy, pendingController == 0,
  vault owner == Safe, pendingOwner == 0; predecessor policy not paused,
  owner == Safe, pendingOwner == 0; `DisputeVerifier` owner == Safe,
  pendingOwner == 0; writers == [predecessor]; hook == predecessor hook;
  orchestrator not paused; fresh policy exactly in the ownership state the
  batch was built for (`owner == deployer && pendingOwner == Safe` when the
  batch includes `acceptOwnership`, else `owner == Safe && pendingOwner ==
  0`); fresh policy `stakeVault() == vault`, `disputeVerifier() == pinned`,
  `isLifecycleHookAuthorized(freshHook)`,
  `!isLifecycleHookAuthorized(predecessorHook)`, `admissionsPaused() ==
  false`, per-method risk windows == pinned; **trust surface** (identical
  in both guards): registry `owner == Safe`; orchestrator `owner == Safe`,
  `escrowRegistry` / `paymentVerifierRegistry` / `relayerRegistry` ==
  pinned, `protocolFee == 0`, `protocolFeeRecipient == pinned`,
  `allowMultipleIntents == false`, `OrchestratorRegistry.isOrchestrator(orchestrator)`;
  fresh hook `orchestratorRegistry` / `whitelistPolicy` /
  `disputeProtectionPolicy` == pinned; `WhitelistPolicyMethodScoped` `owner
  == Safe` and `escrowRegistry` / `groupRegistry` / `orchestratorRegistry`
  == pinned; `MultiAttestationVerifier` `owner == Safe`,
  `requiredSignatures == 1`, `witnesses()` == pinned array in order;
  predecessor policy `disputeVerifier() == pinned`.
- `DisputeMethodScopedCutoverGuard(expected…)` — `assertReady()` reverts
  unless: vault pendingController == fresh policy and `block.timestamp >=
  pendingControllerValidAt`; controller still predecessor; vault owner ==
  Safe, pendingOwner == 0; predecessor `admissionsPaused() == true`, owner
  == Safe, pendingOwner == 0; `DisputeVerifier` owner == Safe, pendingOwner
  == 0, `attestationVerifier()` and `nullifierRegistry()` == pinned;
  writers == [predecessor]; hook == predecessor hook; orchestrator not
  paused; fresh policy owner == Safe, pendingOwner == 0,
  `admissionsPaused() == false`, `disputeVerifier() == pinned`,
  `isLifecycleHookAuthorized(freshHook)`,
  `!isLifecycleHookAuthorized(predecessorHook)`, per-method risk windows ==
  pinned; the same **trust surface** as the rotation guard; **for every
  predecessor intent hash pinned at generation** (the complete enumerated
  set — admissions were paused in batch 1, so it cannot grow):
  `predecessorPolicy.getDisputeProtectionIntent(h).status ∈ {CANCELLED,
  RELEASED, DISPUTED}` and `vault.locks(h).amount == 0`;
  `escrow.depositCounter() == pinnedCounter` for the canonical `EscrowV2`;
  **for every inventory tuple pinned at generation**:
  `successorPolicy.isDisputeProtectionEnabled(escrow, id, method) == false`.
  Not bindable on-chain and therefore **accepted races**, re-derived by the
  verify script immediately before execution and requiring regeneration if
  changed: (a) "only the fresh hook is authorized" beyond the two named
  hooks (event history); (b) inventory tuples that arise from a payment
  method **added to an existing deposit** or from a predecessor opt-out
  emitted after generation — the deployed opt-in predecessor cannot expose
  "explicit false" to a contract, and enumerating every deposit's method
  list on-chain is unbounded. Predecessor-choice preservation is therefore
  defined as of the cutover generation block; a depositor who changes their
  mind afterwards exercises the same setter on the successor policy, which
  is live from lane-37 deployment onward.
- `DisputeMethodScopedRotationPostcondition` / `…CutoverPostcondition` —
  simulation-only, appended after the batch in the fork like lane 34's;
  assert the resulting state (see below). Never persisted in the batch.

**Batch 1 — rotation** (`ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_ROTATION_PREPARATION=true`,
reducer phase `deployed`), ordered:

1. `rotationGuard.assertReady()`;
2. `freshPolicy.acceptOwnership()` — only if `pendingOwner == Safe`; omitted
   if the Safe already owns it; any other state is `unrecognized`;
3. `predecessorPolicy.setAdmissionsPaused(true)`;
4. `vault.proposeController(freshPolicy)`.

Rotation postcondition: fresh policy owner == Safe, pendingOwner == 0;
predecessor paused; vault pendingController == fresh policy,
`pendingControllerValidAt >= simulationTimestamp + 172800`, controller ==
predecessor, owner == Safe, pendingOwner == 0; writers == [predecessor];
hook == predecessor hook.

**Batch 2 — cutover** (`ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_CUTOVER_PREPARATION=true`,
reducer phase `rotation-proposed`, timing/lock/inventory proofs passing at
the pinned block), ordered:

1. `cutoverGuard.assertReady()`;
2. `freshPolicy.acceptVaultController()`;
3. `registry.addWritePermission(freshPolicy)`;
4. `registry.removeWritePermission(predecessorPolicy)`;
5. `orchestrator.setLifecycleHook(freshHook)`.

Cutover postcondition: vault controller == fresh policy, pendingController
== 0, owner == Safe, pendingOwner == 0; fresh policy owner == Safe,
pendingOwner == 0, `admissionsPaused == false`,
`isLifecycleHookAuthorized(freshHook)`; writers == [fresh policy]; hook ==
fresh hook; per-method risk windows as pinned; the trust surface unchanged
(same fields as the guards). No vault-emptiness assertion — the vault is
live. Both postconditions re-assert the trust surface so the simulation
also fails on a stale generation.

Artifact discipline follows lane 34: `Safe.nonce()` from the contract, Safe
v1.3.0 + `MultiSendCallOnly` runtime-hash pins, clean git +
`CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_RELEASE_READY_SHA == HEAD`,
`BASE_FORK_RPC_URL`, child-process pinned fork simulation of
`batch ‖ postcondition` through `Safe.simulateAndRevert(MultiSendCallOnly,
multiSend(…))`. Guard chronology is explicitly two-block: (1) read the
snapshot, lock proof, and inventory at a **proof block** P; (2) deploy the
guard from the deployer EOA with those pinned expectations; (3) capture a
**simulation block** S > P that contains the guard deployment; (4) re-read
every guard expectation at S and require it to equal the P values (else
regenerate); (5) pin S's number and hash in the manifest and fork S for
the simulation, so the guard exists in the forked state. The sidecar
records both P and S. Artifacts: `deployments/outputs/safe-batches/base_method_scoped_rotation.json`
+ `.sha256.json`, `…/base_method_scoped_cutover.json` + `.sha256.json`.
`meta.name` = `ZKP2P method-scoped dispute rotation - base` /
`ZKP2P method-scoped dispute cutover - base`; `meta.description` lists the
exact calls; `txBuilderVersion 1.16.5`; `createdFromSafeAddress = BASE_SAFE`.

**Sidecar manifest v2** (`deployments/activationBatchManifest.ts`, new;
`safeBatchManifest.ts` is left unchanged for lane-34 tooling): the v1
fields plus `guard: {address, constructorArgs, deployTransactionHash,
runtimeCodeHash}`, `lockProof: {fromBlock, toBlock, intentHashes[],
statuses[]}`, `inventory: {escrow, depositCounter, tuples[], sourceBlock}`,
`postcondition: {address, constructorArgs, deployTransactionHash,
runtimeCodeHash}` (identified exactly like the guard, so a wrong or no-op
contract cannot stand in for it), `proofBlock: {number, hash}`; `manifestSha256`
covers the canonical JSON of **all** of these, and the verifier recomputes
it. Refresh semantics: if a pair already exists and differs, the existing
pair is moved to `…/superseded/<name>_<simulationBlock>_<manifestSha256[0:12]>.json`
(both files, so repeated regenerations at one block cannot collide) and the
new pair is installed crash-safely: write both new files under a staging
name and `fsync` each; rename the archived pair into `superseded/`; rename
the new sidecar first and the new batch second; `fsync` the parent
directory after the archive renames and again after the canonical renames;
a verifier that finds a batch whose sidecar digest does not match treats
the pair as incomplete and refuses it. A batch is expected to be generated
inside the execution window; the guard, not the artifact's age, is what
makes stale execution of the enumerable invariants impossible, and the
pre-execution verify run is what covers the two accepted races.

**Pre-execution verifier** (`scripts/verify-method-scoped-safe-batch.ts`,
`yarn verify:method-scoped-safe-batch --batch rotation|cutover [--mode
generation|artifact-child]`; the lane's own generation path runs it in
`generation` mode before writing artifacts). It is **mandatory immediately
before the Safe transaction is executed** (a run at import time does not
count; the runbook requires a fresh run within the same operator session as
the execution signature, with its output hash and verification block
recorded next to the Safe transaction hash). It narrows the two accepted
races to the verifier-to-execution window; it does not close them.
**Residual race, explicitly accepted:** between the verification block and
the block that executes the Safe transaction, a depositor or delegate can
still add a payment method to an existing deposit or change a
protection setting on either policy. The guard catches every enumerable
effect (new deposits, pinned tuples, pinned intents, trust surface); a
tuple that comes into existence only in that window is missed, and its
effect is bounded: a non-whitelisted taker on that tuple is routed
through stake-backed protection (or reverts `IntentTokenMismatch` on a
non-stake-token deposit) until the depositor opts out, with the setter
live. There is no on-chain configuration nonce on the deployed contracts
that could bind this without a contract change, which is out of scope. At one
freshly captured current block it must: validate the canonical pair
(deterministic paths, sidecar digest, manifest schema v2, meta strings);
require live `Safe.nonce()` == manifest; **independently** prove the
guard's and the postcondition's identity — fetch each recorded deployment
transaction, require a successful receipt whose `contractAddress` equals
the manifest address, require the transaction's initcode to equal the
compiled artifact's creation bytecode concatenated with constructor
arguments the verifier derives itself from the pinned expectations (not
copied from the manifest), and require the live runtime code hash to equal
that artifact's expected runtime — so an artifact-only child cannot swap
in a no-op deployment and recompute the digest; re-derive the
snapshot, lock proof, and inventory and require them equal to the pinned
values (this detects drift through the verification block — a method
added to an existing deposit, a late predecessor opt-out, or an extra
authorized hook all change the derived state and fail here — and narrows,
but does not close, the residual window described below); re-run the pinned fork
simulation of batch ‖ postcondition; and in `artifact-child` mode require
the recorded source SHA to be an ancestor of `HEAD` with only the artifact
pair changed since. Any failure means "regenerate"; it never repairs.
Tested failure modes: nonce drift, guard code/args drift, each re-derived
state class drifting, sidecar/batch digest mismatch, simulation revert.

Confirmations for either Base preparation:
`CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_ACTIVATION=true` and
`CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_DOWNSTREAM_READY=true`. No
`PREDECESSOR_DRAINED` confirmation: the guard proves it.

Deployer-EOA helper on Base (`ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_RELEASE_MATURED=true`,
tag-scoped): calls `predecessorPolicy.releaseMaturedDisputeProtectionIntents`
for `SETTLED` intents whose maturity has passed. It is permissionless on the
policy, moves only the depositor's own coverage state to `RELEASED`, and
exists so the cutover proof can pass without waiting for a third party.

### Proofs (pure functions over pinned-block reads; exported)

- **Lock proof** (`proveNoLivePredecessorLocks`): enumerate
  `DisputeProtectionIntentOpened` on the predecessor policy from its
  record's `receipt.blockNumber` to the pinned block with topic-filtered,
  ≤10 000-block `getLogs` pages; for each intent hash read
  `getDisputeProtectionIntent(h).status` and `vault.locks(h)` at the pinned
  block. Pass iff every status ∈ {`CANCELLED`, `RELEASED`, `DISPUTED`} and
  every lock amount is 0. `NONE`, `PENDING`, and `SETTLED` fail, naming the
  hash, status, and (for `SETTLED`) the lock's maturity so the operator
  knows whether to run the release helper or wait. The full hash list is
  pinned into the cutover guard.
- **Depositor inventory** (`buildDepositorInventory`), over the canonical
  `EscrowV2` only (the pinned `EXPECTED_LIVE` escrow; configuration events
  for any other escrow address are ignored — the policy setter accepts
  arbitrary escrows, so a global replay would be poisonable):
  1. **extant deposits** = ids in `[0, depositCounter)` with
     `getDeposit(id).depositor != 0` (closed deposits are deleted;
     `acceptingIntents` is irrelevant because it can be re-enabled);
  2. **listed windowed methods** of a deposit = its listed payment methods
     (active or not — an inactive method can be reactivated) whose
     successor risk window is nonzero;
  3. set A: extant deposits whose latest predecessor
     `DisputeProtectionEnabledUpdated` (filtered by the canonical escrow
     topic; ordered by block, tx index, log index) requested `false` —
     expanded to every listed windowed method of that deposit, **minus any
     tuple whose latest successor `DisputeProtectionEnabledUpdated` is
     newer than the deposit's latest predecessor event** — ordering is
     cross-policy by `(blockNumber, transactionIndex, logIndex)` (same
     canonical-escrow topic filter on both policies). The newer explicit
     choice wins regardless of which policy carries it and whether it is
     `true` or `false`: a successor `true` at block 100 followed by a
     predecessor `false` at block 110 keeps the tuple in A (the opt-out is
     newer); a predecessor `false` followed by a successor `true` removes
     it. A depositor who opted out on the predecessor and later opted a rail
     back in on the successor is therefore respected, not blocked;
  4. set B: extant deposits with `token != stakeToken` — expanded to every
     listed windowed method; this set is **not** overridden by a successor
     `true` (an explicit opt-in cannot make a non-stake-token deposit
     admissible; its non-whitelisted takers would revert
     `IntentTokenMismatch`), so it stays forced to `false`;
  5. every tuple in A ∪ B must read `successorPolicy.isDisputeProtectionEnabled(escrow,
     id, method) == false` (only windowed methods are considered, so `false`
     means an explicit opt-out). Successor events are replayed only for
     the canonical escrow topic and only to compute the A exclusion; the
     gate itself is the getter.
  The tuples, counts, `depositCounter`, and block are pinned into the
  cutover guard and the sidecar. Today A and B are empty on Base; the gate
  runs regardless.

### Base staging execution

Flags: `PREPARE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION=true` (read-only
preflight of the next action) or
`ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION=true` (execute exactly
one), mutually exclusive; plus
`CONFIRM_STAGING_V3_DISPUTE_METHOD_SCOPED_{ACTIVATION,DOWNSTREAM_READY}`.
Execution follows lane 34 verbatim: preflight (`eth_call`, `estimateGas`,
balance, fee data), prepare-only return, re-read + byte-identical
transaction check + nonce stability, send, `waitForDeploymentDelay`, then
require the reducer's next action advanced by exactly one step. The staging
predecessor vault is drained and its policy has no intents, so steps 3–4's
proofs pass trivially there, but they run.

### After activation

`skip` returns `true` when the reducer reports `active` and the cutover
postcondition-equivalent checks pass; `false` when the lane has work under
its tag and flags; throws on `unrecognized`. It never re-runs a completed
transition.

## Repo-side sequencing (recording PRs, not this PR)

1. After lanes 36/37 execute deploy-only on a network: record the artifacts,
   **pin and retire lane 37** (`activeSource: null`, both tags rejected);
   lane 36 stays mounted (its `skip` is unaffected by activation).
2. After lane 38's first live transition (staging step 1): pin lane 38 with
   `retired: false` so it stays mounted for the remaining transitions.
3. After Base staging reaches `active`: `active-dispute-stack.json`
   `base_staging` → `DisputeProtectionPolicyMethodScoped` /
   `IntentLifecycleHookV1MethodScoped` / `StakeVault` (the lane-32 staging
   record = the reused vault); evidence refreshed; outputs re-canonicalized.
4. After Base reaches `active`: `active-dispute-stack.json` `base` policy/hook
   → `*MethodScoped`, `StakeVault` stays `StakeVaultOptIn`;
   `PREDECESSOR_DISPUTE_STACKS.base` → the lane-34 `*OptIn` trio with
   `activeLifecycleHook = IntentLifecycleHookV1OptIn`;
   `dispute-stack-evidence.json` refreshed (recognized predecessor,
   deployment evidence, runtime hashes, per-rail sentinel); the fresh hook
   gets a pinned runtime hash so `findPinnedLifecycleHookRuntimeHash` covers
   it; canonical `WhitelistPolicy` package key aliased to
   `WhitelistPolicyMethodScoped` (4th canonical name; manifest re-stamp);
   lane 38 retired; package published per `zkp2p-contracts-publish`.

## Tests

`scripts/test-method-scoped-activation.cjs` (`node:test`, offline, fake HRE):
- `reduceActivation`: every row of both tables; every `unrecognized` case
  listed above produces the expected violations; the staging table is
  unreachable when `network === "base"` and vice versa;
- batch builders: exact order, targets, selectors, calldata; guard call
  first; ownership acceptance omitted when the Safe already owns the policy;
- `proveNoLivePredecessorLocks` over fake logs/reads: passes only with
  `{CANCELLED, RELEASED, DISPUTED}` and zero locks; fails naming a `PENDING`
  intent and a `SETTLED` intent with amount > 0 and its maturity;
- `buildDepositorInventory`: extant-deposit definition, inactive-but-listed
  windowed method included, foreign-escrow events ignored, latest-event
  ordering; cross-policy ordering in both directions (successor `true`
  newer than predecessor `false` removes the tuple from A; predecessor
  `false` newer than successor `true` keeps it); a set-B tuple stays forced;
  successor `false` satisfies / `true` (without a newer successor event)
  fails listing tuples;
- verifier identity proof: initcode == artifact creation bytecode ‖
  independently derived constructor args, receipt `contractAddress`,
  runtime hash — for both the guard and the postcondition; a no-op
  replacement with a recomputed digest is rejected;
- waiting states: `controller-delay` and `predecessor-drain` are
  recognized with the right earliest-change timestamp; post-send advance
  check accepts step 2 → `controller-delay`; the release action is
  repeatable while `settled-matured` intents exist and absent otherwise;
- flags: mutual exclusion, activation flags on an untagged run throw,
  missing `CONFIRM_*` throws in order, tagged localhost run throws;
- verify-script inventory re-derivation: a method added to an existing
  deposit and a late predecessor opt-out both change the derived tuple set
  and fail verification (regeneration required), while the guard alone
  would not have caught them — documenting the accepted race;
- manifest v2: digest covers guard/lockProof/inventory/postcondition;
  tamper detection; refresh archives the previous pair;
- verifier: every failure mode listed in the verifier section, with the
  `--batch rotation|cutover` selection and both modes;
- lane identity, tags, no dependencies, `deploy_summary` tags, immutable
  manifest untouched.

`scripts/test-method-scoped-activation-rehearsal.cjs` (in-process Hardhat,
like `test-v3-groups-base-deployment.cjs`): deploy `USDCMock`, `StakeVault`,
two `DisputeProtectionPolicy` instances, `NullifierRegistry`, a minimal
orchestrator stub, initialize the vault to the predecessor policy, open one
intent and settle it through the predecessor policy. Then, with a fake HRE
bound to the in-process network and snapshots between stages:
1. staging path: step 1 and 2 execute; step 4 is refused while the settled
   intent's lock is live; advance time past maturity, run step 3 (release),
   then steps 4–7 complete and the reducer reports `active`;
2. Base path from a fresh snapshot: build batch 1, deploy the rotation
   guard, execute guard+batch through the stub Safe path, assert the
   rotation postcondition; advance time, drain, build batch 2, deploy the
   cutover guard, prove that a new deposit (counter change) or a live lock
   makes `assertReady()` revert, then execute and assert the cutover
   postcondition.

`scripts/test-method-scoped-runner.cjs` (runner-level, stubbed spawn like
lane 34's): an untagged `deployActive` run with a pending controller and
lane 37 retired mounts lane 38 and not lane 37; lane 38 with activation
flags but no tag throws before spawn.

`test-foundry/deterministic/mocks/DisputeMethodScopedActivation.t.sol`: each
guard and postcondition contract passes on the intended state and reverts
on each **single** deviation of every bound field (ownership and pending
owner of each component, pause flags, controller/pending/validAt, writer
set, hook, hook authorizations, each risk window, verifier dependencies,
orchestrator pause, a new deposit, a live lock, a non-opted-out inventory
tuple).

Localhost gate: `yarn deploy:localhost` still ends with lane 38 skipping;
a tagged lane-38 run on localhost throws the "no predecessor stack" error.

## Documentation

AGENTS.md (lane 38 bullet: tag-only execution, flags, two guarded batches,
pause-before-rotate, retire-37-first sequencing, scripts never sign), README
lane section, CLAUDE.md lane list, pointer from the successor-lanes spec.

## Non-goals

- No Solidity change outside `contracts/mocks/` (guards and postconditions).
- No execution: the lane never signs, proposes, or executes a Safe
  transaction; staging transitions execute only under the explicit
  `ENABLE_*` flag, one per run, tagged.
- No manifest, predecessor-map, evidence, package, or lane-37/38 pinning
  change in this PR.
- No indexer or curator code.
