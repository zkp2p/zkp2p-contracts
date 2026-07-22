// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IStakeVault} from "./interfaces/IStakeVault.sol";

/**
 * @title StakeVault
 * @notice Holds stake and records controller-defined locks and immediately withdrawable claims.
 * @dev The vault deliberately knows nothing about intents, fees, chargebacks, or lock purpose. The current
 *      controller owns all lock policy and immediately gains authority over every lock after a delayed handover.
 *      Stake ownership is never delegated: a taker may only select an authorized owner's stake for policy reads.
 */
contract StakeVault is IStakeVault, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant MIN_CONTROLLER_CHANGE_DELAY = 1 days;
    uint64 public constant NEVER_MATURES = type(uint64).max;

    IERC20 public immutable override stakeToken;
    uint64 public immutable override controllerChangeDelay;

    address public override controller;
    address public override pendingController;
    uint64 public override pendingControllerValidAt;

    mapping(address => uint256) public override stakeBalance;
    mapping(address => uint256) public override lockedStake;
    mapping(address => uint256) public override claimable;
    mapping(bytes32 => StakeLock) public override locks;

    mapping(address => mapping(address => bool)) public override authorizedTakers;
    mapping(address => address) public override selectedStakeOwner;

    uint256 public override totalStaked;
    uint256 public override totalClaimable;

    error ZeroAddress();
    error ZeroAmount();
    error ZeroLockId();
    error InvalidControllerChangeDelay(uint64 suppliedDelay);
    error ControllerAlreadyInitialized(address controller);
    error ControllerInitializationWithLiabilities(uint256 totalStaked, uint256 totalClaimable);
    error UnauthorizedController(address caller);
    error UnauthorizedPendingController(address caller, address pendingController);
    error NoPendingController();
    error ControllerProposalNotReady(uint64 validAt, uint64 currentTime);
    error InvalidTaker(address taker);
    error UnauthorizedStakeOwner(address taker, address stakeOwner);
    error InvalidMaturity(uint64 maturity, uint64 currentTime);
    error LockAlreadyExists(bytes32 lockId);
    error LockNotFound(bytes32 lockId);
    error LockAlreadyMatured(bytes32 lockId, uint64 maturesAt, uint64 currentTime);
    error InvalidLockAmount(uint256 newAmount, uint256 currentAmount);
    error InsufficientFreeStake(address stakeOwner, uint256 available, uint256 required);
    error InsufficientUnaccountedTokens(uint256 available, uint256 required);
    error InvalidReceivedAmount(uint256 expected, uint256 received);
    error InvalidClaim(address beneficiary, uint256 amount);
    error ClaimsExceedLock(uint256 lockAmount, uint256 claimsAmount);
    error TimestampOverflow(uint256 timestamp);
    error OwnershipRenunciationDisabled();

    modifier onlyController() {
        if (msg.sender != controller) revert UnauthorizedController(msg.sender);
        _;
    }

    constructor(address _owner, IERC20 _stakeToken, address _controller, uint64 _controllerChangeDelay) {
        if (_owner == address(0) || address(_stakeToken) == address(0)) revert ZeroAddress();
        if (_controllerChangeDelay < MIN_CONTROLLER_CHANGE_DELAY) {
            revert InvalidControllerChangeDelay(_controllerChangeDelay);
        }

        stakeToken = _stakeToken;
        controller = _controller;
        controllerChangeDelay = _controllerChangeDelay;
        _transferOwnership(_owner);
    }

    /// @inheritdoc IStakeVault
    function depositStake(uint256 _amount) external override nonReentrant {
        if (_amount == 0) revert ZeroAmount();

        uint256 balanceBefore = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(msg.sender, address(this), _amount);
        uint256 balanceAfter = stakeToken.balanceOf(address(this));
        uint256 received = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (received != _amount) revert InvalidReceivedAmount(_amount, received);

        stakeBalance[msg.sender] += _amount;
        totalStaked += _amount;
        emit StakeDeposited(msg.sender, _amount, stakeBalance[msg.sender]);
    }

    /// @inheritdoc IStakeVault
    function withdrawStake(uint256 _amount) external override nonReentrant {
        if (_amount == 0) revert ZeroAmount();
        uint256 available = freeStake(msg.sender);
        if (available < _amount) revert InsufficientFreeStake(msg.sender, available, _amount);

        stakeBalance[msg.sender] -= _amount;
        totalStaked -= _amount;
        emit StakeWithdrawn(msg.sender, _amount, stakeBalance[msg.sender]);
        stakeToken.safeTransfer(msg.sender, _amount);
    }

    /// @inheritdoc IStakeVault
    function claim() external override nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert ZeroAmount();

        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        emit ClaimWithdrawn(msg.sender, amount);
        stakeToken.safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc IStakeVault
    function setTakerAuthorization(address _taker, bool _authorized) external override {
        if (_taker == address(0) || _taker == msg.sender) revert InvalidTaker(_taker);

        authorizedTakers[msg.sender][_taker] = _authorized;
        emit TakerAuthorizationUpdated(msg.sender, _taker, _authorized);

        if (!_authorized && selectedStakeOwner[_taker] == msg.sender) {
            delete selectedStakeOwner[_taker];
            emit StakeOwnerSelected(_taker, msg.sender, address(0));
        }
    }

    /// @inheritdoc IStakeVault
    function selectStakeOwner(address _stakeOwner) external override {
        if (_stakeOwner == address(0) || _stakeOwner == msg.sender) revert ZeroAddress();
        if (!authorizedTakers[_stakeOwner][msg.sender]) {
            revert UnauthorizedStakeOwner(msg.sender, _stakeOwner);
        }

        address previousStakeOwner = selectedStakeOwner[msg.sender];
        selectedStakeOwner[msg.sender] = _stakeOwner;
        emit StakeOwnerSelected(msg.sender, previousStakeOwner, _stakeOwner);
    }

    /// @inheritdoc IStakeVault
    function clearStakeOwner() external override {
        address previousStakeOwner = selectedStakeOwner[msg.sender];
        delete selectedStakeOwner[msg.sender];
        emit StakeOwnerSelected(msg.sender, previousStakeOwner, address(0));
    }

    /// @inheritdoc IStakeVault
    function lockStake(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt)
        external
        override
        onlyController
    {
        _validateNewLock(_stakeOwner, _lockId, _amount, _maturesAt);
        _consumeFreeStake(_stakeOwner, _amount);
        _storeLock(_stakeOwner, _lockId, _amount, _maturesAt);
    }

    /// @inheritdoc IStakeVault
    function fundLock(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt)
        external
        override
        onlyController
    {
        _validateNewLock(_stakeOwner, _lockId, _amount, _maturesAt);
        uint256 available = unaccountedBalance();
        if (available < _amount) revert InsufficientUnaccountedTokens(available, _amount);

        stakeBalance[_stakeOwner] += _amount;
        totalStaked += _amount;
        emit LockFunded(_lockId, _stakeOwner, _amount, stakeBalance[_stakeOwner]);
        _storeLock(_stakeOwner, _lockId, _amount, _maturesAt);
    }

    /// @inheritdoc IStakeVault
    function increaseLock(bytes32 _lockId, uint256 _additionalAmount) external override onlyController {
        if (_additionalAmount == 0) revert ZeroAmount();
        StakeLock storage stakeLock = locks[_lockId];
        if (stakeLock.stakeOwner == address(0)) revert LockNotFound(_lockId);

        uint64 currentTime = _currentTimestamp();
        if (currentTime >= stakeLock.maturesAt) {
            revert LockAlreadyMatured(_lockId, stakeLock.maturesAt, currentTime);
        }

        address stakeOwner = stakeLock.stakeOwner;
        _consumeFreeStake(stakeOwner, _additionalAmount);
        uint256 previousAmount = stakeLock.amount;
        stakeLock.amount = previousAmount + _additionalAmount;
        lockedStake[stakeOwner] += _additionalAmount;

        emit StakeLockIncreased(_lockId, stakeOwner, previousAmount, stakeLock.amount, lockedStake[stakeOwner]);
    }

    /// @inheritdoc IStakeVault
    function resizeLock(bytes32 _lockId, uint256 _newAmount, uint64 _newMaturesAt) external override onlyController {
        if (_newAmount == 0) revert ZeroAmount();
        StakeLock storage stakeLock = locks[_lockId];
        if (stakeLock.stakeOwner == address(0)) revert LockNotFound(_lockId);

        uint64 currentTime = _currentTimestamp();
        if (currentTime >= stakeLock.maturesAt) {
            revert LockAlreadyMatured(_lockId, stakeLock.maturesAt, currentTime);
        }
        _validateMaturity(_newMaturesAt, currentTime);

        uint256 previousAmount = stakeLock.amount;
        if (_newAmount > previousAmount) revert InvalidLockAmount(_newAmount, previousAmount);

        address stakeOwner = stakeLock.stakeOwner;
        uint64 previousMaturity = stakeLock.maturesAt;
        lockedStake[stakeOwner] -= previousAmount - _newAmount;
        stakeLock.amount = _newAmount;
        stakeLock.maturesAt = _newMaturesAt;

        emit StakeLockResized(
            _lockId, stakeOwner, previousAmount, _newAmount, previousMaturity, _newMaturesAt, lockedStake[stakeOwner]
        );
    }

    /// @inheritdoc IStakeVault
    function unlockStake(bytes32 _lockId) external override onlyController {
        StakeLock memory stakeLock = _takeLock(_lockId);
        emit StakeUnlocked(_lockId, stakeLock.stakeOwner, stakeLock.amount, lockedStake[stakeLock.stakeOwner]);
    }

    /// @inheritdoc IStakeVault
    function resolveLock(bytes32 _lockId, Claim[] calldata _claims) external override onlyController {
        StakeLock memory stakeLock = locks[_lockId];
        if (stakeLock.stakeOwner == address(0)) revert LockNotFound(_lockId);

        uint256 claimsAmount;
        for (uint256 claimIndex = 0; claimIndex < _claims.length; claimIndex++) {
            Claim calldata claimAllocation = _claims[claimIndex];
            if (claimAllocation.beneficiary == address(0) || claimAllocation.amount == 0) {
                revert InvalidClaim(claimAllocation.beneficiary, claimAllocation.amount);
            }
            claimsAmount += claimAllocation.amount;
        }
        if (claimsAmount > stakeLock.amount) revert ClaimsExceedLock(stakeLock.amount, claimsAmount);

        _takeLock(_lockId);
        if (claimsAmount != 0) {
            stakeBalance[stakeLock.stakeOwner] -= claimsAmount;
            totalStaked -= claimsAmount;
            totalClaimable += claimsAmount;

            for (uint256 claimIndex = 0; claimIndex < _claims.length; claimIndex++) {
                Claim calldata claimAllocation = _claims[claimIndex];
                claimable[claimAllocation.beneficiary] += claimAllocation.amount;
                emit ClaimCreated(
                    _lockId, claimAllocation.beneficiary, claimAllocation.amount, claimable[claimAllocation.beneficiary]
                );
            }
        }

        emit StakeLockResolved(
            _lockId,
            stakeLock.stakeOwner,
            stakeLock.amount,
            stakeLock.amount - claimsAmount,
            claimsAmount,
            lockedStake[stakeLock.stakeOwner]
        );
    }

    /// @inheritdoc IStakeVault
    function initializeController(address _controller) external override onlyOwner {
        if (_controller == address(0)) revert ZeroAddress();
        if (controller != address(0)) revert ControllerAlreadyInitialized(controller);
        if (totalStaked != 0 || totalClaimable != 0) {
            revert ControllerInitializationWithLiabilities(totalStaked, totalClaimable);
        }
        controller = _controller;
        emit ControllerInitialized(_controller);
    }

    /**
     * @dev Governance must always retain a recovery path for delayed controller replacement.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /// @inheritdoc IStakeVault
    function proposeController(address _controller) external override onlyOwner {
        if (_controller == address(0)) revert ZeroAddress();
        uint64 currentTime = _currentTimestamp();
        uint64 validAt = currentTime + controllerChangeDelay;
        pendingController = _controller;
        pendingControllerValidAt = validAt;
        emit ControllerProposed(controller, _controller, validAt);
    }

    /// @inheritdoc IStakeVault
    function cancelControllerProposal() external override onlyOwner {
        address proposedController = pendingController;
        if (proposedController == address(0)) revert NoPendingController();
        delete pendingController;
        delete pendingControllerValidAt;
        emit ControllerProposalCancelled(proposedController);
    }

    /// @inheritdoc IStakeVault
    function acceptController() external override {
        address proposedController = pendingController;
        if (proposedController == address(0)) revert NoPendingController();
        if (msg.sender != proposedController) {
            revert UnauthorizedPendingController(msg.sender, proposedController);
        }

        uint64 currentTime = _currentTimestamp();
        uint64 validAt = pendingControllerValidAt;
        if (currentTime < validAt) revert ControllerProposalNotReady(validAt, currentTime);

        address previousController = controller;
        controller = proposedController;
        delete pendingController;
        delete pendingControllerValidAt;
        emit ControllerAccepted(previousController, proposedController);
    }

    /// @inheritdoc IStakeVault
    function stakeOwnerOf(address _taker) external view override returns (address) {
        address selectedOwner = selectedStakeOwner[_taker];
        if (selectedOwner != address(0) && authorizedTakers[selectedOwner][_taker]) return selectedOwner;
        return _taker;
    }

    /// @inheritdoc IStakeVault
    function freeStake(address _stakeOwner) public view override returns (uint256) {
        return stakeBalance[_stakeOwner] - lockedStake[_stakeOwner];
    }

    /// @inheritdoc IStakeVault
    function isLockMature(bytes32 _lockId) external view override returns (bool) {
        StakeLock memory stakeLock = locks[_lockId];
        return stakeLock.stakeOwner != address(0) && block.timestamp >= stakeLock.maturesAt;
    }

    /// @inheritdoc IStakeVault
    function totalAccounted() public view override returns (uint256) {
        return totalStaked + totalClaimable;
    }

    /// @inheritdoc IStakeVault
    function unaccountedBalance() public view override returns (uint256) {
        uint256 tokenBalance = stakeToken.balanceOf(address(this));
        uint256 accounted = totalAccounted();
        return tokenBalance > accounted ? tokenBalance - accounted : 0;
    }

    function _validateNewLock(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt) internal view {
        if (_stakeOwner == address(0)) revert ZeroAddress();
        if (_lockId == bytes32(0)) revert ZeroLockId();
        if (_amount == 0) revert ZeroAmount();
        if (locks[_lockId].stakeOwner != address(0)) revert LockAlreadyExists(_lockId);
        _validateMaturity(_maturesAt, _currentTimestamp());
    }

    function _validateMaturity(uint64 _maturesAt, uint64 _currentTime) internal pure {
        if (_maturesAt <= _currentTime) revert InvalidMaturity(_maturesAt, _currentTime);
    }

    function _consumeFreeStake(address _stakeOwner, uint256 _amount) internal view {
        uint256 available = freeStake(_stakeOwner);
        if (available < _amount) revert InsufficientFreeStake(_stakeOwner, available, _amount);
    }

    function _storeLock(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt) internal {
        locks[_lockId] = StakeLock({stakeOwner: _stakeOwner, amount: _amount, maturesAt: _maturesAt});
        lockedStake[_stakeOwner] += _amount;
        emit StakeLocked(_lockId, _stakeOwner, _amount, _maturesAt, lockedStake[_stakeOwner]);
    }

    function _takeLock(bytes32 _lockId) internal returns (StakeLock memory stakeLock) {
        stakeLock = locks[_lockId];
        if (stakeLock.stakeOwner == address(0)) revert LockNotFound(_lockId);
        delete locks[_lockId];
        lockedStake[stakeLock.stakeOwner] -= stakeLock.amount;
    }

    function _currentTimestamp() internal view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow(block.timestamp);
        return uint64(block.timestamp);
    }
}
