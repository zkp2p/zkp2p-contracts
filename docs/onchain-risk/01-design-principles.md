# Onchain Risk Redesign: Design Principles and Decision Log

Status: implementation candidate. No production deployment or configuration mutation is part of this change.

## Problem statement

Curator currently decides whether a taker may signal an intent by combining a
database-backed tier table, per-platform caps, cooldowns, active-intent checks,
make-to-take rules, blocklists, and a backend signature. That gives the backend
effective control over protocol access even though settlement is onchain.

The target system makes the contract state authoritative. Curator may still
serve quotes, maker metadata, and compatibility responses, but it cannot grant
or deny access to the open orchestrator.

## Goals

1. Anyone with a unique Attestor-verified identity can take without a maker
   allowlist or Curator signature.
2. There is no per-user intent-count limit and no tier-based amount cap.
3. Liquidity griefing and chargeback risk are priced with capital rather than
   hidden backend policy.
4. Platform configs, reputation thresholds, tier discounts, stake multipliers,
   and maturity curves are readable onchain.
5. Existing `EscrowV2` deposits do not migrate.
6. Existing clients can keep the current `SignalIntentParams` ABI during the
   transition.

## Decisions and rejected alternatives

### Keep EscrowV2 unchanged

The new orchestrator remains authorized through `OrchestratorRegistry`, so it
can lock and settle every existing EscrowV2 deposit. Replacing EscrowV2 solely
to delete its active-slot safeguard would force maker deposit migration for no
material user benefit.

EscrowV2's `maxIntentsPerDeposit` remains a bounded-array/gas safety limit. It
is shared by all users of one deposit, is not a taker quota, and can be raised
by governance. Existing maker min/max per-intent settings also remain for ABI
and deposit compatibility. The new risk system adds no amount cap.

### Preserve calldata, retire authorization semantics

`gatingServiceSignature`, `signatureExpiration`, pre-intent hook setters, and
whitelist-hook getters remain in the ABI. The open orchestrator does not use
legacy signatures or stored hooks and rejects new non-zero eligibility-hook
configuration. A zero-risk legacy deployment preserves its old checks. This
lets clients migrate incrementally without leaving a maker- or
backend-controlled bypass—or a control that only appears active—in the open
execution path.

### Use capital-bounded concurrency, not count-bounded concurrency

Unlimited free locks are an obvious griefing vector. A configurable `signalBond`
is reserved for every active intent. If the intent expires or is cancelled, a
configured share is credited to the maker's vault balance and reputation falls. There is no
count limit: concurrency is bounded by the user's voluntarily posted capital.

### Use a bounded graph, not global graph traversal

Computing PageRank, EigenTrust, or arbitrary neighbor walks onchain is too
expensive and makes transaction cost depend on global protocol growth.
Instead, each verified identity pair has a single edge:

```text
edge weight = min(sqrt(cumulative pair volume / point unit), edge cap)
reward      = change in edge weight × counterparty reputation multiplier
```

Only payment-proof-verified settlements and only the change in square-root
weight earn points. Manual maker releases earn no points. Repeated volume between the
same two identities therefore has diminishing returns and a hard ceiling.
Interactions with reputable counterparties weigh more, capped at 2x by
default. Updates remain constant-time.

### Use signed scores

Reputation can go below zero. An abandonment must matter even for a new user;
clamping at zero would make fresh identities free to grief. Platform configs
set a minimum score. The proposed deployment uses `-100`, which permits recovery
after ordinary cancellations but generally blocks an identity after a proven
chargeback.

### Do not decay payer collateral before the dispute window closes

The proposed inverse-log decay was rejected during adversarial review. A
malicious payer can choose when to initiate many chargebacks, so historical
post-day-7 frequency is not a safe basis for withdrawing collateral. Without a
separately funded insurance pool, taker stake must cover the maker's full loss
through the configured enforceable dispute window. The initial conservative
curve is:

| Age | Collateral still locked |
|---|---:|
| 0–180 days | at least 100% |
| 180+ days | 0% |

The contract rejects chargebackable configs whose intermediate retention or
tier multiplier would take coverage below 100%. The exact final maturity must
be validated per rail before cutover. A future funded insurance layer could
cover a declining tail, but reputation alone cannot make an undercollateralized
maker whole. Existing positions keep their snapshotted schedule.

### Snapshot policy per intent

The orchestrator snapshots both the risk-manager address and the effective
protocol fee. The risk manager snapshots stake and maturity parameters. A
governance update therefore affects only new intents and cannot retroactively
move collateral or change fees for an already locked user.

## Initial reputation tiers

Tiers do not cap take size. They only discount the protocol fee and reduce
chargeback collateral as earned reputation increases.

| Tier | Minimum score | Protocol-fee discount | Stake multiplier |
|---|---:|---:|---:|
| Starter | 0 | 0% | 125% |
| Proven | 100 | 10% | 100% |
| Trusted | 500 | 25% | 100% |
| Anchor | 2,000 | 40% | 100% |

An account below zero still resolves to Starter for quoting, but the platform's
minimum reputation policy can reject it.

## Why this is simpler

- One public platform config replaces caps, cooldowns, reversible-rail flags,
  and hidden fallback tables as the execution authority.
- Four contracts have one responsibility each.
- Signal and lifecycle index updates are O(1); view arrays and matured-withdrawal
  batches are caller-bounded.
- Existing escrow custody, payment verification, post-intent hooks, and signal
  calldata remain compatible.
