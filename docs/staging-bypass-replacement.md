# Lane 47: staging bypass replacement

Source-only, not executed. `base_staging` is a staging namespace on Base chain 8453, not a separate testnet.
Base production uses lanes 45/46 unchanged. Lane 47 replaces only the staging dispute trio under the existing
`StakeVaultBypass`, `DisputeProtectionPolicyBypass`, and `IntentLifecycleHookV1Bypass` record names.
UPV4, its record, payment routes/currencies/order, NRV2 writers, and the August predecessor stay unchanged.

## Prepare and execute

Use the compiled policy artifact containing the stake-owner change. The tagged runner uses `--no-compile`.
The lane rejects executable runtime identical to the superseded policy, ignoring metadata and immutable slots,
and any vault, policy or hook artifact whose compiler metadata does not match this checkout's `contracts/` sources.

Supply `ALCHEMY_API_KEY` and `BASE_DEPLOY_PRIVATE_KEY` externally through the approved environment. Keep the local
`.env` dummy copy unchanged. Each command below names its required variables without providing their values.
Set the selected mode variable to `true`; the other mode must be unset. The package script supplies
`DEPLOY_ACTIVE_TAG=47_replace_staging_bypass_stack` through `scripts/deployActive.ts`.

Read-only preparation (also the post-run verification command):

```sh
env -u ENABLE_STAGING_V3_DISPUTE_BYPASS_REPLACEMENT \
  ALCHEMY_API_KEY="$ALCHEMY_API_KEY" \
  BASE_DEPLOY_PRIVATE_KEY="$BASE_DEPLOY_PRIVATE_KEY" \
  PREPARE_STAGING_V3_DISPUTE_BYPASS_REPLACEMENT="$PREPARE_STAGING_V3_DISPUTE_BYPASS_REPLACEMENT" \
  yarn deploy:dispute-bypass-replacement:base_staging
```

Execution, only after separate live authorization:

```sh
env -u PREPARE_STAGING_V3_DISPUTE_BYPASS_REPLACEMENT \
  ALCHEMY_API_KEY="$ALCHEMY_API_KEY" \
  BASE_DEPLOY_PRIVATE_KEY="$BASE_DEPLOY_PRIVATE_KEY" \
  ENABLE_STAGING_V3_DISPUTE_BYPASS_REPLACEMENT="$ENABLE_STAGING_V3_DISPUTE_BYPASS_REPLACEMENT" \
  yarn deploy:dispute-bypass-replacement:base_staging
```

No confirmation flags from lane 46 apply. Untagged runs skip lane 47, even with a mode flag set. Tagged `base`
runs throw before any RPC access; other networks skip. Tagged staging runs require exactly one mode flag.
Preparation reads and prints remaining steps; it neither deletes deployment records nor sends transactions.

## Steps and resumability

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
Lane 46 does not gate its `active` row on inventory. This lane intentionally does not migrate old policy opt-outs.

## Recording PR and interim behavior

Record only after successful execution, in a separate PR:

- `deployments/base_staging/StakeVaultBypass.json`, `DisputeProtectionPolicyBypass.json`, and
  `IntentLifecycleHookV1Bypass.json`: generated replacement records and receipts.
- Solc inputs under `deployments/base_staging/solcInputs/` are gitignored and are not part of the recording PR.
- `deployments/bypassDisputeStack.ts`: update only the three staging `BYPASS_RECORDED_DEPLOYMENTS` address/runtime
  pins. UPV4 and `BYPASS_EXPECTED_LIVE` (the August predecessor) remain unchanged.
- `deployments/dispute-stack-evidence.json`: staging execution provenance, trio addresses and artifact hashes.
- `deployments/outputs/baseStagingContracts.ts`: regenerate and canonicalize trio aliases and by-name exports.
- `scripts/test-bypass-dispute-deployment.cjs`: update the staging recorded-pin expectations.
- `AGENTS.md`, `CLAUDE.md`, `README.md`, and this lane note: record actual execution source/transactions/status.
- Archive transaction/block/postcondition evidence in a new `deployments/outputs/` recording file.

`deployments/active-dispute-stack.json` already selects these three record names, so no alias flip is required.
`PREDECESSOR_DISPUTE_STACKS` still identifies the retained August predecessor; do not replace it with the abandoned
trio. `BYPASS_EXPECTED_LIVE` and lane 45/46 sources stay unchanged. No Base files change.
Package generation later refreshes `packages/contracts/addresses/baseStaging.json` and generated manifest/runtime
metadata from the recorded output; package release is a separate boundary, not a lane-47 side effect.

Between execution and recording:

- Tagged lane 47 resumes/verifies independently of the three stale recorded pins.
- Tagged lane 45 detects the new policy writer and enters lane 46's record loader; lane 46's own tagged run also
  uses that loader. Both fail on `StakeVaultBypass deployment address mismatch` until pins are recorded.
- Untagged deployment skips 45/46/47. Lane 30 can recognize the new hook in the deploying checkout through matching
  canonical build evidence; a different build-cache checkout without its new runtime pin fails closed. Lane 31
  verifies unchanged UPV4 independently of trio pins. Do not assume the untagged command is a recording gate:
  if all mounted lanes pass, `yarn deploy:base_staging` proceeds to export/canonicalize output and extract package
  files despite the stale dispute pins/evidence. Complete the recording PR before using that broad command.

The Foundry continuity case admits protected intents before switching and proves cancellation/settlement still
use the old hook and vault. Such activity intentionally prevents the real lane's final writer-removal step;
that test stops at the switch prefix and retains the writer. It does not claim activity can pass the removal gate.
