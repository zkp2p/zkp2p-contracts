// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IStakeVaultV2} from "./IStakeVaultV2.sol";

/// @notice Fixed bonds held in StakeVaultV2 for a subject the owner names, slashable by governance.
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

    /// @notice Vault that holds bonds.
    function stakeVault() external view returns (IStakeVaultV2);

    /// @notice Token bonds are paid in.
    function stakeToken() external view returns (IERC20);

    /// @notice Amount every bond holds.
    function bondAmount() external view returns (uint256);

    /// @notice Notice an owner gives before taking a bond back; governance may slash it until then.
    function exitDelay() external view returns (uint64);

    /// @notice Moves `bondAmount` from the caller's wallet into the vault as the caller's bond for `_subject`.
    function postBond(bytes32 _subject) external;

    /// @notice Starts the caller's exit notice for its bond on `_subject`.
    function requestExit(bytes32 _subject) external;

    /// @notice Pays the caller's bond on `_subject` back to the caller once the exit notice has run.
    function exit(bytes32 _subject) external;

    /// @notice GOVERNANCE ONLY: Ends a bond, turning all of it into a vault claim for `_beneficiary`.
    function slash(address _stakeOwner, bytes32 _subject, address _beneficiary) external;

    /// @notice Vault lock id of an owner's bond on a subject.
    function bondId(address _stakeOwner, bytes32 _subject) external view returns (bytes32);

    /// @notice Whether an owner's bond on a subject is locked, and when its exit notice ends.
    function getBond(address _stakeOwner, bytes32 _subject) external view returns (Bond memory);
}
