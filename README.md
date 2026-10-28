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

Use the familiar names below when discussing the production stack. The public package exports those same
canonical names; deployment artifacts retain the longer method-scoped names. All four are current production
components, and each pair refers to one deployed contract:

| Familiar / package name | Deployment artifact name | Base production address |
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

The whitelist policy configures enforcement and allowed groups per deposit/payment-method tuple. Direct taker
allowlisting is deposit-wide: an allowlisted taker passes every enabled payment-method tuple for that deposit.
`AddressGroupRegistry` supplies curator-managed group membership. The lifecycle hook applies the selected
whitelist/dispute policy at intent admission and settlement. `DisputeVerifier` and `DisputeNullifierRegistry`
support dispute verification and replay protection; `IntentGuardian` supports configured intent extensions.

### Intent admission

Production whitelisting uses `WhitelistPolicy` through `IntentLifecycleHookV1`. OrchestratorV3 separately
checks the gating-service signature configured on each escrow deposit/payment method. Neither path requires
the old `WhitelistPreIntentHook` or `SignatureGatingPreIntentHook` deployment; those two are outside the current
production stack.

OrchestratorV3 retains a generic optional per-deposit pre-intent-hook interface. On 23 October 2026, the production
indexer returned no O3 `DepositPreIntentHookSet` events. Its 248 non-null legacy whitelist-hook deposit records
were also checked directly against O3 at Base block **52975146**: every `getDepositPreIntentHook` result was zero.
Legacy indexed hook fields therefore must not be interpreted as current O3 admission policy.

### Registries and pricing

- `EscrowRegistry`, `OrchestratorRegistry`, `PaymentVerifierRegistry` and `RelayerRegistry` define the
  authorized settlement participants and verification routes.
- `NullifierRegistryV2` is the current payment-nullifier writer registry. It still reads
  `NullifierRegistry` for replay protection; that read dependency remains part of production.
- `RateManagerV1` supplies delegated rates. `EscrowV2` applies the configured deposit floor and oracle
  constraints. `ChainlinkOracleAdapter` reads configured Chainlink-compatible feeds.
- `FxRateStore`, `FxRateFeedInrUsd` and `FxRateFeedCnyUsd` provide the protocol's INR/USD and CNY/USD feeds.
- `ProtocolViewerV2` remains a read helper in the retained stack. `PythOracleAdapter` is retained as an adapter
  component; this inventory does not assert that a current deposit uses it. The current indexer supports
  Chainlink-compatible feeds and has removed Pyth indexing.

## Settlement flow

1. A maker creates and funds an `EscrowV2` deposit with payment methods, currencies and pricing rules.
2. A taker signals an intent through `OrchestratorV3`. Registry authorization and the selected lifecycle
   policy govern admission; the escrow locks the corresponding funds.
3. The taker completes the fiat payment and obtains the required attestation.
4. `UnifiedPaymentVerifierV3` verifies the payment and checks the nullifier history. Successful settlement
   transfers the locked funds and applies fees and the snapshotted lifecycle callbacks. Referral and manager-fee
   terms are captured at signaling; the protocol fee and its recipient are read from current configuration at fulfillment.
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

- Node.js 22.23.4 (the version pinned in CI)
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
- `BASE_DEPLOYER_KEY` (production signer `0x41123d6419C7b8e44157f6F3b0088442116641eC`)
- `STAGING_DEPLOYER_KEY` (staging signer; no production-key fallback)
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

### Base staging ownership

Base staging uses Base mainnet, chain ID **8453**, with signer
[`0x41123d6419C7b8e44157f6F3b0088442116641eC`](https://basescan.org/address/0x41123d6419C7b8e44157f6F3b0088442116641eC).
`base_staging` loads only `STAGING_DEPLOYER_KEY`, accepting the key with or without a `0x` prefix. If it is unset,
the account list is empty. Production `base` uses the same signer via `BASE_DEPLOYER_KEY`, with the same prefix
handling and no deployer account when unset. Delete `BASE_DEPLOY_PRIVATE_KEY` from the environment; config loading
rejects it. Its former signer `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929` was compromised on 2026-10-28,
is retired, and must never sign again.

Use this signer for future staging deployments and as the owner of every ownable component in the
current staging stack. Historical contracts outside that stack do not need to migrate.

At Base block **52976468** (23 October 2026), all **21 ownable contracts** in the supported V3 stack
and seven passive V4 candidates report the dedicated signer as owner. The remaining eight components have no
contract-wide `owner()` interface. The nine outstanding ownership transfers are complete, with successful receipts,
`OwnershipTransferred` events and owner readbacks; all 20 checked address/boolean configuration getters stayed
unchanged. The handoff spans [the EscrowV2 transfer](https://basescan.org/tx/0x99c29550534a6db39d7b3dd78b4d2eaf35e4bd2e3de3dee8239d4ed0c656dd68) through
[the RateManagerV1 transfer](https://basescan.org/tx/0x9ba1f506cb1aa96d5dfd38abf8c06bbca6dc43609f3990cd7cc174ff2b6bf145).

#### Supported staging V3 stack

This is the retained staging integration inventory. Familiar lifecycle names and exact deployment aliases are
shown together. Superseded staging deployments are excluded.

| Contract / familiar name | Deployment artifact | Base staging address |
| --- | --- | --- |
| `EscrowV2` | `EscrowV2` | [`0x77e8f808FE201075e0bD651CD46fdF239fc83265`](https://basescan.org/address/0x77e8f808FE201075e0bD651CD46fdF239fc83265) |
| `OrchestratorV3` | `OrchestratorV3` | [`0x2b5E8Ab562e45fA89D73802605E145ED3E3EeF4f`](https://basescan.org/address/0x2b5E8Ab562e45fA89D73802605E145ED3E3EeF4f) |
| `UnifiedPaymentVerifierV3` | `UnifiedPaymentVerifierV3` | [`0x4c62E99649c8Ba745E67018f5c8a483D77c429C4`](https://basescan.org/address/0x4c62E99649c8Ba745E67018f5c8a483D77c429C4) |
| `MultiAttestationVerifier` | `MultiAttestationVerifier` | [`0x9855a39aC5975069632e91160d8712CBfF19e864`](https://basescan.org/address/0x9855a39aC5975069632e91160d8712CBfF19e864) |
| `IntentLifecycleHookV1` | `IntentLifecycleHookV1MethodScopedStaked` | [`0x5A7f6cb7397134da1fDEFA7E2D434b4Cf18E56D9`](https://basescan.org/address/0x5A7f6cb7397134da1fDEFA7E2D434b4Cf18E56D9) |
| `WhitelistPolicy` | `WhitelistPolicyMethodScoped` | [`0xF79aAD1BAaB617fF3Eb299225c80893F22F743Fe`](https://basescan.org/address/0xF79aAD1BAaB617fF3Eb299225c80893F22F743Fe) |
| `DisputeProtectionPolicy` | `DisputeProtectionPolicyMethodScopedStaked` | [`0x484fA07F085eb66bb7C2b649Ea9d5894b2B6681c`](https://basescan.org/address/0x484fA07F085eb66bb7C2b649Ea9d5894b2B6681c) |
| `StakeVault` | `StakeVaultMethodScoped` | [`0x92d7B59E99e1CD2066540Cd2413b8714948b731f`](https://basescan.org/address/0x92d7B59E99e1CD2066540Cd2413b8714948b731f) |
| `DisputeVerifier` | `DisputeVerifier` | [`0x973578148c5Fd49b9f68B50B26066555325AC708`](https://basescan.org/address/0x973578148c5Fd49b9f68B50B26066555325AC708) |
| `DisputeNullifierRegistry` | `DisputeNullifierRegistry` | [`0xE0B05a9655AF0f31E32904267baa50FbC7f217ea`](https://basescan.org/address/0xE0B05a9655AF0f31E32904267baa50FbC7f217ea) |
| `IntentGuardian` | `IntentGuardian` | [`0x3355bb8CEFA54509d244384CFA7f2A71fdb1FDD6`](https://basescan.org/address/0x3355bb8CEFA54509d244384CFA7f2A71fdb1FDD6) |
| `PaymentVerifierRegistry` | `PaymentVerifierRegistry` | [`0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc`](https://basescan.org/address/0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc) |
| `EscrowRegistry` | `EscrowRegistry` | [`0xc545f336eC77E69bf115729acCbf2e557A00ac91`](https://basescan.org/address/0xc545f336eC77E69bf115729acCbf2e557A00ac91) |
| `OrchestratorRegistry` | `OrchestratorRegistry` | [`0xfA6384EB6176cfEC049540526A3d2126C3666d8A`](https://basescan.org/address/0xfA6384EB6176cfEC049540526A3d2126C3666d8A) |
| `RelayerRegistry` | `RelayerRegistry` | [`0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E`](https://basescan.org/address/0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E) |
| `AddressGroupRegistry` | `AddressGroupRegistry` | [`0x54Ff7788Cb42B46FE2F016a65Fd0f654Bb9BcF3D`](https://basescan.org/address/0x54Ff7788Cb42B46FE2F016a65Fd0f654Bb9BcF3D) |
| `NullifierRegistryV2` | `NullifierRegistryV2` | [`0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C`](https://basescan.org/address/0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C) |
| `NullifierRegistry` | `NullifierRegistry` | [`0x3FFd04f7909a16d3476263A1f4ce413A089dCc69`](https://basescan.org/address/0x3FFd04f7909a16d3476263A1f4ce413A089dCc69) |
| `RateManagerV1` | `RateManagerV1` | [`0x9d773Af159538369b4842e40510562016E3eD3d7`](https://basescan.org/address/0x9d773Af159538369b4842e40510562016E3eD3d7) |
| `ChainlinkOracleAdapter` | `ChainlinkOracleAdapter` | [`0xA3dBea0fCc742bF2eF32BB38E0D94e6AF0A6eDD6`](https://basescan.org/address/0xA3dBea0fCc742bF2eF32BB38E0D94e6AF0A6eDD6) |
| `PythOracleAdapter` | `PythOracleAdapter` | [`0xaa2bBDa3072bD37af76613846268Ec48bd0bB885`](https://basescan.org/address/0xaa2bBDa3072bD37af76613846268Ec48bd0bB885) |
| `ProtocolViewerV2` | `ProtocolViewerV2` | [`0x5079E5aD9aF58E0B7F512C977720106A1494f684`](https://basescan.org/address/0x5079E5aD9aF58E0B7F512C977720106A1494f684) |

`NullifierRegistryV2` still reads the retained `NullifierRegistry` for replay protection. The lifecycle hook,
`AddressGroupRegistry`, oracle adapters and viewer do not have a contract-wide owner. FX feed contracts are shared
with production and are outside this staging ownership handoff.

#### Passive V4 candidates

These seven contracts are deployed but not activated. They remain separate from the supported V3 integration
targets above; their ownership does not establish rollout readiness.

| Candidate | Base staging address |
| --- | --- |
| `StakeVaultV2` | [`0xa33dE1C8eD627fF5D6d94ABaC462A86b315cFb4e`](https://basescan.org/address/0xa33dE1C8eD627fF5D6d94ABaC462A86b315cFb4e) |
| `AddressGroupRegistryV4` | [`0xE138653725e3602d596ae388D2B2FD05ed1148f3`](https://basescan.org/address/0xE138653725e3602d596ae388D2B2FD05ed1148f3) |
| `WhitelistPolicyV2` | [`0xe034B9C59063DBad5F632c38515e75C24F625503`](https://basescan.org/address/0xe034B9C59063DBad5F632c38515e75C24F625503) |
| `DisputeProtectionPolicyV2` | [`0x3C536cD642cF0ca989899D392fb2c41Bff7A94b1`](https://basescan.org/address/0x3C536cD642cF0ca989899D392fb2c41Bff7A94b1) |
| `UnifiedPaymentVerifierV4` | [`0x7b1598b98cAC2930DD8D3174C329416848771748`](https://basescan.org/address/0x7b1598b98cAC2930DD8D3174C329416848771748) |
| `OrchestratorV4` | [`0x7222027313D6D8D7e9BCdD7d2411a228B998C180`](https://basescan.org/address/0x7222027313D6D8D7e9BCdD7d2411a228B998C180) |
| `ProtocolViewerV4` | [`0xEC0131D535160f32601BFca3DfA4B8043eefB56a`](https://basescan.org/address/0xEC0131D535160f32601BFca3DfA4B8043eefB56a) |

The V4 orchestrator, verifier, dispute policy and vault are owned by the dedicated signer. The V4 address-group
registry, whitelist policy and viewer have no contract-wide owner. Deployment and activation remain separate
release steps; this ownership handoff does not resume the paused rollout.

Read each target's live `owner()` and, for two-step ownership, `pendingOwner()` before administrative calls.
The current owner retains authority until acceptance. Preserve governance checks in current wrappers/helpers
and keep executed deployment lanes, constructor arguments and receipts immutable. A historical deployment sender
does not establish current ownership. Fee and dust recipients, registry permissions, group curators, controllers
and other operational roles are separate from ownership and must be checked for the intended action.

Use `yarn deploy:base_staging` through `scripts/deployActive.ts` for an authorized staging deployment.
Signer isolation and these recorded handoffs do not establish release or deployment readiness.
Run `corepack yarn test:staging-signer-config` to verify key selection without loading credentials or broadcasting.

## Security notes

- Follow the active registry, lifecycle and replay-protection wiring when integrating or changing roles.
- Payment replay protection uses `NullifierRegistryV2` and its configured `NullifierRegistry` read dependency.
- Oracle safety depends on adapter validation and escrow-side staleness limits.
- Fees and policy references relevant to an intent must be interpreted using the contract's snapshot rules.
- Source, tests and verified live deployment state govern production changes; this README is an overview.

## License

MIT
