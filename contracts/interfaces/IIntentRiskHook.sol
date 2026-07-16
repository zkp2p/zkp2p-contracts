// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IIntentRiskHook
 * @notice Lifecycle callbacks used by OrchestratorV3 for depositor-selected risk policy.
 * @dev Admission is fail-closed. Terminal callbacks are invoked after the active intent body is
 *      pruned and may be handled fail-open by the orchestrator. Failed settlement callbacks may
 *      be reconciled from durable recovery data exposed by the orchestrator.
 */
interface IIntentRiskHook {
    /**
     * @notice Validates and records a newly created intent.
     * @param _intentHash Identifier of the readable intent in the calling orchestrator.
     * @return requiresSettlementHook True when manual release must execute the intent's settlement hook.
     */
    function onIntentCreated(bytes32 _intentHash) external returns (bool requiresSettlementHook);

    /**
     * @notice Resolves risk accounting for a cancelled or expired intent.
     * @param _intentHash Identifier of the intent being cancelled.
     */
    function onIntentCancelled(bytes32 _intentHash) external;

    /**
     * @notice Resolves risk accounting after proof verification succeeds.
     * @param _intentHash Identifier of the intent being fulfilled.
     * @param _releasedAmount Gross escrow amount released for the verified payment.
     * @param _paymentId Provider payment identifier authenticated by the payment verifier.
     */
    function onIntentFulfilled(bytes32 _intentHash, uint256 _releasedAmount, bytes32 _paymentId) external;

    /**
     * @notice Resolves risk accounting after a maker authorizes manual release.
     * @param _intentHash Identifier of the intent being released.
     * @param _releasedAmount Gross escrow amount manually released.
     */
    function onIntentReleased(bytes32 _intentHash, uint256 _releasedAmount) external;
}
