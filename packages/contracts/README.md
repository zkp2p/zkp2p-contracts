# @zkp2p/contracts-v2

Official npm package for ZKP2P V2 smart contract interfaces, ABIs, addresses, and utilities.

## Release 0.4.4-rc.5

Compared with rc.4, Base staging exports the dispute trio redeployed with the stake-owner policy bytecode
on 2026-10-13 from `285bc5c`:

- `StakeVault` / `StakeVaultBypass`: `0x6b32df91EB92637F64bA444996702fC9582C87a1`.
- `DisputeProtectionPolicy` / `DisputeProtectionPolicyBypass`: `0x1a9C442E3Ae99fB08313242fCdA601431027B39C`.
- `IntentLifecycleHookV1` / `IntentLifecycleHookV1Bypass`: `0xec27Cc47370267c843177375c3Fe43D29D498bB4`.

All other staging addresses, including `StakeVaultMethodScoped` and `UnifiedPaymentVerifierV4`, are unchanged.
ABIs are unchanged, including the byte-identical `DisputeProtectionPolicy` ABI export. Every Base value is
unchanged. Includes everything from `0.4.4-rc.4` and targets the `rc` tag; `latest` remains at `0.4.3`.

The rc.4 staging trio is abandoned and no longer exported. OrchestratorV3 on staging mounts the fresh hook,
which rejects a protected-route validation envelope that names the rc.4 policy
(`ILH: Invalid payment validation hook`), so staging consumers must use the rc.5 `DisputeProtectionPolicy`
address.

The staging dispute-stack manifest (`disputeStack/baseStaging`) follows the fresh trio: its addresses, the
policy and hook runtime code hashes, and `lifecycleHookAuthorizationFromBlock`, which is now `52530944`.

This is also the first release after the superseded sources moved to `contracts/archive/`. Their TypeChain
types move from `types/contracts/` to `types/contracts/archive/`, so `Escrow`, `Orchestrator`,
`OrchestratorV2`, `ProtocolViewer`, `IProtocolViewer`, `PostIntentHookRegistry`, `IPostIntentHookRegistry`,
`UnifiedPaymentVerifier` and `BaseUnifiedPaymentVerifier` are now exported under `contracts.archive` from
`@zkp2p/contracts-v2/types`, keeping their `interfaces`, `registries` and `unifiedVerifier` sub-namespaces.
Their ABI and address exports are unchanged.

## Release 0.4.4-rc.4

- Base staging canonical aliases (`StakeVault`, `DisputeProtectionPolicy`,
  `IntentLifecycleHookV1`) now resolve to the bypass stack; every staging payment
  method routes to `UnifiedPaymentVerifierV4`.
- The by-name records `StakeVaultBypass`, `DisputeProtectionPolicyBypass`,
  `IntentLifecycleHookV1Bypass`, and `UnifiedPaymentVerifierV4` retain their addresses;
  the three dispute records equal their canonical aliases on staging. The previous
  staging vault remains exported as `StakeVaultMethodScoped` for withdrawals and claims.
- The staging dispute-stack manifest names the previous policy and hook as
  `RecognizedPredecessorPolicy` / `RecognizedPredecessorHook`. The dispute registry
  retains the predecessor as a passive writer and the bypass policy as its active writer.
- Base is unchanged: MethodScoped aliases, UPV3 routing, and zero addresses for the bypass
  names. Base also exports a zero address for `StakeVaultMethodScoped`, because that vault
  is still Base's canonical `StakeVault`.
- Includes everything from `0.4.4-rc.3`.
- Targets the `rc` tag; `latest` remains at `0.4.3`.

## Release 0.4.4-rc.3

- Adds the `UnifiedPaymentVerifierV4` canonical source ABI and no-stake dispute
  protection ABIs: `DisputeProtectionPolicy` gains `setIntentNoStake`,
  `isIntentNoStake`, `validatePayment`, and the `DisputeProtectionIntentStakeModeChanged`
  event; the `getDisputeProtectionIntent` struct is unchanged. `IntentLifecycleHookV1`
  requires the `abi.encode(policy, abi.encode(bool noStake))` validation envelope in
  `intent.data` on protected routes. That release's `StakeVault` source accepted a zero
  controller-change delay; the current source restores the August vault and adds `StakeVaultV2` separately.
- Base staging exports `StakeVaultBypass`, `DisputeProtectionPolicyBypass`,
  `IntentLifecycleHookV1Bypass`, and `UnifiedPaymentVerifierV4` deployment records by
  name (deployed, not yet activated). Canonical aliases (`StakeVault`,
  `DisputeProtectionPolicy`, `IntentLifecycleHookV1`) are unchanged on both networks;
  Base exports zero addresses for the new names.
- Includes everything from `0.4.4-rc.2`.
- Targets the `rc` tag; `latest` remains at `0.4.3`.

## Release 0.4.4-rc.2

- Adds the executed Monobank/UAH registration to the Base catalog, matching Base
  Safe nonce 85 at block 52,132,101. Base staging retains its existing registration.
- Records Monobank's zero dispute risk window. The buyer attestor separately
  enforces the 14-day payment timestamp buffer.
- Includes UAH currency hashes and Monobank cross-network lookups from `0.4.4-rc.1`.
- Targets the `rc` tag; `latest` remains at `0.4.3`.

## Release 0.4.3

- Exports canonical `FxRateStore` and `FxRateFeed` source ABIs under `abis/contracts`.
- Adds Base addresses for `FxRateStore` (`0x389206956C57bdB5d07FF78AB3D1e1DEED070b9c`),
  `FxRateFeedInrUsd` (`0x053A03F1704aE3F71082D3cDFD50BC830415A326`), and
  `FxRateFeedCnyUsd` (`0xc034d806DbeA6b13980D94174eA5FF83E1C191C3`).
  The feeds are shared on Base; `baseStaging` exports all three names as zero addresses
  through extractor backfill, not staging deployments.
- Adds the `OracleFeedProvider` runtime enum and optional `provider` field to oracle feeds.
  Existing feeds use `chainlink`; the new INR/USD and CNY/USD feeds use `zkp2p` and are
  backed by `FxRateStore` with a hardcoded 5%/24h band.
- Published on the `latest` tag; `rc` remains at `0.4.3-rc.1`.

## Release 0.4.3-rc.1

- Adds INR/USD and CNY/USD oracle feeds with provider `zkp2p`, served by
  ZKP2P-operated `FxRateFeed` contracts on Base backed by `FxRateStore`
  with a hardcoded 5%/24h band.
- Consumers selecting oracles by currency now see INR and CNY.
- Targets the `rc` tag; `latest` remains at `0.4.2`.

## Release 0.4.3-rc.0

- Exports canonical `FxRateStore` and `FxRateFeed` source ABIs under `abis/contracts`.
- Adds the `OracleFeedProvider` runtime enum and optional `provider` field to oracle feeds;
  all existing entries use `chainlink`, with no INR/USD or CNY/USD catalog entries yet.
- Adds Base addresses for `FxRateStore`, `FxRateFeedInrUsd`, and `FxRateFeedCnyUsd`.
  The feeds are shared on Base; Base staging has no FX deployment addresses.
- Targets the `rc` tag; `latest` remains at `0.4.2`.

## Release 0.4.2

- Adds the registered X Money/USD method to Base and Base staging catalogs
  and cross-network hash lookups, with a zero dispute risk window.
- Includes the registered UPI/INR method in both Base and Base staging catalogs
  and cross-network hash lookups. The catalog identifies generic UPI; clients
  select Amazon Pay for buyer payment verification.
- Published on the `latest` tag; the existing `rc` tag is unchanged.

## Release 0.4.1

- Exports the canonical source ABIs for `DisputeNullifierRegistry`, `DisputeProtectionPolicy`,
  `DisputeVerifier`, `IntentLifecycleHookV1`, and `StakeVault`.
- Hard-cuts unused chargeback deployment aliases and exposes only the canonical `Dispute*` API.
- Requires a complete fresh Base staging dispute stack before the release can be published.
- Exports deterministic dispute-stack manifests for Base production and staging,
  including runtime identities, governance ownership, attestation trust, and exact authorization sets.
- Hard-cuts the retired `disputeReadiness` subpath in favor of `disputeStack`.

## Installation

```bash
npm install @zkp2p/contracts-v2
# or
yarn add @zkp2p/contracts-v2
# or
pnpm add @zkp2p/contracts-v2
```

## Quick Start

```typescript
// Import addresses for specific networks
import { base, baseStaging } from "@zkp2p/contracts-v2/addresses"

// Import specific contract ABIs from a network
import { Escrow, Orchestrator } from "@zkp2p/contracts-v2/abis/baseStaging"

// Import constants
import { USDC, INTENT_EXPIRATION_PERIOD } from "@zkp2p/contracts-v2/constants/base"

// Import payment method configurations
import { baseStaging as paymentMethods } from "@zkp2p/contracts-v2/paymentMethods"

// Import TypeScript types (TypeChain contract types are under the `contracts` namespace,
// for example `contracts.EscrowV2` and `contracts.OrchestratorV3`)
import type { contracts } from "@zkp2p/contracts-v2/types"

// Import utility functions
import { getKeccak256Hash, calculateIntentHash } from "@zkp2p/contracts-v2/utils/protocolUtils"

// Import stable source ABIs for the deposit-scoped whitelist policy
import {
  AddressGroupRegistry,
  OrchestratorV3,
  WhitelistLifecycleHook,
  WhitelistPolicy,
} from "@zkp2p/contracts-v2/abis/contracts"

// Import the selected per-network dispute-stack manifest
import { base as baseDisputeStack } from "@zkp2p/contracts-v2/disputeStack"

// Example: Create contract instance with ethers
import { ethers } from 'ethers';

const provider = new ethers.providers.JsonRpcProvider('https://mainnet.base.org');
const orchestrator = new ethers.Contract(
  base.Orchestrator,
  Orchestrator,
  provider
);

console.log('Intent expiration:', INTENT_EXPIRATION_PERIOD);
console.log('Venmo config:', paymentMethods.venmo);
console.log('Expected successor hook:', baseDisputeStack.expectedRelations.activeLifecycleHook);
```

## Features

### 📍 Network-Specific Contract Addresses

Pre-configured addresses for all deployed networks:

```typescript
import { base, baseStaging } from "@zkp2p/contracts-v2/addresses"

console.log(base.Orchestrator);
console.log(base.Escrow);
console.log(baseStaging.UnifiedPaymentVerifier);
```

Supported networks:
- Base (`base`)
- Base staging (`baseStaging`)

### 📜 Network-Specific Contract ABIs

Minimal ABIs extracted from on-chain deployments:

```typescript
// Import specific contracts from a network
import { Orchestrator, Escrow } from "@zkp2p/contracts-v2/abis/baseStaging"

// Use the ABIs directly with ethers or viem
const orchestratorABI = Orchestrator;
const escrowABI = Escrow;

// Alternative: Import all ABIs for a network
import * as baseStagingAbis from "@zkp2p/contracts-v2/abis/baseStaging"
const unifiedVerifierABI = baseStagingAbis.UnifiedPaymentVerifier;

// Also supports direct JSON imports for bundle optimization
import EscrowABI from "@zkp2p/contracts-v2/abis/baseStaging/Escrow.json"
```

### 🔧 Network-Specific Protocol Constants

All protocol parameters and configurations per network:

```typescript
import { INTENT_EXPIRATION_PERIOD, MAX_INTENTS_PER_DEPOSIT, DUST_THRESHOLD } from "@zkp2p/contracts-v2/constants/base"
import * as baseStagingConstants from "@zkp2p/contracts-v2/constants/baseStaging"

// Use specific constants
console.log('Intent expiration:', INTENT_EXPIRATION_PERIOD);
console.log('Max intents:', MAX_INTENTS_PER_DEPOSIT);

// Or access all constants for a network
console.log('USDC address:', baseStagingConstants.USDC);
```

### 💳 Payment Methods with Provider Hashes

Unified payment method configurations including provider hashes from deployment:

```typescript
import { base, baseStaging } from "@zkp2p/contracts-v2/paymentMethods"

// Access payment method configurations
const venmoConfig = base.venmo;
console.log('Payment Method Hash:', venmoConfig.paymentMethodHash);
console.log('Currencies:', venmoConfig.currencies);

// Or use staging configurations
const stagingPaymentMethods = baseStaging;
console.log('Available methods:', Object.keys(stagingPaymentMethods));
```

### 🛠️ Utility Functions

Protocol utility functions:

```typescript
// Import protocol utilities
import { getKeccak256Hash, calculateIntentHash, getCurrencyInfo } from "@zkp2p/contracts-v2/utils/protocolUtils"
import { Currency } from "@zkp2p/contracts-v2/utils/types"

// Use utility functions
const paymentMethodHash = getKeccak256Hash("venmo");
const intentHash = calculateIntentHash(depositor, depositId, signalIntentParams);

// Get currency information
const usdInfo = getCurrencyInfo(Currency.USD);
console.log('Currency code:', usdInfo.code);
console.log('Decimals:', usdInfo.decimals);
```

### 🛡️ Dispute Stack

`@zkp2p/contracts-v2/disputeStack` exports `base`, `baseStaging`, and
`disputeStackByNetwork` in CommonJS and ESM, with declarations under the same subpath. Each
manifest pins:

- The selected dispute-stack version and selection hash.
- The exact successor and recognized predecessor addresses and runtime code hashes.
- The complete approved orchestrator membership, its runtime identities, and the registry deployment
  block from which consumers reconstruct additions/removals and reject extras; plus verifier, whitelist,
  vault-controller, lifecycle-hook authorization, and Base USDC dependency expectations.
- A fail-closed sentinel probe and the active-successor prerequisites, including unpaused
  admission, an unpaused orchestrator, and `allowMultipleIntents = true`.
- The approved risk window for every active payment-method bytes32 hash: 1,209,600 seconds for
  PayPal and Venmo, and zero for all other active methods, including Cash App.

The package exports the currently selected (latest) addresses for each network, and consumers should
treat them as the addresses to use.


## API Reference

### Package Structure

The package follows modern ESM/CJS patterns with clean subpath exports:

```
@zkp2p/contracts-v2/
├── addresses/          # Network-specific contract addresses
├── abis/              # Network-specific contract ABIs  
├── constants/         # Protocol constants per network
├── paymentMethods/    # Payment method configurations
├── disputeStack/      # Trusted V3 identities and policy expectations
├── types/             # TypeScript type definitions
└── utils/             # Utility functions
```

### Import Patterns

All modules are directly accessible via subpath exports:

- `@zkp2p/contracts-v2/addresses` - Contract addresses for all networks
- `@zkp2p/contracts-v2/abis/<network>` - Contract ABIs per network (e.g., `/abis/baseStaging`)
- `@zkp2p/contracts-v2/abis/contracts` - Stable source ABIs for approved but not-yet-deployed contracts
- `@zkp2p/contracts-v2/abis/<network>/<contract>.json` - Direct JSON import for specific contracts
- `@zkp2p/contracts-v2/constants/<network>` - Constants per network
- `@zkp2p/contracts-v2/paymentMethods` - Payment method configs
- `@zkp2p/contracts-v2/disputeStack` - Typed Base production/staging dispute-stack manifests
- `@zkp2p/contracts-v2/disputeStack/<network>.json` - Direct dispute-stack JSON import
- `@zkp2p/contracts-v2/utils/protocolUtils` - Protocol utilities
- `@zkp2p/contracts-v2/types` - TypeScript types

### Export Format Details

The package now uses explicit wrapper modules for each network to ensure reliable imports across all environments:

```typescript
// Recommended: Import from network-specific wrappers
import { Escrow, Orchestrator } from "@zkp2p/contracts-v2/abis/baseStaging"

// Alternative: Direct JSON imports for bundle size optimization
import EscrowABI from "@zkp2p/contracts-v2/abis/baseStaging/Escrow.json"

// CommonJS compatibility
const { Escrow } = require("@zkp2p/contracts-v2/abis/baseStaging")
```

Each network export provides:
- CommonJS support (`.cjs`)
- ESM support (`.mjs`)
- TypeScript definitions (`.d.ts`)
- Direct JSON file access

## Development

### Build and release

From `packages/contracts`:
- `yarn build` – Clean, extract, and bundle package
- `yarn test` – Run package tests
- `yarn verify:release` – Verify current ABIs and deployment-address integrity
- `npm pack --dry-run` – Preview tarball contents

Publishing is performed only by the protected GitHub Actions trusted-publishing workflow. It uses npm OIDC and provenance without a long-lived npm token. See [the release runbook](../../NPM_RELEASE.md).

The package uses modern module patterns with `_esm/`, `_cjs/`, and `_types/` folders for compatibility.

## License

MIT

## Links

- [GitHub Repository](https://github.com/zkp2p/zkp2p-contracts)
- [Documentation](https://docs.zkp2p.xyz)
- [Website](https://zkp2p.xyz)

### UPV4 return compatibility and O4 settlement

UPV4 accepts the same 448-byte `abi.encode(PaymentDetails, IntentSnapshot)` prefix as UPV3,
followed by signed extension bytes. Witness signatures cover the entire payload. UPV4 returns
those bytes untouched and uninterpreted; O3 continues to decode the V1 result prefix.
Extension word 0 is the dispute window in uint256 seconds, required for non-manual settlements
and capped at 180 days. Word 1 is the conditions hash; an incomplete word reads as zero.
Words 2+ are reserved. O4 settlement payloads therefore contain at least 480 bytes, or 512 bytes
with conditions. Manual release forwards an empty extension.

OrchestratorV4 calls `IIntentSettlementPolicy` directly. This minimal interface contains only
`settleIntent(SettlementContext)` and `onDeferredPayoutFunded(bytes32)`. A replacement policy
needs only these settlement functions and ERC-165 support, so its rules can change without a new
orchestrator. `setSettlementPolicy` accepts zero (no protection) or a contract advertising this
interface through ERC-165; `InvalidSettlementPolicy` rejects the wrong contract at configuration
time instead of failing every fulfil. `settlementPolicy`, `getIntentSettlementPolicy`,
`SettlementPolicyUpdated` and `IntentSettlementPolicySnapshotted` expose the current selection
and each intent's snapshot. Changing the selection affects only future intents. O4 retains its
own `IOrchestratorV4` ERC-165 advertisement. OrchestratorV3, IntentLifecycleHookV1 and the August
DisputeProtectionPolicy are unchanged.

O4 and DisputeProtectionPolicyV2 receive the same immutable, nonzero deployed `IWhitelistPolicy`
in their constructors. The policy reads the calling authorized orchestrator's current
`IRelayerRegistry` at settlement through `IRelayerRegistryProvider`; it stores no registry.
A zero registry reverts with `ZeroRelayerRegistry`. The lookup occurs at the relayer exemption,
after the whitelist exemption and before the deposit opt-out and token checks. O4 enforces admission
at signal: an enabled deposit/payment-method whitelist must allow the taker. `TakerNotWhitelisted` rejects non-members even with a zero
settlement policy. Signal does not call the settlement policy. Cancel, escrow prune and orphan
cleanup clear the intent and policy snapshot without policy callbacks.

IOrchestratorV4 retains V3's `Intent` field order with `postIntentHook` removed:
`owner, to, escrow, depositId, amount, timestamp, paymentMethod, fiatCurrency, conversionRate, payeeId, referralFees, data`.
`SignalIntentParams` drops `postIntentHook`; `FulfillIntentParams` drops `postIntentHookData`.
O4 never executes a post-intent hook. ProtocolViewerV2 still reads the V2/V3 layout; read O4
intents directly through `getIntent`.

`data` is opaque to O4 and stored only in `Intent.data`. Non-empty data requires a current policy
(`DataRequiresPolicy`) and a deposit payment-method gating service (`DataRequiresGatingService`).
O4 appends `keccak256(data)` to the existing 336-byte packed gating message, producing 368 bytes.
Empty data preserves V3's message byte-for-byte. Read data through `getIntent(intentHash).data`
until pruning; there is no separate policy-data mapping or getter.

Settlement preserves O3's order: escrow unlock, the unchanged protocol/referral/manager fee
function, the snapshotted policy, then net payout. O4 captures the token and depositor before
unlock, even when escrow deletes an exhausted deposit, and the policy never reads escrow during
settlement. Only the depositor opt-out setter reads escrow.
`SettlementContext` is `{ intentHash, token, taker, recipient, depositor, escrow, depositId,
paymentMethod, releaseAmount, netAmount, data, extensionData, isManualRelease }`.
The policy returns zero to pay `intent.to` now, or the vault that must receive `netAmount`.
O4 transfers the net to that vault, calls `onDeferredPayoutFunded` in the same transaction,
and emits `IntentPayoutDeferred` and `IntentFulfilled` naming the vault. A revert rolls back
escrow unlock, fees and payment verification. A zero snapshotted policy pays `intent.to` directly.
O4 does not decode extensions, validate conditions, read the whitelist at settlement or select
collateral based on the token.

DisputeProtectionPolicyV2 authorizes callers with `setOrchestratorAuthorization` and
`isOrchestratorAuthorized`, emits `OrchestratorAuthorizationUpdated`, and rejects unauthorized
callers with `UnauthorizedOrchestrator`, including manual settlements and funding callbacks.
Governance must retain authorization for an old policy's orchestrator until its snapshots drain.
Authorize a successor alongside its predecessor with `StakeVaultV2.setController(successor, true)`,
then select it with O4's `setSettlementPolicy`: new intents snapshot the successor for settlement,
while existing snapshots and locks remain with the predecessor. The predecessor stays authorized
until its locks drain; complete any policy-mediated payouts before de-authorizing it.

`StakeVaultV2` is a separate contract and source ABI. The August `StakeVault` / `IStakeVault` retain
main's delayed single-controller behavior. V2 has no proposal, acceptance, initialization-once or
controller delay. Its constructor accepts an optional initial controller; non-zero controllers must
have deployed code. Owner-only `setController(address,bool)` takes effect immediately and emits
`ControllerUpdated`. Each lock stores its creator, exposed by `lockController(lockId)`; only that
creator while authorized may increase, resize, unlock or resolve it. Removing authorization freezes
its open locks until re-authorization. Lock events and the `locks` tuple remain unchanged.
Every authorized controller is governance-trusted: it can lock any owner's free stake and call
`payOutStake` to pay any owner's free stake only to that owner's own address. Payout authority is
per owner, independent of which controller released the stake. Staking, claims, withdrawals,
taker delegation and accounting invariants are unchanged.
The policy validates settlement in this order:

1. Manual release returns zero.
2. Require extension word 0 (`MissingDisputeWindow`) and check the uint256 window against
   `MAX_RISK_WINDOW` (180 days) before narrowing (`InvalidDisputeWindow(uint256)`).
3. Require extension word 1 to equal `bytes32(data)` (`ConditionsNotAttested(intentHash)`).
4. Window zero returns zero.
5. A live enabled whitelist allowing the taker returns zero.
6. A registered relayer taker returns zero unless the deposit has opted out of relayer bypass.
7. A token other than `stakeVault.stakeToken()` returns zero.
8. Reject duplicate records and zero amounts, enforce timestamp bounds, then lock gross stake
   (`STAKE`) or defer the net payout (`DEFERRED_PAYOUT`).

Whitelist and relayer membership belong to the taker, not the recipient, and are read live at
settlement. Registered relayer takers bypass collateral on every deposit by default. Only the
depositor may call `setDepositOptOutForRelayerBypass(escrow, depositId, optOut)` to opt out or back
in; delegates are rejected with `NotDepositor(escrow, depositId, caller)`. The setter emits
`DepositOptOutForRelayerBypassUpdated`; `isDepositOptedOutForRelayerBypass` exposes the current
value. Opt-outs are scoped to escrow and deposit ID. A fake escrow can only write its own key,
because settlement uses the escrow validated by O4. Opting out restores the collateral cascade
for relayers, but whitelist and manual-release exemptions still take precedence. Disabling a
whitelist or removing its taker restores the cascade only if relayer bypass does not apply.
Exempt settlements write no record, emit no policy event and make no vault call (except the
stake-token read for the non-stake-token exemption). There are no signal/cancel records,
per-method windows or admissions pause.
Both protected paths create a `SETTLED` record; the deferred path returns `address(stakeVault)`.
Funding requires a `SETTLED` `DEFERRED_PAYOUT` record and calls `fundLock`; the vault rejects double
funding with `LockAlreadyExists`. Skipping funding leaves a settled record without a vault lock.
Funding does not change the policy record or emit a policy event.

Status ordinals are `NONE=0`, `SETTLED=1`, `RELEASED=2`, `DISPUTED=3`; collateral ordinals are
`NONE=0`, `STAKE=1`, `DEFERRED_PAYOUT=2`. The stored record remains
`taker, recipient, stakeOwner, depositor, paymentMethod, status, collateralSource,
releaseEligibleAt, lockedAmount, claimedAmount`. It stores neither releaseAmount nor riskWindow.
`DisputeProtectionIntentSettled` preserves both in the event and fires only for protected
settlements. Only matured collateral releases emit `DisputeProtectionIntentReleased`.
Disputes, releases and claims retain their own guards; no Opened or Cancelled event is emitted.

The policy reads the conditions hash as `bytes32(data)`: empty/all-zero data means none,
shorter data is right-padded and longer data uses the first word. Clients normally send
`abi.encodePacked(conditionsHash)` or empty data. There is no length/version decoding.
The comparison is symmetric, including zero windows, whitelisted takers and relayer bypass.
Manual release skips it. Off-chain v1 convention is
`conditionsHash = keccak256(abi.encode(uint8(1), salt, payerIdHash))`, with two bytes32 values.
Use a cryptographically random salt per intent and keep it off-chain with the conditions supplied
to the gating service and attestor.

Lanes 45/46 deploy StakeVaultV2, WhitelistPolicyV4, DisputeProtectionPolicyV2, UPV4 and O4 without a lifecycle hook.
Lane 45 authorizes the policy on the vault immediately, without an accept-controller step.
They pass a fresh `WhitelistPolicyV4` to O4 and the policy, set O4's policy, authorize O4 on the policy,
and register O4 last. `WhitelistPolicyV4` uses unchanged `WhitelistPolicy.sol` with the same
AddressGroupRegistry, EscrowRegistry and OrchestratorRegistry as `WhitelistPolicyMethodScoped`.
No deposit entries are seeded: existing deposits start with whitelist off on O4, while O3 and its
August hook keep `WhitelistPolicyMethodScoped` and its settings. Merchant groups remain available
when a depositor enables them on the fresh instance. The deployer retains ownership on staging/local;
Base transfers its single-step Ownable ownership directly to the Safe during lane 45.
The policy reads the calling orchestrator's current relayer registry at settlement, so O4 registry updates immediately govern bypass for existing and new intents.
Deployment checks, activation snapshots and the on-chain guard retain O4's pinned registry check.
Depositor opt-outs are allowed before activation. Bypass batch manifest version 11 records the
selected policy's vault-controller authorization, O4 authorization, fresh whitelist ownership/registries
and the separate O3/O4 whitelist bindings, without a separate policy registry; older manifests are rejected. Historical O3 predecessor checks
remain separate. The package drops the removed hook ABI. Its source ABI catalog does not export interface ABIs;
generated TypeChain interface exports include `IIntentSettlementPolicy` and `IStakeVaultV2`.
The source ABI catalog exports `StakeVaultV2` separately from the August `StakeVault`.

The cross-repo attestor smoke is gated by `ATTESTOR_POLICY_SMOKE_ROOT`; its signed payload
contains word 0 (zero for pay now, the attested window for protected settlements).

`WhitelistPolicyV4` is exported as its own network address key and uses the existing `WhitelistPolicy`
ABI. It never replaces the canonical `WhitelistPolicy` alias used by O3. Until a network's lane-45
recording exports the new deployment, this key is zero (including Base until its separately approved run).
