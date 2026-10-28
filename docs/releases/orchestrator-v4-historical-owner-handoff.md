# Staging historical-owner handoff

This operator-local helper performs exactly seven zero-value calls on Base chain
8453. It never activates the new verifier, changes payment routing, registers O4,
or edits deposit privacy. The operator retains the historical key locally; do not
import it into a service or replace `STAGING_DEPLOYER_KEY`.

Use a clean checkout of the reviewed, CI-green commit supplied with this handoff.
The helper verifies its tracked source and imported modules before any chain work.
Inject `BASE_RPC_URL` and, only for `apply`, `O4_HISTORICAL_OWNER_KEY` directly into
the process environment using the operator's trusted secret runtime. Never put a
key in a command argument, shell history, `.env`, journal, or report. The key must
derive `0xdd93E0f5fC32c86A568d87Cb4f08598f55E980F3`; no alternate signer is accepted.

The fixed plan hash is
`2dc519aeb02fc17c254c1f235102987c39879fe12163feac14211a6bb554f909`.
Every call has value zero. In order:

| Phase | Target | Call |
| --- | --- | --- |
| pause | `0xF9b9CD27Deea496B960b3cb5221b514705fCaF5e` | `pauseOrchestrator()` |
| pause | `0x338dfB48fAcA1F2dddD0da83Ecb31819b0Cf4612` | `pauseOrchestrator()` |
| handoff | `0xfA6384EB6176cfEC049540526A3d2126C3666d8A` | `transferOwnership(0x41123d6419C7b8e44157f6F3b0088442116641eC)` |
| handoff | `0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc` | same ownership transfer |
| handoff | `0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C` | same ownership transfer |
| handoff | `0xE0B05a9655AF0f31E32904267baa50FbC7f217ea` | same ownership transfer |
| handoff | `0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E` | `addRelayer(0xBC6Ca58369853D77a9A2f33358334BF9E9B9094F)` |

Pause calldata: `0x45a734b7`.
Ownership calldata: `0xf2fde38b00000000000000000000000041123d6419c7b8e44157f6f3b0088442116641ec`.
Relayer calldata: `0xdd39f00d000000000000000000000000bc6ca58369853d77a9a2f33358334bf9e9b9094f`.

The default action is read-only `plan pause`. Inspect both phases before applying.
The `handoff` apply phase requires both pause receipts in the same journal.

```sh
node -r ts-node/register/transpile-only scripts/handoff-staging-owner.ts plan pause
node -r ts-node/register/transpile-only scripts/handoff-staging-owner.ts plan handoff
node -r ts-node/register/transpile-only scripts/handoff-staging-owner.ts apply pause 2dc519aeb02fc17c254c1f235102987c39879fe12163feac14211a6bb554f909
node -r ts-node/register/transpile-only scripts/handoff-staging-owner.ts verify pause
node -r ts-node/register/transpile-only scripts/handoff-staging-owner.ts apply handoff 2dc519aeb02fc17c254c1f235102987c39879fe12163feac14211a6bb554f909
node -r ts-node/register/transpile-only scripts/handoff-staging-owner.ts verify handoff
```

Keep exclusive custody of the historical account's transaction nonce while a
phase runs. The helper checks chain, exact runtime hashes, owners, legacy intent
counters, confirmed call prefix, latest/pending nonce, simulation, and balance.
Each signature is restricted to its exact target/calldata/value/nonce, with gas
limit at most 150,000 and max fee at most 0.1 gwei. The required 0.0002 ETH balance
reserve exceeds the seven-call maximum L2 fee of 0.000105 ETH and leaves room for
Base L1 data fees. The read-only plan prints current estimates separately; gas
fees are spent, no ETH is transferred by these calls.

The journal defaults to
`deployments/outputs/orchestrator-v4-historical-owner.json`; optionally set
`O4_OWNER_JOURNAL` to a private local path whose parent directory already exists.
Journal, lock and signed pending bytes use mode 0600. Keep the `.pending` file
private: it can authorize the exact signed transaction. Publish only confirmed
transaction hashes, receipts and state readback. Do not upload pending raw bytes.

After interruption, retain the journal and `.pending` file and rerun `plan` before
the same apply phase. Recovery reconciles canonical receipts without broadcasting,
checks the resulting state and nonce prefix, and only then may rebroadcast the
same signed bytes. It never replaces a transaction or chooses a new nonce for a
pending step. An unrelated nonce, unknown pending transaction, changed owner or
noncanonical receipt stops execution. If a process died leaving `.lock`, first
prove that process and any other signer are stopped; then remove only that stale
lock. Do not delete the journal or create another one to bypass a failed guard.

Ownership handoff does not establish activation readiness. Record both canonical
pause blocks, let the existing indexer catch up, and obtain a fresh drain query.
The existing indexer has no coverage of the obsolete October 16 O4. Activation
therefore also authenticates all 290 V1 and 38 obsolete O4 signal receipts against
their monotonic counters and reads every intent at the pause observation and
current block. An old V1 mapping may remain only when its exact historical escrow
has an authenticated matching `FundsUnlocked` event, a fully deleted lock and no
deposit intent-hash entry at both blocks. The 23 known old V1 orphan records do
not imply locked funds. This exception cannot apply to obsolete O4.

After the pause, supply `legacySignals` alongside the existing drain evidence:

```json
{
  "legacySignals": {
    "Orchestrator": [{"transactionHash":"0x...","logIndex":0,"unlock":{"transactionHash":"0x...","logIndex":1}}],
    "OrchestratorV4Historical20261016": [{"transactionHash":"0x...","logIndex":0}]
  }
}
```

`unlock` is required only for a remaining V1 mapping. This example is schematic;
the complete inventory, query response and post-pause block must be supplied.
The complete pre-pause signal references are preserved in
`deployments/orchestrator-v4/historical/2026-10-22/legacy-drain-signals.json`; references remain useful,
but their existence does not replace fresh post-pause chain reads and indexer
evidence. Full historical log enumeration independently matched all 290/38 refs.
The migrated deployer's separate activation runner still enforces the complete
privacy migration, post-pause drain and all registry/wiring checks.

The deployment manifest keeps its original `sourceCommit`. A reviewed upgrade to
the execution checks is recorded explicitly as `executionToolCommit` after that
exact commit passes CI. Compiled contracts, compiler configuration and deployment
configuration must remain identical to the deployed source. Execution modules and
historical ABI records must match the pinned tool commit, and dirty source fails.
The immutable rc.8 package and address sidecar remain unchanged.

Rollback of these owner calls is an explicit operation, never automatic: the
migrated owner can transfer each of the four registries back to the historical
owner; the historical owner still controls both paused orchestrators and the
RelayerRegistry. Keep both obsolete orchestrators paused once shared verifier
routing changes. Any later rollback must use the main release runbook's dependency
order and live drain/privacy checks.
