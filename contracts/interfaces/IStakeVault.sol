// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IIntentRiskHook } from "./IIntentRiskHook.sol";

/**
 * @title IStakeVault
 * @notice Policy-agnostic interface for membership stake, reservations, and deferred fee claims.
 */
interface IStakeVault {
    /* ============ Structs ============ */

    struct ExitRequest {
        bool exiting;
        uint64 requestedAt;
        uint64 availableAt;
    }

    struct StakeWithdrawalRequest {
        uint256 amount;
        uint64 requestedAt;
        uint64 availableAt;
    }

    struct Reservation {
        address staker;
        address controller;
        uint256 amount;
        uint64 releaseTime;
        bool active;
    }

    struct DeferredStake {
        address staker;
        address controller;
        uint256 grossAmount;
        uint256 feeAmount;
        uint64 releaseTime;
        bool funded;
    }

    /* ============ Events ============ */

    event StakeDeposited(address indexed staker, uint256 amount, uint256 newStakeBalance);
    event StakeReserved(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed controller,
        uint256 amount,
        uint256 totalReserved,
        uint64 releaseTime
    );
    event StakeReservationUpdated(
        bytes32 indexed intentHash,
        address indexed staker,
        uint256 previousAmount,
        uint256 newAmount,
        uint256 totalReserved,
        uint64 releaseTime
    );
    event StakeReservationReleased(
        bytes32 indexed intentHash,
        address indexed staker,
        uint256 amount,
        uint256 totalReserved
    );
    event StakeSlashed(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed maker,
        uint256 amount,
        uint256 remainingStake,
        uint256 remainingReservation
    );
    event ExitRequested(address indexed staker, uint64 requestedAt, uint64 availableAt);
    event ExitCancelled(address indexed staker);
    event StakeWithdrawalRequested(
        address indexed stakeOwner,
        uint256 amount,
        uint64 requestedAt,
        uint64 availableAt
    );
    event StakeWithdrawalCancelled(address indexed stakeOwner, uint256 amount);
    event StakeWithdrawn(address indexed staker, address indexed recipient, uint256 amount);
    event CompensationCredited(
        bytes32 indexed intentHash,
        address indexed maker,
        uint256 amount,
        uint256 newClaimableBalance
    );
    event CompensationWithdrawn(address indexed maker, address indexed recipient, uint256 amount);
    event DeferredStakeAuthorized(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed controller,
        uint64 releaseTime
    );
    event DeferredStakeAuthorizationReleased(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed controller
    );
    event DeferredStakeFunded(
        bytes32 indexed intentHash,
        address indexed staker,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount,
        uint64 releaseTime
    );
    event DeferredStakeSlashed(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed maker,
        uint256 slashedGrossAmount,
        uint256 cancelledFeeAmount
    );
    event DeferredStakeReleased(
        bytes32 indexed intentHash,
        address indexed staker,
        uint256 releasedGrossAmount,
        uint256 vestedFeeAmount,
        uint256 netStakeReleased
    );
    event DeferredFeeVested(
        bytes32 indexed intentHash,
        address indexed recipient,
        IIntentRiskHook.FeeType indexed feeType,
        uint256 amount,
        uint256 newClaimableBalance
    );
    event DeferredFeeContingent(
        bytes32 indexed intentHash,
        address indexed recipient,
        IIntentRiskHook.FeeType indexed feeType,
        uint256 amount
    );
    event DeferredFeeCancelled(
        bytes32 indexed intentHash,
        address indexed recipient,
        IIntentRiskHook.FeeType indexed feeType,
        uint256 amount
    );
    event FeeClaimWithdrawn(
        address indexed beneficiary,
        address indexed recipient,
        uint256 amount
    );
    event TakerAuthorizationUpdated(address indexed stakeOwner, address indexed taker, bool authorized);
    event StakeDelegationEnabledUpdated(address indexed taker, bool enabled);
    event AllowedStakeOwnerUpdated(address indexed taker, address indexed allowedStakeOwner);
    event ControllerProposed(address indexed currentController, address indexed pendingController, uint64 validAt);
    event ControllerInitialized(address indexed controller);
    event ControllerAccepted(address indexed previousController, address indexed newController);
    event StakeOperationsPausedUpdated(bool depositsPaused, bool reservationsPaused);

    /* ============ User Functions ============ */

    function depositStake(uint256 _amount) external;
    function depositStakeFor(address _taker, uint256 _amount) external;
    function setTakerAuthorization(address _taker, bool _authorized) external;
    function setTakerAuthorizations(address[] calldata _takers, bool _authorized) external;
    function clearStakeOwner() external;
    function setStakeDelegationEnabled(bool _enabled) external;
    function setAllowedStakeOwner(address _stakeOwner) external;
    function requestStakeWithdrawal(uint256 _amount) external;
    function cancelStakeWithdrawal() external;
    function withdrawRequestedStake(address _recipient) external;
    function requestExit() external;
    function cancelExit() external;
    function withdrawStake(address _recipient) external;
    function withdrawCompensation(address _recipient) external;
    function withdrawFeeClaim(address _recipient) external;
    function withdrawFeeClaimFor(address _beneficiary) external;

    /* ============ Controller Functions ============ */

    function reserveStake(address _staker, bytes32 _intentHash, uint256 _amount, uint64 _releaseTime) external;
    /**
     * @notice Adds stake to, or refreshes the release time of, an active admission reservation.
     * @dev `_amount` may be zero so cumulative-rounding steps still enforce admission gates.
     */
    function increaseReservation(bytes32 _positionId, uint256 _amount, uint64 _releaseTime) external;
    function updateReservation(bytes32 _intentHash, uint256 _newAmount, uint64 _releaseTime) external;
    function releaseReservation(bytes32 _intentHash) external;
    function slashReservation(bytes32 _intentHash, address _maker, uint256 _amount) external;
    function authorizeDeferredStake(bytes32 _intentHash, address _staker, uint64 _releaseTime) external;
    function releaseDeferredStakeAuthorization(bytes32 _intentHash) external;
    function recordDeferredStake(
        bytes32 _intentHash,
        address _staker,
        uint256 _grossAmount,
        uint64 _releaseTime,
        IIntentRiskHook.FeeAllocation[] calldata _feeAllocations
    ) external;
    function releaseDeferredStake(bytes32 _intentHash) external;
    function slashDeferredStake(bytes32 _intentHash, address _maker) external;

    /* ============ Governance Functions ============ */

    function initializeController(address _controller) external;
    function proposeController(address _controller) external;
    function acceptController() external;
    function setStakeOperationsPaused(bool _depositsPaused, bool _reservationsPaused) external;

    /* ============ View Functions ============ */

    function stakeToken() external view returns (IERC20);
    function controller() external view returns (address);
    function stakeBalance(address _staker) external view returns (uint256);
    function reservedStake(address _staker) external view returns (uint256);
    function eligibleStake(address _staker) external view returns (uint256);
    function freeStake(address _staker) external view returns (uint256);
    function stakeOwnerOf(address _taker) external view returns (address);
    function stakeDelegationEnabled(address _taker) external view returns (bool);
    function allowedStakeOwner(address _taker) external view returns (address);
    function isExiting(address _staker) external view returns (bool);
    function getExitRequest(address _staker) external view returns (ExitRequest memory);
    function getStakeWithdrawalRequest(address _staker) external view returns (StakeWithdrawalRequest memory);
    function getReservation(bytes32 _intentHash) external view returns (Reservation memory);
    function getDeferredStake(bytes32 _intentHash) external view returns (DeferredStake memory);
    function getDeferredFeeAllocations(
        bytes32 _intentHash
    ) external view returns (IIntentRiskHook.FeeAllocation[] memory);
    function claimableCompensation(address _maker) external view returns (uint256);
    function claimableFees(address _beneficiary) external view returns (uint256);
    function totalDeferredFees() external view returns (uint256);
    function totalClaimableFees() external view returns (uint256);
    function totalLiabilities() external view returns (uint256);
}
