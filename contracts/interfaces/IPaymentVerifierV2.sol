// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

interface IPaymentVerifierV2 {
    struct VerifyPaymentData {
        bytes32 intentHash;                     // The hash of the intent being fulfilled
        bytes paymentProof;                     // Payment proof
        bytes data;                             // Additional data provided by the taker
    }

    struct PaymentDetails {
        bytes32 method;           // Payment method hash (e.g., "venmo", "paypal", "wise")
        bytes32 payeeId;          // Payment recipient ID (hashed payee details to preserve privacy)
        uint256 amount;           // Payment amount in smallest currency unit (i.e. cents)
        bytes32 currency;         // Payment currency hash (e.g., "USD", "EUR")
        uint256 timestamp;        // Payment timestamp in UTC in milliseconds
        bytes32 paymentId;        // Hashed payment identifier from the service (e.g. hashed venmo payment ID to preserve privacy)
    }

    struct IntentSnapshot {
        bytes32 intentHash;
        uint256 amount;
        bytes32 paymentMethod;
        bytes32 fiatCurrency;
        bytes32 payeeDetails;
        uint256 conversionRate;
        uint256 signalTimestamp;
        uint256 timestampBuffer;
        bytes32 payerCommitmentHash;  // keccak256 of the O4 intent's payer commitment, zero if empty; the attestor checked the payer
    }

    /// @dev Must stay fully static and preserve the V1 three-field prefix: OrchestratorV3 calls
    /// through IPaymentVerifier and reads only the first three words. Dynamic data must be a
    /// separate trailing return value, never a field inside this struct, so the V1 prefix remains unchanged.
    struct PaymentVerificationResultV2 {
        bool success;
        bytes32 intentHash;
        uint256 releaseAmount;
        uint256 attestedReleaseAmount; // Signed release amount before the intent cap.
        PaymentDetails payment;
        IntentSnapshot intent;
    }

    /// @notice Verifies a payment and returns all verified fields plus the signed settlement data.
    /// @dev The verifier returns settlementData uninterpreted; the settlement policy decodes and validates it.
    function verifyPayment(VerifyPaymentData calldata _verifyPaymentData)
        external
        returns (PaymentVerificationResultV2 memory result, bytes memory settlementData);
}
