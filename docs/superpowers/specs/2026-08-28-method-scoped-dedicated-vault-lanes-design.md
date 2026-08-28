# Method-scoped dispute stack on a dedicated StakeVault — lanes 39 and 40

**Date:** 2026-08-28 · **Status:** approved by the user in chat (names, deferred OptIn writer removal, abandoned old stake)
**Supersedes:** the vault-reuse decision in `2026-08-27-rail-aware-default-dispute-protection-design.md` and the rotation design in `2026-08-27-method-scoped-dispute-activation-lane-design.md` (lane 38).

## Problem

Lane 37 bound the method-scoped `DisputeProtectionPolicy` to the *reused* predecessor `StakeVault`, so activating it requires the vault's two-step controller rotation with a hard-coded 2-day `controllerChangeDelay` (172 800 s, `MIN_CONTROLLER_CHANGE_DELAY` = 1 day). Lane 38 implements that rotation; on 2026-08-27 it proposed the controller on Base staging (acceptable from 2026-08-29 ~22:03 UTC) and queued the Base rotation batch (Safe nonce 77, `0x70026df2…3992`). The delay makes the contracts cutover and the client (indexer/curator) address sync impossible to coordinate as one change.

`DisputeProtectionPolicy.stakeVault` and `IntentLifecycleHookV1.disputeProtectionPolicy` are `immutable`, so a new vault means a fresh vault + policy + hook trio.

## Decisions (user, 2026-08-28)

1. Deploy a **fresh `StakeVault`** (same contract, new instance) on both networks and use it everywhere. Old vaults (`StakeVaultOptIn` on Base, the lane-32 `StakeVault` on Base staging) and their stake are **abandoned**: stakers withdraw from the old vault once their locks release; takers re-stake in the new vault. No compatibility with the old addresses.
2. Record names: **`StakeVaultMethodScoped`** (free on both live networks; canonical package key `StakeVault` aliases to it after activation), **`DisputeProtectionPolicyMethodScopedStaked`**, **`IntentLifecycleHookV1MethodScopedStaked`** (today's `…MethodScoped` policy/hook records from lane 37 are immutable artifacts and are dropped, never activated). `WhitelistPolicyMethodScoped` (lane 36) is reused unchanged; the Base whitelist bootstrap queued at Safe nonces 78–83 stays valid.
3. The OptIn policy's `DisputeNullifierRegistry` writer permission is **removed in a deferred follow-up batch**, never in the cutover. Base OptIn currently has two `SETTLED` coverage locks (release-eligible 2026-09-07 22:10 UTC and 2026-09-10 11:30 UTC); maturity does not release a lock, and `submitDispute` needs the registry writer, so the condition is operational, not a date: release every matured predecessor intent (`…_RELEASE_MATURED`), then require every predecessor-opened intent terminal and every predecessor-vault lock zero at execution time (guard-bound).
4. **Lane 38 is retired unexecuted on Base** (pinned at its current digest, `activeSource: null`, tags refused). Its queued Safe proposals at nonce 77 (`0x70026df2…3992`, and the older `0x4929…9266` / `0x4d44…836f`) must be rejected by the owners. On Base staging the lane-32 policy stays `admissionsPaused` (it is being replaced) and the staging vault's dangling `pendingController` proposal is left alone (harmless; the fresh policy never calls `acceptController`).
5. Lane 37's localhost wrapper is retired too (`activeSource: null`): lane 39 deploys and activates the local stack from now on.

## Lane 39: `deploy/39_deploy_method_scoped_vault_stack.ts`

Deploy-only on live networks; deploy + activate on `localhost`/`hardhat`. It is lane 37's existing localhost fresh-vault path promoted to live networks, with lane 37's live preflight and resumability model.

- Flags: `ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT=true` / `ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT=true`; untagged live runs skip; `dependencies: []`.
- Deployments (deployer EOA, in order; each resumable and canonical-checked if the record already exists):
  1. `StakeVaultMethodScoped` = `StakeVault(deployer, USDC, address(0), 172800)`.
  2. `DisputeProtectionPolicyMethodScopedStaked` = `DisputeProtectionPolicy(deployer, vault, pinned DisputeVerifier, pinned DisputeNullifierRegistry)`.
  3. `IntentLifecycleHookV1MethodScopedStaked` = `IntentLifecycleHookV1(pinned OrchestratorRegistry, WhitelistPolicyMethodScoped record, policy)`.
- Configuration steps (deployer, resumable): `vault.initializeController(policy)`; `policy.setLifecycleHookAuthorization(hook, true)`; `policy.setRiskWindow` = `DISPUTE_RISK_WINDOW[network]` for `getRiskWindowPaymentMethods(network)` (paypal, venmo, cashapp; every other rail stays 0); Base only: `vault.transferOwnership(Safe)` and `policy.transferOwnership(Safe)` (both `Ownable2Step` — the Safe accepts inside the lane-40 cutover batch). Staging stays deployer-owned.
- Live preflight (fail closed, from lane 37's `assertLiveSharedState` with the per-network `allowMultipleIntents` pin): OrchestratorV3 governance state, registry owner and writer set == `[predecessor policy]`, O3 hook == predecessor hook, `WhitelistPolicyMethodScoped` record canonical and Safe/deployer-owned, pinned verifier/registry/attestation identities. Predecessor per network = `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS` (Base: OptIn trio; staging: lane-32 stack). Fresh-stack proof: the fresh policy's logs contain only allowed configuration events (lane 37's three event lists).
- Never touches: registry writers, the O3 hook, any V2 deposit hook, lane-37's records.
- Localhost: additionally `registry.addWritePermission(policy)` and `orchestrator.setLifecycleHook(hook)` (as lane 37 did locally); `active-dispute-stack.json` localhost/hardhat select the new names.

## Lane 40: `deploy/40_activate_method_scoped_vault_stack.ts`

Lane 38 without the rotation. Reuses lane 38's exported machinery by import where it is semantics-neutral (`withBlockLagRetry`, `mapWithConcurrency`, block-tag helpers, `deployActivationContract`, `runPinnedSimulation`, `requireStableStagingNonce`, `preflightStagingTransaction`, staging executor shape, `assertActivationArtifactGitState`) and the `deployments/methodScopedActivation.ts` / `activationBatchManifest.ts` / `safeArtifacts.ts` modules, extended rather than forked:

- Snapshot: a new `VaultActivationSnapshot` (lane-38's `ActivationSnapshot` left untouched) with **two vault identities**: `freshVault` (`StakeVaultMethodScoped`: `controller == freshPolicy`, `pendingController == 0`, `pendingControllerValidAt == 0`, `controllerChangeDelay == 172800`, `stakeToken == USDC`, owner/pendingOwner bound per phase) and `predecessorVault` (`predecessorPolicy.stakeVault()` must equal it; used for the predecessor lock proof and the writer-removal guard). Per-network predecessor-vault expectation: Base `pendingController == 0`; staging exactly `pendingController == 0x0173CaA95ecfC1c314C26766FB037d44cc71B42d` (the lane-38 proposal) with predecessor admissions paused — any other pending controller is `unrecognized`. Lock proof (predecessor vault) and depositor inventory are computed; inventory gates the cutover, the lock proof gates only writer removal.
- Reducer phases: `deployed` → (`cutover-pending` on staging between steps) → `active` → `writer-removed` (terminal), plus `unrecognized`. Staging actions in order: `add-fresh-writer` → `set-fresh-hook` → `remove-predecessor-writer` (allowed immediately when the predecessor lock proof is clean — staging lane-32 has zero intents). No pause step, no controller step.
- Base batches (each headed by a freshly deployed guard; postcondition appended in simulation only; manifest v2; artifact pair + superseded archive; verifier in `generation` mode inside the lane and `artifact-child` mode standalone, unchanged git-state rule):
  - **cutover** (`ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_CUTOVER_PREPARATION=true`): `guard.assertReady()` → [`freshVault.acceptOwnership()` iff `owner == deployer && pendingOwner == Safe`] → [`freshPolicy.acceptOwnership()` iff likewise] → `registry.addWritePermission(freshPolicy)` → `orchestrator.setLifecycleHook(freshHook)`. Each acceptance is included conditionally and the guard binds the exact `owner`/`pendingOwner` of both contracts (`expectVaultAcceptOwnership`, `expectPolicyAcceptOwnership`); any partial state other than deployer-owned-with-Safe-pending or Safe-owned is `unrecognized`. Allowed in phase `deployed` only; inventory must be clean; predecessor locks are NOT required to be drained.
  - **writer-removal** (`ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_WRITER_REMOVAL_PREPARATION=true`): `guard.assertReady()` → `registry.removeWritePermission(predecessorPolicy)`. Allowed in phase `active` only when every predecessor-opened intent is terminal and every predecessor-vault lock is zero (guard binds the intent hashes and re-reads their status and `predecessorVault.locks` on-chain); `releaseMaturedPredecessorIntents` remains available under `…_RELEASE_MATURED` to get there.
- Guards: **new files only** — `contracts/mocks/DisputeMethodScopedVaultActivationTypes.sol` (`VaultTrustSurface` with both vault addresses, its own base checks) plus `DisputeMethodScopedVaultCutoverGuard(VaultTrustSurface, bool expectVaultAcceptOwnership, bool expectPolicyAcceptOwnership, InventoryTuple[] tuples, address escrow, uint256 depositCounter)`, `DisputeMethodScopedVaultWriterRemovalGuard(VaultTrustSurface, bytes32[] intentHashes)` and matching postconditions. Every lane-38 contract, type, manifest schema, artifact path, and verifier path stays byte-identical (lane 38's archived artifacts are never re-verified — the lane is retired unexecuted — but nothing about them changes). `allowMultipleIntents` stays pinned per network.
- Confirmations: `CONFIRM_{STAGING,BASE}_V3_DISPUTE_METHOD_SCOPED_VAULT_ACTIVATION`, `…_DOWNSTREAM_READY`, `CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_RELEASE_READY_SHA`, `BASE_FORK_RPC_URL`; tag-only execution; untagged runs skip; local tagged runs throw.
- Scripts: new `deployments/vaultActivationBatchManifest.ts` (manifest v3 for the two vault kinds, same canonical-JSON/sha256 discipline) and new kinds `vault-cutover` / `vault-writer-removal` added to the simulate/verify scripts as additive branches, artifact paths `deployments/outputs/safe-batches/base_method_scoped_vault_{cutover,writer_removal}.json` (+ `.sha256.json`); lane-38 branches untouched. `yarn safe:propose-chunks --start-nonce <n>` proposes each batch as one MultiSend.
- Safe nonce plan (Base): the on-chain nonce is 77 and the bootstrap batches sit at 78–83; rejecting proposals off-chain consumes nothing. The cutover batch is generated against the live nonce and **proposed at 77**, replacing the lane-38 proposals; 78–83 execute after it. That order is safe: un-bootstrapped whitelist tuples are ungated by design and the depositor inventory currently has zero opt-outs, so the hook swap before the bootstrap only leaves the (empty) opt-out set temporarily ungated. The verifier keeps requiring exact nonce equality immediately before execution.

## Retirements and manifests (this PR)

- `deployments/immutableDeploymentLanes.ts`: lane 38 pinned at its current digest, `retired: true`, `activeSource: null`, tags refused; lane 37's entry switches to `activeSource: null` (wrapper file deleted). Lanes 39/40 are mounted and unpinned until their first production execution.
- `active-dispute-stack.json`: localhost/hardhat → the new names; base/base_staging unchanged until the post-cutover recording PR (which also flips `PREDECESSOR_DISPUTE_STACKS`, `dispute-stack-evidence.json`, and aliases the package's `StakeVault`/`DisputeProtectionPolicy`/`IntentLifecycleHookV1` keys to the new records). `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS` is unchanged (still the OptIn trio / lane-32 stack).
- `package.json`: `deploy:dispute-method-scoped-vault:{base_staging,base}`, `deploy:dispute-method-scoped-vault-activation:{base_staging,base}`, `verify:method-scoped-vault:{base_staging,base}` (Etherscan for the three new names); the lane-38 activation scripts are removed.

## Tests

- Lane 39: fake-HRE suite mirroring `scripts/test-method-scoped-deployment.cjs` (skip matrix, preflight drift, resumability per step, deploy-only never touches writers/hook, Base ownership transfers initiated); localhost in-process topology test (fresh vault controller == policy, hook authorized, windows, O3 hook set locally).
- Lane 40: unit suite mirroring `scripts/test-method-scoped-activation.cjs` for the new phases/actions/batches; Foundry tests for the two guards + postconditions; rehearsal (in-process Hardhat) running the staging path end-to-end and the Base cutover then writer-removal batches in one block each; runner test proving 38 is refused and 39/40 mount.
- Localhost gate: fresh `yarn deploy:localhost` deploys and activates the new trio via lane 39, lane 40 skips; tagged lane-40 local run throws.

## Sequencing after merge (with recording checkpoints)

1. Staging: lane 39 (deploy-only) → **recording PR #1** (staging records; pin lanes 39 and 40 at their executed digests — a lane is immutable after any live execution) → lane 40 steps (add writer → set hook → remove lane-32 writer; staging lane-32 has zero intents) — all deployer EOA; Basescan verify; on-chain reads; Slack.
2. Base: lane 39 (deploy-only; vault + policy ownership transfers initiated) → **recording PR #2** (Base records; artifact generation requires a clean worktree at `HEAD == sourceSha`) → lane 40 cutover preparation → standalone verifier (artifact-child protected-path rule below) → propose at nonce 77 → owners execute on Kartik's go (then 78–83) → **recording PR #3** (execution evidence, `active-dispute-stack.json` / `PREDECESSOR_DISPUTE_STACKS` / evidence flips, package alias, RC).
3. Fresh-vault readiness is a precondition of the Base cutover and is attested by `CONFIRM_BASE_…_DOWNSTREAM_READY`: indexer/curator on the new addresses, affected takers re-staked in `StakeVaultMethodScoped` (the fresh policy calls `lockStake` on admission; `stakeOwnerOf` falls back to the taker when no delegation exists), delegations/selections recreated, and any predecessor opt-outs that must persist recreated on the fresh policy (none exist today).
4. Writer-removal batch once every predecessor intent is terminal and the predecessor vault holds no locks (earliest possible: after both OptIn locks are released, i.e. no sooner than 2026-09-10 11:30 UTC unless disputed/released earlier).

## Non-goals

No changes to `StakeVault`, `DisputeProtectionPolicy`, `IntentLifecycleHookV1`, or `WhitelistPolicy` source; no migration of stake or depositor opt-outs from the old stacks; no rollback path to lane 37/38 artifacts.

## Amendment 2026-08-28: cutover deposit-counter floor

The lane-40 vault-cutover guard and fresh-block verifier treat the proof-time `inventory.depositCounter` as a floor:
the live counter must be greater than or equal to the pinned value. `EscrowV2` continues minting deposits between
proof generation and Safe execution, so exact equality made an otherwise valid batch expire immediately. Every
pinned inventory tuple remains equality-bound and is re-checked on-chain against the fresh policy. Deposits created
after the proof cannot carry predecessor opt-outs that the fresh default-on policy would honor; a depositor who needs
an opt-out re-applies it on the fresh policy.

## Amendment 2026-08-28: protected artifact paths

Generation mode remains clean-worktree-only with `HEAD == sourceSha`. Artifact-child verification instead requires
`sourceSha` to be an ancestor of `HEAD` and rejects changes only under `ACTIVATION_PROTECTED_PATHS`, which covers the
lanes, activation and manifest modules, verifier and simulators, contracts, deployment records and pins, and toolchain
configuration that produce or verify all four method-scoped batches. Unrelated CI, documentation, and other
non-protected repository changes no longer force artifact regeneration or a replacement Safe proposal.
