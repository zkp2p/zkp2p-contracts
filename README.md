# zkp2p-v2-contracts

[![Coverage](https://codecov.io/gh/zkp2p/zkp2p-contracts/branch/main/graph/badge.svg?precision=2)](https://codecov.io/gh/zkp2p/zkp2p-contracts)

Smart contracts for the ZKP2P fiat on/off-ramp, with the current repository centered on the v2 system.
The pristine deployed pre-cut `OrchestratorV2` source is archived outside the compilation tree.

- `EscrowV2`: maker liquidity, per-deposit payment configuration, oracle-backed pricing, delegated rate managers.
- `OrchestratorV2`: intent lifecycle, fee handling, pre-intent hooks, whitelist hooks, post-intent execution, and unrestricted account-level concurrency.
- `UnifiedPaymentVerifierV2`: shared attestation-based verifier registered across supported payment methods.
- `ProtocolViewerV2`: batched read model for deposits, intents, supported payment methods, and effective rates.

The repository still contains legacy v1 contracts and deploy scripts because v2 is deployed on top of shared protocol infrastructure, but the active development work over the last month has been concentrated in the v2 contracts, periphery, and deployment pipeline.

## Table of Contents

- [What Landed Recently](#what-landed-recently)
- [System Overview](#system-overview)
- [V3 Lifecycle Risk and Maker Groups](#v3-lifecycle-risk-and-maker-groups)
- [V2 Contract Inventory](#v2-contract-inventory)
- [Core Lifecycle](#core-lifecycle)
- [Rate Management Model](#rate-management-model)
- [Hooks and Extensibility](#hooks-and-extensibility)
- [Payment Verification Model](#payment-verification-model)
- [Repository Layout](#repository-layout)
- [Getting Started](#getting-started)
- [Build, Test, and Development Commands](#build-test-and-development-commands)
- [Deployment Model](#deployment-model)
- [Supported Payment Methods](#supported-payment-methods)
- [Testing Strategy](#testing-strategy)
- [Networks and Deployment Artifacts](#networks-and-deployment-artifacts)
- [Security Notes](#security-notes)

## What Landed Recently

The v2 surface was built out rapidly between February 20, 2026 and March 11, 2026. The main additions in that window are:

- `2026-03-02`: `EscrowV2`, `OrchestratorV2`, `ProtocolViewerV2`, `RateManagerV1`, `SignatureGatingPreIntentHook`, `WhitelistPreIntentHook`, `ChainlinkOracleAdapter`, `OrchestratorRegistry`, and the supporting v2 interfaces/mocks/tests landed.
- `2026-03-02`: the dedicated v2 deployment pipeline landed in `deploy/14_deploy_v2_system.ts`, `deploy/15_deploy_v2_periphery.ts`, and `deploy/16_configure_v2_payment_methods.ts`, with matching deployment tests.
- `2026-03-03`: `PythOracleAdapter` and its deployment/test coverage were added for Pyth FX feeds.
- `2026-03-04`: mainnet deployment scripts for `EscrowV2`, `OrchestratorV2`, and `RateManagerV1` landed.
- `2026-03-06`: the rate-floor model was refactored so `EscrowV2` enforces the final floor while `RateManagerV1` acts as a pure delegated rate registry.
- `2026-03-11`: `EscrowV2` gained batch currency/oracle configuration setters, including `setOracleRateConfigBatch`, `updateCurrencyConfigBatch`, and `deactivateCurrenciesBatch`.
- `2026-03-11`: `EscrowV2` added support for negative oracle spreads, allowing makers to quote below the oracle market rate while still preserving a positive multiplier invariant.
- `2026-03-11`: `OrchestratorV2` added support for multi-recipient referral fees, with `ReferralFeeLib` and updated interfaces/tests.
- `2026-03-11`: a staging redeploy script for `EscrowV2`, `OrchestratorV2`, and `SignatureGatingPreIntentHook` landed in `deploy/19_redeploy_escrowv2_orchestratorv2_staging.ts`.

In practice, "the latest contracts we have added in the past month" means the README should be read as a v2-first document.

## System Overview

ZKP2P is a non-custodial fiat-to-crypto settlement protocol. Makers deposit on-chain liquidity, takers lock a portion of that liquidity by signaling an intent, a payment proof is verified on-chain against an off-chain attestation, and settlement completes either directly to the taker or through a post-intent hook.

The v2 system is built around four layers:

1. Liquidity custody and pricing.
   `EscrowV2` stores deposits, payment methods, payee hashes, supported fiat currencies, fixed floors, oracle configs, rate-manager delegation, and outstanding intents.
2. Intent coordination and settlement.
   `OrchestratorV2` validates whether a taker can lock liquidity, snapshots fee terms and min intent size, verifies payments through the registry-selected verifier, and releases funds.
3. Verification and registries.
   `UnifiedPaymentVerifier` validates EIP-712 attestations and nullifies payments. Active registries define which escrows, orchestrators, hooks, and payment methods are valid. `RelayerRegistry` backs the deployed legacy V1 stack and the deployed prod `OrchestratorV2`.
4. Read models and periphery.
   `ProtocolViewerV2`, oracle adapters, bridge hooks, and pre-intent hooks provide the ergonomic layer used by frontends, routing systems, and privileged operators.

### High-Level Flow

![ZKP2P V2 Settlement Flow](diagrams/high-level-flow.png)

### Contract Architecture

![ZKP2P V2 Contract Architecture](diagrams/architecture.png)

## Deposit Whitelist and Maker Groups

The deposit whitelist stack is available through the `OrchestratorV2` per-deposit whitelist hook:

- `AddressGroupRegistry`: anyone may create a curator-managed group. Curators can add or remove members,
  transfer control, configure an optional membership resolver, and opt into self-service membership.
- `WhitelistPolicy`: each deposit payment method owns an `enabled` switch and a bounded list of up to 10 allowed
  groups; direct taker addresses remain shared across all payment methods on the deposit. Only the escrow's
  recorded depositor may configure a deposit payment method, and `configureDeposit` updates its switch and groups
  while appending any direct takers to the deposit-wide whitelist. The policy keeps this configuration independently
  of the `OrchestratorV2` hook assignment.
  A governance owner may rotate the escrow registry that gates those writes via `setEscrowRegistry`. The owner
  cannot admit or reject a taker: whitelist enforcement allows a taker when enforcement is disabled for the
  intent's `(deposit, paymentMethod)`, the taker is directly whitelisted on that deposit, or the taker belongs to
  at least one group allowed by that tuple. Enabled policies with no matching address or group fail closed.
  Under `IntentLifecycleHookV1` the no-stake fast lane requires the tuple's whitelist to be **enabled**: a directly
  whitelisted address on a tuple whose whitelist is disabled is treated like any other taker and, on a payment
  method with a nonzero risk window, is routed through stake-backed dispute protection.
  Because enforcement is per tuple, a payment method the depositor adds to a deposit **after** its whitelist was
  configured or bootstrapped starts with that method's whitelist disabled: on a payment method with a nonzero risk
  window its takers are stake-backed by default, on a zero-window method it is open. Depositors configure the new
  tuple themselves, and the whitelist bootstrap can be re-run with `BOOTSTRAP_ALLOW_COMPLETED=true` to pick up
  new tuples of already-bootstrapped deposits.

Group IDs are derived from the curator and registry group counter, and offchain consumers must key them by
chain, registry address, and group ID. Enforcement and groups are scoped to
`(escrow, depositId, paymentMethod)` while direct taker addresses are scoped to `(escrow, depositId)`, so a maker
can independently gate each payment method without maintaining duplicate direct-address lists.

## V2 Contract Inventory

This section covers the current v2 contracts and why each exists.

### Core Contracts

#### `EscrowV2`

`EscrowV2` is the v2 liquidity layer. Each deposit stores:

- depositor and optional delegate
- deposit token
- min/max per-intent amount range
- whether the deposit is currently accepting intents
- optional intent guardian
- optional `retainOnEmpty` behavior so the deposit configuration can survive empty liquidity
- per-payment-method verification data
- per-payment-method supported currencies
- per-currency fixed minimum conversion rates
- optional per-currency oracle rate configuration
- optional delegated rate manager configuration

Notable v2 behavior:

- Supports `createDeposit` and `depositTo`, so contracts can fund deposits on behalf of makers.
- Tracks outstanding intents inside escrow and reclaims liquidity when expired intents are pruned.
- Allows a delegate to manage deposit configuration without ownership transfer.
- Supports oracle-based pricing through `OracleRateConfig` with:
  - `adapter`
  - normalized `adapterConfig`
  - signed `spreadBps`
  - `maxStaleness`
- Supports negative oracle spreads as of March 11, 2026.
- Supports delegated pricing via `RateManagerV1`.
- Exposes batch management APIs for currency/oracle updates.

Important v2 management APIs include:

- `setOracleRateConfig`
- `setOracleRateConfigBatch`
- `updateCurrencyConfigBatch`
- `deactivateCurrenciesBatch`
- `setRateManager`
- `clearRateManager`
- `getEffectiveRate`
- `getManagerFee`

#### `OrchestratorV2`

`OrchestratorV2` is the settlement coordinator. It owns the intent lifecycle:

- `signalIntent`
- `cancelIntent`
- `fulfillIntent`
- `releaseFundsToPayer`
- `cleanupOrphanedIntents`
- escrow-driven `pruneIntents`

Key v2 behavior:

- Validates escrow and payment-method support through registries.
- Locks liquidity on signal and unlocks/releases on cancel or fulfill.
- Snapshots the deposit minimum at signal time to prevent sub-minimum fulfillments later.
- Snapshots delegated manager fee terms at signal time.
- Supports a generic pre-intent hook and a dedicated whitelist hook per deposit.
- Supports optional post-intent hooks through `IPostIntentHookV2`.
- Distributes protocol fees, manager fees, and multiple referral fees.
- Allows every account to hold multiple concurrent intents; V3 admission is governed only by the selected lifecycle hook.

Recent addition:

- Multi-recipient referral fee support landed on March 11, 2026.

#### `ProtocolViewerV2`

`ProtocolViewerV2` is the read-model contract for apps and indexers that need a single call to return:

- a deposit plus all configured payment methods
- effective per-currency rates after floor/oracle/manager logic
- outstanding intent hashes
- reclaimable liquidity from expired intents
- intents joined with their backing deposits

It is stateless and exists to make frontend queries cheaper and simpler.

#### `RateManagerV1`

`RateManagerV1` is the delegated rate registry used by `EscrowV2`.

It stores manager-owned pricing state keyed by a `rateManagerId`:

- manager address
- fee recipient
- fee and max fee
- minimum liquidity requirement
- display metadata (`name`, `uri`)
- per-payment-method / per-currency rates

Important semantics:

- As of March 6, 2026, `RateManagerV1` is a pure registry; floor enforcement is handled inside `EscrowV2`.
- Escrows opt into a manager via `setRateManager`.
- Managers can update one rate or batches of rates.
- The manager fee is snapshotted in `OrchestratorV2` when the taker signals an intent.

### Hook Contracts

#### `WhitelistPreIntentHook`

A depositor-managed private-orderbook mechanism:

- whitelist specific taker addresses per `escrow + depositId`
- only authorized orchestrators may invoke it
- used through the dedicated whitelist hook slot in `OrchestratorV2`

#### `SignatureGatingPreIntentHook`

An off-chain allowlist / RFQ gate:

- the deposit owner or delegate sets an authorized signer per deposit
- the taker includes ephemeral hook data with a signature and expiration
- the hook verifies a payload bound to:
  - orchestrator
  - escrow
  - deposit
  - amount
  - taker
  - recipient
  - payment method
  - fiat currency
  - conversion rate
  - referral fee hash
  - expiration
  - chain id

This is useful for private liquidity, per-trade approval, or off-chain risk checks.

### Oracle Adapters

#### `ChainlinkOracleAdapter`

- Accepts `abi.encode(address feed, bool invert)` raw config.
- Validates the feed and normalizes config to a compact packed format.
- Normalizes output to `1e18` precise units.
- Supports `feed == address(0)` as a constant `1.0` base rate, useful for USD-denominated USDC deposits.

#### `PythOracleAdapter`

- Added on March 3, 2026.
- Accepts `abi.encode(bytes32 feedId, bool invert)` raw config.
- Uses `Pyth.getPriceUnsafe` and returns a normalized `1e18` precise-unit rate plus publish time.
- Delegates staleness enforcement to `EscrowV2` via `maxStaleness`.

### Verifier Layer

#### `UnifiedPaymentVerifier` / `UnifiedPaymentVerifierV2`

The deployed v2 verifier uses the same contract implementation as `UnifiedPaymentVerifier`, but is deployed under the deployment name `UnifiedPaymentVerifierV2`.

Responsibilities:

- maintain the set of supported payment methods
- verify standardized EIP-712 payment attestations
- validate that the attested intent snapshot matches the live orchestrator intent
- nullify `(paymentMethod, paymentId)` combinations through `NullifierRegistry`
- emit normalized `PaymentVerified` events for off-chain reconciliation

#### `BaseUnifiedPaymentVerifier`

Shared base contract for:

- payment method configuration
- attestation verifier rotation
- orchestrator authorization
- nullifier writes

### Registry Layer

The v2 stack reuses and extends the existing registry model:

- `EscrowRegistry`: whitelists escrow contracts
- `OrchestratorRegistry`: whitelists both v1 and v2 orchestrators for escrow/verifier authorization
- `PaymentVerifierRegistry`: maps payment method hash to verifier and supported currencies
- `PostIntentHookRegistry`: whitelists post-intent hooks
- `RelayerRegistry`: backs deployed legacy V1 orchestrators and the deployed prod `OrchestratorV2`
- `NullifierRegistry`: stores consumed payment nullifiers

## Core Lifecycle

### 1. Maker Creates a Deposit

The maker funds `EscrowV2` and specifies:

- deposit token and amount
- min/max intent size
- supported payment methods
- per-method payee and verifier data
- per-method supported fiat currencies
- optional delegate
- optional intent guardian
- whether the deposit should remain configured after going empty

### 2. Deposit Pricing Is Defined

For each `(paymentMethod, currency)` pair, the deposit can use:

- a fixed floor only
- an oracle-backed rate with a spread
- a delegated manager rate through `RateManagerV1`

`ProtocolViewerV2` surfaces the final effective rate used by clients.

### 3. Taker Signals an Intent

`OrchestratorV2.signalIntent`:

- validates the escrow and deposit
- verifies payment-method and currency support
- runs the generic pre-intent hook, if present
- runs the dedicated whitelist hook, if present
- snapshots deposit min amount and manager fee terms
- stores the intent
- locks funds on `EscrowV2`

### 4. Fiat Payment Happens Off-Chain

The taker pays the maker using the selected payment rail. The off-chain attestation layer turns the payment evidence into a standardized signed payload.

### 5. Intent Is Fulfilled

`OrchestratorV2.fulfillIntent`:

- loads the stored intent
- resolves the correct verifier from `PaymentVerifierRegistry`
- verifies the payment proof
- checks the attested intent snapshot against on-chain data
- enforces the min-at-signal guarantee
- prunes the intent
- unlocks and transfers escrowed funds
- distributes protocol, referral, and manager fees
- optionally executes a post-intent hook

### 6. Expired Intents Can Be Reclaimed

If an intent expires:

- the escrow owner can reclaim liquidity during fund removal or withdrawal
- the orchestrator can prune orphaned intents
- `ProtocolViewerV2` exposes reclaimable liquidity so off-chain systems can model real availability

## Rate Management Model

Pricing is one of the biggest differences between the old system and v2.

### Fixed Floors

Every configured currency can carry a fixed minimum conversion rate. This is the hard floor that the settlement rate cannot violate.

### Oracle-Backed Floors

`EscrowV2` can derive rates from an oracle adapter plus a spread:

- Chainlink or Pyth supplies the base market rate.
- `spreadBps` adjusts the market rate.
- `maxStaleness` bounds stale data.
- The effective rate is returned in precise units.

Recent change:

- `spreadBps` is signed, so makers can quote above or below market. The implementation still requires the final multiplier to remain strictly positive.

### Delegated Managers

For programmatic market making, a deposit can delegate pricing to `RateManagerV1`:

- the deposit opts into a `rateManagerId`
- the manager updates rates off the critical settlement path
- `EscrowV2` combines manager-side rates with escrow-side floor enforcement
- `OrchestratorV2` snapshots the manager fee when the taker signals

This split keeps settlement safety inside escrow while letting pricing move quickly.

## Hooks and Extensibility

v2 introduces a clearer extension model around the intent lifecycle.

### Pre-Intent Hooks

Executed during `signalIntent`, before funds are locked:

- generic hook slot: arbitrary eligibility or policy checks
- whitelist hook slot: dedicated private-liquidity control

These hooks are configured per deposit by the depositor or delegate.

### Post-Intent Hooks

Executed during `fulfillIntent`, after verification and escrow release:

- direct recipient settlement remains the default
- hooks can route fulfilled funds into external workflows

### Registries as Safety Gates

The hook and orchestrator registry model prevents arbitrary external contracts from being inserted into the settlement path without explicit whitelisting.

## Payment Verification Model

The verification path is intentionally standardized across payment methods.

### Payment Method Registration

Each payment method is registered in two places:

1. `UnifiedPaymentVerifierV2` must recognize the payment method.
2. `PaymentVerifierRegistry` must map the method to the deployed verifier and its supported currencies.

### Attestation Model

The payment proof decodes into:

- payment details
- an intent snapshot
- witness signatures
- attested data and metadata

The verifier:

- reconstructs the EIP-712 digest
- checks the attestation through the configured attestation verifier
- validates the on-chain intent snapshot
- nullifies the payment ID
- returns the final release amount to `OrchestratorV2`

### Why the Nullifier Registry Matters

Payment IDs are nullified as `keccak256(paymentMethod, paymentId)` so the same raw ID cannot be replayed across methods.

## Repository Layout

```text
contracts/
  Escrow.sol
  EscrowV2.sol
  Orchestrator.sol
  OrchestratorV2.sol
  ProtocolViewer.sol
  ProtocolViewerV2.sol
  RateManagerV1.sol
  hooks/
  interfaces/
  lib/
  mocks/
  oracles/
  registries/
  unifiedVerifier/

archive/
  orchestrator-v2-pre-relayer-cut/  # pristine deployed legacy V2 source, excluded from compilation

deploy/
  00_deploy_system.ts
  01_deploy_unified_verifier.ts
  02_add_venmo_payment_method.ts
  ...
  14_deploy_v2_system.ts
  15_deploy_v2_periphery.ts
  16_configure_v2_payment_methods.ts
  17_deploy_pyth_oracle.ts
  18_redeploy_escrowv2_ratemanager.ts
  19_redeploy_escrowv2_orchestratorv2_staging.ts
  deploy_summary.ts

test-foundry/
  deterministic/
  fuzz/
  invariant/
```

## Getting Started

### Prerequisites

- Node.js 20.20.2 (the version pinned in CI)
- Yarn 4
- Foundry v1.7.1
- a `.env` copied from `.env.default`

### Initial Setup

```bash
corepack yarn install --immutable
cp .env.default .env
```

Fill the relevant environment variables, including the ones used by deployment and verification flows:

- `ALCHEMY_API_KEY`
- `BASE_DEPLOY_PRIVATE_KEY`
- `TESTNET_DEPLOY_PRIVATE_KEY`
- `BASESCAN_API_KEY`
- `ETHERSCAN_KEY`
- `INFURA_TOKEN`

### Local Development

Start a chain:

```bash
yarn chain
```

Deploy locally:

```bash
yarn deploy:localhost
```

For wallet-based local testing, import Hardhat account `#0` into your wallet.

## Build, Test, and Development Commands

### Core Commands

- `yarn compile`: compile Solidity contracts
- `yarn build`: clean, compile, generate typechain bindings, and transpile TypeScript
- `yarn clean`: remove compiler, coverage, and generated build artifacts
- `yarn typechain`: generate TypeChain bindings
- `yarn transpile`: run `tsc`

### Test Commands

- `corepack yarn test`: run the complete always-on Foundry suite
- `corepack yarn test:deterministic`: run deterministic unit, integration, and deployment tests
- `corepack yarn test:fuzz`: run the real-contract property suite at 512 cases per property
- `corepack yarn test:invariant`: run handler-driven invariants at 128 runs × 64 calls
- `forge test --match-path '<path>' --match-test '<name>'`: isolate a file or named test

See [TESTING.md](./TESTING.md) for suite design, seed reproduction, coverage mechanics, and contribution rules.

### Coverage

- `corepack yarn coverage`: run deterministic coverage once, build accurate Foundry LCOV, and enforce the permanent Foundry baseline floors

Coverage is deliberately outside the pull-request critical path. Code pull requests run the complete deterministic,
fuzz, invariant, integration, and deployment Foundry suite. The `Release readiness` workflow runs package and
localhost-deployment checks for release-surface pull requests, every relevant push to `main`, and manual dispatches;
its four coverage lanes run on `main` and manual dispatches only. Markdown, agent guidance, audits, and deployment
logs do not start these workflows when the entire PR or push is limited to those paths. A docs-only follow-up inside
a mixed PR still reruns CI because GitHub evaluates pull-request path filters against the complete PR diff.

Before publishing the contracts package, promoting a release branch, or deploying to Base staging or Base, verify
that the exact release SHA has a green complete Foundry suite and a green `Release readiness` run including package,
localhost-deployment, and coverage jobs. A green contract-only pull request is not release-readiness evidence because
the deferred workflow runs after merge to `main`; if the release SHA has not run there, dispatch `Release readiness`
on its release ref and wait for it. Never reuse coverage or deployment evidence from another SHA.
An ignored documentation-only head may inherit the immediately preceding green runtime SHA only after its complete
intervening diff is proven to contain no executable, package, configuration, or deployment input.

### Packaging Commands

- `yarn pkg:extract`
- `yarn pkg:build`
- `yarn pkg:clean`
- `yarn pkg:test`

## Deployment Model

The deployment pipeline is layered because v2 reuses shared protocol infrastructure.

### Legacy Base System

Scripts `00` through `13` deploy and configure the original shared system and payment method scaffolding. These remain relevant because v2 builds on:

- existing registries
- the shared attestation verifier
- shared payment-method config artifacts

### V2 Deployment Sequence

#### `deploy/14_deploy_v2_system.ts`

Deploys and wires:

- `OrchestratorRegistry`
- `EscrowV2`
- `OrchestratorV2`
- `UnifiedPaymentVerifierV2` (same implementation as `UnifiedPaymentVerifier`)

Then it:

- adds both v1 and v2 orchestrators to `OrchestratorRegistry`
- adds `EscrowV2` to `EscrowRegistry`
- grants the v2 verifier write permissions in `NullifierRegistry`
- transfers ownership of the ownable v2 contracts to the configured multisig

#### `deploy/15_deploy_v2_periphery.ts`

Deploys:

- `WhitelistPreIntentHook`
- `SignatureGatingPreIntentHook`
- `RateManagerV1`
- `ChainlinkOracleAdapter`
- `ProtocolViewerV2`

#### `deploy/16_configure_v2_payment_methods.ts`

Configures the v2 verifier and registry for all supported methods:

- add payment methods to `UnifiedPaymentVerifierV2`
- repoint `PaymentVerifierRegistry` entries to the v2 verifier
- save payment method snapshots
- emit Safe batch calldata when the deployer is not the registry owner

This script currently covers:

- Venmo
- Revolut
- Cash App
- Wise
- Mercado Pago
- Zelle
- PayPal
- Monzo
- N26
- Alipay
- Chime
- Luxon

#### Additional Recent Deployment Scripts

- `deploy/17_deploy_pyth_oracle.ts`: deploys the Pyth adapter
- `deploy/18_redeploy_escrowv2_ratemanager.ts`: redeploys `EscrowV2` and `RateManagerV1` after the rate-floor refactor
- `deploy/19_redeploy_escrowv2_orchestratorv2_staging.ts`: staging-specific redeploy for `EscrowV2`, `OrchestratorV2`, and the signature-gating hook
- `deploy/32_deploy_deposit_creation_guard.ts`: deploys the stateless `DepositCreationGuard` for atomic
  pre/post assertions around `EscrowV2.createDeposit`

The canonical `DepositCreationGuard` was deployed once on Base at
`0x0D765BD7322b9E8C85F66Cc3353dBc6B6d602e2f` in transaction
`0xaa732525f07f9919e3e5ac991430f7f5e7a88e945a4204a23571c14d1a63cfaf`. Its canonical production artifact is
recorded under `deployments/base_prod/DepositCreationGuard.json`. Because the guard is stateless and receives the
target escrow on each call, staging intentionally reuses this production Base deployment. No separate staging
contract deployment or duplicate staging artifact is required.

#### Deployment Summary

`deploy/deploy_summary.ts` prints both legacy and v2 addresses and writes Safe Transaction Builder batch files when multisig actions are pending.

### Common Deployment Commands

- `yarn deploy:localhost`
- `yarn deploy:base`
- `yarn deploy:base_staging`

These are the supported deployment entrypoints and all route through `scripts/deployActive.ts`. Do not invoke
`hardhat deploy` directly: it bypasses the immutable-lane hash and retirement filter.

### V3 Groups Cutover

The lifecycle rollout is split into explicit lanes. Production-executed numbered scripts are immutable
provenance: new behavior gets a new lane, while retirement and live-state checks stay in current helpers
or runner metadata. Lane 31 verifies and cuts over the V3 payment-binding pair, lane 33 owns the
IntentGuardian fee update, lane 34 is the immutable, retired lane that shipped the opt-in dispute/staking
stack, and lanes 36 and 37 are the current deploy-only lanes for the payment-method-scoped policies.

`deploy/30_deploy_v3_lifecycle_stack.ts` is the exact historical groups-only source used in production.
Its original implementation deploys `WhitelistLifecycleHook` and `OrchestratorV3` with the lane-29
`WhitelistPolicy` dependency. The supported runner first verifies the historical source digest, then mounts
`deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts` under lane 30's filename. The wrapper
returns without invoking the historical implementation when the live O3 already uses a bytecode- and
configuration-verified predecessor or successor dispute hook; otherwise it delegates to lane 30's exact
historical function and skip behavior. Do not move live artifacts aside or rerun lane 30 to replace the
current stack. A future O3 deployment requires a new numbered lane.

`deploy/31_deploy_v3_payment_binding_stack.ts` is the state-aware payment-binding and hard-cutover lane.
On Base staging and Base it pins the existing `NullifierRegistryV2` and `UnifiedPaymentVerifierV3`
addresses, runtime code hashes, immutable dependencies, owners, active method order, exact currency arrays,
and writer set. Missing, partial, or mismatched production-like artifacts fail closed; only local networks
may deploy the pair. Base staging is already fully cut over and is verification-only: its registries are
EOA-owned, so the script refuses to approximate an atomic cutover with 22 independent transactions. On Base,
`ENABLE_BASE_V3_PAYMENT_BINDING_CUTOVER=true` removes all ten methods in reverse order, re-adds them in
original order against UPV3, and revokes UPV1 and UPV2 from the legacy nullifier registry. This preserves
the registry order and produces exactly 22 atomic Safe calls. Never route a method back to a retired verifier
after this one-way cutover.

`deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts` is the exact executable source used for the
production dispute-stack deployment. It remains at its original path only as immutable audit provenance;
it is not current read-only code. The supported runner verifies its digest, excludes the exact file from
all tagged and untagged runs, and rejects both historical lane-32 tags. Never invoke it directly.
`deployments/predecessorDisputeStack.ts` owns current read-only predecessor address, deployment-bytecode,
and runtime-bytecode verification used by lane 34 and the Safe tooling.

`deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts` is the exact executable source that deployed the
`StakeVaultOptIn`, `DisputeProtectionPolicyOptIn`, and `IntentLifecycleHookV1OptIn` records on both
networks and, through its Safe batch, activated them on Base. It is immutable and retired: the supported
runner verifies its digest, excludes it from every tagged and untagged run, and rejects both of its tags.
`yarn verify:dispute-opt-in-safe-batch` and `yarn simulate:obsolete-dispute-safe-batch` remain as tooling
for that executed history. The Base `*OptIn` trio is the live dispute stack until the method-scoped
activation lane replaces it; the Base-staging `*OptIn` trio was deployed but never activated.

`deploy/36_deploy_method_scoped_whitelist_policy.ts` deploys `WhitelistPolicyMethodScoped`, the
payment-method-scoped `WhitelistPolicy`, against the existing `AddressGroupRegistry`, `EscrowRegistry`,
and `OrchestratorRegistry`, and hands ownership to governance. Use `yarn deploy:method-scoped-policy:base_staging`
or `yarn deploy:method-scoped-policy:base` with `ENABLE_STAGING_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT=true`
or `ENABLE_BASE_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT=true`. The lane never mutates the registries and
never touches the lane-29 policy or any V2 deposit hook; an existing record is canonical-checked and reused.

`deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts` deploys `DisputeProtectionPolicyMethodScoped`
and `IntentLifecycleHookV1MethodScoped`, wiring the hook to the lane-36 policy and the fresh dispute policy
while reusing the network's pinned `DisputeVerifier`, `DisputeNullifierRegistry`, and — because `StakeVault`
is unchanged and holds live taker stake — the predecessor `StakeVault` itself (`StakeVaultOptIn` on Base, the
lane-32 vault on Base staging). The fresh policy becomes that vault's controller only through the vault's
delayed two-step handover in the activation lane; a `StakeVaultMethodScoped` record exists on localhost only. The lane
executed deploy-only on Base staging and Base on 2026-08-27 and is immutable and retired for live networks: the runner
refuses its tags, and `deployments/activeDeploymentLanes/37_deploy_method_scoped_dispute_lifecycle_stack.ts` mounts it
only for `localhost`/`hardhat`, where it still deploys the local method-scoped stack. The historical deploy-only run
authorized only the
fresh hook, applies non-zero risk windows only to PayPal, Venmo, and Cash App, and on Base initiates the
policy's two-step ownership transfer for the Safe to accept later. It is
transaction-by-transaction resumable and leaves the active O3 hook and the dispute-registry writer set
unchanged. The method-scoped policy is on by default for every payment method with a nonzero risk window
(paypal, venmo, cashapp) and can be opted out per deposit payment method by the depositor; depositor
opt-outs on the passive policy are expected, and only lifecycle activity on it invalidates the deploy-only
preparation; the live vault is never inspected.
`deployments/predecessorDisputeStack.ts` pins what the lane replaces per network in
`METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS`; `PREDECESSOR_DISPUTE_STACKS` keeps describing the predecessor of
the currently selected stack until activation.

`deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts` activates the lane-37 stack. It is
tag-only: `yarn deploy:dispute-method-scoped-activation:base_staging` and
`yarn deploy:dispute-method-scoped-activation:base` run the lane under
`DEPLOY_ACTIVE_TAG=38_activate_method_scoped_dispute_lifecycle_stack`; every untagged run skips it, a
tagged local run throws because there is no predecessor stack, and a lane-38 flag without the tag throws
before any chain read. Every read is pinned to one block and reduced into a single activation state
(`deployed`, `rotation-proposed`, `active`, or `unrecognized`, which aborts). Base staging advances one
deployer-EOA step per run with `PREPARE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION=true` (dry run) or
`ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION=true`: pause predecessor admissions, propose the fresh
policy as the vault controller, release matured predecessor intents, accept the controller once the delay
has elapsed and no predecessor lock is open, add the fresh registry writer, set the O3 hook, and remove
the predecessor writer; the lane reports `controller-delay` / `predecessor-drain` waiting states instead
of guessing. Base produces two unsigned Safe batches, each headed by a freshly deployed on-chain guard
contract that re-checks the whole trust surface inside the Safe transaction:

- `ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_ROTATION_PREPARATION=true` — guard, optional
  `acceptOwnership()` on the fresh policy, `setAdmissionsPaused(true)` on the predecessor policy, and
  `proposeController(freshPolicy)` on the reused vault.
- `ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_CUTOVER_PREPARATION=true` — only after the controller delay with
  zero live predecessor locks: guard, `acceptVaultController()`, `addWritePermission(freshPolicy)`,
  `removeWritePermission(predecessorPolicy)`, and `setLifecycleHook(freshHook)`.
- `ENABLE_BASE_V3_DISPUTE_METHOD_SCOPED_RELEASE_MATURED=true` — permissionless release of matured
  predecessor intents from the deployer so the cutover precondition can be met.

Each batch is simulated on a pinned Base fork with a postcondition contract appended, then written to
`deployments/outputs/safe-batches/base_method_scoped_{rotation,cutover}.json` with a `.sha256.json`
sidecar that pins the proof snapshot, guard identity, and source SHA. Run
`yarn verify:method-scoped-safe-batch --batch rotation|cutover` immediately before the Safe executes;
it re-derives the guard constructor arguments from the manifest, re-proves the guard and postcondition
deployments, re-reads the chain at a fresh block, and re-runs the simulation. Artifact-child verification allows
unrelated commits after the recorded source SHA only when every producer and verifier path in
`ACTIVATION_PROTECTED_PATHS` is unchanged. No script signs. Lane 37
must be retired before activation (its skip asserts the predecessor hook is still live), lane 38 is
pinned after its first live transition, and the `active-dispute-stack.json`,
`PREDECESSOR_DISPUTE_STACKS`, evidence, and `WhitelistPolicy` package-alias flips land in recording PRs
after each execution. Before lane 38 can run:

- [x] Lanes 36 and 37 have executed deploy-only on Base staging and Base and their records are committed,
      and lane 37 is retired in `deployments/immutableDeploymentLanes.ts`.
- [ ] `yarn whitelist:bootstrap` has populated `WhitelistPolicyMethodScoped` on each network.
- [ ] `zkp2p-indexer` indexes the fresh addresses and the tuple-scoped `EnabledUpdated` /
      `DisputeProtectionEnabledUpdated` events.
- [ ] `@zkp2p/contracts-v2` publishes the tuple-scoped ABIs and replacement addresses, and its consumers upgrade.

`deploy/39_deploy_method_scoped_vault_stack.ts` and `deploy/40_activate_method_scoped_vault_stack.ts` supersede
lane 38 (retired unexecuted on Base on 2026-08-28). Lane 39 deploys a dedicated `StakeVaultMethodScoped` with
`DisputeProtectionPolicyMethodScopedStaked` and `IntentLifecycleHookV1MethodScopedStaked` bound to it — controller
set at deployment, so activation needs no two-day rotation — using `yarn deploy:dispute-method-scoped-vault:base_staging`
/ `:base` with `ENABLE_{STAGING,BASE}_V3_DISPUTE_METHOD_SCOPED_VAULT_DEPLOYMENT=true` (deploy-only; Base initiates the
vault and policy ownership transfers to the Safe). Lane 40 (`yarn deploy:dispute-method-scoped-vault-activation:*`,
tag-only) advances Base staging one deployer step per run (add writer → set hook → remove the lane-32 writer) and on
Base prepares one guarded cutover batch (guard → conditional `acceptOwnership` on vault and policy → add fresh writer →
`setLifecycleHook`) plus a later guarded writer-removal batch that is only allowed once every OptIn-opened intent is
terminal and `StakeVaultOptIn` holds no locks. Artifacts live at
`deployments/outputs/safe-batches/base_method_scoped_vault_{cutover,writer_removal}.json`; run
`yarn verify:method-scoped-safe-batch --batch vault-cutover|vault-writer-removal` immediately before the Safe executes.
The same protected-path rule keeps these batches valid across unrelated merges without weakening their source,
artifact-pair, or live-chain checks.
Both lanes are immutable and pinned after their 2026-08-28 Base execution.
Stake in the old vaults is abandoned: stakers withdraw once their locks release and takers re-stake in the new vault
before the cutover; that readiness is part of `CONFIRM_BASE_V3_DISPUTE_METHOD_SCOPED_VAULT_DOWNSTREAM_READY`.

The package exports the currently selected (latest) addresses for each network, and consumers should treat them as
the addresses to use.

Dispute-evidence issuance in `attestation-service` remains a separate follow-up and is intentionally not implemented
by these contract lanes. Only PayPal, Venmo, and Cash App receive non-zero onchain risk windows, matching the
explicitly ratified chargebackable-platform set.

### Whitelist Bootstrap

`yarn whitelist:bootstrap` discovers active deposits from a configurable raw GraphQL endpoint and
selects only deposits with an active Venmo, Cash App, or PayPal payment method. It deduplicates the
matching rows by deposit and payment method and simulates canonical `bootstrapDeposits` batches against the
lane-36 `WhitelistPolicyMethodScoped` record for the ordered, non-empty, distinct group list supplied through
`WHITELIST_GROUP_IDS`. It refuses the lane-29 deposit-scoped policy address and fails closed on a network whose
`WhitelistPolicyMethodScoped` artifact does not exist yet. It imports no indexer
schema package, so the contracts and indexer packages remain acyclic. Discovery is a dry-run by
default; mutation and Safe output require both the exact expected deposit count and the printed
selection digest, which bind the eligible onchain-filtered set and the ordered group IDs. Withdrawn deposits and
inactive payment-method rows are skipped and reported; the count, digest, and generated batches cover only eligible
tuples. All discovery modes enforce a configurable maximum.

- Staging execution requires `BOOTSTRAP_EXECUTE=true` and the current policy owner's private key.
- Production Safe preparation requires `BOOTSTRAP_SAFE_OUTPUT_FILE`; it emits unsigned Transaction
  Builder JSON owned by the policy's onchain owner, and never signs or submits it.
- Direct execution and Safe output are mutually exclusive. Every batch is simulated and its calldata
  decoded and checked before either execution or file output.
- Base execution is pinned to the canonical production indexer and deployment artifacts, and every configured
  group ID must be one of the known production groups recorded by the Base `AddressGroupRegistry`. It also requires
  `BOOTSTRAP_CONFIRM_PRODUCTION=true`.
- `BOOTSTRAP_ALLOW_COMPLETED=true` resumes only batches whose deposit/payment-method tuples are still enabled and
  contain every requested group. The script rechecks policy ownership before each submitted batch.
- Direct execution uses the receipt RPC for confirmation and bounded post-receipt state reads. It computes
  EIP-1559 fees from the latest base fee with a `0.001` gwei priority fee and refuses to submit above
  the `0.02` gwei default max-fee ceiling; both values are configurable through the documented env.
- Run `yarn whitelist:bootstrap --self-test` for the embedded calldata/Safe validation and
  `yarn whitelist:bootstrap --help` for the complete environment-variable reference.

### Verification Commands

- `yarn etherscan:base`
- `yarn etherscan:base_staging`

## Supported Payment Methods

The repository contains deployment coverage for the following payment rails in the current v2 configuration flow:

- Venmo
- Revolut
- Cash App
- Wise
- Mercado Pago
- Zelle
- PayPal
- Monzo
- N26
- Alipay
- Chime
- Luxon

Payment-method specific provider configuration lives under `deployments/verifiers/`.

## Testing Strategy

Foundry is the sole contract test system. The suite is separated by assurance type:

- `test-foundry/deterministic/`: unit behavior, integration, deployment topology, events, reverts, state, balances, and authorization boundaries
- `test-foundry/fuzz/`: bounded real-contract properties that add input breadth beyond deterministic cases
- `test-foundry/invariant/`: multi-actor handlers, ghost accounting, lifecycle conservation, and nullifier uniqueness

The default `corepack yarn test` command runs every layer with the centrally configured run counts. The PR suite has
no reduced fuzz counts, pending cases, or ignored test failures, but non-runtime paths are skipped and coverage is
deferred. During development, run the affected file first and rely on the exact commit's PR suite for the complete
gate. Run or confirm the deferred coverage and release-readiness workflow only when preparing a package, release
branch, or deployment, or when changing its configuration.

## Networks and Deployment Artifacts

The repo is configured primarily for:

- Base
- Base staging
- localhost / hardhat

Artifacts and exports live in:

- `deployments/<network>/`
- `deployments/outputs/`

The deploy scripts also reference current network parameters such as:

- USDC addresses
- multisig address
- protocol fee recipient
- dust recipient
- Pyth contract address

These parameters live in `deployments/parameters.ts`.

## Security Notes

- The contracts are designed around explicit registry-based authorization rather than open-ended plugin injection.
- `EscrowV2` and `OrchestratorV2` both use reentrancy guards on state-changing flows that interact with external contracts.
- Payment replay protection depends on `NullifierRegistry`.
- Oracle safety depends on both adapter validation and escrow-side `maxStaleness`.
- Manager fees are capped and snapshotted at signal time.
- The README is not a full audit report. Contract behavior should be read alongside the source and tests before making deployment or integration assumptions.

## License

MIT
