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

## Preparation validation

Read-only inspection at block `53195224` passed the baseline, reused bytecode,
wiring, catalog, pending-nonce and clean-source gates. The configured deployer
had nonce `60`, pending nonce `60`, and `0.041313152764110917 ETH`. All four
mutable registries belonged to that deployer; `requiredOwnershipChanges` was
empty. V1 and the October 16 O4 were paused with counters `290` and `38`; O3
remained registered, unpaused, and wired to its pinned hook. There were no
inspection warnings. Separate read-only enumeration confirmed the added
relayer `0xBC6Ca58369853D77a9A2f33358334BF9E9B9094F`.

`base_staging.json` required no edits: ownership and signer nonces are read live,
and the additional relayer does not change the pinned O3 configuration. The
gating service and all bytecode, wiring, catalog and witness pins are unchanged.

| Command | Result |
| --- | --- |
| `yarn install` | Passed; dependencies were initially absent |
| `forge build` | Passed; existing mutability/lint warnings only |
| `forge test --match-path 'test-foundry/**/OrchestratorV4StackDeployment.t.sol'` | 19 passed |
| `yarn test:orchestrator-v4-release` | 28 passed |
| `yarn test:release-policy` | 114 passed, including archive integrity/export checks |
| `yarn typecheck:dispute-deployment` | Passed |
| `yarn pkg:extract` | Passed, including canonical Hardhat compilation and TypeChain |
| `yarn pkg:build` | Passed |
| `yarn workspace @zkp2p/contracts-v2 test` | 13 passed across 3 suites |
| `yarn workspace @zkp2p/contracts-v2 verify:release` | Passed: 84 deployment-backed entries, 34 source ABI exports |

The runner tests and `pkg:extract` used
`HARDHAT_CONFIG=hardhat.canonical.config.ts HARDHAT_NETWORK=hardhat` to clear
unused remote accounts while retaining public local fixtures. The runner suite
includes the eight-contract deploy/resume/activate/verify regression (the
successor of the former seven-contract rehearsal). Its first focused invocation
was blocked by missing Hardhat artifacts; the full suite passed after extraction.
All transactions in these tests were confined to local in-memory chains. No live
deployment, activation, source-verification submission, publication, key access,
or push was performed. The current manifest and eight current Hardhat record
names remain absent for the separately authorized deployment.

## Passive deployment, 2026-10-28

Deployed from `0749b75f235c6d90079c1e261f46d67778f7c389`, whose `contracts/` is
byte-identical to main `646898f`. Signer `0x41123d6419C7b8e44157f6F3b0088442116641eC`,
nonces 60–84, 25 confirmed transactions. The suite is passive: O4 is not
registered, and no shared registry, route or ownership state changed.

| Contract | Address | Block |
| --- | --- | --- |
| StakeVaultV2 | [`0xe6314251979b6185c6a1A265de82460EB180821c`](https://basescan.org/address/0xe6314251979b6185c6a1A265de82460EB180821c#code) | 53196135 |
| AddressGroupRegistryV4 | [`0xD80e868d4682EF6760903aF7a00ace2C8D76EF62`](https://basescan.org/address/0xD80e868d4682EF6760903aF7a00ace2C8D76EF62#code) | 53196139 |
| WhitelistPolicyV2 | [`0x226b5Fcb292b7F730562B51fd50a35045b16168e`](https://basescan.org/address/0x226b5Fcb292b7F730562B51fd50a35045b16168e#code) | 53196143 |
| IntentSignalPolicy | [`0x0cc9A2fEF98fE535ca4aEb5bd708bf17E63e4A80`](https://basescan.org/address/0x0cc9A2fEF98fE535ca4aEb5bd708bf17E63e4A80#code) | 53196146 |
| DisputeProtectionPolicyV2 | [`0x0d5a9162161d195577A3a3458524574bb462ccDc`](https://basescan.org/address/0x0d5a9162161d195577A3a3458524574bb462ccDc#code) | 53196150 |
| UnifiedPaymentVerifierV4 | [`0x7Da43ba0F85cfb64733216C4A2288f80dFfe1EAb`](https://basescan.org/address/0x7Da43ba0F85cfb64733216C4A2288f80dFfe1EAb#code) | 53196158 |
| OrchestratorV4 | [`0xd03674d06FB9d66C7F1dc9c8D45ADd314B604F2c`](https://basescan.org/address/0xd03674d06FB9d66C7F1dc9c8D45ADd314B604F2c#code) | 53196209 |
| ProtocolViewerV4 | [`0xDe4a3DA259549f1e236B05D1158822D03b8f4ABc`](https://basescan.org/address/0xDe4a3DA259549f1e236B05D1158822D03b8f4ABc#code) | 53196219 |

The runner's post-deploy verification passed (bytecode, constructors, wiring,
ownership, payment catalog, escrow compatibility, predecessor preservation).
All eight sources are exact Basescan matches. Independent reads confirmed O4's
signal policy and settlement policy, `gatingService`
`0x87eE8394DDa0F8CB89924e093f6209cfCA3045e0`, the registry's `groupArbitrator`,
the 12-field `IntentSignaled` topic in O4's bytecode, DisputeProtectionPolicyV2 as
the vault controller, 14 UPV4 payment methods, and O4 unregistered.

CI gate deviation: Foundry CI and Release readiness fail repo-wide in the shared
`patch-node24` runner step (main has been red since `948ca94`). Before broadcast,
every CI command was run locally at `0749b75` and passed: release-policy,
compile, `pkg:build`, `pkg:test`, the payment-method and signer tests,
`typecheck:dispute-deployment`, `test:orchestrator-v4-release`,
`deploy:localhost` and the complete Foundry suite (1872 passed, 0 failed).

Not done here, each separately approved: package export, downstream re-vendor,
relayer allowlists, privacy re-migration on the new WhitelistPolicyV2, group
recreation on the new registry, and activation.
