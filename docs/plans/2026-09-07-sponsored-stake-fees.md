# Buyer stake referrals at the existing L1 rate

## Accepted product rule

Aaron is a **buyer**. If another wallet stakes for him, that wallet earns a
referral at the existing L1 rate on the trades actually backed by its stake.
There is no independently priced sponsor product or permanent referral-code
reassignment. The buyer's selected backer is the referral recipient for that
trade; selecting a different backer affects future trades only. This supersedes
the earlier 80 bps pricing hypothesis.

The source L1 default is 40 bps (0.40%). The contract rate is configured by
governance to match the referral program, not hardcoded or independently
selected by a sponsor. Changing the program's L1 rate requires updating both
Curator's ladder and the on-chain stake referral configuration for future
signals. Existing intent snapshots keep their original rate.

## Implemented contract behavior

- `setStakeReferralConfig(hook, feeSource, l1ReferralFee)` derives the dispute
  policy from the exact canonical lifecycle hook. The configured `feeSource`
  is Peer's existing service-fee recipient, not the Orchestrator's separate
  protocol-fee field. Configuration is owner-only; rate zero disables future
  stake referrals. A different lifecycle hook does not use this configuration.
- After the lifecycle hook locks collateral, OrchestratorV3 reads the actual
  policy snapshot. An externally backed intent gets a stake referral; self
  stake, whitelist bypass, unprotected and zero-window routes do not.
- The existing Peer fee entry must fully fund the L1 rate. Missing or
  insufficient budget reverts the complete signal, including collateral and
  escrow state. Direct callers cannot consume sponsored collateral while
  omitting that funding entry when this configuration is active.
- The recipient, funding source and L1 rate are snapshotted for each intent.
  Revocation, stake-owner selection, referral configuration and hook changes
  cannot redirect old trades' earnings or collateral liability.
- Settlement carves the referral out of Peer's **already-rounded** fee amount.
  The signed referral array, aggregate fees, existing seller referrals and
  exact buyer net payout stay unchanged, including fractional-base-unit cases.
- Proof and manual settlement pay the same L1 rate on actual gross release;
  partial settlement pays only on the partial release. Cancellation and
  expiry do not pay. Any failing lifecycle settlement rolls back all payouts.
- Payouts use `IntentReferralFeeDistributed`, so they enter the existing
  referral earnings pipeline. A wallet acting as both seller referrer and
  buyer backer receives a combined payout and one event. No new L2 payment is
  created from the buyer's staking relationship.
- Stake remains fully collateralized for the snapshotted risk window after
  settlement (14 days in this model). Maturity alone does not unlock it: the
  permissionless policy release transaction must succeed. A later dispute
  consumes principal but does not claw back an already earned referral.

`getIntentStakeReferral` exposes an active intent's referral snapshot;
`IntentStakeReferralSnapshotted` preserves the signal-time record after the
intent is pruned. The stored original referral array remains the buyer's
signed total-fee plan; actual recipient distributions include the stake carve.

Existing vault consent is reused: the backer authorizes the buyer and the
buyer selects that backer. This PR does not introduce a new lending agreement,
per-buyer exposure cap, or UI. Vault authorization still exposes the backer's
available shared stake to its authorized buyers, under existing vault rules.

## Fee example

The following illustrates a 100 bps total service fee and a complete seller
referral chain; it is not a claim about live production configuration:

| Recipient | Rate on gross settled volume | On $1,000 |
| --- | ---: | ---: |
| Seller's existing L1 | 40 bps | $4 |
| Seller's existing L2 | 10 bps | $1 |
| Buyer's selected external backer | 40 bps | $4 |
| Peer remainder | 10 bps | $1 |
| Total service fee | 100 bps | $10 |

Before the carve, the supplied Peer entry is 50 bps; afterward it receives
10 bps. Existing maker/integration allocations are preserved. If those other
allocations leave Peer less than 40 bps, the sponsored route rejects instead
of reducing someone's existing referral, adding a buyer charge, or silently
underpaying the backer. Unprotected and self-backed routes retain existing fees.
Any manager, bridge or separate protocol fees remain part of the original
quote and are not used as funding sources.

## Economics of the chosen rate

The calculator fixture now uses the accepted L1 rate of 40 bps. With 100%
gross collateral, annual volume per dollar of capital is `utilization × 365 /
holdingDays`. Simple net annual return is:

```text
(referral rate - losses per settled dollar - operating cost per settled dollar)
× utilization × 365 / (risk-window days + additional holding days)
```

At a 14-day hold and illustrative 10 bps losses plus 5 bps costs:

| Capital utilization | Gross annualized return at 40 bps | Net annualized return |
| --- | ---: | ---: |
| 50% | 5.21% | 3.26% |
| 75% | 7.82% | 4.89% |
| 100% | 10.43% | 6.52% |

At 75% utilization, $10,000 average capital supports $195,535.71 annual gross
settled volume and models $782.14 referral income, $195.54 losses, $97.77 costs,
and $488.84 net income. Two additional holding days reduce modeled net return
to 4.28%. A 12% target would require 77 bps under the base assumptions; matching
L1 deliberately does not meet that target. The model informs economics and
never overrides the accepted product rate.

These are steady-state assumptions, not observed losses or guaranteed returns.
Idle/cancelled reservations reduce productive utilization; additional holding
days capture successful positions' pending/release delays. Do not count the
same delay in both inputs. Losses must be replenished to sustain the modeled
capital. Correlated fraud, capital depletion, fixed overhead and compounding
are not simulated; a valid dispute can consume the full trade's collateral.

```sh
node scripts/model-sponsor-fees.mjs scripts/fixtures/sponsor-fees.json
node --test scripts/model-sponsor-fees.spec.mjs
```

All JSON inputs are required integers; rates use basis points. The minimum
whole-bp fee is rounded upward with integer arithmetic. Dollar/APR outputs are
offline numerical approximations, never quote or transaction arithmetic.

## Source review and delivery boundary

Reviewed contracts main `2e70f3c`, Curator main `69f01365`, clients main
`5a3655715`, and indexer main `9954946`. Canonical sources are standalone repos.

- Curator `src/common/utils/serviceFee.ts` allocates existing maker/integration
  fees. No change is required to construct a stake recipient: the contract
  derives it from the actual locked stake, avoiding stale quotes and signatures.
- Clients `packages/sdk/src/client/IntentOperations.ts` forwards the fee plan.
  No signal-input or signature format changes are required. Deployments and
  package address selection still need the successor Orchestrator address.
- Indexer `src/handlers/v3/orchestrator_v3.ts` forwards ordinary referral payout
  events to the existing distribution and recipient aggregates. One payout
  event per recipient avoids overwriting its intent/recipient-keyed row.
- Curator's current dashboard attributes L1/L2 through the **seller** code tree.
  Buyer-backer payments enter total earnings but can appear as unattributed
  there; this PR changes payout behavior, not dashboard tree classification or
  referral-code registration. A wallet still uses the existing referral
  account flow to view that dashboard.
- The new snapshot event is on-chain audit data. Current indexer projections
  need not consume it for payout totals; a future buyer-referral dashboard
  should consume it to distinguish that relationship from seller attribution.

This is a source PR, not a live activation. It changes the OrchestratorV3 ABI
additively and exposes an already-existing policy getter in its interface.
No immutable deployment scripts or historical artifacts are edited, and no
package versions or active addresses are changed. Activation requires a new
numbered successor-orchestrator lane, registry/verifier compatibility checks,
authorizing its existing lifecycle path, exact L1/fee-source configuration,
consumer package/address cutover, and separately authorized deployment.
Existing orchestrators and hooks must remain usable until their intents drain.
Before enabling referrals against a shared vault, every registered predecessor
that can still open unpriced locks through the same policy must stop new
stake-backed admissions and drain, or be removed after draining. Activating
this configuration on one successor does not enforce fees on another
orchestrator. Prove that invariant across the registry at cutover; do not
advertise fee enforcement for the shared vault while a bypass remains.
The accepted task is implementation for review; live deployment remains separate.
