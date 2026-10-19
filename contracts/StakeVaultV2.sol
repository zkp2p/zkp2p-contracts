// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IStakeVaultV2} from "./interfaces/IStakeVaultV2.sol";

/**
 * @title StakeVaultV2
 * @notice Policy-agnostic custody, delegation, lock, and immediately claimable token accounting.
 *
 * @dev ACCOUNTING MODEL
 *      Stake principal belongs to a `stakeOwner` and is split into locked and free amounts:
 *
 *        freeStake(owner) = stakeBalance(owner) - lockedStake(owner)
 *        totalAccounted() = totalStaked + totalClaimable
 *
 *      Creating or unlocking a lock only moves principal between locked and free accounting.
 *      Resolving a lock may move some principal from `totalStaked` into beneficiary `claimable` balances; every
 *      unallocated unit becomes free stake of the original owner. Claims are immediately withdrawable and are never
 *      stake. `fundLock` is the sole path that adopts tokens already transferred into the vault as new locked stake.
 *
 * @dev DELEGATION MODEL
 *      A stake owner may authorize any number of takers, and each taker explicitly selects at most one authorized owner.
 *      Authorizations are additive: one owner's authorization never overwrites another's, and a taker can always fall
 *      back to its own stake. Delegation never transfers ownership, custody rights, or withdrawal rights. Revocation
 *      clears an active selection for future policy reads but cannot alter locks already created for that owner.
 *
 * @dev LOCK AND CONTROLLER MODEL
 *      The vault deliberately knows nothing about intents, fees, disputes, or lock purpose. Lock IDs and beneficiary
 *      allocations are opaque controller inputs. A lock's maturity is recorded for the controller; it never resolves
 *      the lock, and the controller chooses whether and how every lock is unlocked or converted into claims.
 *
 *      Every authorized controller is governance-trusted: it can lock any owner's free stake. Each lock records its
 *      creating controller; only that controller, while still authorized, can unlock or resolve it. Governance can authorize a
 *      successor immediately alongside its predecessor. De-authorize a controller only after its locks drain;
 *      revocation freezes its locks until it is re-authorized. The owner cannot renounce ownership, preserving recovery.
 *
 * @dev TOKEN ASSUMPTION
 *      ZKP2P deployments configure the vault only with canonical USDC. USDC administration, upgrades, pauses, and
 *      blocklisting remain accepted external operational risks. Tokens with transfer fees, rebasing, or other balance
 *      transformations are unsupported; the exact inbound balance-delta check is defense in depth, not generic-token
 *      compatibility.
 *
 * @dev SECURITY INVARIANTS AND RATIONALE
 *      1. Only free stake may be withdrawn or newly locked. Existing locks remain fully backed in aggregate accounting.
 *      2. Lock IDs are globally unique while active, preventing one owner's lock from colliding with another's.
 *      3. Only authorized controllers can create or fund locks; only their still-authorized creator can service them.
 *         Each controller must enforce all policy,
 *         including whether a named stake owner authorized the economic action; the vault enforces accounting only.
 *      4. Resolution conserves liabilities: claim allocations cannot exceed the lock, and unclaimed remainder stays with
 *         the stake owner rather than being transferred to the controller.
 *      5. Deposits require an exact token balance delta. Funded locks can adopt only balance already held above existing
 *         liabilities, while the controller remains responsible for transfer-specific delta checks. The controller never
 *         takes custody.
 *      6. User withdrawals and claims apply accounting effects before token interactions and are reentrancy guarded.
 *      7. Controller authorization changes immediately; existing locks retain their creator until removed.
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

    /**
     * @dev Restricts controller operations to governance-authorized callers.
     */
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
     * @dev Claims are separate from stake principal and cannot be delegated or used for locks. The claim balance and
     *      aggregate claim liability are cleared before the token transfer. Partial claim withdrawal is intentionally
     *      unsupported, keeping claim settlement to one state transition per beneficiary withdrawal.
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
     * @dev The caller remains the stake owner and retains all deposit and withdrawal rights. Revoking the authorization
     *      automatically clears the taker's selection if it currently points to the caller. Existing locks remain owned
     *      by and charged against the original stake owner. Self-authorization is unnecessary because every taker falls
     *      back to its own stake when it has no valid selection.
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
     * @dev Selection does not lock or transfer funds and overwrites only the caller's previous selection. The named owner
     *      must currently authorize the caller. Selecting oneself or zero is unsupported; use `clearStakeOwner` to return
     *      to the implicit self-staking fallback.
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
     * @dev Does not change any owner's authorization mapping and cannot alter existing locks. Emits an event even when no
     *      selection was active, allowing indexers to treat the call as an explicit preference reset.
     */
    function clearStakeOwner() external override {
        address previousStakeOwner = selectedStakeOwner[msg.sender];
        delete selectedStakeOwner[msg.sender];
        emit StakeOwnerSelected(msg.sender, previousStakeOwner, address(0));
    }

    /* ============ Controller Lock Accounting ============ */

    /**
     * @notice CONTROLLER ONLY: Creates a new lock backed by an owner's existing free stake.
     * @dev The lock ID must be non-zero and globally unused, the owner and amount must be non-zero, and maturity must be
     *      strictly in the future. This function does not consult delegation state; authorization and lock purpose are
     *      controller policy. Principal remains in `stakeBalance` while `lockedStake` increases by the lock amount.
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
     * @dev Intended for atomic flows that transfer tokens directly to StakeVault before calling this function. The vault
     *      must hold at least `_amount` above existing stake and claim liabilities. Funding increases the named owner's
     *      stake balance and aggregate stake, then commits the complete amount under a validated new lock. Any excess
     *      unaccounted tokens remain available for a later funding operation.
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
     * @dev Unlocking is permitted before or after maturity because business policy belongs to the controller. No stake or
     *      aggregate liability changes; only the lock record and owner's locked subtotal are reduced.
     * @param _lockId Identifier of the active lock to delete.
     */
    function unlockStake(bytes32 _lockId) external override onlyController onlyLockController(_lockId) {
        StakeLock memory stakeLock = _removeLock(_lockId);
        emit StakeUnlocked(_lockId, stakeLock.stakeOwner, stakeLock.amount, lockedStake[stakeLock.stakeOwner]);
    }

    /**
     * @notice CONTROLLER ONLY: Deletes an active lock and converts selected principal into beneficiary claims.
     * @dev Resolution is permitted before or after maturity. Every allocation requires a non-zero beneficiary and amount,
     *      and their sum cannot exceed the lock. Allocated principal moves atomically from the owner's stake liability to
     *      immediately withdrawable claim liabilities; duplicate beneficiaries accumulate. The unallocated remainder
     *      becomes owner free stake. An empty claim array is equivalent in accounting effect to an unlock.
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
     * @dev Every authorized controller can lock any owner's free stake.
     *      De-authorize a controller only after its locks drain; only an authorized creator can service its locks.
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
     * @dev Always reverts for the owner; non-owners revert through the inherited ownership check first.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ Views ============ */

    /**
     * @notice Resolves the stake owner used for a taker's future controller policy reads.
     * @dev Returns the selected owner only while its authorization remains live; otherwise returns the taker itself.
     *      Existing locks are independent of this live lookup and retain the owner stored in each lock.
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
     * @dev Delegation is resolved live. If a previous authorization was revoked, the taker falls back to its own
     *      stake and the returned balances describe the taker's account.
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
     * @dev Derived from aggregate owner balances; lock creation and release maintain `lockedStake <= stakeBalance`.
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
     * @dev Direct transfers and settlement transfers are unaccounted until funded. The subtraction saturates at zero, so
     *      an external token-balance deficit is not represented as a negative value and remains an insolvency condition.
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
     * @dev Validates common creation requirements without changing accounting. A lock ID may be reused only after its
     *      previous lock has been deleted by unlock or resolution.
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
     * @dev Writes a previously validated new lock and increases the owner's aggregate locked principal.
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
     * @dev Loads and deletes one active lock, returning its complete principal to the owner's free subtotal. Callers may
     *      subsequently move some of that principal into claims as part of the same transaction.
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
