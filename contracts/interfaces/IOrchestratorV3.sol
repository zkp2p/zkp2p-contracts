// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "./IIntentRiskHook.sol";
import { IOrchestratorV2 } from "./IOrchestratorV2.sol";

/**
 * @title IOrchestratorV3
 * @notice V2-compatible intent interface with snapshotted depositor-selected risk callbacks.
 */
interface IOrchestratorV3 is IOrchestratorV2 {
    /* ============ Structs ============ */

    struct RiskIntentData {
        address owner;
        address to;
        address escrow;
        uint256 depositId;
        uint256 amount;
        bytes32 paymentMethod;
        uint64 createdAt;
    }

    struct IntentCancellation {
        uint64 cancelledAt;
        IIntentRiskHook riskHook;
    }

    /* ============ Events ============ */

    event DepositRiskHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);
    event IntentRiskHookSnapshotted(bytes32 indexed intentHash, address indexed riskHook);
    event IntentRiskSettlementExecuted(
        bytes32 indexed intentHash,
        address indexed riskHook,
        address indexed token,
        uint256 grossAmount,
        uint256 executableAmount,
        bool fundsConsumed,
        bool isManualRelease
    );
    event RiskHookCallbackFailed(
        bytes32 indexed intentHash,
        address indexed riskHook,
        bytes4 indexed callbackSelector,
        bytes revertData
    );
    event RiskCallbackGasLimitUpdated(uint256 gasLimit);
    event IntentCancellationRecorded(bytes32 indexed intentHash, uint64 cancelledAt);
    event IntentCancellationReconciled(bytes32 indexed intentHash, address indexed riskHook);

    /* ============ Errors ============ */

    error InvalidRiskHook(address hook);
    error RiskHookAdmissionFailed(bytes32 intentHash, address hook, bytes revertData);
    error RiskHookSettlementFailed(bytes32 intentHash, address hook, bytes revertData);
    error InsufficientGasForRiskCallback(uint256 availableGas, uint256 requiredGas);
    error RiskHookSettlementBalanceIncreased(bytes32 intentHash, uint256 beforeBalance, uint256 afterBalance);
    error InvalidRiskHookSettlementConsumption(bytes32 intentHash, uint256 consumed, uint256 grossAmount);
    error RiskCallbackGasLimitTooLow(uint256 gasLimit, uint256 minimum);
    error IntentCancellationNotRecorded(bytes32 intentHash);
    error UnauthorizedCancellationAcknowledger(address caller, address riskHook);

    /* ============ External Functions ============ */

    function setDepositRiskHook(address _escrow, uint256 _depositId, IIntentRiskHook _hook) external;
    function setRiskCallbackGasLimit(uint256 _gasLimit) external;
    /** @notice Clears durable recovery data after the failed risk hook completes reconciliation. */
    function acknowledgeIntentCancellation(bytes32 _intentHash) external;

    /* ============ View Functions ============ */

    function getDepositRiskHook(address _escrow, uint256 _depositId) external view returns (IIntentRiskHook);
    function getIntentRiskHook(bytes32 _intentHash) external view returns (IIntentRiskHook);
    function getRiskIntent(bytes32 _intentHash) external view returns (RiskIntentData memory);
    /**
     * @notice Returns the liquidity-unlock timestamp when a cancellation callback failed open.
     * @dev The risk hook must use this timestamp during reconciliation rather than the later transaction time.
     */
    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64 cancelledAt);
}
