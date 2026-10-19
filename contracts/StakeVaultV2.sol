// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IStakeVaultV2} from "./interfaces/IStakeVaultV2.sol";

/**
 * @title StakeVaultV2
 * @notice Holds stake, locks it for governance-authorized controllers and pays out dispute claims.
 * @dev Only free stake (balance minus locks) can be withdrawn or locked. Only the controller that created a lock can
 *      unlock or resolve it, and only while still authorized. Canonical USDC only.
 */
contract StakeVaultV2 is IStakeVaultV2, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ============ Immutable Configuration ============ */

    /// @notice Token held and accounted by the vault.
    IERC20 public immutable override stakeToken;

    /* ============ Controller State ============ */

    /// @notice Governance-trusted controllers allowed to create locks.
    mapping(address => bool) public override isController;

    /// @notice Creating controller of each active lock, or zero after the lock is removed.
    mapping(bytes32 => address) public override lockController;

    /* ============ Stake and Claim State ============ */

    /// @notice Total principal owned by each stake owner, including both free and locked stake.
    mapping(address => uint256) public override stakeBalance;

    /// @notice Principal committed across all active locks for each stake owner.
    mapping(address => uint256) public override lockedStake;

    /// @notice Immediately withdrawable, non-stake token balance credited to each beneficiary.
    mapping(address => uint256) public override claimable;

    /// @notice Active lock accounting keyed by controller-defined globally unique identifiers.
    mapping(bytes32 => StakeLock) public override locks;

    /* ============ Delegation State ============ */

    /// @notice Whether a stake owner permits a taker to select its stake for future controller policy reads.
    mapping(address => mapping(address => bool)) public override authorizedTakers;

    /// @notice Stake owner explicitly selected by each taker, subject to live authorization.
    mapping(address => address) public override selectedStakeOwner;

    /// @notice Aggregate stake principal liability across all owners.
    uint256 public override totalStaked;

    /// @notice Aggregate immediately withdrawable claim liability across all beneficiaries.
    uint256 public override totalClaimable;

    /* ============ Modifiers ============ */

    modifier onlyController() {
        if (!isController[msg.sender]) revert UnauthorizedController(msg.sender);
        _;
    }

    /// @dev An authorized controller may service only locks it created.
    modifier onlyLockController(bytes32 _lockId) {
        address creator = lockController[_lockId];
        if (creator == address(0)) revert LockNotFound(_lockId);
        if (msg.sender != creator) revert UnauthorizedLockController(_lockId, msg.sender, creator);
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Creates a token vault; governance authorizes controllers with setController.
     * @param _owner Governance owner responsible for controller authorization and recovery.
     * @param _stakeToken Canonical USDC token held and accounted by the vault.
     */
    constructor(address _owner, IERC20 _stakeToken) {
        if (_owner == address(0) || address(_stakeToken) == address(0)) revert ZeroAddress();
        stakeToken = _stakeToken;
        _transferOwnership(_owner);
    }

    /* ============ User Stake and Claim Accounting ============ */

    /**
     * @notice Deposits stake-token principal owned exclusively by the caller.
     * @param _amount Amount of stake token to transfer into and credit within the vault.
     */
    function depositStake(uint256 _amount) external override nonReentrant {
        if (_amount == 0) revert ZeroAmount();

        stakeToken.safeTransferFrom(msg.sender, address(this), _amount);
        stakeBalance[msg.sender] += _amount;
        totalStaked += _amount;
        emit StakeDeposited(msg.sender, _amount, stakeBalance[msg.sender]);
    }

    /**
     * @notice Withdraws caller-owned free stake to the caller.
     * @param _amount Amount of free stake principal to withdraw.
     */
    function withdrawStake(uint256 _amount) external override nonReentrant {
        _withdrawStake(msg.sender, _amount);
    }

    /**
     * @notice Withdraws caller-owned free stake to another address.
     * @param _to Address receiving the tokens.
     * @param _amount Amount of free stake principal to withdraw.
     */
    function withdrawStakeTo(address _to, uint256 _amount) external override nonReentrant {
        _withdrawStake(_to, _amount);
    }

    /**
     * @notice Withdraws the caller's complete immediately claimable balance.
     */
    function claim() external override nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert ZeroAmount();

        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        emit ClaimWithdrawn(msg.sender, amount);
        stakeToken.safeTransfer(msg.sender, amount);
    }

    /* ============ Delegation ============ */

    /**
     * @notice Authorizes or revokes a taker's ability to select the caller's stake for future policy reads.
     * @param _taker Taker whose authorization is being changed.
     * @param _authorized True to authorize selection of the caller's stake; false to revoke it.
     */
    function setTakerAuthorization(address _taker, bool _authorized) external override {
        if (_taker == address(0) || _taker == msg.sender) revert InvalidTaker(_taker);

        authorizedTakers[msg.sender][_taker] = _authorized;
        emit TakerAuthorizationUpdated(msg.sender, _taker, _authorized);

        if (!_authorized && selectedStakeOwner[_taker] == msg.sender) {
            delete selectedStakeOwner[_taker];
            emit StakeOwnerSelected(_taker, msg.sender, address(0));
        }
    }

    /**
     * @notice Selects an authorizing third-party stake owner for the caller's future policy reads.
     * @param _stakeOwner Authorized third party whose stake the caller wants future policy to resolve.
     */
    function selectStakeOwner(address _stakeOwner) external override {
        if (_stakeOwner == address(0) || _stakeOwner == msg.sender) revert ZeroAddress();
        if (!authorizedTakers[_stakeOwner][msg.sender]) {
            revert UnauthorizedStakeOwner(msg.sender, _stakeOwner);
        }

        address previousStakeOwner = selectedStakeOwner[msg.sender];
        selectedStakeOwner[msg.sender] = _stakeOwner;
        emit StakeOwnerSelected(msg.sender, previousStakeOwner, _stakeOwner);
    }

    /**
     * @notice Clears the caller's selected third-party stake owner and restores the self-staking fallback.
     */
    function clearStakeOwner() external override {
        address previousStakeOwner = selectedStakeOwner[msg.sender];
        delete selectedStakeOwner[msg.sender];
        emit StakeOwnerSelected(msg.sender, previousStakeOwner, address(0));
    }

    /* ============ Controller Lock Accounting ============ */

    /**
     * @notice CONTROLLER ONLY: Creates a new lock backed by an owner's existing free stake.
     * @param _stakeOwner Owner whose free stake backs the new lock.
     * @param _lockId Controller-defined globally unique identifier for the active lock.
     * @param _amount Amount of existing free stake to commit.
     * @param _maturesAt Maturity recorded for the controller; must be in the future.
     */
    function lockStake(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt)
        external
        override
        onlyController
    {
        _validateNewLock(_stakeOwner, _lockId, _amount, _maturesAt);
        uint256 available = freeStake(_stakeOwner);
        if (available < _amount) revert InsufficientFreeStake(_stakeOwner, available, _amount);
        _storeLock(_stakeOwner, _lockId, _amount, _maturesAt);
    }

    /**
     * @notice CONTROLLER ONLY: Adopts unaccounted vault tokens as new stake and immediately locks them.
     * @param _stakeOwner Owner credited with the newly accounted stake.
     * @param _lockId Controller-defined globally unique identifier for the active lock.
     * @param _amount Amount of unaccounted token balance to adopt and lock.
     * @param _maturesAt Maturity recorded for the controller; must be in the future.
     */
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

    /**
     * @notice CONTROLLER ONLY: Deletes an active lock and returns its complete amount to owner free stake.
     * @param _lockId Identifier of the active lock to delete.
     */
    function unlockStake(bytes32 _lockId) external override onlyController onlyLockController(_lockId) {
        StakeLock memory stakeLock = _removeLock(_lockId);
        emit StakeUnlocked(_lockId, stakeLock.stakeOwner, stakeLock.amount, lockedStake[stakeLock.stakeOwner]);
    }

    /**
     * @notice CONTROLLER ONLY: Deletes an active lock and converts selected principal into beneficiary claims.
     * @param _lockId Identifier of the active lock to resolve.
     * @param _claims Beneficiary allocations to create from the locked principal.
     */
    function resolveLock(bytes32 _lockId, Claim[] calldata _claims)
        external
        override
        onlyController
        onlyLockController(_lockId)
    {
        StakeLock memory stakeLock = locks[_lockId];

        uint256 claimsAmount;
        for (uint256 claimIndex = 0; claimIndex < _claims.length; claimIndex++) {
            Claim calldata claimAllocation = _claims[claimIndex];
            if (claimAllocation.beneficiary == address(0) || claimAllocation.amount == 0) {
                revert InvalidClaim(claimAllocation.beneficiary, claimAllocation.amount);
            }
            claimsAmount += claimAllocation.amount;
        }
        if (claimsAmount > stakeLock.amount) revert ClaimsExceedLock(stakeLock.amount, claimsAmount);

        _removeLock(_lockId);
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

    /* ============ Controller Governance ============ */

    /**
     * @notice GOVERNANCE ONLY: Immediately authorizes or de-authorizes a controller.
     * @param _controller Non-zero controller address.
     * @param _authorized Whether the controller may act.
     */
    function setController(address _controller, bool _authorized) external override onlyOwner {
        if (_controller == address(0)) revert ZeroAddress();
        isController[_controller] = _authorized;
        emit ControllerUpdated(_controller, _authorized);
    }

    /**
     * @notice Ownership renunciation is disabled so governance always retains a controller recovery path.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ Views ============ */

    /**
     * @notice Resolves the stake owner used for a taker's future controller policy reads.
     * @param _taker Taker whose effective stake owner should be resolved.
     * @return Effective stake owner for future policy decisions.
     */
    function stakeOwnerOf(address _taker) public view override returns (address) {
        address selectedOwner = selectedStakeOwner[_taker];
        if (selectedOwner != address(0) && authorizedTakers[selectedOwner][_taker]) return selectedOwner;
        return _taker;
    }

    /**
     * @notice Returns a taker's currently selected stake owner and that owner's aggregate stake balances.
     * @param _taker Taker whose effective stake owner and balances are queried.
     * @return stakeOwner Effective owner supplying stake for the taker.
     * @return totalStake Total principal owned by `stakeOwner`, including free and locked stake.
     * @return lockedStakeAmount Principal currently committed to active locks.
     * @return freeStakeAmount Principal currently available for withdrawal or new locks.
     */
    function getTakerState(address _taker)
        external
        view
        override
        returns (address stakeOwner, uint256 totalStake, uint256 lockedStakeAmount, uint256 freeStakeAmount)
    {
        stakeOwner = stakeOwnerOf(_taker);
        totalStake = stakeBalance[stakeOwner];
        lockedStakeAmount = lockedStake[stakeOwner];
        freeStakeAmount = totalStake - lockedStakeAmount;
    }

    /**
     * @notice Returns principal the owner may immediately withdraw or commit to another lock.
     * @param _stakeOwner Owner whose free principal should be calculated.
     * @return Stake balance not committed to any active lock.
     */
    function freeStake(address _stakeOwner) public view override returns (uint256) {
        return stakeBalance[_stakeOwner] - lockedStake[_stakeOwner];
    }

    /**
     * @notice Returns aggregate token liabilities represented by stake principal and beneficiary claims.
     * @return Sum of `totalStaked` and `totalClaimable`.
     */
    function totalAccounted() public view override returns (uint256) {
        return totalStaked + totalClaimable;
    }

    /**
     * @notice Returns vault token balance available to be adopted through `fundLock`.
     * @return Token balance held above aggregate stake and claim liabilities.
     */
    function unaccountedBalance() public view override returns (uint256) {
        uint256 tokenBalance = stakeToken.balanceOf(address(this));
        uint256 accounted = totalAccounted();
        return tokenBalance > accounted ? tokenBalance - accounted : 0;
    }

    /* ============ Internal Stake Helpers ============ */

    /// @dev Reverts unless the complete amount is free; accounting is reduced before the token transfer.
    function _withdrawStake(address _to, uint256 _amount) internal {
        if (_amount == 0) revert ZeroAmount();
        uint256 available = freeStake(msg.sender);
        if (available < _amount) revert InsufficientFreeStake(msg.sender, available, _amount);

        stakeBalance[msg.sender] -= _amount;
        totalStaked -= _amount;
        emit StakeWithdrawn(msg.sender, _to, _amount, stakeBalance[msg.sender]);
        stakeToken.safeTransfer(_to, _amount);
    }

    /* ============ Internal Lock Helpers ============ */

    /**
     * @param _stakeOwner Non-zero owner to record on the lock.
     * @param _lockId Non-zero globally unused active lock identifier.
     * @param _amount Non-zero amount to lock.
     * @param _maturesAt Maturity timestamp required to be strictly in the future.
     */
    function _validateNewLock(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt) internal view {
        if (_stakeOwner == address(0)) revert ZeroAddress();
        if (_lockId == bytes32(0)) revert ZeroLockId();
        if (_amount == 0) revert ZeroAmount();
        if (locks[_lockId].stakeOwner != address(0)) revert LockAlreadyExists(_lockId);
        if (_maturesAt <= block.timestamp) revert InvalidMaturity(_maturesAt, uint64(block.timestamp));
    }

    /**
     * @param _stakeOwner Owner recorded on the lock.
     * @param _lockId Globally unused active lock identifier.
     * @param _amount Amount of owner principal being committed.
     * @param _maturesAt Recorded maturity timestamp.
     */
    function _storeLock(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt) internal {
        locks[_lockId] = StakeLock({stakeOwner: _stakeOwner, amount: _amount, maturesAt: _maturesAt});
        lockController[_lockId] = msg.sender;
        lockedStake[_stakeOwner] += _amount;
        emit StakeLocked(_lockId, _stakeOwner, _amount, _maturesAt, lockedStake[_stakeOwner]);
    }

    /**
     * @param _lockId Identifier of the active lock to remove.
     * @return stakeLock Deleted lock snapshot used by the caller's terminal accounting.
     */
    function _removeLock(bytes32 _lockId) internal returns (StakeLock memory stakeLock) {
        stakeLock = locks[_lockId];
        if (stakeLock.stakeOwner == address(0)) revert LockNotFound(_lockId);
        delete locks[_lockId];
        delete lockController[_lockId];
        lockedStake[stakeLock.stakeOwner] -= stakeLock.amount;
    }
}
