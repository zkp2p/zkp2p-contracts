// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IStakeVault} from "./interfaces/IStakeVault.sol";

/**
 * @title StakeVault
 * @notice Policy-agnostic custody, delegation, lock, and immediately claimable token accounting.
 *
 * @dev ACCOUNTING MODEL
 *      Stake principal belongs to a `stakeOwner` and is split into locked and free amounts:
 *
 *        freeStake(owner) = stakeBalance(owner) - lockedStake(owner)
 *        totalAccounted() = totalStaked + totalClaimable
 *
 *      Creating, increasing, resizing, or unlocking a lock only moves principal between locked and free accounting.
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
 *      The vault deliberately knows nothing about intents, fees, chargebacks, or lock purpose. Lock IDs and beneficiary
 *      allocations are opaque controller inputs. A lock maturity prevents further increase or resize once reached, but
 *      does not automatically resolve the lock; the controller remains responsible for choosing whether and how every
 *      lock is unlocked or converted into claims. `NEVER_MATURES` represents exposure requiring an explicit controller
 *      transition on all paths.
 *
 *      Controller replacement is delayed, but accepted authority is global: the new controller immediately gains the
 *      same power over existing and future locks. The owner can cancel a pending handover during the delay and cannot
 *      renounce ownership, preserving a governance recovery path.
 *
 * @dev SECURITY INVARIANTS AND RATIONALE
 *      1. Only free stake may be withdrawn or newly locked. Existing locks remain fully backed in aggregate accounting.
 *      2. Lock IDs are globally unique while active, preventing one owner's lock from colliding with another's.
 *      3. Only the controller can create, resize, unlock, fund, or resolve locks. The controller must enforce all policy,
 *         including whether a named stake owner authorized the economic action; the vault enforces accounting only.
 *      4. Resolution conserves liabilities: claim allocations cannot exceed the lock, and unclaimed remainder stays with
 *         the stake owner rather than being transferred to the controller.
 *      5. Deposits require an exact token balance delta. Funded locks can adopt only balance already held above existing
 *         liabilities, while the controller remains responsible for transfer-specific delta checks. The controller never
 *         takes custody.
 *      6. User withdrawals and claims apply accounting effects before token interactions and are reentrancy guarded.
 *      7. Initializing an omitted controller is allowed only before any stake or claim liabilities exist. Later controller
 *         replacements always use the configured handover delay.
 */
contract StakeVault is IStakeVault, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ============ Constants ============ */

    /// @notice Minimum governance delay allowed for controller replacement.
    uint64 public constant MIN_CONTROLLER_CHANGE_DELAY = 1 days;

    /// @notice Sentinel maturity for locks that must never become mature through passage of practical time.
    uint64 public constant NEVER_MATURES = type(uint64).max;

    /* ============ Immutable Configuration ============ */

    /// @notice Token held and accounted by the vault.
    IERC20 public immutable override stakeToken;

    /// @notice Delay between controller proposal and acceptance eligibility.
    uint64 public immutable override controllerChangeDelay;

    /* ============ Controller State ============ */

    /// @notice Address with authority over every active and future lock.
    address public override controller;

    /// @notice Proposed replacement controller, or zero when no handover is pending.
    address public override pendingController;

    /// @notice Earliest timestamp at which the pending controller may accept authority.
    uint64 public override pendingControllerValidAt;

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

    /* ============ Modifiers ============ */

    /**
     * @dev Restricts lock and claim-allocation transitions to the current global controller.
     */
    modifier onlyController() {
        if (msg.sender != controller) revert UnauthorizedController(msg.sender);
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Creates a token vault with an optional initial controller and delayed controller replacement.
     * @dev `_controller` may be zero to break circular deployment dependencies; it can then be initialized exactly once
     *      before any liabilities exist. The owner and token must be non-zero, and the handover delay must be at least
     *      one day. Future ownership transfers use Ownable2Step.
     * @param _owner Governance owner responsible for controller selection and recovery.
     * @param _stakeToken Token held and accounted by the vault.
     * @param _controller Initial global lock-policy controller, or zero for later liability-free initialization.
     * @param _controllerChangeDelay Delay required before a proposed replacement controller may accept authority.
     */
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

    /* ============ User Stake and Claim Accounting ============ */

    /**
     * @notice Deposits stake-token principal owned exclusively by the caller.
     * @dev Pulls exactly `_amount` from the caller and verifies the vault's balance increased by that amount before
     *      crediting stake. Fee-on-transfer and rebasing behavior that changes the observed delta is rejected. Deposited
     *      principal begins as free stake and does not affect delegation selections or authorizations.
     * @param _amount Amount of stake token to transfer into and credit within the vault.
     */
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

    /**
     * @notice Withdraws caller-owned free stake directly to the caller.
     * @dev Reverts unless the complete amount is free; active locks are never implicitly matured, resolved, or resized.
     *      Accounting is reduced before the token transfer and the function is reentrancy guarded.
     * @param _amount Amount of free stake principal to withdraw.
     */
    function withdrawStake(uint256 _amount) external override nonReentrant {
        if (_amount == 0) revert ZeroAmount();
        uint256 available = freeStake(msg.sender);
        if (available < _amount) revert InsufficientFreeStake(msg.sender, available, _amount);

        stakeBalance[msg.sender] -= _amount;
        totalStaked -= _amount;
        emit StakeWithdrawn(msg.sender, _amount, stakeBalance[msg.sender]);
        stakeToken.safeTransfer(msg.sender, _amount);
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
     * @param _maturesAt Timestamp after which this lock can no longer be increased or resized.
     */
    function lockStake(address _stakeOwner, bytes32 _lockId, uint256 _amount, uint64 _maturesAt)
        external
        override
        onlyController
    {
        _validateNewLock(_stakeOwner, _lockId, _amount, _maturesAt);
        _consumeFreeStake(_stakeOwner, _amount);
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
     * @param _maturesAt Timestamp after which this lock can no longer be increased or resized.
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
     * @notice CONTROLLER ONLY: Adds owner free stake to an active lock without changing its maturity.
     * @dev The lock must exist and remain strictly before maturity. Only the incremental amount is checked against the
     *      owner's current free stake; principal and aggregate stake liabilities are unchanged.
     * @param _lockId Identifier of the active lock to increase.
     * @param _additionalAmount Non-zero amount of owner free stake to add.
     */
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

    /**
     * @notice CONTROLLER ONLY: Decreases an active lock and replaces its maturity.
     * @dev The existing lock must not already be mature, the new maturity must be strictly in the future, and the new
     *      non-zero amount cannot exceed the current amount. A same-amount call may retime the lock; increases must use
     *      `increaseLock`. Any removed amount immediately becomes free stake of the original owner.
     * @param _lockId Identifier of the active lock to resize.
     * @param _newAmount New non-zero locked amount, less than or equal to the current amount.
     * @param _newMaturesAt Replacement maturity timestamp.
     */
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

    /**
     * @notice CONTROLLER ONLY: Deletes an active lock and returns its complete amount to owner free stake.
     * @dev Unlocking is permitted before or after maturity because business policy belongs to the controller. No stake or
     *      aggregate liability changes; only the lock record and owner's locked subtotal are reduced.
     * @param _lockId Identifier of the active lock to delete.
     */
    function unlockStake(bytes32 _lockId) external override onlyController {
        StakeLock memory stakeLock = _takeLock(_lockId);
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

    /* ============ Controller Governance ============ */

    /**
     * @notice GOVERNANCE ONLY: Initializes controller authority when deployment intentionally omitted a controller.
     * @dev This path is available only while `controller` is zero and both aggregate stake and claim liabilities are zero.
     *      The liability check prevents governance from bypassing delayed handover after user funds are accounted. Once
     *      initialized, every subsequent replacement must use proposal and delayed acceptance.
     * @param _controller Non-zero initial controller address.
     */
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
     * @notice Ownership renunciation is disabled so governance always retains a delayed controller recovery path.
     * @dev Always reverts for the owner; non-owners revert through the inherited ownership check first.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /**
     * @notice GOVERNANCE ONLY: Proposes a replacement global controller subject to the immutable handover delay.
     * @dev A new proposal overwrites any existing proposal and restarts the full delay. The current controller remains
     *      authoritative until the proposed controller accepts after `pendingControllerValidAt`.
     * @param _controller Non-zero address proposed to receive global lock authority.
     */
    function proposeController(address _controller) external override onlyOwner {
        if (_controller == address(0)) revert ZeroAddress();
        uint64 currentTime = _currentTimestamp();
        uint64 validAt = currentTime + controllerChangeDelay;
        pendingController = _controller;
        pendingControllerValidAt = validAt;
        emit ControllerProposed(controller, _controller, validAt);
    }

    /**
     * @notice GOVERNANCE ONLY: Cancels the active controller replacement proposal.
     * @dev Leaves the current controller unchanged and clears both pending-controller fields.
     */
    function cancelControllerProposal() external override onlyOwner {
        address proposedController = pendingController;
        if (proposedController == address(0)) revert NoPendingController();
        delete pendingController;
        delete pendingControllerValidAt;
        emit ControllerProposalCancelled(proposedController);
    }

    /**
     * @notice PENDING CONTROLLER ONLY: Accepts global lock authority after the handover delay.
     * @dev The caller must equal the pending controller and the current timestamp must be at least the proposal's valid
     *      timestamp. Acceptance immediately grants authority over all existing and future locks, then clears proposal
     *      state. Governance cannot accept on the proposed controller's behalf.
     */
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

    /* ============ Views ============ */

    /**
     * @notice Resolves the stake owner used for a taker's future controller policy reads.
     * @dev Returns the selected owner only while its authorization remains live; otherwise returns the taker itself.
     *      Existing locks are independent of this live lookup and retain the owner stored in each lock.
     * @param _taker Taker whose effective stake owner should be resolved.
     * @return Effective stake owner for future policy decisions.
     */
    function stakeOwnerOf(address _taker) external view override returns (address) {
        address selectedOwner = selectedStakeOwner[_taker];
        if (selectedOwner != address(0) && authorizedTakers[selectedOwner][_taker]) return selectedOwner;
        return _taker;
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
     * @notice Returns whether an existing lock has reached or passed its recorded maturity.
     * @dev Returns false for an unknown lock. Maturity does not automatically unlock or resolve principal; it only blocks
     *      later increase and resize operations and can be used by controller policy to authorize a terminal transition.
     * @param _lockId Identifier of the lock to inspect.
     * @return True when the lock exists and its maturity is not later than the current block timestamp.
     */
    function isLockMature(bytes32 _lockId) external view override returns (bool) {
        StakeLock memory stakeLock = locks[_lockId];
        return stakeLock.stakeOwner != address(0) && block.timestamp >= stakeLock.maturesAt;
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
        _validateMaturity(_maturesAt, _currentTimestamp());
    }

    /**
     * @dev Enforces a strictly future maturity; equality is already mature and therefore invalid for a new lock state.
     * @param _maturesAt Proposed lock maturity.
     * @param _currentTime Current checked timestamp.
     */
    function _validateMaturity(uint64 _maturesAt, uint64 _currentTime) internal pure {
        if (_maturesAt <= _currentTime) revert InvalidMaturity(_maturesAt, _currentTime);
    }

    /**
     * @dev Verifies that an owner can commit the requested principal. The subsequent lock write performs the accounting
     *      transition by increasing `lockedStake`; this helper itself is intentionally read-only.
     * @param _stakeOwner Owner whose free stake backs the operation.
     * @param _amount Amount of free stake required.
     */
    function _consumeFreeStake(address _stakeOwner, uint256 _amount) internal view {
        uint256 available = freeStake(_stakeOwner);
        if (available < _amount) revert InsufficientFreeStake(_stakeOwner, available, _amount);
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
        lockedStake[_stakeOwner] += _amount;
        emit StakeLocked(_lockId, _stakeOwner, _amount, _maturesAt, lockedStake[_stakeOwner]);
    }

    /**
     * @dev Loads and deletes one active lock, returning its complete principal to the owner's free subtotal. Callers may
     *      subsequently move some of that principal into claims as part of the same transaction.
     * @param _lockId Identifier of the active lock to consume.
     * @return stakeLock Deleted lock snapshot used by the caller's terminal accounting.
     */
    function _takeLock(bytes32 _lockId) internal returns (StakeLock memory stakeLock) {
        stakeLock = locks[_lockId];
        if (stakeLock.stakeOwner == address(0)) revert LockNotFound(_lockId);
        delete locks[_lockId];
        lockedStake[stakeLock.stakeOwner] -= stakeLock.amount;
    }

    /**
     * @dev Returns the current block timestamp after checked narrowing to the lock timestamp width.
     * @return Current EVM timestamp represented as `uint64`.
     */
    function _currentTimestamp() internal view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow(block.timestamp);
        return uint64(block.timestamp);
    }
}
