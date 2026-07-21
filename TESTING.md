# Foundry testing

Foundry is the repository's only contract test system. Hardhat remains installed for production compilation, deployment, TypeChain generation, verification, and package release; it is not a test runner.

## Canonical commands

Install the pinned dependencies and run the complete suite:

```bash
corepack yarn install --immutable
corepack yarn test
```

Focused layers are available for iteration:

```bash
corepack yarn test:deterministic
corepack yarn test:fuzz
corepack yarn test:invariant
forge test --match-path 'test-foundry/deterministic/escrow/EscrowCreateDepositParity.t.sol'
forge test --match-test test_CreateDepositStoresEveryField
```

The canonical profile in `foundry.toml` runs 512 cases for each fuzz property and 128 stateful invariant runs at depth 64. `fail_on_revert = true`; handlers catch and count only explicitly expected reverts. CI never lowers these values.

## Reproducing fuzz and invariant failures

Forge prints a replayable counterexample and seed on failure. Re-run the affected layer with that exact 32-byte seed:

```bash
forge test --match-path 'test-foundry/fuzz/**/*.t.sol' --fuzz-seed 0x<seed> -vvvv
forge test --match-path 'test-foundry/invariant/**/*.t.sol' --fuzz-seed 0x<seed> -vvvv
```

Promote every genuine counterexample to a named deterministic regression test before fixing it. Do not hide a failure with a narrower `bound`, broader `assume`, reduced run count, or ignored revert.

## Coverage

Run the clean-checkout coverage workflow with:

```bash
corepack yarn coverage
```

Solidity 0.8.18 cannot compile several stack-heavy production contracts after ordinary coverage disables optimizer/IR. The coverage tool therefore:

1. executes the complete suite once with Foundry's supported `--ir-minimum` fallback and a fixed coverage seed;
2. reconstructs the 1,512 behaviors that actually executed in the starting Hardhat run from the immutable inventory/manifest and runs their exact Foundry destinations in two selector partitions;
3. compares that starting-behavior bridge with the complete suite on identical minimal-IR line, statement, branch, and function denominators, requiring strict line/branch improvement and no aggregate or per-file regression;
4. runs exact-source standard-compiler shards for contracts whose source maps are more accurate without IR;
5. merges hit maxima only onto the original minimal-IR anchors and independently requires an LCOV record for every current production file; and
6. rejects stale or unexplained instrumentation gaps recorded in `foundry-migration/coverage-exceptions.json`.

The historical Hardhat and final Foundry percentages remain useful absolute evidence, but they are not compared directly: Istanbul and Foundry model Solidity branches differently. The enforced improvement uses one Foundry compiler/anchor denominator on both sides. The bridge deliberately includes selector-collision additions, making its baseline conservative.

Generated artifacts are:

- `coverage/lcov.info` — canonical Codecov input
- `coverage/foundry-coverage-summary.json` — machine-readable overall and per-file results
- `coverage/foundry-coverage-by-file.csv` — review-friendly per-file table
- `coverage/shards/*.log` — full compiler/test diagnostics

CI uploads only `coverage/lcov.info` under the `foundry` flag using Codecov OIDC. Upload errors fail the job. `codecov.yml` requires 99.42% project coverage and 100% patch coverage.

## Adding tests

### Deterministic behavior

Place the test in the matching domain under `test-foundry/deterministic/`. Use explicit actor addresses, assert exact custom-error arguments and events where meaningful, and verify the complete state/balance postcondition. Deployment changes require a deterministic topology or deployment-helper test. Every test must pass alone and in the complete suite.

The historical one-to-one Hardhat migration is preserved in `foundry-migration/hardhat-to-foundry-manifest.csv`. If changing a migrated behavior, keep its named destination stable or update the manifest and parity audit with an explicit rationale.

### Fuzz properties

Place additive real-contract properties under `test-foundry/fuzz/`. Document the protocol risk the property covers, exercise production calls, use broad bounded inputs, and include negative and multi-step behavior where useful. Do not add arithmetic-only mirrors of production formulas.

### Stateful invariants

Place handlers under `test-foundry/invariant/handlers/` and invariant contracts under `test-foundry/invariant/`. Target selectors deliberately, use multiple realistic actors, maintain sufficient ghost state, and assert both a protocol property and handler reachability. Expected reverting actions belong inside the handler; an uncaught revert must fail the run.

There are no fork-dependent tests. Chain-dependent behavior was replaced with deterministic fixtures so every required suite runs on every push and pull request without an RPC secret or mutable live-head state.

## Expected local runtimes

On the recorded Apple M5 Max / Foundry v1.7.1 baseline host, deterministic tests take about 0.8s warm and the complete suite takes about 5.6s warm. Coverage takes about 14 minutes because it runs the complete IR suite, two same-denominator bridge partitions, and 16 mapping shards; see `foundry-migration/EVIDENCE.md` for the component timings. A genuinely clean production-like via-IR compile is expensive (about 15.3 minutes for 242 files); subsequent runs use Foundry's content-addressed cache. CI restores this cache opportunistically but never relies on it for correctness.
