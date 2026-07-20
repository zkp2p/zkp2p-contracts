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
        bytes32 _paymentMethod,
        uint16 _chargebackReserveBps,
        uint64 _coverageDeadline
    ) external {
        RiskPosition storage position = riskPositions[_intentHash];
        position.mode = _mode;
        position.status = _status;
        position.paymentMethod = _paymentMethod;
        position.chargebackReserveBps = _chargebackReserveBps;
        position.coverageDeadline = _coverageDeadline;
    }

    function forceRiskPosition(bytes32 _intentHash, RiskPosition calldata _position) external {
        riskPositions[_intentHash] = _position;
    }

    function exposedSettlePosition(
        bytes32 _intentHash,
        IERC20 _token,
        uint256 _grossAmount,
        uint256 _executableAmount,
        uint64 _settledAt,
        bool _isManualRelease,
        FeeAllocation[] calldata _feeAllocations
    ) external {
        _settlePosition(
            _intentHash,
            _token,
            _grossAmount,
            _executableAmount,
            _settledAt,
            _isManualRelease,
            _feeAllocations
        );
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
 * @dev This mock deliberately exposes a setter for durable cancellation records. Production
 *      integration behavior remains covered against OrchestratorV3 in `riskManager.spec.ts`.
 */
contract RiskManagerOrchestratorHarness {
    mapping(bytes32 => IOrchestratorV3.RiskIntentData) internal riskIntents;
    mapping(bytes32 => uint64) internal cancellationTimes;
    function setRiskIntent(bytes32 _intentHash, IOrchestratorV3.RiskIntentData calldata _intent) external {
        riskIntents[_intentHash] = _intent;
    }

    function setIntentCancellation(bytes32 _intentHash, uint64 _cancelledAt) external {
        cancellationTimes[_intentHash] = _cancelledAt;
    }

    function getRiskIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.RiskIntentData memory) {
        return riskIntents[_intentHash];
    }

    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64) {
        return cancellationTimes[_intentHash];
    }

    function createPosition(IIntentRiskHook _hook, bytes32 _intentHash) external {
        _hook.onIntentCreated(_intentHash);
    }

    function cancelPosition(IIntentRiskHook _hook, bytes32 _intentHash) external {
        _hook.onIntentCancelled(_intentHash);
    }

    function settlePosition(
        IIntentRiskHook _hook,
        IIntentRiskHook.RiskSettlementContext calldata _context
    ) external {
        IERC20 token = IERC20(_context.token);
        token.approve(address(_hook), 0);
        token.approve(address(_hook), _context.grossAmount);
        _hook.settleIntent(_context);
        token.approve(address(_hook), 0);
    }
}

/** @notice Minimal Escrow policy and LP source for isolated RiskManager tests. */
contract RiskManagerEscrowHarness {
    uint256 public intentExpirationPeriod;
    address public depositor;
    address public intentGuardian;
    IERC20 public token = IERC20(address(0xbeef));
    mapping(bytes32 => IEscrowV2.Intent) internal intents;

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

    function setIntentGuardian(address _intentGuardian) external {
        intentGuardian = _intentGuardian;
    }

    function setIntent(bytes32 _intentHash, uint256 _createdAt) external {
        intents[_intentHash] = IEscrowV2.Intent({
            intentHash: _intentHash,
            amount: 0,
            timestamp: _createdAt,
            expiryTime: _createdAt + intentExpirationPeriod
        });
    }

    function setIntentState(
        bytes32 _intentHash,
        uint256 _timestamp,
        uint256 _expiryTime
    ) external {
        intents[_intentHash] = IEscrowV2.Intent({
            intentHash: _intentHash,
            amount: 0,
            timestamp: _timestamp,
            expiryTime: _expiryTime
        });
    }

    function getDepositIntent(uint256, bytes32 _intentHash) external view returns (IEscrowV2.Intent memory) {
        return intents[_intentHash];
    }

    function extendIntentExpiry(uint256, bytes32 _intentHash, uint256 _additionalTime) external {
        require(msg.sender == intentGuardian, "not guardian");
        require(
            intents[_intentHash].expiryTime + _additionalTime
                <= intents[_intentHash].timestamp + 5 days,
            "intent lifetime exceeded"
        );
        intents[_intentHash].expiryTime += _additionalTime;
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
            intentGuardian: intentGuardian,
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

    struct DeferredStake {
        address staker;
        uint256 grossAmount;
        uint256 feeAmount;
        uint64 releaseTime;
        bool authorized;
        bool funded;
    }

    mapping(address => uint256) public stakeBalance;
    mapping(address => uint256) public reservedStake;
    mapping(address => uint256) public freeStake;
    mapping(address => address) public stakeOwnerOf;
    mapping(address => bool) public isExiting;
    mapping(address => uint256) public claimableCompensation;
    mapping(bytes32 => Reservation) public reservations;
    mapping(bytes32 => DeferredStake) public deferredStakes;
    mapping(bytes32 => IIntentRiskHook.FeeAllocation[]) internal deferredFeeAllocations;
    mapping(address => uint256) public claimableFees;
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

    function depositAndReserveStake(
        address _funder,
        address _staker,
        bytes32 _positionId,
        uint256 _amount,
        uint64 _releaseTime
    ) external {
        stakeToken.transferFrom(_funder, address(this), _amount);
        stakeBalance[_staker] += _amount;
        reservedStake[_staker] += _amount;
        Reservation storage reservation = reservations[_positionId];
        reservation.staker = _staker;
        reservation.amount += _amount;
        reservation.releaseTime = _releaseTime;
    }

    function increaseReservation(bytes32 _positionId, uint256 _amount, uint64 _releaseTime) external {
        Reservation storage reservation = reservations[_positionId];
        require(!isExiting[reservation.staker], "staker exiting");
        require(freeStake[reservation.staker] >= _amount, "insufficient free stake");
        freeStake[reservation.staker] -= _amount;
        reservedStake[reservation.staker] += _amount;
        reservation.amount += _amount;
        reservation.releaseTime = _releaseTime;
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

    function authorizeDeferredStake(bytes32 _intentHash, address _staker, uint64 _releaseTime) external {
        deferredStakes[_intentHash] = DeferredStake(_staker, 0, 0, _releaseTime, true, false);
    }

    function releaseDeferredStakeAuthorization(bytes32 _intentHash) external {
        delete deferredStakes[_intentHash];
    }

    function recordDeferredStake(
        bytes32 _intentHash,
        address _staker,
        uint256 _grossAmount,
        uint64 _releaseTime,
        IIntentRiskHook.FeeAllocation[] calldata _feeAllocations
    ) external {
        DeferredStake storage deferredStake = deferredStakes[_intentHash];
        require(deferredStake.authorized, "not authorized");
        deferredStake.staker = _staker;
        deferredStake.grossAmount = _grossAmount;
        deferredStake.releaseTime = _releaseTime;
        deferredStake.funded = true;
        for (uint256 index = 0; index < _feeAllocations.length; index++) {
            deferredStake.feeAmount += _feeAllocations[index].amount;
            deferredFeeAllocations[_intentHash].push(_feeAllocations[index]);
        }
        stakeBalance[_staker] += _grossAmount;
        reservedStake[_staker] += _grossAmount;
        reservations[_intentHash] = Reservation(_staker, _grossAmount, _releaseTime);
    }

    function releaseDeferredStake(bytes32 _intentHash) external {
        DeferredStake memory deferredStake = deferredStakes[_intentHash];
        reservedStake[deferredStake.staker] -= deferredStake.grossAmount;
        stakeBalance[deferredStake.staker] -= deferredStake.feeAmount;
        freeStake[deferredStake.staker] += deferredStake.grossAmount - deferredStake.feeAmount;
        IIntentRiskHook.FeeAllocation[] storage allocations = deferredFeeAllocations[_intentHash];
        for (uint256 index = 0; index < allocations.length; index++) {
            claimableFees[allocations[index].recipient] += allocations[index].amount;
        }
        delete reservations[_intentHash];
        delete deferredFeeAllocations[_intentHash];
        delete deferredStakes[_intentHash];
    }

    function slashDeferredStake(bytes32 _intentHash, address _maker) external {
        DeferredStake memory deferredStake = deferredStakes[_intentHash];
        reservedStake[deferredStake.staker] -= deferredStake.grossAmount;
        stakeBalance[deferredStake.staker] -= deferredStake.grossAmount;
        claimableCompensation[_maker] += deferredStake.grossAmount;
        delete reservations[_intentHash];
        delete deferredFeeAllocations[_intentHash];
        delete deferredStakes[_intentHash];
    }

    function acceptController() external {
        acceptControllerCalls += 1;
    }

}
