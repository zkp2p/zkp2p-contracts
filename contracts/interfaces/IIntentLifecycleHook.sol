// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IIntentLifecycleHook
 * @notice Lifecycle callbacks used by OrchestratorV3 for governance-selected risk policy.
 * @dev All callbacks are fail-closed: a reverting hook aborts the operation that triggered it,
 *      including cancellation.
 */
interface IIntentLifecycleHook {
    /** @notice Complete token and lifecycle context for one atomic settlement decision. */
    struct SettlementContext {
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
     * @notice Observes or vetoes a settlement after fees are transferred and before recipient proceeds move.
     * @dev Fail-closed: a revert aborts the entire settlement, including fee transfers. The hook receives no token
     *      allowance and the context is informational; executableAmount is the net payout.
     * @param _context Gross release, net executable amount, token, recipient, and resolution type.
     */
    function settleIntent(SettlementContext calldata _context) external;
}
