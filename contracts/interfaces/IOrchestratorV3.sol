// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "./IIntentRiskHook.sol";
import { IPostIntentHookV2 } from "./IPostIntentHookV2.sol";
import { IPreIntentHook } from "./IPreIntentHook.sol";
import { IReferralFee } from "./IReferralFee.sol";

/**
 * @title IOrchestratorV3
 * @notice Standalone interface for the V3 orchestrator: the full V2 intent lifecycle surface
 *         (pre-intent hooks, manager fees, orphan cleanup) plus snapshotted
 *         governance-selected risk callbacks. Deliberately relayer-free.
 */
interface IOrchestratorV3 {

    /* ============ Structs ============ */

    struct Intent {
        address owner;                              // Address of the intent owner
        address to;                                 // Address to forward funds to (can be same as owner)
        address escrow;                             // Address of the escrow contract holding the deposit
        uint256 depositId;                          // ID of the deposit the intent is associated with
        uint256 amount;                             // Amount of the deposit.token the owner wants to take
        uint256 timestamp;                          // Timestamp of the intent
        bytes32 paymentMethod;                      // The payment method to be used for the offchain payment
        bytes32 fiatCurrency;                       // Currency code that the owner is paying in offchain (keccak256 hash of the currency code)
        uint256 conversionRate;                     // Conversion rate of deposit token to fiat currency at the time of intent
        bytes32 payeeId;                            // Hashed payee identifier to whom the owner will pay offchain
        IReferralFee.ReferralFee[] referralFees;    // Referral fee recipients and fee rates paid by the taker
        IPostIntentHookV2 postIntentHook;            // Address of the post-intent hook that will execute any post-intent actions
        bytes data;                                 // Additional data to be passed to the post-intent hook contract
    }

    struct SignalIntentParams {
        address escrow;                             // The escrow contract where the deposit is held
        uint256 depositId;                          // The ID of the deposit the taker intends to use
        uint256 amount;                             // The amount of deposit.token the user wants to take
        address to;                                 // Address to forward funds to
        bytes32 paymentMethod;                      // The payment method to be used for the offchain payment
        bytes32 fiatCurrency;                       // The currency code for offchain payment
        uint256 conversionRate;                     // The conversion rate agreed offchain
        IReferralFee.ReferralFee[] referralFees;    // Referral fee recipients and fee rates paid by the taker
        bytes gatingServiceSignature;               // Signature from the deposit's gating service
        uint256 signatureExpiration;                // Timestamp when the gating service signature expires
        IPostIntentHookV2 postIntentHook;           // Optional post-intent hook (address(0) for no hook)
        bytes preIntentHookData;                    // Ephemeral data passed only to the pre-intent hook during signalIntent
        bytes data;                                 // Signal data persisted in Intent and forwarded as post-intent hook signalHookData
    }

    struct FulfillIntentParams {
        bytes paymentProof;                         // Payment proof. Can be Groth16 Proof, TLSNotary proof, TLSProxy proof, attestation etc.
        bytes32 intentHash;                         // Identifier of intent being fulfilled
        bytes verificationData;                     // Additional data for payment verifier
        bytes postIntentHookData;                   // Additional data for post intent hook
    }

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

    event IntentSignaled(
        bytes32 indexed intentHash,
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        address owner,
        address to,
        uint256 amount,
        bytes32 fiatCurrency,
        uint256 conversionRate,
        uint256 timestamp
    );

    event IntentPruned(
        bytes32 indexed intentHash
    );

    event IntentFulfilled(
        bytes32 indexed intentHash,
        address indexed fundsTransferredTo,
        uint256 amount,
        bool isManualRelease
    );

    event IntentFeeDistributed(
        bytes32 indexed intentHash,
        IIntentRiskHook.FeeType feeType,
        address indexed recipient,
        uint256 amount
    );
    event IntentManagerFeeSnapshotted(bytes32 indexed intentHash, address indexed feeRecipient, uint256 fee);
    event DepositPreIntentHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);

    event PaymentVerifierRegistryUpdated(address indexed paymentVerifierRegistry);
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    event ProtocolFeeUpdated(uint256 protocolFee);
    event ProtocolFeeRecipientUpdated(address indexed protocolFeeRecipient);
    event PartialManualReleaseDelayUpdated(uint256 partialManualReleaseDelay);

    event RiskHookUpdated(address indexed oldHook, address indexed newHook);
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

    /* ============ Standardized Custom Errors ============ */

    // Zero value errors
    error ZeroAddress();
    error ZeroValue();

    // Authorization errors
    error UnauthorizedEscrowCaller(address caller);
    error UnauthorizedCaller(address caller, address authorized);
    error UnauthorizedCallerOrDelegate(address caller, address owner, address delegate);

    // Not found errors
    error IntentNotFound(bytes32 intentHash);
    error PaymentMethodDoesNotExist(bytes32 paymentMethod);
    error PaymentMethodNotSupported(bytes32 paymentMethod);
    error CurrencyNotSupported(bytes32 paymentMethod, bytes32 currency);

    // Whitelist errors
    error PaymentMethodNotWhitelisted(bytes32 paymentMethod);
    error EscrowNotWhitelisted(address escrow);

    // Amount and fee errors
    error AmountBelowMin(uint256 amount, uint256 min);
    error AmountAboveMax(uint256 amount, uint256 max);
    error AmountExceedsLimit(uint256 amount, uint256 limit);
    error FeeExceedsMaximum(uint256 fee, uint256 maximum);
    error RateBelowMinimum(uint256 rate, uint256 minRate);

    // Validation errors
    error InvalidPostIntentHook(address hook);
    error InvalidPreIntentHook(address hook);
    error InvalidSignature();
    error GatingSignatureAlreadyUsed(bytes32 digest);
    error SignatureExpired(uint256 expiration, uint256 currentTime);

    // Verification errors
    error PaymentVerificationFailed();
    error HashMismatch(bytes32 expected, bytes32 actual);

    // Transfer errors
    error TransferFailed(address recipient, uint256 amount);
    error EscrowLockFailed();

    // Risk hook errors
    error InvalidRiskHook(address hook);
    error RiskHookAdmissionFailed(bytes32 intentHash, address hook, bytes revertData);
    error RiskHookSettlementFailed(bytes32 intentHash, address hook, bytes revertData);
    error InsufficientGasForRiskCallback(uint256 availableGas, uint256 requiredGas);
    error RiskHookSettlementBalanceIncreased(bytes32 intentHash, uint256 beforeBalance, uint256 afterBalance);
    error InvalidRiskHookSettlementConsumption(bytes32 intentHash, uint256 consumed, uint256 grossAmount);
    error RiskCallbackGasLimitTooLow(uint256 gasLimit, uint256 minimum);
    error IntentCancellationNotRecorded(bytes32 intentHash);
    error UnauthorizedCancellationAcknowledger(address caller, address riskHook);

    /* ============ External Functions for Users ============ */

    function signalIntent(SignalIntentParams calldata params) external;
    function setDepositPreIntentHook(address escrow, uint256 depositId, IPreIntentHook hook) external;

    function cancelIntent(bytes32 intentHash) external;

    function fulfillIntent(FulfillIntentParams calldata params) external;

    /** @notice Manually releases an intent through risk settlement and its configured post-intent hook, if any. */
    function releaseFundsToPayer(bytes32 intentHash) external;

    /** @notice Clears durable recovery data after the failed risk hook completes reconciliation. */
    function acknowledgeIntentCancellation(bytes32 _intentHash) external;

    /* ============ External Functions for Escrow ============ */

    function pruneIntents(bytes32[] calldata intentIds) external;

    /* ============ External Functions for Anyone ============ */

    function cleanupOrphanedIntents(bytes32[] calldata intentHashes) external;

    /* ============ Governance Functions ============ */

    function setRiskHook(IIntentRiskHook _hook) external;
    function setRiskCallbackGasLimit(uint256 _gasLimit) external;

    /* ============ View Functions ============ */

    function getIntent(bytes32 intentHash) external view returns (Intent memory);
    function getAccountIntents(address account) external view returns (bytes32[] memory);
    function getDepositPreIntentHook(address escrow, uint256 depositId) external view returns (IPreIntentHook);
    function riskHook() external view returns (IIntentRiskHook);
    function getIntentRiskHook(bytes32 _intentHash) external view returns (IIntentRiskHook);
    function getRiskIntent(bytes32 _intentHash) external view returns (RiskIntentData memory);
    /**
     * @notice Returns the liquidity-unlock timestamp when a cancellation callback failed open.
     * @dev The risk hook must use this timestamp during reconciliation rather than the later transaction time.
     */
    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64 cancelledAt);
}
