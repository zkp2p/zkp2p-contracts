// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPostIntentHook } from "./IPostIntentHook.sol";

interface IOrchestrator {
    
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
        address referrer;                           // Address of the referrer who brought this intent (if any)
        uint256 referrerFee;                        // Fee to be paid to the referrer in preciseUnits (1e16 = 1%)
        IPostIntentHook postIntentHook;             // Address of the post-intent hook that will execute any post-intent actions
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
        address referrer;                           // Address of the referrer (address(0) if no referrer)
        uint256 referrerFee;                        // Fee to be paid to the referrer
        bytes gatingServiceSignature;               // Signature from the deposit's gating service
        uint256 signatureExpiration;                // Timestamp when the gating service signature expires
        IPostIntentHook postIntentHook;             // Optional post-intent hook (address(0) for no hook)
        bytes data;                                 // Additional data for the intent
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
        address indexed fundsTransferredTo,   // Address that funds were transferred to; can be intent.to or postIntentHook address
        uint256 amount,
        bool isManualRelease
    );

    event IntentManagerFeeSnapshotted(bytes32 indexed intentHash, address indexed feeRecipient, uint256 fee);
    event ManagerFeeConfigUpdated(address indexed manager, address indexed feeRecipient, uint256 fee);

    event AllowMultipleIntentsUpdated(bool allowMultiple);

    event PaymentVerifierRegistryUpdated(address indexed paymentVerifierRegistry);
    event PostIntentHookRegistryUpdated(address indexed postIntentHookRegistry);
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
    
    // Not found errors
    error IntentNotFound(bytes32 intentHash);
    error PaymentMethodDoesNotExist(bytes32 paymentMethod);
    error PaymentMethodNotSupported(bytes32 paymentMethod);
    error CurrencyNotSupported(bytes32 paymentMethod, bytes32 currency);
    
    // Whitelist errors
    error PaymentMethodNotWhitelisted(bytes32 paymentMethod);
    error PostIntentHookNotWhitelisted(address hook);
    error EscrowNotWhitelisted(address escrow);
    
    // Amount and fee errors
    error AmountBelowMin(uint256 amount, uint256 min);
    error AmountAboveMax(uint256 amount, uint256 max);
    error AmountExceedsLimit(uint256 amount, uint256 limit);
    error FeeExceedsMaximum(uint256 fee, uint256 maximum);
    error RateBelowMinimum(uint256 rate, uint256 minRate);
    
    // Validation errors
    error AccountHasActiveIntent(address account, bytes32 existingIntent);
    error InvalidReferrerFeeConfiguration();
    error InvalidSignature();
    error SignatureExpired(uint256 expiration, uint256 currentTime);
    error PartialReleaseNotAllowedYet(uint256 currentTime, uint256 allowedTime);

    // Verification errors
    error PaymentVerificationFailed();
    error HashMismatch(bytes32 expected, bytes32 actual);
     
    // Transfer errors
    error TransferFailed(address recipient, uint256 amount);
    error EscrowLockFailed();

    /* ============ View Functions ============ */

    function protocolFee() external view returns (uint256);
    function getIntent(bytes32 intentHash) external view returns (Intent memory);
    function getAccountIntents(address account) external view returns (bytes32[] memory);
    function getIntentManagerFeeSnapshot(bytes32 intentHash) external view returns (address feeRecipient, uint256 fee);
    
    /* ============ External Functions for Users ============ */

    function signalIntent(SignalIntentParams calldata params) external;

    function cancelIntent(bytes32 intentHash) external;

    function fulfillIntent(FulfillIntentParams calldata params) external;

    function releaseFundsToPayer(bytes32 intentHash) external;

    function setManagerFeeConfig(address feeRecipient, uint256 fee) external;

    /* ============ External Functions for Escrow ============ */

    function pruneIntents(bytes32[] calldata intentIds) external;
}
