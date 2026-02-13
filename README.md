# zkp2p-v2-contracts (v2.1)

[![Coverage](https://codecov.io/gh/zkp2p/zkp2p-v2-contracts/branch/main/graph/badge.svg?precision=2)](https://codecov.io/gh/zkp2p/zkp2p-v2-contracts)

V2.1 smart contracts for the ZK P2P fiat on/off‑ramp. The system centers on Escrow (maker deposits), Orchestrator (intent lifecycle and verification), and a Unified Payment Verifier that validates off‑chain attestations for multiple payment methods.

## Overview

ZKP2P is a decentralized protocol enabling trustless peer-to-peer exchanges between fiat and cryptocurrency. Users can on-ramp (buy crypto with fiat) or off-ramp (sell crypto for fiat) directly with counterparties, without intermediaries.

### Key Features
- **Trustless P2P Trading**: Direct fiat-to-crypto exchanges without intermediaries
- **Multi-Platform Support**: Venmo, PayPal, Wise, Zelle, CashApp, Revolut, MercadoPago, Monzo
- **Zero-Knowledge Privacy**: Payment verification without exposing sensitive data
- **Intent-Based Architecture**: Efficient liquidity matching and settlement
- **Modular Design**: Pluggable verifiers and extensible registry system

### Use Cases
- **On-ramp**: Buy USDC with fiat through verified payment platforms
- **Off-ramp**: Sell USDC for fiat with guaranteed settlement
- **Cross-border**: Access global liquidity through multiple payment rails

## Quick Start
- Prereqs: Node 18+, Yarn 4, Foundry (for `forge`).
- Install: `yarn`
- Env: `cp .env.default .env` and set keys (`ALCHEMY_API_KEY`, `BASE_DEPLOY_PRIVATE_KEY`, `TESTNET_DEPLOY_PRIVATE_KEY`, `BASESCAN_API_KEY`, `ETHERSCAN_KEY`, `INFURA_TOKEN`).
- Local node: `yarn chain`
- Deploy locally: `yarn deploy:localhost`

## Supported Networks

| Network | Status | Contract Addresses |
|---------|--------|-------------------|
| Base | ✅ Production | [View Deployments](./deployments/base/) |
| Base Sepolia | ✅ Testnet | [View Deployments](./deployments/base_sepolia/) |
| Base Staging | 🔧 Staging | [View Deployments](./deployments/base_staging/) |


## Commands
- Build: `yarn build` (clean → compile → typechain → tsc)
- Compile: `yarn compile`
- Tests (Hardhat): `yarn test` | fast: `yarn test:fast`
- Tests (Foundry): `yarn test:forge` | fuzz: `yarn test:forge:fuzz` | invariant: `yarn test:forge:invariant`
- Coverage: `yarn coverage` | Foundry: `yarn test:forge:coverage`
- Deploy: `yarn deploy:base` | `yarn deploy:base_sepolia`
- Verify: `yarn etherscan:base` | `yarn etherscan:base_sepolia`

## Architecture (v2.1)

### Core Components

**Escrow Contract**
- Manages liquidity deposits from makers (liquidity providers)
- Configures supported payment methods, currencies, and conversion rates
- Enforces intent limits, expiry periods, and dust thresholds
- Handles secure fund custody and transfers
- Collects maker fees on successful trades

**Orchestrator Contract**
- Central coordinator for the intent lifecycle
- Validates intent gating signatures (optional access control)
- Locks/unlocks funds on Escrow during intent processing
- Routes verification requests to appropriate verifiers via registry
- Collects and distributes protocol/referrer fees
- Executes optional post-intent hooks for custom logic

**Across post-intent hook notes**
- `AcrossBridgeHook` (v1) bridges directly through `depositNow` and falls back to a local USDC transfer on failure.
- `AcrossBridgeHookV2` keeps the same fallback behavior for bridge-only mode and adds optional `SWAP_AND_BRIDGE`.
- V2 swap mode trusts an allowlisted `exchange` and the configured `spokePoolPeriphery` for route execution.
- Worst-case behavior is still a fallback transfer back to `intent.to` in USDC on source chain.

**Unified Payment Verifier**
- Single contract supporting all payment methods via configuration
- Validates EIP-712 signed attestations from off-chain services
- Enforces timestamp buffers for L2 flexibility
- Nullifies payments in registry to prevent double-spending

**Registry System**
- `PaymentVerifierRegistry`: Maps payment methods to verifiers and currencies
- `EscrowRegistry`: Whitelists valid escrow implementations
- `RelayerRegistry`: Authorizes relayers for gasless transactions
- `PostIntentHookRegistry`: Manages approved post-intent hooks
- `NullifierRegistry`: Tracks used payment proofs globally

**Protocol Viewer**
- Read-only contract aggregating Escrow + Orchestrator state
- Optimized for frontend queries and analytics
- Provides batched data fetching for UI performance

### User Flow

1. **Deposit Phase**: Maker creates deposit with USDC, specifying accepted payment methods and rates
2. **Intent Phase**: Taker signals intent to trade, temporarily locking maker's liquidity
3. **Payment Phase**: Taker sends fiat payment off-chain through specified platform
4. **Proof Phase**: Payment receipt is converted to zkTLS proof via attestation service
5. **Verification Phase**: On-chain verification of payment proof and attestation signatures
6. **Settlement Phase**: USDC released to taker, fees distributed, liquidity returned to maker

### Diagram
```
Maker ── createDeposit ──▶ Escrow
Taker/Relayer ── signalIntent ──▶ Orchestrator ── lockFunds ──▶ Escrow
Orchestrator ── getVerifier(paymentMethod) ──▶ PaymentVerifierRegistry ──▶ UnifiedPaymentVerifier
UnifiedPaymentVerifier ── verify(EIP‑712) ──▶ AttestationVerifier
UnifiedPaymentVerifier ── nullify(paymentId) ──▶ NullifierRegistry
UnifiedPaymentVerifier ── result ──▶ Orchestrator
Orchestrator ── unlockAndTransfer ──▶ Escrow ── tokens ──▶ Orchestrator
Orchestrator ── fees ──▶ Protocol/Referrer
Orchestrator ── net ──▶ Recipient OR PostIntentHook (then executes)
```

## Project Structure
```
contracts/
├── Orchestrator.sol           # Intent lifecycle management
├── Escrow.sol                 # Deposit and liquidity management
├── unifiedVerifier/           # Unified payment verification
│   ├── UnifiedPaymentVerifier.sol
│   └── SimpleAttestationVerifier.sol
├── registries/                # Permission and configuration registries
│   ├── PaymentVerifierRegistry.sol
│   ├── NullifierRegistry.sol
│   └── [other registries]
├── interfaces/                # Contract interfaces
└── lib/                       # Utility libraries

deploy/                        # Deployment scripts (00-09 numbered sequence)
test/                         # Comprehensive test suite
test-foundry/                 # Foundry tests (.t.sol)
deployments/                  # Network deployment artifacts
typechain/                    # Generated TypeScript bindings
```

## Integration Examples

### Creating a Deposit (Maker)
```typescript
import { Escrow } from "@typechain/Escrow";

// Create deposit with payment method configuration
const depositId = await escrow.createDeposit({
  token: USDC_ADDRESS,
  amount: ethers.utils.parseUnits("1000", 6),
  paymentMethods: [paymentMethodHash],
  minAmounts: [ethers.utils.parseUnits("10", 6)],
  conversionRates: [100], // 1:1 rate
});
```

### Signaling Intent (Taker)
```typescript
import { Orchestrator } from "@typechain/Orchestrator";

// Signal intent to trade
await orchestrator.signalIntent({
  escrow: escrowAddress,
  depositId: depositId,
  amount: ethers.utils.parseUnits("100", 6),
  recipient: takerAddress,
  paymentMethod: paymentMethodHash,
  payeeDetails: payeeHash,
  data: additionalData,
});
```

### Fulfilling Intent with Payment Proof
```typescript
// Submit payment attestation for verification
await orchestrator.fulfillIntent({
  intentHash: intentHash,
  paymentProof: attestationBytes, // EIP-712 signed attestation
  data: verificationData,
});
```

## Testing

The project includes comprehensive test coverage:

### Test Suites
- **Unit Tests**: Individual contract function testing
- **Integration Tests**: End-to-end user flow validation
- **Fuzz Tests**: Property-based testing with Foundry
- **Invariant Tests**: Protocol invariant verification

### Running Tests
```bash
# Run all Hardhat tests
yarn test

# Run specific test suites
yarn test test/escrow/
yarn test test/orchestrator/
yarn test test/unifiedVerifier/

# Foundry tests
yarn test:forge              # All Foundry tests
yarn test:forge:fuzz         # Fuzz testing
yarn test:forge:invariant    # Invariant testing

# Coverage reports
yarn coverage                # Hardhat coverage
yarn test:forge:coverage     # Foundry coverage
```

## Resources

- **Website**: [zkp2p.xyz](https://zkp2p.xyz)
- **Documentation**: [docs.zkp2p.xyz](https://docs.zkp2p.xyz)
- **GitHub**: [github.com/zkp2p](https://github.com/zkp2p)

## License
MIT
