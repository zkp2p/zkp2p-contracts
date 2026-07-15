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
        address postIntentHook;
        uint64 createdAt;
    }

    struct IntentSettlement {
        uint256 releasedAmount;
        uint64 settledAt;
    }

    struct IntentCancellation {
        uint64 cancelledAt;
    }

    /* ============ Events ============ */

    event DepositRiskHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);
    event IntentRiskHookSnapshotted(bytes32 indexed intentHash, address indexed riskHook, bool requiresPostIntentHook);
    event RiskHookCallbackFailed(
        bytes32 indexed intentHash,
        address indexed riskHook,
        bytes4 indexed callbackSelector,
        bytes revertData
    );
    event RiskCallbackGasLimitUpdated(uint256 gasLimit);
    event IntentSettlementRecorded(bytes32 indexed intentHash, uint256 releasedAmount, uint64 settledAt);
    event IntentCancellationRecorded(bytes32 indexed intentHash, uint64 cancelledAt);

    /* ============ Errors ============ */

    error InvalidRiskHook(address hook);
    error RiskHookAdmissionFailed(bytes32 intentHash, address hook, bytes revertData);
    error InvalidRiskHookResponse(address hook, bytes response);
    error RequiredPostIntentHookMissing(bytes32 intentHash);
    error RiskCallbackGasLimitTooLow(uint256 gasLimit, uint256 minimum);

    /* ============ External Functions ============ */

    function setDepositRiskHook(address _escrow, uint256 _depositId, IIntentRiskHook _hook) external;
    function setRiskCallbackGasLimit(uint256 _gasLimit) external;

    /* ============ View Functions ============ */

    function getDepositRiskHook(address _escrow, uint256 _depositId) external view returns (IIntentRiskHook);
    function getIntentRiskHook(bytes32 _intentHash) external view returns (IIntentRiskHook);
    function intentRequiresPostIntentHook(bytes32 _intentHash) external view returns (bool);
    function getRiskIntent(bytes32 _intentHash) external view returns (RiskIntentData memory);
    function getAccountIntentCount(address _account) external view returns (uint256);
    /**
     * @notice Returns recovery data when a settlement callback failed open.
     * @dev Successful settlement callbacks leave this record empty.
     */
    function getIntentSettlement(bytes32 _intentHash) external view returns (uint256 releasedAmount, uint64 settledAt);
    /**
     * @notice Returns the liquidity-unlock timestamp when a cancellation callback failed open.
     * @dev The risk hook must use this timestamp during reconciliation rather than the later transaction time.
     */
    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64 cancelledAt);
}
