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
