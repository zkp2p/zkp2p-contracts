# Method-scoped policy successor lanes

Date: 2026-08-27
Status: approved for implementation on PR #278
Scope: deployment lanes, runner metadata, package alias manifest, bootstrap
tooling, and documentation for the payment-method-scoped `WhitelistPolicy`,
`DisputeProtectionPolicy`, and `IntentLifecycleHookV1` introduced by PR #278
Builds on: `2026-08-20-immutable-production-deployment-lanes-design.md`,
`2026-08-20-dispute-protection-opt-in-cutover-design.md`

## Problem

PR #278 hard-cuts three ABIs to `(escrow, depositId, paymentMethod)` scope.
The contracts backing lanes 29 and 34 are already deployed on Base staging and
Base from the deposit-only interfaces:

| Network | `WhitelistPolicy` (lane 29) | `DisputeProtectionPolicyOptIn` | `IntentLifecycleHookV1OptIn` | `StakeVaultOptIn` |
| --- | --- | --- | --- | --- |
| base | `0xBC53641b4B2504f0061D6a9426C61B8eBE9B4Ff0` | `0xcEc48F7242eDBf02875BB4629115Bd927e1287aA` | `0x71467dCac3B50eeED5A485aC6a70f27B1EAC1970` | `0x4d16F4a9946CfC76b1c1A4B63aa9D94cdA2dbCEB` |
| base_staging | `0x7d9277cb8bb78a51eeaafB7CFF306E7DA4C972fD` | `0x51436B8051cCf52739A2090C29DA208B70eC2663` | `0x3AB0879499b28e03bfcA4F5bC2CBe2070Fba4E36` | `0x01075fdCB8D38fD5A1070db41B3c00DC2459e71e` |

Live state read on 2026-08-27 (public Base RPC):

- Base `OrchestratorV3.lifecycleHook()` is `IntentLifecycleHookV1OptIn`; the
  Base `DisputeNullifierRegistry` writer set is exactly
  `[DisputeProtectionPolicyOptIn]`; `StakeVaultOptIn.totalStaked()` is
  `1105263` with zero `totalClaimable`; the lane-32 Base vault is drained and
  its policy is no longer a writer. The lane-34 stack is the completed,
  active Base dispute stack, not a passive one.
- Base staging `OrchestratorV3.lifecycleHook()` is the lane-32 staging hook
  `0x19D9F0Fcb08C60D8bd0CD061C34eae27eF8b6e65` and the staging writer set is
  exactly `[0x21517b7743E727ae47A66FafF93550B689c15020]`. The staging
  `*OptIn` trio is deployed, deployer-owned, and passive.

Codex review on PR #278 raised four P1 findings. Comment 1 (lane 32 edited) is
already fixed by `b108135`. This design resolves the remaining three:

- lane 34 must not be the lane that deploys the new bytecode;
- lane 29 must not be edited or re-executed against the new bytecode;
- `scripts/bootstrapWhitelistPolicy.ts` must target a tuple-aware policy.

## Decisions

1. **All production-executed lanes are immutable.** Lanes 29 and 34 are
   restored byte-for-byte to `main` and pinned in
   `deployments/immutableDeploymentLanes.ts`. Lane 34 is retired (excluded
   from every supported run, both tags rejected) because its only remaining
   live capability was Base-staging activation of a stack this design
   supersedes. Lane 29 stays mounted: on live networks its `skip` already
   returns `true` for the wired production policy, and lane 30's wrapper
   depends on its tag.
2. **Successors get new lanes and new deployment names.** No deployment
   name that exists under `deployments/base/` or `deployments/base_staging/`
   is reused, so the checked-in artifacts for the live contracts remain
   canonical evidence. The name suffix is `MethodScoped`, which describes
   the behavioral change rather than implying a version bump:
   - lane `36_deploy_method_scoped_whitelist_policy.ts` deploys
     `WhitelistPolicyMethodScoped` (contract `WhitelistPolicy`);
   - lane `37_deploy_method_scoped_dispute_lifecycle_stack.ts` deploys
     `DisputeProtectionPolicyMethodScoped` and
     `IntentLifecycleHookV1MethodScoped` against the **reused** predecessor
     `StakeVault` (amended 2026-08-27 — see the lane-37 section);
     `StakeVaultMethodScoped` is a localhost-only record.
   Deployment names never reach the package: `active-dispute-stack.json`
   maps the canonical `StakeVault` / `DisputeProtectionPolicy` /
   `IntentLifecycleHookV1` keys to whichever internal record is active.
3. **This PR ships deploy-only lanes.** Live-network execution of lanes 36
   and 37 is passive: it deploys and configures fresh contracts, initiates
   Base ownership handover to the Safe, and leaves the orchestrator hook,
   the dispute-registry writer set, and every V2 deposit hook untouched.
   Activation (Base-staging EOA transitions, the Base Safe batch, its fork
   simulation, and the predecessor writer revoke) is a later lane, because
   lane 37 becomes immutable the moment it executes on Base and the
   activation preconditions (indexer/package readiness, drained predecessor
   vault, bootstrapped tuple policy) cannot be met in this PR.
4. **Canonical selection does not move for live networks in this PR.**
   `active-dispute-stack.json` keeps the `*OptIn` records for `base` and
   `base_staging`; it switches `localhost` and `hardhat` to the
   `MethodScoped` records because lane 34 no longer runs there. The
   selection stamps embedded in the committed Base and Base-staging outputs
   therefore do not change, and `dispute-stack-evidence.json` is untouched.
5. **Predecessor evidence is lane-scoped.** `PREDECESSOR_DISPUTE_STACKS`
   keeps describing the predecessor of the currently selected stack (the
   lane-32 stacks) because the lane-30 wrapper, the package's
   `RecognizedPredecessor*` identities, and the lane-34 tooling all read it.
   Lane 37 gets its own pinned map, `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS`:
   on Base the lane-34 `*OptIn` trio plus the active `IntentLifecycleHookV1OptIn`
   hook; on Base staging the lane-32 staging stack, which is what the staging
   orchestrator and registry actually reference. The staging `*OptIn` trio
   is neither predecessor nor successor there and lane 37 must not touch it.
6. **The bootstrap script targets only the tuple-aware policy.** Its default
   and its Base pin resolve `WhitelistPolicyMethodScoped`; it refuses the
   lane-29 `WhitelistPolicy` address explicitly. Until the Base artifact
   exists the script fails closed with a missing-artifact error, which is the
   intended pre-deployment behavior.

## Non-goals

- No Solidity, ABI, or Foundry test change. PR #278's contract diff stands.
- No Safe batch, sidecar, fork simulation, staging transition, or writer
  revoke for the method-scoped stack. No `ENABLE_*_ACTIVATION` flags.
- No change to `deployments/*/*.json`, `deployments/outputs/*`,
  `dispute-stack-evidence.json`, or the Base / Base-staging entries of
  `active-dispute-stack.json`.
- No migration of lane-29 policy state or lane-34 stake. The 1.1 USDC in the
  Base `StakeVaultOptIn` belongs to takers who can `withdraw()` directly; the
  settled intent's coverage lock resolves when its 14-day risk window ends
  (~2026-09-08). Both are activation-lane concerns.
- No package publication and no manifest `version` bump.

## Lane 36: `WhitelistPolicyMethodScoped`

Supported networks: `localhost`, `hardhat`, `base_staging`, `base`.

- Reads `AddressGroupRegistry`, `EscrowRegistry`, `OrchestratorRegistry`,
  `OrchestratorV2`, and `EscrowV2` records. On live networks it also pins
  the expected registry addresses and asserts `OrchestratorV2` is registered
  and `EscrowV2` is whitelisted; it never mutates those registries.
- Deploys `WhitelistPolicyMethodScoped` with constructor
  `[AddressGroupRegistry, EscrowRegistry, OrchestratorRegistry]`, waits for
  the network deployment delay, verifies the three dependency getters, then
  hands ownership to `MULTI_SIG[network] || deployer` through `setNewOwner`
  (plain `Ownable`, so Base ownership moves in the deployment run itself,
  exactly as lane 29 did).
- Existing record: assert canonical (`solcInputHash` and immutable-zeroed
  runtime bytecode match the current build) and reuse; never redeploy.
- Live gating mirrors lane 34: `ENABLE_STAGING_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT=true`
  or `ENABLE_BASE_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT=true`. Without
  the flag the lane skips, except that a tagged run
  (`DEPLOY_ACTIVE_TAG === "36_deploy_method_scoped_whitelist_policy"`)
  throws so an operator cannot silently no-op. Once the record exists the
  lane skips after the canonical check.
- Tags: `36_deploy_method_scoped_whitelist_policy`,
  `MethodScopedWhitelistPolicy`. Dependencies: none, like lanes 34 and 35.
  Declaring `29_deploy_whitelist_policy` would pull `28` and `16` into every
  tagged run, and lane 16 unconditionally re-points the local payment
  registry at UPV2, which breaks lane 31's cutover check for lane 37. Local
  ordering comes from filenames; missing records fail closed through
  `deployments.get`.

## Lane 37: method-scoped dispute lifecycle stack

Modeled on lane 34's deploy-only and local paths; the activation paths are
deliberately absent.

- Deployment names and artifacts: `StakeVaultMethodScoped` → `StakeVault`,
  `DisputeProtectionPolicyMethodScoped` → `DisputeProtectionPolicy`,
  `IntentLifecycleHookV1MethodScoped` → `IntentLifecycleHookV1`. Local-only
  `DisputeNullifierRegistry` and `DisputeVerifier` records are created on
  `localhost`/`hardhat` exactly as lane 34 did.
- **Amended 2026-08-27 — the predecessor `StakeVault` is reused on live
  networks**, replaced only on localhost/hardhat where none exists. See
  `2026-08-27-rail-aware-default-dispute-protection-design.md` ("Deployment
  and tooling" and the vault-controller-rotation activation gate) for the
  rationale: `StakeVault` is unchanged, holds real taker state, and ships
  its own delayed controller handover.
- Constructor wiring: policy `[deployer, predecessorVault, DisputeVerifier,
  DisputeNullifierRegistry]` where all three are the network's pinned live
  contracts from `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS` (on localhost the
  lane deploys local `DisputeNullifierRegistry`, `DisputeVerifier`, and
  `StakeVaultMethodScoped` `[deployer, stakeToken, address(0),
  STAKE_VAULT_CONTROLLER_CHANGE_DELAY]` and initializes the controller
  itself); hook `[OrchestratorRegistry, WhitelistPolicyMethodScoped,
  freshPolicy]`. The whitelist policy is read from the lane-36 record and
  canonical-checked, not address-pinned.
- Live deploy-only step machine, resumable from chain reads:
  `deploy-policy`, `deploy-hook`, `authorize-hook`,
  `set-risk-window:<method>` for each disputable method; Base adds
  `transfer-policy-owner` (`Ownable2Step` transfer to the Safe; acceptance
  belongs to activation). No vault deployment, controller initialization,
  vault ownership transfer, or predecessor cancellation steps.
- Live preflight (`assertLiveSharedState`): deployer identity, stake token,
  controller delay, lane-37 predecessor map via
  `assertHistoricalDisputeStack(hre, METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS)`,
  pinned registries / orchestrator / attestation verifier and their runtime
  hashes, `OrchestratorV3.lifecycleHook()` equals the predecessor hook,
  dispute-registry writer set equals exactly `[predecessorPolicy]`,
  `WhitelistPolicyMethodScoped` present, canonical, and pointing at the
  pinned registries. It does **not** require the predecessor vault to be
  empty (Base holds live stake); emptiness is an activation-lane gate.
- Fresh-stack proof after deployment: the predecessor vault still reports
  `controller == predecessorPolicy` with no pending controller, only the
  fresh hook is authorized on the fresh policy, risk windows equal
  `DISPUTE_RISK_WINDOW`, `policy.stakeVault()` is the pinned predecessor
  vault, and the fresh policy emitted no lifecycle event (configuration and
  governance events are allowed; anything else fails closed). No vault log
  or accounting is inspected — the vault is live. **Amended 2026-08-27** by
  `2026-08-27-rail-aware-default-dispute-protection-design.md`.
- Live gating: `ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_DEPLOYMENT=true` /
  `ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_DEPLOYMENT=true`, same skip and
  tagged-run semantics as lane 36. `paymentBindingCutoverReady` from lane 31
  remains a precondition everywhere, as in lane 34.
- Local path: deploy the five records, initialize the controller, grant the
  fresh policy write permission on the local dispute registry, authorize the
  hook, set risk windows, and `setLifecycleHook` on `OrchestratorV3`. This
  is what makes `yarn deploy:localhost` (release-readiness CI) end on the
  method-scoped topology.
- Tags: `37_deploy_method_scoped_dispute_lifecycle_stack`,
  `V3DisputeMethodScopedStack`. Dependencies: none (same reasoning as lane
  36); a tagged lane-37 run requires the lane-36 record to exist and fails
  closed otherwise. `deploy/deploy_summary.ts` gains both new tags so tagged
  runs still print the summary.
- The lane-30 managed-hook guard (`deployments/managedDisputeLifecycleHook.ts`)
  compared the successor record's artifact bytecode (immutable placeholders)
  to live runtime code, which can never match for `IntentLifecycleHookV1`'s
  three immutables. It now normalizes both sides with the artifact's
  immutable references, and derives the successor's expected whitelist policy
  from the record's constructor arguments instead of assuming the lane-29
  policy.

## Runner and manifest changes

- `IMMUTABLE_DEPLOYMENT_LANES` gains:
  - `29_deploy_whitelist_policy.ts`: `deployedSourceSha`
    `3c4c1306dcce6693cf32300d8917d45c4604b84e` (the PR #237 commit that
    executed on Base, shared with lane 30), `sha256`
    `95ee7660bdb069e1d31ea0e843f557b05f2ea76697766fec0d2146f8ec44d842`,
    `retired: false`, no `activeSource`, tags as in the file.
  - `34_deploy_opt_in_dispute_lifecycle_stack.ts`: `deployedSourceSha`
    `f0ec8b109c36d253486be072e910d54db2432f7e` (PR #269 commit that ran the
    Base deployment; its digest was `37d50a81…`), `sha256`
    `82562509fdf6acbf64c1fe6e1b7a39ff8d08ef324a680231e5b7b6a64243ba17`
    (current bytes: PR #270 relocated the predecessor import after
    execution, and that is the file the runner must protect from now on),
    `activeSource: null`, `retired: true`, tags
    `34_deploy_opt_in_dispute_lifecycle_stack`, `V3DisputeOptInStack`.
- `assertSupportedDeploymentTag` rejects the tags of every retired lane,
  not only lane 32's.
- `active-dispute-stack.json`: `localhost` and `hardhat` select the
  `MethodScoped` records. `activeDisputeStack.cjs` removes every internal
  record name referenced by any network selection (plus the existing
  `OptIn` suffix rule) from published output.
- `package.json`: replace `deploy:dispute-opt-in:*` with
  `deploy:method-scoped-policy:{base_staging,base}` and
  `deploy:dispute-method-scoped:{base_staging,base}`; add
  `verify:method-scoped:{base_staging,base}` etherscan targets for the four
  new names; keep `verify:dispute-opt-in:*` and the lane-34 Safe tooling
  scripts (they operate on executed history). Add
  `test:method-scoped-deployment` and run it from release-readiness CI.
- `tsconfig.dispute-deployment.json` adds lanes 36, 37, and the new test.

## Tests

`scripts/test-method-scoped-deployment.cjs` (`node:test`, offline, fake
HRE — same harness as the lane-34 test):

- lanes 29 and 34 match their pinned digests; a mutated byte fails;
- selection mounts 36 and 37 (tagged and untagged), excludes 34 and 32,
  keeps `32_deploy_deposit_creation_guard.ts`, and rejects all four retired
  tags plus multi-tag input;
- lane 36/37 identity: names, artifact map, tags, dependencies, supported
  networks, and fail-closed skip without the flag / throw under the tag;
- lane 37 step machine: staging count, Base count, contiguous-prefix
  rejection, next-step resolution;
- lane-37 predecessor map exact values for both networks and the invariant
  that Base staging's predecessor equals `PREDECESSOR_DISPUTE_STACKS.base_staging`;
- `deploy_summary` carries the new tags.

Existing suites are updated where their assertions encode the old
selection: `test-opt-in-dispute-lifecycle-deployment.cjs` (lane 34 now
excluded and rejected) and `active-dispute-stack.spec.cjs` (local fixtures
use the `MethodScoped` records). Everything asserting Base or Base-staging
selection, evidence, or predecessor values stays unchanged.

Integration gate: `yarn typecheck:dispute-deployment`,
`yarn test:dispute-lifecycle-deployment`, `yarn test:v3-groups-deployment`,
`yarn test:method-scoped-deployment`, and a full `yarn deploy:localhost`
against a fresh `yarn chain`, ending with `OrchestratorV3.lifecycleHook()`
equal to `IntentLifecycleHookV1MethodScoped`.

## Follow-ups (not this PR)

1. Deploy-only execution of lanes 36 and 37 on Base staging, then Base;
   commit artifacts and regenerated outputs.
2. Bootstrap the tuple policy on both networks with
   `yarn whitelist:bootstrap` (Base via Safe batch).
3. Activation lane: staging EOA transitions; on Base a first Safe batch that
   pauses predecessor admissions and proposes the fresh policy as the reused
   vault's controller, then (after the delay and once no predecessor lock is
   open) a second batch that accepts the fresh policy's ownership, calls
   `acceptVaultController()`, grants the fresh policy writer permission,
   sets the orchestrator hook, and revokes the lane-34 writer only once the
   predecessor policy is fully drained. Flip `active-dispute-stack.json`,
   `PREDECESSOR_DISPUTE_STACKS`, and `dispute-stack-evidence.json` at that
   point, then publish the package.
4. In the same activation PR, pin lane 37 in `immutableDeploymentLanes.ts`
   and retire it (`activeSource: null`, tags rejected), exactly as lane 34
   was retired here: lane 37's `skip` re-runs `assertLiveSharedState`, which
   requires the orchestrator to still be on the predecessor hook and the
   writer set to be exactly the predecessor policy, so after the flip every
   untagged `yarn deploy:base` / `deploy:base_staging` would abort until it
   is excluded from the runner.
