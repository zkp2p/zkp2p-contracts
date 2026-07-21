// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { IStakeVault } from "./interfaces/IStakeVault.sol";

/**
 * @title StakeVault
 * @notice Stable, policy-agnostic USDC accounting for taker stake, reservations, and deferred fee claims.
 * @dev The controller decides why funds are reserved or slashed. The vault only enforces accounting,
 *      exit, maturity, and solvency rules. User and maker withdrawals remain available while stake
 *      admission is paused.
 */
contract StakeVault is IStakeVault, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ============ Constants ============ */

    uint64 public constant MIN_CONTROLLER_CHANGE_DELAY = 1 days;

    /* ============ State Variables ============ */

    IERC20 public immutable override stakeToken;
    uint64 public immutable baseExitDelay;
    uint64 public immutable controllerChangeDelay;

    address public override controller;
    address public pendingController;
    uint64 public pendingControllerValidAt;

    bool public depositsPaused;
    bool public reservationsPaused;

    mapping(address => uint256) public override stakeBalance;
    mapping(address => uint256) public override reservedStake;
    mapping(address => address) internal delegatedStakeOwners;
    mapping(address => bool) internal stakeDelegationDisabled;
    mapping(address => address) internal allowedStakeOwners;
    mapping(address => ExitRequest) internal exitRequests;
    mapping(address => StakeWithdrawalRequest) internal stakeWithdrawalRequests;
    mapping(bytes32 => Reservation) internal reservations;
    mapping(bytes32 => DeferredStake) internal deferredStakes;
    mapping(bytes32 => IIntentRiskHook.FeeAllocation[]) internal deferredFeeAllocations;
    mapping(address => uint256) public override claimableCompensation;
    mapping(address => uint256) public override claimableFees;

    uint256 public totalStaked;
    uint256 public override totalDeferredFees;
    uint256 public totalClaimableCompensation;
    uint256 public override totalClaimableFees;

    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroAmount();
    error EmptyBatch();
    error InvalidTaker(address taker);
    error TakerAlreadyAuthorized(address taker, address stakeOwner);
    error TakerAuthorizationNotFound(address taker, address stakeOwner);
    error NoDelegatedStakeOwner(address taker);
    error StakeDelegationDisabled(address taker);
    error StakeOwnerNotAllowed(address taker, address stakeOwner, address allowedStakeOwner);
    error UnauthorizedController(address caller);
    error UnauthorizedPositionController(address caller, address expectedController);
    error StakeActionPaused();
    error AlreadyExiting(address staker);
    error NotExiting(address staker);
    error ExitNotReady(uint64 availableAt, uint64 currentTime);
    error StakeWithdrawalAlreadyRequested(address stakeOwner, uint256 amount);
    error StakeWithdrawalNotFound(address stakeOwner);
    error StakeWithdrawalNotReady(uint64 availableAt, uint64 currentTime);
    error PendingStakeWithdrawal(address stakeOwner, uint256 amount);
    error ActiveReservations(address staker, uint256 reservedAmount);
    error InsufficientFreeStake(address staker, uint256 available, uint256 required);
    error ReservationAlreadyExists(bytes32 intentHash);
    error ReservationNotFound(bytes32 intentHash);
    error InvalidReservationAmount(uint256 amount, uint256 reservedAmount);
    error DeferredStakeAlreadyExists(bytes32 intentHash);
    error DeferredStakeNotFound(bytes32 intentHash);
    error DeferredStakeAlreadyFunded(bytes32 intentHash, uint256 amount);
    error DeferredStakeOwnerMismatch(address expected, address actual);
    error DeferredStakeNotMature(uint64 releaseTime, uint64 currentTime);
    error InvalidDeferredFeeTotal(uint256 grossAmount, uint256 feeAmount);
    error InsufficientUnaccountedTokens(uint256 available, uint256 required);
    error UnexpectedTokenAmount(uint256 expected, uint256 received);
    error InvalidControllerChangeDelay(uint64 delay);
    error ControllerAlreadyInitialized(address controller);
    error ControllerProposalNotReady(uint64 validAt, uint64 currentTime);
    error NoPendingController();

    /* ============ Modifiers ============ */

    modifier onlyController() {
        if (msg.sender != controller) revert UnauthorizedController(msg.sender);
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Creates a vault with an initial controller and delayed controller handover.
     * @param _owner Governance owner.
     * @param _stakeToken USDC-compatible token held by the vault.
     * @param _controller Initial risk-policy controller.
     * @param _baseExitDelay Minimum delay after a full-exit request.
     * @param _controllerChangeDelay Delay before a proposed controller may accept control.
     */
    constructor(
        address _owner,
        IERC20 _stakeToken,
        address _controller,
        uint64 _baseExitDelay,
        uint64 _controllerChangeDelay
    ) Ownable() {
        if (_owner == address(0) || address(_stakeToken) == address(0)) {
            revert ZeroAddress();
        }
        if (_controllerChangeDelay < MIN_CONTROLLER_CHANGE_DELAY) {
            revert InvalidControllerChangeDelay(_controllerChangeDelay);
        }

        stakeToken = _stakeToken;
        controller = _controller;
        baseExitDelay = _baseExitDelay;
        controllerChangeDelay = _controllerChangeDelay;

        transferOwnership(_owner);
    }

    /* ============ User Functions ============ */

    /**
     * @notice Deposits membership stake for the caller.
     * @param _amount Amount of stake token to deposit.
     */
    function depositStake(uint256 _amount) external override nonReentrant {
        _depositStake(msg.sender, _amount);
    }

    /**
     * @notice Deposits stake owned by the caller and authorizes a taker to use it.
     * @dev The caller remains the stake owner and retains all withdrawal rights.
     * @param _taker Address that may use the caller's stake for future intents.
     * @param _amount Amount of stake token to deposit.
     */
    function depositStakeFor(address _taker, uint256 _amount) external override nonReentrant {
        _setTakerAuthorization(msg.sender, _taker, true);
        _depositStake(msg.sender, _amount);
    }

    /**
     * @notice Authorizes or revokes a taker's use of the caller's stake for future intents.
     * @dev Existing risk positions retain the stake owner snapshotted at admission.
     * @param _taker Address whose authorization is being updated.
     * @param _authorized True to authorize the taker, false to revoke it.
     */
    function setTakerAuthorization(address _taker, bool _authorized) external override {
        _setTakerAuthorization(msg.sender, _taker, _authorized);
    }

    /**
     * @notice Authorizes or revokes multiple takers for the caller's stake.
     * @param _takers Addresses whose authorizations are being updated.
     * @param _authorized True to authorize every taker, false to revoke them.
     */
    function setTakerAuthorizations(address[] calldata _takers, bool _authorized) external override {
        if (_takers.length == 0) revert EmptyBatch();

        for (uint256 takerIndex = 0; takerIndex < _takers.length; takerIndex++) {
            _setTakerAuthorization(msg.sender, _takers[takerIndex], _authorized);
        }
    }

    /**
     * @notice Clears the caller's delegated stake owner for future intents.
     * @dev Existing risk positions remain backed by their snapshotted stake owner. New delegations
     *      stay disabled until the caller explicitly re-enables them, preventing forced reassignment.
     */
    function clearStakeOwner() external override {
        address stakeOwner = delegatedStakeOwners[msg.sender];
        if (stakeOwner == address(0)) revert NoDelegatedStakeOwner(msg.sender);

        delete delegatedStakeOwners[msg.sender];
        stakeDelegationDisabled[msg.sender] = true;
        delete allowedStakeOwners[msg.sender];
        emit TakerAuthorizationUpdated(stakeOwner, msg.sender, false);
        emit StakeDelegationEnabledUpdated(msg.sender, false);
        emit AllowedStakeOwnerUpdated(msg.sender, address(0));
    }

    /**
     * @notice Enables or disables third-party stake delegation for the caller's future intents.
     * @dev Delegation is enabled by default so a Safe may authorize its relayer in one transaction.
     *      Disabling delegation does not alter an existing assignment; use clearStakeOwner for that.
     * @param _enabled True to accept future assignments, false to reject them.
     */
    function setStakeDelegationEnabled(bool _enabled) external override {
        stakeDelegationDisabled[msg.sender] = !_enabled;
        if (_enabled && allowedStakeOwners[msg.sender] != address(0)) {
            delete allowedStakeOwners[msg.sender];
            emit AllowedStakeOwnerUpdated(msg.sender, address(0));
        }
        emit StakeDelegationEnabledUpdated(msg.sender, _enabled);
    }

    /**
     * @notice Restricts the caller's future stake assignment to one exact stake owner.
     * @dev This atomically removes a different current assignment, so a taker can recover from
     *      squatting without briefly reopening delegation to every address.
     * @param _stakeOwner Only address allowed to authorize stake for the caller.
     */
    function setAllowedStakeOwner(address _stakeOwner) external override {
        if (_stakeOwner == address(0) || _stakeOwner == msg.sender) revert InvalidTaker(_stakeOwner);

        address currentStakeOwner = delegatedStakeOwners[msg.sender];
        if (currentStakeOwner != address(0) && currentStakeOwner != _stakeOwner) {
            delete delegatedStakeOwners[msg.sender];
            emit TakerAuthorizationUpdated(currentStakeOwner, msg.sender, false);
        }

        allowedStakeOwners[msg.sender] = _stakeOwner;
        stakeDelegationDisabled[msg.sender] = false;
        emit AllowedStakeOwnerUpdated(msg.sender, _stakeOwner);
        emit StakeDelegationEnabledUpdated(msg.sender, true);
    }

    /**
     * @notice Requests a delayed withdrawal of currently unreserved stake.
     * @dev The requested amount immediately stops contributing to reservation eligibility and free stake.
     * @param _amount Amount of stake token to withdraw after the delay.
     */
    function requestStakeWithdrawal(uint256 _amount) external override {
        if (_amount == 0) revert ZeroAmount();
        if (exitRequests[msg.sender].exiting) revert AlreadyExiting(msg.sender);

        StakeWithdrawalRequest memory existingRequest = stakeWithdrawalRequests[msg.sender];
        if (existingRequest.amount != 0) {
            revert StakeWithdrawalAlreadyRequested(msg.sender, existingRequest.amount);
        }

        uint256 available = freeStake(msg.sender);
        if (_amount > available) revert InsufficientFreeStake(msg.sender, available, _amount);

        uint64 requestedAt = uint64(block.timestamp);
        uint64 availableAt = requestedAt + baseExitDelay;
        stakeWithdrawalRequests[msg.sender] = StakeWithdrawalRequest({
            amount: _amount,
            requestedAt: requestedAt,
            availableAt: availableAt
        });

        emit StakeWithdrawalRequested(msg.sender, _amount, requestedAt, availableAt);
    }

    /**
     * @notice Cancels the caller's pending partial stake withdrawal.
     */
    function cancelStakeWithdrawal() external override {
        StakeWithdrawalRequest memory withdrawalRequest = stakeWithdrawalRequests[msg.sender];
        if (withdrawalRequest.amount == 0) revert StakeWithdrawalNotFound(msg.sender);

        delete stakeWithdrawalRequests[msg.sender];
        emit StakeWithdrawalCancelled(msg.sender, withdrawalRequest.amount);
    }

    /**
     * @notice Withdraws the caller's requested stake after the delay.
     * @param _recipient Address receiving the stake token.
     */
    function withdrawRequestedStake(address _recipient) external override nonReentrant {
        if (_recipient == address(0)) revert ZeroAddress();

        StakeWithdrawalRequest memory withdrawalRequest = stakeWithdrawalRequests[msg.sender];
        if (withdrawalRequest.amount == 0) revert StakeWithdrawalNotFound(msg.sender);
        if (block.timestamp < withdrawalRequest.availableAt) {
            revert StakeWithdrawalNotReady(withdrawalRequest.availableAt, uint64(block.timestamp));
        }

        delete stakeWithdrawalRequests[msg.sender];
        stakeBalance[msg.sender] -= withdrawalRequest.amount;
        totalStaked -= withdrawalRequest.amount;

        stakeToken.safeTransfer(_recipient, withdrawalRequest.amount);
        emit StakeWithdrawn(msg.sender, _recipient, withdrawalRequest.amount);
    }

    function _depositStake(address _stakeOwner, uint256 _amount) internal {
        if (depositsPaused) revert StakeActionPaused();
        if (_amount == 0) revert ZeroAmount();

        uint256 balanceBefore = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(msg.sender, address(this), _amount);
        uint256 received = stakeToken.balanceOf(address(this)) - balanceBefore;
        if (received != _amount) revert UnexpectedTokenAmount(_amount, received);

        stakeBalance[_stakeOwner] += _amount;
        totalStaked += _amount;

        emit StakeDeposited(_stakeOwner, _amount, stakeBalance[_stakeOwner]);
    }

    /**
     * @notice Requests a full exit and immediately blocks new reservations for the caller.
     */
    function requestExit() external override {
        if (stakeBalance[msg.sender] == 0) revert ZeroAmount();
        if (exitRequests[msg.sender].exiting) revert AlreadyExiting(msg.sender);
        uint256 pendingWithdrawal = stakeWithdrawalRequests[msg.sender].amount;
        if (pendingWithdrawal != 0) revert PendingStakeWithdrawal(msg.sender, pendingWithdrawal);

        uint64 requestedAt = uint64(block.timestamp);
        uint64 availableAt = requestedAt + baseExitDelay;
        exitRequests[msg.sender] = ExitRequest({ exiting: true, requestedAt: requestedAt, availableAt: availableAt });

        emit ExitRequested(msg.sender, requestedAt, availableAt);
    }

    /**
     * @notice Cancels an outstanding exit request and restores admission eligibility.
     */
    function cancelExit() external override {
        if (!exitRequests[msg.sender].exiting) revert NotExiting(msg.sender);

        delete exitRequests[msg.sender];
        emit ExitCancelled(msg.sender);
    }

    /**
     * @notice Withdraws the caller's entire remaining stake after the exit delay and all reservations settle.
     * @param _recipient Address receiving the stake token.
     */
    function withdrawStake(address _recipient) external override nonReentrant {
        if (_recipient == address(0)) revert ZeroAddress();

        ExitRequest memory exitRequest = exitRequests[msg.sender];
        if (!exitRequest.exiting) revert NotExiting(msg.sender);
        if (block.timestamp < exitRequest.availableAt) {
            revert ExitNotReady(exitRequest.availableAt, uint64(block.timestamp));
        }

        uint256 activeReservedStake = reservedStake[msg.sender];
        if (activeReservedStake != 0) revert ActiveReservations(msg.sender, activeReservedStake);

        uint256 amount = stakeBalance[msg.sender];
        if (amount == 0) revert ZeroAmount();

        delete exitRequests[msg.sender];
        delete stakeBalance[msg.sender];
        totalStaked -= amount;

        stakeToken.safeTransfer(_recipient, amount);
        emit StakeWithdrawn(msg.sender, _recipient, amount);
    }

    /**
     * @notice Withdraws all maker compensation credited to the caller.
     * @param _recipient Address receiving the stake token.
     */
    function withdrawCompensation(address _recipient) external override nonReentrant {
        if (_recipient == address(0)) revert ZeroAddress();

        uint256 amount = claimableCompensation[msg.sender];
        if (amount == 0) revert ZeroAmount();

        delete claimableCompensation[msg.sender];
        totalClaimableCompensation -= amount;

        stakeToken.safeTransfer(_recipient, amount);
        emit CompensationWithdrawn(msg.sender, _recipient, amount);
    }

    /** @notice Withdraws every matured deferred fee claim owned by the caller. */
    function withdrawFeeClaim(address _recipient) external override nonReentrant {
        _withdrawFeeClaim(msg.sender, _recipient);
    }

    /** @notice Permissionlessly transfers a beneficiary's matured fee claims to that beneficiary. */
    function withdrawFeeClaimFor(address _beneficiary) external override nonReentrant {
        _withdrawFeeClaim(_beneficiary, _beneficiary);
    }

    function _withdrawFeeClaim(address _beneficiary, address _recipient) internal {
        if (_beneficiary == address(0) || _recipient == address(0)) revert ZeroAddress();

        uint256 amount = claimableFees[_beneficiary];
        if (amount == 0) revert ZeroAmount();

        delete claimableFees[_beneficiary];
        totalClaimableFees -= amount;
        stakeToken.safeTransfer(_recipient, amount);

        emit FeeClaimWithdrawn(_beneficiary, _recipient, amount);
    }

    /* ============ Controller Functions ============ */

    /**
     * @notice Reserves free membership stake for one risk position.
     */
    function reserveStake(
        address _staker,
        bytes32 _intentHash,
        uint256 _amount,
        uint64 _releaseTime
    ) external override onlyController {
        if (reservationsPaused) revert StakeActionPaused();
        if (_staker == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();
        if (exitRequests[_staker].exiting) revert AlreadyExiting(_staker);
        if (reservations[_intentHash].active) revert ReservationAlreadyExists(_intentHash);

        uint256 available = freeStake(_staker);
        if (_amount > available) revert InsufficientFreeStake(_staker, available, _amount);

        reservations[_intentHash] = Reservation({
            staker: _staker,
            controller: msg.sender,
            amount: _amount,
            releaseTime: _releaseTime,
            active: true
        });
        reservedStake[_staker] += _amount;

        emit StakeReserved(_intentHash, _staker, msg.sender, _amount, reservedStake[_staker], _releaseTime);
    }

    /**
     * @notice Adds free stake to an active reservation while enforcing admission pause and exit gates.
     * @dev Settlement uses `updateReservation`, which intentionally remains available during a pause.
     *      New paid extension exposure must use this function instead.
     */
    function increaseReservation(
        bytes32 _positionId,
        uint256 _amount,
        uint64 _releaseTime
    ) external override onlyController {
        if (reservationsPaused) revert StakeActionPaused();
        if (_amount == 0) revert ZeroAmount();

        Reservation storage reservation = reservations[_positionId];
        if (!reservation.active) revert ReservationNotFound(_positionId);
        _requirePositionController(reservation.controller);
        if (exitRequests[reservation.staker].exiting) revert AlreadyExiting(reservation.staker);

        uint256 available = freeStake(reservation.staker);
        if (_amount > available) {
            revert InsufficientFreeStake(reservation.staker, available, _amount);
        }

        uint256 previousAmount = reservation.amount;
        uint256 newAmount = previousAmount + _amount;
        reservation.amount = newAmount;
        reservation.releaseTime = _releaseTime;
        reservedStake[reservation.staker] += _amount;

        emit StakeReservationUpdated(
            _positionId,
            reservation.staker,
            previousAmount,
            newAmount,
            reservedStake[reservation.staker],
            _releaseTime
        );
    }

    /**
     * @notice Replaces a reservation amount and maturity after exact release accounting is known.
     */
    function updateReservation(
        bytes32 _intentHash,
        uint256 _newAmount,
        uint64 _releaseTime
    ) external override {
        Reservation storage reservation = reservations[_intentHash];
        if (!reservation.active) revert ReservationNotFound(_intentHash);
        _requirePositionController(reservation.controller);
        if (_newAmount == 0) revert ZeroAmount();

        uint256 previousAmount = reservation.amount;
        if (_newAmount > previousAmount) {
            uint256 increase = _newAmount - previousAmount;
            uint256 available = freeStake(reservation.staker);
            if (increase > available) revert InsufficientFreeStake(reservation.staker, available, increase);
            reservedStake[reservation.staker] += increase;
        } else if (_newAmount < previousAmount) {
            reservedStake[reservation.staker] -= previousAmount - _newAmount;
        }

        reservation.amount = _newAmount;
        reservation.releaseTime = _releaseTime;

        emit StakeReservationUpdated(
            _intentHash,
            reservation.staker,
            previousAmount,
            _newAmount,
            reservedStake[reservation.staker],
            _releaseTime
        );
    }

    /**
     * @notice Releases an active reservation without slashing stake.
     */
    function releaseReservation(bytes32 _intentHash) external override {
        Reservation memory reservation = reservations[_intentHash];
        if (!reservation.active) revert ReservationNotFound(_intentHash);
        _requirePositionController(reservation.controller);

        delete reservations[_intentHash];
        reservedStake[reservation.staker] -= reservation.amount;

        emit StakeReservationReleased(
            _intentHash,
            reservation.staker,
            reservation.amount,
            reservedStake[reservation.staker]
        );
    }

    /**
     * @notice Slashes part of a reservation, retains remaining coverage, and credits maker compensation.
     */
    function slashReservation(
        bytes32 _intentHash,
        address _maker,
        uint256 _amount
    ) external override {
        if (_maker == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();

        Reservation storage reservation = reservations[_intentHash];
        if (!reservation.active) revert ReservationNotFound(_intentHash);
        _requirePositionController(reservation.controller);
        if (_amount > reservation.amount) revert InvalidReservationAmount(_amount, reservation.amount);

        address staker = reservation.staker;
        uint256 remainingReservation = reservation.amount - _amount;
        if (remainingReservation == 0) {
            delete reservations[_intentHash];
        } else {
            reservation.amount = remainingReservation;
        }

        reservedStake[staker] -= _amount;
        stakeBalance[staker] -= _amount;
        totalStaked -= _amount;

        _creditCompensation(_intentHash, _maker, _amount);

        emit StakeSlashed(
            _intentHash,
            staker,
            _maker,
            _amount,
            stakeBalance[staker],
            remainingReservation
        );
    }

    /**
     * @notice Snapshots the current controller for a deferred position before any proceeds exist.
     * @dev Admission is blocked while reservations are paused. Later terminal accounting remains
     *      available to the snapshotted controller even after a pause or controller handover.
     */
    function authorizeDeferredStake(
        bytes32 _intentHash,
        address _staker,
        uint64 _releaseTime
    ) external override onlyController {
        if (reservationsPaused) revert StakeActionPaused();
        if (_staker == address(0)) revert ZeroAddress();
        if (exitRequests[_staker].exiting) revert AlreadyExiting(_staker);
        if (deferredStakes[_intentHash].staker != address(0)) revert DeferredStakeAlreadyExists(_intentHash);

        deferredStakes[_intentHash] = DeferredStake({
            staker: _staker,
            controller: msg.sender,
            grossAmount: 0,
            feeAmount: 0,
            releaseTime: _releaseTime,
            funded: false
        });

        emit DeferredStakeAuthorized(_intentHash, _staker, msg.sender, _releaseTime);
    }

    /**
     * @notice Removes an unfunded deferred-position authorization after cancellation.
     */
    function releaseDeferredStakeAuthorization(bytes32 _intentHash) external override {
        DeferredStake memory deferredStake = deferredStakes[_intentHash];
        if (deferredStake.staker == address(0)) revert DeferredStakeNotFound(_intentHash);
        _requirePositionController(deferredStake.controller);
        if (deferredStake.funded) revert DeferredStakeAlreadyFunded(_intentHash, deferredStake.grossAmount);

        delete deferredStakes[_intentHash];
        emit DeferredStakeAuthorizationReleased(_intentHash, deferredStake.staker, deferredStake.controller);
    }

    /**
     * @notice Converts a gross deferred settlement already transferred into the vault into fully reserved stake.
     * @dev The gross amount is immediately part of `stakeBalance`, while the full amount remains reserved until
     *      chargeback or maturity. Fee allocations vest only at clean maturity; before then the maker can receive
     *      the full gross amount through a slash.
     */
    function recordDeferredStake(
        bytes32 _intentHash,
        address _staker,
        uint256 _grossAmount,
        uint64 _releaseTime,
        IIntentRiskHook.FeeAllocation[] calldata _feeAllocations
    ) external override {
        if (_staker == address(0)) revert ZeroAddress();
        if (_grossAmount == 0) revert ZeroAmount();

        DeferredStake storage deferredStake = deferredStakes[_intentHash];
        if (deferredStake.staker == address(0)) revert DeferredStakeNotFound(_intentHash);
        _requirePositionController(deferredStake.controller);
        if (deferredStake.funded) revert DeferredStakeAlreadyFunded(_intentHash, deferredStake.grossAmount);
        if (_staker != deferredStake.staker) {
            revert DeferredStakeOwnerMismatch(deferredStake.staker, _staker);
        }
        if (reservations[_intentHash].active) revert ReservationAlreadyExists(_intentHash);

        uint256 feeAmount;
        for (uint256 allocationIndex = 0; allocationIndex < _feeAllocations.length; allocationIndex++) {
            IIntentRiskHook.FeeAllocation calldata allocation = _feeAllocations[allocationIndex];
            if (allocation.recipient == address(0)) revert ZeroAddress();
            if (allocation.amount == 0) continue;
            feeAmount += allocation.amount;
        }
        if (feeAmount >= _grossAmount) revert InvalidDeferredFeeTotal(_grossAmount, feeAmount);

        uint256 accountedBefore = totalLiabilities();
        uint256 vaultBalance = stakeToken.balanceOf(address(this));
        uint256 unaccounted = vaultBalance > accountedBefore ? vaultBalance - accountedBefore : 0;
        if (_grossAmount > unaccounted) revert InsufficientUnaccountedTokens(unaccounted, _grossAmount);

        deferredStake.grossAmount = _grossAmount;
        deferredStake.feeAmount = feeAmount;
        deferredStake.releaseTime = _releaseTime;
        deferredStake.funded = true;
        for (uint256 allocationIndex = 0; allocationIndex < _feeAllocations.length; allocationIndex++) {
            if (_feeAllocations[allocationIndex].amount != 0) {
                deferredFeeAllocations[_intentHash].push(_feeAllocations[allocationIndex]);
            }
        }

        reservations[_intentHash] = Reservation({
            staker: _staker,
            controller: deferredStake.controller,
            amount: _grossAmount,
            releaseTime: _releaseTime,
            active: true
        });
        stakeBalance[_staker] += _grossAmount;
        reservedStake[_staker] += _grossAmount;
        totalStaked += _grossAmount;
        totalDeferredFees += feeAmount;

        emit StakeReserved(
            _intentHash,
            _staker,
            deferredStake.controller,
            _grossAmount,
            reservedStake[_staker],
            _releaseTime
        );
        emit DeferredStakeFunded(
            _intentHash,
            _staker,
            _grossAmount,
            feeAmount,
            _grossAmount - feeAmount,
            _releaseTime
        );
    }

    /** @notice Vests deferred fee claims and releases the remaining net amount as reusable stake. */
    function releaseDeferredStake(bytes32 _intentHash) external override {
        DeferredStake memory deferredStake = deferredStakes[_intentHash];
        if (deferredStake.staker == address(0) || !deferredStake.funded) {
            revert DeferredStakeNotFound(_intentHash);
        }
        _requirePositionController(deferredStake.controller);
        if (block.timestamp < deferredStake.releaseTime) {
            revert DeferredStakeNotMature(deferredStake.releaseTime, uint64(block.timestamp));
        }

        Reservation memory reservation = reservations[_intentHash];
        if (!reservation.active || reservation.amount != deferredStake.grossAmount) {
            revert InvalidReservationAmount(reservation.amount, deferredStake.grossAmount);
        }

        delete reservations[_intentHash];
        reservedStake[deferredStake.staker] -= deferredStake.grossAmount;
        stakeBalance[deferredStake.staker] -= deferredStake.feeAmount;
        totalStaked -= deferredStake.feeAmount;
        totalDeferredFees -= deferredStake.feeAmount;

        IIntentRiskHook.FeeAllocation[] storage allocations = deferredFeeAllocations[_intentHash];
        for (uint256 allocationIndex = 0; allocationIndex < allocations.length; allocationIndex++) {
            IIntentRiskHook.FeeAllocation storage allocation = allocations[allocationIndex];
            claimableFees[allocation.recipient] += allocation.amount;
            totalClaimableFees += allocation.amount;
            emit DeferredFeeVested(
                _intentHash,
                allocation.recipient,
                allocation.feeType,
                allocation.amount,
                claimableFees[allocation.recipient]
            );
        }

        delete deferredFeeAllocations[_intentHash];
        delete deferredStakes[_intentHash];

        emit StakeReservationReleased(
            _intentHash,
            deferredStake.staker,
            deferredStake.grossAmount,
            reservedStake[deferredStake.staker]
        );
        emit DeferredStakeReleased(
            _intentHash,
            deferredStake.staker,
            deferredStake.grossAmount,
            deferredStake.feeAmount,
            deferredStake.grossAmount - deferredStake.feeAmount
        );
    }

    /** @notice Slashes the full gross deferred stake and cancels every contingent fee allocation. */
    function slashDeferredStake(bytes32 _intentHash, address _maker) external override {
        if (_maker == address(0)) revert ZeroAddress();

        DeferredStake memory deferredStake = deferredStakes[_intentHash];
        if (deferredStake.staker == address(0) || !deferredStake.funded) {
            revert DeferredStakeNotFound(_intentHash);
        }
        _requirePositionController(deferredStake.controller);

        Reservation memory reservation = reservations[_intentHash];
        if (!reservation.active || reservation.amount != deferredStake.grossAmount) {
            revert InvalidReservationAmount(reservation.amount, deferredStake.grossAmount);
        }

        delete reservations[_intentHash];
        delete deferredFeeAllocations[_intentHash];
        delete deferredStakes[_intentHash];
        reservedStake[deferredStake.staker] -= deferredStake.grossAmount;
        stakeBalance[deferredStake.staker] -= deferredStake.grossAmount;
        totalStaked -= deferredStake.grossAmount;
        totalDeferredFees -= deferredStake.feeAmount;
        _creditCompensation(_intentHash, _maker, deferredStake.grossAmount);

        emit StakeSlashed(
            _intentHash,
            deferredStake.staker,
            _maker,
            deferredStake.grossAmount,
            stakeBalance[deferredStake.staker],
            0
        );
        emit DeferredStakeSlashed(
            _intentHash,
            deferredStake.staker,
            _maker,
            deferredStake.grossAmount,
            deferredStake.feeAmount
        );
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice Initializes controller authority once after circular deployment dependencies are resolved.
     * @dev This one-time path is available only when the constructor controller was address(0).
     */
    function initializeController(address _controller) external override onlyOwner {
        if (_controller == address(0)) revert ZeroAddress();
        if (controller != address(0)) revert ControllerAlreadyInitialized(controller);

        controller = _controller;
        emit ControllerInitialized(_controller);
    }

    /**
     * @notice Proposes a delayed two-step controller handover.
     */
    function proposeController(address _controller) external override onlyOwner {
        if (_controller == address(0)) revert ZeroAddress();

        pendingController = _controller;
        pendingControllerValidAt = uint64(block.timestamp) + controllerChangeDelay;

        emit ControllerProposed(controller, _controller, pendingControllerValidAt);
    }

    /**
     * @notice Accepts controller authority after the handover delay.
     */
    function acceptController() external override {
        if (pendingController == address(0)) revert NoPendingController();
        if (msg.sender != pendingController) revert UnauthorizedController(msg.sender);
        if (block.timestamp < pendingControllerValidAt) {
            revert ControllerProposalNotReady(pendingControllerValidAt, uint64(block.timestamp));
        }

        address previousController = controller;
        controller = pendingController;
        delete pendingController;
        delete pendingControllerValidAt;

        emit ControllerAccepted(previousController, controller);
    }

    /**
     * @notice Pauses new deposits and/or new stake reservations without blocking withdrawals.
     */
    function setStakeOperationsPaused(bool _depositsPaused, bool _reservationsPaused) external override onlyOwner {
        depositsPaused = _depositsPaused;
        reservationsPaused = _reservationsPaused;
        emit StakeOperationsPausedUpdated(_depositsPaused, _reservationsPaused);
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns stake eligible for new reservations after a pending withdrawal is excluded.
     */
    function eligibleStake(address _staker) public view override returns (uint256) {
        return stakeBalance[_staker] - stakeWithdrawalRequests[_staker].amount;
    }

    /**
     * @notice Returns eligible stake not currently committed to active reservations.
     */
    function freeStake(address _staker) public view override returns (uint256) {
        return eligibleStake(_staker) - reservedStake[_staker];
    }

    /**
     * @notice Returns the stake owner used for a taker's future intents.
     * @dev Takers without a delegation use their own stake.
     */
    function stakeOwnerOf(address _taker) external view override returns (address) {
        address delegatedStakeOwner = delegatedStakeOwners[_taker];
        return delegatedStakeOwner == address(0) ? _taker : delegatedStakeOwner;
    }

    /**
     * @notice Returns whether a taker accepts new third-party stake assignments.
     */
    function stakeDelegationEnabled(address _taker) external view override returns (bool) {
        return !stakeDelegationDisabled[_taker];
    }

    /**
     * @notice Returns the only stake owner a taker currently accepts, or zero when assignments are open.
     */
    function allowedStakeOwner(address _taker) external view override returns (address) {
        return allowedStakeOwners[_taker];
    }

    /**
     * @notice Returns whether a staker has requested full exit.
     */
    function isExiting(address _staker) external view override returns (bool) {
        return exitRequests[_staker].exiting;
    }

    /**
     * @notice Returns the full exit request for a staker.
     */
    function getExitRequest(address _staker) external view override returns (ExitRequest memory) {
        return exitRequests[_staker];
    }

    /**
     * @notice Returns the pending partial withdrawal for a stake owner.
     */
    function getStakeWithdrawalRequest(
        address _staker
    ) external view override returns (StakeWithdrawalRequest memory) {
        return stakeWithdrawalRequests[_staker];
    }

    /**
     * @notice Returns one membership-stake reservation.
     */
    function getReservation(bytes32 _intentHash) external view override returns (Reservation memory) {
        return reservations[_intentHash];
    }

    /** @notice Returns one deferred-stake authorization or funded position. */
    function getDeferredStake(bytes32 _intentHash) external view override returns (DeferredStake memory) {
        return deferredStakes[_intentHash];
    }

    /** @notice Returns the exact fee plan that remains contingent until maturity. */
    function getDeferredFeeAllocations(
        bytes32 _intentHash
    ) external view override returns (IIntentRiskHook.FeeAllocation[] memory) {
        return deferredFeeAllocations[_intentHash];
    }

    /**
     * @notice Returns all token-denominated vault liabilities.
     */
    function totalLiabilities() public view override returns (uint256) {
        return totalStaked + totalClaimableCompensation + totalClaimableFees;
    }

    /* ============ Internal Functions ============ */

    function _creditCompensation(bytes32 _intentHash, address _maker, uint256 _amount) internal {
        claimableCompensation[_maker] += _amount;
        totalClaimableCompensation += _amount;

        emit CompensationCredited(
            _intentHash,
            _maker,
            _amount,
            claimableCompensation[_maker]
        );
    }

    function _setTakerAuthorization(address _stakeOwner, address _taker, bool _authorized) internal {
        if (_taker == address(0) || _taker == _stakeOwner) revert InvalidTaker(_taker);

        address currentStakeOwner = delegatedStakeOwners[_taker];
        if (_authorized) {
            if (currentStakeOwner == _stakeOwner) return;
            if (stakeDelegationDisabled[_taker]) revert StakeDelegationDisabled(_taker);
            address requiredStakeOwner = allowedStakeOwners[_taker];
            if (requiredStakeOwner != address(0) && requiredStakeOwner != _stakeOwner) {
                revert StakeOwnerNotAllowed(_taker, _stakeOwner, requiredStakeOwner);
            }
            if (currentStakeOwner != address(0) && currentStakeOwner != _stakeOwner) {
                revert TakerAlreadyAuthorized(_taker, currentStakeOwner);
            }

            delegatedStakeOwners[_taker] = _stakeOwner;
        } else {
            if (currentStakeOwner != _stakeOwner) {
                revert TakerAuthorizationNotFound(_taker, _stakeOwner);
            }
            delete delegatedStakeOwners[_taker];
        }

        emit TakerAuthorizationUpdated(_stakeOwner, _taker, _authorized);
    }

    function _requirePositionController(address _expectedController) internal view {
        if (msg.sender != _expectedController) {
            revert UnauthorizedPositionController(msg.sender, _expectedController);
        }
    }
}
