// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IIntentLifecycleHook
 * @notice Governance-selected admission and settlement callbacks used by OrchestratorV3.
 * @dev OrchestratorV3 snapshots the configured hook when an intent is signaled, then calls that same hook for the
 *      intent's terminal cancellation or settlement. Every callback is fail-closed: a revert aborts the complete
 *      Orchestrator and Escrow operation that triggered it.
 */
interface IIntentLifecycleHook {
    /**
     * @notice Read-only settlement context supplied after fees are transferred and before recipient funds move.
     * @param intentHash Intent being settled.
     * @param token Escrow token released for this settlement.
     * @param recipient Intent recipient that receives the net amount when no post-intent hook is configured.
     * @param releaseAmount Amount released from Escrow before protocol, referral, and manager fees.
     * @param netAmount Remainder after all fees; this is the amount transferred to the recipient or made executable
     * by the intent's post-intent hook.
     * @param isManualRelease Whether the depositor used the manual-release path instead of payment-proof fulfillment.
     */
    struct SettlementContext {
        bytes32 intentHash;
        address token;
        address recipient;
        uint256 releaseAmount;
        uint256 netAmount;
        bool isManualRelease;
    }

    /**
     * @notice Validates and records lifecycle-policy state for a newly signaled intent.
     * @dev The calling orchestrator stores the complete intent before invoking this callback, allowing the hook to
     * read canonical intent data through `getIntent`. A revert rolls back intent creation and Escrow locking.
     * @param _intentHash Identifier of the newly stored intent in the calling orchestrator.
     */
    function onIntentSignaled(bytes32 _intentHash) external;

    /**
     * @notice Resolves lifecycle-policy state for an intent being cancelled, expired, or pruned as an orphan.
     * @dev A revert preserves the Orchestrator intent and aborts the corresponding Escrow unlock or prune operation.
     * @param _intentHash Identifier of the intent being removed without settlement.
     */
    function onIntentCancelled(bytes32 _intentHash) external;

    /**
     * @notice Resolves lifecycle-policy state for a successfully fulfilled or manually released intent.
     * @dev Called after fee transfers and before the net amount moves to the recipient or post-intent hook. The
     * lifecycle hook receives no token allowance and cannot consume settlement funds. A revert rolls back the entire
     * settlement, including Escrow release and fee transfers.
     * @param _context Intent identifier, token, recipient, pre-fee release amount, post-fee net amount, and settlement
     * route.
     */
    function settleIntent(SettlementContext calldata _context) external;
}
