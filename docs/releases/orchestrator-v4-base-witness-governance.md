# Base O4 verification after witness migration and registry retirements

On 2026-11-04 at 15:26:49 UTC, Base Safe
`0x0bC26FF515411396DD588Abd6Ef6846E04470227`, nonce 92, executed
`MultiAttestationVerifier.addWitness(0x7f814Afbd0Baf3932FA20Cb76b414007B0bADa8C)`.
Transaction `0x071e79c3329b5f08b364e937ad9adb8a60233c98eebe9f9fb6c65554197f011c`
landed at block 53508331. The verifier is
`0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5`.

Safe nonce 93 completed the planned KMS witness migration by removing
`0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754`. The sole accepted current state is
`[0x7f814Afbd0Baf3932FA20Cb76b414007B0bADa8C,
0xE078D93bFdd87A8c5C5cCA5905DCbA0Dd7A1F0BD]`, in that order, threshold `1`,
owned by the same Safe. These exact addresses, order, threshold and owner were
read from the public Base RPC. The earlier two- and three-witness states fail.

## Deployment provenance stays immutable

`deployments/orchestrator-v4/base.json` is bound in two independent ways:

- `deployments/outputs/orchestrator-v4-base.json.configurationHash` is SHA-256
  of `JSON.stringify(configuration)`; the CLI compares it with the config on disk.
  Its value remains `9b3e56c1cd04a2cc6bf4c74119589d2237e96da51264c0b66340f1ef69194512`.
- `scripts/orchestrator-v4-provenance.ts::releasePaths().deployed` includes that
  config, all contracts, `hardhat.config.ts`, the source verifier, and
  `deployments/canonicalDeployment.ts`. They must equal deployed source
  `526f81d2ea53f2045b821931b21f7b7e8f15a2c4`, which must remain an ancestor of HEAD.
  The sole Base documentation exception is the exact path `contracts/archive/README.md`,
  which records O3 retirement. No other source path is exempt; staging remains exact.

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
threshold and current verifier owner. The addition record is preserved, with a
mandatory `removal` record appended. The resulting list is derived by the
verifier's EnumerableSet swap-and-pop removal, not accepted as an arbitrary list.
Both successful receipts must match their transaction hash, block number and
canonical block hash, with exact witness and Safe `ExecutionSuccess` logs.
For each witness call the checker derives the Safe EIP-712 hash from its method,
witness, nonce, target, CALL operation, zero value and zero fee fields.

| Witness event | Safe nonce | Block | Transaction |
| --- | --- | --- | --- |
| Add `0x7f814Afbd0Baf3932FA20Cb76b414007B0bADa8C` | 92 | 53508331 | `0x071e79c3329b5f08b364e937ad9adb8a60233c98eebe9f9fb6c65554197f011c` |
| Remove `0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754` | 93 | 53544480 | `0xad69646909c5e4d3b049e7403bbf8eac8a9810604a2ac615ab323cdb24ec321b` |

Nonce 93's canonical block hash is
`0xbde61ac7dbc9ba76bfb18aeb7c1847684f787b15b145a4a73ed8388315e6d3be`;
its Safe transaction hash is
`0x2145a47ae1b3e6594daf9f3a4e514dcdb31cf594b1c268c62a906bae3403d137`.
The verifier's complete witness-add/remove, threshold and ownership event stream
from the addition block through the current inspection head must contain exactly
the two recorded witness logs. Extra events fail even when the resulting state
is restored. Scans use contiguous ranges of at most 50,000 blocks and include
the head. RPC errors fail verification; they do not skip evidence.

The live snapshot is pinned to one block by `inspect`. All other baseline,
bytecode, constructor, role, route, writer, fee and privacy checks remain in
place. The separate `.verification` receipt records current governance evidence
without rewriting the historical deployment manifest.

## Verification after O3 retirement

The active Base gate also requires O3 `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`
to remain unregistered and O4 `0x74c55679268FAfB493864915aD16A320AB8c40Ba` to remain
registered. The retirement is pinned to Safe nonce 94, transaction
`0x85b7c40b779350cdeb6890f84d72375588e1bf930f9fdcd8eeea97aa4ea60dfc`, block
53550556 (2026-11-05 14:54:19 UTC). Two subsequent, human-confirmed governance
transactions are now mandatory history:

| Purpose | Safe nonce | Block | Transaction |
| --- | --- | --- | --- |
| Atomic stuck-deposit drain: add O3, then remove O3 in the same transaction | 95 | 54173646 | `0x497b6d78199baebce6c1b1c9adcc4b6c2c8422e348e67c63fb85a93eab9a505c` |
| Remove legacy orchestrator `0x88888883Ed048FF0a415271B28b2F52d431810D0` after the 2026-11-07 abuse | 96 | 54199685 | `0x825754eb601dd1ffe71a03c918508421ec9a2a15533f4a5ee195c548e40dfe20` |

Nonce 95 has canonical block hash
`0x35d191318b3f5ed9ba8475660181ab3e4a96f7ccb63d2d51f157b41035cecd81`
and Safe transaction hash
`0x27c3e24e1d1c91afa353660e91a26c623a8b497f8a7eee274c0bed05f0580c33`.
O3's add and remove logs have indices 9 and 100. Its outer transaction targets
the relayer `0x781388759EacB9892f60D77D9A99c9BE2F7F4ada`; the Safe's own
success event authenticates execution. O3 was registered only within this
transaction, not at either block boundary.

Nonce 96 has canonical block hash
`0xbbc8b569470b4b35c6321719d2ec53b0a535f6b01f6c6519cae4ede1978fe8e3`
and Safe transaction hash
`0x5a0edfe3396da88550e2c01223a187b31c776ac6b916794857807423530a9c48`.
The legacy removal log has index 7. The current legacy registration must be false.

Verification authenticates all three canonical successful receipts, registry
logs and Safe success logs. The complete registry add/remove event stream from
the nonce-94 checkpoint through the inspection head must equal exactly these
four logs: O3 removal, atomic O3 addition/removal, legacy removal. Any other
member mutation, transaction/block substitution, duplicate, missing event, or
later add/remove cycle fails. O4 registration remains mandatory. O3 pause, hook,
wiring, fees and every other baseline check remain exact.

Use the same two-commit pin procedure above. Only the Base manifest's top-level
`verificationToolCommit` advances; deployment source, configuration, addresses,
baseline and activation evidence stay byte-identical. The local `.verification`
receipt records `predecessorPreserved: false` and `predecessorRetirement` with the
authenticated evidence. Staging and historical execution paths do not receive
the retirement allowance.

Attestation consumers must pin the recording commit, vendor the updated Base
manifest and refresh its digest. Any consumer that independently checks protected
source paths must apply the same exact README exception; a contracts tool pin alone
cannot bypass a consumer's earlier source check.

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

## Attestation-service handoff

For peer-infra's **prod** contracts entry and attestation-service's production
wrapper, use this exact-checkout protocol. This change does not update either
consumer; no remote repository or service access is needed for the handoff.

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
  Its independent deployed-source comparison must allow only the exact
  `contracts/archive/README.md` documentation exception for Base, while preserving
  all executable-source checks and staging behavior. The wrapper must use a
  provider-only configuration with empty accounts; for public-RPC runs disable
  dotenv loading and override Base to `https://base-rpc.publicnode.com` or
  `https://mainnet.base.org`. No credentials or signing are needed.
  Do not skip deployed-source comparisons against the package's source: if a
  staging-only artifact pin differs on protected Base paths, it needs a compatible
  production provenance entry, not a bypass.

This contracts change does not publish a package, push a branch, submit a Safe
transaction, or deploy attestation-service.
