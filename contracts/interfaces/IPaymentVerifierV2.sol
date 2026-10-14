// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IPaymentVerifier} from "./IPaymentVerifier.sol";

interface IPaymentVerifierV2 {
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
    }

    /// @dev Must stay fully static and preserve the V1 three-field prefix: OrchestratorV3 calls
    /// through IPaymentVerifier and reads only the first three words. Dynamic data must be a
    /// separate trailing return value, never a field inside this struct.
    struct PaymentVerificationResultV2 {
        bool success;
        bytes32 intentHash;
        uint256 releaseAmount;
        bool balanceFunded; // Attestation-signed: payment was funded from the payer's platform balance.
        uint256 attestedReleaseAmount; // Signed release amount before the intent cap.
        PaymentDetails payment;
        IntentSnapshot intent;
    }

    /// @notice Verifies a payment and returns all verified fields plus signed extension data (never unsigned metadata).
    function verifyPayment(IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData)
        external
        returns (PaymentVerificationResultV2 memory result, bytes memory extensionData);
}
