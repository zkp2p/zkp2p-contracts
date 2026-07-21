// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPostIntentHookV2 } from "./IPostIntentHookV2.sol";
import { IPreIntentHook } from "./IPreIntentHook.sol";
import { IReferralFee } from "./IReferralFee.sol";

/**
 * @title IOrchestratorV2
 * @notice Interface for the V2 orchestrator with pre-intent hooks, whitelist hooks,
 *         manager fee support, and cleanupOrphanedIntents.
 */
interface IOrchestratorV2 {

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

    event IntentReferralFeeDistributed(
        bytes32 indexed intentHash,
        address indexed feeRecipient,
        uint256 feeAmount
    );
    event IntentManagerFeeSnapshotted(bytes32 indexed intentHash, address indexed feeRecipient, uint256 fee);
    event DepositPreIntentHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);
    event DepositWhitelistHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);

    event AllowMultipleIntentsUpdated(bool allowMultiple);

    event PaymentVerifierRegistryUpdated(address indexed paymentVerifierRegistry);
    event RelayerRegistryUpdated(address indexed relayerRegistry);
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    event ProtocolFeeUpdated(uint256 protocolFee);
    event ProtocolFeeRecipientUpdated(address indexed protocolFeeRecipient);
    event PartialManualReleaseDelayUpdated(uint256 partialManualReleaseDelay);

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
    error AccountHasActiveIntent(address account, bytes32 existingIntent);
    error InvalidPostIntentHook(address hook);
    error InvalidPreIntentHook(address hook);
    error InvalidSignature();
    error SignatureExpired(uint256 expiration, uint256 currentTime);

    // Verification errors
    error PaymentVerificationFailed();
    error HashMismatch(bytes32 expected, bytes32 actual);

    // Transfer errors
    error TransferFailed(address recipient, uint256 amount);
    error EscrowLockFailed();

    /* ============ View Functions ============ */

    function getIntent(bytes32 intentHash) external view returns (Intent memory);
    function getAccountIntents(address account) external view returns (bytes32[] memory);
    function getDepositPreIntentHook(address escrow, uint256 depositId) external view returns (IPreIntentHook);
    function getDepositWhitelistHook(address escrow, uint256 depositId) external view returns (IPreIntentHook);

    /* ============ External Functions for Users ============ */

    function signalIntent(SignalIntentParams calldata params) external;
    function setDepositPreIntentHook(address escrow, uint256 depositId, IPreIntentHook hook) external;
    function setDepositWhitelistHook(address escrow, uint256 depositId, IPreIntentHook hook) external;

    function cancelIntent(bytes32 intentHash) external;

    function fulfillIntent(FulfillIntentParams calldata params) external;

    function releaseFundsToPayer(bytes32 intentHash) external;

    /* ============ External Functions for Escrow ============ */

    function pruneIntents(bytes32[] calldata intentIds) external;

    /* ============ External Functions for Anyone ============ */

    function cleanupOrphanedIntents(bytes32[] calldata intentHashes) external;
}
