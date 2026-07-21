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
| Starting SHA | `a55b49db180ddf2dee96334bace4e38553cd0943` |
| Current rebased base SHA | `845f8a077404a3c000e723265288f83be65194c7` |
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

- Runtime-expanded Hardhat inventory: 61 spec files, 977 suites, 1,514 named behaviors, 693 hooks, 531 imported dependency records, and 302 named local callables. Every source file is SHA-256 pinned in the inventory.
- After rebasing the relayer hard cut (`845f8a0`), the same runtime inventory contains 61 files, 977 suites, 1,517 named behaviors (1,512 executable and 5 pending), 693 hooks, 531 imported dependency records, and 302 named local callables. The committed inventory and manifest were regenerated from the rebased sources; the original 1,514-row state remains preserved in Git history.
- Initial canonical group: 36 files / 1,305 behaviors (1,300 executable, 5 pending). On current `845f8a0`, the canonical group is 36 files / 1,308 behaviors (1,303 executable, 5 pending). Patch-coverage remains 1 file / 33 executable behaviors, and deployment remains 24 files / 176 executable behaviors.
- Foundry test implementations under `test-foundry/`: 16.
- Production and test-support Solidity files under `contracts/`: 103 (exact coverage denominator will follow `.solcover.js`).
- Test entry points discovered in `package.json`: `test`, `test:integration`, `test:deploy`, `coverage`, `test:forge`, `test:forge:fuzz`, `test:forge:invariant`, `test:forge:fork`, `test:forge:coverage`, and package tests.
- Existing CI problems observed before changes: workflow branch allowlists omit ordinary feature branches; Foundry fuzz CI forces 100 runs below configured 256; fork tests are omitted on pull requests and depend on an RPC secret; Codecov upload is skipped when its token is absent; Foundry/action versions are unpinned; suite names and jobs split coverage in ways that can omit tests.
- `origin/main` advanced during Phase 0 from the starting SHA to `659fb603` (`feat: fund intent extensions with delegated stake (#190)`). The branch was immediately rebased. Upstream changed `RiskManager`, `StakeVault`, their Hardhat tests, and two old Foundry files; affected and complete baselines are being refreshed on the new base while retaining the original cold measurement.
- During deterministic translation, `origin/main` advanced again to `845f8a0` (`refactor: remove privileged relayer intent access (#192)`). The branch was immediately rebased. The V2/V3 relayer dependency and global multiple-intent switch were removed, ordinary V2 accounts gained concurrent intents, affected Foundry topologies were hard-cut to the new constructors, and the runtime oracle/manifest were regenerated rather than retaining compatibility aliases.

## Baseline commands and results

Measured results will be appended here before either test suite is deleted.

| Group | Exact command | Result/counts | Timing | Notes |
| --- | --- | --- | --- | --- |
| Hardhat cold canonical | `PATH=/opt/homebrew/opt/node@20/bin:$PATH node .yarn/releases/yarn-4.9.1.cjs clean`, then `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test` | 1,298 passing; 5 pending; exit 0; 124 Solidity files compiled | real 245.89s; user 182.27s; sys 12.10s | Clean generated state; canonical groups from `package.json` |
| Hardhat warm canonical | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test >/dev/null` | Each run exit 0 with unchanged 1,298 passing / 5 pending registry | 101.67s, 100.06s, 100.85s; median 100.85s; range 1.61s | Generated artifacts retained; exact canonical script, output suppressed only to remove terminal rendering cost |
| Hardhat integration | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test:integration` | Exit 1; no tests executed | real 0.18s; user 0.24s; sys 0.03s | Script references absent `test/integration/*.ts`; obsolete/silently empty baseline group must be resolved, not skipped |
| Hardhat deployment/default network | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test:deploy` | 6 passing; 48 failing; exit 48 | real 3.41s; user 3.47s; sys 2.49s | Expected missing deployment artifacts when invoked without the CI deploy topology |
| Hardhat deployment/local node | Start `yarn chain`; run `yarn deploy:localhost`; then `yarn hardhat test $(find test/deploy -maxdepth 1 -type f -name '*.ts' -print \| sort) --network localhost` | Deploy exit 0; 176 passing / 0 pending / 0 failing; test exit 0 | deploy 9.11s; assertions 3.54s | Exact current CI topology; tracked localhost timestamp side effects restored after run |
| Hardhat canonical after rebase | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test` | 1,300 passing; 5 pending; exit 0 | real 99.36s; user 41.67s; sys 9.36s | Current `659fb603` base; includes two upstream staking behaviors added after the original baseline |
| Hardhat relayer-cut affected groups | `yarn hardhat test test/orchestratorV2/orchestratorV2.spec.ts test/orchestrator/preIntentHook.spec.ts test/periphery/protocolViewerV2.spec.ts test/unifiedVerifier/unifiedPaymentVerifierV2.spec.ts test/unifiedVerifier/unifiedPaymentVerifierV3.spec.ts test/staking/riskManager.spec.ts test/hooks/whitelistPreIntentHook.spec.ts` | 152 passing; 0 pending; exit 0 | real 116.80s; user 110.09s; sys 5.08s | Clean compile on rebased `845f8a0`; covers every directly affected canonical source group |
| Hardhat canonical after relayer cut | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs test` | 1,303 passing; 5 pending; exit 0 | real 111.04s; user 47.43s; sys 10.07s | Full canonical oracle on rebased `845f8a0` |
| Hardhat affected staking after rebase | `yarn hardhat test test/staking/riskManager.spec.ts test/staking/stakeVault.spec.ts` | 125 passing; 0 pending; exit 0; 5 changed Solidity files compiled | real 27.14s | Targeted validation after rebasing upstream delegated-stake funding changes |
| Hardhat patch-coverage group | `yarn hardhat test test/patchCoverage/*.ts` | 33 passing; 0 pending; exit 0 | real 5.65s | Separately invoked coverage-only group; behaviors must move into ordinary named deterministic tests |
| Hardhat coverage | `PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs coverage` | 1,333 passing; 5 pending; 0 failing; exit 0 | real 870.61s; user 976.89s; sys 74.13s | Authoritative current-base parity baseline; canonical plus patch-coverage groups |
| Existing Foundry cold complete | `yarn test:forge` | 137 passing; 2 failing; 0 skipped across 15 suites / 139 tests; exit 1; 159 files compiled | compile 203.63s; real 207.89s; user 209.69s; sys 5.39s | Context only, not parity credit; default-profile live fork failures changed with live state |
| Existing Foundry warm complete | `yarn test:forge` | 137 passing; 2 failing; 0 skipped; exit 1 | real 2.07s | Same two live-fork failures: expected Across deposit but observed no spoke-pool increase/fallback |
| Existing Foundry fuzz | `yarn test:forge:fuzz` | 35 passing; 0 failing; 100 runs forced by script | real 0.51s | Script overrides the configured 256-run default downward |
| Existing Foundry invariants | `yarn test:forge:invariant` | 24 passing; 0 failing; 3 suites; 256 runs and 3,840 calls per invariant suite | real 1.45s | `fail_on_revert=false`; includes an empty invariant and log-only summaries; separate placeholder file is silently undiscovered |
| Existing Foundry fork | `FOUNDRY_PROFILE=fork yarn forge test --match-path 'test-foundry/fork/*Fork.t.sol' -vvv` | 3 passing; 0 failing against an unpinned live Base head; exit 0; 144 files compiled | compile 52.28s; real 54.84s | Default and fork-profile runs used different cached live blocks (`48917829` and `48917873`), demonstrating nondeterminism |
| Existing Foundry coverage | `yarn test:forge:coverage` | Exit 1 before tests | real 2.19s; user 1.35s; sys 1.14s | Forge coverage disables optimizer/IR and fails with `stack too deep` at `contracts/OrchestratorV2.sol:802`; no usable old-Foundry coverage artifact |
| Package build | `yarn build` | Pass | real 6.19s | Preserves compile and TypeScript release surface |
| Package tests | `yarn pkg:test` | 2 suites / 7 tests passing | real 2.56s | Package export/import smoke coverage |

### Baseline pending behaviors

These receive no exemption from migration and must become executable assertions:

1. `test/escrow/escrow.spec.ts` — `Escrow #pruneExpiredIntentsAndReclaimLiquidity when timestamp is after intent expiry should have called the orchestrator to prune intents`.
2. `test/orchestrator/orchestrator.spec.ts` — `Orchestrator #signalIntent when there aren't enough deposits to cover requested amount but there are prunable intents should prune the old intent and update the deposit mapping correctly`.
3. Same source/suite — `should delete the original intent from the intents mapping`.
4. Same source/suite — `should emit an IntentPruned event`.
5. Same source/suite under `when the reclaimable amount can't cover the new intent` — `should revert`.

### Existing Foundry confidence findings

- `test-foundry/invariant/V2RateFlowInvariantSkeleton.t.sol` is an explicit compile-safe placeholder. Its ten empty `spec_*` functions are deliberately undiscovered, so CI reports no failure or skip.
- `EscrowInvariant.invariant_FeeBounds()` has an empty body.
- `EscrowInvariant.invariant_callSummary()` and `OrchestratorInvariant.invariant_callSummary()` only print counters/accounting; they assert no property.
- Global `fail_on_revert = false` permits handler sequences to revert without failing. Call distributions show substantial reverting traffic, requiring handler-by-handler reachability and exercise review.
- The fork suite calls `vm.createSelectFork(rpcUrl)` without a block number and depends on mutable Base USDC/Across SpokePool state. It failed under the default profile and passed minutes later under the fork profile at a different live block.
- `test-foundry/fuzz/RiskManagerMathFuzz.t.sol` contains arithmetic-focused properties that require re-derivation against production contract behavior; no old fuzz assertion receives parity or additive-assurance credit.
- Repository scans found no `.only`, `xit`, or `xdescribe`; the five known Hardhat omissions are implemented through one `it.skip` and one `describe.skip` containing four tests.

## Phase 1 nuclear reset

After committing the full Hardhat baseline, coverage artifacts, runtime inventory, and 1,514-row manifest, all 16 pre-existing `.t.sol` implementations under `test-foundry/` were deleted. No test assertion, fixture, handler, fork implementation, fuzz property, invariant, or placeholder was retained. The independently versioned `lib/forge-std` dependency remains as generic test infrastructure; it contains no repository-specific test behavior and will underpin the re-derived suite.

## Coverage comparison

The authoritative baseline instruments all 35 production files selected by `.solcover.js`. Exact totals are:

| Metric | Covered / total | Baseline |
| --- | ---: | ---: |
| Statements | 1,751 / 1,775 | 98.65% |
| Branches | 1,600 / 1,770 | 90.40% |
| Functions | 440 / 446 | 98.65% |
| Lines | 2,327 / 2,379 | 97.81% |

Machine-readable evidence is committed in [hardhat-coverage-summary.json](./baseline/hardhat-coverage-summary.json) and [hardhat-coverage-by-file.csv](./baseline/hardhat-coverage-by-file.csv). The extraction tool records SHA-256 hashes of the original `coverage-final.json` and LCOV inputs and reproduces the report totals. Final Foundry comparison remains pending.

## Parity status

The machine-auditable [migration manifest](./hardhat-to-foundry-manifest.csv) contains all 1,517 runtime-expanded named behaviors on current `origin/main`, with unique stable hash IDs, source file, suite path, scenario, expected-behavior category, inherited hook/helper dependencies, one-to-one translation shape, and baseline status. The underlying [Hardhat inventory](./baseline/hardhat-inventory.json) preserves suites, hooks, imports, named local callables, source hashes, group totals, and the five pending cases. Runtime enumeration expands parameterized test construction rather than relying on a text-only `it()` search. No row is verified until its Foundry destination passes alone and in the complete repeated suite.

| Re-derived domain | Hardhat rows mapped | Foundry tests | Isolation evidence | Status |
| --- | ---: | ---: | --- | --- |
| Seven registries | 120 | 50 across 7 contracts | Every test passed individually; complete file 50/50, 0 skipped; warm real 0.22s | Independently verified; shadow/full-repeat gates pending |
| Chainlink and Pyth oracle adapters | 27 | 25 across 2 contracts | Every test passed individually; complete file 25/25, 0 skipped; warm real 0.22s | Independently verified; shadow/full-repeat gates pending |
| Simple and multi attestation verifiers | 37 | 24 across 2 contracts | Every test passed individually; complete file 24/24, 0 skipped; cumulative deterministic suite 99/99, warm real 0.22s | Independently verified; shadow/full-repeat gates pending |
| Threshold signature library | 22 | 16 | Every test passed individually; complete file 16/16, 0 skipped; cumulative deterministic suite 115/115, warm real 0.21s | Independently verified; shadow/full-repeat gates pending |
| Base unified verifier configuration | 19 | 8 | Every test passed individually; complete file 8/8, 0 skipped; cumulative deterministic suite 123/123, warm real 0.29s | Independently verified; shadow/full-repeat gates pending |
| Unified payment verifier V3 core | 11 | 11 | Every test passed individually; complete file 11/11, 0 skipped; cumulative deterministic suite 134/134, warm real 0.30s | Independently verified against both legacy- and V2-shaped caller interfaces; actual Orchestrator V2/V3 shadow integration gate pending |
| Unified payment verifier core | 19 | 12 | Every test passed individually; complete file 12/12, 0 skipped; cumulative deterministic suite 146/146, warm real 0.21s | Independently verified; actual Orchestrator settlement shadow integration gate pending |
| Unified verifier / OrchestratorV2 compatibility | 1 | 1 | End-to-end test passed independently and in the cumulative deterministic suite; cumulative 147/147, warm real 0.21s | Verified with real EscrowV2 deposit/lock, OrchestratorV2 signal/fulfill, verifier event/nullifier, intent deletion, and exact token settlement |
| OrchestratorV2 delegated rates, manager fees, and relayer hard cut | 6 | 6 | Every test passed individually after rebase; complete file 6/6, 0 skipped; 42/42 rebased affected tests passed individually; cumulative deterministic suite 220/220; warm real 0.23s | Independently verified with real EscrowV2, delegated RateManager, signal-time fee snapshot, exact custom-error arguments, fulfillment/token accounting, ordinary-account concurrent intents, and absence of all four retired runtime selectors |
| EscrowV2 / Pyth oracle integration | 5 | 5 | Every test passed individually; complete file 5/5, 0 skipped; cumulative deterministic suite 156/156, warm real 0.21s | Independently verified with validated/stored config, rounded spread, fixed-rate floor, stale-price halt, fresh price updates, inline creation, and decoded event payload |
| EscrowV2 currency-rate lifecycle | 12 | 12 | Every test passed individually; complete file 12/12, 0 skipped; cumulative deterministic suite 168/168, warm real 0.26s | Independently verified fixed/oracle max, positive and negative spread rounding, stale halt, deactivation event/state cleanup, and explicit reactivation by either source |
| ProtocolViewerV2 aggregation | 12 | 12 | Every test passed individually; complete file 12/12, 0 skipped; cumulative deterministic suite 180/180, warm real 0.24s | Independently verified deposit/currency views, delegated-rate fallback/disable semantics, multi-deposit ordering, account/hash intent aggregation, nested deposit resolution, and exact invalid-address errors |
| Legacy ProtocolViewer aggregation | 15 | 15 | Every test passed individually; complete file 15/15, 0 skipped; cumulative deterministic suite 195/195, warm real 0.27s | Independently verified constructor wiring/errors, deposit/payment-method views, nonexistent records, ordered batch/account intent views, nonzero EIP-191 gating authorization, and expired-intent reclaimable liquidity |
| OrchestratorV2 pre-intent hooks | 23 | 23 | Every test passed individually; complete file 23/23, 0 skipped; cumulative deterministic suite 218/218, warm real 0.24s | Independently verified depositor/delegate administration, exact authorization errors, ephemeral-vs-persisted data, atomic rejection, removal/no-hook behavior, reentry containment, per-deposit signer governance, EIP-191 signature binding, expiry, signer absence, and direct-call rejection |
| Whitelist pre-intent hook | 29 | 29 | Every test passed individually; complete file 29/29, 0 skipped; cumulative deterministic suite 249/249, warm real 0.21s | Independently verified constructor wiring, depositor/delegate authorization, exact errors/events, atomic whitelist batches, removal isolation, dedicated hook administration, direct-call rejection, real signaling, independent dual-hook storage/execution/removal, and atomic rollback when whitelist validation rejects |

Current deterministic mapping: 358 / 1,517 rows (23.60%); 1,159 remain. The complete rebased deterministic suite is 249/249 with zero skips and a 0.21s warm runtime; all 42 constructor/control-affected V2 tests also passed as isolated invocations. Consolidations combine assertions from the same Hardhat setup/action only where the manifest gives every source behavior an exact Foundry function destination. Completed slices additionally cover immutable verifier registries, attestation-verifier rotation, payment-method membership/enumeration, exact owner/error/event behavior for the base unified verifier, V1/V3 EIP-712 attestation integrity, nullifier replay, V3 bidirectional payment-to-intent bindings, snapshot validation, overpayment capping, verifier rotation, real OrchestratorV2 settlement, delegated effective-rate enforcement, manager-fee bounds/snapshotting, net settlement accounting, the relayer/multiple-intent hard cut, fixed/Pyth/static-oracle effective-rate behavior including source lifecycle/staleness/signed spread rounding, both legacy/V2 ProtocolViewer aggregation, OrchestratorV2 pre-intent hook administration/execution/signature gating/reentry containment, and dedicated whitelist-hook access control plus dual-hook atomicity. The verifier core files deliberately record their remaining legacy/V3 actual-Orchestrator shadow gates as pending rather than overclaiming interface-harness evidence.

## Fuzz and invariant catalog

Pending deterministic parity completion. Foundry-native tests cannot receive parity credit.

## Mutation audit

Pending. Mutants will never be committed.

## Pull request and CI

No pull request exists yet. Branch protection endpoint currently reports no classic protection rule; merge will still wait for all relevant checks and required approvals.

## Final merge verification

Pending actual merge, fetched `origin/main` verification, and post-merge workflow inspection.
