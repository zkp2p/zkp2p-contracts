# Orchestrator V4 staging release

Status: implementation prepared; no new live contracts deployed yet. The four
mutable staging registries still need their owner to transfer control to the
verified staging deployer. The deploy command rejects this state before its
first transaction. Production is unchanged.

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

The environment's escrow, escrow registry, orchestrator registry, payment
registry, relayer registry, replay registries, dispute verifier and attestation
verifier are reused. `deployments/orchestrator-v4/base_staging.json` records every
reused address, deployment transaction, deployment block, runtime hash, payment
method/currency, witness, fee and predecessor hook. The Base configuration is a
future template: its signer is deliberately unset and must be supplied by a
separately approved production release.

## One release entry point

```sh
yarn deploy:orchestrator-v4 base_staging inspect
yarn deploy:orchestrator-v4 base_staging deploy
yarn deploy:orchestrator-v4 base_staging activate
yarn deploy:orchestrator-v4 base_staging verify
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
registry ownership, payment catalog, witnesses, predecessor configuration and
pending nonce before deploying. It installs the policy as the vault controller,
configures UPV4 methods, selects O4's policy and sets its intent configuration.
`activate` grants the new writer permissions, removes payment routes in reverse
order, recreates them in their original order with their original currencies,
revokes UPV3's payment-nullifier permission and registers O4 last. Each transition
must match the confirmed transaction prefix. Old dispute writers remain enabled.

This staging cutover temporarily removes payment routes while rebuilding them;
coordinate a staging maintenance window. O3 retains its existing lifecycle hook
and pending O3 intents can fulfill through UPV4. UPV4 rejects O1: check that no
O1 intent still needs proof fulfillment before activation. The model regression
explicitly demonstrates this compatibility boundary.

For a future production release the same script deploys under the approved
production signer and governance configuration, transfers single-step ownership
to the configured Safe, and nominates the Safe on the two-step owners.
`prepare-governance` records unsigned Safe calls, including ownership acceptance.
Direct production activation is rejected. Production Safe simulation, proposal
and execution are separate governance operations, never authorized by this
staging release.

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
nonce. A consumed nonce without the expected receipt fails closed. Preserve the
manifest and `.pending` file together. Never delete a partial manifest to retry.
The `.lock` file prevents concurrent release commands. If the process is killed,
confirm that no release process is running, then remove only its stale `.lock`
file before retrying the same command. These local files contain no private key;
they are excluded from commits. Confirmed manifests are committed.

After deployment, verify each standard Hardhat record on Basescan with the
repository's `etherscan-verify-with-delay` task and its exact constructor args.
`verify` independently compares on-chain runtime against compiled runtime (only
compiler-declared immutable locations are normalized), deployment transaction
calldata against encoded constructors, and every new dependency, owner,
controller, method catalog, writer set, escrow binding and O4 registration.

The source ABI package includes the six merged V4/V2 artifacts under
`@zkp2p/contracts-v2/abis/contracts`. A local `npm pack --ignore-scripts` tarball
supports branch consumers while the PR remains unmerged. Do not publish from a
branch: the repository's trusted publisher requires canonical `main`. No stale
deployed address is aliased to a new ABI.

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

## Release checklist

- [x] Identify merged contract source and affected ABI changes.
- [x] Verify migrated deployer address against authoritative credential and live ownership.
- [x] Capture live reused contracts and configuration before any release broadcast.
- [x] Implement one resumable environment-configured release runner.
- [x] Exercise permission rejection and partial-deployment/activation recovery locally.
- [ ] Required staging registry ownership migrated.
- [ ] Exact release SHA complete Foundry and Release readiness checks green.
- [ ] Fresh staging suite deployed, activated and independently verified.
- [ ] Basescan source and constructor verification complete.
- [ ] Confirmed manifest, addresses, transactions and blocks recorded in PR.
- [ ] Downstream services deployed against the fresh addresses and start blocks.
- [ ] Real staging quote/signal/payment verification/fulfillment traced end to end.
- [ ] Canonical PR remains open; superseded deployment PR linked and closed.
