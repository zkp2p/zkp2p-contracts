# Repository Guidelines

## Project Structure & Module Organization
- `contracts/`: Solidity sources (0.8.18), plus `interfaces/`, `lib/`, `mocks/`, `unifiedVerifier/`.
- `deploy/`: Hardhat Deploy scripts, ordered `NN_description.ts` (e.g., `00_deploy_system.ts`).
- `test/`: Hardhat + Mocha/Chai tests (`*.spec.ts`) grouped by domain.
- `test-foundry/`: Foundry Solidity tests (`.t.sol`) with `fuzz/` and `invariant/` suites.
- `deployments/`: Network artifacts and exported addresses; update on live deploys.
- `tasks/`: Custom Hardhat tasks (e.g., Etherscan verification with delay).
- `typechain/`, `artifacts/`, `out/`, `dist/`: Generated output; do not edit by hand.

## Staging Deployment Status

- `RiskManager` and `OrchestratorV3` have only been deployed to staging. That staging lane is disposable and may be
  removed, abandoned, or redeployed non-incrementally.
- Write final deployment scripts fresh after the payment-binding and chargeback design stabilizes. Do not treat the
  current staging deployment as immutable production history.
- The payment-verifier cutover is one-way. In the same governance batch, authorize UPV3 on `NullifierRegistryV2`,
  permanently revoke the retired verifier's legacy-registry write permission, and route the shared
  `PaymentVerifierRegistry` to UPV3. Never route a payment method back to the retired verifier: the legacy registry
  cannot observe V2 writes, so a rollback would reopen payment replay.

## Architecture Overview (v2.1)
- Core: `Escrow` holds maker deposits and per-deposit config (methods, currencies, min rates, intent limits/expiry); `Orchestrator` manages intents, routes to verifiers, collects protocol/referrer fees; `ProtocolViewer` provides aggregated read views.
- Registries: `PaymentVerifierRegistry` maps `paymentMethod` → verifier + currencies; `EscrowRegistry` whitelists escrows; `PostIntentHookRegistry` whitelists post‑intent hooks; `NullifierRegistry` records consumed nullifiers. `RelayerRegistry` is retained only for deployed legacy V1 support.
- Unified Verifier: `unifiedVerifier/UnifiedPaymentVerifier.sol` validates EIP‑712 attestations, checks provider hashes and timestamp buffers (from `BaseUnifiedPaymentVerifier`), and nullifies payments.
- Wiring: Deploy registries → deploy `Escrow` → deploy `Orchestrator` with registry addresses → `Escrow.setOrchestrator(...)` → deploy `UnifiedPaymentVerifier` and register it per `paymentMethod` in `PaymentVerifierRegistry` (also set provider hashes/timestamp buffers) → whitelist escrows/hooks as needed. Active V2/V3 orchestrators have no relayer registry dependency.
- Flow: Maker `createDeposit` on `Escrow` → Taker `signalIntent` on `Orchestrator` (escrow locks funds) → `fulfillIntent` calls method verifier → on success, `Orchestrator` unlocks/transfers from `Escrow`, applies fees, runs optional post‑intent hook.

### Minimal Diagram
```
Maker ── createDeposit ──▶ Escrow
Taker ── signalIntent ──▶ Orchestrator ── lockFunds ──▶ Escrow
Orchestrator ── getVerifier(paymentMethod) ──▶ PaymentVerifierRegistry ──▶ UnifiedPaymentVerifier
UnifiedPaymentVerifier ── verify(EIP‑712) ──▶ AttestationVerifier
UnifiedPaymentVerifier ── nullify(paymentId) ──▶ NullifierRegistry
UnifiedPaymentVerifier ── result ──▶ Orchestrator
Orchestrator ── unlockAndTransfer ──▶ Escrow ── tokens ──▶ Orchestrator
Orchestrator ── fees ──▶ Protocol/Referrer
Orchestrator ── net ──▶ Recipient OR PostIntentHook (then executes)
```

## Build, Test, and Development Commands
- `yarn`: Install dependencies. Copy env: `cp .env.default .env` then fill keys.
- `yarn compile`: Compile Solidity; generates `artifacts/` and `typechain/`.
- `yarn build`: Clean, compile, and transpile TypeScript to `dist/`.
- `yarn chain`: Start local Hardhat node (no auto-deploy).
- `yarn test`: Run TypeScript unit tests under `test/`.
- `yarn test:fast`: Skip compile for faster iteration.
- `yarn test:forge`: Run Foundry tests in `test-foundry/` (see `foundry.toml`).
- `yarn coverage`: Solidity coverage via `solidity-coverage`.
- Deploy: `yarn deploy:localhost`, `yarn deploy:base`, `yarn deploy:base_staging`.
- Verify: `yarn etherscan:base` and `yarn etherscan:base_staging`.

## Coding Style & Naming Conventions
- Solidity: 4-space indent, explicit visibility, NatSpec for externals. Contracts/Libs `PascalCase`, interfaces `IName`, constants `UPPER_CASE`.
- Solidity: Avoid single-letter local variable names in contracts (e.g., `f`, `r`). Prefer clear names like `fee`, `recipient`, `id`, `registryAddr`.
- TypeScript: strict `tsconfig`, CommonJS; prefer path aliases `@utils/*`, `@typechain/*`. Tests named `*.spec.ts`.
- Scripts: prefix deploy files with two-digit order `NN_` and a concise verb-noun.

## Testing Guidelines
- Unit/integration (Hardhat): place in `test/<area>/*.spec.ts`; run with `yarn test` or a specific glob.
- Foundry: fuzz and invariants in `test-foundry/`; run `yarn test:forge` (e.g., `FOUNDRY_FUZZ_RUNS=100 yarn test:forge`).
- Coverage: `yarn coverage` and `yarn test:forge:coverage`. Keep core paths and revert scenarios covered.
- Do not run coverage unless the user explicitly asks for it. Coverage is heavy in this repo; prefer focused tests by default.

## Commit & Pull Request Guidelines
- Use Conventional Commits where possible: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`.
- PRs: describe scope and rationale, link issues, include test updates, and note deployment impacts (network, addresses). Update `deployments/outputs/*.ts` when applicable.

## Agent Skills

| Skill | Location | Description |
|-------|----------|-------------|
| `zkp2p-contracts-publish` | `.agents/skills/zkp2p-contracts-publish/SKILL.md` | Bump, build, test, verify addresses, and publish `@zkp2p/contracts-v2` to npm |

## Security & Configuration Tips
- Never commit secrets. Configure `.env` (`ALCHEMY_API_KEY`, `BASE_DEPLOY_PRIVATE_KEY`, `BASESCAN_API_KEY`, etc.).
- For local dev: import Hardhat Account #0 into your wallet, then `yarn deploy:localhost`.
