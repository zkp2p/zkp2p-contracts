# Foundry Coverage CI Optimization Experiments

This log records attributable experiments for the Foundry coverage CI runtime
investigation. Runtime improvements are accepted only when the pre-merge
correctness and coverage signals remain unchanged.

## Starting state

- Date: 2026-07-23 (Asia/Bangkok)
- Branch: `codex/optimize-foundry-coverage-ci`
- Starting `origin/main`: `33cc22f353c62bb82b1a56c7b054e1a08005b50c`
- Node: `v20.20.2`
- Yarn: `4.9.1`
- Forge: `1.7.1`, commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`
- Solidity: Foundry-pinned `0.8.18` (`foundry.toml`); no standalone `solc`
- Forge Standard Library: `8bbcf6e3f8f62f419e5429a0bd89331c85c37824`

## Accepted GitHub Actions reference

| State | Run | Coverage command | Coverage job |
| --- | --- | ---: | ---: |
| Warm PR | [29909605866](https://github.com/zkp2p/zkp2p-contracts/actions/runs/29909605866) | 7m53s | 8m34s |
| Cold post-merge | [29907261009](https://github.com/zkp2p/zkp2p-contracts/actions/runs/29907261009) | 8m25s | 9m04s |

The accepted warm run's complete Foundry test command took 28 seconds. The
coverage job has no Foundry artifact cache and uploads `coverage/lcov.info`
through Codecov OIDC with `fail_ci_if_error: true`.

## Baseline B0: clean local coverage

**Hypothesis:** Establish the untouched component baseline and confirm whether
the exact-source shards or the complete minimal-IR pass dominates runtime.

**Cache state:** Clean worktree with no `out`, `cache_forge`, or `coverage`;
dependencies and the pinned submodule freshly installed.

**Command:**

```sh
/usr/bin/time -p corepack yarn coverage
```

**Result:**

- Wall: 294.51s
- User: 291.12s
- System: 16.76s
- `full-ir`: 281.32s (95.5% of wall)
- Sixteen exact-source shards: 11.87s total
- LCOV merge, reconstruction, validation, and output: approximately 1.32s
- No `out` or `cache_forge` directory was emitted; `forge coverage` used
  ephemeral compilation artifacts.

**Coverage:**

| Metric | Covered / total | Percent |
| --- | ---: | ---: |
| Lines | 2930 / 2947 | 99.42% |
| Statements | 3264 / 3307 | 98.70% |
| Branches | 756 / 798 | 94.74% |
| Functions | 458 / 458 | 100% |

- Production files: 35
- Exit status: 0

**Conclusion:** Optimize the `full-ir` pass. Complexity around the exact-source
shards or JavaScript merge/gating cannot provide a material saving.

## Baseline B1: unchanged warm local coverage

**Hypothesis:** Determine whether Forge reuses coverage compilation after an
identical successful run.

**Cache state:** Prior coverage output present; no `out` or `cache_forge`
exists because `forge coverage` emits neither.

**Command:** Same as B0.

**Result:**

- Wall: 301.75s
- `full-ir`: 287.76s
- Coverage and all denominators: identical to B0
- No coverage compilation artifact was reused.

**Conclusion:** Restoring the ordinary `out` and `cache_forge` directories
cannot accelerate this Forge 1.7.1 coverage path. A dedicated coverage cache is
not implementable from supported emitted artifacts, and caching LCOV would
violate the fresh-evidence requirement.

## Experiment E1: deterministic test-directory partitions

**Hypothesis:** The monolithic compile is dominated by compiling all
deterministic test contracts together. Compiling top-level deterministic test
directories independently may reduce the critical path while retaining the
full production source root and executing every test.

**Change:** No retained code change for the measurement. Ran one minimal-IR
coverage command for each top-level directory containing `.t.sol` files.

**Cache state:** Forge coverage rebuild for every command.

| Partition | Local wall |
| --- | ---: |
| deployment | 39.81s |
| escrow | 97.30s |
| hooks | 22.84s |
| integration | 19.01s |
| libs | 16.50s |
| oracles | 16.25s |
| orchestrator | 78.62s |
| periphery | 22.11s |
| rateManager | 19.05s |
| registries | 19.03s |
| staking | 89.88s |
| verifiers | 21.07s |

All partitions collectively ran the same 97 suites and 1,517 tests as B0.
Every partition emitted all 35 production files.

Four measured lanes were selected:

| Lane | Partitions | Isolated local sum |
| --- | --- | ---: |
| escrow | escrow, integration | 116.31s |
| staking | staking, verifiers | 110.95s |
| orchestrator | orchestrator, rateManager, libs | 114.17s |
| remaining | deployment, hooks, oracles, periphery, registries | 120.04s |

**Initial merge result:** Rejected. Line, branch, and function anchors matched,
but Foundry's summary reporter exposes statements only as per-file aggregate
counts. Taking the maximum partition count produced only 97.67% statement
coverage and failed the 98.70% gate. The aggregate-only merge is unsafe.

**Conclusion:** Partitioning is viable only if statement hits can be merged by
an exact, stable source identity.

## Experiment E2: exact statement reconstruction

**Hypothesis:** Foundry's debug reporter identifies every statement by source
file and exact byte range. Reconstructing statement hits by `(file, byteStart,
byteEnd)` can safely union partition results without changing the denominator.

**Attributable change:**

- Minimal-IR partition runs also request the debug report.
- The merge requires every partition to expose identical production-file and
  line/branch/function/statement anchor shapes.
- Statement hits are unioned by exact byte range.
- The existing standard-compiler exact-source summary maxima remain in place
  for the documented cross-configuration exceptions.
- Partition definitions must exactly cover every top-level deterministic test
  directory containing a `.t.sol` file.

**Local result:**

- Concurrent four-lane wall: approximately 142s
- Lane totals with debug output: 112.55s to 121.98s
- Exact-source shards and merge: approximately 13s cold; 0.44s merge-only
- Test execution: 97 suites, 1,517 tests, zero failed/skipped
- Production files: 35 in every partition
- Final metrics and per-file CSV: exactly identical to B0
- LCOV anchor identities and covered/missed states: exactly identical to B0
- LCOV raw positive hit counts differ because partition maxima replace
  monolithic aggregate execution counts; Codecov coverage semantics are
  unchanged.

**Conclusion:** Retain for CI validation. This design does not use a reusable
coverage cache. Matrix artifacts are freshly generated within, and named for,
the current workflow run and attempt.

## Failure-mode validation

The following probes were performed against fresh E2 partition outputs. Each
command exited non-zero as required, and the original generated artifact was
restored after the probe.

| Probe | Exit | Rejection |
| --- | ---: | --- |
| Missing partition LCOV | 1 | Explicit missing-input error |
| Truncated partition LCOV | 1 | Incomplete production denominator |
| Truncated debug/summary log | 1 | Missing statement anchors |
| Invalid timing JSON | 1 | JSON parse/contents failure |
| New unassigned deterministic test directory | 1 | Partition inventory mismatch before compilation |
| Intentional failing deterministic test in an assigned directory | 1 | Forge failure propagated through the lane |

The inherited `--resume` behavior was removed. Neither local nor CI coverage
can treat existing LCOV/log/timing files as fresh execution evidence. The CI
merge accepts only artifacts produced by its required matrix jobs in the same
workflow run and attempt; a failed lane prevents the merge job from running.

## Local retained-change validation

### Clean coverage output

The retained runner was executed after moving the entire prior `coverage`
directory aside. It regenerated every deterministic result and exact-source
shard from source:

- Wall: 301.49s
- `full-ir`: 287.76s
- Production files: 35
- Lines: 2930 / 2947 (99.42%)
- Statements: 3264 / 3307 (98.70%)
- Branches: 756 / 798 (94.74%)
- Functions: 458 / 458 (100%)
- Exit status: 0

### Complete Foundry suite isolation

The ordinary production-like Foundry profile was then run with its own empty
`out` and `cache_forge` directories:

| State | Wall | Result |
| --- | ---: | --- |
| Cold | 1047.12s | 104 suites; 1,541 passed; 0 failed/skipped |
| Exact warm hit | 6.37s | Compilation skipped; 1,541 passed; 0 failed/skipped |

This includes the existing fuzz and invariant run/depth settings. It also
confirms that coverage neither populates nor changes the ordinary optimized
test artifacts or compiler settings.

### Build, package, deployment, and changed-file checks

- `corepack yarn compile`: 124 Solidity files compiled successfully in 95.58s.
- `corepack yarn pkg:build`: passed in 6.73s.
- `corepack yarn pkg:test`: 3 suites and 8 tests passed in 2.73s.
- `corepack yarn deploy:localhost`: the complete active deployment sequence
  passed against a fresh Hardhat node in 8.87s.
- `node --check scripts/run-foundry-coverage.cjs`: passed.
- Ruby YAML parse of `.github/workflows/ci.yml`: passed.
- `git diff --check`: passed.

There is no repository lint or format script. `forge fmt --check` was also
probed, but it reports extensive pre-existing differences across untouched
production and test Solidity on the starting SHA, so it is not a usable
project gate for this infrastructure-only change.
