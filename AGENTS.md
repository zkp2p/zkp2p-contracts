# Repository Guidelines

## Project Structure & Module Organization

- `contracts/`: Solidity sources (0.8.18), plus `interfaces/`, `lib/`, `mocks/`, `unifiedVerifier/`.
- `contracts/mocks/`: only what Hardhat must compile. That is the doubles a deploy lane or a Hardhat deployment test
  loads (`USDCMock`, `PythMock`, `PaymentVerifierMock`, `OrchestratorV3SurfaceMock`) and the Safe-batch guard,
  postcondition, and activation-type contracts (`Dispute*`). Every other test double lives in `test-foundry/mocks/`.
- `contracts/archive/`: superseded sources (V1 `Escrow`, `Orchestrator`, `ProtocolViewer`, and
  `PostIntentHookRegistry`; `OrchestratorV2`; the pre-V3 `UnifiedPaymentVerifier`). They stay compiled only because
  executed lanes deploy them on local networks and tests exercise them. Never edit them or base new work on them.
  `contracts/archive/README.md` lists what is there and which lower-numbered sources are still current.
- `deploy/`: Hardhat Deploy scripts, ordered `NN_description.ts` (e.g., `00_deploy_system.ts`).
- `test-foundry/`: the only contract test system, split into `deterministic/`, `fuzz/`, and `invariant/`, with
  shared test doubles in `mocks/`.
- `scripts/`: coverage and deployment-support scripts.
- `deployments/`: Network artifacts and exported addresses; update on live deploys.
- `tasks/`: Custom Hardhat tasks (e.g., Etherscan verification with delay).
- `typechain/`, `artifacts/`, `out/`, `dist/`: Generated output; do not edit by hand.
- A numbered deployment script becomes immutable after any production execution. Never edit that source again;
  add a new numbered lane for new behavior and keep retirement, live-state checks, and active mounting in current
  helpers or runner metadata outside the historical file.

## V3 Lifecycle Deployment Status

- `deploy/30_deploy_v3_lifecycle_stack.ts` is immutable production provenance for the whitelist-only V3 lifecycle
  deployment. The supported runner verifies its deployed-source hash and mounts
  `deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts` under lane 30's filename. That current wrapper
  preserves the exact tags and lane-29 dependency, refuses to roll a verified predecessor or successor dispute hook
  back to `WhitelistLifecycleHook`, and otherwise delegates to the immutable historical implementation.
- Base staging removes only the explicitly drained staging predecessors. Base keeps the existing orchestrators
  registered and queues exactly one Safe call to register the fresh O3. Base execution requires
  `ENABLE_BASE_V3_GROUPS_CUTOVER=true`, a separately approved exact source SHA, and the production governance path.
- Lane `31` is frozen at the PR #313 reconciliation checkpoint and hash-pinned. The runner mounts its current
  wrapper, which verifies the active payment catalog, bytecode-pinned binding, governance, witnesses, and replay
  permissions on Base and Base staging without invoking the historical cutover. Missing artifacts or drift fail
  closed. Local networks retain the historical deployment path. Update live checks in the wrapper, never the
  historical file.
- `deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts` is executable immutable production history, not current
  read-only logic. `scripts/deployActive.ts` verifies its deployed-source hash and excludes the exact file from every
  supported tagged and untagged run; both historical lane-32 tags are rejected. Never invoke the historical file
  directly. Current read-only predecessor address and bytecode checks live in
  `deployments/predecessorDisputeStack.ts`.
- Lane `33` is the independently owned IntentGuardian fee update.
- `deploy/29_deploy_whitelist_policy.ts` is immutable production provenance for the deposit-scoped
  `WhitelistPolicy`. It stays mounted because lane 30 depends on its tag and its `skip` already recognizes the wired
  production policy; its digest is pinned in `deployments/immutableDeploymentLanes.ts`.
- `deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts` is immutable and retired. It deployed and, on Base, activated
  the `*OptIn` dispute stack built from the deposit-only interfaces; the runner verifies its digest, excludes it from
  every supported run, and rejects both of its tags. Its Safe simulation and verification scripts remain as tooling
  for that executed history. Lanes 39/40 superseded the Base `*OptIn` trio on 2026-08-28, and
  `PREDECESSOR_DISPUTE_STACKS` records it as the predecessor of the selected Base stack. The Base-staging `*OptIn`
  trio is deployed but was never activated.
- Lanes `36` and `37` executed deploy-only on Base staging and Base on 2026-08-27 and are immutable (pinned in
  `deployments/immutableDeploymentLanes.ts`). Lane `36` stays mounted behind its canonical-record skip; lane `37` is
  retired for live networks (its preflight requires the predecessor hook, which lane 38 replaces) and is mounted through
  `deployments/activeDeploymentLanes/37_…ts`, a wrapper that delegates to the pinned source only on `localhost`/`hardhat`
  so local deployments keep the method-scoped stack; its tags are refused by the runner. Lane `36`
  deploys `WhitelistPolicyMethodScoped`; lane `37` deploys `DisputeProtectionPolicyMethodScoped` and
  `IntentLifecycleHookV1MethodScoped` against the lane-36 policy, the network's pinned verifier and dispute
  registry, and the pinned predecessor `StakeVault`, which is reused (controller rotation happens in the activation
  lane through the vault's delayed two-step handover); `StakeVaultMethodScoped` is a localhost-only record. `ENABLE_{STAGING,BASE}_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT=true`
  and `ENABLE_{STAGING,BASE}_V3_DISPUTE_METHOD_SCOPED_DEPLOYMENT=true` authorize passive deployment only: the
  OrchestratorV3 hook, the dispute-registry writer set, and every V2 deposit hook stay unchanged, and Base ownership
  handover is initiated for the Safe to accept later. Activation, the predecessor writer revoke, and the canonical
  selection flip belong to a future lane; never infer activation from source, tests, package ABIs, artifacts, or
  deployment. The lane-37 policy is default-on for windowed rails with a depositor opt-out (see the rail-aware
  default design); pre-activation opt-outs are expected and do not invalidate the lane; the live vault is never inspected by it.
- `deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts` is the activation lane for the lane-37 stack. It
  runs only under `DEPLOY_ACTIVE_TAG=38_activate_method_scoped_dispute_lifecycle_stack`; untagged runs skip on
  every network, a tagged local run throws (there is no predecessor stack to activate), and any lane-38 flag
  without the tag throws before the first chain read. Every read is pinned to one block and reduced by
  `reduceActivation` (`deployments/methodScopedActivation.ts`) into `deployed` / `rotation-proposed` / `active`
  or `unrecognized`; an unrecognized state aborts. Base staging advances one deployer-EOA step per run
  (`PREPARE_`/`ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION=true`): pause predecessor admissions,
  propose the fresh policy as vault controller, release matured predecessor intents, accept the controller
  after the delay and only once no predecessor lock is open, add the fresh writer, set the O3 hook, remove the
  predecessor writer. Base emits two unsigned Safe batches, each headed by a freshly deployed on-chain guard
  that binds the full trust surface: rotation (`ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_ROTATION_PREPARATION`)
  = guard, optional `acceptOwnership`, pause predecessor admissions, `proposeController`; cutover
  (`ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_CUTOVER_PREPARATION`, only after the delay with zero live
  predecessor locks and no successor-side violations) = guard, `acceptVaultController`, add fresh writer,
  remove predecessor writer, `setLifecycleHook`. A postcondition contract is appended in the pinned fork
  simulation only. Artifacts live at `deployments/outputs/safe-batches/base_method_scoped_{rotation,cutover}.json`
  with `.sha256.json` sidecars; `yarn verify:method-scoped-safe-batch --batch rotation|cutover` must pass
  immediately before the Safe executes, and no script ever signs. Artifact-child verification permits unrelated
  commits after the recorded source SHA only while every path in `ACTIVATION_PROTECTED_PATHS` remains unchanged.
  Retire lane 37 before activation (its skip
  asserts the predecessor hook is still live), pin lane 38 after its first live transition, and keep the
  `active-dispute-stack.json` / `PREDECESSOR_DISPUTE_STACKS` / evidence flip and the `WhitelistPolicy`
  package alias in recording PRs after each execution — the lane itself flips nothing repo-side.
  Lane 38 executed only its first two Base-staging steps (2026-08-27) and is retired unexecuted on Base: the reused
  vault's two-day controller delay was abandoned in favour of a dedicated vault. Its staging side effects remain live
  (lane-32 policy admissions paused; staging vault `pendingController` = the lane-37 policy) and lane 39 pins exactly
  that state.
- `deploy/39_deploy_method_scoped_vault_stack.ts` deploys `StakeVaultMethodScoped` (a fresh `StakeVault`, aliased to the
  canonical `StakeVault` package key after activation), `DisputeProtectionPolicyMethodScopedStaked`, and
  `IntentLifecycleHookV1MethodScopedStaked` against `WhitelistPolicyMethodScoped` and the pinned verifier/registry, sets
  the vault controller with `initializeController` (no delay), authorizes the hook, applies the windowed-rail risk
  windows, and on Base initiates two-step ownership transfers of vault and policy to the Safe. Flags
  `ENABLE_{STAGING,BASE}_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT=true` authorize deploy-only runs; local networks
  deploy and activate. Old vaults and their stake are abandoned by decision (2026-08-28); the lane-37 policy/hook records
  are immutable history that was never activated. Lane 39 is immutable and pinned after its 2026-08-28 Base execution.
- `deploy/40_activate_method_scoped_vault_stack.ts` activates the lane-39 stack without a rotation: Base staging runs
  add-fresh-writer → set-fresh-hook → remove-predecessor-writer one deployer step per run; Base emits a single guarded
  cutover batch (guard → conditional `acceptOwnership` on vault and policy → add fresh writer → `setLifecycleHook`) and,
  later, a guarded writer-removal batch allowed only when every predecessor-opened intent is terminal and the
  predecessor vault holds no locks. Snapshots carry `freshVault` and `predecessorVault` separately; guards, manifest
  (v3), verifier kinds (`vault-cutover`, `vault-writer-removal`) and artifacts
  (`deployments/outputs/safe-batches/base_method_scoped_vault_*`) are additive to lane 38's, which stay byte-identical.
  The same artifact-child protected-path rule applies to both lane-40 batch kinds; unrelated repository changes do not
  require regeneration when the batch producers and verifiers are unchanged.
  Recording checkpoints: commit live records before any artifact generation, pin lanes 39/40 after their first live
  execution, propose the Base cutover at the live Safe nonce, and flip manifests/package only after execution. Lane 40
  is immutable and pinned after its 2026-08-28 Base execution.
- `deploy/42_retire_dispute_risk_windows.ts` removes payment methods from dispute protection by zeroing their risk
  windows on `DisputeProtectionPolicyMethodScopedStaked`: a zero window makes `onIntentSignaled` a no-op and
  `isDisputeProtectionEnabled` false for that method, and PayPal/Venmo are untouched. Its target is
  `RETIRED_DISPUTABLE_PAYMENT_METHODS` (`cashapp`, decided 2026-08-28), not `DISPUTABLE_PAYMENT_METHODS`, which
  #311 already trimmed to PayPal/Venmo. Live networks run only under `DEPLOY_ACTIVE_TAG=42_retire_dispute_risk_windows`
  (`yarn deploy:dispute-risk-windows:base_staging` executes the deployer-EOA write; `:base` queues one
  `setRiskWindow(cashapp, 0)` Safe call that `deploy_summary` writes under `deployments/outputs/safe-batches/`);
  local networks zero the window right after lane 39, and the lane skips wherever every retired window already reads
  zero. Base executed the call at Safe nonce 80 on 2026-08-28 (safeTxHash `0x16a7…4650`, tx `0x4824…6f8a`, artifacts
  `base_retire_cashapp_risk_window*`, whose Safe origin/description say "lane 41" — the retirement lane's number
  before lane 41 was claimed by the UPI payment method). Base staging executed the deployer-EOA write on 2026-09-02
  (tx `0x5cde17a0c59ba4b606b19b9d09b468af06cd283d256984160e9627aaff4dc451`), so Cash App reads a zero window on both
  networks, the evidence and package manifest carry `0` everywhere, and the lane — immutable and pinned after that
  first execution — stays mounted and skips wherever every retired window already reads zero.
- Lane `43` adds the X Money payment method on Base staging only. Untagged runs are inert; tagged preparation and
  execution are mutually exclusive. It reuses lane 31's payment-binding checks, permitting only the pending
  `xmoney` entry to be absent during preparation. Execution registers it in UPV3 before the registry, requires full
  readiness, then records the snapshot. Production activation is intentionally outside this lane.
- Lane `44` deploys `FxRateStore` and two Chainlink-compatible `FxRateFeed`s, INR/USD (`FxRateFeedInrUsd`) and
  CNY/USD (`FxRateFeedCnyUsd`), each `XXX/USD` with 8 decimals. Curator's `fx-rate-push` job writes them from
  ExchangeRate-API.
  - **One shared set on Base:** the lane skips `base_staging`. Live Base runs need
    `DEPLOY_ACTIVE_TAG=44_deploy_fx_rate_feeds` and `ENABLE_BASE_FX_RATE_FEEDS_DEPLOYMENT=true`. An untagged Base
    run skips the lane.
  - **Preflight, then steps:** the lane checks every input before its first transaction: live flag,
    `FX_RATE_UPDATER.base`, and the `FX_RATE_SEED_*` env seeds. It then deploys only missing names, registers and
    seeds both feeds, and hands ownership to `MULTI_SIG.base` with a single `Ownable` transfer, so no Safe accept is
    needed.
  - **Reruns only verify:** they check code, the exact updater, limits, seeded rounds, feed sources and owners, and
    throw on any drift.
  - **Local networks** keep deployer ownership and use `accounts[1]` as the updater.
  - **Contract guarantee:** the updater can't publish a price more than 5% away from any price shown in the last
    24 hours. That window is 25 hourly buckets on block time plus the latest price. Only the Safe can `seedFeed`
    outside the band. Its `emergencyStop` zeroes the updater and locks the feeds.
  - **Package:** feed addresses join `oracleFeeds` (`provider: "zkp2p"`) only in release B, after keeper rounds
    land.
  - **Base execution (2026-10-01):** run from `88be796` (#325 + #326) by deployer `0x84e1…1929` (nonces
    15421–15430, all successful). Addresses:
    - `FxRateStore` `0x389206956C57bdB5d07FF78AB3D1e1DEED070b9c`
    - `FxRateFeedInrUsd` `0x053A03F1704aE3F71082D3cDFD50BC830415A326`
    - `FxRateFeedCnyUsd` `0xc034d806DbeA6b13980D94174eA5FF83E1C191C3`

    Seeds came from the ExchangeRate-API snapshot at 14:45:02 UTC: INR/USD `1038964` and CNY/USD `14889617`. Both
    were written before the three `transferOwnership` calls to `MULTI_SIG.base`. The updater is
    `0x81630fb1ab2A7Eab137888b9746b66889f78F091`. All three contracts are Basescan-verified. The lane is immutable
    and pinned in `deployments/immutableDeploymentLanes.ts`.
- `deploy/45_deploy_bypass_dispute_stack.ts` is retargeted to `StakeVaultV2` (zero controller delay),
  `DisputeProtectionPolicyV2`, `IntentLifecycleHookV2`, `UnifiedPaymentVerifierV4` and `OrchestratorV4`.
  This cascade/O4 source has not executed on Base or Base staging. The existing tag and
  `ENABLE_{STAGING,BASE}_V3_DISPUTE_BYPASS_STACK_DEPLOYMENT=true` select resumable deploy-only steps.
  Lane 45 initializes the vault controller, authorizes HookV2, configures O4
  with O3's registries, fees and `allowMultipleIntents`. O4 stays unregistered; Base starts vault/policy
  two-step ownership transfers and transfers UPV4/O4 ownership directly to the Safe.
  Only the exact superseded staging UPV4 address `0x3fe38Afdfa85A9E14D9b0ae5A5B2E577A8a71DA7` with its
  pinned runtime hash may be replaced. Lane 45 deletes that record and deploys a different address.
  Pre-cutover binding checks use the pinned retired verifier independently of the mutable record, including
  after a crash between deletion and deployment; other identity or runtime mismatches fail closed.
  The cascade policy protects stake-token settlements with a nonzero attested window; it has no per-method
  windows, admissions pause, or per-deposit opt-out. Lanes 45/46 neither configure nor verify those removed fields.
  Historical lane 45 first executed on staging on 2026-10-11 from `f9eab7f`. The stake-owner bypass trio
  replaced that first trio on 2026-10-13 from `285bc5c`; UPV4 and its record were unchanged by that run.
- `deploy/46_activate_bypass_dispute_stack.ts` activates the cascade stack with O4 registration last.
  O3 stays registered with its August hook on Base/local; staging restores that hook as its first action.
  Lane 46 adds the cascade dispute writer, makes fresh UPV4 the sole `NullifierRegistryV2` writer and
  routes every method to it with identical currencies and method order (reverse-remove, in-order-add).
  Existing dispute writers remain passive, including staging's superseded bypass policy. Every PENDING
  intent opened by that stale policy blocks verifier rotation and every later action, including staked
  intents that could switch to no-stake; cancel or prune them before continuing.
  Live runs require `DEPLOY_ACTIVE_TAG=46_activate_bypass_dispute_stack`. Staging runs lane 45 first
  (it reports open stale intents), then lane 46 `ENABLE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION=true` with
  both `CONFIRM_STAGING_V3_DISPUTE_BYPASS_ACTIVATION` and
  `CONFIRM_STAGING_V3_DISPUTE_BYPASS_DOWNSTREAM_READY` set to `true`, then lane 46
  `PREPARE_STAGING_V3_DISPUTE_BYPASS_ACTIVATION=true` to verify `active`. Do not prepare lane 46 first.
  Keep one build through deployment and verification; avoid untagged staging runs until recording merges.
  Downstream readiness requires attestations with the 448-byte payload and signed extension words
  for the new UPV4 domain for both orchestrators
  (attestation-service #529) and clients routing new intents to O4. RelayerRegistry is shared; its relayers
  are allowed on every orchestrator.
  Base preparation requires `ENABLE_BASE_V3_DISPUTE_BYPASS_CUTOVER_PREPARATION=true`, both Base
  `CONFIRM_` flags and `CONFIRM_BASE_V3_DISPUTE_BYPASS_RELEASE_READY_SHA` matching the source SHA.
  The unsigned atomic Safe batch is guard → conditional vault/policy `acceptOwnership` → activation
  actions → `addOrchestrator(O4)`. No canonical Base call targets O3. The guard checks O3's August hook;
  the deployed postcondition runs only in the pinned fork simulation. Artifacts remain
  `deployments/outputs/safe-batches/base_dispute_bypass_cutover{,.sha256}.json`; run
  `yarn verify:dispute-bypass-safe-batch` immediately before Safe execution. Preparation never signs,
  proposes or executes a Safe transaction.
  Historical lane 46 executed on staging on 2026-10-12 from `a6970aa` in 32 actions over three runs.
  On 2026-10-13, `285bc5c` activated the replacement trio: add its writer, switch O3's hook, remove the
  abandoned writer. Lanes 45/46 took ten transactions at deployer nonces 16340–16349; block 52531092
  reduced to `active`. That temporary replacement executor was deleted in the recording PR, which then
  restored the lanes to `314298e`; the current source is now retargeted and remains unexecuted on both networks.
  The first staging trio is abandoned: no protected intent, stake, live reference or writer permission.
  The recorded 2026-10-13 trio remains `StakeVaultBypass` `0x6b32df91EB92637F64bA444996702fC9582C87a1`,
  `DisputeProtectionPolicyBypass` `0x1a9C442E3Ae99fB08313242fCdA601431027B39C` and
  `IntentLifecycleHookV1Bypass` `0xec27Cc47370267c843177375c3Fe43D29D498bB4`. That execution kept UPV4,
  all 14 routes, currencies, method order and the sole NRV2 writer unchanged. The August policy
  `0x484fA07F085eb66bb7C2b649Ea9d5894b2B6681c` stayed a passive writer. No opt-outs were mirrored in those
  ten transactions; the historical `active` result did not attest opt-out mirroring.
  Staging aliases/evidence still describe that executed bypass stack; Base retains MethodScoped aliases
  and UPV3 binding. Superseded identities live in `BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS`; fresh
  `BYPASS_RECORDED_DEPLOYMENTS` pins are empty until recording. The staging recording PR must save all
  five fresh records and address/runtime pins, update the committed-record test after replacing UPV4's
  JSON, restore staging aliases/evidence/`PREDECESSOR_DISPUTE_STACKS.base_staging` to main's August O3
  selection, regenerate outputs with the O4 stack exported by name and update these docs.
  Base requires separate approvals for lane 45, its recording PR with pins, and lane-46 preparation;
  after activation, record evidence/outputs and flip `BYPASS_PAYMENT_BINDING_RECORDED.base` to `true`.
  Canonical dispute aliases keep describing O3's August stack; O4 consumers use `StakeVaultV2` and
  the other O4 records by name. Retain stale vault exports for withdrawals. Lane 31 selects UPV4 through
  the binding flag independently of aliases; staging lanes 35/41/43 still pin UPV3 and fail closed.
  Lanes 45/46 remain unpinned until Base executes. RC publication is a later, separately approved boundary.
  Local aliases select MethodScopedStaked while lanes 45/46 deploy and activate O4 beside O3. Restart the
  node before another full `yarn deploy:localhost`; lanes 31/39 retain historical local wiring checks.
- `deployments/predecessorDisputeStack.ts` keeps two pinned maps: `PREDECESSOR_DISPUTE_STACKS` describes the
  predecessor of the currently selected stack and feeds the lane-30 wrapper, the package's recognized-predecessor
  identities, and lane-34 tooling; `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS` describes what lane 37 replaces (the
  Base `*OptIn` trio, the Base-staging lane-32 stack). Do not merge them until the method-scoped stack is activated.
- `scripts/bootstrapWhitelistPolicy.ts` targets only `WhitelistPolicyMethodScoped` and refuses the lane-29 policy
  address. Its required `WHITELIST_GROUP_IDS` is an ordered, non-empty, distinct list; on Base every ID must be one
  of the known production groups. Withdrawn, method-inactive, self-configured, and already-bootstrapped tuples are
  skipped and reported; the expected count and selection digest cover only the eligible set. Until the lane-36
  artifact exists for a network the script fails closed on the missing artifact.
- `IntentGuardian` and `WhitelistPolicy` remain part of the V2 policy history and are reused where the mounted V3
  lifecycle lane specifies. Do not redeploy a core stack merely to change an independently owned policy component.
- The payment-verifier cutover is one-way. Before the governance batch, lane `31` must prove UPV3 is the sole
  `NullifierRegistryV2` writer. In the same governance batch, permanently revoke every retired verifier's
  legacy-registry write permission and route the shared
  `PaymentVerifierRegistry` to UPV3. Never route a payment method back to the retired verifier: the legacy registry
  cannot observe V2 writes, so a rollback would reopen payment replay.

## Architecture Overview (v2.1)

This section describes the V1 stack, whose sources now live in `contracts/archive/`. The current stack is `EscrowV2`,
`OrchestratorV3`, and `UnifiedPaymentVerifierV3`.

- Core: `Escrow` holds maker deposits and per-deposit config (methods, currencies, min rates, intent limits/expiry); `Orchestrator` manages intents, routes to verifiers, collects protocol/referrer fees; `ProtocolViewer` provides aggregated read views.
- Registries: `PaymentVerifierRegistry` maps `paymentMethod` → verifier + currencies; `EscrowRegistry` whitelists escrows; `PostIntentHookRegistry` whitelists post‑intent hooks; `NullifierRegistry` records consumed nullifiers. `RelayerRegistry` backs the deployed legacy V1 stack, deployed production `OrchestratorV2`, and current `OrchestratorV3` source and staging wiring, including relayer-gated multi-intent admission.
- Unified Verifier: `archive/unifiedVerifier/UnifiedPaymentVerifier.sol` validates EIP‑712 attestations, checks provider hashes and timestamp buffers (from `BaseUnifiedPaymentVerifier`), and nullifies payments.
- Wiring: Deploy registries → deploy `Escrow` → deploy `Orchestrator` with registry addresses → `Escrow.setOrchestrator(...)` → deploy `UnifiedPaymentVerifier` and register it per `paymentMethod` in `PaymentVerifierRegistry` (also set provider hashes/timestamp buffers) → whitelist escrows/hooks as needed. Current `OrchestratorV3` deliberately retains the relayer admission boundary while replacing the V2 deposit-whitelist-hook path with snapshotted, fail-closed lifecycle callbacks; review those differences as designed behavior, not accidental parity drift.
- Flow: Maker `createDeposit` on `Escrow` → Taker `signalIntent` on `Orchestrator` (escrow locks funds) → `fulfillIntent` calls method verifier → on success, `Orchestrator` unlocks/transfers from `Escrow`, applies fees, runs optional post‑intent hook.

Important ownership boundaries:

- `OrchestratorV4` is OrchestratorV3 plus deferred settlement, and is not a proxy.
- `DisputeProtectionPolicyV2` and `IntentLifecycleHookV2` serve only OrchestratorV4; OrchestratorV3 keeps `DisputeProtectionPolicy` and `IntentLifecycleHookV1`.
- `UnifiedPaymentVerifierV4` returns signed extension bytes without decoding them and serves both OrchestratorV3 and OrchestratorV4.

### Minimal Diagram

```
Maker ── createDeposit ──▶ Escrow
Taker ── signalIntent ──▶ Orchestrator ── lockFunds ──▶ Escrow
Orchestrator ── getVerifier(paymentMethod) ──▶ PaymentVerifierRegistry ──▶ UnifiedPaymentVerifier
UnifiedPaymentVerifier ── verify(EIP‑712) ──▶ AttestationVerifier
UnifiedPaymentVerifier ── nullify(paymentId) ──▶ NullifierRegistry
UnifiedPaymentVerifier ── result ──▶ Orchestrator
Orchestrator ── unlockAndTransfer ──▶ Escrow ── tokens ──▶ Orchestrator
Orchestrator ── fees ──▶ Protocol/Referrer
Orchestrator ── net ──▶ Recipient OR PostIntentHook (then executes)
```

## Build, Test, and Development Commands

- `yarn`: Install dependencies. Copy env: `cp .env.default .env` then fill keys.
- `yarn compile`: Full Hardhat compile; use only when Hardhat artifacts or TypeChain output are required.
- `yarn build`: Clean, compile, generate TypeChain, and transpile TypeScript. This is a cold full build, not an
  iteration command.
- `yarn chain`: Start local Hardhat node (no auto-deploy).
- `yarn test`: Run the complete Foundry suite.
- `yarn test:deterministic`, `yarn test:fuzz`, `yarn test:invariant`: Run one Foundry layer.
- Focused iteration: `forge test --match-path '<test-file>'`, `forge test --match-contract <Contract>`, or
  `forge test --match-test <testName>`.
- `yarn coverage`: Run the deterministic Foundry coverage pipeline. It is intentionally much heavier than tests.
- Deploy: `yarn deploy:localhost`, `yarn deploy:base`, `yarn deploy:base_staging`. These supported commands route
  through `scripts/deployActive.ts`; direct `hardhat deploy` invocation bypasses immutable-lane retirement and is
  unsupported.
- Verify: `yarn etherscan:base` and `yarn etherscan:base_staging`.

## Fast Development Workflow

Optimize for the shortest command that can disprove the current change. Broad verification is a final gate, not an
iteration loop.

### Scope Before Running Commands

- Inspect the requested change and `git diff` first. List the production files, interfaces, deploy/package consumers,
  and test files that can actually be affected.
- Use direct searches (`rg` for imports, calls, fixtures, and selectors) to map contract-specific consumers. Impact
  analysis belongs to the contract owner and its concrete tests and review checks; do not invoke or recreate a
  generic fleet-wide impact skill.
- For architecture, explanation, documentation, or read-only review tasks, do not compile or test unless the answer
  depends on executing code.
- Do not expand a focused request into repository cleanup, unrelated test repair, coverage work, or extra review
  loops.

### Preserve Warm Caches

- Reuse the assigned worktree. Do not create another clone/worktree for analysis, focused testing, or an ordinary
  read-only review unless isolation is explicitly required.
- Run dependency installation only when `node_modules` is missing or the lockfile/package manifest changed.
- Reuse Foundry and Hardhat caches. Do not run `yarn clean`, `forge clean`, delete `cache_forge`/`out`/`artifacts`, or
  force a cold build unless diagnosing cache/compiler behavior, benchmarking cold CI, or performing a requested
  release-quality clean build.
- Do not run overlapping Forge/Hardhat commands in the same worktree. One compile-heavy process at a time.
- A Foundry test compiles its dependency graph. Do not precede it with a separate compile unless a distinct artifact
  consumer requires that compile.
- `yarn build` begins with a clean and is therefore inappropriate for routine Solidity iteration.
- Fetch/rebase when establishing the implementation base and before PR/merge handoff. Do not repeatedly fetch or
  rebase between local test iterations unless the upstream branch actually changed.

### Compiler Parallelism Reality

- Forge already defaults to all logical cores (`--threads 0`), and Hardhat defaults to CPU cores minus one. Do not add
  a thread/job flag and claim it will fix a slow compile without first showing that multiple compiler jobs exist.
- These worker settings parallelize independent compiler jobs and test execution. They cannot split one `solc`
  optimizer invocation across cores.
- This repository's shared Solidity 0.8.18 import graph and uniform `viaIR` settings commonly produce one large
  compiler job. During its Yul optimization phase, roughly one-core utilization is expected even on a many-core
  machine.
- Do not create artificial compiler-setting variants, duplicate worktrees, or parallel Forge processes merely to use
  more CPUs. They duplicate compilation, compete for memory/cache writes, and risk bytecode/configuration drift.
- Optimize the single-job bottleneck by avoiding it: keep caches warm, use a focused test/build path, and avoid
  metadata-only source changes that trigger recompilation.
- Foundry dynamic test linking may be benchmarked in an isolated optimization task because it can avoid recompiling
  large test trees after production-code edits. Do not enable it for the canonical, coverage, deployment, or release
  path until deterministic/fuzz/invariant behavior, artifacts, and coverage equivalence are proven.
- Use process-level parallelism only for genuinely independent cold jobs, such as the existing CI coverage lanes.
  Local iteration should remain one focused compiler process.

### Change-Aware Verification Ladder

| Change                                                                             | Default local verification                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown, comments, or NatSpec only                                                | `git diff --check`; for Solidity comments, `forge fmt --check <changed-files>` and confirm no executable tokens changed. Do not compile or test.                    |
| One deterministic test or test helper                                              | Run only the changed test file or the smallest matching test/contract.                                                                                              |
| One contract's internal behavior                                                   | Run its closest deterministic test file or matching contract/test. Add the directly relevant fuzz/invariant target only when the changed behavior is covered there. |
| Shared interface, base contract, or library                                        | Find direct consumers with `rg`; run their focused deterministic tests. Compile the affected contract dependency graph only if tests do not already do so.          |
| Fuzz/invariant property or handler                                                 | Run the changed property/handler target. Reproduce a failure with its exact seed and promote real counterexamples to deterministic regressions.                     |
| Deployment or wiring script                                                        | Run the matching deployment-helper test or TypeScript check. Run `yarn deploy:localhost` only when deployment topology/wiring changed or the user requests it.      |
| Public ABI, TypeChain, or package extraction                                       | Run focused contract tests first; generate/build the affected artifacts once after the interface is stable.                                                         |
| Cross-cutting accounting, authorization, settlement, storage, or reentrancy change | Run the affected deterministic suites plus the relevant fuzz/invariant suites, then one complete suite at the final code state.                                     |

- Start with the smallest deterministic regression. Stop once the relevant failure is reproduced or the scoped
  verification passes.
- Do not automatically follow a focused pass with its parent layer, the complete suite, a clean build, localhost
  deployment, and coverage. Escalate only when the change boundary or a failure justifies it.
- Run the complete `yarn test` suite at most once per finalized local code state, and only for cross-cutting behavior,
  an explicit user request, or when CI is unavailable. If the exact commit is already green in CI, do not duplicate
  the complete suite locally.
- Do not run every fuzz and invariant suite after unrelated changes. For an affected property, use its focused target
  with the canonical configuration before handoff; reduced debug runs are not final evidence.

### Coverage, CI, and Review Discipline

- Never run `yarn coverage` as a general correctness check. Run it only when the user explicitly requests coverage,
  coverage/Codecov configuration changes, or a coverage failure must be reproduced. Prefer the current commit's CI
  coverage result over duplicating the multi-minute pipeline locally.
- Diagnose CI from the exact failing job/test first. Reproduce the smallest failing command; do not start with the
  complete suite or coverage unless that exact broad gate is what failed.
- Keep requested commit boundaries locally, but avoid pushing every micro-commit by default because each push starts
  a full CI workflow. Push a coherent batch unless the user asks for an immediate push.
- Do not wait for full CI after every ordinary push. Wait for the current head only when merging/shipping, when the
  user asks for confirmed CI, or when CI is the only available verification. Ignore or cancel superseded runs where
  appropriate.
- One coherent review at a stable checkpoint is preferable to repeated broad reviews after documentation or
  mechanical edits. Run additional security/audit/review skills only when explicitly requested or when a material
  security-sensitive code change warrants them.
- Once the requested behavior and proportionate verification are complete, stop. Report broader gates not run and
  the reason instead of running them defensively.

### PR Feedback Versus Release Readiness

- Code pull requests run the complete Foundry suite without coverage. Contract-only changes intentionally do not run
  package and localhost-deployment validation until the integrated `main` commit. Release-surface pull requests that
  touch deploy, package, scripts, tasks, utilities, configuration, or workflow files run those checks immediately.
- Markdown, agent instructions, audits, and deployment logs intentionally skip CI. Use `git diff --check` and any
  documentation-specific validation; do not manufacture an empty status check. A docs-only release head may inherit
  the immediately preceding green runtime SHA only after the complete intervening diff is proven non-executable.
  This skip applies only when the entire PR or push is limited to ignored paths; a docs-only follow-up in a mixed PR
  still reruns CI because GitHub evaluates the complete PR diff.
- A green pull request is development evidence, not permission or evidence to publish or deploy. Before package
  publication, release-branch promotion, Base staging deployment, or Base deployment, require the exact release SHA
  to have a green complete Foundry suite and a green `Release readiness` run including build/package, localhost
  deployment, all four coverage lanes, coverage-floor enforcement, and Codecov upload.
- Relevant pushes to `main` run those deferred gates automatically. If the exact release SHA has not run on `main`,
  manually dispatch `Release readiness` on its release ref and wait for it. Never substitute results from another
  commit, and do not rerun a gate locally when the exact SHA already has equivalent green CI evidence.
- Deployment, governance, package-publication, and production approvals remain separate. Follow the applicable
  release/deployment skill after the deferred technical gates are green.

## Coding Style & Naming Conventions

- Solidity: 4-space indent, explicit visibility, NatSpec for externals. Contracts/Libs `PascalCase`, interfaces `IName`, constants `UPPER_CASE`.
- Solidity: Avoid single-letter local variable names in contracts (e.g., `f`, `r`). Prefer clear names like `fee`, `recipient`, `id`, `registryAddr`.
- TypeScript: strict `tsconfig`, CommonJS; prefer path aliases `@utils/*`, `@typechain/*`.
- Scripts: prefix deploy files with two-digit order `NN_` and a concise verb-noun.

Protocol code is precise: validate inputs once at the boundary and trust them
afterward; reject impossible states instead of handling them.

- Reject with terse require-chains and short reason strings; no fallback
  branches or recovery paths for states that shouldn't exist. Fail closed on
  truncated or ambiguous data.
- No defensive checks whose invariant another layer (escrow, registry,
  circuit, verifier) already enforces; a guard must name the input that
  triggers it.
- Keep on-chain state minimal at the same security level; push complexity into
  the layer that owns it instead of enshrining it in the protocol.
- Delete speculative machinery: unused params, storage, modes, and flags.
- A rename ships with a full docs-and-naming pass across the surface.
- Tests lock exact values and cover adversarial cases (fee-on-transfer tokens,
  replay, expiry, truncation).
- TypeScript follows the same doctrine: boundary validation, no swallowing
  catches, no union wire types.

## Testing Guidelines

- Foundry is the only contract test runner. Hardhat remains for compilation, deployment, TypeChain, verification, and
  package release.
- Put deterministic tests in `test-foundry/deterministic/<domain>/`, fuzz properties in `test-foundry/fuzz/`, and
  stateful handlers/invariants in `test-foundry/invariant/`.
- Put opt-in, environment-gated cross-repo smoke tests in `test-foundry/smoke/`. They skip unless their
  environment is set, and coverage never runs them. Never put a skipping test under `test-foundry/deterministic/`.
- Every behavior change needs the smallest deterministic success/revert/state regression that proves it. Add fuzz or
  invariant coverage only for a meaningful input space or state-machine property, not as automatic duplication.
- Keep core paths and revert scenarios covered, but do not add tests solely to raise counts or exercise unrelated
  branches.
- See `TESTING.md` for canonical full-suite, seed reproduction, invariant, and coverage details.

## Commit & Pull Request Guidelines

- Use Conventional Commits where possible: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`.
- PRs: describe scope and rationale, link issues, include test updates, and note deployment impacts (network, addresses). Update `deployments/outputs/*.ts` when applicable.

## Agent Skills

| Skill                     | Location                                          | Description                                                                                  |
| ------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `audit`                   | `.agents/skills/audit/SKILL.md`                   | Review contracts and load selected Trail of Bits guidance on demand without a global install |
| `zkp2p-contracts-publish` | `.agents/skills/zkp2p-contracts-publish/SKILL.md` | Bump, build, test, verify addresses, and publish `@zkp2p/contracts-v2` to npm                |

## Security & Configuration Tips

- Never commit secrets. Configure `.env` (`ALCHEMY_API_KEY`, `BASE_DEPLOY_PRIVATE_KEY`, `BASESCAN_API_KEY`, etc.).
- For local dev: import Hardhat Account #0 into your wallet, then `yarn deploy:localhost`.

### UPV4 return compatibility

UPV4 accepts the same 448-byte `abi.encode(PaymentDetails, IntentSnapshot)` payload as UPV3,
followed by optional signed extension bytes. The entire `data`, including the extension, is
covered by `dataHash` and witness signatures. UPV4 returns the extension untouched and uninterpreted.
Extension fields occupy dedicated 32-byte words: word 0 is `disputeWindow` (uint256 seconds),
word 1 is the attested `conditionsHash`, and words 2+ are reserved and ignored by the current hook.
Non-manual HookV2 settlement requires a complete word 0 (`MissingDisputeWindow()` otherwise),
rejects windows above 180 days with `InvalidDisputeWindow(window)`, and treats zero as pay now.
A missing complete word 1 reads as zero. O4 settlement payloads are at least 480 bytes, or 512 bytes
with conditions. The 448-byte prefix and opaque UPV4 return remain unchanged for O3.
Attestors must sign seconds in word 0; the former balance-funded boolean no longer has that meaning.

The fully static result preserves the V1 `success`, `intentHash`, `releaseAmount` prefix,
then returns the uncapped `attestedReleaseAmount`, verified `PaymentDetails`, and signed/validated
`IntentSnapshot`. Dynamic extension bytes are a separate
trailing return value; unsigned metadata is never returned. O3 reads the V1 prefix with or without
extension bytes. O4 forwards the raw extension and opaque `intent.data` saved before pruning to
its snapshotted IntentLifecycleHookV2. The hook is stateless by design: per-intent data lives only in O4,
and the hook interprets it because governance can replace hooks for future intents while O4
is not upgradeable. Manual release forwards the saved data and an empty extension; the hook skips the
attestation comparison and extension validation and returns pay now without calling the policy.

IOrchestratorV4 keeps V3's `Intent` field order with `postIntentHook` removed entirely:
`owner, to, escrow, depositId, amount, timestamp, paymentMethod, fiatCurrency, conversionRate, payeeId, referralFees, data`.
`SignalIntentParams` keeps V3's fields in order except `postIntentHook`;
`FulfillIntentParams` keeps V3's fields except `postIntentHookData`. O4 has no post-intent-hook execution.
`data` is the opaque lifecycle hook payload and is stored only in `Intent.data`. Non-empty data requires
a mounted lifecycle hook (`LifecycleHookDataRequiresHook`) and a deposit payment-method gating service
(`LifecycleHookDataRequiresGatingService`). O4 appends `keccak256(data)` to the gating message; empty
data preserves the plain V3 packed message byte-for-byte. Read it through `getIntent(intentHash).data`
until pruning; there is no separate hook-data mapping or getter. Fees are unchanged. The net payout goes
to the lifecycle hook's deferral vault or directly to `intent.to`. Settlement preserves O3's order:
escrow unlock, protocol/referral/manager fee transfers, lifecycle hook, then net payout. O4 passes the
depositor and token read before unlock to the hook, so settlement works even when escrow deletes an
exhausted deposit. The policy does not read escrow at settlement. UPV4 checks O4's ERC-165 interface
before the V2 probe and decodes `IOrchestratorV4.Intent`; O3 and older decode paths stay unchanged.
ProtocolViewerV2 is unchanged and decodes only the V2/V3 `Intent` layout, so it cannot serve O4 intents;
read O4 intents directly with `OrchestratorV4.getIntent`.

IntentLifecycleHookV2 is stateless. At signal, a deposit's enabled whitelist is a pure admission gate:
non-members are rejected, and nonzero conditions require a gating service. Signal never calls the
policy or checks the deposit token, hook authorization, or a risk window. Cancellation is an unrestricted
no-op, retained for future hooks; O4 still invokes the snapshotted callback on cancel, escrow prune and
orphan cleanup.

`SettlementContext` is `{ intentHash, token, depositor, taker, recipient, escrow, depositId, paymentMethod,
releaseAmount, netAmount, data, extensionData, isManualRelease }`. O4 reads intent fields before pruning:
`taker = intent.owner`, `recipient = intent.to`, and `data = intent.data`; `depositor = deposit.depositor`
and `token = address(deposit.token)` come from its pre-unlock deposit read. The hook retains escrow/depositId
for whitelist checks and passes depositor/token and the intent identities and amounts to the policy's
`onIntentSettled(SettleParams)`, including the attested `uint64 riskWindow` and `bypass` set only for
whitelisted takers. A whitelisted taker means the deposit/payment-method whitelist is enabled and
`isTakerAllowed` returns true for the taker, not the recipient. Registered relayer takers follow the same
rule: relayer registration alone does not bypass collateral. The hook does not query the relayer registry;
O4 still uses it for its own admission gating. Whitelist state is read live at settlement. Disabling it or
removing the taker after signal restores collateral for nonzero windows. Manual release and window zero
return pay now without calling the policy; zero-window settlement still validates conditions.

Lanes 45/46 use bypass batch manifest version 6, which omits fresh-policy windows and admissions pause.
Historical O3 predecessor checks remain separate; old manifest versions are rejected.

DisputeProtectionPolicyV2 has no signal/cancel records, per-method windows, admissions pause, or
per-deposit opt-outs. It uses the supplied depositor and token without reading escrow. A non-stake-token
deposit pays now with no record or policy event. Whitelist bypass emits `DisputeProtectionIntentSettled`
with source `BYPASS` and no storage writes. Otherwise the policy snapshots the attested window, locks gross
stake (`STAKE`) or defers the net payout (`DEFERRED_PAYOUT`), and sets `releaseEligibleAt = now + window`.
It rejects windows above its `MAX_RISK_WINDOW` (180 days) as defence in depth. Statuses remain `NONE`,
`AWAITING_FUNDING`, `SETTLED`, `RELEASED`, and `DISPUTED`. Collateral ordinals remain `NONE=0`, `BYPASS=1`,
`STAKE=2`, `DEFERRED_PAYOUT=3`; `MANUAL_RELEASE` is removed. The settled event includes all participant
identities, method, window, collateral source, stake owner, amounts and eligibility time, with no manual
flag. O4's `IntentFulfilled` carries `isManualRelease`. Only matured collateral releases emit
`DisputeProtectionIntentReleased`. No Opened or Cancelled event is emitted.

IntentLifecycleHookV2 reads `bytes32(data)`: clients send empty data for no conditions or
`abi.encodePacked(conditionsHash)` for a raw 32-byte hash. Empty and all-zero data are unconditioned;
shorter data is right-padded and longer data uses its first word, with no length or version decoding.
The conditions version belongs inside the attestor-side hash preimage. Each intent's data is interpreted
only by its snapshotted hook. After the whitelist admission check, a nonzero hash requires a
gating service (`ConditionsRequireGatingService`); O4 separately requires a gating service for any
non-empty data and verifies its signature covering the data hash. Settlement compares extension word 1
with the expected hash symmetrically, unless manually released. A mismatch reverts with
`ConditionsNotAttested(intentHash)`. IIntentLifecycleHookV2 contains only the four lifecycle callbacks:
`onIntentSignaled`, `onIntentCancelled`, `settleIntent` and `onDeferredPayoutFunded`. Its ERC-165
interface id is the XOR of exactly those four selectors; O4 validates it when configuring the hook.

The cross-repo attestor smoke remains gated by `ATTESTOR_POLICY_SMOKE_ROOT`. Its expected signed payload
contains a dispute window in word 0: zero for pay now and the attested window for protected settlements.

### Deferred lifecycle compatibility

OrchestratorV4 accepts zero or a hook advertising IIntentLifecycleHookV2 through standard ERC-165.
The configuration-time check rejects a wrong hook with InvalidLifecycleHook: a V1 hook would
otherwise revert at signal because V2 uses onIntentSignaled(bytes32,bytes) and a V2-only
SettlementContext selector, so no intent would be stranded. For the same reason, OrchestratorV3
cannot successfully signal or snapshot IntentLifecycleHookV2. The shared V1/V2
onIntentCancelled(bytes32) selector is only called for intents snapshotted with that hook.

IntentLifecycleHookV2 checks the caller's orchestrator-registry membership without querying
ERC-165. Registering an orchestrator is a governance assertion that it honours the deferral vault
returned by settleIntent. O4 and the hook still advertise IERC165 and their own interfaces and
reject 0xffffffff; the protocol interface ids exclude supportsInterface.
OrchestratorV3 and IntentLifecycleHookV1 remain unchanged.
