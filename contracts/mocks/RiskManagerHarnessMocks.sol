// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IEscrowV2 } from "../interfaces/IEscrowV2.sol";
import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";
import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";
import { INullifierRegistryV2 } from "../interfaces/INullifierRegistryV2.sol";
import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";
import { IRiskManager } from "../interfaces/IRiskManager.sol";
import { IStakeVault } from "../interfaces/IStakeVault.sol";
import { RiskManager } from "../RiskManager.sol";
import { NullifierRegistryV2 } from "../registries/NullifierRegistryV2.sol";
import { INullifierRegistry } from "../interfaces/INullifierRegistry.sol";

/**
 * @title RiskManagerStateHarness
 * @notice Exposes impossible-state construction solely to verify RiskManager's defensive invariant guards.
 * @dev No production state transition can create these positions; the setters make the two defensive
 *      `PositionModeMismatch` branches and the zero-deadline guard directly testable.
 */
contract RiskManagerStateHarness is RiskManager {
    constructor(
        address _owner,
        IOrchestratorV3 _orchestrator,
        IStakeVault _stakeVault,
        IAttestationVerifier _attestationVerifier,
        INullifierRegistryV2 _nullifierRegistry
    ) RiskManager(_owner, _orchestrator, _stakeVault, _attestationVerifier, _nullifierRegistry) { }

    function forcePlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) external {
        platformRiskConfigs[_paymentMethod] = _config;
    }

    function forcePosition(
        bytes32 _intentHash,
        RiskMode _mode,
        PositionStatus _status,
        address _deferredPayoutHook,
        bytes32 _paymentMethod,
        uint16 _chargebackReserveBps,
        uint64 _coverageDeadline
    ) external {
        RiskPosition storage position = riskPositions[_intentHash];
        position.mode = _mode;
        position.status = _status;
        position.deferredPayoutHook = _deferredPayoutHook;
        position.paymentMethod = _paymentMethod;
        position.chargebackReserveBps = _chargebackReserveBps;
        position.coverageDeadline = _coverageDeadline;
    }

    function forceRiskPosition(bytes32 _intentHash, RiskPosition calldata _position) external {
        riskPositions[_intentHash] = _position;
    }

    function exposedReleaseManualPosition(
        bytes32 _intentHash,
        uint256 _releasedAmount,
        uint64 _settledAt
    ) external {
        _releaseManualPosition(_intentHash, _releasedAmount, _settledAt);
    }

    function exposedSynchronizeSettlement(bytes32 _intentHash) external {
        _synchronizeSettlement(_intentHash);
    }

    /** @notice Calls a target while this manager's inherited reentrancy guard is entered. */
    function callWhileEntered(address _target, bytes calldata _data) external nonReentrant {
        (bool success, bytes memory returnData) = _target.call(_data);
        if (success) return;
        assembly {
            revert(add(returnData, 0x20), mload(returnData))
        }
    }
}

/** @notice Corrupts one binding direction solely to exercise RiskManager's defensive two-way check. */
contract NullifierRegistryV2StateHarness is NullifierRegistryV2 {
    constructor(INullifierRegistry _legacyNullifierRegistry) NullifierRegistryV2(_legacyNullifierRegistry) { }

    function forceNullifierByIntentHash(bytes32 _intentHash, bytes32 _nullifier) external {
        nullifierByIntentHash[_intentHash] = _nullifier;
    }
}

/**
 * @title RiskManagerOrchestratorHarness
 * @notice Minimal lifecycle source used to exercise RiskManager's isolated recovery and error paths.
 * @dev This mock deliberately exposes setters for durable cancellation and settlement records. Production
 *      integration behavior remains covered against OrchestratorV3 in `riskManager.spec.ts`.
 */
contract RiskManagerOrchestratorHarness {
    mapping(bytes32 => IOrchestratorV3.RiskIntentData) internal riskIntents;
    mapping(bytes32 => uint64) internal cancellationTimes;
    mapping(bytes32 => IOrchestratorV3.IntentSettlement) internal settlements;
    function setRiskIntent(bytes32 _intentHash, IOrchestratorV3.RiskIntentData calldata _intent) external {
        riskIntents[_intentHash] = _intent;
    }

    function setIntentCancellation(bytes32 _intentHash, uint64 _cancelledAt) external {
        cancellationTimes[_intentHash] = _cancelledAt;
    }

    function setIntentSettlement(
        bytes32 _intentHash,
        uint256 _releasedAmount,
        uint64 _settledAt,
        bool _isManualRelease
    ) external {
        settlements[_intentHash] = IOrchestratorV3.IntentSettlement(_releasedAmount, _settledAt, _isManualRelease);
    }

    function getRiskIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.RiskIntentData memory) {
        return riskIntents[_intentHash];
    }

    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64) {
        return cancellationTimes[_intentHash];
    }

    function getIntentSettlement(bytes32 _intentHash) external view returns (uint256, uint64, bool) {
        IOrchestratorV3.IntentSettlement memory settlement = settlements[_intentHash];
        return (settlement.releasedAmount, settlement.settledAt, settlement.isManualRelease);
    }

    function createPosition(IIntentRiskHook _hook, bytes32 _intentHash) external returns (bool) {
        return _hook.onIntentCreated(_intentHash);
    }

    function cancelPosition(IIntentRiskHook _hook, bytes32 _intentHash) external {
        _hook.onIntentCancelled(_intentHash);
    }

    function fulfillPosition(IIntentRiskHook _hook, bytes32 _intentHash, uint256 _releasedAmount) external {
        _hook.onIntentFulfilled(_intentHash, _releasedAmount);
    }

    function releasePosition(IIntentRiskHook _hook, bytes32 _intentHash, uint256 _releasedAmount) external {
        _hook.onIntentReleased(_intentHash, _releasedAmount);
    }

    function registerDeferredPayout(
        IRiskManager _manager,
        bytes32 _intentHash,
        address _beneficiary,
        uint256 _amount
    ) external {
        _manager.registerDeferredPayout(_intentHash, _beneficiary, _amount);
    }
}

/** @notice Minimal Escrow policy and LP source for isolated RiskManager tests. */
contract RiskManagerEscrowHarness {
    uint256 public intentExpirationPeriod;
    address public depositor;
    IERC20 public token = IERC20(address(0xbeef));

    constructor(uint256 _intentExpirationPeriod, address _depositor) {
        intentExpirationPeriod = _intentExpirationPeriod;
        depositor = _depositor;
    }

    function setIntentExpirationPeriod(uint256 _intentExpirationPeriod) external {
        intentExpirationPeriod = _intentExpirationPeriod;
    }

    function setToken(IERC20 _token) external {
        token = _token;
    }

    function getDeposit(uint256) external view returns (IEscrowV2.Deposit memory) {
        return IEscrowV2.Deposit({
            depositor: depositor,
            delegate: address(0),
            token: token,
            intentAmountRange: IEscrowV2.Range({ min: 0, max: type(uint256).max }),
            acceptingIntents: true,
            remainingDeposits: type(uint256).max,
            outstandingIntentAmount: 0,
            intentGuardian: address(0),
            retainOnEmpty: true
        });
    }
}

/**
 * @title RiskManagerVaultHarness
 * @notice Policy-agnostic accounting double for RiskManager branch and recovery tests.
 */
contract RiskManagerVaultHarness {
    struct Reservation {
        address staker;
        uint256 amount;
        uint64 releaseTime;
    }

    struct DeferredPayout {
        address beneficiary;
        uint256 amount;
        uint64 releaseTime;
        bool authorized;
    }

    mapping(address => uint256) public stakeBalance;
    mapping(address => uint256) public reservedStake;
    mapping(address => uint256) public freeStake;
    mapping(address => address) public stakeOwnerOf;
    mapping(address => bool) public isExiting;
    mapping(address => uint256) public claimableCompensation;
    mapping(bytes32 => Reservation) public reservations;
    mapping(bytes32 => DeferredPayout) public deferredPayouts;
    uint256 public acceptControllerCalls;
    IERC20 public stakeToken = IERC20(address(0xbeef));

    function setStakeToken(IERC20 _stakeToken) external {
        stakeToken = _stakeToken;
    }

    function setTakerState(
        address _taker,
        address _stakeOwner,
        uint256 _stakeBalance,
        uint256 _freeStake,
        bool _isExiting
    ) external {
        stakeOwnerOf[_taker] = _stakeOwner;
        stakeBalance[_stakeOwner] = _stakeBalance;
        freeStake[_stakeOwner] = _freeStake;
        isExiting[_stakeOwner] = _isExiting;
    }

    function reserveStake(address _staker, bytes32 _intentHash, uint256 _amount, uint64 _releaseTime) external {
        require(freeStake[_staker] >= _amount, "insufficient free stake");
        freeStake[_staker] -= _amount;
        reservedStake[_staker] += _amount;
        reservations[_intentHash] = Reservation(_staker, _amount, _releaseTime);
    }

    function updateReservation(bytes32 _intentHash, uint256 _newAmount, uint64 _releaseTime) external {
        Reservation storage reservation = reservations[_intentHash];
        uint256 previousAmount = reservation.amount;
        if (_newAmount < previousAmount) {
            uint256 released = previousAmount - _newAmount;
            reservedStake[reservation.staker] -= released;
            freeStake[reservation.staker] += released;
        } else if (_newAmount > previousAmount) {
            uint256 added = _newAmount - previousAmount;
            freeStake[reservation.staker] -= added;
            reservedStake[reservation.staker] += added;
        }
        reservation.amount = _newAmount;
        reservation.releaseTime = _releaseTime;
    }

    function releaseReservation(bytes32 _intentHash) external {
        Reservation memory reservation = reservations[_intentHash];
        reservedStake[reservation.staker] -= reservation.amount;
        freeStake[reservation.staker] += reservation.amount;
        delete reservations[_intentHash];
    }

    function slashReservation(bytes32 _intentHash, address _maker, uint256 _amount) external {
        Reservation storage reservation = reservations[_intentHash];
        reservation.amount -= _amount;
        reservedStake[reservation.staker] -= _amount;
        stakeBalance[reservation.staker] -= _amount;
        claimableCompensation[_maker] += _amount;
    }

    function authorizeDeferredPayout(bytes32 _intentHash, address _beneficiary, uint64 _releaseTime) external {
        deferredPayouts[_intentHash] = DeferredPayout(_beneficiary, 0, _releaseTime, true);
    }

    function releaseDeferredPayoutAuthorization(bytes32 _intentHash) external {
        delete deferredPayouts[_intentHash];
    }

    function recordDeferredPayout(
        bytes32 _intentHash,
        address _beneficiary,
        uint256 _amount,
        uint64 _releaseTime
    ) external {
        DeferredPayout storage payout = deferredPayouts[_intentHash];
        require(payout.authorized, "not authorized");
        payout.beneficiary = _beneficiary;
        payout.amount = _amount;
        payout.releaseTime = _releaseTime;
    }

    function slashDeferredPayout(bytes32 _intentHash, address _maker, uint256 _amount) external {
        deferredPayouts[_intentHash].amount -= _amount;
        claimableCompensation[_maker] += _amount;
    }

    function acceptController() external {
        acceptControllerCalls += 1;
    }

}
