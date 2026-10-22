# Orchestrator V4 staging release

Status: all seven fresh contracts are deployed and pass bytecode, constructor,
wiring, ownership, payment-catalog and escrow-compatibility verification. The
suite remains unregistered and inactive. Activation is blocked until the four
mutable staging registries belong to the migrated staging deployer, both
incompatible predecessors are paused and drained, and existing private deposits
enable the fresh whitelist. Production is unchanged.

## Scope and source

Contract semantics come from merged #351, #353, #355 and #357, with final source
baseline `9c01555f93e493b4ad4497ff65ae9d4870b7ade2`. This release adds deployment
tooling and source ABI exports; it does not change their Solidity implementation.

The new suite consists of `StakeVaultV2`, `AddressGroupRegistryV4` (the compiled
`AddressGroupRegistry` contract), `WhitelistPolicyV2`,
`DisputeProtectionPolicyV2`, `UnifiedPaymentVerifierV4`, `OrchestratorV4`, and
`ProtocolViewerV4`. A fresh group registry is necessary because the previous
deployment lacks the group-arbitrator field used by O4. Groups, members and
deposit whitelist settings are not silently copied. A depositor must enable
their own V2 whitelist; the policy has no owner or bootstrap privilege.

### Existing private deposits

The old O3 hook uses method-scoped `WhitelistPolicy` at
`0xF79aAD1BAaB617fF3Eb299225c80893F22F743Fe`. Its complete indexed checkpoint across every escrow at
block `52938535` contains 27 enabled method tuples across 25 deposit IDs; every
tuple was independently checked on-chain at that block. The evidence is in
`deployments/orchestrator-v4/private-policy-checkpoint.json`.

Eighteen deposits still exist: `0, 1, 4, 6, 13, 18, 19, 24, 25, 29, 48, 60, 65,
66, 84, 97, 138, 139`. Deposits `98, 129, 130, 131, 132, 133, 134` have been
irreversibly deleted. Deposits 65 and 66 hold 37.5 and 4 USDC respectively, accept
intents and have no gating signer. Their intent guardian only controls expiry
extensions; it does not restrict `lockFunds`. A newly registered O4 would accept
these rows while its fresh whitelist remains disabled.

Before activation, each existing private deposit's depositor must call
`setEnabled(escrow, depositId, true)` on the fresh `WhitelistPolicyV2`. With no new
allowlists this closes O4 admission while leaving old O3 groups and deposit state
unchanged. Only the recorded depositor can do this; neither the deployment signer
nor an escrow delegate has that authority. The runner checks the pinned old
policy, includes all later `EnabledUpdated` events, reads current enablement,
covers every escrow appearing in those records/events, skips deleted deposits,
and requires new-policy enablement for every remaining
private deposit. It runs before the first activation write and again immediately
before registration. Empty retained deposits are included because they can be
funded again. The manifest records the checked block and required/deleted escrow
and deposit IDs. The shared escrow registry contains five addresses; the guard
is not limited to the primary EscrowV2 address.

Gating signatures use EIP-191 over a packed message containing the orchestrator
address; O3 signatures cannot be replayed on O4. This does not substitute for
migrating private-policy settings. Coordinate deposit/policy mutations during
cutover, and use the new policy for subsequent O4 privacy settings.

The environment's escrow, escrow registry, orchestrator registry, payment
registry, relayer registry, replay registries, dispute verifier and attestation
verifier are reused. `deployments/orchestrator-v4/base_staging.json` records every
reused address, deployment transaction, deployment block, runtime hash, payment
method/currency, witness, fee and predecessor hook. The Base configuration is a
future template: its signer and privacy/drain checkpoints are deliberately unset.
The predecessor-policy pin and reviewed checkpoints must be supplied by a
separately approved production release.

## One release entry point

```sh
yarn deploy:orchestrator-v4 base_staging inspect
yarn deploy:orchestrator-v4 base_staging deploy
yarn deploy:orchestrator-v4 base_staging record-drain /path/to/post-pause-drain.json
yarn deploy:orchestrator-v4 base_staging activate
yarn deploy:orchestrator-v4 base_staging verify
yarn deploy:orchestrator-v4 base_staging verify-source
```

Use only the dedicated `STAGING_DEPLOYER_KEY`; it must derive
`0x41123d6419C7b8e44157f6F3b0088442116641eC`. The historical staging signer and
`BASE_DEPLOY_PRIVATE_KEY` are never alternate deployment signers. Inject the key
from its authoritative secret store into the command; do not write it to files
or command arguments. Before broadcast require the exact branch commit's
complete Foundry suite and manually dispatched **Release readiness** workflow,
including coverage and Codecov, to be green.

`inspect` performs only reads and writes a local preflight snapshot. `deploy`
checks the selected chain, derived signer, pinned reused bytecode, wiring,
registry ownership status, payment catalog, witnesses, predecessor configuration
and pending nonce before deploying. Staging deployment writes only fresh contract
state: missing reused-registry ownership is recorded in the manifest and blocks
activation, but does not prevent passive deployment. All production deployment
permission checks remain required. An inactive suite has no registry permission
to lock existing escrow funds, and UPV4 has no replay-registry write permission. It installs the policy as the vault controller,
configures UPV4 methods, selects O4's policy and sets its intent configuration.
`verify` uses a read-only signer, needs no deployment key and requires an active
registered suite with the expected permissions, routes, legacy pauses and privacy.
Use it from the exact release checkout before starting dependent services. It
writes refreshed evidence to the ignored manifest-path `.verification` sidecar,
leaving the committed input manifest unchanged for repeatable clean-checkout gates.
`verify-source`, `record-drain` and unsigned governance preparation also require
no signing key. The manifest is supplied alongside the immutable package;
`verification.active=false` means addresses are deployed but not activated.

`activate` first requires reused-registry ownership, then grants the new writer permissions, removes payment routes in reverse
order, recreates them in their original order with their original currencies,
revokes UPV3's payment-nullifier permission and registers O4 last. Each transition
must match the confirmed transaction prefix. Recovery reconciles mined receipts
first, then validates that prefix before rebroadcasting any pending signed bytes.
Old dispute writers remain enabled.

This staging cutover temporarily removes payment routes while rebuilding them;
coordinate a staging maintenance window. O3 retains its existing lifecycle hook
and pending O3 intents can fulfill through UPV4. UPV4 rejects O1: check that no
O1 intent still needs proof fulfillment before activation. The recorded indexer
checkpoint has no signaled V1 intents at block `52937634`; the corresponding
monotonic V1 counter is `290`. Activation requires V1 to be paused and its counter
to remain `290`, before the first shared write and every following transition.
The historical owner must call `pauseOrchestrator()` before cutover. A changed
counter requires a new drain review and configuration, never a bypass. The model
regression explicitly demonstrates the V1 compatibility boundary. The executed
October 16 O4 is also incompatible with the new verifier: its old 12-field intent
layout is neither the current V4 interface nor the V2 layout selected by its
legacy probe. Its zero-open-intent checkpoint at block `52937634`, counter `38`,
and paused state are required by the same guard. Both old orchestrators remain
registered so historical cancellations and inspection retain their normal paths.

After both pause transactions are confirmed, record an observation block where
both report paused. Wait until the staging indexer reaches that block, then run
this complete query and preserve its unchanged response:

```graphql
query { Intent(where:{status:{_eq:"SIGNALED"}},limit:1000){intentHash orchestratorAddress status} chain_metadata{latest_processed_block} }
```

The JSON passed to `record-drain` contains `pausedAtBlock`, `query` and `response`.
The runner requires the indexer's height to be at least the pause observation,
checks that neither retired address has a signaled intent, rejects truncated
results, and reads both pause states/counters at that observation and at latest.
Any subsequent `Unpaused` event invalidates the evidence and requires another
post-pause query. `activate` validates this evidence before any write or replay.
A snapshot taken before pausing cannot authorize activation. The manifest stores
the full evidence without changing its immutable deployment configuration.

For a future production release the same script deploys under the approved
production signer and governance configuration, transfers single-step ownership
to the configured Safe, and nominates the Safe on the two-step owners.
`prepare-governance` records unsigned Safe calls, including ownership acceptance.
Direct production activation is rejected. Production Safe simulation, proposal
and execution are separate governance operations, never authorized by this
staging release.

The reused relayer registry remains at
`0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E`, owned by
`0xdd93E0f5fC32c86A568d87Cb4f08598f55E980F3` at block `52937550`.
The fresh Pay signal relayer `0xBC6Ca58369853D77a9A2f33358334BF9E9B9094F`
is not whitelisted. Its owner must submit zero-value
`addRelayer(0xBC6Ca58369853D77a9A2f33358334BF9E9B9094F)` to that registry,
calldata `0xdd39f00d000000000000000000000000bc6ca58369853d77a9a2f33358334bf9e9b9094f`,
before concurrent Pay intents are exercised. `allowMultipleIntents` stays false;
serial staging tests do not require this permission. Fulfillment is permissionless
and the isolated fulfillment signer needs no relayer registration.

The [passive deployment plan](../../deployments/orchestrator-v4/passive-deployment-plan.json)
records a Base fork rehearsal: 23 fresh-suite transactions, nonces 26–48 and
13,279,823 execution gas. At block 52938969 the RPC quoted a 0.001 gwei tip
and 0.005 gwei base fee, yielding approximately 0.000079678938 ETH execution
plus 0.000000660751 ETH estimated L1 data fees. Recheck fees, balance and nonce
before live broadcast. Predicted addresses in that plan are explicitly simulated
until confirmed live receipts are recorded. No top-up is needed at the recorded
0.114271057733113262 ETH staging balance.

## Recovery and evidence

The canonical manifest is
`deployments/outputs/orchestrator-v4-base_staging.json`. It includes the source
commit, configuration and hash, complete pre-change snapshot, all signed
transaction hashes and nonces, confirmed receipt blocks/gas, constructor
arguments, runtime hashes and verification results. Standard Hardhat deployment
records are also written for explorer verification and package extraction.

Before broadcasting, the script saves the exact signed transaction in a local
`.pending` file and records its hash in the manifest. Restarting reconciles that
hash or rebroadcasts the same bytes; it does not allocate a second deployment
nonce. EIP-1559 fees use the RPC `eth_maxPriorityFeePerGas` quote as the tip,
with a twice-base-fee cap plus that tip; ethers v5's 1.5 gwei default tip is not
used on Base. An unavailable priority quote or a tip above the RPC's total gas-price
recommendation rejects before signing. A consumed nonce without the expected receipt fails closed. Preserve the
manifest and `.pending` file together. Never delete a partial manifest to retry.
The `.lock` file prevents concurrent release commands. If the process is killed,
confirm that no release process is running, then remove only its stale `.lock`
file before retrying the same command. These local files contain no private key;
they are excluded from commits. Confirmed manifests are committed.

After deployment, `verify-source` submits the exact Hardhat standard JSON compiler
input to [Etherscan V2](https://docs.etherscan.io/api-reference/endpoint/verifysourcecode)
with Base chain ID on every request, polls completion and checks exact compiler,
contract name and constructor arguments on Basescan. It requires an injected
`ETHERSCAN_API_KEY`; it never prints API response text or authenticated URLs.
The older repository Etherscan plugin drops V2 chain selection while polling and
is not used for this release. Confirmed source results are saved in the manifest.
`verify` independently compares on-chain runtime against compiled runtime (only
compiler-declared immutable locations are normalized), deployment transaction
calldata against encoded constructors, and every new dependency, owner,
controller, method catalog, writer set, escrow binding and O4 registration.

The source ABI package includes the six merged V4/V2 artifacts under
`@zkp2p/contracts-v2/abis/contracts`. A local `npm pack --ignore-scripts` tarball
supports branch consumers while the PR remains unmerged. Do not publish from a
branch: the repository's trusted publisher requires canonical `main`. No stale
deployed address is aliased to a new ABI. Executed October 16 records removed
from main by the source rollback are preserved: the bypass stack and
`WhitelistPolicyV4` retain their original names; the old O4, UPV4, DPPV2 and
StakeVaultV2 records use the explicit `Historical20261016` suffix. Each historical
address and source export uses its original deployed ABI. These aliases preserve
existing obligations without presenting the old suite as this release.

## Rollback

Before activation, leave the fresh unregistered suite inert and restore the
previous service revisions; no shared state has changed. During partial
activation, prefer resuming the exact journal to complete the planned staging
transition. Never run an old deployment lane to guess the current state.

After activation, pause new O4 signals and record all open O4 intents and policy
locks before a rollback. Restore client/backend/indexer revisions only in a
coordinated window. The manifest's baseline contains the old UPV3 route for each
payment method, each currency array, payment-nullifier writer set, dispute writer
set and O3 hook. Recreate the old routes in reverse-remove/forward-add order and
restore UPV3's writer permission only after deciding how outstanding O4 intents
will settle. O4 intents cannot fulfill through UPV3. Keep the new policy's dispute
writer permission, vault controller and O4 registration while obligations remain;
do not revoke a controller with live locks. No database wipe, escrow replacement,
deposit rewrite or production action belongs to rollback.

## Consolidation of #356

The unexecuted lane proposal #356 is superseded by the single environment-driven
runner. Its seven-contract constructor/wiring model and 19 acceptance tests are
preserved in `OrchestratorV4StackDeployment.t.sol`, including O3 compatibility,
V1 rejection, whitelist exemptions, group arbitration, stake/deferred settlement,
viewer reads and replay-writer revocation. Its separate lane45/lane46 entry points,
hard-coded pre-rotation owners and duplicated deployment/activation state machines
are replaced by this runner's pinned configuration, transaction journal and
transition checks. The proposed production-specific Safe guard toolchain is not
an executed deployment; future production governance must simulate its exact
unsigned calls before authorization. Historical executed lanes and records are
unchanged. The independent ownership inventory PRs are not closed by this work.

## Confirmed passive deployment

Deployment source: `cd849c5383a274a4c970d7bb6231e032285fd9a2`. All 23 transactions
(nonces 26–48) succeeded at blocks 52939285–52939333. Independent receipt readback
confirmed canonical block hashes, signer and nonce, 13,279,823 execution gas,
0.000079678938 ETH execution fees and 0.000000656081824076 ETH L1 data fees.
The total 0.000080335019824076 ETH exactly equals the signer balance decrease.
The confirmed manifest is `deployments/outputs/orchestrator-v4-base_staging.json`.
The seven ordinary Hardhat records are under `deployments/base_staging/`.

| Contract | Address / Basescan | Deployment transaction | Block |
|---|---|---|---|
| StakeVaultV2 | [`0xa33dE1C8eD627fF5D6d94ABaC462A86b315cFb4e`](https://basescan.org/address/0xa33dE1C8eD627fF5D6d94ABaC462A86b315cFb4e#code) | [transaction](https://basescan.org/tx/0xbd800d5ece6987ea042c20110b7b9f415cf3b04f0c3ca94fca9df178621ba228) | 52939285 |
| AddressGroupRegistryV4 | [`0xE138653725e3602d596ae388D2B2FD05ed1148f3`](https://basescan.org/address/0xE138653725e3602d596ae388D2B2FD05ed1148f3#code) | [transaction](https://basescan.org/tx/0x1f3d44ba9332ffde45d70ba3dbee34a3b806a0e785baf5f8d48f4bf46503e9f3) | 52939287 |
| WhitelistPolicyV2 | [`0xe034B9C59063DBad5F632c38515e75C24F625503`](https://basescan.org/address/0xe034B9C59063DBad5F632c38515e75C24F625503#code) | [transaction](https://basescan.org/tx/0xb4f612d98e5f1e199650622460e23164c511f41828225361da6e76608bf85681) | 52939289 |
| DisputeProtectionPolicyV2 | [`0x3C536cD642cF0ca989899D392fb2c41Bff7A94b1`](https://basescan.org/address/0x3C536cD642cF0ca989899D392fb2c41Bff7A94b1#code) | [transaction](https://basescan.org/tx/0x993696ace583b1e1d4b92055b2afeb0a69ceb109d494748277d8bfeba2c8f4f9) | 52939292 |
| UnifiedPaymentVerifierV4 | [`0x7b1598b98cAC2930DD8D3174C329416848771748`](https://basescan.org/address/0x7b1598b98cAC2930DD8D3174C329416848771748#code) | [transaction](https://basescan.org/tx/0x994b14c6b22114d9bc455c8213c2a91f6a9d20223d5f4b43698cfba4e7776a72) | 52939296 |
| OrchestratorV4 | [`0x7222027313D6D8D7e9BCdD7d2411a228B998C180`](https://basescan.org/address/0x7222027313D6D8D7e9BCdD7d2411a228B998C180#code) | [transaction](https://basescan.org/tx/0xdb508c7f882918a6a7a37f6a0087d124c9ef85e0d3e104f9d7fd80e1899e89db) | 52939329 |
| ProtocolViewerV4 | [`0xEC0131D535160f32601BFca3DfA4B8043eefB56a`](https://basescan.org/address/0xEC0131D535160f32601BFca3DfA4B8043eefB56a#code) | [transaction](https://basescan.org/tx/0x7f4463265990bbadd92ebdac1d42c528b4cbf245cbd0a9bc96b636e4e521d0ca) | 52939333 |

The deployment source passed [complete Foundry CI](https://github.com/zkp2p/zkp2p-contracts/actions/runs/39768499783)
and [full manual Release readiness](https://github.com/zkp2p/zkp2p-contracts/actions/runs/39768543477),
including build/package/localhost, four coverage lanes, floors and Codecov.
Explorer verification is a separate operation: its exact-source results are
recorded in the manifest after the explorer API exposes matching source and
constructor metadata. Deployed bytecode and constructor transaction checks already
passed independently of explorer indexing.

### Immutable package and activation evidence

`0.4.4-rc.8` is an immutable branch tarball containing the seven confirmed passive
addresses and source ABIs. All 41 pre-existing staging exports remain semantically
unchanged; historical aliases retain their deployed ABIs. No npm tag is changed.
The package's record/export commit differs from `manifest.sourceCommit`, which
remains the exact deployment and compilation source above.

Services may build against this passive artifact while activation is pending.
Before starting them, use a clean checkout of that exact record/export commit and
run `yarn deploy:orchestrator-v4 base_staging verify` without a signing key. It
accepts the committed passive manifest as input, independently requires live
active registration, routes, writers, privacy and paused predecessor state, and
writes `orchestrator-v4-base_staging.json.verification` with `active=true`. That
ignored receipt does not dirty the checkout. Do not reject the passive input's
`active=false` before running the verifier. Later activation receipts and drain
evidence belong to the deployment record; they do not require rebuilding every
consumer solely to change an activation flag. Protected source-path equivalence
remains enforced by the canonical runner.

## Release checklist

- [x] Identify merged contract source and affected ABI changes.
- [x] Verify migrated deployer address against authoritative credential and live ownership.
- [x] Capture live reused contracts and configuration before any release broadcast.
- [x] Implement one resumable environment-configured release runner.
- [x] Exercise permission rejection and partial-deployment/activation recovery locally.
- [ ] Required staging registry ownership migrated.
- [ ] V1 and October 16 O4 paused with reviewed zero-open-intent checkpoints and unchanged counters.
- [ ] Fresh Pay signal relayer registered before concurrent Pay testing.
- [x] Exact deployment SHA complete Foundry and Release readiness checks green.
- [x] Fresh staging suite passively deployed and independently verified.
- [ ] Fresh staging suite activated after ownership, drain and privacy gates.
- [ ] Basescan source and constructor verification complete.
- [ ] Confirmed manifest, addresses, transactions and blocks recorded in PR.
- [ ] Downstream services deployed against the fresh addresses and start blocks.
- [ ] Real staging quote/signal/payment verification/fulfillment traced end to end.
- [x] Canonical PR #362 remains open; superseded deployment PR #356 linked and closed.
