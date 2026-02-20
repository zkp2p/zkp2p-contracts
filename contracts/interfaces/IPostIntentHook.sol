// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOrchestrator } from "./IOrchestrator.sol";

/**
 * @title IPostIntentHook
 * @notice Interface for post-intent hooks
 */
interface IPostIntentHook {

    /**
     * @notice Post-intent hook
     * @param _intent The intent data structure containing all intent information
     * @param _fulfillIntentData The data passed to fulfillIntent
     */
    function execute(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData
    ) external;
}
