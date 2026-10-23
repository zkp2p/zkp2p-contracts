// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IReferralFee } from "./IReferralFee.sol";
import { IIntentSettlementPolicy } from "./IIntentSettlementPolicy.sol";
import { IIntentSignalPolicy } from "./IIntentSignalPolicy.sol";

/**
 * @title IOrchestratorV4
 * @notice Interface for the V4 orchestrator with deferred settlement.
 * @dev Intent keeps V3 field order with the intent hooks removed and the hook data replaced by payerCommitment,
 * then appends takerWhitelisted and arbitrator.
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
        bytes payerCommitment;                      // What the payer commits to, e.g. a salted payer ID hash; empty = none
        bool takerWhitelisted;                      // Taker passed the deposit's enabled whitelist at signal; skips the policy
        address arbitrator;                         // Arbitrator of the group the taker signaled through; can release or cancel; zero = none
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
        bytes gatingServiceSignature;               // Signature from the gating service, checked by the signal policy
        uint256 signatureExpiration;                // Timestamp when the gating service signature expires
        bytes payerCommitment;                      // Signed by the gating service; UPV4 requires the attestor to sign its hash
        bytes32 groupId;                            // Allowed group the taker is a member of; its arbitrator rules the intent; zero = none; ignored when the whitelist is off
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
        address releasedBy                          // Depositor or arbitrator for a manual release; zero for a verified payment
    );

    event IntentReferralFeeDistributed(
        bytes32 indexed intentHash,
        address indexed feeRecipient,
        uint256 feeAmount
    );
    event IntentManagerFeeSnapshotted(bytes32 indexed intentHash, address indexed feeRecipient, uint256 fee);
    event SettlementPolicyUpdated(address indexed previousPolicy, address indexed newPolicy);
    event SignalPolicyUpdated(address indexed previousPolicy, address indexed newPolicy);
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

    // Not found errors
    error IntentNotFound(bytes32 intentHash);
    error PaymentMethodDoesNotExist(bytes32 paymentMethod);
    error PaymentMethodNotSupported(bytes32 paymentMethod);
    error CurrencyNotSupported(bytes32 paymentMethod, bytes32 currency);

    // Whitelist errors
    error PaymentMethodNotWhitelisted(bytes32 paymentMethod);
    error EscrowNotWhitelisted(address escrow);
    error TakerNotWhitelisted(address escrow, uint256 depositId, bytes32 paymentMethod, address taker);

    // Amount and fee errors
    error AmountBelowMin(uint256 amount, uint256 min);
    error AmountAboveMax(uint256 amount, uint256 max);
    error AmountExceedsLimit(uint256 amount, uint256 limit);
    error FeeExceedsMaximum(uint256 fee, uint256 maximum);
    error RateBelowMinimum(uint256 rate, uint256 minRate);
    error PartialReleaseRequiresArbitrator(uint256 releaseAmount, uint256 intentAmount);

    // Validation errors
    error AccountHasActiveIntent(address account, bytes32 existingIntent);

    // Verification errors
    error PaymentVerificationFailed();
    error HashMismatch(bytes32 expected, bytes32 actual);

    // Transfer errors
    error TransferFailed(address recipient, uint256 amount);
    error EscrowLockFailed();

    /* ============ View Functions ============ */

    function getIntent(bytes32 intentHash) external view returns (Intent memory);
    function getAccountIntents(address account) external view returns (bytes32[] memory);
    function settlementPolicy() external view returns (IIntentSettlementPolicy);
    function signalPolicy() external view returns (IIntentSignalPolicy);

    /* ============ External Functions for Users ============ */

    /// @notice Signals an intent and locks its escrow funds; a set signal policy must accept it.
    function signalIntent(SignalIntentParams calldata params) external;

    /// @notice Sets the signal policy that validates every later signal; zero disables signal checks.
    function setSignalPolicy(IIntentSignalPolicy policy) external;

    /// @notice Sets the settlement policy applied to every later settlement; zero disables protection.
    function setSettlementPolicy(IIntentSettlementPolicy policy) external;

    /// @notice Cancels an intent as its owner or arbitrator and unlocks its funds.
    function cancelIntent(bytes32 intentHash) external;

    /// @notice Verifies payment and settles immediately or defers the net payout.
    /// @dev Forwards the signed settlement data to the current settlement policy.
    function fulfillIntent(FulfillIntentParams calldata params) external;

    /// @notice Manually settles an intent: in full as its depositor, or any part as its arbitrator.
    function releaseFundsToPayer(bytes32 intentHash, uint256 releaseAmount) external;

    /// @notice Extends an intent's expiry for free as its arbitrator; the escrow must let this orchestrator extend.
    function extendIntent(bytes32 intentHash, uint256 additionalTime) external;

    /* ============ External Functions for Escrow ============ */

    /// @notice Prunes intents belonging to the calling escrow.
    function pruneIntents(bytes32[] calldata intentIds) external;

    /* ============ External Functions for Anyone ============ */

    /// @notice Prunes intents no longer present on their escrow.
    function cleanupOrphanedIntents(bytes32[] calldata intentHashes) external;
}
