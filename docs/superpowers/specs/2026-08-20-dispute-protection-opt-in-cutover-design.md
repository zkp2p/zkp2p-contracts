# Dispute protection opt-in successor cutover

Date: 2026-08-20
Status: implementation complete, verification in progress
Scope: contracts behavior, successor deployment lane, protected package
publication, and the required indexer hard cut
Supersedes: `2026-08-08-dispute-opt-out-design.md`
Review: external Claude convergence produced no review text after three required
attempts; no external feedback was available to incorporate

## Goal

Reverse the default introduced by contracts PR #257. Stake-backed dispute
protection must be deposit-scoped and opt-in: an untouched deposit is not
protected, and only its depositor can enable protection explicitly.

The change must also replace the already-deployed default-on dispute stack with
a fresh successor stack on Base staging and Base. Deployment is passive and
independent of governance activation. After both deployments have produced real
reviewed artifacts, publish a new protected `@zkp2p/contracts-v2` version and
hard-cut the indexer behavior and both network address sets to the replacement
stack.

## Non-goals

- Do not change the public dispute-protection setter, getter, event, or ABI.
- Do not migrate a deposit's old policy configuration to the replacement
  policy. Every deposit starts disabled on the fresh policy.
- Do not migrate stake balances. Both predecessor vaults were empty when this
  design was approved; every deployment or activation run must prove that
  condition again.
- Do not deploy a new `DisputeVerifier` or `DisputeNullifierRegistry` on Base
  staging or Base. A fresh localhost/Hardhat deployment creates local-only
  instances because no live dependency can be reused there.
- Do not execute a Base Safe transaction from a deployment script.
- Do not infer activation from source, artifacts, package data, or an unsigned
  Safe batch.
- Do not publish locally, choose a package version in advance, or bypass the
  protected trusted-publisher workflow.
- Do not change Curator behavior in this scope. Before activation, Curator must
  consume the new package and addresses while continuing to fail closed against
  the still-active predecessor hook. Its exact `Canonical` state is a
  post-activation condition.

## Approved live-state baseline

The implementation must re-read all state before acting. At approval time:

- Base OrchestratorV3 uses `WhitelistLifecycleHook` at
  `0x251d78fb6bBb4071995Bce74bAfC9E4168638622`.
- Base's prepared default-on `IntentLifecycleHookV1` at
  `0x5B0017FCA6A2131701ef718e470a3930c1b6C12c` is passive.
- Base staging OrchestratorV3 uses the pinned predecessor lifecycle hook at
  `0xE8Fe714f848fAf7ecff7960AfD0C395771C22AA1`. The old default-on
  `IntentLifecycleHookV1` at `0x19D9F0Fcb08C60D8bd0CD061C34eae27eF8b6e65`
  remains separate predecessor evidence and is not the active hook.
- The Base and Base-staging predecessor `StakeVault` contracts report zero
  `totalStaked` and zero `totalClaimable`.
- The Base `DisputeNullifierRegistry` is already Safe-owned. The predecessor
  policy is its current sole intended dispute writer.
- The Base predecessor verifier, vault, and policy have pending ownership
  transfers used by the obsolete unsigned activation batch.
- The package manifest is `0.4.1-rc.2`. This is context only; release discovery
  determines the actual next publishable version after deployment.

Any drift invalidates this baseline and must be handled by the lane's explicit
state machine, not by weakening a check.

## Contract behavior

`DisputeProtectionPolicy` returns to a direct per-deposit enabled mapping:

```solidity
mapping(address => mapping(uint256 => bool)) internal isDepositDisputeProtectionEnabled;
```

The existing external surface retains its exact semantics and shape:

- `setDisputeProtectionEnabled(escrow, depositId, true)` writes `true` and
  emits `DisputeProtectionEnabledUpdated(..., true)`.
- Passing `false` writes `false` and emits the same event with `false`.
- `isDisputeProtectionEnabled` returns the stored value. Untouched and
  nonexistent deposits therefore return `false`.
- `_validateIntentAdmission` reverts `DisputeProtectionNotEnabled` unless the
  stored value is `true`.

The ABI must remain byte-for-byte unchanged. NatSpec and contract prose must
state opt-in behavior without compatibility aliases or a tri-state default.

### Admission matrix

The fresh `IntentLifecycleHookV1` keeps the existing whitelist-first ordering.
The rows below are authoritative for future intents.

| Whitelist | Taker | Protection | Risk window | Result |
| --- | --- | --- | --- | --- |
| enabled | allowed | any | any | direct admission, no stake |
| enabled | not allowed | disabled/default | any | revert `TakerNotWhitelisted` |
| enabled | not allowed | enabled | nonzero | stake-backed admission |
| disabled | any | disabled/default | any | direct admission, no stake |
| disabled | any | enabled | nonzero | stake-backed admission |
| any | non-whitelisted route | enabled | zero | existing direct pass-through |

The `riskWindow == 0` pass-through remains deliberately unchanged. Governance
must configure a nonzero risk window before relying on dispute protection for a
payment method.

## Successor deployment architecture

### Lane ownership

Lane 32 is historical predecessor state. Lane 34 is the only current-tree lane
allowed to create or prepare activation of the opt-in dispute stack.

Lane 34 is used because lane 33 was assigned to the IntentGuardian fee update
on `main` after this design was approved.

Changing the policy source means lane 32 cannot compare the deployed
default-on policy against the current compiled artifact. On Base and Base
staging it must recognize only pinned predecessor addresses and runtime hashes,
report the lane as superseded, and leave all state untouched. On localhost and
Hardhat, lane 34 supplies the final current stack; lane 32 must not deploy a
second current-policy stack first.

Lane 34 uses versioned internal deployment records so it never overwrites the
predecessor evidence:

- `StakeVaultOptIn`
- `DisputeProtectionPolicyOptIn`
- `IntentLifecycleHookV1OptIn`

Each record points at the canonical Solidity artifact. One checked-in
`deployments/active-dispute-stack.json` manifest maps each environment's
canonical public key to its active internal deployment record. Before the real
successor deployment, Base-staging and Base entries continue to point at the
predecessor canonical records. The deployment commit changes them to the three
opt-in records only after those records exist.

Public package exports remain `StakeVault`, `DisputeProtectionPolicy`, and
`IntentLifecycleHookV1`. The deployment-output generator, address extractor,
network ABI extractor, release verifier, and installed-package smoke test all
consume the same alias manifest. They must not expose `*OptIn` keys publicly.
Canonicalized deployment outputs carry a deterministic manifest-selection hash
so those consumers can distinguish an already-canonicalized current output from
an unstamped or stale predecessor output without exposing internal record names.
The historical canonical deployment JSON remains unchanged as predecessor
evidence.

### Reused and fresh components

On Base staging and Base, lane 34 reuses the network's exact deployed:

- `DisputeVerifier`
- `DisputeNullifierRegistry`
- `OrchestratorRegistry`
- `WhitelistPolicy`
- `OrchestratorV3`

It deploys a fresh:

- `StakeVault`, initially empty and controlled by the fresh policy;
- `DisputeProtectionPolicy`, pointing at the fresh vault and reused verifier
  and dispute registry;
- `IntentLifecycleHookV1`, pointing at the existing orchestrator registry and
  whitelist policy plus the fresh dispute policy.

On a fresh localhost or Hardhat deployment, lane 34 also deploys the local-only
`DisputeNullifierRegistry` and `DisputeVerifier` dependencies that lane 32
previously supplied. Local deployment tests start from an empty deployment
database and may not rely on warm lane-32 artifacts.

Before ownership transfer, the approved deployer configures the new policy's
exact risk windows and authorizes only the new hook. The deployment run proves
constructor dependencies, runtime bytecode, controller wiring, risk windows,
writer state, ownership state, and empty accounting.

## Deployment and activation phases

### Phase 1: deploy-only

Deploy-only is a complete, independently successful outcome:

1. Verify the exact predecessor and shared dependencies.
2. Deploy and configure the fresh trio.
3. Persist the three real versioned deployment records.
4. Initiate the required fresh-contract ownership transfers.
5. On Base only, cancel the predecessor policy and vault pending ownership
   transfers that the obsolete Base batch atomically requires, after asserting
   their exact before-state and then their cleared after-state.
6. Leave OrchestratorV3 on its current hook.

The new policy does not need dispute-registry writer permission to deploy.
Granting permission and changing the Orchestrator hook are activation actions,
not deployment prerequisites. A deploy-only run must never say the stack is
active or downstream-ready.

Canceling the two predecessor pending transfers makes the obsolete atomic Safe
batch revert before its hook-change call. The file is moved to a clearly
superseded location or removed from the active batch directory. Tests must
decode the old batch and prove its full atomic execution now reverts. This is
the operational invalidation available before a new Safe nonce is consumed.

### Phase 2: downstream propagation and governance preparation

After deploy-only addresses are reviewed:

1. Update address consumers with the exact fresh addresses.
2. Prove the predecessor is drained and downstream consumers are ready.
3. Re-read governance ownership, current hook, writer set, balances, and runtime
   hashes.

#### Base-only Safe preparation

1. Read the Safe contract's `nonce()`; do not substitute an account transaction
   count.
2. Generate an unsigned activation batch from the exact common and Safe reads.
3. Simulate the complete batch atomically and commit its reproducibility
   manifest.

The sidecar manifest records chain ID, Safe address, `Safe.nonce()`, source SHA,
simulation block number and hash, simulation result, and the ordered normalized
transactions. The hash input is the UTF-8 JSON serialization with no whitespace
of an array whose object keys are exactly `to`, `value`, `data`, `operation` in
that order; addresses and calldata are lowercase hex, `value` is a decimal
string, and `operation` is an integer. The recorded SHA-256 covers exactly those
bytes. Tests reconstruct the bytes and reject any changed target, order, value,
calldata, operation, or metadata/source mismatch.

Generating a batch does not authorize or execute it.

#### Base-staging EOA preparation

Base staging has no Safe and emits no Safe batch or sidecar. The lane identifies
the next permitted monotonic transition from fresh chain reads, verifies its EOA
authority, nonce, balance, and gas, and simulates that one exact transaction.
Preparation does not send it. Each later activation rerun repeats the preflight
for only the next still-required transition.

### Phase 3: governance execution

Base execution is external to the deployment script. The new batch performs,
in audited order:

1. Accept ownership of the reused `DisputeVerifier` if its exact pending-owner
   state still requires acceptance.
2. Accept ownership of the fresh `StakeVault`.
3. Accept ownership of the fresh `DisputeProtectionPolicy`.
4. Grant the fresh policy write permission on the shared dispute registry.
5. Revoke the predecessor policy's write permission.
6. Set OrchestratorV3's lifecycle hook to the fresh
   `IntentLifecycleHookV1`.

The registry permission and hook swap are atomic. The new writer exists before
the new hook is reachable, and the old writer is removed only after the drain
proof. The final call changes Base from the whitelist-only hook to the combined
whitelist plus opt-in dispute hook.

Base staging uses its EOA governance path and cannot make the equivalent
cutover atomic. It therefore allows only these resumable monotonic states:

1. fresh writer absent, predecessor hook active;
2. fresh writer present, predecessor hook active;
3. fresh writer present, fresh hook active, predecessor writer present;
4. fresh writer present, fresh hook active, predecessor writer absent.

Each rerun detects the exact current state and performs only the next permitted
transition. It requires separate activation, downstream-ready, and
predecessor-drained confirmations. Unknown partial states fail closed.

## Preconditions and failure behavior

Passive deployment requires exact shared dependencies and predecessor evidence.
Activation additionally requires:

- lane 31 payment binding is fully cut over;
- the current hook is the expected per-network predecessor;
- the predecessor vault has `totalStaked == 0`, `totalClaimable == 0`, the
  expected controller, and no pending controller change;
- the fresh vault is empty and controlled by the fresh policy;
- every live lock would have a positive amount and contribute to
  `totalStaked`, so zero aggregate stake proves no live lock remains;
- the predecessor and fresh policies have exact constructor dependencies;
- risk windows equal the approved method/order/value configuration;
- only the expected hooks are authorized by their respective policies;
- the dispute registry writer set is one of the explicitly permitted
  transition states;
- ownership and pending ownership equal the expected phase;
- on Base, the current Safe contract `nonce()` and
  balance/gas/simulation preconditions match the prepared batch;
- on Base staging, the authorized EOA nonce, balance, gas, and exact next-call
  simulation match the next permitted transition;
- the exact source SHA has the required release-readiness evidence;
- the package and environment-specific indexer addresses are deployed;
- Curator consumes the new package/address tuple and, while the predecessor hook
  remains active, reports the expected fail-closed/direct-only state rather than
  `Canonical`.

Lane 34 fails closed on unknown code, address drift, hook drift, accounting,
unexpected writers, permission drift, ownership drift, missing confirmations,
stale nonce, Base batch drift, or an unrecognized partial transition.

Postflight verifies the hook, dependency graph, writer set, owners, risk
windows, controller, both vaults' accounting, emitted hook-update event, and
indexed normalized hook state. After indexer catch-up and cache refresh, Curator
must then report `Canonical`. Base postflight happens only after separately
approved external execution.

## Package publication

Publication happens only after the real Base-staging and Base deployment
artifacts and regenerated outputs are committed.

1. Discover the current release line, registry state, and next unused version
   using the repository publish workflow; do not assume `0.4.1-rc.3` or any
   other value.
2. Prepare the version and package outputs from the exact deployment commit.
3. Require the exact candidate SHA to have a green complete Foundry suite and a
   green `Release readiness` run, including build/package, localhost deploy,
   all coverage lanes, floor enforcement, and Codecov upload.
4. Tag and dispatch only through the protected GitHub Actions trusted publisher
   with OIDC/provenance.
5. Verify registry version, dist-tag, integrity, provenance, installed package,
   and Base/Base-staging canonical exported addresses.

No local publish, token publication, version reuse, or artifact substitution is
permitted. Safe activation remains independent of package publication.

## Indexer hard cut

The indexer change ships against the actual replacement addresses on both
network configurations:

- A missing `DepositDisputeProtectionConfig` resolves to `false`.
- Explicit `enabled: false` resolves to `false`.
- Explicit `enabled: true` resolves to `true` only when the config belongs to
  the active replacement policy and that policy's payment-method risk window is
  nonzero.
- Competing or predecessor policy rows must not win by lexicographic address.
  Active policy identity comes from an explicit environment-specific configured
  replacement address, not from chain ID. Base staging and Base both use chain
  ID 8453.
- Base-staging and Base policy, hook, and vault addresses are replaced with the
  real lane-34 deployments.
- The published contracts package dependency and lockfile are updated.
- Envio codegen/config synchronization is regenerated before typecheck.
- The deployment/reindex excludes predecessor policy events from active policy
  projection so an old explicit event cannot opt a deposit into the new policy.

The environment configuration passes its active policy address explicitly into
effective projection resolution. Config synchronization proves that this value
matches the policy bound in the corresponding Base-staging or Base YAML. Tests
exercise both environments with the shared chain ID and different active policy
addresses.

QuoteCandidate and OrderbookEntry must agree on the effective field. Query
predicates, post-fetch admission, response mapping, and schema documentation
must all describe missing configuration as disabled.

Curator must adopt the new package/address tuple before activation. With the
predecessor hook still active, the expected readiness result is fail-closed and
direct-only. The exact hook check remains unchanged and may report `Canonical`
only after activation, indexer catch-up, and cache refresh. Curator changes are
not part of this implementation unless a later request expands scope.

## Testing and verification

### Test-driven contract change

Before production Solidity changes:

1. Change the smallest policy tests to require `false` for untouched and
   nonexistent deposits and observe the expected failure.
2. Add an explicit-enable admission regression and observe the expected
   failure under default-on source.
3. Change the admission-matrix integration tests and observe the changed rows
   fail for the expected reasons.
4. Implement the minimal direct-mapping change and make those tests green.

Focused Foundry coverage includes policy setter/getter/events, whitelist and
combined-hook admission, insufficient stake, cancellation, settlement,
non-USDC mismatch, `riskWindow == 0`, and hook snapshot behavior.

### Deployment tests

The lane-34 helper tests cover:

- Base's whitelist-hook predecessor and Base staging's old combined-hook
  predecessor;
- exact pinned predecessor acceptance and unknown bytecode rejection;
- fresh trio deployment with shared verifier/registry reuse on live networks;
- local-only verifier/registry creation from an empty localhost/Hardhat
  deployment database;
- versioned deployment records plus one alias manifest consumed by every
  extractor/verifier, canonical fresh public addresses, no public `*OptIn`
  keys, and unchanged historical JSON;
- deploy-only completion with no hook or writer mutation;
- obsolete-batch decoding, archival, and invalidation;
- every allowed Base-staging partial state and resumable transition;
- Base-staging preparation and activation neither require nor emit Safe batch
  or sidecar artifacts;
- every missing confirmation and drift failure;
- exact Base Safe target/calldata/order/`Safe.nonce()`/canonical hash and atomic
  simulation, with a fully recomputable sidecar manifest;
- predecessor drain proof and fresh/predecessor postflight;
- localhost/Hardhat final topology without a duplicate lane-32 stack.

### Final gates

Contracts verification uses the smallest focused commands first, then:

- affected deterministic suites;
- deployment-helper tests and TypeScript checks;
- ABI equality against the pre-change interface;
- package extraction and installed-package verification;
- `git diff --check` and stale default-on prose/name scans;
- one complete `yarn test` at the finalized cross-cutting code state.

Do not run local coverage as an iteration check. The exact release candidate's
protected `Release readiness` workflow supplies final coverage evidence.

Indexer verification includes:

- `pnpm codegen`;
- focused policy-handler and quote/orderbook projection tests;
- `pnpm typecheck`;
- `pnpm check:config-sync`;
- schema package build/release verification;
- Base/Base-staging address scans;
- tests proving only the configured active policy can enable a row;
- same-chain-ID tests proving environment-specific policy selection;
- `git diff --check` and stale default-on documentation scans.

## Delivery sequence

1. Implement and merge the contracts behavior plus lane-34 machinery.
2. Run deploy-only on Base staging and Base; verify and commit real artifacts
   and regenerated outputs. Do not swap either hook as part of deployment.
3. Publish the newly discovered protected contracts package version from the
   exact deployment release SHA.
4. Update and verify indexer behavior, package dependency, and both address
   configurations; deploy/reindex downstream environments through their normal
   release path.
5. Update Curator to the published package/address tuple and prove that the
   still-active predecessor hook produces the expected fail-closed/direct-only
   preactivation state.
6. Prepare the exact governance activation artifacts from fresh chain reads.
7. Execute Base staging through its separately confirmed resumable activation
   path when approved.
8. Present the Base Safe batch for separate multisig approval and execution.
9. Postflight chain state, events, indexer state, cache refresh, Curator
   `Canonical` readiness, and downstream eligibility.

Every phase is independently reviewable. Completion of an earlier phase is not
evidence that a later deployment, publication, downstream release, or
governance activation occurred.
