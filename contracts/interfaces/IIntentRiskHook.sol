// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IIntentRiskHook
 * @notice Lifecycle callbacks used by OrchestratorV3 for depositor-selected risk policy.
 * @dev Admission and token-bearing settlement are fail-closed. Cancellation is a separate
 *      liveness path that may be handled fail-open by the orchestrator and reconciled later.
 */
interface IIntentRiskHook {
    /** @notice Complete token and lifecycle context for one atomic settlement decision. */
    struct RiskSettlementContext {
        bytes32 intentHash;
        address token;
        address recipient;
        uint256 grossAmount;
        uint256 executableAmount;
        bool isManualRelease;
    }

    /**
     * @notice Validates and records a newly created intent.
     * @param _intentHash Identifier of the readable intent in the calling orchestrator.
     */
    function onIntentCreated(bytes32 _intentHash) external;

    /**
     * @notice Resolves risk accounting for a cancelled or expired intent.
     * @param _intentHash Identifier of the intent being cancelled.
     */
    function onIntentCancelled(bytes32 _intentHash) external;

    /**
     * @notice Atomically resolves settlement risk after funds reach the orchestrator and fees are paid.
     * @dev The hook may consume either zero tokens or exactly `executableAmount` using the temporary
     *      allowance granted by the orchestrator. Any other balance delta reverts settlement.
     * @param _context Gross release, net executable amount, token, recipient, and resolution type.
     */
    function settleIntent(RiskSettlementContext calldata _context) external;
}
