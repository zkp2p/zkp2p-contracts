# Affine Risk Manager Staging E2E Test Plan and Outcomes

## Document control

| Field               | Value                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status              | Plan and read-only contract baseline complete; transaction/indexer execution blocked on the fully synced Envio endpoint                                     |
| Test oracle         | `STAKE_RISK_POLICY_SPEC.md` from contracts `main` at `c063b10953cabadf2149a84e3920b99ddfb0184d`                                                             |
| Target              | Base staging contracts and the Envio staging deployment indexing those contracts                                                                            |
| Curator             | Out of scope until contracts and indexer packages are released after this test pass                                                                         |
| Secrets             | Use the contracts `.env` key whose derived public address is the approved `0x84…` deployer. Never print, persist, or pass the key on a command line.        |
| Approved divergence | A stake owner, including a Safe, may authorize a different taker/relayer to consume its stake. Owner authorization is one-sided; the taker does not opt in. |

This document is both the pre-implementation-independent plan and the durable execution record. Expected results come from the approved policy specification. Contract and indexer implementation details may determine how a transaction or query is encoded, but cannot redefine the expected outcome.

## Scope and release gates

This pass validates the deployed contracts and indexer together. It covers policy configuration, stake ownership and delegation, affine reservation mathematics, free takes, position lifecycle, slashing, deferred payouts, batch operations, administrative gates, events, and indexed current and derived state.

The pass does not validate curator APIs, client presentation, production migration, or large historical-volume behavior. Curator remains held until the contracts and indexer packages are released after testing.

The staging release is acceptable when:

1. Every `EXEC` case is `PASS`, or has a documented high-confidence product decision accepting the result.
2. No unresolved high-confidence severity-high or severity-critical defect exists.
3. Contract reads, emitted events, and indexer entities reconcile exactly in raw token units.
4. Every `BLOCKED` or `DEFERRED` case has a concrete reason and pre-production follow-up.
5. Any temporary governance/configuration mutation is restored and evidenced.

## Classification and result vocabulary

| Code      | Execution class                  | Meaning                                                                                                                                                                                                 |
| --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXEC`    | Executable                       | Use controlled staging actors and modest amounts; expected to run in this pass.                                                                                                                         |
| `DATA`    | Data-dependent                   | Requires an external payment proof, chargeback attestation, existing deposit, guardian action, or naturally elapsed time. Run only when the required data already exists or is cheap to produce safely. |
| `GOV`     | Destructive/governance-sensitive | Changes global configuration, pause state, authorization, or other shared staging state. Run in an announced short window, snapshot first, and restore in `finally`-style cleanup.                      |
| `PREPROD` | Defer to pre-production          | Requires large volume, long waits, induced reorgs, broad concurrent traffic, or other staging-inappropriate conditions. Do not fabricate expensive data.                                                |

| Result     | Meaning                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `PASS`     | Observed contract and indexer state exactly match the policy oracle.             |
| `FAIL`     | Deterministic mismatch with sufficient evidence.                                 |
| `BLOCKED`  | Intended for this pass, but an external dependency or safe setup is unavailable. |
| `DEFERRED` | Deliberately moved to pre-production under the stated classification.            |
| `NOT RUN`  | Execution has not started.                                                       |

## Normative mathematical oracle

All calculations use raw integer token units. For six-decimal USDC, `1 USDC = 1_000_000` raw units. No floating-point values are used.

Define exact unsigned integer ceiling division as:

```text
ceilDiv(n, d) = 0                         if n == 0
                ((n - 1) / d) + 1        otherwise
```

For bonded intent amount `A`, elapsed seconds `t`, snapshotted maximum intent period `T`, cliff `C`, griefing slope `s` in bps/hour, and chargeback reserve `r` in bps:

```text
effectiveElapsed        = min(t, T)
chargeableTime          = max(effectiveElapsed - C, 0)
griefingPenalty(A, t)   = ceilDiv(A * s * chargeableTime, 10_000 * 3_600)
maxGriefingBond(A)      = ceilDiv(A * s * (T - C), 10_000 * 3_600)
chargebackReserve(A)    = ceilDiv(A * r, 10_000)
requiredReservation(A) = max(maxGriefingBond(A), chargebackReserve(A))
```

Expected staging profile, subject to direct post-deployment verification:

| Platform class            | Chargebackable | Deferred payout |    Reserve | Risk window |      Cliff |       Slope |                                 Free takes |
| ------------------------- | -------------: | --------------: | ---------: | ----------: | ---------: | ----------: | -----------------------------------------: |
| Reversible/chargebackable |            yes |             yes | 10,000 bps |     30 days | 15 minutes | 10 bps/hour |                                       none |
| Non-chargebackable        |             no |              no |          0 |           0 | 15 minutes | 10 bps/hour | 3 lifetime intents of at most 20 USDC each |

A deployed mismatch against this approved profile is recorded as a configuration failure. The test oracle must not be altered to match the deployment.

Base staging intentionally retains Escrow V2's one-hour maximum intent period, while production uses six hours. Therefore staging calculations use `T = 3_600`, `C = 900`, `T - C = 2_700`, and a maximum griefing rate of 7.5 bps at the configured 10 bps/hour slope. The six-hour configuration remains a production/pre-production case and is not a staging deviation.

### Reservation and lifecycle invariants

- A bonded pending intent reserves the larger of maximum griefing bond and chargeback reserve, never their sum.
- Reservations across all platforms, takers, and positions backed by the same owner share one stake balance.
- A free intent is wholly free or wholly bonded; free capacity cannot be a tranche of a larger intent.
- Free allowance is consumed only by successful signaling and is never restored by cancellation, expiry, or fulfillment.
- Fulfillment never charges griefing penalty.
- Cancellation penalty uses the time liquidity stopped being locked and cannot exceed the snapshotted maximum griefing bond.
- Guardian extensions cannot increase griefing liability beyond the snapshotted Escrow intent period.
- A fulfilled chargebackable position resizes coverage using the exact released amount and retains it until chargeback consumption or maturity.
- Governance changes affect new positions only; every open position retains its snapshotted terms.
- There is no tier, cooldown, protocol risk count limit, per-intent risk maximum, or protocol-wide exposure ceiling.
- Escrow operational bounds remain allowed and must not be misreported as affine risk policy.

## Environment and evidence inventory

Complete this table before sending a transaction.

| Item                                | Planned value                                                    | Execution value                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Chain / chain ID                    | Base staging / verified from RPC                                 | Base / `8453`                                                                                            |
| RPC hostname                        | Redacted to hostname; sourced from `.env`                        | `base-mainnet.infura.io`; credential omitted                                                             |
| Deployer/governance                 | Approved address derived from `.env`, ending in/known as `0x84…` | `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929`                                                             |
| Contracts git/deployment commit     | Merged source plus staging deployment commit                     | Source `c063b10953cabadf2149a84e3920b99ddfb0184d`; deployment `37cd10303c9de0b5494a1d1112685c01f7bbf2fc` |
| Deployment transaction block range  | Supplied by deployment task                                      | `48,667,836–48,667,851`; common indexer start `48,667,836`                                               |
| Stake vault                         | Supplied by deployment task                                      | `0x5c570D2be2bFD8960B2B9F8d2D3C8148A1e24C5f`                                                             |
| Risk manager                        | Supplied by deployment task                                      | `0x57E4b9046EA5ABCe1fc688b77D846aE67222b998`                                                             |
| Orchestrator V3                     | Supplied by deployment task                                      | `0x79dE2123eE792e77165b2E6E65A54B745E8A734E`                                                             |
| Escrow V2 instance(s)               | Supplied by deployment task                                      | Existing `0x77e8f808FE201075e0bD651CD46fdF239fc83265`; registered; `T=3,600s`                            |
| Deferred payout hook                | Supplied by deployment task                                      | `0xd279997e057b22ecC4660C7bBaD82FF0017B08A9`                                                             |
| USDC/token                          | Supplied by deployment task; verify decimals on-chain            | Canonical USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; 6 decimals                                  |
| Indexer code commit                 | Reviewed/merged indexer commit                                   | `TBD`                                                                                                    |
| Envio deployment ID and start block | Supplied by indexer deployment task                              | `TBD`                                                                                                    |
| New raw GraphQL endpoint            | Fully synced deployment endpoint                                 | `TBD`                                                                                                    |
| Staging proxy endpoint              | Observe only unless separately routed                            | `TBD`                                                                                                    |
| Reference/previous endpoint         | For smoke comparisons, if applicable                             | `TBD`                                                                                                    |
| Block explorer                      | Base staging explorer                                            | `https://basescan.org`                                                                                   |

### Controlled actor matrix

Fresh actors prevent existing staging history from contaminating lifetime counters. Seed only the minimum test balances.

| Actor          | Purpose                                                                         | Funding/authority           | Persist public address?                      |
| -------------- | ------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------- |
| `GOV`          | `0x84…` deployer/governance; configuration and authorized test funding          | Existing `.env`; native gas | `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929` |
| `OWNER_A`      | Primary stake owner; Safe if one is available, otherwise fresh EOA for baseline | USDC stake + gas            | `0x6B3D5891feDBd84eeE41c8102DD93CD1A831500A` |
| `OWNER_B`      | Isolation/control owner                                                         | Small USDC stake + gas      | `0xCdeA13723c13fb64b5C7bf4bb667d0d62CeEd6a8` |
| `TAKER_A1`     | Relayer/taker authorized by `OWNER_A`                                           | Gas only                    | `0x2a04CDA40Fb160C2e65a662Ac8973DEBDa3fCD89` |
| `TAKER_A2`     | Second relayer using the same `OWNER_A` portfolio                               | Gas only                    | `0x78F5f207f2624ee51593eF54E073240aF2cC0Ed8` |
| `TAKER_B`      | Taker backed by `OWNER_B`                                                       | Gas only                    | `0x3963dd3e8DFa6d88a1787A4019b7d397345cfDAd` |
| `LP_A`         | Creates controlled deposits and receives penalties/chargeback compensation      | Deposit USDC + gas          | `0xabfAF04b4410040C1DaeD4a69a017617d1d05c78` |
| `LP_B`         | Isolation and LP-grouped exposure checks                                        | Deposit USDC + gas          | `0xaBD9C80B7F76F08b92f33fF9c14941b678eaAA50` |
| `RECIPIENT`    | Intent proceeds recipient                                                       | Gas optional                | `0xB23d9cF1A38E0AaE06F3b4F26c47184D2dDfeb36` |
| `UNAUTHORIZED` | Negative calls and attempted stake use                                          | Gas only                    | `0x553334e92f04479422feBC51CbFe71b44BeE7c98` |
| `CALLER`       | Permissionless maturity/reconciliation/batch caller                             | Gas only                    | `0xCea8cCcf74FF60805E1C3a84864Fc085199A0888` |

Never commit actor private keys. The execution record stores only public addresses, transaction hashes, and raw observations.

### Platform/deposit matrix

Use existing configured payment methods when safe. Create isolated deposits owned by the controlled LPs. If a required policy variant is unavailable, treat temporary configuration as `GOV` and restore it; do not silently substitute a different policy.

| Label        | Required configuration/use                                                             | Preferred class              |
| ------------ | -------------------------------------------------------------------------------------- | ---------------------------- |
| `NCB_FREE`   | Enabled non-chargebackable, 0 reserve, 15m/10 bps-hour, 3 × 20 USDC free               | `EXEC`                       |
| `NCB_BONDED` | Same platform after free count exhaustion, or enabled no-free method                   | `EXEC`                       |
| `CB_FULL`    | Enabled chargebackable, 10,000 bps, 30d, deferred enabled, no free                     | `EXEC`/`DATA`                |
| `CB_PARTIAL` | Chargebackable with safe temporary sub-100% reserve config                             | `GOV`; otherwise `PREPROD`   |
| `DISABLED`   | Disabled risk policy                                                                   | `GOV`                        |
| `DEFERRED`   | `CB_FULL` deposit selecting the required deferred-payout hook                          | `DATA`                       |
| `PLAIN_HOOK` | Deposit with no hook or a non-protocol hook for quote/filter compatibility observation | `DATA`; curator out of scope |

## Evidence bundle required for every executed case

Each result row links or embeds an evidence bundle containing:

1. Case ID, UTC start/end, actor addresses, amount in raw units and display units, platform/deposit/intent IDs.
2. Preconditions: block number, relevant config, token decimals, stake totals/free/reserved, counters, and position state.
3. Submitted transaction hash, receipt status, block number/hash/timestamp, gas used, and decoded logs in log order.
4. Independent expected calculation in raw `bigint`, including numerator, denominator, rounding direction, and chosen `max` branch.
5. Post-transaction contract reads at the receipt block or latest finalized block.
6. Raw GraphQL request and response after polling, plus indexed block/timestamp if exposed.
7. Reconciliation table: raw event delta → contract state delta → each current/derived entity delta.
8. Result and any discrepancy. For failures: minimal reproduction, confidence, severity, and whether it is contract, deployment/config, or indexer behavior.

Indexer polling uses a deterministic timeout recorded before execution. A transaction is not marked failed merely because indexing is delayed; timeout produces `BLOCKED` or a separate indexing `FAIL` only after the endpoint is confirmed healthy and past the receipt block.

## Large end-to-end scenarios

Run these in order unless a data dependency makes a later independent scenario safer to execute first.

| Scenario                                        | Class                    | End-to-end objective                                                                                                                                                                                           | Required evidence                                                                                                                       |
| ----------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `S01` Deployment/config bootstrap               | `EXEC`                   | Prove addresses, ownership/wiring, admission policy, token decimals, expected launch configs, and indexer start/config are coherent before risking funds.                                                      | All deployment receipts, address/code hashes, config reads, initial GraphQL entities, indexed head.                                     |
| `S02` Free onboarding lifecycle                 | `EXEC`                   | With a fresh owner and multiple authorized relayers, consume exactly three ≤20 USDC free intents on `NCB_FREE`; mix fulfillment/cancellation; prove no stake reservation/slash and no allowance restoration.   | Counter after every signal, free flag, zero reservation, terminal entities, owner/platform aggregate.                                   |
| `S03` Non-chargebackable griefing lifecycle     | `EXEC` plus natural wait | Exhaust free takes, admit bonded intents, cancel before/at/after cliff, fulfill another, and verify time-linear upward-rounded penalty and bond release.                                                       | Receipt timestamps, exact formula calculations, LP/token balance deltas, reservation/current/history entities.                          |
| `S04` Chargebackable stake-backed lifecycle     | `EXEC`/`DATA`            | Admit under 1:1 reserve, cancel one intent, settle another for an exact released amount, retain 30d coverage, process partial/full valid chargeback if attestation exists, and mature coverage when available. | Max-vs-sum proof, settlement resize, coverage expiry, chargeback requested/paid/remaining, LP exposure buckets.                         |
| `S05` Deferred payout lifecycle                 | `DATA`                   | Show fallback when stake covers griefing but not chargeback reserve: pending griefing reservation, fulfillment release, payout held instead of stake coverage, withdrawal/chargeback/expiry behavior.          | Hook selection, reserved stake, held payout, merchant/LP balances, deferred entities and bucket transitions.                            |
| `S06` One-sided delegation and shared portfolio | `EXEC`                   | Have `OWNER_A` authorize `TAKER_A1` and `TAKER_A2`; prove both consume one shared cross-platform portfolio and free counter, while unauthorized actors cannot use it and no taker acceptance is required.      | Authorization events/state, owner attribution, combined reservations, failed unauthorized receipt/call, indexed owner/taker relations.  |
| `S07` Stake exits and partial withdrawals       | `EXEC`/natural wait      | Request partial/full exits around free and reserved stake, prove only available stake exits, partial amounts are exact, and released/matured positions restore withdrawable capacity.                          | Stake before/after, exit queue/position, maturity timestamps, token transfer, stake and derived capacity entities.                      |
| `S08` Concurrency and batches                   | `EXEC`                   | Split capacity across multiple intents without a protocol risk-count rule; use merchant and governance cadence batch methods with mixed items and inspect atomicity/idempotence.                               | Per-item events/log ordering, aggregate conservation, return/revert behavior, no duplicate withdrawals/releases.                        |
| `S09` Callback failure and reconciliation       | `GOV`/`DATA`             | Cause a best-effort terminal risk callback failure safely, prove cancellation remains live, bond stays reserved, cancellation time is recorded, and permissionless reconciliation uses that time.              | Cancellation and failure logs, timestamp snapshot, reservation retention, reconciliation penalty math, indexer failed/reconciled state. |
| `S10` Governance, snapshots, and pause          | `GOV`                    | Prove config validation, disable/pause admission, terminal-operation liveness, and non-retroactive policy snapshots; restore all settings.                                                                     | Before/after configs, rejected/accepted calls, old/new position snapshots, restoration transaction.                                     |
| `S11` Indexer conservation and replay safety    | `EXEC`/`PREPROD`         | Reconcile every event and current/derived entity, expiry buckets, exact raw values, deterministic IDs, duplicate absence, and deployment replay/reorg behavior.                                                | Raw GraphQL archive, aggregate recomputation, ID uniqueness queries, deployment sync status; induced reorg deferred.                    |

## Granular test cases

### A. Deployment, wiring, configuration, and baseline

| ID    | Class  | Test and expected result                                                                                                                                                                                                                                    | Specific evidence                                                       |
| ----- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `A01` | `EXEC` | Each supplied address has non-empty bytecode and matches the deployment artifact/network record.                                                                                                                                                            | `eth_getCode`, artifact/address manifest, deployment tx.                |
| `A02` | `EXEC` | Ownership/admin/authorized-caller wiring matches the deployment plan; RiskManager, StakeVault, Orchestrator V3, Escrow V2, and deferred hook point to the intended peers.                                                                                   | Raw getters and roles; no inferred addresses.                           |
| `A03` | `EXEC` | Token address and `decimals()` are correct; every later display amount is derived from this read.                                                                                                                                                           | Token address, symbol if available, decimals raw response.              |
| `A04` | `EXEC` | Reversible platform config equals 10,000 reserve bps, 30-day risk window, deferred enabled, no free takes, 15m cliff, 10 bps/hour.                                                                                                                          | Config read and indexed platform policy.                                |
| `A05` | `EXEC` | Non-chargebackable config equals zero reserve/window, deferred disabled, three free takes of 20,000,000 raw USDC, 15m cliff, 10 bps/hour.                                                                                                                   | Config read and indexed platform policy.                                |
| `A06` | `EXEC` | Every enabled payment method expected to use the hook resolves to the intended risk hook; plain/nonexistent hooks remain distinguishable.                                                                                                                   | Deposit/payment-method config and event/indexer view.                   |
| `A07` | `EXEC` | Envio reports fully synced for every chain, indexes from a block no later than deployment, and its processed head reaches the latest test block.                                                                                                            | Deployment status and GraphQL/meta head evidence.                       |
| `A08` | `EXEC` | Baseline stake, authorization, free-use, reservation, position, coverage, deferred, compensation, and expiry-bucket entities for fresh actors are empty/zero.                                                                                               | Raw baseline GraphQL saved before transactions.                         |
| `A09` | `GOV`  | Invalid config combinations revert: reserve >10,000; chargebackable with zero reserve/window; non-chargebackable with reserve or deferred enabled; chargebackable with free takes; only one free field set; cliff ≥ Escrow period; max griefing rate >100%. | Read-only simulations where possible; revert selectors; no state delta. |
| `A10` | `EXEC` | Zero griefing slope is represented as a disabled griefing curve, not zero taking capacity; zero free fields disable free takes.                                                                                                                             | Controlled read/capacity calculation or `GOV` simulation.               |

### B. Stake ownership, authorization, and delegation

| ID    | Class     | Test and expected result                                                                                                                                        | Specific evidence                                                         |
| ----- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `B01` | `EXEC`    | `OWNER_A` stakes for itself; total, free, and reserved stake plus token balances reconcile exactly.                                                             | Approval/stake receipts, transfer and stake events, GraphQL stake entity. |
| `B02` | `EXEC`    | `OWNER_A` authorizes `TAKER_A1` one-sidedly; no taker acceptance transaction is required.                                                                       | Authorization state/event and absence of a pending acceptance state.      |
| `B03` | `EXEC`    | Authorized `TAKER_A1` signals a position attributed to `OWNER_A`, not to its own empty stake balance.                                                           | Position snapshot, reservation owner, indexed owner/taker fields.         |
| `B04` | `EXEC`    | `OWNER_A` authorizes `TAKER_A2`; both takers reduce the same free stake and share owner/platform free-use counters.                                             | Combined positions and owner aggregates.                                  |
| `B05` | `EXEC`    | `UNAUTHORIZED` cannot signal using `OWNER_A` stake. State, counters, and reservations remain unchanged.                                                         | Revert selector/receipt and pre/post reads.                               |
| `B06` | `EXEC`    | Revoking `TAKER_A1` prevents new use but does not rewrite the owner or policy of its existing positions; terminal handling remains possible.                    | Revoke event, failed new signal, existing snapshot and terminal tx.       |
| `B07` | `EXEC`    | A different owner authorizing the same taker remains economically isolated; no stake/counter leakage across owners.                                             | `OWNER_A` vs `OWNER_B` state and entities.                                |
| `B08` | `DATA`    | If a staging Safe is available, the Safe executes stake and authorization while a distinct relayer submits intents. Expected behavior matches the EOA baseline. | Safe transaction hash plus resulting protocol events/state.               |
| `B09` | `PREPROD` | Multiple Safe owners/modules, signature policy changes, and high-concurrency relayer rotation do not corrupt owner attribution.                                 | Deferred because staging Safe operations add little protocol signal.      |

### C. Free-intent policy

| ID    | Class     | Test and expected result                                                                                                                                 | Specific evidence                                               |
| ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `C01` | `EXEC`    | Fresh `OWNER_A` signals exactly 1 raw unit on `NCB_FREE`; the entire intent is free, count becomes 1, reservation remains zero.                          | Free-consumed event, position flag, counter/entity.             |
| `C02` | `EXEC`    | A free intent of exactly 20,000,000 raw units is accepted and wholly free.                                                                               | Amount and zero reservation in event/state/indexer.             |
| `C03` | `EXEC`    | A 20,000,001-unit intent is not partially free; without sufficient bond it reverts, or with stake it is wholly bonded and does not consume a free count. | Counter unchanged and bonded reservation/math.                  |
| `C04` | `EXEC`    | Three eligible successful signals consume counts 1, 2, and 3. A fourth eligible amount is wholly bonded or reverts for insufficient stake.               | Sequential events/counters and final remaining=0.               |
| `C05` | `EXEC`    | Cancelling a free intent before the cliff restores neither allowance nor counter and pays no penalty.                                                    | Terminal event, counter unchanged, zero LP/stake delta.         |
| `C06` | `EXEC`    | Cancelling a free intent after the cliff still pays no penalty and does not restore allowance.                                                           | Receipt timestamp, zero penalty/reservation, counter.           |
| `C07` | `DATA`    | Fulfilling a free intent is terminal with no reservation/chargeback coverage and no restored allowance.                                                  | Fulfillment logs/state/entity.                                  |
| `C08` | `DATA`    | Expiry/pruning of a free intent is terminal with zero slash and no restored allowance.                                                                   | Expiry receipt and counter.                                     |
| `C09` | `EXEC`    | A reverted signaling attempt does not consume a free allowance. Induce a downstream-safe revert after admission checks if possible.                      | Revert plus unchanged counter/event absence.                    |
| `C10` | `EXEC`    | Free eligibility is keyed by owner and platform: two relayers share the count; `OWNER_B` and another eligible platform have independent counts.          | Owner/platform key matrix.                                      |
| `C11` | `EXEC`    | Chargebackable platforms never admit a free intent, even at 1 raw unit with unused non-chargebackable allowances.                                        | Bonded reservation or insufficient-stake revert; no free event. |
| `C12` | `PREPROD` | Wallet sybil can obtain separate configured allowances. This is documented behavior, not a security failure; no mass wallets are created on staging.     | Policy acknowledgement only.                                    |

### D. Affine curve mathematics, rounding, and shared capacity

Use at least one amount that divides evenly and one that produces a remainder for each formula.

| ID    | Class     | Test and expected result                                                                                                                                                          | Specific evidence                                                  |
| ----- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `D01` | `EXEC`    | For `NCB_BONDED`, pending reservation equals `ceil(A*s*(T-C)/(10_000*3600))`, including the 1-raw-unit upward-rounding boundary.                                                  | Full numerator/denominator and on-chain reservation.               |
| `D02` | `EXEC`    | For `CB_FULL`, pending reservation equals `max(griefing, ceil(A*10_000/10_000)) = A`, not `A + griefing`.                                                                         | Both candidate values, selected branch, stake delta.               |
| `D03` | `GOV`     | For safe `CB_PARTIAL`, reserve uses upward rounding and whichever curve is larger controls. Exercise one griefing-dominant and one chargeback-dominant amount/config if feasible. | Temporary config, math, reservation, restoration.                  |
| `D04` | `EXEC`    | Exactly enough free stake admits; one raw unit less reverts without consuming free count or creating a position.                                                                  | Boundary stake/amount and revert.                                  |
| `D05` | `EXEC`    | Splitting one total amount across several bonded intents yields the sum of per-intent ceilings; record any expected rounding difference from one combined intent.                 | Per-position and aggregate math.                                   |
| `D06` | `EXEC`    | Two takers and two platforms backed by `OWNER_A` cannot reserve more than owner eligible stake in aggregate.                                                                      | All active reservations and failed over-capacity call.             |
| `D07` | `EXEC`    | A completed non-chargebackable fulfillment releases capacity immediately; a completed chargebackable fulfillment retains chargeback coverage and therefore does not.              | Pre/post free stake, position lifecycle.                           |
| `D08` | `EXEC`    | There is no RiskManager max individual intent check: a large controlled intent is governed only by deposit/Escrow operational bounds and available reservation.                   | If rejected, identify exact non-risk bound/revert.                 |
| `D09` | `EXEC`    | There is no RiskManager count/cooldown gate: multiple concurrent intents are accepted until shared stake or Escrow operational limits bind.                                       | Consecutive txs, no cooldown state/entity, precise binding revert. |
| `D10` | `EXEC`    | Capacity views/helpers, if exposed, match inverted curves using raw integer conservative rounding and report free allowances separately rather than combining tranches.           | Helper output vs independent calculations.                         |
| `D11` | `PREPROD` | Large-scale cross-platform portfolio and rounding conservation over hundreds of intents.                                                                                          | Defer volume; unit/fuzz evidence is not staging E2E evidence.      |

### E. Griefing cancellation, expiry, and reconciliation

| ID    | Class        | Test and expected result                                                                                                                          | Specific evidence                                           |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `E01` | `EXEC`       | Bonded cancellation with receipt timestamp at/before `creation+C` charges zero and releases the full reservation.                                 | Creation/cancel block timestamps and stake/LP deltas.       |
| `E02` | `EXEC`       | First cancellation strictly after the cliff charges at least 1 raw unit by upward rounding.                                                       | `chargeableTime > 0`, numerator remainder, event.           |
| `E03` | `EXEC`       | Later cancellation equals the exact time-linear formula using chain timestamps, not wall-clock submission time.                                   | Both block timestamps and independent calculation.          |
| `E04` | `EXEC`       | Chargebackable pending cancellation charges only accrued griefing penalty and releases all unused max reservation; no coverage window is created. | Large reserve before; penalty/LP/free stake after.          |
| `E05` | `DATA`       | Expiry/prune charges the same formula using the time liquidity stopped being locked.                                                              | Expiry/cleanup timestamps and terminal event.               |
| `E06` | `DATA`       | Guardian extension beyond `T` does not raise penalty above `maxGriefingBond`; elapsed used by economic math is capped at `T`.                     | Snapshotted `T`, extension action, eventual terminal event. |
| `E07` | `GOV`/`DATA` | A best-effort callback failure does not block cancellation/cleanup, does not release the bond, and records the terminal timestamp.                | Failure event/state and retained reservation.               |
| `E08` | `GOV`/`DATA` | Anyone can reconcile; penalty uses recorded cancellation timestamp rather than reconciliation timestamp, and remainder is released once.          | Delayed reconciliation receipt and exact timestamps.        |
| `E09` | `EXEC`       | Repeating terminal cancellation/reconciliation cannot double slash or double release.                                                             | Revert/no-op behavior and conserved balances.               |
| `E10` | `EXEC`       | Fulfillment/manual release never emits or charges griefing penalty.                                                                               | Event absence plus LP/stake balances.                       |

### F. Settlement, chargeback coverage, and maturity

| ID    | Class     | Test and expected result                                                                                                                                             | Specific evidence                                                   |
| ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `F01` | `DATA`    | Fulfillment of `CB_FULL` releases the pending griefing component and retains coverage equal to the exact released amount, not necessarily original requested amount. | Intent/released amounts, settlement event, coverage state.          |
| `F02` | `DATA`    | Coverage expiry equals settlement block timestamp + snapshotted 30-day risk window.                                                                                  | Block timestamp and raw expiry.                                     |
| `F03` | `DATA`    | A valid partial chargeback compensates at most requested/remaining coverage and preserves exact remaining coverage.                                                  | Attestation/proof reference, requested/paid/remaining event/entity. |
| `F04` | `DATA`    | A subsequent valid chargeback can consume remaining coverage but never slash beyond it.                                                                              | Cumulative compensation and owner/LP balances.                      |
| `F05` | `DATA`    | Chargeback request exceeding coverage pays only remaining covered amount; LP bears uncovered loss.                                                                   | Requested vs compensated vs uncovered fields.                       |
| `F06` | `DATA`    | Invalid, replayed, wrong-platform, wrong-payment, wrong-LP, or otherwise unauthorized chargeback attestations revert without state change.                           | Revert reason/selectors and nullifier/replay state.                 |
| `F07` | `DATA`    | Valid chargeback after expiry cannot slash matured coverage.                                                                                                         | Attestation timestamp, coverage deadline, balances.                 |
| `F08` | `DATA`    | Permissionless maturity release at/after expiry frees remaining coverage once and makes the position terminal.                                                       | Caller, release event, free stake delta, entity/bucket removal.     |
| `F09` | `DATA`    | Release before expiry reverts/no-ops according to interface and cannot free coverage.                                                                                | Pre-expiry simulation/receipt and unchanged state.                  |
| `F10` | `GOV`     | Config change after admission does not change an existing pending or settled position’s reserve ratio/window; a new position snapshots new values.                   | Old/new policy reads, two position snapshots, restoration.          |
| `F11` | `PREPROD` | Naturally wait full 30-day window with significant existing chargeback data. Use pre-production volume rather than fabricating staging history.                      | Deferred.                                                           |

### G. Deferred payouts and merchant compensation

| ID    | Class     | Test and expected result                                                                                                                                                        | Specific evidence                                 |
| ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `G01` | `DATA`    | When free stake covers max griefing bond but not full chargeback reservation, a `CB_FULL` intent using the required deferred hook is admitted with only griefing bond reserved. | Stake boundary, hook, pending reservation.        |
| `G02` | `DATA`    | The same undercollateralized intent without the required deferred hook is rejected.                                                                                             | Call/receipt and unchanged state.                 |
| `G03` | `DATA`    | Cancellation/expiry of pending deferred intent charges griefing normally and creates no held payout.                                                                            | Penalty and deferred entity absence.              |
| `G04` | `DATA`    | Fulfillment releases griefing reservation without penalty and holds the exact payout through the configured risk window instead of reserving stake coverage.                    | Hook/token transfer logs, held amount/expiry.     |
| `G05` | `DATA`    | Valid chargeback/compensation against deferred payout cannot exceed held amount; partial use leaves an exact remainder.                                                         | Requested/paid/remaining and balances.            |
| `G06` | `DATA`    | Merchant withdrawal before payout expiry is rejected; withdrawal at/after expiry transfers remaining held payout once.                                                          | Expiry and token deltas.                          |
| `G07` | `DATA`    | Batch deferred-payout withdrawal processes multiple matured payouts with clear per-item evidence and no duplicate transfer.                                                     | Batch receipt logs and per-payout terminal state. |
| `G08` | `DATA`    | Batch compensation withdrawal handles multiple available compensations and conserves totals.                                                                                    | Per-compensation event, merchant balance delta.   |
| `G09` | `EXEC`    | Free intents never apply to chargebackable deferred flows.                                                                                                                      | No free event/counter delta.                      |
| `G10` | `PREPROD` | High-volume merchant cadence across many expiry buckets and partial compensations.                                                                                              | Defer due limited staging data.                   |

### H. Stake exits, partial withdrawals, and batch maturity

| ID    | Class  | Test and expected result                                                                                                                                | Specific evidence                                  |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `H01` | `EXEC` | Partial withdrawal/exit of unreserved stake records the exact requested raw amount, leaving the remainder staked.                                       | Stake position/event/token balance.                |
| `H02` | `EXEC` | A request that would consume reserved stake is rejected or limited only if the interface explicitly supports limiting; reserved invariant never breaks. | Requested amount and pre/post total/free/reserved. |
| `H03` | `EXEC` | Full available withdrawal while reservations exist cannot withdraw the reserved portion.                                                                | Token and stake deltas.                            |
| `H04` | `DATA` | After pending reservation release, newly free stake becomes withdrawable under the exit schedule.                                                       | Terminal tx then withdrawal/exit position.         |
| `H05` | `DATA` | After chargeback coverage maturity, released stake becomes withdrawable.                                                                                | Maturity tx and stake exit.                        |
| `H06` | `EXEC` | Another address may not redirect an owner’s withdrawal; stake owner receives funds.                                                                     | Unauthorized call and transfer recipient.          |
| `H07` | `DATA` | Batch release of multiple matured stake positions/coverage positions emits one understandable transition per item and preserves aggregate totals.       | Batch log ordering and per-item state.             |
| `H08` | `DATA` | Mixed matured/unmatured/duplicate batch inputs exhibit documented atomicity, with no partial hidden state.                                              | Receipt/revert and exact per-item state.           |
| `H09` | `EXEC` | Zero amount, over-withdrawal, duplicate completion, and nonexistent position inputs fail safely.                                                        | Revert selectors/no state delta.                   |

### I. Administrative, pause, and security gates

| ID    | Class     | Test and expected result                                                                                                                                                         | Specific evidence                                     |
| ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `I01` | `EXEC`    | Non-admin cannot enable/disable platforms, modify policy, pause, change trusted callers/hooks, or move another owner’s stake.                                                    | Read-only simulations/reverts.                        |
| `I02` | `GOV`     | Disabling a platform blocks new admission but does not prevent cancellation, fulfillment/manual release, chargeback handling, reconciliation, or maturity of existing positions. | Short disable window, all relevant calls, restore tx. |
| `I03` | `GOV`     | Pausing each supported component blocks only documented entry points. Financially necessary terminal/withdrawal paths remain live unless explicitly designed otherwise.          | Pause matrix, calls, and restore tx.                  |
| `I04` | `EXEC`    | Calls from an unauthorized orchestrator/hook/callback source cannot fabricate positions, settlements, cancellations, chargebacks, or releases.                                   | Direct-call simulations/reverts.                      |
| `I05` | `EXEC`    | Reentrancy attempts through token/hook/recipient paths cannot double reserve, slash, release, or withdraw. Use existing safe adversarial staging fixture only; otherwise defer.  | Adversarial tx or `PREPROD` rationale.                |
| `I06` | `EXEC`    | Unknown intent/position IDs, malformed array lengths, duplicate IDs, zero addresses, and zero/overflow-like boundary amounts fail without partial state.                         | Reverts and event absence.                            |
| `I07` | `EXEC`    | Checks-effects-interactions/liveness outcome: failed external transfer/callback cannot leave accounting claiming a transfer or silently release liability.                       | Controlled failure if safely available.               |
| `I08` | `PREPROD` | Gas and denial-of-service behavior for maximum operational array and intent counts.                                                                                              | Defer large-volume test.                              |

### J. Events and indexer lifecycle/current/derived entities

The exact final GraphQL type names are filled in from the reviewed indexer schema at execution time. These semantic checks remain invariant across naming.

| ID    | Class     | Test and expected result                                                                                                                                                              | Specific evidence                               |
| ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `J01` | `EXEC`    | Every config update event produces one current platform-policy entity with exact nested values and transaction metadata.                                                              | Decoded log and raw entity JSON.                |
| `J02` | `EXEC`    | Stake add/remove/exit/maturity events update owner totals, free/reserved values, and immutable activity records exactly once.                                                         | Event-to-entity ID and aggregate recomputation. |
| `J03` | `EXEC`    | Delegation events create/revoke the semantic owner↔taker relationship without attributing stake to the relayer.                                                                       | Relationship/current owner entity.              |
| `J04` | `EXEC`    | Admission creates one position with snapshotted terms, owner, taker, LP, platform, amount, free flag, max bond, reserve, timestamps, and current status.                              | Log/state/entity field-by-field diff.           |
| `J05` | `EXEC`    | Free consumption updates owner/platform used and remaining counters exactly once, including terminal non-restoration.                                                                 | Event and aggregate entity.                     |
| `J06` | `EXEC`    | Cancellation writes accrued penalty, elapsed time, reservation released, terminal timestamp/status, and LP compensation; free intents show zeros.                                     | Cancellation/penalty logs and entity.           |
| `J07` | `DATA`    | Settlement writes exact released amount, reserve resize, risk expiry, and appropriate protected/uncovered/deferred exposure.                                                          | Settlement logs and current/history entities.   |
| `J08` | `DATA`    | Partial/full chargeback writes requested, compensated, remaining coverage, and terminality accurately.                                                                                | Chargeback logs and exposure deltas.            |
| `J09` | `DATA`    | Maturity/withdrawal removes current exposure/claim once while preserving immutable history.                                                                                           | Before/after queries and activity record.       |
| `J10` | `DATA`    | Deferred payout lifecycle and compensation entities match held token balances and merchant withdrawals.                                                                               | Hook balance plus GraphQL aggregates.           |
| `J11` | `EXEC`    | LP exposure is grouped by platform and correct coverage-expiry bucket; protected + uncovered + deferred/matured categories reconcile to position-level state without double-counting. | Independent raw-event aggregate vs GraphQL.     |
| `J12` | `EXEC`    | Boundary expiry timestamps land in the documented bucket using seconds (not milliseconds) and migrate/remove at the correct lifecycle event.                                          | Exact expiry and bucket key.                    |
| `J13` | `EXEC`    | All token amounts remain exact decimal-free GraphQL integers/strings and round-trip to raw `bigint`; no JS `number` precision loss or 10^6 double-scaling.                            | Raw JSON and independent sum.                   |
| `J14` | `EXEC`    | Event/position/activity IDs are deterministic and unique across same-transaction batch items; no duplicate rows after repeated queries or redeploy/restart.                           | ID list, counts, tx/log indices.                |
| `J15` | `EXEC`    | Current aggregates equal a recomputation from position/activity entities for each owner, taker, LP, and platform.                                                                     | Saved query plus recomputation output.          |
| `J16` | `EXEC`    | Indexer pause/admission-gate fields match contract state and do not confuse historical position status.                                                                               | Config events/reads and policy entity.          |
| `J17` | `EXEC`    | Indexer catches up after every test transaction within deterministic timeout and never reports a block ahead with missing known receipt events.                                       | Poll log with processed block/time.             |
| `J18` | `PREPROD` | Induced canonical-chain reorg removes orphan activity and recomputes aggregates. Do not attempt to induce a Base staging reorg.                                                       | Validate in local/preprod replay instead.       |
| `J19` | `DATA`    | If Envio redeployment/replay is naturally performed, entities and aggregates at the same canonical head are identical before and after replay.                                        | Canonicalized GraphQL snapshots/diff.           |
| `J20` | `EXEC`    | Queries for missing owners/platforms/positions return stable empty/null semantics without server errors.                                                                              | Raw GraphQL request/response/status.            |

## Execution order and safety runbook

1. Receive exact deployment addresses, chain ID, deployment commit and block range, merged indexer commit, Envio deployment ID, start blocks, and fully synced raw endpoint from the root task.
2. Verify the contracts checkout is clean and points at the deployment source. Keep this document branch isolated; do not edit deployment artifacts owned by the deployment task.
3. Load `.env` without printing it. List key names only. Derive the configured signer address in-process and abort unless it equals the approved `0x84…` deployer address supplied in the handoff.
4. Save the environment inventory, deployment receipts, config reads, token decimals, indexed head, and baseline GraphQL responses.
5. Generate fresh actor keys in an ignored runtime directory or ephemeral process. Fund only minimal gas/USDC. Record public addresses only.
6. Create isolated LP deposits and establish one-sided owner→taker authorizations.
7. Execute `S02`, `S03`, `S06`, and the executable parts of `S07`/`S08`, polling the indexer after each economically distinct transition.
8. Execute chargebackable signaling/cancellation portions of `S04`; execute fulfillment/chargeback only when valid staging proofs are already available.
9. Execute `S05` only when a valid fulfillment route and required deferred hook are available. Do not fake high-volume merchant data.
10. Run `GOV` cases in one short window. Snapshot all affected settings; restore each immediately and confirm restoration through contract reads and the indexer.
11. Run conservation, exact-decimal, duplicate-ID, expiry-bucket, and aggregate recomputations over all data created by this pass.
12. Mark long-window, attestation-blocked, reorg, and volume cases `BLOCKED` or `DEFERRED` with explicit pre-production follow-ups.
13. Report any high-confidence bug immediately to the root task. Do not patch source code from this testing task.
14. Redact RPC credentials and secrets, commit outcome updates, push this branch, and open/update the testing PR only after execution is complete.

### Governance cleanup checklist

- [ ] All platform configs equal their pre-test snapshots.
- [ ] All pause flags equal their pre-test snapshots.
- [ ] Temporary authorizations/roles are removed unless intentionally retained and documented.
- [ ] Temporary deposits are closed where protocol timing permits.
- [ ] No test actor retains unnecessary governance privilege.
- [ ] No secret or credential appears in git diff, shell transcript, outcome file, or PR body.

## Execution outcome ledger

### Read-only baseline evidence — 2026-07-15

No transaction was submitted by the testing task during this phase. The runner independently resolved all values from RPC and refused to proceed unless the `.env` key derived to the expected governance address.

| Contract           | Deployment transaction                                               | Block / UTC                           | Runtime bytes | Runtime code hash                                                    |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------- | ------------: | -------------------------------------------------------------------- |
| Orchestrator V3    | `0xfe001ee1326c34824c1ba64eba9a597f7331bf2415eebfbf0de0d9bf60cd725d` | `48,667,836` / `2026-07-15T14:16:59Z` |        24,526 | `0xd0b57e5cfae64d64f11ad6cdde4ca15c928ef9b95b0e84ad6f41b279600d4eb0` |
| StakeVault         | `0x4b9a3183cdf085e1cd655fe1fd05bcada1777538c44d4a79a3001e05466a43d8` | `48,667,841` / `2026-07-15T14:17:09Z` |        13,445 | `0x44799c35f495f922b1057ad54c950d1197ab116d9c96886e1889f3993a1374c5` |
| RiskManager        | `0xee3873ec064c797c4adb668812ce060788e8880bbef2fb4f7d36a98bd8368e28` | `48,667,846` / `2026-07-15T14:17:19Z` |        18,858 | `0x317204350b7e6fbfdaaba0771d70e00b2740787eafa376806859cebf61dbea24` |
| DeferredPayoutHook | `0x766d2bfa8ce32aaf5f48a7ff133b2c4bbea7915e1c6d5cb803f9705898b269b4` | `48,667,851` / `2026-07-15T14:17:29Z` |         1,935 | `0x215d15b783d9e08c8d5f8ae648ef53e3c4e51bb1b0cf6a3c90073dcbfce8ca9d` |

All four receipts had status `1`, and each receipt's `contractAddress` exactly matched the supplied address. Wiring reads established:

- All owned components are owned by `GOV`; no protocol pause is active.
- RiskManager points to the supplied Orchestrator V3 and StakeVault; StakeVault's controller is RiskManager.
- RiskManager and DeferredPayoutHook point to one another; the hook and vault both use canonical six-decimal USDC.
- DeferredPayoutHook's registry is the existing OrchestratorRegistry, which currently allows Orchestrator V3.
- Orchestrator V3 and Escrow V2 use the same payment-verifier registry; Escrow V2 is whitelisted and Orchestrator V3 is authorized by its registry.
- StakeVault totals, liabilities, held deferred payouts, compensation, and token balance were all zero. Fresh controlled actors had zero stake/reservations, self-owned default portfolios, and zero free takes used.

The exact policy-setting events were:

| Platform | Configuration transaction / block                                                   | Direct policy read                                                                                                          |
| -------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Venmo    | `0x730f5385dd14ce2e53336fbea4d6d73d4a9cf96bad2a8228f375f69ee8c6100e` / `48,667,870` | enabled; chargebackable; deferred; 10,000 bps; 2,592,000s; 900s; 10 bps/hour; no free takes                                 |
| PayPal   | `0x746d6dff1c7886af17ea0f3b931b239d492976eaeb65596bb4bfe61dc99d1bd4` / `48,667,875` | enabled; chargebackable; deferred; 10,000 bps; 2,592,000s; 900s; 10 bps/hour; no free takes                                 |
| Zelle    | `0x7e08f2597b151ad233e57b830e8ea045ca5608ea7d29b09e147a0999d299c19e` / `48,667,879` | enabled; non-chargebackable; no deferred payout; zero reserve/window; 900s; 10 bps/hour; 3 × 20,000,000 raw-unit free takes |

Add one row per granular case; do not collapse multiple cases into one result. Cases whose contract portion is complete but indexer evidence is pending remain `NOT RUN` until both sides are reconciled.

| Case  | Result    | UTC                    | Tx/block                                        | Contract evidence                                                              | Indexer evidence                                           | Notes/bug                                  |
| ----- | --------- | ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------ |
| `A01` | `PASS`    | `2026-07-15T14:43:31Z` | Deployment txs / blocks `48,667,836–48,667,851` | All bytecode, receipt-address, block-hash, and code-hash checks passed.        | Not applicable to contract-code existence.                 | No mismatch.                               |
| `A02` | `PASS`    | `2026-07-15T14:43:31Z` | Read at block `48,668,632`                      | Owner, controller, registry, token, and bidirectional hook wiring match.       | Not applicable to immutable wiring.                        | No mismatch.                               |
| `A03` | `PASS`    | `2026-07-15T14:43:31Z` | Read at block `48,668,632`                      | Canonical USDC; decimals `6`; raw balances retained as integers.               | Pending lifecycle decimal checks under `J13`.              | No mismatch.                               |
| `A04` | `NOT RUN` | `2026-07-15T14:43:31Z` | Config txs `0x730f…6100e`, `0x746d…1bd4`        | Venmo and PayPal direct reads exactly match expected reversible policy.        | Awaiting synced endpoint and policy entities.              | Contract portion complete.                 |
| `A05` | `NOT RUN` | `2026-07-15T14:43:31Z` | Config tx `0x7e08…c19e`                         | Zelle direct read exactly matches expected non-chargebackable policy.          | Awaiting synced endpoint and policy entity.                | Contract portion complete.                 |
| `A07` | `BLOCKED` | `2026-07-15T14:43:31Z` | Common start `48,667,836`                       | Contract start coordinates confirmed.                                          | Fully synced Envio deployment endpoint not yet handed off. | Resume immediately after endpoint handoff. |
| `A08` | `NOT RUN` | `2026-07-15T14:48:00Z` | Read-only fresh actor queries                   | Fresh actors have self-owned zero-stake portfolios and zero free-use counters. | Awaiting baseline entities from synced endpoint.           | No actors funded; no mutation yet.         |

## Bugs and deviations

Record only observed outcomes here. A high-confidence bug entry must include severity, ownership (`contracts`, `deployment/config`, or `indexer`), minimal reproduction, expected versus actual raw values, transaction/block, and links to the evidence bundle. Ambiguous implementation choices remain observations until checked against the policy oracle.

| ID  | Confidence | Severity | Owner | Summary           | Reproduction/evidence | Status |
| --- | ---------- | -------- | ----- | ----------------- | --------------------- | ------ |
| —   | —          | —        | —     | No execution yet. | —                     | —      |

## Pre-production follow-up register

The following are expected staging limitations, not waived requirements:

- Natural 30-day chargeback expiry and post-expiry proof submission with meaningful volume.
- Large portfolio/concurrency and maximum operational batch-size behavior.
- High-volume merchant deferred payout/compensation cadence across many expiry buckets.
- Canonical reorg handling and full deterministic replay under controlled chain conditions.
- Multiple real Safe owners/modules and sustained relayer rotation.
- Platform distributions/high-capacity states that depend on organic pre-production traffic.

Each `PREPROD` case above must be copied into the pre-production test run with its original expected result.
