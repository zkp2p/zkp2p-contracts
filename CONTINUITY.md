- Goal (incl. success criteria):
  - Implement a simplified Across swap-and-bridge-only hook using `AcrossSwapBridgeHook` that follows the legacy v1 flow and remove v2-specific code paths from the current system.
  - Keep unit + deploy test coverage for the new hook name.
  - Preserve the existing `AcrossBridgeHook` for backward compatibility.

- Constraints/Assumptions:
  - Preserve `IOrchestrator` execute signature.
  - Keep fallback behavior (revert -> safe fallback transfer) in this request’s simplified hook.
  - Do not touch orchestrator or registry plumbing.

- Key decisions:
  - Deleted v2 files: `AcrossBridgeHookV2` contract, v2 deployment/test scripts, and v2 fork/unit tests.
  - Added new contract `AcrossSwapBridgeHook` with direct `swapAndBridge` flow, plus v1-like validation and fallback.
  - Added dedicated deploy script/test for `AcrossSwapBridgeHook` at deploy index 11.
  - Added fork test variant for swap-and-bridge path.
  - Kept existing `AcrossBridgeHook` (legacy bridge-only) unchanged.
  - Documented permissionless fulfillment limitation directly in `AcrossSwapBridgeHook` docs:
    - Hook assumes orchestrator mediates execution and does not authenticate fulfill caller identity.
  - Current `AcrossSwapBridgeHook` commit surface was expanded to include swap execution fields from Across `swapAndBridge`.
  - User requests both min guardrails be user-committed: `minOutputAmount` and `minExpectedInputTokenAmount` should remain fixed at `signalIntent`.

- State:
  - `contracts/hooks/AcrossSwapBridgeHook.sol` added.
  - `deploy/11_deploy_across_swap_bridge_hook.ts` added.
  - `test/hooks/acrossSwapBridgeHook.spec.ts` updated and passing.
  - `test/deploy/11_acrossSwapBridgeHook.spec.ts` added.
  - `test-foundry/fork/AcrossSwapBridgeHookFork.t.sol` updated.
  - Removed:
    - `contracts/hooks/AcrossBridgeHookV2.sol`
    - `deploy/11_deploy_across_bridge_hook_v2.ts`
    - `test/hooks/acrossBridgeHookV2.spec.ts`
    - `test/deploy/11_acrossBridgeHookV2.spec.ts`
    - `test-foundry/fork/AcrossBridgeHookV2Fork.t.sol`

- Now:
  - Repository contains the simplified swap+bridge hook and deploy/test wiring.
  - New hook contract, unit tests, deploy tests, and fork tests are implemented and passing.
  - Fulfill data in `AcrossSwapBridgeHook` is now minimal (`intentHash`, `outputAmount`); all route fields are in commitment.
  - Hook docs now explicitly call out permissionless fulfill limitation and reliance on fallback safety.
  - Decision confirmed: user wants both `minOutputAmount` and `minExpectedInputTokenAmount` committed at signal-time and returned from the quote path into intent data.
  - Updated `AcrossSwapBridgeHook` naming/comments to define committed signal-time payload explicitly.
  - Expanded unit + fork tests to assert committed minima and all route fields are propagated into periphery call data; both targeted test sets pass.

- Next:
  - Keep both minima committed and finalize docs/comments so intent producers persist both fields from API quote response.
  - Optional: run broader suite once for regression confidence.

- Open questions (UNCONFIRMED if needed):
  - None currently.

- Working set (files/ids/commands):
  - /Users/richardliang/Documents/zk/zkp2p-v2-contracts/contracts/hooks/AcrossSwapBridgeHook.sol
  - /Users/richardliang/Documents/zk/zkp2p-v2-contracts/contracts/hooks/AcrossBridgeHook.sol
  - /Users/richardliang/Documents/zk/zkp2p-v2-contracts/deploy/11_deploy_across_swap_bridge_hook.ts
  - /Users/richardliang/Documents/zk/zkp2p-v2-contracts/test/hooks/acrossSwapBridgeHook.spec.ts
  - /Users/richardliang/Documents/zk/zkp2p-v2-contracts/test/deploy/11_acrossSwapBridgeHook.spec.ts
  - /Users/richardliang/Documents/zk/zkp2p-v2-contracts/test-foundry/fork/AcrossSwapBridgeHookFork.t.sol
  - Command run: `cd /Users/richardliang/Documents/zk/zkp2p-v2-contracts && npx hardhat test test/hooks/acrossSwapBridgeHook.spec.ts`
