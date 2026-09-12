# Passive UPV4 bootstrap

Lane 43 deploys and configures `UnifiedPaymentVerifierV4` against the existing
`NullifierRegistryV2`, its legacy history, the existing orchestrator registry and
the predecessor's attestation verifier. It registers all current methods with
their existing replay namespaces, then registers `venmo-balance` with the
`venmo` namespace. It transfers ownership after configuration. It never grants
writer permission, changes a live payment route, changes risk windows, or
updates the active package addresses.

The lane requires the intact UPV3 routes/writer configuration and the active
method-scoped lifecycle stack. Its current-owned predecessor evidence records
Base's eleven methods, including UPI, and Base staging's thirteen methods at
block 51,199,130. Staging's registry and UPV3 have different valid orders;
both are checked against their own evidence arrays. Currency order, chain,
governance, core deployed addresses/full runtime hashes, O3 pause/chain state,
and MultiAttestationVerifier witnesses/threshold must match. Untagged runs
remain inert. Executed lane31 retains its historical ten-method Base catalog;
the new bootstrap does not call that obsolete catalog preflight.

Every predecessor read uses one pinned block, whose hash is rechecked after
collection. The lane validates the current O3 hook/policy pointers and refuses
a nonzero risk window for any shared-namespace alias. Each operation rechecks
the predecessor snapshot, current compiled successor runtime, dependencies,
signing domain and exact namespace prefix. Resume does not repair unexpected
ownership, method/currency/witness changes, disabled methods or reassigned
namespaces. These remain passive-deployment checks, **not an atomic activation
proof**. Updating the pinned evidence requires new deployed-state review;
unknown catalog or authority drift is never silently accepted.

Compile the reviewed source before running a tagged deployment; tagged runs use
`--no-compile`. An ordinary untagged deployment skips this lane on every network.
After deploying the existing local stack, exercise deployment and resume with:

```sh
yarn deploy:upv4:localhost
yarn deploy:upv4:localhost
```

Live execution requires separate deployment authorization, the exact tag
`43_deploy_unified_payment_verifier_v4`, and exactly the matching environment
opt-in: `ENABLE_BASE_UPV4_BOOTSTRAP=true` or
`ENABLE_STAGING_UPV4_BOOTSTRAP=true`. This PR and a successful local run do not
authorize either live operation. No live deployment has been recorded.

Before activation, prepare and review a separate complete cutover manifest and
execution-time guard: every authorized orchestrator/admission path, every
method's ordered currencies, immutable namespaces, existing and retired writer
sets, policy governance, authenticated funding evidence, and all attestor and
client domains must agree. Balance must remain unadvertised until those gates
pass. Historical alias registration and consumption require investigation.
Regular paid orders need fresh signatures for the replacement address; users
must not be asked to send another payment. Retire the predecessor-only lane-31
runner through current metadata or a wrapper when activation is implemented;
never rewrite executed deployment history or restore predecessor routes after
UPV4 consumption. Base requires an atomic guarded governance batch; staging's
EOA ownership needs a separately reviewed maintenance sequence.

## Admission prerequisite for activation

The shared payment registry is also reachable by V1 and V2 orchestrators.
Their admission paths do not invoke O3's method-scoped lifecycle hook. An
unpaused registered legacy caller can therefore lock a balance-enabled
EscrowV2 deposit without applying its O3 whitelist. Passive deployment is
safe because it adds no public route; activating balance requires proving
that every admitted caller enforces the intended policy.

First reconstruct the complete OrchestratorRegistry Added/Removed history
from deployment to one pinned block, and reconcile every discovered address
with its getter, runtime bytecode, owner, pause state and registry pointers.
The registry has no enumeration getter. Current deployment artifacts and an
explorer page are not a complete allowlist. A removal without a preceding
add, mismatched getter, unknown caller or missing history aborts preparation.
Do not infer that an authorized legacy caller is active without checking its
pause state and reachable escrows.

Generate the registry portion of this evidence from clean committed source
using a trusted archive RPC selected by `UPV4_INVENTORY_RPC_URL`:

```sh
yarn inspect:upv4-callers base <pinned-block-number> /tmp/upv4-base-callers.json
yarn inspect:upv4-callers base_staging <pinned-block-number> /tmp/upv4-staging-callers.json
```

The optional fourth argument selects the block span (default 2,000). Both
deployments are on chain 8453. The tool checks the recorded direct creation
transaction and exact registry runtime, scans contiguous Added/Removed ranges
from creation, and reconciles the union of event-discovered and current
artifact-known callers against getters at the pinned block. It rejects missing
transitions, duplicate events, getter disagreement, RPC failures and detected
reorgs. A new output file records source/record hashes, scan bounds, events,
membership and caller runtime hashes; existing output files are never replaced.
The RPC URL and raw provider errors are not written to the report or console.

This inventory still trusts the RPC to return every matching log: a completely
omitted unknown caller history cannot be detected from the non-enumerable
registry. Runtime hashes need separate identification and review, including
owners, pause state, registry pointers, escrow reachability and all paid-order
obligations. The tool emits no activation-ready verdict and creates no
governance transactions. A successful scan is one input to the full cutover.

If legacy admissions remain possible, use a separately approved maintenance
window before activation:

1. Pin the shared EscrowRegistry's full ordered allowlist and permissive flag.
   Set `acceptAllEscrows` false and remove all entries in a guarded admission
   closure. Prove the final flag is false and the list is empty. Every known
   caller must use this registry; divergent registries need equivalent proven
   closure. Keep verifier routes, writers, domains and caller authorization
   intact while existing payments settle.
2. Resolve outstanding legacy orders with their original payments and existing
   terms. For bytecode-proven V1/V2/V3 implementations, enumerate every
   `getIntent` using counters `[0, intentCounter)`: the hash is
   `keccak256(abi.encodePacked(orchestrator, counter))` modulo the circuit
   prime. Reconcile nonzero intents with every escrow's deposit locks and
   paid-but-unresolved support cases. Expiry or an empty event page alone is
   not proof that a paid obligation is resolved.
3. Retire only callers whose obligations are proven terminal. Pausing a caller
   before drain also disables fulfillment; removing it from the registry
   blocks UPV verification and EscrowV2 release. After drain, pause and
   deauthorize retired callers. V1's original Escrow uses a direct orchestrator
   pointer, so registry removal alone does not prevent new V1 locks there.
   The original Escrow also lacks the effective-rate and manager-fee getters
   required by O3. Changing its pointer to O3 is not a supported migration and
   would disable V1 release. Keep it outside the restored admission list; from
   the observed admitted Base pair, only EscrowV2 is O3-compatible. Escrow
   pause itself leaves locking enabled and cannot replace admission closure.
4. Keep admissions closed through the all-method UPV4 cutover. Preserve every
   existing method/currency order and replay namespace, add balance only when
   all issuer and consumer gates pass, and revoke UPV3's writer in the atomic
   Base batch. Verify final governance, route, writer, namespace and O3 policy
   invariants before restoring only the approved O3-capable escrow allowlist.
   Staging must retain closure across its non-atomic EOA steps.

Closing EscrowRegistry admissions preserves the core fulfill/cancel/manual
release paths, but disables `IntentGuardian.extendIntent` and whitelist
configuration setters during the window. Plan existing payment deadlines and
review custom post-intent hooks before closure. Do not substitute blanket
cancellation, another fiat payment or automatic expiry for payment recovery.
Existing O3 paid intents and settled dispute coverage need no vault drain for
a verifier replacement; retain their snapshotted hook/policy/vault state.

`UnifiedVerifierAdmissionMaintenance.t.sol` covers signed predecessor
settlement and unpaid cancellation across V1/V2/V3 against a shared EscrowV2,
plus the failure caused by premature caller pause/removal. These local source
fixtures are not live caller inventory or authorization to execute maintenance.
The complete guarded activation generator, current-runner retirement, live
history/drain proof and coordinated domain/package recording remain required.
