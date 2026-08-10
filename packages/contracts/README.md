# @zkp2p/contracts-v2

Official npm package for ZKP2P V2 smart contract interfaces, ABIs, addresses, and utilities.

## Release 0.4.1-rc.1

- Exports the canonical source ABIs for `DisputeNullifierRegistry`, `DisputeProtectionPolicy`,
  `DisputeVerifier`, `IntentLifecycleHookV1`, and `StakeVault`.
- Hard-cuts unused chargeback deployment aliases and exposes only the canonical `Dispute*` API.
- Requires a complete fresh Base staging dispute stack before the release can be published.
- Keeps `OrchestratorV3` hook activation as a separate governance operation after downstream
  consumers have upgraded.

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

// Import stable source ABIs for the deposit-scoped whitelist policy
import {
  AddressGroupRegistry,
  OrchestratorV3,
  WhitelistLifecycleHook,
  WhitelistPolicy,
} from "@zkp2p/contracts-v2/abis/contracts"

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
- `@zkp2p/contracts-v2/abis/contracts` - Stable source ABIs for approved but not-yet-deployed contracts
- `@zkp2p/contracts-v2/abis/<network>/<contract>.json` - Direct JSON import for specific contracts
- `@zkp2p/contracts-v2/constants/<network>` - Constants per network
- `@zkp2p/contracts-v2/paymentMethods` - Payment method configs
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
