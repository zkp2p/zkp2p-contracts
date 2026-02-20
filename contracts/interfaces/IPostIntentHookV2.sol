// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IPostIntentHookV2
 * @notice V2 interface for post-intent hooks with structured execution context.
 */
interface IPostIntentHookV2 {
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
     * @notice Post-intent hook
     * @param _ctx The execution context built from intent + fulfill state
     * @param _fulfillHookData The data passed to fulfillIntent for the hook
     */
    function execute(
        HookExecutionContext calldata _ctx,
        bytes calldata _fulfillHookData
    ) external;
}
