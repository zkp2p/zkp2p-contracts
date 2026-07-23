# RiskManager Code-Layer Refactor Specification

## Status and scope

This specification defines a behavior-preserving, pre-deployment refactor of the `RiskManager` at
`origin/main` commit `efc9bb6`.

The refactor separates intent-extension policy from chargeback policy at the Solidity source and
storage layers while retaining one deployed `RiskManager` address. The deployed address remains:

- the `IIntentRiskHook` snapshotted by `OrchestratorV3`;
- the `intentGuardian` authorized by `EscrowV2`;
- the sole controller of `StakeVault`.

The refactor may change internal storage layout because no production `RiskManager` has been
deployed. Except for the explicitly listed validation simplifications, it must preserve the
existing external behavior, economics, events, and public API.

## Goals

1. Separate extension and chargeback policy into two independently understandable abstract,
   stateful contracts.
2. Keep `RiskManager` as a small lifecycle coordinator.
3. Preserve the current lock accounting, formulas, settlement routing, evidence binding, and
   lifecycle recovery behavior.
4. Remove redundant validation of canonical data supplied by the immutable `OrchestratorV3`.
5. Use the naming and function decomposition conventions used by `OrchestratorV3`, `EscrowV2`,
   and `StakeVault`.
6. Document that chargeback and payment attestations may use the same attestation verifier and
   offchain signer backend.

## Non-goals

- Deploying separate extension and chargeback manager addresses.
- Adding multiple `StakeVault` controllers.
- Changing `OrchestratorV3`, `EscrowV2`, or `StakeVault` integration.
- Changing extension or chargeback economics.
- Adding an upgrade or migration mechanism.
- Requiring different verifier contracts or signer sets for payment and chargeback attestations.

## Contract structure

### RM-ARCH-001: Single deployed coordinator

`contracts/RiskManager.sol` remains the only concrete deployed contract. It owns common
dependencies, access control, reentrancy protection, pause state, common intent lifecycle state,
and the three `IIntentRiskHook` callbacks.

### RM-ARCH-002: Intent-extension module

`contracts/risk/IntentExtensionManager.sol` is abstract and stateful. It owns:

- extension configuration;
- extension position state;
- extension lock identifier derivation;
- extension authorization;
- Escrow expiry extension;
- extension cost and terminal penalty calculations;
- extension lock creation, increase, and resolution.

It must not own chargeback mode, coverage, deferred-fee, attestation, or chargeback-nullifier
state.

### RM-ARCH-003: Chargeback module

`contracts/risk/ChargebackManager.sol` is abstract and stateful. It owns:

- chargeback configuration;
- coverage mode and coverage position state;
- stake-backed and deferred-payout settlement;
- deferred fee allocation state;
- clean maturity;
- chargeback attestation hashing and validation;
- chargeback dispute-nullifier state;
- attestation verifier and payment-nullifier registry dependencies.

It must not own extension pricing, purchased-time, extension-owner, or extension-lock state.

### RM-ARCH-004: Common state

The coordinator may own only facts genuinely shared by both modules:

- taker;
- LP/depositor;
- payout recipient;
- payment method;
- intent creation timestamp;
- intent amount;
- common lifecycle status.

Public aggregate views may compose common, extension, and chargeback storage into the existing
`IRiskManager.RiskPosition` return type.

### RM-ARCH-005: Internal composition

The coordinator invokes internal module functions. The modules must not call one another through
external calls, and the refactor must not introduce `delegatecall`, proxy, or facet machinery.

## Trust and validation policy

### RM-TRUST-001: Canonical Orchestrator

The immutable `OrchestratorV3` is the trusted source of canonical intent and settlement data.
Functions protected by `onlyOrchestrator` must not repeat zero-address, zero-amount, or malformed
shape checks already enforced by Orchestrator and Escrow.

The coordinator must retain the `onlyOrchestrator` check itself.

### RM-TRUST-002: Required state-transition checks

Checks that prevent an invalid lifecycle transition are not junk validation and must remain.
Examples include:

- admission cannot overwrite an existing position;
- cancellation and settlement require a pending position;
- maturity and chargeback require a settled coverage position;
- maturity and chargeback remain mutually exclusive.

### RM-TRUST-003: Required policy checks

Checks that enforce configured economic policy must remain. Examples include:

- payment method enabled for new positions;
- intent token equals the `StakeVault` token;
- deposit selected this `RiskManager` as intent guardian;
- sufficient free stake or deferred payout availability;
- extension authorization and maximum lifetime;
- chargeback window and full coverage;
- deferred transfer balance delta.

### RM-TRUST-004: Public and evidence inputs

Permissionless and user-callable functions must retain checks needed to prevent unauthorized
state changes. Chargeback evidence must retain cryptographic and replay-protection checks.

Unused attestation fields must not be subjected to arbitrary non-zero checks merely to enforce a
payload shape. The attestation verifier is authoritative for the evidence it signs.

### RM-TRUST-005: Governance inputs

Configuration validation must enforce relationships needed for safe math and reachable terminal
states. It need not reject inert identifiers or values solely because they are zero when no
economic invariant depends on the check.

### RM-TRUST-006: Constructor dependencies

Deployment is responsible for supplying the intended owner, Orchestrator, and StakeVault; the
coordinator constructor does not duplicate those deployment checks. The chargeback module may
retain dependency validation for the attestation verifier and nullifier registry.

## Shared lifecycle

### RM-LIFE-001: Admission

`onIntentCreated(intentHash)` is callable only by Orchestrator and is fail-closed.

It must:

1. reject admission while new risk taking is paused;
2. read canonical intent and deposit data;
3. verify the payment method is enabled;
4. verify the deposit token equals the Vault token;
5. verify the deposit selected this deployed coordinator as `intentGuardian`;
6. store common immutable intent facts;
7. initialize the extension position;
8. initialize chargeback coverage;
9. emit the existing `RiskPositionCreated` event with equivalent values.

No extension lock is created at admission.

### RM-LIFE-002: Cancellation

`onIntentCancelled(intentHash)` is callable only by Orchestrator and uses the current timestamp.
It must resolve extension exposure first, cancel pending chargeback coverage second, and transition
the common position to `CANCELLED`.

The complete callback remains atomic. A Vault failure reverts the callback so Orchestrator can
record the failed-open cancellation.

### RM-LIFE-003: Settlement

`settleIntent(context)` is callable only by Orchestrator and is fail-closed.

It must:

1. require a pending position;
2. resolve extension exposure using the settlement timestamp;
3. settle chargeback coverage according to the snapshotted coverage mode;
4. transition the common lifecycle to the resulting state;
5. emit the existing settlement events.

The hook continues to consume either zero settlement tokens or exactly `grossAmount`.

### RM-LIFE-004: Cancellation reconciliation

`reconcileCancellation` and its batch form remain permissionless. Reconciliation must use
Orchestrator's persisted original cancellation timestamp, perform the same complete cancellation
transition, and acknowledge the record only after all local and Vault accounting succeeds.

An empty batch may be a successful no-op; it does not require a dedicated zero-length revert.

### RM-LIFE-005: Pause

Pausing blocks:

- new admissions;
- new intent extensions.

Pausing must not block:

- cancellation;
- settlement;
- reconciliation;
- clean maturity;
- chargeback submission.

## Intent-extension policy

### RM-EXT-001: Admission snapshot

For every admitted intent, the extension module snapshots:

- configured hourly extension slope;
- original Escrow expiry.

The coordinator snapshots creation timestamp and intent amount in common position state and supplies
them to the extension module when its formulas or live-intent checks need them.

A zero extension slope disables extensions without affecting chargeback admission.

### RM-EXT-002: Extension authorization

The first extension snapshots the taker's currently selected stake owner.

- The taker may purchase the first extension.
- The selected stake owner may purchase the first extension.
- The taker may purchase later extensions only while its live selected owner still equals the
  snapshotted extension owner.
- The snapshotted extension owner may always add exposure from its own stake.
- Other callers must revert.

### RM-EXT-003: Canonical intent validation

Because `extendIntent` is publicly callable, it must confirm the referenced Orchestrator and Escrow
intent is still the admitted, pending intent and has not expired. It must confirm local purchased
time agrees with Escrow expiry.

### RM-EXT-004: Lifetime and pricing

The final expiry must not exceed five days from original intent creation.

For intent amount `A`, configured hourly slope `s`, and total purchased seconds `T`:

```text
extensionCost = ceil(A * s * T / (10_000 * 1 hour))
```

Pricing is cumulative. Each extension locks only the difference between the new cumulative cost
and the already locked cumulative cost.

### RM-EXT-005: Lock isolation

The extension lock identifier remains:

```text
keccak256(abi.encode(keccak256("ZKP2P_INTENT_EXTENSION"), intentHash))
```

It must never collide with the raw intent hash used for chargeback coverage.

Extension locks use `NEVER_MATURES` and are resolved only through a terminal intent transition.

### RM-EXT-006: Escrow update ordering

The extension lock update and `EscrowV2.extendIntentExpiry` must occur in one transaction.
Any downstream revert must roll back both operations.

### RM-EXT-007: Terminal penalty

At terminal timestamp `terminalAt`:

```text
chargeableTime = min(max(terminalAt - baseExpiry, 0), totalPurchasedTime)
penalty = ceil(A * s * chargeableTime / (10_000 * 1 hour))
```

Resolving the extension lock creates one immediate LP claim for `penalty`. The unused lock
remainder becomes free stake of the extension stake owner.

Extension exposure is fully resolved at cancellation or settlement and never continues into the
chargeback window.

## Chargeback policy

### RM-CB-001: Admission modes

For a chargeback-disabled payment method, coverage mode is `UNBONDED` and no coverage lock is
created.

For a chargeback-enabled payment method:

- if selected free stake covers the full intent amount, mode is `STAKE_BACKED` and the raw intent
  hash locks the full intent amount with `NEVER_MATURES`;
- otherwise, if deferred payout is enabled, mode is `DEFERRED_PAYOUT`, no admission lock is
  created, and the payout recipient becomes the future funded-lock owner;
- otherwise admission reverts for insufficient collateral.

Deferred admission rejects a non-zero post-intent hook because deferred settlement consumes the
complete gross amount instead of executing ordinary payout routing.

### RM-CB-002: Cancellation

Cancellation of a stake-backed pending position unlocks the raw-intent coverage lock.
Cancellation of an unbonded or deferred position creates no Vault mutation for chargeback policy.

### RM-CB-003: Unbonded settlement

Unbonded settlement:

- consumes no settlement tokens;
- creates no coverage lock;
- transitions the aggregate position directly to `RELEASED`;
- allows Orchestrator to execute ordinary fees and payout.

### RM-CB-004: Stake-backed settlement

Stake-backed settlement:

- consumes no settlement tokens;
- resizes the raw-intent lock from admitted intent amount to gross release amount;
- sets maturity to `settlementTimestamp + snapshottedRiskWindow`;
- records coverage equal to gross release;
- allows Orchestrator to execute ordinary fees and payout.

### RM-CB-005: Deferred settlement

Deferred settlement:

- transfers exactly the gross release directly from Orchestrator to `StakeVault`;
- verifies the Vault's token balance increased by exactly the gross release;
- funds one raw-intent lock owned by the payout recipient;
- records coverage equal to gross release;
- stores the exact non-zero fee allocations for clean maturity;
- consumes the complete gross release so Orchestrator executes no immediate payout or fee transfer.

### RM-CB-006: Clean maturity

Anyone may release a settled coverage position at or after the half-open coverage deadline.

- Stake-backed maturity unlocks the coverage lock.
- Deferred maturity resolves the lock into the stored fee claims and leaves the unallocated net
  amount as free stake owned by the payout recipient.

The position transitions to `RELEASED`, coverage becomes zero, and deferred fee storage is
cleared.

An empty maturity batch may be a successful no-op.

### RM-CB-007: Chargeback evidence

Anyone may submit chargeback evidence before the coverage deadline.

The signed EIP-712 digest must bind:

- the deployed manager and chain through the domain;
- `intentHash`;
- `dataHash`.

The manager must verify:

- `keccak256(data) == dataHash`;
- decoded payment method equals the snapshotted payment method;
- proof-based settlements have the bidirectional payment-nullifier binding to the exact intent;
- the payment-method-scoped dispute nullifier has not been used;
- the configured attestation verifier approves the digest, signatures, and data.

Manual releases do not require a payment-nullifier binding.

The verifier may be the exact same `IAttestationVerifier` instance used by the unified payment
verifier. No code or documentation may require or recommend an independent verifier or signer set.

### RM-CB-008: Chargeback resolution

A valid chargeback requires complete coverage equal to gross release.

It must:

- consume the dispute nullifier;
- transition the position to `SLASHED`;
- clear coverage and deferred fee state;
- resolve the complete coverage lock into one immediate LP claim;
- emit `ChargebackSettled`.

No protocol, referral, manager, or payout-recipient amount vests after a successful chargeback.

## Governance and configuration

### RM-GOV-001: Platform policy

The public platform configuration remains behaviorally equivalent:

- `enabled`;
- `chargebackable`;
- `deferredPayoutEnabled`;
- `riskWindow`;
- `extensionPenaltyBpsPerHour`.

Existing positions retain snapshotted values across governance changes.

### RM-GOV-002: Configuration invariants

- Chargeback-enabled policy requires a non-zero risk window no greater than 365 days.
- Chargeback-disabled policy cannot enable deferred payout or retain a risk window.
- Maximum five-day extension cost cannot exceed the intent amount.

### RM-GOV-003: Verifier updates

Governance may replace the chargeback attestation verifier with a non-zero deployed verifier
dependency.
The update applies to unresolved settled positions because verification occurs at submission time.

### RM-GOV-004: Vault controller handover

Governance retains the coordinator-level function that accepts delayed `StakeVault` controller
handover.

## Accounting and safety invariants

### RM-INV-001

Extension and coverage lock identifiers are disjoint.

### RM-INV-002

Every non-zero extension amount equals the corresponding extension lock amount.

### RM-INV-003

Every non-zero coverage amount equals the corresponding raw-intent lock amount.

### RM-INV-004

Extension penalty never exceeds the extension lock.

### RM-INV-005

Stake-backed and deferred post-settlement coverage equals gross release.

### RM-INV-006

Chargeback and clean maturity cannot both resolve the same coverage position.

### RM-INV-007

Deferred settlement conserves gross release:

```text
gross release = executable amount + sum(fee allocations)
```

At clean maturity the executable amount remains payout-recipient-owned stake and every stored fee
becomes an immediate claim.

### RM-INV-008

The coordinator and modules never retain settlement or stake tokens.

### RM-INV-009

All terminal paths remain reachable while new risk taking is paused.

### RM-INV-010

Cancellation recovery delay cannot increase the extension penalty because reconciliation uses the
original cancellation timestamp.

## Naming and documentation

### RM-STYLE-001

Use `intent`, `deposit`, `intentHash`, `depositId`, `owner`, `depositor`, `recipient`,
`paymentMethod`, `releaseAmount`, and `feeAllocations` consistently with Orchestrator, Escrow, and
StakeVault.

Do not introduce alternate names for the same protocol object without an economic distinction.

### RM-STYLE-002

External lifecycle functions should read as orchestration. Complex validation, state
initialization, formulas, funding, and resolution belong in appropriately named internal
functions.

### RM-STYLE-003

NatSpec must describe:

- actor authorization;
- lifecycle ordering;
- custody and accounting effects;
- token-consumption behavior;
- important invariants and rationale.

NatSpec must not restate every line of implementation or claim that chargeback credentials are
independent from payment-attestation credentials.

## Compatibility requirements

### RM-COMPAT-001

Keep the existing external `IRiskManager` functions unless removing an unused validation-only
error or helper is necessary for the refactor.

### RM-COMPAT-002

Keep existing event signatures and economic meanings so indexers do not need a behavioral
migration.

### RM-COMPAT-003

The existing deterministic, fuzz, invariant, and Orchestrator integration suites must continue to
pass after updating tests that assert intentionally removed redundant validation.

## Required verification

1. Compile Solidity and regenerate dependent artifacts through normal repository commands.
2. Run all deterministic Foundry tests.
3. Run RiskManager fuzz and invariant tests.
4. Run the full applicable Foundry suite.
5. Run requested Solidity coverage and inspect uncovered RiskManager/module branches.
6. Compare the final implementation against every `RM-*` requirement.
7. Review the diff against the baseline implementation for unintended economic, event, or API
   changes.
