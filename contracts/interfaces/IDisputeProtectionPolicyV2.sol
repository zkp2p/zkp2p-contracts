// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentSettlementPolicy} from "./IIntentSettlementPolicy.sol";
import {IStakeVaultV2} from "./IStakeVaultV2.sol";

/// @notice Selects dispute collateral. Zero windows and non-stake tokens pay now without a record or event.
interface IDisputeProtectionPolicyV2 is IIntentSettlementPolicy {
    /// @dev The StakeVaultV2 lock with id intentHash holds the owner, amount and maturity.
    struct DisputeProtectionIntent {
        address depositor;        // paid on a proven dispute
        bytes32 paymentMethod;    // selects the dispute verification rules
    }

    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, address indexed depositor);
    event DisputeProtectionIntentReleased(bytes32 indexed intentHash);
    event DisputeResolved(bytes32 indexed intentHash, address indexed stakeOwner, address indexed depositor, uint256 compensatedAmount, bytes32 disputeId);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event OrchestratorAuthorizationUpdated(address indexed orchestrator, bool isAuthorized);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error DisputeProtectionIntentAlreadyExists(bytes32 intentHash);
    error DisputeProtectionIntentNotFound(bytes32 intentHash);
    error DisputeProtectionIntentNotReleaseEligible(uint64 releaseEligibleAt, uint64 currentTime);
    error InvalidSettlementAmount(uint256 releaseAmount, uint256 netAmount);
    error TimestampOverflow(uint256 timestamp);
    error InvalidDisputeWindow(uint256 window);
    error OwnershipRenunciationDisabled();

    /// @notice Returns whether an orchestrator may create and fund settlement records.
    function isOrchestratorAuthorized(address orchestrator) external view returns (bool);
    /// @notice Authorizes or revokes an orchestrator's settlement callbacks.
    function setOrchestratorAuthorization(address orchestrator, bool isAuthorized) external;
    /// @notice Returns the collateral vault.
    function stakeVault() external view returns (IStakeVaultV2);
}
