// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentSettlementPolicy} from "./IIntentSettlementPolicy.sol";
import {IStakeVaultV2} from "./IStakeVaultV2.sol";

/// @notice Selects dispute collateral. Zero windows and non-stake tokens pay now without a record or event.
interface IDisputeProtectionPolicyV2 is IIntentSettlementPolicy {
    /// @dev The StakeVaultV2 lock with id intentHash holds the owner, amount and maturity.
    struct Protection {
        address depositor;        // paid on a proven dispute
        bytes32 paymentMethod;    // selects the dispute verification rules
    }

    event ProtectionOpened(bytes32 indexed intentHash, address indexed depositor);
    event ProtectionReleased(bytes32 indexed intentHash);
    event DisputeResolved(bytes32 indexed intentHash, address indexed stakeOwner, address indexed depositor, uint256 compensatedAmount, bytes32 disputeId);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    error ZeroAddress();
    error UnauthorizedOrchestrator(address caller);
    error ProtectionNotFound(bytes32 intentHash);
    error NotMatured(uint64 maturesAt, uint64 currentTime);
    error InvalidDisputeWindow(uint256 window);
    error OwnershipRenunciationDisabled();

    /// @notice Returns the collateral vault.
    function stakeVault() external view returns (IStakeVaultV2);
}
