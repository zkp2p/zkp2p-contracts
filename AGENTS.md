# Repository Guidelines

## Project Structure & Module Organization
- `contracts/`: Solidity sources (0.8.18), plus `interfaces/`, `lib/`, `mocks/`, `unifiedVerifier/`.
- `deploy/`: Hardhat Deploy scripts, ordered `NN_description.ts` (e.g., `00_deploy_system.ts`).
- `test-foundry/`: the only contract test system, split into `deterministic/`, `fuzz/`, and `invariant/`.
- `scripts/`: coverage and deployment-support scripts.
- `deployments/`: Network artifacts and exported addresses; update on live deploys.
- `tasks/`: Custom Hardhat tasks (e.g., Etherscan verification with delay).
- `typechain/`, `artifacts/`, `out/`, `dist/`: Generated output; do not edit by hand.

## Staging Deployment Status

- The retired `RiskManager`/`OrchestratorV3` lane was staging-only. Its historical addresses are not active
  deployment targets.
- `IntentGuardian` and `WhitelistPolicy` extend the existing `EscrowV2`/`OrchestratorV2` stack. Deploy them through
  the single V2 guardian/whitelist script; do not redeploy the V2 core as part of that workflow.
- The payment-verifier cutover is one-way. In the same governance batch, authorize UPV3 on `NullifierRegistryV2`,
  permanently revoke the retired verifier's legacy-registry write permission, and route the shared
  `PaymentVerifierRegistry` to UPV3. Never route a payment method back to the retired verifier: the legacy registry
  cannot observe V2 writes, so a rollback would reopen payment replay.

## Architecture Overview (v2.1)
- Core: `Escrow` holds maker deposits and per-deposit config (methods, currencies, min rates, intent limits/expiry); `Orchestrator` manages intents, routes to verifiers, collects protocol/referrer fees; `ProtocolViewer` provides aggregated read views.
- Registries: `PaymentVerifierRegistry` maps `paymentMethod` → verifier + currencies; `EscrowRegistry` whitelists escrows; `PostIntentHookRegistry` whitelists post‑intent hooks; `NullifierRegistry` records consumed nullifiers. `RelayerRegistry` backs the deployed legacy V1 stack and the deployed prod `OrchestratorV2` (whose in-repo source mirrors the prod deployment, including relayer-gated multi-intent admission).
- Unified Verifier: `unifiedVerifier/UnifiedPaymentVerifier.sol` validates EIP‑712 attestations, checks provider hashes and timestamp buffers (from `BaseUnifiedPaymentVerifier`), and nullifies payments.
- Wiring: Deploy registries → deploy `Escrow` → deploy `Orchestrator` with registry addresses → `Escrow.setOrchestrator(...)` → deploy `UnifiedPaymentVerifier` and register it per `paymentMethod` in `PaymentVerifierRegistry` (also set provider hashes/timestamp buffers) → whitelist escrows/hooks as needed. `OrchestratorV2` keeps its relayer constructor arg because its source mirrors the deployed prod contract.
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
- Deploy: `yarn deploy:localhost`, `yarn deploy:base`, `yarn deploy:base_staging`.
- Verify: `yarn etherscan:base` and `yarn etherscan:base_staging`.

## Fast Development Workflow

Optimize for the shortest command that can disprove the current change. Broad verification is a final gate, not an
iteration loop.

### Scope Before Running Commands

- Inspect the requested change and `git diff` first. List the production files, interfaces, deploy/package consumers,
  and test files that can actually be affected.
- Use direct searches (`rg` for imports, calls, fixtures, and selectors) to map impact. Do not invoke, recreate, or use
  `zkp2p-stack-impact` or another generic "stack impact" skill in this repository.
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

| Change | Default local verification |
|---|---|
| Markdown, comments, or NatSpec only | `git diff --check`; for Solidity comments, `forge fmt --check <changed-files>` and confirm no executable tokens changed. Do not compile or test. |
| One deterministic test or test helper | Run only the changed test file or the smallest matching test/contract. |
| One contract's internal behavior | Run its closest deterministic test file or matching contract/test. Add the directly relevant fuzz/invariant target only when the changed behavior is covered there. |
| Shared interface, base contract, or library | Find direct consumers with `rg`; run their focused deterministic tests. Compile the affected contract dependency graph only if tests do not already do so. |
| Fuzz/invariant property or handler | Run the changed property/handler target. Reproduce a failure with its exact seed and promote real counterexamples to deterministic regressions. |
| Deployment or wiring script | Run the matching deployment-helper test or TypeScript check. Run `yarn deploy:localhost` only when deployment topology/wiring changed or the user requests it. |
| Public ABI, TypeChain, or package extraction | Run focused contract tests first; generate/build the affected artifacts once after the interface is stable. |
| Cross-cutting accounting, authorization, settlement, storage, or reentrancy change | Run the affected deterministic suites plus the relevant fuzz/invariant suites, then one complete suite at the final code state. |

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

## Coding Style & Naming Conventions
- Solidity: 4-space indent, explicit visibility, NatSpec for externals. Contracts/Libs `PascalCase`, interfaces `IName`, constants `UPPER_CASE`.
- Solidity: Avoid single-letter local variable names in contracts (e.g., `f`, `r`). Prefer clear names like `fee`, `recipient`, `id`, `registryAddr`.
- TypeScript: strict `tsconfig`, CommonJS; prefer path aliases `@utils/*`, `@typechain/*`.
- Scripts: prefix deploy files with two-digit order `NN_` and a concise verb-noun.

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

| Skill | Location | Description |
|-------|----------|-------------|
| `zkp2p-contracts-publish` | `.agents/skills/zkp2p-contracts-publish/SKILL.md` | Bump, build, test, verify addresses, and publish `@zkp2p/contracts-v2` to npm |

## Security & Configuration Tips
- Never commit secrets. Configure `.env` (`ALCHEMY_API_KEY`, `BASE_DEPLOY_PRIVATE_KEY`, `BASESCAN_API_KEY`, etc.).
- For local dev: import Hardhat Account #0 into your wallet, then `yarn deploy:localhost`.
