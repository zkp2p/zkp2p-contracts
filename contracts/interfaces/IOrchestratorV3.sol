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

    /** @dev Historical recovery record retained for the pre-final deployment source. */
    struct IntentSettlement {
        uint256 releasedAmount;
        uint64 settledAt;
        bool isManualRelease;
    }

    struct IntentCancellation {
        uint64 cancelledAt;
    }

    /* ============ Events ============ */

    event DepositRiskHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);
    event IntentRiskHookSnapshotted(bytes32 indexed intentHash, address indexed riskHook);
    event IntentProtocolFeeSnapshotted(
        bytes32 indexed intentHash,
        address indexed feeRecipient,
        uint256 feeRate
    );
    event IntentGatingAuthorizationConsumed(
        address indexed taker,
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        uint256 nonce
    );
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

    /* ============ Errors ============ */

    error InvalidRiskHook(address hook);
    error RiskHookAdmissionFailed(bytes32 intentHash, address hook, bytes revertData);
    error RiskHookSettlementFailed(bytes32 intentHash, address hook, bytes revertData);
    error InsufficientGasForRiskCallback(uint256 availableGas, uint256 requiredGas);
    error RiskHookSettlementBalanceIncreased(bytes32 intentHash, uint256 beforeBalance, uint256 afterBalance);
    error InvalidRiskHookSettlementConsumption(bytes32 intentHash, uint256 consumed, uint256 grossAmount);
    error RiskCallbackGasLimitTooLow(uint256 gasLimit, uint256 minimum);
    error RiskCallbackGasLimitTooHigh(uint256 gasLimit, uint256 maximum);
    error InvalidContract(address account);
    error InvalidChainId(uint256 suppliedChainId, uint256 actualChainId);

    /* ============ External Functions ============ */

    function setDepositRiskHook(address _escrow, uint256 _depositId, IIntentRiskHook _hook) external;
    function setRiskCallbackGasLimit(uint256 _gasLimit) external;

    /* ============ View Functions ============ */

    function getDepositRiskHook(address _escrow, uint256 _depositId) external view returns (IIntentRiskHook);
    function getIntentRiskHook(bytes32 _intentHash) external view returns (IIntentRiskHook);
    /** @notice Returns the nonce that must be included in the taker's next gated authorization. */
    function getIntentGatingNonce(
        address _taker,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod
    ) external view returns (uint256);
    /** @notice Returns the unprefixed message hash for the current scoped nonce. */
    function getIntentGatingMessageHash(
        SignalIntentParams calldata _params,
        address _taker
    ) external view returns (bytes32);
    /** @notice Returns the aggregate fee rate snapshotted before risk admission. */
    function getIntentTotalFeeRate(bytes32 _intentHash) external view returns (uint256);
    function getRiskIntent(bytes32 _intentHash) external view returns (RiskIntentData memory);
    function getAccountIntentCount(address _account) external view returns (uint256);
    /**
     * @notice Returns the liquidity-unlock timestamp when a cancellation callback failed open.
     * @dev The risk hook must use this timestamp during reconciliation rather than the later transaction time.
     */
    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64 cancelledAt);
}
