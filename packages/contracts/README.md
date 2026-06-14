# @zkp2p/contracts-v2

Official npm package for ZKP2P V2 smart contract interfaces, ABIs, addresses, and utilities.

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
import { base, baseSepolia } from "@zkp2p/contracts-v2/addresses"

// Import specific contract ABIs from a network
import { Escrow, Orchestrator } from "@zkp2p/contracts-v2/abis/baseSepolia"

// Import constants
import { USDC, INTENT_EXPIRATION_PERIOD } from "@zkp2p/contracts-v2/constants/base"

// Import payment method configurations
import { baseSepolia as paymentMethods } from "@zkp2p/contracts-v2/paymentMethods"

// Import TypeScript types
import type { Escrow, Orchestrator } from "@zkp2p/contracts-v2/types"

// Import utility functions
import { getKeccak256Hash, calculateIntentHash, encodeDepositAttestors } from "@zkp2p/contracts-v2/utils/protocolUtils"

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
import { base, baseSepolia } from "@zkp2p/contracts-v2/addresses"

console.log(base.Orchestrator);
console.log(base.Escrow);
console.log(baseSepolia.UnifiedPaymentVerifier);
```

Supported networks:
- Base (`base`)
- Base Sepolia (`baseSepolia`)

### 📜 Network-Specific Contract ABIs

Minimal ABIs extracted from on-chain deployments:

```typescript
// Import specific contracts from a network
import { Orchestrator, Escrow } from "@zkp2p/contracts-v2/abis/baseSepolia"

// Use the ABIs directly with ethers or viem
const orchestratorABI = Orchestrator;
const escrowABI = Escrow;

// Alternative: Import all ABIs for a network
import * as baseSepoliaAbis from "@zkp2p/contracts-v2/abis/baseSepolia"
const unifiedVerifierABI = baseSepoliaAbis.UnifiedPaymentVerifier;

// Also supports direct JSON imports for bundle optimization
import EscrowABI from "@zkp2p/contracts-v2/abis/baseSepolia/Escrow.json"
```

### 🔧 Network-Specific Protocol Constants

All protocol parameters and configurations per network:

```typescript
import { INTENT_EXPIRATION_PERIOD, MAX_INTENTS_PER_DEPOSIT, DUST_THRESHOLD } from "@zkp2p/contracts-v2/constants/base"
import * as baseSepoliaConstants from "@zkp2p/contracts-v2/constants/baseSepolia"

// Use specific constants
console.log('Intent expiration:', INTENT_EXPIRATION_PERIOD);
console.log('Max intents:', MAX_INTENTS_PER_DEPOSIT);

// Or access all constants for a network
console.log('USDC address:', baseSepoliaConstants.USDC);
```

### 💳 Payment Methods with Provider Hashes

Unified payment method configurations including provider hashes from deployment:

```typescript
import { base, baseSepolia } from "@zkp2p/contracts-v2/paymentMethods"

// Access payment method configurations
const venmoConfig = base.venmo;
console.log('Payment Method Hash:', venmoConfig.paymentMethodHash);
console.log('Currencies:', venmoConfig.currencies);

// Or use testnet configurations
const testnetPaymentMethods = baseSepolia;
console.log('Available methods:', Object.keys(testnetPaymentMethods));
```

### 🛠️ Utility Functions

Protocol utility functions:

```typescript
// Import protocol utilities
import { getKeccak256Hash, calculateIntentHash, encodeDepositAttestors } from "@zkp2p/contracts-v2/utils/protocolUtils"

// Use utility functions
const paymentMethodHash = getKeccak256Hash("venmo");
const intentHash = calculateIntentHash(depositor, depositId, signalIntentParams);

// Encode additional deposit attestors for DepositPaymentMethodData.data.
// MultiAttestationVerifier appends these to the default witness set, so either
// defaults or added attestors can satisfy the combined threshold.
const verificationData = encodeDepositAttestors([attestorAddress], 1);
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
- `@zkp2p/contracts-v2/abis/<network>` - Contract ABIs per network (e.g., `/abis/baseSepolia`)
- `@zkp2p/contracts-v2/abis/<network>/<contract>.json` - Direct JSON import for specific contracts
- `@zkp2p/contracts-v2/constants/<network>` - Constants per network
- `@zkp2p/contracts-v2/paymentMethods` - Payment method configs
- `@zkp2p/contracts-v2/utils/protocolUtils` - Protocol utilities
- `@zkp2p/contracts-v2/types` - TypeScript types

### Export Format Details

The package now uses explicit wrapper modules for each network to ensure reliable imports across all environments:

```typescript
// Recommended: Import from network-specific wrappers
import { Escrow, Orchestrator } from "@zkp2p/contracts-v2/abis/baseSepolia"

// Alternative: Direct JSON imports for bundle size optimization
import EscrowABI from "@zkp2p/contracts-v2/abis/baseSepolia/Escrow.json"

// CommonJS compatibility
const { Escrow } = require("@zkp2p/contracts-v2/abis/baseSepolia")
```

Each network export provides:
- CommonJS support (`.cjs`)
- ESM support (`.mjs`)
- TypeScript definitions (`.d.ts`)
- Direct JSON file access

## Version

Current version: `0.0.1-rc5`

## Development

### Build & Publish

From `packages/contracts`:
- `yarn build` – Clean, extract, and bundle package
- `npm pack` – Preview tarball contents
- `npm publish --access public` – Publish (runs prepublishOnly)

Note: The package uses modern module patterns with _esm/, _cjs/, and _types/ folders for optimal compatibility.

## License

MIT

## Links

- [GitHub Repository](https://github.com/zkp2p/zkp2p-v2-contracts)
- [Documentation](https://docs.zkp2p.xyz)
- [Website](https://zkp2p.xyz)
