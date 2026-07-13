// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IStakeVault
 * @notice Policy-agnostic custody interface for membership stake and deferred payouts.
 */
interface IStakeVault {
    /* ============ Structs ============ */

    struct ExitRequest {
        bool exiting;
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

    struct DeferredPayout {
        address beneficiary;
        address controller;
        uint256 amount;
        uint64 releaseTime;
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
    event StakeWithdrawn(address indexed staker, address indexed recipient, uint256 amount);
    event CompensationCredited(
        bytes32 indexed intentHash,
        address indexed maker,
        uint256 amount,
        uint256 newClaimableBalance
    );
    event CompensationWithdrawn(address indexed maker, address indexed recipient, uint256 amount);
    event DeferredPayoutAuthorized(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        address indexed controller,
        uint64 releaseTime
    );
    event DeferredPayoutAuthorizationReleased(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        address indexed controller
    );
    event DeferredPayoutRecorded(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        uint256 amount,
        uint64 releaseTime
    );
    event DeferredPayoutSlashed(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        address indexed maker,
        uint256 amount,
        uint256 remainingAmount
    );
    event DeferredPayoutWithdrawn(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        address indexed recipient,
        uint256 amount
    );
    event ControllerProposed(address indexed currentController, address indexed pendingController, uint64 validAt);
    event ControllerInitialized(address indexed controller);
    event ControllerAccepted(address indexed previousController, address indexed newController);
    event CustodyPausedUpdated(bool depositsPaused, bool reservationsPaused);

    /* ============ User Functions ============ */

    function depositStake(uint256 _amount) external;
    function requestExit() external;
    function cancelExit() external;
    function withdrawStake(address _recipient) external;
    function withdrawCompensation(address _recipient) external;
    function withdrawDeferredPayout(bytes32 _intentHash, address _recipient) external;

    /* ============ Controller Functions ============ */

    function reserveStake(address _staker, bytes32 _intentHash, uint256 _amount, uint64 _releaseTime) external;
    function updateReservation(bytes32 _intentHash, uint256 _newAmount, uint64 _releaseTime) external;
    function releaseReservation(bytes32 _intentHash) external;
    function slashReservation(bytes32 _intentHash, address _maker, uint256 _amount) external;
    function authorizeDeferredPayout(bytes32 _intentHash, address _beneficiary, uint64 _releaseTime) external;
    function releaseDeferredPayoutAuthorization(bytes32 _intentHash) external;
    function recordDeferredPayout(bytes32 _intentHash, address _beneficiary, uint256 _amount, uint64 _releaseTime) external;
    function slashDeferredPayout(bytes32 _intentHash, address _maker, uint256 _amount) external;

    /* ============ Governance Functions ============ */

    function initializeController(address _controller) external;
    function proposeController(address _controller) external;
    function acceptController() external;
    function setCustodyPaused(bool _depositsPaused, bool _reservationsPaused) external;

    /* ============ View Functions ============ */

    function stakeToken() external view returns (IERC20);
    function controller() external view returns (address);
    function stakeBalance(address _staker) external view returns (uint256);
    function reservedStake(address _staker) external view returns (uint256);
    function freeStake(address _staker) external view returns (uint256);
    function isExiting(address _staker) external view returns (bool);
    function getExitRequest(address _staker) external view returns (ExitRequest memory);
    function getReservation(bytes32 _intentHash) external view returns (Reservation memory);
    function getDeferredPayout(bytes32 _intentHash) external view returns (DeferredPayout memory);
    function claimableCompensation(address _maker) external view returns (uint256);
    function totalLiabilities() external view returns (uint256);
}
