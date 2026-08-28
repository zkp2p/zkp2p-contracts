# Repository Guidelines

## Project Structure & Module Organization

- `contracts/`: Solidity sources (0.8.18), plus `interfaces/`, `lib/`, `mocks/`, `unifiedVerifier/`.
- `deploy/`: Hardhat Deploy scripts, ordered `NN_description.ts` (e.g., `00_deploy_system.ts`).
- `test-foundry/`: the only contract test system, split into `deterministic/`, `fuzz/`, and `invariant/`.
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
- Lane `31` is the state-aware V3 payment-binding lane. On Base staging and Base it must verify and reuse the
  bytecode-pinned `NullifierRegistryV2` and `UnifiedPaymentVerifierV3`; missing production-like artifacts fail
  closed. Base staging is verification-only because its EOA-owned registries cannot provide an atomic cutover.
  On Base, the explicit cutover opt-in preserves the audited method order and currencies while atomically routing
  all active methods to UPV3 and revoking both retired verifiers from the legacy registry.
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
  for that executed history. The Base `*OptIn` trio is the live dispute stack until a later activation lane replaces
  it; the Base-staging `*OptIn` trio is deployed but was never activated.
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

- Core: `Escrow` holds maker deposits and per-deposit config (methods, currencies, min rates, intent limits/expiry); `Orchestrator` manages intents, routes to verifiers, collects protocol/referrer fees; `ProtocolViewer` provides aggregated read views.
- Registries: `PaymentVerifierRegistry` maps `paymentMethod` → verifier + currencies; `EscrowRegistry` whitelists escrows; `PostIntentHookRegistry` whitelists post‑intent hooks; `NullifierRegistry` records consumed nullifiers. `RelayerRegistry` backs the deployed legacy V1 stack, deployed production `OrchestratorV2`, and current `OrchestratorV3` source and staging wiring, including relayer-gated multi-intent admission.
- Unified Verifier: `unifiedVerifier/UnifiedPaymentVerifier.sol` validates EIP‑712 attestations, checks provider hashes and timestamp buffers (from `BaseUnifiedPaymentVerifier`), and nullifies payments.
- Wiring: Deploy registries → deploy `Escrow` → deploy `Orchestrator` with registry addresses → `Escrow.setOrchestrator(...)` → deploy `UnifiedPaymentVerifier` and register it per `paymentMethod` in `PaymentVerifierRegistry` (also set provider hashes/timestamp buffers) → whitelist escrows/hooks as needed. Current `OrchestratorV3` deliberately retains the relayer admission boundary while replacing the V2 deposit-whitelist-hook path with snapshotted, fail-closed lifecycle callbacks; review those differences as designed behavior, not accidental parity drift.
- Flow: Maker `createDeposit` on `Escrow` → Taker `signalIntent` on `Orchestrator` (escrow locks funds) → `fulfillIntent` calls method verifier → on success, `Orchestrator` unlocks/transfers from `Escrow`, applies fees, runs optional post‑intent hook.

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
