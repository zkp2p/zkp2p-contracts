# Base O4 verification after the Support KMS witness addition

On 2026-11-04 at 15:26:49 UTC, Base Safe
`0x0bC26FF515411396DD588Abd6Ef6846E04470227`, nonce 92, executed
`MultiAttestationVerifier.addWitness(0x7f814Afbd0Baf3932FA20Cb76b414007B0bADa8C)`.
Transaction `0x071e79c3329b5f08b364e937ad9adb8a60233c98eebe9f9fb6c65554197f011c`
landed at block 53508331. The verifier is
`0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5`.

The sole accepted current state is the ordered list
`[0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754,
0xE078D93bFdd87A8c5C5cCA5905DCbA0Dd7A1F0BD,
0x7f814Afbd0Baf3932FA20Cb76b414007B0bADa8C]`, threshold `1`.

## Deployment provenance stays immutable

`deployments/orchestrator-v4/base.json` is bound in two independent ways:

- `deployments/outputs/orchestrator-v4-base.json.configurationHash` is SHA-256
  of `JSON.stringify(configuration)`; the CLI compares it with the config on disk.
  Its value remains `9b3e56c1cd04a2cc6bf4c74119589d2237e96da51264c0b66340f1ef69194512`.
- `scripts/orchestrator-v4-provenance.ts::releasePaths().deployed` includes that
  config, all contracts, `hardhat.config.ts`, the source verifier, and
  `deployments/canonicalDeployment.ts`. They must equal deployed source
  `526f81d2ea53f2045b821931b21f7b7e8f15a2c4`, which must remain an ancestor of HEAD.
  The source paths at the task base `2ee9839` match that deployment.

The embedded configuration and baseline in the output manifest describe the
original two-witness deployment. They are deliberately unchanged. Replacing those
lists and recomputing the configuration hash would rewrite deployment provenance.

The existing separate `executionToolCommit` mechanism binds reviewed execution
paths independently of deployed source. However,
`scripts/orchestrator-v4-safe-batches.ts::assertApprovedBaseManifest` explicitly
requires Base's original `executionToolCommit` to be absent. That restriction is
unchanged. A new optional top-level **`verificationToolCommit`** in the Base output
manifest selects a reviewed tool revision only for `base verify` and
`base verify-source`. It is passed to the same `assertReleaseProvenance` function:
full SHA, ancestor, exact execution-path equality, immutable deployed paths, and
no dirty protected paths. Deploy, activation, preparation, staging and Safe-batch
commands do not gain authority from this pin. Historical Safe tooling continues
to require its original clean checkout.

This uses two commits: first the implementation and governance record, then a
manifest-only recording commit setting `verificationToolCommit` to the first
commit. Consumers pin the second commit as their exact verification checkout.
Do not squash away the first commit or amend it after recording its SHA.

## Exact governance evidence

`deployments/orchestrator-v4/base.governance-changes.json` and
`scripts/orchestrator-v4-governance.ts` are execution-protected paths. Active Base
CLI verification must load the record; missing evidence is an error. It is not
PR #384's optional staging allowance, and does not enable its policy/writer changes.

The checker requires the recorded chain, verifier, Safe, complete ordered list,
threshold and current verifier owner. The result must be exactly the original
baseline plus the recorded addition. It checks the successful transaction receipt,
its exact block and block hash, canonical block identity, and the exact
`WitnessAdded` and Safe `ExecutionSuccess` logs from their pinned emitters.
It derives the Safe EIP-712 hash from `addWitness`, nonce 92, the target, CALL
operation, zero value and zero fee fields. This authenticates the inner Safe call
even though the outer transaction targets a relayer. The live snapshot is pinned
to one block by `inspect`; all other baseline, bytecode, constructor, role, route,
writer, fee and privacy checks remain in place.

The current three-witness list, extra witnesses, altered order, threshold changes,
and malformed governance evidence have focused regression coverage. The old list
is accepted only by the original historical baseline API, used for deployment
fixtures and historical rehearsals. The active Base CLI gate requires the record
and rejects that old list. Its separate `.verification` receipt records the new
check without rewriting historical evidence.

## Other witness pins found

- `deploy/31_deploy_v3_payment_binding_stack.ts` pins both old witnesses and
  threshold, and checks their order. Its mounted wrapper still calls the frozen
  readiness function. The new witness makes that historical check fail before its
  UPV3-writer exception; this O4 verification change does not authorize that lane.
- Executed lanes 34, 38 and 40 retain their historical witness pins. The method
  and vault activation reducers in `deployments/methodScopedActivation.ts` and
  `deployments/vaultMethodScopedActivation.ts` compare supplied trust surfaces,
  including witness order. Historical Safe-batch sidecars also bind the old set.
  Those immutable lanes and execution artifacts must not be edited for this change.
- `deployments/dispute-stack-evidence.json` contains the old Base attestation
  trust. `packages/contracts/scripts/extractors/disputeStack.ts` exports it into
  the package; `scripts/active-dispute-stack.spec.cjs` checks the same two-witness
  evidence, and package smoke validation currently requires two witnesses.
  These are separate package/evidence checks, not inputs to the O4 gate. They
  remain unchanged and must not be presented as a current live witness snapshot.
  Updating the published catalog requires a separate evidence/package change.
- `deployments/parameters.ts::MULTI_WITNESS_ADDRESSES.base` is an older constructor
  default containing DB4Ed7 alone, not the current O4 trust source. The canonical
  MultiAttestationVerifier deployment record preserves its constructor arguments.

## Follow-up after removing DB4Ed7

Do not pre-authorize the two-witness state. After an approved Safe transaction
executes `removeWitness(0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754)`:

1. Record its transaction hash, canonical block/hash, Safe nonce and Safe hash.
   Preserve the addition record as historical evidence.
2. Extend the checker to authenticate that exact `removeWitness` Safe call and
   `WitnessRemoved` log, and its transition from the recorded three-witness state.
   The only resulting order is `[0x7f814Afbd0Baf3932FA20Cb76b414007B0bADa8C,
   0xE078D93bFdd87A8c5C5cCA5905DCbA0Dd7A1F0BD]` because EnumerableSet swaps the
   last entry into DB4Ed7's removed slot. Threshold remains `1`.
3. Make the removal result mandatory; reject the old three-witness state,
   different order, extra witnesses, changed threshold and missing/reverted or
   mismatched removal evidence. Run the O4 release specs and a fresh live check.
4. Commit the tool/record change, then advance only the output manifest's
   `verificationToolCommit` in a recording commit. Preserve `base.json`, deployed
   `sourceCommit`, configuration/hash and baseline. Re-pin downstream evidence.

## Attestation-service handoff

Read-only inspection of fetched `attestation-service` `origin/main` and
`origin/kohai/nonpayment-attestation` found **only a staging canonical gate**:
`deploy/verify-staging-contracts.cjs` hardcodes `base_staging` for the config,
manifest comparison and command. `deploy/nitro/README.md` documents that staging
gate. Main pins `69dbf0d`; the nonpayment branch pins PR #384's `a750273`.
Neither inspected ref has a production O4 gate to repair by changing those fields
alone. Do not replace the existing staging pin with this Base pin.

For a production gate on another ref, or a separately implemented Base gate,
apply the README's same exact-checkout protocol to the production environment:

- Set that production contracts entry's `verificationToolCommit` to this change's
  **recording commit**, not the implementation commit.
- Vendor the exact bytes of that commit's
  `deployments/outputs/orchestrator-v4-base.json`; set `deploymentManifest` to its
  vendored path and `deploymentManifestSha256` to the SHA-256 of those file bytes.
  Set `deploymentSourceCommit` to `526f81d2ea53f2045b821931b21f7b7e8f15a2c4`.
- The vendored manifest's own `verificationToolCommit` points to the implementation
  commit. Keep its original configuration/hash/baseline; do not vendor the local
  `.verification` receipt instead. Keep package `sourceCommit`, tarball and integrity
  unchanged unless independently releasing a different package.
- Point `O4_CONTRACTS_CHECKOUT` at the clean recording commit with full Git history
  and immutable dependencies. Check byte equality of the vendored Base manifest,
  then run `HARDHAT_CONFIG=hardhat.readonly.config.ts yarn deploy:orchestrator-v4 base verify`.
  The production wrapper must select `base` in every config/manifest/path check.
  Do not skip deployed-source comparisons against the package's source: if a
  staging-only artifact pin differs on protected Base paths, it needs a compatible
  production provenance entry, not a bypass.

This contracts change does not publish a package, push a branch, submit a Safe
transaction, or deploy attestation-service.
