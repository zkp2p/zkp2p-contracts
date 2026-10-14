// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IRelayerRegistry } from "./IRelayerRegistry.sol";
import { IReferralFee } from "./IReferralFee.sol";
import { IIntentLifecycleHookV2 } from "./IIntentLifecycleHookV2.sol";
import { IPreIntentHook } from "./IPreIntentHook.sol";

/**
 * @title IOrchestratorV4
 * @notice Interface for the V4 orchestrator with deferred settlement.
 * @dev Intent retains the V3 ABI layout; data holds opaque lifecycle hook data and postIntentHook is always zero.
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
        address postIntentHook;                     // Reserved V3 layout field; always address(0)
        bytes data;                                 // Opaque lifecycle hook data; empty = none
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
        bytes data;                                 // Opaque lifecycle hook data persisted in Intent; empty = none
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
    event LifecycleHookUpdated(address indexed previousHook, address indexed newHook);
    event IntentLifecycleHookSnapshotted(bytes32 indexed intentHash, address indexed lifecycleHook);
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

    // Amount and fee errors
    error AmountBelowMin(uint256 amount, uint256 min);
    error AmountAboveMax(uint256 amount, uint256 max);
    error AmountExceedsLimit(uint256 amount, uint256 limit);
    error FeeExceedsMaximum(uint256 fee, uint256 maximum);
    error RateBelowMinimum(uint256 rate, uint256 minRate);

    // Validation errors
    error AccountHasActiveIntent(address account, bytes32 existingIntent);
    error InvalidPreIntentHook(address hook);
    error InvalidLifecycleHook(address hook);
    error InvalidSignature();
    error LifecycleHookDataRequiresHook();
    error LifecycleHookDataRequiresGatingService();
    error SignatureExpired(uint256 expiration, uint256 currentTime);

    // Verification errors
    error PaymentVerificationFailed();
    error HashMismatch(bytes32 expected, bytes32 actual);

    // Transfer errors
    error TransferFailed(address recipient, uint256 amount);
    error EscrowLockFailed();

    /* ============ View Functions ============ */

    /// @notice Returns the active intent.
    function getIntent(bytes32 intentHash) external view returns (Intent memory);

    /// @notice Returns active intent hashes owned by the account.
    function getAccountIntents(address account) external view returns (bytes32[] memory);

    /// @notice Returns the configured deposit pre-intent hook.
    function getDepositPreIntentHook(address escrow, uint256 depositId) external view returns (IPreIntentHook);

    /// @notice Returns the hook selected for future intents.
    function lifecycleHook() external view returns (IIntentLifecycleHookV2);

    /// @notice Returns the hook snapshotted for the intent.
    function getIntentLifecycleHook(bytes32 intentHash) external view returns (IIntentLifecycleHookV2);

    /// @notice Returns the registry used for relayer admission and lifecycle settlement rules.
    function relayerRegistry() external view returns (IRelayerRegistry);

    /* ============ External Functions for Users ============ */

    /// @notice Signals an intent and locks its escrow funds, with optional opaque lifecycle hook data.
    /// @dev Non-empty data requires a lifecycle hook and a gating service for the deposit's payment method.
    /// Its keccak256(data) is appended to the gating message covered by the service's signature.
    /// Empty data preserves the plain V3 gating message byte-for-byte. Only the lifecycle hook interprets this data.
    function signalIntent(SignalIntentParams calldata params) external;

    /// @notice Sets the deposit pre-intent hook as depositor or delegate.
    function setDepositPreIntentHook(address escrow, uint256 depositId, IPreIntentHook hook) external;

    /// @notice Sets a compatible lifecycle hook for future intents; zero disables callbacks.
    function setLifecycleHook(IIntentLifecycleHookV2 hook) external;

    /// @notice Cancels the caller's intent and unlocks its funds.
    function cancelIntent(bytes32 intentHash) external;

    /// @notice Verifies payment and settles immediately or defers the net payout.
    /// @dev Forwards stored lifecycle hook data and raw signed extension bytes to the snapshotted lifecycle hook.
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
