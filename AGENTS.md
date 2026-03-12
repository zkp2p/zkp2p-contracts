# Repository Guidelines

## Project Structure & Module Organization
- `contracts/`: Solidity sources (0.8.18), plus `interfaces/`, `lib/`, `mocks/`, `unifiedVerifier/`.
- `deploy/`: Hardhat Deploy scripts, ordered `NN_description.ts` (e.g., `00_deploy_system.ts`).
- `test/`: Hardhat + Mocha/Chai tests (`*.spec.ts`) grouped by domain.
- `test-foundry/`: Foundry Solidity tests (`.t.sol`) with `fuzz/` and `invariant/` suites.
- `deployments/`: Network artifacts and exported addresses; update on live deploys.
- `tasks/`: Custom Hardhat tasks (e.g., Etherscan verification with delay).
- `typechain/`, `artifacts/`, `out/`, `dist/`: Generated output; do not edit by hand.

## Architecture Overview (v2.1)
- Core: `Escrow` holds maker deposits and per-deposit config (methods, currencies, min rates, intent limits/expiry); `Orchestrator` manages intents, routes to verifiers, collects protocol/referrer fees; `ProtocolViewer` provides aggregated read views.
- Registries: `PaymentVerifierRegistry` maps `paymentMethod` → verifier + currencies; `EscrowRegistry` whitelists escrows; `RelayerRegistry` whitelists relayers; `PostIntentHookRegistry` whitelists post‑intent hooks; `NullifierRegistry` records consumed nullifiers.
- Unified Verifier: `unifiedVerifier/UnifiedPaymentVerifier.sol` validates EIP‑712 attestations, checks provider hashes and timestamp buffers (from `BaseUnifiedPaymentVerifier`), and nullifies payments.
- Wiring: Deploy registries → deploy `Escrow` → deploy `Orchestrator` with registry addresses → `Escrow.setOrchestrator(...)` → deploy `UnifiedPaymentVerifier` and register it per `paymentMethod` in `PaymentVerifierRegistry` (also set provider hashes/timestamp buffers) → whitelist escrows/hooks/relayers as needed.
- Flow: Maker `createDeposit` on `Escrow` → Taker `signalIntent` on `Orchestrator` (escrow locks funds) → `fulfillIntent` calls method verifier → on success, `Orchestrator` unlocks/transfers from `Escrow`, applies fees, runs optional post‑intent hook.

### Minimal Diagram
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

## Build, Test, and Development Commands
- `yarn`: Install dependencies. Copy env: `cp .env.default .env` then fill keys.
- `yarn compile`: Compile Solidity; generates `artifacts/` and `typechain/`.
- `yarn build`: Clean, compile, and transpile TypeScript to `dist/`.
- `yarn chain`: Start local Hardhat node (no auto-deploy).
- `yarn test`: Run TypeScript unit tests under `test/`.
- `yarn test:fast`: Skip compile for faster iteration.
- `yarn test:forge`: Run Foundry tests in `test-foundry/` (see `foundry.toml`).
- `yarn coverage`: Solidity coverage via `solidity-coverage`.
- Deploy: `yarn deploy:localhost`, `yarn deploy:base`, `yarn deploy:base_sepolia`.
- Verify: `yarn etherscan:base` (and `:base_staging`, `:base_sepolia`).

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

## Security & Configuration Tips
- Never commit secrets. Configure `.env` (`ALCHEMY_API_KEY`, `BASE_DEPLOY_PRIVATE_KEY`, `BASESCAN_API_KEY`, etc.).
- For local dev: import Hardhat Account #0 into your wallet, then `yarn deploy:localhost`.


## Continuity Ledger (compaction-safe)
Maintain a single Continuity Ledger for this workspace in `http://CONTINUITY.md`. The ledger is the canonical session briefing designed to survive context compaction; do not rely on earlier chat text unless it’s reflected in the ledger.

### How it works
- At the start of every assistant turn: read `http://CONTINUITY.md`, update it to reflect the latest goal/constraints/decisions/state, then proceed with the work.
- Update `http://CONTINUITY.md` again whenever any of these change: goal, constraints/assumptions, key decisions, progress state (Done/Now/Next), or important tool outcomes.
- Keep it short and stable: facts only, no transcripts. Prefer bullets. Mark uncertainty as `UNCONFIRMED` (never guess).
- Do not commit `CONTINUITY.md`. Treat it as a local working ledger only, and remove it from git if it ever becomes tracked or staged.
- If you notice missing recall or a compaction/summary event: refresh/rebuild the ledger from visible context, mark gaps `UNCONFIRMED`, ask up to 1–3 targeted questions, then continue.

### `functions.update_plan` vs the Ledger
- `functions.update_plan` is for short-term execution scaffolding while you work (a small 3–7 step plan with pending/in_progress/completed).
- `http://CONTINUITY.md` is for long-running continuity across compaction (the “what/why/current state”), not a step-by-step task list.
- Keep them consistent: when the plan or state changes, update the ledger at the intent/progress level (not every micro-step).

### In replies
- Begin with a brief “Ledger Snapshot” (Goal + Now/Next + Open Questions). Print the full ledger only when it materially changes or when the user asks.

### `http://CONTINUITY.md` format (keep headings)
- Goal (incl. success criteria):
- Constraints/Assumptions:
- Key decisions:
- State:
- Done:
- Now:
- Next:
- Open questions (UNCONFIRMED if needed):
- Working set (files/ids/commands):
