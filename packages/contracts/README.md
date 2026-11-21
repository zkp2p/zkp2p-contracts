# @zkp2p/contracts-v2

Official npm package for ZKP2P V2 smart contract interfaces, ABIs, addresses, and utilities.

## O3 retirement in 0.4.4

Release verification expects O4 registered and O3 unregistered on both networks.
The exact post-retirement registry sets are V1 + O4 on Base and V1 + O2 + O4 on
Base staging. Both removals executed on 2026-11-05; the Base one (Safe nonce 94) is tx
`0x85b7c40b779350cdeb6890f84d72375588e1bf930f9fdcd8eeea97aa4ea60dfc`.
Offline build/verification checks the intended state against repository records;
it does not attest that the Safe has executed.

The `disputeStack` manifest keeps its historical O3 runtime identities, governance,
lifecycle, and relayer wiring for compatibility. `expectedRelations.registeredOrchestrator`
and `prerequisites.orchestratorRegistered` refer to current O4; the additive
`expectedRelations.unregisteredOrchestrator` identifies retired O3. In particular,
`activeLifecycleHook`, `orchestratorRelayerRegistry`, and the other lifecycle
prerequisites describe the retained O3 stack, not O4 policies or admission readiness.
O4 has no relayer-registry dependency. O3 source/network ABIs, addresses, and event
decoding remain exported for history, payouts, indexers, and support.

## Release 0.4.4

- Promotes the current OrchestratorV4 package exports to stable, including Base
  and Base staging suite addresses, canonical source ABIs, and one-hour intent expiry.
- Includes the merged O3 retirement metadata: release verification requires O4
  registered and O3 unregistered on both networks. Historical O3 ABIs, addresses,
  and dispute-stack wiring remain available as described above. The executed
  retirement record is maintained separately in [PR #387](https://github.com/zkp2p/zkp2p-contracts/pull/387).
- Targets `latest`, moving it from `0.4.4-rc.14` to `0.4.4`; `rc` remains at
  `0.4.4-rc.14`.

## Release 0.4.4-rc.14

- First npm RC since `0.4.4-rc.6`. Candidates `rc.7`–`rc.13` were local
  tarballs only and are not on npm.
- Package exports are identical to local candidate `0.4.4-rc.13` except Base
  `INTENT_EXPIRATION_PERIOD` is now `3600` (one hour), matching
  `ESCROW_V2_INTENT_EXPIRATION_PERIOD`. Both Base escrows have used this expiry since Safe nonce 89
  executed on 2026-10-30 at block 53,292,327
  ([transaction](https://basescan.org/tx/0x0adea24a0196d04373009c81bf13af0d7c835bc710a7e8d3741bba6537d5caeb)).
  Base staging remains `3600`.
- Includes the Base OrchestratorV4 suite addresses and ABIs recorded on main,
  including `OrchestratorV4` at `0x74c55679268FAfB493864915aD16A320AB8c40Ba`.
- Regenerated `baseContracts.ts` with the canonical export pipeline to restore the 7 Base O4 contract exports missing from main; byte-identical to the rc.13 build (`00e9595`).
- Serves as the pre-0.4.4 baseline for both `latest` and `rc`.

## Candidate 0.4.4-rc.11

- Adds the Base production `UnifiedPaymentVerifierV4` address
  `0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048`, recorded from the 2026-10-28
  deployment (zkp2p-contracts #371). It is Safe-owned and serves the live Base
  `OrchestratorV3`.
- Base O4-stack addresses other than UPV4 stay zero or absent; Base `OrchestratorV4`
  is not deployed. Base staging exports are unchanged from rc.10.
- Like rc.10, this candidate is consumed as a local branch tarball; no npm
  registry tag changes.

## Candidate 0.4.4-rc.10

- Exports the fresh eight-contract passive O4 staging suite recorded in `bb9ceeb`,
  including `IntentSignalPolicy`, with its current deployed ABIs. Base production
  O4-stack addresses remain zero or absent; this package does not activate the suite.
- Exports the 12-field Orchestrator V4 `IntentSignaled` event ending in `groupId`
  and `arbitrator`, and the `AddressGroupRegistry` source ABI with `groupArbitrator`.
- Keeps the October 22 suite under `Historical20261022` aliases with its original
  deployed ABIs. This candidate is consumed as a local branch tarball; no npm
  registry tag changes.

## Candidate 0.4.4-rc.9

- Exports the `IntentSignalPolicy` source ABI and the Orchestrator V4 ABI that
  delegates signal admission to it (gating signature, deposit whitelist, group
  arbitrator). O4 allows multiple concurrent intents for every account.
- Exports the payment verifier V4 ABI whose attested snapshot ends with the
  intent owner.
- Preserves the October 22 staging addresses and deployed ABIs only under
  `Historical20261022` aliases. Current names are absent until the fresh
  eight-contract deployment is recorded. This candidate
  is consumed as a branch tarball; no npm registry tag changes.

## Candidate 0.4.4-rc.8

- Exports the merged Orchestrator V4, ProtocolViewer V4, payment verifier V4,
  WhitelistPolicy V2, DisputeProtectionPolicy V2 and StakeVault V2 source ABIs.
- Preserves executed staging bypass records and October 16 contracts under
  explicit `Historical20261016` aliases with their original deployed ABIs.
- Includes the seven confirmed October 22 staging addresses; the suite remains
  inactive until the contract release gates pass. This candidate
  is consumed as an immutable branch tarball while its PR remains open; no npm
  registry tag is changed by the staging release.

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

Read the Base orchestrator with ethers v5 and the matching network ABI.

```typescript
import { ethers } from "ethers"
import { base } from "@zkp2p/contracts-v2/addresses"
import OrchestratorV4 from "@zkp2p/contracts-v2/abis/base/OrchestratorV4.json" with { type: "json" }

const provider = new ethers.providers.JsonRpcProvider("https://mainnet.base.org")
const orchestrator = new ethers.Contract(base.contracts.OrchestratorV4, OrchestratorV4, provider)
console.log("Protocol fee:", (await orchestrator.protocolFee()).toString())
```

## Features

### 📍 Network-Specific Contract Addresses

Pre-configured addresses for all deployed networks:

```typescript
import { base, baseStaging } from "@zkp2p/contracts-v2/addresses"

console.log(base.contracts.OrchestratorV4);
console.log(base.contracts.EscrowV2);
console.log(baseStaging.contracts.UnifiedPaymentVerifierV4);
```

Supported networks:
- Base (`base`)
- Base staging (`baseStaging`)

### 📜 Network-Specific Contract ABIs

Network ABIs extracted from the recorded deployments:

```typescript
// Import specific contracts from a network
import { OrchestratorV4, EscrowV2 } from "@zkp2p/contracts-v2/abis/baseStaging"

// Use the ABIs directly with ethers or viem
const orchestratorABI = OrchestratorV4;
const escrowABI = EscrowV2;

// Alternative: Import all ABIs for a network
import * as baseStagingAbis from "@zkp2p/contracts-v2/abis/baseStaging"
const unifiedVerifierABI = baseStagingAbis.UnifiedPaymentVerifierV4;

// Also supports direct JSON imports for bundle optimization
import EscrowABI from "@zkp2p/contracts-v2/abis/baseStaging/EscrowV2.json"
```

### 🔧 Network-Specific Protocol Constants

Read the constants object for the selected network:

```typescript
import constants from "@zkp2p/contracts-v2/constants/base"

console.log("Intent expiration:", constants.INTENT_EXPIRATION_PERIOD)
console.log("Max intents per deposit:", constants.MAX_INTENTS_PER_DEPOSIT)
console.log("USDC address:", constants.USDC)
```

### 💳 Payment Methods with Provider Hashes

Unified payment method configurations including provider hashes from deployment:

```typescript
import { base, baseStaging } from "@zkp2p/contracts-v2/paymentMethods"

// Access payment method configurations
const venmoConfig = base.methods.venmo;
console.log('Payment Method Hash:', venmoConfig.paymentMethodHash);
console.log('Currencies:', venmoConfig.currencies);

// Or use staging configurations
const stagingPaymentMethods = baseStaging.methods;
console.log('Available methods:', Object.keys(stagingPaymentMethods));
```

### 🛠️ Utility Functions

This subpath ships TypeScript source that uses ethers v5. Use a build tool that transpiles TypeScript dependencies.

```typescript
import { base } from "@zkp2p/contracts-v2/addresses"
import {
  calculateIntentHash,
  Currency,
  getCurrencyCodeFromHash,
} from "@zkp2p/contracts-v2/utils/protocolUtils"

// Use the counter assigned to the intent on this orchestrator.
const intentHash = calculateIntentHash(base.contracts.OrchestratorV4, 1)
console.log(intentHash, getCurrencyCodeFromHash(Currency.USD))
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

The manifest describes historical O3 dispute wiring. For new integrations use the network’s
`contracts.OrchestratorV4`, `contracts.EscrowV2`, and the O4 policies: `IntentSignalPolicy`,
`WhitelistPolicyV2`, `DisputeProtectionPolicyV2`, `StakeVaultV2` and `AddressGroupRegistryV4`.


## API Reference

### Package Structure

The package follows modern ESM/CJS patterns with clean subpath exports:

```
@zkp2p/contracts-v2/
├── addresses/          # Network-specific contract addresses
├── abis/              # Network-specific contract ABIs
├── constants/         # Protocol constants per network
├── paymentMethods/    # Payment method configurations
├── currencies/         # Currency lookups
├── oracleFeeds/        # Configured price feeds
├── networks/           # Per-network entry points
├── disputeStack/      # Trusted V3 identities and policy expectations
├── types/             # TypeScript type definitions
└── utils/             # Utility functions
```

### Import Patterns

All modules are directly accessible via subpath exports:

- `@zkp2p/contracts-v2/addresses` - Contract addresses for all networks
- `@zkp2p/contracts-v2/abis/<network>` - Contract ABIs per network (e.g., `/abis/baseStaging`)
- `@zkp2p/contracts-v2/abis/contracts` - Source ABIs independent of network deployment
- `@zkp2p/contracts-v2/abis/<network>/<contract>.json` - Direct JSON import for specific contracts
- `@zkp2p/contracts-v2/constants/<network>` - Constants per network
- `@zkp2p/contracts-v2/paymentMethods` - Payment method configs
- `@zkp2p/contracts-v2/disputeStack` - Typed Base production/staging dispute-stack manifests
- `@zkp2p/contracts-v2/disputeStack/<network>.json` - Direct dispute-stack JSON import
- `@zkp2p/contracts-v2/utils/protocolUtils` - Protocol utilities
- `@zkp2p/contracts-v2/types` - TypeScript types

### Export Format Details

The ABI wrapper for each network has an ESM entry point, a CommonJS entry point and TypeScript declarations. For example, a CommonJS consumer can use:

```javascript
const { EscrowV2 } = require("@zkp2p/contracts-v2/abis/baseStaging")
```

## Development

### Build and release

First run `yarn compile` from the repository root to generate the Hardhat artifacts used by extraction.
From `packages/contracts`:
- `yarn build` – Clean, extract, and bundle package
- `yarn test` – Run package tests
- `yarn verify:release` – Verify current ABIs and deployment-address integrity
- `npm pack --dry-run` – Preview tarball contents

Publishing is performed only by the protected GitHub Actions trusted-publishing workflow. It uses npm OIDC and provenance without a long-lived npm token. See [the release runbook](https://github.com/zkp2p/zkp2p-contracts/blob/main/NPM_RELEASE.md).

The package uses modern module patterns with `_esm/`, `_cjs/`, and `_types/` folders for compatibility.

## License

MIT

## Links

- [GitHub Repository](https://github.com/zkp2p/zkp2p-contracts)
- [Documentation](https://docs.peer.xyz)
- [Website](https://peer.xyz)
