// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "../interfaces/IEscrow.sol";
import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";
import { BoundedCall } from "./BoundedCall.sol";
import { OrchestratorV3FeeLib } from "./OrchestratorV3FeeLib.sol";
import { RiskCallbackRecorder } from "./RiskCallbackRecorder.sol";

/**
 * @title OrchestratorV3RiskLib
 * @notice Executes V3 risk-hook selection, admission, and compact intent reads.
 * @dev The linked library keeps the V3 implementation below the EIP-170 runtime-size limit while
 *      preserving OrchestratorV3 as the storage, authorization, and event-emitting context.
 */
library OrchestratorV3RiskLib {
    event DepositRiskHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);
    event IntentRiskHookSnapshotted(bytes32 indexed intentHash, address indexed riskHook, bool requiresSettlementHook);
    event IntentSettlementRecorded(bytes32 indexed intentHash, uint256 releasedAmount, uint64 settledAt);

    error ZeroAddress();
    error InvalidContract(address account);
    error InvalidRiskHook(address hook);
    error UnauthorizedCallerOrDelegate(address caller, address depositor, address delegate);

    /** @notice Updates the risk hook used by future intents for one depositor-controlled deposit. */
    function setDepositRiskHook(
        mapping(address => mapping(uint256 => IIntentRiskHook)) storage _depositRiskHooks,
        address _escrow,
        uint256 _depositId,
        IIntentRiskHook _hook
    ) external {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_escrow.code.length == 0) revert InvalidContract(_escrow);

        address hookAddress = address(_hook);
        if (hookAddress != address(0) && hookAddress.code.length == 0) {
            revert InvalidRiskHook(hookAddress);
        }

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        bool isDepositorOrDelegate = msg.sender == deposit.depositor
            || (deposit.delegate != address(0) && msg.sender == deposit.delegate);
        if (!isDepositorOrDelegate) {
            revert UnauthorizedCallerOrDelegate(msg.sender, deposit.depositor, deposit.delegate);
        }

        _depositRiskHooks[_escrow][_depositId] = _hook;
        emit DepositRiskHookSet(_escrow, _depositId, hookAddress, msg.sender);
    }

    /** @notice Returns the scalar intent fields used by the snapshotted risk hook. */
    function getRiskIntent(
        mapping(bytes32 => IOrchestratorV2.Intent) storage _intents,
        bytes32 _intentHash
    ) external view returns (IOrchestratorV3.RiskIntentData memory riskIntent) {
        IOrchestratorV2.Intent storage intent = _intents[_intentHash];
        riskIntent = IOrchestratorV3.RiskIntentData({
            owner: intent.owner,
            to: intent.to,
            escrow: intent.escrow,
            depositId: intent.depositId,
            amount: intent.amount,
            paymentMethod: intent.paymentMethod,
            settlementHook: address(intent.settlementHook),
            createdAt: uint64(intent.timestamp)
        });
    }

    /** @notice Snapshots the selected hook and executes fail-closed intent admission. */
    function snapshotAndAdmit(
        mapping(address => mapping(uint256 => IIntentRiskHook)) storage _depositRiskHooks,
        mapping(bytes32 => IIntentRiskHook) storage _intentRiskHooks,
        mapping(bytes32 => bool) storage _intentRequiresSettlementHook,
        mapping(bytes32 => IOrchestratorV2.Intent) storage _intents,
        bytes32 _intentHash,
        uint256 _callbackGasLimit,
        uint256 _postCallGasReserve,
        uint256 _maxReturnData
    ) external {
        IOrchestratorV2.Intent storage intent = _intents[_intentHash];
        IIntentRiskHook riskHook = _depositRiskHooks[intent.escrow][intent.depositId];
        _intentRiskHooks[_intentHash] = riskHook;

        bool requiresSettlementHook = BoundedCall.executeRiskAdmission(
            riskHook,
            _intentHash,
            address(intent.settlementHook),
            _callbackGasLimit,
            _postCallGasReserve,
            _maxReturnData
        );
        _intentRequiresSettlementHook[_intentHash] = requiresSettlementHook;
        emit IntentRiskHookSnapshotted(_intentHash, address(riskHook), requiresSettlementHook);
    }

    /** @notice Clears terminal snapshots, invokes the bounded callback, and stores retry data on failure. */
    function executeTerminalCallback(
        mapping(bytes32 => IIntentRiskHook) storage _intentRiskHooks,
        mapping(bytes32 => bool) storage _intentRequiresSettlementHook,
        mapping(bytes32 => OrchestratorV3FeeLib.IntentFeeSnapshot) storage _intentFeeSnapshots,
        mapping(bytes32 => IOrchestratorV3.IntentSettlement) storage _failedSettlements,
        mapping(bytes32 => IOrchestratorV3.IntentCancellation) storage _failedCancellations,
        bytes32 _intentHash,
        uint8 _resolution,
        uint256 _releasedAmount,
        uint256 _callbackGasLimit,
        uint256 _postCallGasReserve,
        uint256 _maxReturnData
    ) external {
        bool isSettlement = _resolution != 0;
        uint64 resolvedAt = uint64(block.timestamp);
        if (isSettlement) emit IntentSettlementRecorded(_intentHash, _releasedAmount, resolvedAt);

        IIntentRiskHook riskHook = _intentRiskHooks[_intentHash];
        delete _intentRiskHooks[_intentHash];
        delete _intentRequiresSettlementHook[_intentHash];
        if (!isSettlement) delete _intentFeeSnapshots[_intentHash];

        bool callbackSucceeded = BoundedCall.executeTerminalRiskCallback(
            riskHook,
            _intentHash,
            _resolution,
            _releasedAmount,
            _callbackGasLimit,
            _postCallGasReserve,
            _maxReturnData
        );
        RiskCallbackRecorder.recordFailure(
            _failedSettlements,
            _failedCancellations,
            _intentHash,
            _resolution,
            _releasedAmount,
            resolvedAt,
            callbackSucceeded
        );
    }
}
