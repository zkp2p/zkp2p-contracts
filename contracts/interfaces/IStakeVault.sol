// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IStakeVault
 * @notice Custody, delegation, locking, and immediately claimable token accounting.
 * @dev The controller supplies all risk policy. Lock identifiers and claim allocations are opaque to the vault.
 */
interface IStakeVault {
    struct StakeLock {
        address stakeOwner;
        uint256 amount;
        uint64 maturesAt;
    }

    struct Claim {
        address beneficiary;
        uint256 amount;
    }

    event StakeDeposited(address indexed stakeOwner, uint256 amount, uint256 newStakeBalance);
    event StakeWithdrawn(address indexed stakeOwner, uint256 amount, uint256 newStakeBalance);
    event TakerAuthorizationUpdated(address indexed stakeOwner, address indexed taker, bool authorized);
    event StakeOwnerSelected(address indexed taker, address indexed previousStakeOwner, address indexed newStakeOwner);
    event StakeLocked(
        bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint64 maturesAt, uint256 totalLockedStake
    );
    event LockFunded(bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint256 newStakeBalance);
    event StakeLockIncreased(
        bytes32 indexed lockId,
        address indexed stakeOwner,
        uint256 previousAmount,
        uint256 newAmount,
        uint256 totalLockedStake
    );
    event StakeLockResized(
        bytes32 indexed lockId,
        address indexed stakeOwner,
        uint256 previousAmount,
        uint256 newAmount,
        uint64 previousMaturity,
        uint64 newMaturity,
        uint256 totalLockedStake
    );
    event StakeUnlocked(bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint256 totalLockedStake);
    event StakeLockResolved(
        bytes32 indexed lockId,
        address indexed stakeOwner,
        uint256 lockAmount,
        uint256 unlockedAmount,
        uint256 claimedAmount,
        uint256 totalLockedStake
    );
    event ClaimCreated(
        bytes32 indexed lockId, address indexed beneficiary, uint256 amount, uint256 newClaimableBalance
    );
    event ClaimWithdrawn(address indexed beneficiary, uint256 amount);
    event ControllerInitialized(address indexed controller);
    event ControllerProposed(address indexed currentController, address indexed pendingController, uint64 validAt);
    event ControllerProposalCancelled(address indexed pendingController);
    event ControllerAccepted(address indexed previousController, address indexed newController);

    function depositStake(uint256 _amount) external;
    function withdrawStake(uint256 _amount) external;
    function claim() external;

    function setTakerAuthorization(address _taker, bool _authorized) external;
    function selectStakeOwner(address _stakeOwner) external;
    function clearStakeOwner() external;

    function lockStake(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt) external;
    function fundLock(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt) external;
    function increaseLock(bytes32 _lockId, uint256 _additionalAmount) external;
    function resizeLock(bytes32 _lockId, uint256 _newAmount, uint64 _newMaturesAt) external;
    function unlockStake(bytes32 _lockId) external;
    function resolveLock(bytes32 _lockId, Claim[] calldata _claims) external;

    function initializeController(address _controller) external;
    function proposeController(address _controller) external;
    function cancelControllerProposal() external;
    function acceptController() external;

    function stakeToken() external view returns (IERC20);
    function controller() external view returns (address);
    function pendingController() external view returns (address);
    function pendingControllerValidAt() external view returns (uint64);
    function controllerChangeDelay() external view returns (uint64);
    function stakeBalance(address _stakeOwner) external view returns (uint256);
    function lockedStake(address _stakeOwner) external view returns (uint256);
    function claimable(address _beneficiary) external view returns (uint256);
    function totalStaked() external view returns (uint256);
    function totalClaimable() external view returns (uint256);
    function locks(bytes32 _lockId) external view returns (address stakeOwner, uint256 amount, uint64 maturesAt);
    function selectedStakeOwner(address _taker) external view returns (address);
    function authorizedTakers(address _stakeOwner, address _taker) external view returns (bool);
    function stakeOwnerOf(address _taker) external view returns (address);
    function freeStake(address _stakeOwner) external view returns (uint256);
    function isLockMature(bytes32 _lockId) external view returns (bool);
    function totalAccounted() external view returns (uint256);
    function unaccountedBalance() external view returns (uint256);
}
