## Summary

This PR implements the **P0 mutability hardening** discussed after PR100/104 planning, to reduce forced redeploy blast radius when `Orchestrator` changes.

### What changed

1. **Unified verifier orchestrator rotation (two-step, delayed)**
- `BaseUnifiedPaymentVerifier` now uses a mutable `orchestrator` pointer with governance-controlled delayed rotation:
  - `scheduleOrchestratorUpdate(address)`
  - `finalizeOrchestratorUpdate()`
- Added:
  - `ORCHESTRATOR_UPDATE_DELAY = 2 days`
  - `pendingOrchestrator`
  - `orchestratorUpdateTimestamp`
  - events: `OrchestratorUpdateScheduled`, `OrchestratorUpdated`
- Preserved security anchor: `nullifierRegistry` remains immutable.

2. **Across hook orchestrator rotation (two-step, delayed)**
- `AcrossBridgeHook` now supports delayed orchestrator rotation:
  - `proposeOrchestrator(address)`
  - `cancelOrchestratorUpdate()`
  - `acceptOrchestrator()`
- Added:
  - `ORCHESTRATOR_UPDATE_DELAY = 1 days`
  - `pendingOrchestrator`
  - `pendingOrchestratorActivationTime`
  - events and custom errors for pending/delay flows
- Preserved immutables: `inputToken` and `spokePool` remain immutable.

3. **ProtocolViewer pointer mutability**
- `ProtocolViewer` now inherits `Ownable` and supports governance pointer updates:
  - `setEscrowContract(address)`
  - `setOrchestrator(address)`
- Added update events and non-zero checks.
- `IProtocolViewer` updated with setter signatures.

4. **Deployment script updates for idempotent pointer sync**
- `deploy/00_deploy_system.ts`
  - transfers `ProtocolViewer` ownership to multisig.
- `deploy/01_deploy_unified_verifier.ts`
  - now runnable on all networks.
  - uses `skipIfAlreadyDeployed: true` and sync logic to schedule/finalize unified verifier orchestrator updates when address drift is detected.
- `deploy/10_deploy_across_bridge_hook.ts`
  - now runnable on all networks.
  - uses `skipIfAlreadyDeployed: true` and sync logic to propose/accept (and cancel stale) across hook orchestrator updates.
- `deployments/helpers.ts`
  - added `callContractAsOwner(...)` utility to execute owner-gated function calls when owner key is available, or print calldata for manual multisig execution.

## Why this helps

Previously, an Orchestrator replacement forced redeploy/re-registration of multiple downstream components due immutable references. With this PR:
- Unified verifier and Across hook can be updated in-place (governance + delay).
- ProtocolViewer can be re-pointed without redeploy.
- Deployment scripts can perform safe pointer reconciliation in repeat runs.

## Files changed

### Contracts
- `contracts/unifiedVerifier/BaseUnifiedPaymentVerifier.sol`
- `contracts/hooks/AcrossBridgeHook.sol`
- `contracts/ProtocolViewer.sol`
- `contracts/interfaces/IProtocolViewer.sol`

### Deploy scripts / helpers
- `deploy/00_deploy_system.ts`
- `deploy/01_deploy_unified_verifier.ts`
- `deploy/10_deploy_across_bridge_hook.ts`
- `deployments/helpers.ts`

### Tests
- `test/unifiedVerifier/baseUnifiedPaymentVerifier.spec.ts`
- `test/unifiedVerifier/unifiedPaymentVerifier.spec.ts`
- `test/hooks/acrossBridgeHook.spec.ts`
- `test/periphery/protocolViewer.spec.ts`
- `test/deploy/00_system.spec.ts`

## Test Plan

### Contract-level suites (targeted)
- `yarn test test/unifiedVerifier/baseUnifiedPaymentVerifier.spec.ts test/unifiedVerifier/unifiedPaymentVerifier.spec.ts test/hooks/acrossBridgeHook.spec.ts test/periphery/protocolViewer.spec.ts`

### Requested end-to-end local deploy validation
1. `yarn chain`
2. `yarn deploy:localhost`
3. `yarn test:deploy --network localhost`

Result:
- `deploy:localhost` completed successfully, including full deployment summary.
- `test:deploy --network localhost` passed.
- Total: **77 passing**.

## Notes / Risk

- Delayed rotation means same-run immediate cutover is not possible for affected contracts unless delay has elapsed.
- Scripts intentionally log/manual-calldata path when multisig owner is not locally unlocked.
- Existing immutable security roots remain unchanged where intended (`chainId`, verifier `nullifierRegistry`).
