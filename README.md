# zkp2p-v2-contracts

[![Coverage](https://codecov.io/gh/zkp2p/zkp2p-contracts/branch/main/graph/badge.svg?precision=2)](https://codecov.io/gh/zkp2p/zkp2p-contracts)

Smart contracts for the Peer/ZKP2P fiat on/off-ramp. The current Base production settlement path is
**EscrowV2 → OrchestratorV3 → UnifiedPaymentVerifierV3**.

Use the current deployment records and package aliases for integrations. Historical deployments are outside
this README's supported production inventory. Their presence in an artifact or an executed deployment lane
does not make them an active integration target.

## Production contracts

### Settlement and verification

| Contract | Role |
| --- | --- |
| `EscrowV2` | Holds maker liquidity, deposit configuration and funds locked for intents. |
| `OrchestratorV3` | Coordinates intent admission, payment verification, fees and settlement. |
| `UnifiedPaymentVerifierV3` | Verifies payment attestations and enforces payment replay protection. |
| `MultiAttestationVerifier` | Checks the configured attestation witnesses and signature threshold. |

### Lifecycle, whitelist and dispute protection

The public package uses short canonical names. The deployment artifacts retain the names of the selected
method-scoped stack. These names refer to the same production addresses:

| Package name | Selected deployment artifact | Base production address |
| --- | --- | --- |
| `IntentLifecycleHookV1` | `IntentLifecycleHookV1MethodScopedStaked` | `0x5Dd6C675a7406fE8C9f0D93394a36fd6e8c50031` |
| `WhitelistPolicy` | `WhitelistPolicyMethodScoped` | `0x389Cd9bA91FfFcd83d267B241E975541892759Ce` |
| `DisputeProtectionPolicy` | `DisputeProtectionPolicyMethodScopedStaked` | `0xbF4B769dB70DBEc89b6b2c44988304a7aD2de4Fc` |
| `StakeVault` | `StakeVaultMethodScoped` | `0x47c26258222e2f96424bD2B21bf173f0DA5034C7` |

The aliases are selected in [active-dispute-stack.json](deployments/active-dispute-stack.json).
At Base block **52974604** (23 October 2026), production OrchestratorV3
(`0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`) selected the hook above. The hook selected the listed
whitelist and dispute policies; the dispute policy selected the listed vault; the vault's controller was
that same dispute policy. OrchestratorV3 was unpaused and dispute admissions were enabled. All 13 registered
payment methods routed to UnifiedPaymentVerifierV3. Recheck current wiring before a live change.

The whitelist policy configures allowed groups and direct takers per deposit/payment-method tuple.
`AddressGroupRegistry` supplies curator-managed group membership. The lifecycle hook applies the selected
whitelist/dispute policy at intent admission and settlement. `DisputeVerifier` and `DisputeNullifierRegistry`
support dispute verification and replay protection; `IntentGuardian` supports configured intent extensions.

### Registries and pricing

- `EscrowRegistry`, `OrchestratorRegistry`, `PaymentVerifierRegistry` and `RelayerRegistry` define the
  authorized settlement participants and verification routes.
- `NullifierRegistryV2` is the current payment-nullifier writer registry. It still reads
  `NullifierRegistry` for replay protection; that read dependency remains part of production.
- `RateManagerV1` supplies delegated rates. `EscrowV2` applies the configured deposit floor and oracle
  constraints. `ChainlinkOracleAdapter` reads configured Chainlink-compatible feeds.
- `FxRateStore`, `FxRateFeedInrUsd` and `FxRateFeedCnyUsd` provide the protocol's INR/USD and CNY/USD feeds.
- Read helpers and per-deposit hooks must be selected from the consumer's configured deployment.
  A package export alone does not establish that a particular helper is used by every production deposit.

## Settlement flow

1. A maker creates and funds an `EscrowV2` deposit with payment methods, currencies and pricing rules.
2. A taker signals an intent through `OrchestratorV3`. Registry authorization and the selected lifecycle
   policy govern admission; the escrow locks the corresponding funds.
3. The taker completes the fiat payment and obtains the required attestation.
4. `UnifiedPaymentVerifierV3` verifies the payment and checks the nullifier history. Successful settlement
   transfers the locked funds and applies the snapshotted fees and lifecycle callbacks.
5. Expired intents are reconciled under the active escrow/orchestrator rules, returning the locked portion
   to available deposit liquidity.

## Repository layout

- `contracts/`: protocol sources, interfaces and shared libraries.
- `deployments/base/`: Base production deployment records.
- `deployments/base_staging/`: staging deployment records; this environment also uses Base mainnet.
- `deployments/active-dispute-stack.json`: current package aliases for lifecycle components.
- `deployments/parameters.ts`: network parameters and governance addresses.
- `deployments/verifiers/`: payment-method provider configuration.
- `scripts/deployActive.ts`: supported deployment runner and lane selection.
- `test-foundry/`: deterministic, fuzz and invariant contract tests.
- `packages/`: published contract package and extraction tooling.

Executed deployment lanes are immutable provenance. Use the supported runner, current wrappers and
repository deployment instructions for an authorized change. Removing obsolete integration guidance does
not change on-chain state, historical ABIs or immutable deployment inputs.

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

## Security notes

- Follow the active registry, lifecycle and replay-protection wiring when integrating or changing roles.
- Payment replay protection uses `NullifierRegistryV2` and its configured `NullifierRegistry` read dependency.
- Oracle safety depends on adapter validation and escrow-side staleness limits.
- Fees and policy references relevant to an intent must be interpreted using the contract's snapshot rules.
- Source, tests and verified live deployment state govern production changes; this README is an overview.

## License

MIT
