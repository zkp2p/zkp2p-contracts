// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IReferralFee } from "./IReferralFee.sol";

/**
 * @title IPreIntentHook
 * @notice Interface for pre-intent hooks that run during signalIntent.
 */
interface IPreIntentHook {
    struct PreIntentContext {
        address taker;
        address escrow;
        uint256 depositId;
        uint256 amount;
        address to;
        bytes32 paymentMethod;
        bytes32 fiatCurrency;
        uint256 conversionRate;
        IReferralFee.ReferralFee[] referralFees;
        bytes preIntentHookData; // Ephemeral hook-specific data from SignalIntentParams.preIntentHookData
    }

    /**
     * @notice Called by the Orchestrator during signalIntent before state changes.
     * @dev Implementations should revert to reject the incoming intent.
     * @param _ctx Incoming intent context.
     */
    function validateSignalIntent(PreIntentContext calldata _ctx) external;
}
