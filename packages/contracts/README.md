# @zkp2p/contracts-v2

Official npm package source for ZKP2P smart contract interfaces, ABIs, addresses, and utilities.

> **Release status:** the latest npm release is `0.3.0`, published before the merged affine-risk and
> direct-chargeback source changes. It does not contain the new `abis/contracts` or `utils/riskMath`
> exports described under [Unpublished Source Exports](#unpublished-source-exports). Do not use the
> source manifest's unchanged `0.3.0` version as evidence that those paths are available from npm.

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

// Import TypeScript types
import type { Escrow, Orchestrator } from "@zkp2p/contracts-v2/types"

// Import utility functions
import { getKeccak256Hash, calculateIntentHash } from "@zkp2p/contracts-v2/utils/protocolUtils"

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


## API Reference

### Package Structure

The package follows modern ESM/CJS patterns with clean subpath exports:

```
@zkp2p/contracts-v2/
├── addresses/          # Network-specific contract addresses
├── abis/              # Network-specific contract ABIs  
├── constants/         # Protocol constants per network
├── paymentMethods/    # Payment method configurations
├── types/             # TypeScript type definitions
└── utils/             # Utility functions
```

### Import Patterns

All modules are directly accessible via subpath exports:

- `@zkp2p/contracts-v2/addresses` - Contract addresses for all networks
- `@zkp2p/contracts-v2/abis/<network>` - Contract ABIs per network (e.g., `/abis/baseStaging`)
- `@zkp2p/contracts-v2/abis/<network>/<contract>.json` - Direct JSON import for specific contracts
- `@zkp2p/contracts-v2/constants/<network>` - Constants per network
- `@zkp2p/contracts-v2/paymentMethods` - Payment method configs
- `@zkp2p/contracts-v2/utils/protocolUtils` - Protocol utilities
- `@zkp2p/contracts-v2/types` - TypeScript types

## Unpublished Source Exports

The current repository source builds additional exports for the merged v3 architecture:

- `@zkp2p/contracts-v2/abis/contracts`: source ABIs for `OrchestratorV3`, `RiskManager`, `StakeVault`,
  and `DeferredPayoutHook`, independent of a network deployment.
- `@zkp2p/contracts-v2/utils/riskMath`: exact `bigint` helpers for reusable-base subtraction, excess-only
  griefing reservation, hybrid deferred fee-gap reservation, capacity, and cancellation penalties.

These paths are development source until a later package version is built, validated, and published.
They must not be imported from npm `0.3.0`. Network-specific v3 address exports describe the recorded
Base staging affine deployment and do not imply that the final hybrid direct-chargeback implementation is live.

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

## Version

Source manifest version: `0.3.0`

Latest npm version: `0.3.0` (does not include the unpublished source exports above)

## Development

### OrchestratorV3 gating-signature migration

`OrchestratorV3` treats a deposit gating signature as a single-intent authorization. The
`SignalIntentParams` tuple is unchanged, but legacy reusable V2 signatures are not valid on V3.
Curator and client signers must:

1. Build the final `SignalIntentParams`, leaving `gatingServiceSignature` empty.
2. Read `getIntentGatingNonce(taker, escrow, depositId, paymentMethod)` if the nonce is needed for
   observability or caching.
3. Call `getIntentGatingMessageHash(params, taker)` on the exact orchestrator that will receive the
   intent.
4. Sign the returned 32-byte hash with EIP-191 `personal_sign`/`signMessage` and place the result in
   `gatingServiceSignature`.

The signed hash binds the taker, recipient, amount, escrow, deposit, payment method, fiat currency,
conversion rate, referral fees, settlement hook, pre-intent hook data, persisted signal hook data,
expiry, chain id, verifying orchestrator, and current scoped nonce. A successful gated intent
increments the nonce. Failed transactions roll it back, and deposits without a gating service do not
consume a nonce. Nonces are independent per `(taker, escrow, depositId, paymentMethod)`.

### Build & Publish

From `packages/contracts`:
- `yarn build` – Clean, extract, and bundle package
- `npm pack` – Preview tarball contents
- `npm publish --access public` – Publish (runs prepublishOnly)

Note: The package uses modern module patterns with _esm/, _cjs/, and _types/ folders for optimal compatibility.

## License

MIT

## Links

- [GitHub Repository](https://github.com/zkp2p/zkp2p-contracts)
- [Documentation](https://docs.zkp2p.xyz)
- [Website](https://zkp2p.xyz)
