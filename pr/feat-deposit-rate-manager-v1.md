# Deposit Rate Manager v1 — Delegated Rate Management

## Summary
Enables makers to delegate deposit rate management to on-chain “rate managers” while preserving strong safety guarantees:
- Non‑custodial and permissionless: any manager may register; depositors opt in per‑deposit.
- Guardrails: managers can only raise the effective floor; they cannot undercut a depositor’s own floor.
- Config transparency: fees, hooks, and min‑rate maps are on‑chain and indexable.
- Operationally simple: no global loops; batch writes use arrays‑of‑arrays.

## Goals
- Allow a third‑party strategy (“manager”) to maintain competitive min rates for many deposits.
- Let a manager charge a simple fee on fulfilled amounts (snapshot taken at signal time).
- Provide depositor guarantees (fee cap; floor cannot be reduced; optional opt‑in hook checks).
- Minimize core changes while keeping modularity and future extensibility.

## Out of Scope (v1)
- Tranching and per‑token overrides.
- Time‑delayed fee updates (fee increases are allowed up to maxFee; intents snapshot fee at signal).
- Central factory for managers (registry is sufficient for v1).

## Design Overview
### New Concepts
- Rate Manager: configuration tuple stored in a global permissionless registry, identified by a `bytes32 rateManagerId`.
- Optional Opt‑In Hook: a view‑only hook managers can set to enforce per‑id admission checks during deposit opt‑in.

### IDs & Registry
- IDs are collision‑resistant: `rateManagerId = keccak256(abi.encodePacked(address(registry), nextId))`.
- Registry stores:
  - `manager`, `feeRecipient`, immutable `maxFee`, mutable `fee`, `depositHook`, and metadata `(name, uri)`.
  - Manager‑level minRates: `(paymentMethod, currency) → minRate`.
- Only `manager` can update mutable fields; `fee` is capped by `maxFee`.

### Opt‑In Hook
- Interface: `IDepositRateManagerHook.onDepositOptIn(depositor, escrow, depositId, rateManagerId)` (view).
- Default is none. Example hook `DepositRateManagerHookV1` adds a per‑id minimum liquidity requirement.

### Effective Min Rate Calculation
- Escrow effective min rate = `max(depositorFloor, managerMinRate)`; if manager’s pair is `0`, the pair is disabled.
- Orchestrator must enforce `conversionRate >= effectiveMin` at intent signal.

### Manager Fees
- Manager fee = simple percent (preciseUnits, 1e18 = 100%).
- Snapshot taken at `signalIntent`; emitted via `IntentManagerFeeUpdated(intentHash, feeRecipient, fee)` as the last event of signaling.
- Fulfillment transfers manager fee out of the escrowed release amount.

### Events (Selected)
- Registry: `RateManagerCreated(id, manager, feeRecipient, maxFee, fee, depositHook, name, uri)`.
- Registry: `RateManagerConfigUpdated`, `RateManagerFeeUpdated`, `RateManagerMinRateUpdated`, `RateManagerMinRatesBatchUpdated`.
- Escrow: `DepositRateManagerUpdated(depositId, depositor, rateManagerId)`.
- Orchestrator: `IntentManagerFeeUpdated(intentHash, feeRecipient, fee)` (snapshot).

### No Global Loops
- Batch rate updates use `setMinRatesBatch(bytes32[] paymentMethods, bytes32[][] currencies, uint256[][] minRates)`.
- Indexers update off‑chain state based on events; no on‑chain sweeping.

## Contract Changes
### New
- `contracts/registries/DepositRateManagerRegistryV1.sol`
  - `createRateManager`, `setRateManagerConfig`, `setFee`, `setMinRate`, `setMinRatesBatch`.
  - Views: `isRateManager`, `getRateManager`, `getFeeAndRecipient`, `getDepositHook`, `getMinRate`.
- `contracts/interfaces/IDepositRateManagerRegistryV1.sol`.
- `contracts/hooks/DepositRateManagerHookV1.sol` (+ `contracts/interfaces/IDepositRateManagerHook.sol`).

### Modified
- `contracts/Escrow.sol`
  - Per‑deposit manager link: `depositRateManagerRegistryByDeposit[depositId]` and `depositRateManagerId[depositId]`.
  - New functions: `setDepositRateManager(depositId, registry, rateManagerId)`, `clearDepositRateManager(depositId)`.
  - Views: `getDepositCurrencyMinRate` now merges depositor floor with manager min; `getDepositManagerFee` returns `(recipient, fee)`.
  - Event: `DepositRateManagerUpdated(depositId, depositor, rateManagerId)`.
  - Removed: global default rate manager registry setter/getter.
- `contracts/Orchestrator.sol`
  - Enforces `conversionRate >= effectiveMin` from Escrow.
  - Emits `IntentManagerFeeUpdated` (snapshot) at the end of `signalIntent`.

## Storage & Upgrade Notes
- New Escrow mappings for per‑deposit registry and manager id; no layout break outside those additions.
- Manager IDs are tied to registry address; storing the registry alongside the id ensures upgradability without breaking older deposits.

## Security & Invariants
- Manager cannot reduce a depositor’s effective floor; only raise it.
- `fee <= maxFee` (cap set at creation; depositor sees before opting in).
- Opt‑in hook is view‑only and may revert to reject an opt‑in.
- Registry is permissionless; only the recorded `manager` can mutate their own config.
- Fee changes after signal do not affect already‑signaled intents (snapshot semantics).

## Indexer & API Changes
- Watch `DepositRateManagerUpdated` to link deposit → (registry, rateManagerId).
- For fee snapshots, index `IntentManagerFeeUpdated` emitted on `signalIntent`.
- To render effective min rates: read depositor floor from Escrow and manager min from Registry.

## Frontend/Backend Notes
- On opt‑in: show `(name, uri)`, `fee` and `maxFee`, and any hook‑driven requirements.
- At signal: display effective min rate; persist snapshot fee from the event.
- At fulfill: surface the deducted manager fee.

## Deployment
- `deploy/00_deploy_system.ts` now deploys `DepositRateManagerRegistryV1` alongside existing system contracts.
- No global Escrow link to a default registry; each deposit stores its own registry+id.

## Testing
- Hardhat tests follow repo style: per‑function subjects; readable names; one `it` per revert case.
- New suites:
  - `test/escrow/escrowRateManager.spec.ts` — Escrow manager linking and effective min logic.
  - `test/hooks/depositRateManagerHook.spec.ts` — `DepositRateManagerHookV1` behavior.
  - `test/registry/depositRateManagerRegistryV1.spec.ts` — registry CRUD and batch updates.
  - `test/orchestrator/delegatedRateManagement.spec.ts` — min‑rate enforcement and fee snapshot/transfer.
- Foundry:
  - Fork tests for Across bridge hook updated to accept graceful fallback on Base.

## Limitations & Future Work
- Optional delay/governance constraints on fee increases.
- Manager factories and versioned registries.
- Tranching strategies and richer allocation logic.

## Migration
- Existing deposits remain unaffected until users opt in to a manager.
- Depositors may switch both registry and id later; Escrow persists the chosen pair per deposit.

## Appendix — Events (Reference Names)
- Registry: `RateManagerCreated`, `RateManagerConfigUpdated`, `RateManagerFeeUpdated`, `RateManagerMinRateUpdated`, `RateManagerMinRatesBatchUpdated`.
- Escrow: `DepositRateManagerUpdated`.
- Orchestrator: `IntentManagerFeeUpdated`.
