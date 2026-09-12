# Passive UPV4 bootstrap

Lane 43 deploys and configures `UnifiedPaymentVerifierV4` against the existing
`NullifierRegistryV2`, its legacy history, the existing orchestrator registry and
the predecessor's attestation verifier. It registers all current methods with
their existing replay namespaces, then registers `venmo-balance` with the
`venmo` namespace. It transfers ownership after configuration. It never grants
writer permission, changes a live payment route, changes risk windows, or
updates the active package addresses.

The lane requires the intact lane-31 UPV3 cutover and the active method-scoped
lifecycle stack. It validates the current O3 hook/policy pointers and refuses a
nonzero risk window for any shared-namespace alias. Each operation checks a
pinned predecessor snapshot, the current compiled successor runtime, dependency
getters, signing domain and exact namespace prefix. Resume does not repair
unexpected ownership, method removal, reordered methods or namespace changes.
The additional historical lane-31 preflight reads latest state; these checks
are passive-deployment checks, **not an atomic activation proof**.

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
