# Deterministic Hardhat-to-Foundry parity report

This report closes the deterministic translation gate on branch commit `405a395143acc897a6741170dc1412b5f871f1e6`, based on `origin/main` commit `845f8a077404a3c000e723265288f83be65194c7`. It does not claim completion of the overall migration: Foundry-native fuzz/invariant assurance, final coverage, CI, cleanup, review, and merge remain separate gates.

## Same-commit shadow result

| Oracle group | Hardhat result | Command | Time |
| --- | ---: | --- | ---: |
| Canonical | 1,303 passed, 5 pending, 0 failed | `corepack yarn test` | 96.14s warm |
| Patch coverage | 33 passed, 0 pending, 0 failed | `corepack yarn hardhat test test/patchCoverage/*.ts` | 5.47s warm |
| Deployment | 176 passed, 0 pending, 0 failed | fresh `corepack yarn deploy:localhost`, then `corepack yarn hardhat test test/deploy/*.ts --network localhost --no-compile` | 8.21s deploy + 3.07s tests |
| Total inventory | 1,512 executable passed, 5 pending | 61 files / 1,517 runtime-expanded rows | — |

The translated deterministic Foundry suite contains 1,399 live tests. Every file passed independently. Three complete warm runs passed 1,399/1,399 with zero skips in 1.07s, 1.09s, and 1.08s (median 1.08s; range 0.02s). The final full summary run immediately before the repeats also passed in 1.04s.

## Mechanical reconciliation

`node foundry-migration/tools/inventory-hardhat-tests.cjs`, `node foundry-migration/tools/render-parity-manifest.cjs`, and `node foundry-migration/tools/audit-parity-manifest.cjs` independently re-enumerate the source and enforce:

- all 61 Hardhat source hashes still match the committed inventory;
- all 1,517 inventory rows exactly match the manifest in stable ID, source, suite, name, scenario, behavior, and fixture dependencies;
- all 1,517 rows have verified destinations and evidence;
- all 1,388 unique mapped destinations exist in Forge's live test list;
- no source row is unmapped and no mapped destination is missing;
- all five baseline-pending rows have executable Foundry resolutions; and
- 11 additional deterministic tests strengthen behavior beyond the source rows.

The audit reports 77 consolidated destinations covering 206 source rows, a net physical reduction of 129 tests. There are zero split source rows. Consolidation occurs only where one action is followed by several Hardhat assertions or where a coverage-only duplicate is already fully asserted by a normal semantic test. The manifest retains an explicit destination for every individual source row, and the audit emits counts by source file. The 11 additive tests cover restored/commented constructor wiring and additional oracle, delegated-manager, batch-dimension, and RateManager authorization/input branches.

## Formerly pending Hardhat cases

| Stable ID | Resolution |
| --- | --- |
| `HH-A060151C1335` | `EscrowPruningParityTest::test_PruneAfterExpiryCallsOrchestratorAndEmits` executes the expired-prune callback and event assertion. |
| `HH-1B5CA3E7767F` | `OrchestratorSignalParityTest::test_SignalIntentPrunesExpiredIntentAndUpdatesDeposit` verifies reclaimed deposit accounting. |
| `HH-B8EC08509524` | `OrchestratorSignalParityTest::test_SignalIntentPruningDeletesOriginalOrchestratorIntent` verifies deletion. |
| `HH-A076255916EA` | `OrchestratorSignalParityTest::test_SignalIntentPruningEmitsIntentPruned` verifies the exact lifecycle event. |
| `HH-C665239F06EE` | `OrchestratorSignalParityTest::test_SignalIntentRejectsWhenUnexpiredLiquidityCannotCoverAmount` verifies the negative boundary. |

## Environment and semantic differences

- Hardhat deployment assertions require a freshly deployed localhost node; their Foundry counterparts instantiate the equivalent real constructor/configuration topology per test, while FFI is limited to assertions about actual TypeScript deployment-helper behavior or source/type exports.
- The five Hardhat pending cases are not carried forward as exemptions; they execute normally in Foundry.
- Coverage-only Hardhat groupings are represented as named semantic tests in their normal domain files, not as coverage-gaming calls.
- The deterministic suite uses isolated `setUp` state and explicit actors. It passed every file independently and repeatedly as one suite; no execution depends on source ordering.

## Gate decision

Deterministic parity is complete: 1,517/1,517 source behaviors are traceable, executable, and mechanically reconciled with zero omissions. The Hardhat test files may now be removed after preserving this report, the inventory, the manifest, and the baseline coverage artifacts. Production Hardhat deployment/build/release infrastructure remains out of scope for deletion.
