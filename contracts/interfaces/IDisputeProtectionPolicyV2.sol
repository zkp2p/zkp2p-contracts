// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentSettlementPolicy} from "./IIntentSettlementPolicy.sol";
import {IStakeVaultV2} from "./IStakeVaultV2.sol";

interface IDisputeProtectionPolicyV2 is IIntentSettlementPolicy {
    enum DisputeProtectionIntentStatus { NONE, SETTLED, RELEASED, DISPUTED }
    /// @dev Whitelisted takers settle without creating a record.
    enum CollateralSource { NONE, STAKE, DEFERRED_PAYOUT }

    struct DisputeProtectionIntent {
        address taker;            // intent.owner; may call claimFor on a deferred payout
        address recipient;        // intent.to; owns a deferred lock; the only claimFor payee
        address stakeOwner;       // lock owner: stakeOwnerOf(taker) for STAKE, recipient for DEFERRED_PAYOUT
        address depositor;        // paid on a proven dispute
        bytes32 paymentMethod;
        DisputeProtectionIntentStatus status;
        CollateralSource collateralSource;
        uint64 releaseEligibleAt;
        uint256 lockedAmount;     // gross for STAKE, net for DEFERRED_PAYOUT
        uint256 claimedAmount;    // DEFERRED_PAYOUT only: total pushed by claimFor
    }

    /// @notice Emitted only for STAKE or DEFERRED_PAYOUT settlements.
    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, address indexed taker, address indexed depositor, address recipient, bytes32 paymentMethod, uint64 riskWindow, CollateralSource collateralSource, address stakeOwner, uint256 releaseAmount, uint256 lockedAmount, uint64 releaseEligibleAt);
    event DisputeProtectionIntentReleased(bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedAmount);
    event DeferredPayoutClaimed(bytes32 indexed intentHash, address indexed recipient, address indexed caller, uint256 amount, uint256 totalClaimed);
    event DisputeResolved(bytes32 indexed intentHash, address indexed stakeOwner, address indexed depositor, uint256 compensatedAmount, bytes32 disputeId);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event OrchestratorAuthorizationUpdated(address indexed orchestrator, bool isAuthorized);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error DisputeProtectionIntentAlreadyExists(bytes32 intentHash);
    error UnexpectedStatus(bytes32 intentHash, DisputeProtectionIntentStatus status);
    error DisputeProtectionIntentNotReleaseEligible(uint64 releaseEligibleAt, uint64 currentTime);
    error NotDeferredPayout(bytes32 intentHash);
    error UnauthorizedClaimer(address caller);
    error NothingToClaim(bytes32 intentHash);
    error InvalidSettlementAmount(uint256 releaseAmount, uint256 netAmount);
    error TimestampOverflow(uint256 timestamp);
    error MissingDisputeWindow();
    error InvalidDisputeWindow(uint256 window);
    error ConditionsNotAttested(bytes32 intentHash);
    error OwnershipRenunciationDisabled();

    /// @notice Returns whether an orchestrator may create and fund settlement records.
    function isOrchestratorAuthorized(address orchestrator) external view returns (bool);
    /// @notice Authorizes or revokes an orchestrator's settlement callbacks.
    function setOrchestratorAuthorization(address orchestrator, bool isAuthorized) external;
    /// @notice Returns the collateral vault.
    function stakeVault() external view returns (IStakeVaultV2);
}
