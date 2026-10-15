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
  `intent.data` on protected routes. `StakeVault` accepts a zero controller-change delay.
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

### UPV4 wire format and return compatibility

UPV4 accepts the same 448-byte `abi.encode(PaymentDetails, IntentSnapshot)` payload as UPV3,
followed by optional signed extension bytes. The entire `data`, including the extension, is
covered by `dataHash` and witness signatures. UPV4 returns the extension untouched and uninterpreted.
Extension fields occupy dedicated 32-byte words: word 0 is `disputeWindow` (uint256 seconds),
word 1 is the attested `conditionsHash`, and words 2+ are reserved and ignored by the current hook.
Non-manual HookV2 settlement requires a complete word 0 (`MissingDisputeWindow()` otherwise),
rejects windows above 180 days with `InvalidDisputeWindow(window)`, and treats zero as pay now.
A missing complete word 1 reads as zero. O4 settlement payloads are at least 480 bytes, or 512 bytes
with conditions. The 448-byte prefix and opaque UPV4 return remain unchanged for O3.
Attestors must sign seconds in word 0; the former balance-funded boolean no longer has that meaning.

The fully static result preserves the V1 `success`, `intentHash`, `releaseAmount` prefix,
then returns the uncapped `attestedReleaseAmount`, verified `PaymentDetails`, and signed/validated
`IntentSnapshot`. Dynamic extension bytes are a separate
trailing return value; unsigned metadata is never returned. O3 reads the V1 prefix with or without
extension bytes. O4 forwards the raw extension and opaque `intent.data` saved before pruning to
its snapshotted IntentLifecycleHookV2. The hook is stateless by design: per-intent data lives only in O4,
and the hook interprets it because governance can replace hooks for future intents while O4
is not upgradeable. Manual release forwards the saved data and an empty extension; the hook skips the
attestation comparison and extension validation and returns pay now without calling the policy.

IOrchestratorV4 keeps V3's `Intent` field order with `postIntentHook` removed entirely:
`owner, to, escrow, depositId, amount, timestamp, paymentMethod, fiatCurrency, conversionRate, payeeId, referralFees, data`.
`SignalIntentParams` keeps V3's fields in order except `postIntentHook`;
`FulfillIntentParams` keeps V3's fields except `postIntentHookData`. O4 has no post-intent-hook execution.
`data` is the opaque lifecycle hook payload and is stored only in `Intent.data`. Non-empty data requires
a mounted lifecycle hook (`LifecycleHookDataRequiresHook`) and a deposit payment-method gating service
(`LifecycleHookDataRequiresGatingService`). O4 appends `keccak256(data)` to the gating message; empty
data preserves the plain V3 packed message byte-for-byte. Read it through `getIntent(intentHash).data`
until pruning; there is no separate hook-data mapping or getter. Fees are unchanged. The net payout goes
to the lifecycle hook's deferral vault or directly to `intent.to`. Settlement preserves O3's order:
escrow unlock, protocol/referral/manager fee transfers, lifecycle hook, then net payout. O4 passes the
depositor and token read before unlock to the hook, so settlement works even when escrow deletes an
exhausted deposit. The policy does not read escrow at settlement. UPV4 checks O4's ERC-165 interface
before the V2 probe and decodes `IOrchestratorV4.Intent`; O3 and older decode paths stay unchanged.
ProtocolViewerV2 is unchanged and decodes only the V2/V3 `Intent` layout, so it cannot serve O4 intents;
read O4 intents directly with `OrchestratorV4.getIntent`.

IntentLifecycleHookV2 is stateless. At signal, a deposit's enabled whitelist is a pure admission gate:
non-members are rejected, and nonzero conditions require a gating service. Signal never calls the
policy or checks the deposit token, hook authorization, or a risk window. Cancellation is an unrestricted
no-op, retained for future hooks; O4 still invokes the snapshotted callback on cancel, escrow prune and
orphan cleanup.

`SettlementContext` is `{ intentHash, token, depositor, taker, recipient, escrow, depositId, paymentMethod,
releaseAmount, netAmount, data, extensionData, isManualRelease }`. O4 reads intent fields before pruning:
`taker = intent.owner`, `recipient = intent.to`, and `data = intent.data`; `depositor = deposit.depositor`
and `token = address(deposit.token)` come from its pre-unlock deposit read. The hook retains escrow/depositId
for whitelist checks and passes depositor/token and the intent identities and amounts to the policy's
`onIntentSettled(SettleParams)`, including the attested `uint64 riskWindow` and `bypass` set only for
whitelisted takers. A whitelisted taker means the deposit/payment-method whitelist is enabled and
`isTakerAllowed` returns true for the taker, not the recipient. Registered relayer takers follow the same
rule: relayer registration alone does not bypass collateral. The hook does not query the relayer registry;
O4 still uses it for its own admission gating. Whitelist state is read live at settlement. Disabling it or
removing the taker after signal restores collateral for nonzero windows. Manual release and window zero
return pay now without calling the policy; zero-window settlement still validates conditions.

Lanes 45/46 use bypass batch manifest version 6, which omits fresh-policy windows and admissions pause.
Historical O3 predecessor checks remain separate; old manifest versions are rejected.

DisputeProtectionPolicyV2 has no signal/cancel records, per-method windows, admissions pause, or
per-deposit opt-outs. It uses the supplied depositor and token without reading escrow. A non-stake-token
deposit pays now with no record or policy event. Whitelist bypass emits `DisputeProtectionIntentSettled`
with source `BYPASS` and no storage writes. Otherwise the policy snapshots the attested window, locks gross
stake (`STAKE`) or defers the net payout (`DEFERRED_PAYOUT`), and sets `releaseEligibleAt = now + window`.
It rejects windows above its `MAX_RISK_WINDOW` (180 days) as defence in depth. Statuses remain `NONE`,
`AWAITING_FUNDING`, `SETTLED`, `RELEASED`, and `DISPUTED`. Collateral ordinals remain `NONE=0`, `BYPASS=1`,
`STAKE=2`, `DEFERRED_PAYOUT=3`; `MANUAL_RELEASE` is removed. The settled event includes all participant
identities, method, window, collateral source, stake owner, amounts and eligibility time, with no manual
flag. O4's `IntentFulfilled` carries `isManualRelease`. Only matured collateral releases emit
`DisputeProtectionIntentReleased`. No Opened or Cancelled event is emitted.

IntentLifecycleHookV2 reads `bytes32(data)`: clients send empty data for no conditions or
`abi.encodePacked(conditionsHash)` for a raw 32-byte hash. Empty and all-zero data are unconditioned;
shorter data is right-padded and longer data uses its first word, with no length or version decoding.
The conditions version belongs inside the attestor-side hash preimage. Each intent's data is interpreted
only by its snapshotted hook. After the whitelist admission check, a nonzero hash requires a
gating service (`ConditionsRequireGatingService`); O4 separately requires a gating service for any
non-empty data and verifies its signature covering the data hash. Settlement compares extension word 1
with the expected hash symmetrically, unless manually released. A mismatch reverts with
`ConditionsNotAttested(intentHash)`. IIntentLifecycleHookV2 contains only the four lifecycle callbacks:
`onIntentSignaled`, `onIntentCancelled`, `settleIntent` and `onDeferredPayoutFunded`. Its ERC-165
interface id is the XOR of exactly those four selectors; O4 validates it when configuring the hook.

O4's ERC-165 guard rejects a wrong hook with `InvalidLifecycleHook` at configuration time.
A V1 hook would otherwise revert at signal without stranding an intent. Conversely, the V2-only
`onIntentSignaled(bytes32,bytes)` and `SettlementContext` selectors prevent OrchestratorV3 from
successfully signaling or snapshotting IntentLifecycleHookV2. The shared `onIntentCancelled(bytes32)`
selector is only called for intents snapshotted with that hook.
The V2 hook requires orchestrator-registry membership, without querying the caller's ERC-165 support.
Registration is a governance assertion that the orchestrator honours the deferral vault returned
by `settleIntent`. The hook still implements ERC-165 for O4's configuration-time check.

The cross-repo attestor smoke remains gated by `ATTESTOR_POLICY_SMOKE_ROOT`. Its expected signed payload
contains a dispute window in word 0: zero for pay now and the attested window for protected settlements.

### O4 lifecycle hook data

`signalIntent(params)` uses its final `bytes data` field as opaque lifecycle hook data.
O4 stores and forwards these bytes without interpreting them. Non-empty data requires a current hook
(`LifecycleHookDataRequiresHook`) and a gating service for the deposit's payment method
(`LifecycleHookDataRequiresGatingService`). O4 appends the 32-byte `keccak256(data)` to
the existing 336-byte packed gating message (368 bytes total) and verifies the service's signature.
Empty bytes mean no hook data, need no gating service and preserve the plain V3 gating message byte-for-byte.
The field changes O4's calldata selector and ERC-165 interface id.
`getIntent(intentHash).data` exposes the bytes until fulfillment, manual release, cancellation,
escrow pruning or orphan cleanup. O4 never executes a post-intent hook.

The stateless IntentLifecycleHookV2 reads the conditions hash directly as `bytes32(data)`.
Clients send `abi.encodePacked(conditionsHash)` (32 bytes) or empty data. Empty and all-zero data mean
no conditions; shorter data is right-padded and longer data uses its first word. There are no length or
version checks. A nonzero hash requires a deposit gating service even for whitelisted takers, while O4
requires one for all non-empty data. All per-intent storage belongs to O4; read the data from
`getIntent(intentHash)` and interpret it according to that intent's snapshotted hook.

UPV4's signed extension word 0 is `disputeWindow` in seconds; word 1 is the attested conditions hash.
A non-manual settlement requires word 0 and rejects windows above 180 days. Word 1 defaults to zero
when incomplete and must equal the hash read from the pre-prune hook data forwarded by O4, including
when the window is zero. `ConditionsNotAttested(intentHash)` rolls back the entire fulfillment on
mismatch; empty hook data rejects a nonzero attested hash. Words 2+ are ignored. Manual release ignores
the extension and conditions and pays now without calling the policy. The replaceable hook owns both
interpretations.

The conditions version lives inside the attestor-side preimage. Off-chain convention v1 is
`conditionsHash = keccak256(abi.encode(uint8(1), salt, payerIdHash))`,
where `salt` and `payerIdHash` are both `bytes32`.
Use a cryptographically random salt for each intent so phone-number UPI IDs cannot be
brute-forced from the public hash. Keep the salt off-chain with the conditions supplied to
the gating service and attestor.
