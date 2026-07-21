# Foundry Test Migration Evidence

This ledger is the durable source of truth for the Hardhat-to-Foundry migration requested in Codex source task `019f83af-c88b-76c3-824b-bc2f8eefea94`. The active goal is not complete until its pull request is merged and the merged state is verified on `main`.

## Governing gates

- Preserve one-to-one traceability from every hand-crafted Hardhat behavior to deterministic Foundry coverage before removing Hardhat tests.
- Establish the authoritative Hardhat coverage and timing baseline before deleting either suite.
- Rebuild existing Foundry tests from the Hardhat oracle before adding additive fuzz/property and stateful invariant assurance.
- Finish with zero skipped, pending, disabled, placeholder, log-only, event-gated, or silently omitted tests.
- Run deterministic, fuzz, invariant, integration, deployment, and any required pinned-fork coverage on every applicable CI run.
- Upload stable Foundry LCOV to Codecov through an observable required step.
- Strictly improve overall production line coverage and branch coverage when the baseline is below 100%; do not regress statements, functions, or unjustifiably regress per-file metrics; require 100% changed production coverage.
- Record fair cold/warm local benchmarks, CI wall time, isolation/repetition evidence, and mutation sensitivity.
- Preserve production bytecode, public APIs, storage layout, and protocol economics unless a genuine pre-existing bug requires a separately justified regression-tested fix.
- Use `gh` for GitHub operations and ordinary `git` for fetch/rebase/commit/push. Rebase whenever `origin/main` advances and immediately before merge. Never bypass protection or merge pending/failing checks.

## Repository baseline

| Field | Value |
| --- | --- |
| Repository | `zkp2p/zkp2p-contracts` |
| Isolated worktree | `/Users/sachin/.codex/worktrees/1a3b/zkp2p-v2-contracts` |
| Branch | `codex/foundry-test-migration` |
| Starting and current base SHA | `a55b49db180ddf2dee96334bace4e38553cd0943` |
| Starting commit | `fix: harden deferred settlement accounting and integration (#189)` |
| Fetch command | `git fetch origin main --prune` |
| Initial worktree state | Clean detached worktree; branch created directly from fetched `origin/main` |
| Host | Apple M5 Max, 18 logical CPUs, 128 GiB RAM, macOS 26.4.1 arm64 |
| Git | 2.50.1 (Apple Git-155) |
| Node | 20.20.2 |
| Yarn | 4.9.1 from `.yarn/releases/yarn-4.9.1.cjs` |
| Foundry | 1.7.1, commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8` |
| GitHub CLI | 2.90.0 |
| Dependency install | `PATH=/opt/homebrew/opt/node@20/bin:$PATH node .yarn/releases/yarn-4.9.1.cjs install --immutable` (pass; 12.48s after correcting Node 24 environment mismatch) |

## Phase 0 inventory

- Tracked TypeScript files under `test/`: 61 (includes tests and helpers; exact classification pending).
- Foundry test implementations under `test-foundry/`: 16.
- Production and test-support Solidity files under `contracts/`: 103 (exact coverage denominator will follow `.solcover.js`).
- Test entry points discovered in `package.json`: `test`, `test:integration`, `test:deploy`, `coverage`, `test:forge`, `test:forge:fuzz`, `test:forge:invariant`, `test:forge:fork`, `test:forge:coverage`, and package tests.
- Existing CI problems observed before changes: workflow branch allowlists omit ordinary feature branches; Foundry fuzz CI forces 100 runs below configured 256; fork tests are omitted on pull requests and depend on an RPC secret; Codecov upload is skipped when its token is absent; Foundry/action versions are unpinned; suite names and jobs split coverage in ways that can omit tests.

## Baseline commands and results

Measured results will be appended here before either test suite is deleted.

| Group | Exact command | Result/counts | Timing | Notes |
| --- | --- | --- | --- | --- |
| Hardhat cold canonical | `PATH=/opt/homebrew/opt/node@20/bin:$PATH node .yarn/releases/yarn-4.9.1.cjs clean`, then `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test` | 1,298 passing; 5 pending; exit 0; 124 Solidity files compiled | real 245.89s; user 182.27s; sys 12.10s | Clean generated state; canonical groups from `package.json` |
| Hardhat warm canonical | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test >/dev/null` | Each run exit 0 with unchanged 1,298 passing / 5 pending registry | 101.67s, 100.06s, 100.85s; median 100.85s; range 1.61s | Generated artifacts retained; exact canonical script, output suppressed only to remove terminal rendering cost |
| Hardhat integration | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test:integration` | Exit 1; no tests executed | real 0.18s; user 0.24s; sys 0.03s | Script references absent `test/integration/*.ts`; obsolete/silently empty baseline group must be resolved, not skipped |
| Hardhat deployment/default network | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test:deploy` | 6 passing; 48 failing; exit 48 | real 3.41s; user 3.47s; sys 2.49s | Expected missing deployment artifacts when invoked without the CI deploy topology |
| Hardhat deployment/local node | Start `yarn chain`; run `yarn deploy:localhost`; then `yarn hardhat test $(find test/deploy -maxdepth 1 -type f -name '*.ts' -print \| sort) --network localhost` | Deploy exit 0; 176 passing / 0 pending / 0 failing; test exit 0 | deploy 9.11s; assertions 3.54s | Exact current CI topology; tracked localhost timestamp side effects restored after run |
| Hardhat coverage | Pending | Pending | Pending | Authoritative parity baseline |
| Existing Foundry complete | Pending | Pending | Pending | Context only, not parity credit |
| Existing Foundry fork | Pending | Pending | Pending | Diagnose/pin or replace |
| Package build/test | Pending | Pending | Pending | Preserve release surface |

### Baseline pending behaviors

These receive no exemption from migration and must become executable assertions:

1. `test/escrow/escrow.spec.ts` — `Escrow #pruneExpiredIntentsAndReclaimLiquidity when timestamp is after intent expiry should have called the orchestrator to prune intents`.
2. `test/orchestrator/orchestrator.spec.ts` — `Orchestrator #signalIntent when there aren't enough deposits to cover requested amount but there are prunable intents should prune the old intent and update the deposit mapping correctly`.
3. Same source/suite — `should delete the original intent from the intents mapping`.
4. Same source/suite — `should emit an IntentPruned event`.
5. Same source/suite under `when the reclaimable amount can't cover the new intent` — `should revert`.

## Coverage comparison

Pending authoritative Hardhat baseline and final Foundry LCOV metrics, overall and per production file.

## Parity status

The machine-auditable manifest is [hardhat-to-foundry-manifest.csv](./hardhat-to-foundry-manifest.csv). No row is verified until its Foundry destination passes alone and in the complete repeated suite.

## Fuzz and invariant catalog

Pending deterministic parity completion. Foundry-native tests cannot receive parity credit.

## Mutation audit

Pending. Mutants will never be committed.

## Pull request and CI

No pull request exists yet. Branch protection endpoint currently reports no classic protection rule; merge will still wait for all relevant checks and required approvals.

## Final merge verification

Pending actual merge, fetched `origin/main` verification, and post-merge workflow inspection.
