// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IReferralFee } from "./IReferralFee.sol";
import { IIntentSettlementPolicy } from "./IIntentSettlementPolicy.sol";
import { IPreIntentHook } from "./IPreIntentHook.sol";

/**
 * @title IOrchestratorV4
 * @notice Interface for the V4 orchestrator with deferred settlement.
 * @dev Intent keeps V3 field order with the post-intent hook removed; data holds opaque settlement policy data.
 * DisputeProtectionPolicyV2 uses a raw 32-byte conditions hash (or empty); only the snapshotted policy interprets data.
 */
interface IOrchestratorV4 {

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
        bytes data;                                 // Opaque settlement policy data; empty = none
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
        bytes preIntentHookData;                    // Ephemeral data passed only to the pre-intent hook during signalIntent
        bytes data;                                 // Opaque settlement policy data persisted in Intent; empty = none
    }

    struct FulfillIntentParams {
        bytes paymentProof;                         // Payment proof. Can be Groth16 Proof, TLSNotary proof, TLSProxy proof, attestation etc.
        bytes32 intentHash;                         // Identifier of intent being fulfilled
        bytes verificationData;                     // Additional data for payment verifier
    }

    /* ============ Events ============ */

    event IntentPayoutDeferred(bytes32 indexed intentHash, address indexed recipient, address indexed vault, uint256 amount);

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
    event SettlementPolicyUpdated(address indexed previousPolicy, address indexed newPolicy);
    event IntentSettlementPolicySnapshotted(bytes32 indexed intentHash, address indexed settlementPolicy);
    event AllowMultipleIntentsUpdated(bool allowMultiple);

    event RelayerRegistryUpdated(address indexed relayerRegistry);
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    event ProtocolFeeUpdated(uint256 protocolFee);
    event ProtocolFeeRecipientUpdated(address indexed protocolFeeRecipient);

    /* ============ Standardized Custom Errors ============ */

    // Zero value errors
    error ZeroAddress();

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
    error TakerNotWhitelisted(address escrow, uint256 depositId, bytes32 paymentMethod, address taker);
    error InvalidWhitelistPolicy(address policy);

    // Amount and fee errors
    error AmountBelowMin(uint256 amount, uint256 min);
    error AmountAboveMax(uint256 amount, uint256 max);
    error AmountExceedsLimit(uint256 amount, uint256 limit);
    error FeeExceedsMaximum(uint256 fee, uint256 maximum);
    error RateBelowMinimum(uint256 rate, uint256 minRate);

    // Validation errors
    error AccountHasActiveIntent(address account, bytes32 existingIntent);
    error InvalidPreIntentHook(address hook);
    error InvalidSettlementPolicy(address policy);
    error InvalidSignature();
    error GatingDigestAlreadyUsed(bytes32 digest);
    error DataRequiresPolicy();
    error DataRequiresGatingService();
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
    function settlementPolicy() external view returns (IIntentSettlementPolicy);
    function getIntentSettlementPolicy(bytes32 intentHash) external view returns (IIntentSettlementPolicy);

    /* ============ External Functions for Users ============ */

    /// @notice Signals an intent and locks its escrow funds, with optional opaque settlement policy data.
    /// @dev Non-empty data requires a settlement policy and a gating service for the deposit's payment method.
    /// Its keccak256(data) is appended to the gating message covered by the service's signature.
    /// Empty data preserves the plain V3 gating message byte-for-byte. Only the settlement policy interprets this data.
    /// For DisputeProtectionPolicyV2, pass abi.encodePacked(conditionsHash) or empty data; O4 checks no data format.
    /// Each gating message can create only one intent, including after cancellation or settlement.
    function signalIntent(SignalIntentParams calldata params) external;

    /// @notice Sets the deposit pre-intent hook as depositor or delegate.
    function setDepositPreIntentHook(address escrow, uint256 depositId, IPreIntentHook hook) external;

    /// @notice Sets a compatible settlement policy for future intents; zero disables protection.
    function setSettlementPolicy(IIntentSettlementPolicy policy) external;

    /// @notice Cancels the caller's intent and unlocks its funds.
    function cancelIntent(bytes32 intentHash) external;

    /// @notice Verifies payment and settles immediately or defers the net payout.
    /// @dev Forwards stored settlement policy data and raw signed extension bytes to the snapshotted settlement policy.
    function fulfillIntent(FulfillIntentParams calldata params) external;

    /// @notice Manually settles an intent as its depositor.
    function releaseFundsToPayer(bytes32 intentHash) external;

    /* ============ External Functions for Escrow ============ */

    /// @notice Prunes intents belonging to the calling escrow.
    function pruneIntents(bytes32[] calldata intentIds) external;

    /* ============ External Functions for Anyone ============ */

    /// @notice Prunes intents no longer present on their escrow.
    function cleanupOrphanedIntents(bytes32[] calldata intentHashes) external;
}
