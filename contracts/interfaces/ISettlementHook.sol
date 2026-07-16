// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title ISettlementHook
 * @notice Interface for actions that atomically consume an intent's net settlement proceeds.
 */
interface ISettlementHook {
    struct HookIntentContext {
        address owner;
        address to;
        address escrow;
        uint256 depositId;
        uint256 amount;
        uint256 timestamp;
        bytes32 paymentMethod;
        bytes32 fiatCurrency;
        uint256 conversionRate;
        bytes32 payeeId;
        bytes signalHookData;
    }

    struct HookExecutionContext {
        bytes32 intentHash;
        address token;
        uint256 executableAmount;
        HookIntentContext intent;
    }

    /**
     * @notice Executes a settlement action.
     * @param _ctx The execution context built from intent + fulfill state
     * @param _settlementHookData Fulfillment-time data supplied for the settlement action
     */
    function execute(
        HookExecutionContext calldata _ctx,
        bytes calldata _settlementHookData
    ) external;
}
