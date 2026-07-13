// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { IStakeVault } from "./interfaces/IStakeVault.sol";

/**
 * @title StakeVault
 * @notice Stable, policy-agnostic USDC custody for taker stake, reservations, and deferred payouts.
 * @dev The controller decides why funds are reserved or slashed. The vault only enforces accounting,
 *      exit, maturity, and solvency rules. User and maker withdrawals remain available while custody
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
    mapping(address => ExitRequest) internal exitRequests;
    mapping(bytes32 => Reservation) internal reservations;
    mapping(bytes32 => DeferredPayout) internal deferredPayouts;
    mapping(address => uint256) public override claimableCompensation;

    uint256 public totalStaked;
    uint256 public totalDeferredPayouts;
    uint256 public totalClaimableCompensation;

    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedController(address caller);
    error UnauthorizedPositionController(address caller, address expectedController);
    error CustodyActionPaused();
    error AlreadyExiting(address staker);
    error NotExiting(address staker);
    error ExitNotReady(uint64 availableAt, uint64 currentTime);
    error ActiveReservations(address staker, uint256 reservedAmount);
    error InsufficientFreeStake(address staker, uint256 available, uint256 required);
    error ReservationAlreadyExists(bytes32 intentHash);
    error ReservationNotFound(bytes32 intentHash);
    error InvalidReservationAmount(uint256 amount, uint256 reservedAmount);
    error DeferredPayoutAlreadyExists(bytes32 intentHash);
    error DeferredPayoutNotFound(bytes32 intentHash);
    error DeferredPayoutAlreadyFunded(bytes32 intentHash, uint256 amount);
    error DeferredPayoutBeneficiaryMismatch(address expected, address actual);
    error DeferredPayoutNotMature(uint64 releaseTime, uint64 currentTime);
    error UnauthorizedBeneficiary(address caller, address beneficiary);
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
        if (depositsPaused) revert CustodyActionPaused();
        if (_amount == 0) revert ZeroAmount();

        uint256 balanceBefore = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(msg.sender, address(this), _amount);
        uint256 received = stakeToken.balanceOf(address(this)) - balanceBefore;
        if (received != _amount) revert UnexpectedTokenAmount(_amount, received);

        stakeBalance[msg.sender] += _amount;
        totalStaked += _amount;

        emit StakeDeposited(msg.sender, _amount, stakeBalance[msg.sender]);
    }

    /**
     * @notice Requests a full exit and immediately blocks new reservations for the caller.
     */
    function requestExit() external override {
        if (stakeBalance[msg.sender] == 0) revert ZeroAmount();
        if (exitRequests[msg.sender].exiting) revert AlreadyExiting(msg.sender);

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

    /**
     * @notice Withdraws matured deferred proceeds owned by the caller.
     * @param _intentHash Intent whose proceeds are being withdrawn.
     * @param _recipient Address receiving the stake token.
     */
    function withdrawDeferredPayout(bytes32 _intentHash, address _recipient) external override nonReentrant {
        if (_recipient == address(0)) revert ZeroAddress();

        DeferredPayout memory payout = deferredPayouts[_intentHash];
        if (payout.beneficiary == address(0) || payout.amount == 0) revert DeferredPayoutNotFound(_intentHash);
        if (msg.sender != payout.beneficiary) revert UnauthorizedBeneficiary(msg.sender, payout.beneficiary);
        if (block.timestamp < payout.releaseTime) {
            revert DeferredPayoutNotMature(payout.releaseTime, uint64(block.timestamp));
        }

        delete deferredPayouts[_intentHash];
        totalDeferredPayouts -= payout.amount;

        stakeToken.safeTransfer(_recipient, payout.amount);
        emit DeferredPayoutWithdrawn(_intentHash, payout.beneficiary, _recipient, payout.amount);
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
        if (reservationsPaused) revert CustodyActionPaused();
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
    function authorizeDeferredPayout(
        bytes32 _intentHash,
        address _beneficiary,
        uint64 _releaseTime
    ) external override onlyController {
        if (reservationsPaused) revert CustodyActionPaused();
        if (_beneficiary == address(0)) revert ZeroAddress();
        if (deferredPayouts[_intentHash].beneficiary != address(0)) revert DeferredPayoutAlreadyExists(_intentHash);

        deferredPayouts[_intentHash] = DeferredPayout({
            beneficiary: _beneficiary,
            controller: msg.sender,
            amount: 0,
            releaseTime: _releaseTime
        });

        emit DeferredPayoutAuthorized(_intentHash, _beneficiary, msg.sender, _releaseTime);
    }

    /**
     * @notice Removes an unfunded deferred-position authorization after cancellation.
     */
    function releaseDeferredPayoutAuthorization(bytes32 _intentHash) external override {
        DeferredPayout memory payout = deferredPayouts[_intentHash];
        if (payout.beneficiary == address(0)) revert DeferredPayoutNotFound(_intentHash);
        _requirePositionController(payout.controller);
        if (payout.amount != 0) revert DeferredPayoutAlreadyFunded(_intentHash, payout.amount);

        delete deferredPayouts[_intentHash];
        emit DeferredPayoutAuthorizationReleased(_intentHash, payout.beneficiary, payout.controller);
    }

    /**
     * @notice Accounts for deferred proceeds already transferred into the vault.
     */
    function recordDeferredPayout(
        bytes32 _intentHash,
        address _beneficiary,
        uint256 _amount,
        uint64 _releaseTime
    ) external override {
        if (_beneficiary == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();

        DeferredPayout storage payout = deferredPayouts[_intentHash];
        if (payout.beneficiary == address(0)) revert DeferredPayoutNotFound(_intentHash);
        _requirePositionController(payout.controller);
        if (payout.amount != 0) revert DeferredPayoutAlreadyFunded(_intentHash, payout.amount);
        if (_beneficiary != payout.beneficiary) {
            revert DeferredPayoutBeneficiaryMismatch(payout.beneficiary, _beneficiary);
        }

        uint256 accountedBefore = totalLiabilities();
        uint256 vaultBalance = stakeToken.balanceOf(address(this));
        uint256 unaccounted = vaultBalance > accountedBefore ? vaultBalance - accountedBefore : 0;
        if (_amount > unaccounted) revert InsufficientUnaccountedTokens(unaccounted, _amount);

        payout.amount = _amount;
        payout.releaseTime = _releaseTime;
        totalDeferredPayouts += _amount;

        emit DeferredPayoutRecorded(_intentHash, _beneficiary, _amount, _releaseTime);
    }

    /**
     * @notice Slashes deferred proceeds and credits maker compensation.
     */
    function slashDeferredPayout(
        bytes32 _intentHash,
        address _maker,
        uint256 _amount
    ) external override {
        if (_maker == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();

        DeferredPayout storage payout = deferredPayouts[_intentHash];
        if (payout.beneficiary == address(0) || payout.amount == 0) revert DeferredPayoutNotFound(_intentHash);
        _requirePositionController(payout.controller);
        if (_amount > payout.amount) revert InvalidReservationAmount(_amount, payout.amount);

        address beneficiary = payout.beneficiary;
        payout.amount -= _amount;
        uint256 remainingAmount = payout.amount;
        if (remainingAmount == 0) delete deferredPayouts[_intentHash];
        totalDeferredPayouts -= _amount;
        _creditCompensation(_intentHash, _maker, _amount);

        emit DeferredPayoutSlashed(
            _intentHash,
            beneficiary,
            _maker,
            _amount,
            remainingAmount
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
     * @notice Pauses new deposits and/or new custody reservations without blocking withdrawals.
     */
    function setCustodyPaused(bool _depositsPaused, bool _reservationsPaused) external override onlyOwner {
        depositsPaused = _depositsPaused;
        reservationsPaused = _reservationsPaused;
        emit CustodyPausedUpdated(_depositsPaused, _reservationsPaused);
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns stake not currently committed to active reservations.
     */
    function freeStake(address _staker) public view override returns (uint256) {
        return stakeBalance[_staker] - reservedStake[_staker];
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
     * @notice Returns one membership-stake reservation.
     */
    function getReservation(bytes32 _intentHash) external view override returns (Reservation memory) {
        return reservations[_intentHash];
    }

    /**
     * @notice Returns one deferred payout record.
     */
    function getDeferredPayout(bytes32 _intentHash) external view override returns (DeferredPayout memory) {
        return deferredPayouts[_intentHash];
    }

    /**
     * @notice Returns all token-denominated vault liabilities.
     */
    function totalLiabilities() public view override returns (uint256) {
        return totalStaked + totalDeferredPayouts + totalClaimableCompensation;
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

    function _requirePositionController(address _expectedController) internal view {
        if (msg.sender != _expectedController) {
            revert UnauthorizedPositionController(msg.sender, _expectedController);
        }
    }
}
