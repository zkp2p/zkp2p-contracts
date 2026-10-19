// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IStakeVaultV2
 * @notice Stake custody, delegation, controller locks and dispute claims. Canonical USDC only.
 */
interface IStakeVaultV2 {
    struct StakeLock {
        address stakeOwner;
        uint256 amount;
        uint64 maturesAt;
    }

    struct Claim {
        address beneficiary;
        uint256 amount;
    }

    error ZeroAddress();
    error ZeroAmount();
    error ZeroLockId();
    error UnauthorizedController(address caller);
    error UnauthorizedLockController(bytes32 lockId, address caller, address controller);
    error InvalidTaker(address taker);
    error UnauthorizedStakeOwner(address taker, address stakeOwner);
    error InvalidMaturity(uint64 maturity, uint64 currentTime);
    error LockAlreadyExists(bytes32 lockId);
    error LockNotFound(bytes32 lockId);
    error InsufficientFreeStake(address stakeOwner, uint256 available, uint256 required);
    error InsufficientUnaccountedTokens(uint256 available, uint256 required);
    error InvalidClaim(address beneficiary, uint256 amount);
    error ClaimsExceedLock(uint256 lockAmount, uint256 claimsAmount);
    error OwnershipRenunciationDisabled();

    event StakeDeposited(address indexed stakeOwner, uint256 amount, uint256 newStakeBalance);
    event StakeWithdrawn(address indexed stakeOwner, address indexed to, uint256 amount, uint256 newStakeBalance);
    event TakerAuthorizationUpdated(address indexed stakeOwner, address indexed taker, bool authorized);
    event StakeOwnerSelected(address indexed taker, address indexed previousStakeOwner, address indexed newStakeOwner);
    event StakeLocked(
        bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint64 maturesAt, uint256 totalLockedStake
    );
    event LockFunded(bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint256 newStakeBalance);
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

    event ControllerUpdated(address indexed controller, bool authorized);

    function depositStake(uint256 _amount) external;
    function withdrawStake(uint256 _amount) external;
    function withdrawStakeTo(address _to, uint256 _amount) external;
    function claim() external;

    function setTakerAuthorization(address _taker, bool _authorized) external;
    function selectStakeOwner(address _stakeOwner) external;
    function clearStakeOwner() external;

    function lockStake(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt) external;
    function fundLock(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt) external;
    function unlockStake(bytes32 _lockId) external;
    function resolveLock(bytes32 _lockId, Claim[] calldata _claims) external;

    /// @notice Immediately changes controller authorization; de-authorize only after its locks drain.
    function setController(address _controller, bool _authorized) external;

    function stakeToken() external view returns (IERC20);
    function isController(address _controller) external view returns (bool);
    function lockController(bytes32 _lockId) external view returns (address);
    function stakeBalance(address _stakeOwner) external view returns (uint256);
    function lockedStake(address _stakeOwner) external view returns (uint256);
    function claimable(address _beneficiary) external view returns (uint256);
    function totalStaked() external view returns (uint256);
    function totalClaimable() external view returns (uint256);
    function locks(bytes32 _lockId) external view returns (address stakeOwner, uint256 amount, uint64 maturesAt);
    function selectedStakeOwner(address _taker) external view returns (address);
    function authorizedTakers(address _stakeOwner, address _taker) external view returns (bool);
    function stakeOwnerOf(address _taker) external view returns (address);

    /**
     * @notice Returns a taker's live selected stake owner and that owner's aggregate balances.
     * @param _taker Taker whose effective stake owner and balances are queried.
     */
    function getTakerState(address _taker)
        external
        view
        returns (address stakeOwner, uint256 totalStake, uint256 lockedStakeAmount, uint256 freeStakeAmount);
    function freeStake(address _stakeOwner) external view returns (uint256);
    function totalAccounted() external view returns (uint256);
    function unaccountedBalance() external view returns (uint256);
}
