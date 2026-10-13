# Staging bypass replacement through lanes 45 and 46

Source-only, not executed. The staging trio deployed on 2026-10-11 and activated on 2026-10-12 is now abandoned.
`base_staging` is a staging namespace on Base chain 8453. Base production remains pending and unchanged.
The same lanes, tags, flags and `StakeVaultBypass`, `DisputeProtectionPolicyBypass`, and
`IntentLifecycleHookV1Bypass` record names replace only that dispute trio. UPV4, its record, payment routes,
currencies, method order, NRV2 sole writer, and the August predecessor remain unchanged.

## Operator sequence

Compile the current artifacts before live work; the tagged runner uses `--no-compile`. Every trio artifact must
have compiler source hashes matching the checkout, and the policy executable runtime must differ from the
abandoned policy. Live authorization is separate from this source change.

Supply these variable names through the approved environment, with no values committed here:
`ALCHEMY_API_KEY`, `BASE_DEPLOY_PRIVATE_KEY`. The package commands set their existing `DEPLOY_ACTIVE_TAG`.
For each activation invocation, select exactly one mode and unset the other mode. Both prepare and execute
require `CONFIRM_STAGING_V3_DISPUTE_BYPASS_ACTIVATION` and
`CONFIRM_STAGING_V3_DISPUTE_BYPASS_DOWNSTREAM_READY`, exactly as ordinary lane 46 does.

First run the read-only check with `PREPARE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION` and both confirmation
variables supplied. Unset `ENABLE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION`:

```sh
yarn deploy:dispute-bypass-activation:base_staging
```

It prints every remaining replacement action across both lanes in order and checks the abandoned policy's
activity. It never deletes records or sends transactions. A refusal is reported before execution.

The two execution commands, in order, are:

```sh
yarn deploy:dispute-bypass-stack:base_staging
yarn deploy:dispute-bypass-activation:base_staging
```

The first requires `ENABLE_STAGING_V3_DISPUTE_BYPASS_STACK_DEPLOYMENT`. It prints remaining actions while
completing steps 1-7 below, then prints `Lane 45 replacement deploy-only steps complete; run lane 46 next.`
The second requires `ENABLE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION` and both confirmation variables, with
`PREPARE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION` unset. It refuses with `run lane 45 first` if any deploy-only
step remains. It performs steps 8-10, then prints `Staging bypass replacement active; recording PR required for
pins, evidence and outputs.` and the block-pinned snapshot.

Finally switch back to `PREPARE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION`, unset the execute variable, retain both
confirmation variables and repeat the read-only command. It requires the fresh-trio snapshot to reduce to exactly
`active` and prints the same completion message and snapshot. Before completion it prints remaining actions.
Neither command creates a Safe batch or changes the UPV4 record. Untagged lane 45 skips; lane 46 keeps its
existing tag and action-flag validation. Base and local branches never dispatch to the replacement executor,
which independently rejects every network except `base_staging` before accessing RPC.

## Steps and resumability

Lane 45 owns steps 1-7. Lane 46 owns steps 8-10.

1. Deploy `StakeVault(governance, USDC, address(0), BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY)` as `StakeVaultBypass`.
2. Deploy `DisputeProtectionPolicy(governance, newVault, disputeVerifier, disputeRegistry)` as `DisputeProtectionPolicyBypass`.
3. Call new vault `initializeController(newPolicy)`. As in lane 45, if permissionless deposits prevent initialization,
   call `proposeController(newPolicy)` and resume with new policy `acceptVaultController()` (zero delay).
4. Deploy `IntentLifecycleHookV1(orchestratorRegistry, WhitelistPolicyMethodScoped, newPolicy)` as `IntentLifecycleHookV1Bypass`.
5. Call new policy `setLifecycleHookAuthorization(newHook, true)`.
6. Call new policy `setRiskWindow(keccak256("paypal"), pinnedWindow)`.
7. Call new policy `setRiskWindow(keccak256("venmo"), pinnedWindow)`.
8. Call dispute registry `addWritePermission(newPolicy)`.
9. Call O3 `setLifecycleHook(newHook)`.
10. Call dispute registry `removeWritePermission(supersededPolicy)` only after the historical policy log scan passes.

Delay, method ordering, constructors' dependency pins, governance, and windows reuse lane-45 constants.
The policy activity scan reuses lane 37's decoder/classifier and starts at the old receipt's block `52483257`,
pinned independently of the record overwritten by step 2. Unknown events also fail closed.
It scans the superseded policy only; the lane never pauses, deauthorizes, drains, or edits the superseded trio.

If the superseded policy shows activity, or gains any before the hook switch, lane 45 completes steps 1-7 and
lane 46 completes steps 8-9, then refuses step 10 on every rerun. That state is safe (the new hook is mounted and the writers are the August
predecessor, the superseded policy and the new policy), but neither the lane nor its prepare-mode verification can
reach `active` from it. Removing or keeping the superseded writer is then a separate owner decision; do not record
the run as complete until it is made. Run prepare mode first: it reports the refusal before anything is sent.

A missing record or a record at its historical superseded address means that deployment step is incomplete.
Any replacement record must match the canonical build and chain; getters re-verify its dependencies, ownership,
controller, hook authorization, and windows. Completed steps must form a contiguous prefix. Gaps, unexpected
writers, or a hook other than the superseded/replacement hook stop the run.

For each deployment, delete only that canonical deployment record before asking hardhat-deploy to deploy.
This prevents identical vault creation arguments from reusing the old address. Require `newlyDeployed === true`
and an address different from the superseded one. An interruption between deletion and deployment resumes from
an absent record. Hardhat-deploy saves the new receipt normally. No UPV4 deployment/save/delete occurs.

The executor re-reads state after every transaction. It compares the pending deployer nonce across preflight and
submission, supplies that nonce to deployment, and uses lane 38's call/gas/balance preflight for contract calls.
A nonce change aborts. The controller fallback may take two transactions within step 3.

## Preflight and final reads

Every pass checks the network/chain and pinned governance signer. The existing UPV4 payment-binding verifier
checks its record/runtime, ownership/dependencies/methods, NRV2's sole writer, legacy replay permissions,
attestation witnesses, O3 registration/ownership, and every route/currency/order. Additional checks pin dispute,
whitelist and August predecessor records/runtime; verify dispute-registry governance and retained August writer;
reject stale vault, policy and hook artifacts; and verify the mounted hook and the replacement prefix.

After completion, the same read-only command prints a block-pinned snapshot and requires the existing
`reduceBypassActivation` result to be exactly `active` using the new trio addresses and the unchanged August
predecessor. The snapshot reads:

- New vault `owner`, `pendingOwner`, `stakeToken`, `controller`, `pendingController`, `pendingControllerValidAt`,
  `controllerChangeDelay`: governance, zero, pinned USDC, new policy, zero, zero, zero.
- New policy `owner`, `pendingOwner`, `admissionsPaused`, `stakeVault`, `disputeVerifier`,
  `disputeNullifierRegistry`, authorization history and `getRiskWindow`: governance, zero, false, expected
  dependencies, only the new hook, pinned PayPal/Venmo windows and zero on all other listed rails.
- New hook `orchestratorRegistry`, `whitelistPolicy`, `disputeProtectionPolicy`: unchanged shared dependencies
  and the new policy. O3 `lifecycleHook`: the new hook.
- Dispute registry `getWriters`: exactly `[August predecessor, newPolicy]`. Adding first yields
  `[August predecessor, supersededPolicy, newPolicy]`; swap-and-pop removal at index 1 yields the required order.
- NRV2 `getWriters`: exactly `[UPV4]`; payment registry methods, verifiers and currencies unchanged.
- The remaining ownership, shared dependencies and August predecessor fields required by lane 46's reducer.

The reducer's deposit inventory is not evaluated by this replacement (reported `ok: false`, empty inventory).
Lane 46 does not gate its `active` row on inventory. This replacement intentionally does not migrate old policy opt-outs.

## Recording PR and interim behavior

Replacement routing is enabled while all three `BYPASS_RECORDED_DEPLOYMENTS.base_staging` address pins equal
`SUPERSEDED` in `deployments/stagingBypassReplacement.ts`. Whether replacement work is pending comes from the
live contiguous step prefix: missing or abandoned trio records and any unfinished configuration or activation
step keep it pending. Updating records alone cannot retire routing. After execution the same module verifies
completion while the old pins remain. A partially updated set of pins fails closed. Once all three recorded pins
name fresh addresses, replacement dispatch is inert and ordinary lanes 45/46 verify prepared and active state
using the recorded address/runtime pins, without inspecting the abandoned policy or requiring its old artifacts.

Record only after successful execution, in a separate PR. The file list is:

- `deployments/base_staging/StakeVaultBypass.json`: generated fresh vault record and receipt.
- `deployments/base_staging/DisputeProtectionPolicyBypass.json`: generated fresh policy record and receipt.
- `deployments/base_staging/IntentLifecycleHookV1Bypass.json`: generated fresh hook record and receipt.
- `deployments/bypassDisputeStack.ts`: the three staging `BYPASS_RECORDED_DEPLOYMENTS` address/runtime pins only.
- `deployments/dispute-stack-evidence.json`: staging execution provenance, trio addresses and artifact hashes.
- `deployments/outputs/baseStagingContracts.ts`: regenerated trio aliases and by-name exports.
- `scripts/test-bypass-dispute-deployment.cjs`: update the staging recorded-address/runtime expectations.
- `scripts/active-dispute-stack.spec.cjs`: update the staging recorded-address/runtime expectations.
  Replacement tests use explicit abandoned-address fixtures, which remain historical rather than becoming
  fresh-address expectations.
- `CLAUDE.md`, `AGENTS.md`, `README.md`: update lane 45/46 execution entries.
- `docs/staging-bypass-replacement.md`: update this tracked, otherwise gitignored operator note with actual status.

Solc inputs under `deployments/base_staging/solcInputs/` stay gitignored. UPV4's record and pin stay unchanged.
`deployments/active-dispute-stack.json` already selects the same record names. `PREDECESSOR_DISPUTE_STACKS`
and `BYPASS_EXPECTED_LIVE` still identify the retained August predecessor. No Base records change. Package
outputs and publication remain a separate boundary.

Between execution and recording, tagged lane 45 checks the completed replacement state and tagged lane 46
prepare mode performs final verification despite stale trio pins. If activation is still pending, lane 45 reports
lane 46 next and lane 46 resumes. The lane-45 deployment flag is still required in this interval. Avoid broad
untagged deployment from lane 45's first transaction until the recording PR merges: other mounted checks and
output/package extraction are not a substitute for recording. Lane 31 continues verifying the unchanged UPV4
binding independently of trio pins.

The lane-30 wrapper's managed-hook guard (`deployments/managedDisputeLifecycleHook.ts`) identifies O3's hook
only through the August predecessor pin and the canonical `IntentLifecycleHookV1Bypass` record. Between the two
lanes that record already names the fresh hook while O3 still mounts the abandoned one, and after the switch a
checkout without the fresh records still names the abandoned hook. While all three recorded pins name the
abandoned trio, the guard therefore verifies the abandoned hook by its recorded address and runtime pin and
throws on any other staging hook it cannot verify. Lane 30 then cannot reset O3 to `WhitelistLifecycleHook`,
including under `ENABLE_STAGING_V3_GROUPS_CUTOVER`. After the switch, an untagged staging run from a checkout
without the fresh records fails at lane 30 until the recording PR merges. Base and local networks never reach
that branch.

The recording PR may delete the replacement machinery after updating all three records and pins, without
changing subsequent ordinary staging verification or Base behavior. Delete both
`deployments/stagingBypassReplacementExecution.ts` and `deployments/stagingBypassReplacement.ts` (including
abandoned pins), remove the guarded dispatch blocks from lane 45's entry and prepared check and lane 46's
staging entry, remove the staging branch of the lane-30 managed-hook guard and its
`managed-hook-staging-replacement` scenario (`scripts/test-v3-groups-base-deployment.cjs` and the
`test:v3-groups-deployment` chain), remove their explicit TypeScript project entries, and remove or adapt the
replacement-specific script tests and their package/typecheck references. The local Foundry continuity tests
can remain independently. Do not delete either module while leaving its guarded imports behind. No runner mount
or production logic needs changing for this cleanup. Finish it before Base executes lane 45: lanes 45/46 become
immutable at their first production execution, and `deploy/45_*` and `deploy/46_*` are protected paths for a
generated Base cutover batch, so dispatch blocks still present then stay in the lanes and keep both modules
with them.

The Foundry continuity case admits protected intents before switching and proves cancellation/settlement still
use the old hook and vault. Such activity prevents the real replacement's final writer-removal step; that test
retains the writer at the switch prefix. It does not claim activity can pass the removal gate.
