// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IProtocolRiskManager
 * @notice Onchain policy boundary called by the orchestrator for intent lifecycle risk checks.
 */
interface IProtocolRiskManager {
    struct SignalContext {
        bytes32 intentHash;
        address taker;
        address maker;
        address token;
        bytes32 paymentMethod;
        uint256 amount;
    }

    /**
     * @notice Validates and reserves an intent without imposing an amount or intent-count cap.
     * @return feeDiscountBps Percentage discount applied to the protocol fee (10_000 = 100%).
     */
    function onIntentSignaled(SignalContext calldata context) external returns (uint16 feeDiscountBps);

    function onIntentFulfilled(bytes32 intentHash, uint256 releaseAmount, bool paymentProofVerified) external;
    function onIntentAbandoned(bytes32 intentHash, bool expired) external;
    function syncReputation(bytes32 intentHash) external returns (bool synced);
}
