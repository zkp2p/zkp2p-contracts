// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IIntentRiskHook
 * @notice Lifecycle callbacks used by OrchestratorV3 for governance-selected risk policy.
 * @dev Admission and token-bearing settlement are fail-closed. Cancellation is a separate
 *      liveness path that may be handled fail-open by the orchestrator and reconciled later.
 */
interface IIntentRiskHook {
    /** @notice Fee category preserved while a deferred settlement remains slashable. */
    enum FeeType {
        PROTOCOL,
        REFERRAL,
        MANAGER
    }

    /** @notice One exact, independently rounded fee claim derived from the gross Escrow release. */
    struct FeeAllocation {
        FeeType feeType;
        address recipient;
        uint256 amount;
    }

    /** @notice Complete token, fee, and lifecycle context for one atomic settlement decision. */
    struct RiskSettlementContext {
        bytes32 intentHash;
        address token;
        address recipient;
        uint256 grossAmount;
        uint256 executableAmount;
        bool isManualRelease;
        FeeAllocation[] feeAllocations;
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
     * @notice Atomically resolves settlement risk before any fees or recipient proceeds are transferred.
     * @dev The hook may consume either zero tokens or exactly `grossAmount` using the temporary allowance
     *      granted by the orchestrator. Any other balance delta reverts settlement. A zero-consumption
     *      return instructs the orchestrator to execute the supplied fee plan and ordinary payout.
     * @param _context Gross release, net executable amount, exact fee plan, token, recipient, and resolution type.
     */
    function settleIntent(RiskSettlementContext calldata _context) external;
}
