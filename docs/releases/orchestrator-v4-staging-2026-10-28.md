# Fresh Orchestrator V4 staging preparation

This prepares a fresh, passive eight-contract suite on `base_staging` (Base,
8453). It supersedes the inactive October 22 suite; it does not authorize a
transaction or activation. Solidity is unchanged from canonical main `646898f`.

## Historical records and package boundary

All seven October 22 Hardhat records now end in `Historical20261022`, retaining
their exact deployed ABIs, bytecode, addresses and receipts. Package network and
source ABI exports retain these aliases. None of those addresses is exported
under a current suite name. The eight current names are free for fresh records,
including a new `AddressGroupRegistryV4`, `WhitelistPolicyV2` and
`IntentSignalPolicy`. The October 22 registry lacks `groupArbitrator` and cannot
serve the current signal policy.

The original manifest and all October 22 evidence are under
`deployments/orchestrator-v4/historical/2026-10-22/`. `provenance.json` records
their original paths, source/record commits and SHA-256 digests. Archive files
and historical deployment records are protected execution paths. Their embedded
paths and observations remain historical evidence, not instructions to resume
or activate the old suite. The original deployment `sourceCommit` remains
`cd849c5383a274a4c970d7bb6231e032285fd9a2`.

## Fresh source provenance

`deployments/outputs/orchestrator-v4-base_staging.json` is intentionally absent.
After preparation is committed, a separately authorized `deploy` from the clean
final PR #362 commit creates that manifest with `sourceCommit = git rev-parse
HEAD` and the current configuration hash. No placeholder SHA or manual re-pin is
needed. `executionToolCommit` stays absent for a fresh deployment: execution and
source both use that exact commit. Later tool-only changes still require an
explicit reviewed tool SHA; compiled source/configuration drift is rejected.
Never repoint the historical manifest to the new source.

The fresh-manifest `inspect` path runs the same baseline and pending-nonce gates
as deployment, plus clean protected-path provenance, without constructing a
wallet. Signer derivation remains an execution-time gate. The configured signer
and governance are `0x41123d6419C7b8e44157f6F3b0088442116641eC` and
`gatingService` remains `0x87eE8394DDa0F8CB89924e093f6209cfCA3045e0`.

## Operator boundaries

Run the read-only preflight from the final clean commit:

```sh
HARDHAT_CONFIG=hardhat.readonly.config.ts yarn deploy:orchestrator-v4 base_staging inspect
```

No group or membership bootstrap belongs to this deployment. Existing Peer Pay
and QA groups and previous privacy migrations belong to the October 22 registry
and policy only. Activation still requires fresh-policy privacy enablement by
the required depositors, current post-pause drain evidence, correct ownership,
writer sets and routes. An old passive deployment or an archived migration is
not activation evidence for the fresh suite.

Before any separately approved broadcast, the exact final source SHA still
needs green complete Foundry CI and Release readiness (including coverage and
Codecov), plus a fresh nonce/ownership preflight. Local preparation checks do
not replace those gates. No deployer key is needed for this preparation.
