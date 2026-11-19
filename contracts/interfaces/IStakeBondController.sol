// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IStakeVaultV2} from "./IStakeVaultV2.sol";

/// @notice Fixed bonds locked from an owner's StakeVaultV2 stake for a subject the owner names, slashable by governance.
interface IStakeBondController {
    /// @dev A bond exists while its vault lock does; `exitableAt` is zero until the owner gives exit notice.
    struct Bond {
        bool posted;
        uint64 exitableAt;
    }

    event BondPosted(address indexed stakeOwner, bytes32 indexed subject, bytes32 indexed bondId, uint256 amount);
    event BondExitRequested(
        address indexed stakeOwner, bytes32 indexed subject, bytes32 indexed bondId, uint64 exitableAt
    );
    event BondExited(address indexed stakeOwner, bytes32 indexed subject, bytes32 indexed bondId);
    event BondSlashed(
        address indexed stakeOwner, bytes32 indexed subject, bytes32 indexed bondId, address beneficiary, uint256 amount
    );

    error ZeroAddress();
    error ZeroAmount();
    error InvalidExitDelay(uint64 exitDelay);
    error BondNotFound(bytes32 bondId);
    error ExitAlreadyRequested(bytes32 bondId, uint64 exitableAt);
    error ExitNotRequested(bytes32 bondId);
    error ExitNotReady(bytes32 bondId, uint64 exitableAt, uint64 currentTime);
    error OwnershipRenunciationDisabled();

    /// @notice Vault whose stake this controller locks.
    function stakeVault() external view returns (IStakeVaultV2);

    /// @notice Stake every bond locks.
    function bondAmount() external view returns (uint256);

    /// @notice Notice an owner gives before taking a bond back; governance may slash it until then.
    function exitDelay() external view returns (uint64);

    /// @notice Locks `bondAmount` of the caller's free stake as the caller's bond for `_subject`.
    function postBond(bytes32 _subject) external;

    /// @notice Starts the caller's exit notice for its bond on `_subject`.
    function requestExit(bytes32 _subject) external;

    /// @notice Returns the caller's bond on `_subject` to its free stake once the exit notice has run.
    function exit(bytes32 _subject) external;

    /// @notice GOVERNANCE ONLY: Ends a bond, turning `_amount` of it into a vault claim for `_beneficiary`.
    function slash(address _stakeOwner, bytes32 _subject, uint256 _amount, address _beneficiary) external;

    /// @notice Vault lock id of an owner's bond on a subject.
    function bondId(address _stakeOwner, bytes32 _subject) external view returns (bytes32);

    /// @notice Whether an owner's bond on a subject is locked, and when its exit notice ends.
    function getBond(address _stakeOwner, bytes32 _subject) external view returns (Bond memory);
}
