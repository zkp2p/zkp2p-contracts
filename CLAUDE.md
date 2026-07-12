# CLAUDE.md

## Project

ZKP2P V2 Contracts -- Solidity 0.8.18 smart contracts for trustless P2P fiat-to-crypto exchange on Base. Off-chain fiat payments (Venmo, PayPal, Wise, Revolut, CashApp, Zelle, MercadoPago, Monzo, N26, Alipay, Chime, Luxon) are verified on-chain via EIP-712 attestations from a zkTLS attestation service, then escrowed USDC is released to the buyer.

## Build and Test

```bash
yarn                              # Install dependencies
yarn compile                      # Compile Solidity
yarn build                        # Clean + compile + typechain + transpile

# Hardhat tests (TypeScript, ethers v5)
yarn test                         # Core test suite
yarn test:fast                    # Skip compilation
npx hardhat test test/escrowV2/*  # Specific suite

# Foundry tests (Solidity)
yarn test:forge                   # All foundry tests
yarn test:forge:fuzz              # Fuzz tests (100 runs)
yarn test:forge:invariant         # Invariant tests
yarn test:forge:fork              # Fork tests (cancun EVM)

# Coverage
yarn coverage                     # Hardhat coverage
yarn test:forge:coverage          # Foundry coverage

# Deploy
yarn deploy:localhost             # Local hardhat node
yarn deploy:base_staging          # Base mainnet (staging deployer)
yarn deploy:base                  # Base mainnet (production)

# Verify
yarn etherscan:base               # Verify on Basescan
yarn etherscan:base_staging
```

## Architecture

Two contract generations coexist. V1 is legacy; V2 is active development.

### Contract Flow (V2)

```
Maker -- createDeposit --> EscrowV2
Taker -- signalIntent --> OrchestratorV2 -- lockFunds --> EscrowV2
                                         -- preIntentHook (optional)
Off-chain: taker pays fiat, gets zkTLS proof, submits to attestation-service
Attestation service signs EIP-712 typed data with payment details
Anyone -- fulfillIntent --> OrchestratorV2 -- verifyPayment --> UnifiedPaymentVerifier
                                           -- nullify(paymentId) --> NullifierRegistry
                                           -- unlockAndTransfer --> EscrowV2 --> USDC to buyer
```

### Core Contracts

| Contract | Purpose |
|----------|---------|
| `EscrowV2.sol` (1565 lines) | Deposit management, fund locking/release, oracle rate support, delegated rate managers |
| `OrchestratorV2.sol` (788 lines) | Intent lifecycle, fee collection (protocol + referrer + manager), pre-intent hooks, whitelist hooks |
| `RateManagerV1.sol` (366 lines) | Delegated rate management for deposits (managers can set rates on behalf of depositors) |
| `ProtocolViewerV2.sol` | Read-only aggregated state queries |
| `UnifiedPaymentVerifier.sol` | Single verifier for all payment methods via EIP-712 attestation signatures |
| `SimpleAttestationVerifier.sol` | Validates zkTLS attestation signatures from authorized witnesses |

### V1 Contracts (Legacy, still deployed)

| Contract | Purpose |
|----------|---------|
| `Escrow.sol` (1113 lines) | Original escrow (V1 deposits still active) |
| `Orchestrator.sol` (594 lines) | Original orchestrator |
| `ProtocolViewer.sol` | V1 viewer |

### Registry System

| Registry | Purpose |
|----------|---------|
| `PaymentVerifierRegistry` | Maps `paymentMethod` bytes32 -> verifier address + supported currencies |
| `EscrowRegistry` | Whitelists escrow contracts (V1 + V2 both registered) |
| `OrchestratorRegistry` | Whitelists orchestrator contracts (used by EscrowV2) |
| `NullifierRegistry` | Prevents payment proof replay; write-gated to verifiers |
| `RelayerRegistry` | Whitelists relayers for gasless tx submission |
| `PostIntentHookRegistry` | Whitelists post-intent hooks (V1 only) |

### Hooks

| Hook | Purpose |
|------|---------|
| `AcrossBridgeHook` / `AcrossBridgeHookV2` | Post-intent hook that bridges released funds via Across |
| `SignatureGatingPreIntentHook` | Pre-intent hook requiring EIP-712 gating signature |
| `WhitelistPreIntentHook` | Pre-intent hook restricting to whitelisted addresses |

### Oracles

| Oracle | Purpose |
|--------|---------|
| `ChainlinkOracleAdapter` | Wraps Chainlink price feeds for deposit rate floors |
| `PythOracleAdapter` | Wraps Pyth price feeds for deposit rate floors |

### Libraries

| Library | Purpose |
|---------|---------|
| `ThresholdSigVerifierUtils` | Threshold signature verification utilities |
| `ReferralFeeLib` | Referral fee validation and hashing (max 50% total, max 5 recipients) |

## Code Layout

```
contracts/
  Escrow.sol, EscrowV2.sol           # Escrow contracts (V1, V2)
  Orchestrator.sol, OrchestratorV2.sol  # Orchestrators (V1, V2)
  RateManagerV1.sol                   # Delegated rate management
  ProtocolViewer.sol, ProtocolViewerV2.sol  # Read-only viewers
  registries/                         # 6 registry contracts
  unifiedVerifier/                    # EIP-712 payment verification
  hooks/                              # Pre/post intent hooks (4 contracts)
  oracles/                            # Chainlink + Pyth adapters
  interfaces/                         # All interfaces (23 files)
  lib/                                # ThresholdSigVerifierUtils, ReferralFeeLib
  external/                           # Array utils (Address, Bytes32, String, Uint256), Across interface
  mocks/                              # 30 mock contracts for testing

test/                                 # Hardhat tests (*.spec.ts)
  escrow/, escrowV2/                  # V1 and V2 escrow tests
  orchestrator/, orchestratorV2/      # V1 and V2 orchestrator tests
  registries/                         # Registry tests
  unifiedVerifier/                    # Verifier tests
  hooks/                              # Hook tests
  rateManager/                        # Rate manager + oracle adapter tests
  periphery/                          # ProtocolViewer tests
  libs/                               # ThresholdSigVerifierUtils tests
  deploy/                             # Deployment script validation tests
  patchCoverage/                      # Targeted coverage gap tests

test-foundry/                         # Foundry tests (*.t.sol)
  fuzz/                               # EscrowCriticalPathFuzz, OrchestratorCriticalPathFuzz, PythOracleAdapterFuzz
  invariant/                          # EscrowInvariant, OrchestratorInvariant, V2RateFlowInvariantSkeleton
  unit/                               # OrchestratorPruneOnSignal, PythOracleAdapter
  fork/                               # AcrossBridgeHookFork

deploy/                               # Hardhat Deploy scripts (NN_description.ts)
  00-13: V1 system + payment methods
  14: V2 system (EscrowV2, OrchestratorV2, OrchestratorRegistry)
  15: V2 periphery (ProtocolViewerV2, hooks)
  16: V2 payment method configuration
  17: Pyth oracle deployment
  18-22: Redeployments (EscrowV2, RateManagerV1, OrchestratorV2, ProtocolViewerV2, UPV V2)
  deploy_summary.ts: Post-deploy address summary

deployments/                          # Network artifacts
  base/                               # Production (chain 8453, 22 contracts)
  base_staging/                       # Staging (chain 8453, separate deployer)
  localhost/                          # Local dev (chain 31337)
  parameters.ts                       # Network-specific config values
  helpers.ts                          # Deployment helper functions
  safeBatchCollector.ts               # Safe multisig batch transaction builder
  verifiers/                          # Payment method provider hashes (12 platforms)
  outputs/                            # Exported contract addresses (JSON/TS)

utils/                                # TypeScript utilities
  deploys.ts                          # DeployHelper class
  protocolUtils.ts                    # Intent hashes, currency constants, ID hashing
  reclaimUtils.ts                     # Proof encoding/parsing
  unifiedVerifierUtils.ts             # Unified verifier test helpers
  constants.ts                        # ADDRESS_ZERO, time constants
  types.ts                            # ReclaimProof, ClaimInfo types
  common/                             # Blockchain, units (ether, usdc)
  test/                               # Account helpers, snapshot mgmt

packages/contracts/                   # @zkp2p/contracts-v2 NPM package (v0.2.0)
archive/                              # Legacy verifier contracts (pre-unified)
tasks/                                # Hardhat custom tasks (etherscan verify with delay)
```

## Testing Patterns

### Subject Pattern (Hardhat)
```typescript
describe("#methodName", () => {
  let subjectCaller: Account;

  beforeEach(async () => { subjectCaller = user; });

  async function subject(): Promise<any> {
    return contract.connect(subjectCaller.wallet).methodName(params);
  }

  it("should do X", async () => {
    await subject();
    expect(await contract.state()).to.equal(expected);
  });

  describe("when caller is not authorized", () => {
    beforeEach(async () => { subjectCaller = attacker; });
    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Unauthorized");
    });
  });
});
```

### Snapshot Isolation
```typescript
import { addSnapshotBeforeRestoreAfterEach } from "@utils/test";
addSnapshotBeforeRestoreAfterEach();
```

### Key Utilities
```typescript
import { usdc, ether } from "@utils/common";
import { calculateIntentHash, Currency } from "@utils/protocolUtils";
import { Blockchain } from "@utils/common";
import DeployHelper from "@utils/deploys";
import { getAccounts } from "@utils/test";
```

### Path Aliases
- `@utils/*` -> `utils/`
- `@typechain/*` -> `typechain/`

## Deployment Wiring Order (V2)

1. Deploy registries (reuse V1: NullifierRegistry, PaymentVerifierRegistry, EscrowRegistry, RelayerRegistry)
2. Deploy OrchestratorRegistry (new for V2)
3. Deploy EscrowV2 with OrchestratorRegistry + PaymentVerifierRegistry
4. Deploy OrchestratorV2 with EscrowRegistry + PaymentVerifierRegistry + RelayerRegistry
5. Deploy UnifiedPaymentVerifierV2 with OrchestratorRegistry + NullifierRegistry + SimpleAttestationVerifier
6. Register OrchestratorV2 in OrchestratorRegistry
7. Register EscrowV2 in EscrowRegistry
8. Add NullifierRegistry write permission for UnifiedPaymentVerifierV2
9. Configure payment methods on UnifiedPaymentVerifierV2
10. Transfer ownership to multisig

## Networks

| Network | Chain ID | USDC | Intent Expiry | Max Intents |
|---------|----------|------|---------------|-------------|
| Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 hours | 200 |
| Base Staging | 8453 | same | 1 hour | 200 |
| Localhost | 31337 | mock | 24 hours | 100 |

## Key Addresses

- **Multisig / Fee Recipient**: `0x0bC26FF515411396DD588Abd6Ef6846E04470227` (Base mainnet)
- **Witness (prod staging)**: `0x4ab950AE1e3326578Bf7e643a2031E858aBa2927`
- **Witness (prod)**: `0x5106A86819ED6Bb82c77CcBfC151250E1d369DbA`
- **Pyth (Base)**: `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`
- **Across SpokePool (Base)**: `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64`

## Configuration

- `hardhat.config.ts`: Solidity 0.8.18, optimizer 200 runs, viaIR enabled, ethers v5
- `foundry.toml`: Solidity 0.8.18, optimizer 800 runs, viaIR enabled, fuzz 256 runs, invariant depth 15
- `.env`: `BASE_DEPLOY_PRIVATE_KEY`, `TESTNET_DEPLOY_PRIVATE_KEY`, `ALCHEMY_API_KEY`, `BASESCAN_API_KEY`
- `tsconfig.json`: CommonJS, strict mode, path aliases

## Style

- **Solidity**: 4-space indent, explicit visibility, custom errors (not require strings), NatSpec on external functions
- **Naming**: Contracts `PascalCase`, interfaces `IName`, constants `UPPER_CASE`, state vars `camelCase`
- **TypeScript**: Strict mode, CommonJS, use `@utils` and `@typechain` aliases
- **Tests**: `*.spec.ts`, subject pattern, AAA, snapshot isolation
- **Deploy scripts**: `NN_description.ts` prefix ordering
- **Commits**: Conventional format (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`)

## NPM Package

```bash
yarn pkg:extract    # Build + extract deployment artifacts
yarn pkg:build      # Build @zkp2p/contracts-v2 package
```

```typescript
import OrchestratorABI from "@zkp2p/contracts-v2/abis/Orchestrator";
import addresses from "@zkp2p/contracts-v2/addresses";
import { Orchestrator } from "@zkp2p/contracts-v2/typechain";
```

## Agents

| Agent | Description |
|-------|-------------|
| [contracts-developer](.claude/agents/contracts-developer.md) | ZKP2P contracts expert for EscrowV2, payment verifiers, registry system, hook system |
| [security-auditor](.claude/agents/security-auditor.md) | Security auditor using Trail of Bits skills for structured audit workflows |

## Skills

| Skill | Description |
|-------|-------------|
| [zkp2p-contracts-publish](.agents/skills/zkp2p-contracts-publish/SKILL.md) | Bump, build, test, and publish @zkp2p/contracts-v2 to npm |
| [ship-contracts](.claude/skills/ship-contracts/SKILL.md) | Full deployment pipeline: script + tests, local, staging, prod, publish |
| [audit](.claude/skills/audit/SKILL.md) | Security audits: full, differential, or single checks |
