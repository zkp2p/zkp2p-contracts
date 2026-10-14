// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentLifecycleHookV2} from "contracts/interfaces/IIntentLifecycleHookV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract OrchestratorV4Stub {
    mapping(bytes32 => IOrchestratorV4.Intent) internal intents;

    /// @notice Stores canonical intent data for a test.
    function setIntent(bytes32 _intentHash, IOrchestratorV4.Intent calldata _intent) external {
        intents[_intentHash] = _intent;
    }

    /// @notice Returns the stored intent.
    function getIntent(bytes32 _intentHash) external view returns (IOrchestratorV4.Intent memory) {
        return intents[_intentHash];
    }

    /// @notice Reports support for deferred lifecycle settlement.
    function lifecycleHookInterfaceId() external pure returns (bytes4) {
        return type(IIntentLifecycleHookV2).interfaceId;
    }

    /// @notice Calls admission as the registered orchestrator.
    function signal(IIntentLifecycleHookV2 _hook, bytes32 _intentHash) external {
        _hook.onIntentSignaled(_intentHash);
    }

    /// @notice Calls cancellation as the registered orchestrator.
    function cancel(IIntentLifecycleHookV2 _hook, bytes32 _intentHash) external {
        _hook.onIntentCancelled(_intentHash);
    }

    /// @notice Calls settlement as the registered orchestrator.
    function settle(IIntentLifecycleHookV2 _hook, IIntentLifecycleHookV2.SettlementContext calldata _context)
        external returns (address)
    {
        return _hook.settleIntent(_context);
    }

    /// @notice Calls deferred funding as the registered orchestrator.
    function fund(IIntentLifecycleHookV2 _hook, bytes32 _intentHash) external {
        _hook.onDeferredPayoutFunded(_intentHash);
    }
}
