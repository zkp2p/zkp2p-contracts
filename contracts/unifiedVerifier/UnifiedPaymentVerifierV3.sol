// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { BaseUnifiedPaymentVerifierV3 } from "./BaseUnifiedPaymentVerifierV3.sol";
import { INullifierRegistryV2 } from "../interfaces/INullifierRegistryV2.sol";
import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";
import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IEscrow } from "../interfaces/IEscrow.sol";

/**
 * @title UnifiedPaymentVerifierV3
 * @notice Verifies payment proofs for multiple payment methods. This is a unified verifier that
 * replaces individual payment verifiers (VenmoVerifier, PayPalVerifier, etc.) with a single
 * configurable contract. This contract holds no critical state and can be swapped easily for another
 * verifier contract.
 *
 * Key features:
 * - Supports multiple payment methods, each with custom configuration
 * - Uses AttestationVerifier to validate offchain payment attestations
 * - Ensures trust anchor integrity for off-chain verification processes
 * - Verifies standardized payment details against provided data
 * @dev The payment attestation should be signed using the EIP-712 standard
 */
contract UnifiedPaymentVerifierV3 is IPaymentVerifier, BaseUnifiedPaymentVerifierV3 {

    /* ============ Constants ============ */

    // Max timestamp buffer
    uint256 private constant MAX_TIMESTAMP_BUFFER = 48 * 60 * 60 * 1000; // 48 hours

    // EIP-712 Domain Separator
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    // EIP-712 Type Hash for PaymentAttestation
    bytes32 private constant PAYMENT_ATTESTATION_TYPEHASH = keccak256(
        "PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"
    );

    // Used to detect V2 orchestrators that expose getDepositPreIntentHook(address,uint256).
    bytes4 private constant GET_DEPOSIT_PRE_INTENT_HOOK_SELECTOR =
        bytes4(keccak256("getDepositPreIntentHook(address,uint256)"));

    /* ============ State Variables ============ */

    // EIP-712 Domain Separator (computed once at deployment)
    bytes32 public immutable DOMAIN_SEPARATOR;

    /* ============ Events ============ */

    /**
     * @notice Capture and emit payment details for offchain reconciliation
     */
    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );

    /* ============ Structs ============ */

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

    struct PaymentAttestation {
        bytes32 intentHash;       // Binds the payment to the intent on Orchestrator
        uint256 releaseAmount;    // Final token amount to release on-chain after FX
        bytes32 dataHash;         // Hash of the additional data to verify integrity
        bytes[] signatures;       // Array of signatures from witnesses
        bytes data;               // Data for verification
        bytes metadata;           // Additional metadata; isn't signed by the witnesses
    }

    /* ============ Constructor ============ */

    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        INullifierRegistryV2 _nullifierRegistry,
        IAttestationVerifier _attestationVerifier
    ) BaseUnifiedPaymentVerifierV3(
        _orchestratorRegistry,
        _nullifierRegistry,
        _attestationVerifier
    ) {
        // Compute EIP-712 domain separator
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("UnifiedPaymentVerifier")), // name
                keccak256(bytes("1")),                      // version
                block.chainid,                              // chainId
                address(this)                               // verifyingContract
            )
        );
    }

    /* ============ External Functions ============ */

    /**
     * ONLY ORCHESTRATOR: Verifies a standardized payment attestation generated by the attestation service.
     * NOTE: This contract has write permissions on nullifier registry, and nullifies the payment after verification.
     * Hence only Orchestrator can call this function to prevent griefing.
     *
     * @param _verifyPaymentData Payment proof and intent details required for verification
     * @return result The payment verification result containing success status, intent hash, and release amount
     * @dev Ensure the orchestrator verifies the intent exists before calling this function
     */
    function verifyPayment(
        VerifyPaymentData calldata _verifyPaymentData
    )
        external
        override
        onlyOrchestrator()
        returns (PaymentVerificationResult memory result)
    {
        PaymentAttestation memory attestation = _decodeAttestation(_verifyPaymentData.paymentProof);
        require(attestation.intentHash == _verifyPaymentData.intentHash, "UPV: Attestation hash mismatch");
        require(attestation.releaseAmount != 0, "UPV: Invalid release amount");

        (
            PaymentDetails memory paymentDetails,
            IntentSnapshot memory intentSnapshot
        ) = _decodeAttestationPayload(attestation.data);
        require(isPaymentMethod[paymentDetails.method], "UPV: Invalid payment method");
        require(paymentDetails.method == intentSnapshot.paymentMethod, "UPV: Payment method mismatch");
        require(paymentDetails.paymentId != bytes32(0), "UPV: Invalid payment ID");
        require(paymentDetails.amount != 0, "UPV: Invalid payment amount");
        require(paymentDetails.currency != bytes32(0), "UPV: Invalid payment currency");

        _validateIntentSnapshot(_verifyPaymentData.intentHash, intentSnapshot);

        bool isValid = _verifyAttestation(attestation);
        require(isValid, "UPV: Invalid attestation");

        // Nullify the payment to prevent double-spending
        _nullifyPayment(paymentDetails.method, paymentDetails.paymentId, attestation.intentHash);

        _emitPaymentDetails(attestation.intentHash, paymentDetails);

        uint256 releaseAmount = _calculateReleaseAmount(attestation.releaseAmount, intentSnapshot.amount);
        result = PaymentVerificationResult({
            success: true,
            intentHash: attestation.intentHash,
            releaseAmount: releaseAmount
        });

        return result;
    }

    /* ============ Internal Functions ============ */

    function _decodeAttestation(bytes memory paymentProof) internal pure returns (PaymentAttestation memory) {
        return abi.decode(paymentProof, (PaymentAttestation));
    }

    function _decodeAttestationPayload(bytes memory paymentData)
        internal
        pure
        returns (PaymentDetails memory paymentDetails, IntentSnapshot memory intentSnapshot)
    {
        (paymentDetails, intentSnapshot) = abi.decode(paymentData, (PaymentDetails, IntentSnapshot));
    }

    /**
     * Verifies the EIP-712 attestation using the attestation verifier. Also verifies the integrity of the
     * verify payment data using the data hash attached to the attestation.
     */
    function _verifyAttestation(PaymentAttestation memory attestation) internal view returns (bool) {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_ATTESTATION_TYPEHASH,
                attestation.intentHash,
                attestation.releaseAmount,
                attestation.dataHash
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                structHash
            )
        );

        // Verify data integrity - the data hash must match what was signed
        require(
            keccak256(attestation.data) == attestation.dataHash,
            "UPV: Data hash mismatch"
        );

        bool isValid = attestationVerifier.verify(
            digest,
            attestation.signatures,
            attestation.data
        );

        return isValid;
    }

    /**
     * Reads intent data from the Orchestrator and checks them against the intent data provided by the
     * attestation verifier.
     */
    function _validateIntentSnapshot(
        bytes32 intentHash,
        IntentSnapshot memory snapshot
    ) internal view {
        require(snapshot.intentHash == intentHash, "UPV: Snapshot hash mismatch");

        if (_isV2Orchestrator(msg.sender)) {
            IOrchestratorV2.Intent memory intentV2 = IOrchestratorV2(msg.sender).getIntent(intentHash);
            _validateSnapshotAgainstIntent(
                snapshot,
                intentV2.payeeId,
                intentV2.amount,
                intentV2.paymentMethod,
                intentV2.fiatCurrency,
                intentV2.conversionRate,
                intentV2.timestamp
            );
        } else {
            IOrchestrator.Intent memory intent = IOrchestrator(msg.sender).getIntent(intentHash);
            _validateSnapshotAgainstIntent(
                snapshot,
                intent.payeeId,
                intent.amount,
                intent.paymentMethod,
                intent.fiatCurrency,
                intent.conversionRate,
                intent.timestamp
            );
        }

        require(snapshot.timestampBuffer <= MAX_TIMESTAMP_BUFFER, "UPV: Snapshot timestamp buffer exceeds maximum");
    }

    function _validateSnapshotAgainstIntent(
        IntentSnapshot memory snapshot,
        bytes32 payeeId,
        uint256 amount,
        bytes32 paymentMethod,
        bytes32 fiatCurrency,
        uint256 conversionRate,
        uint256 signalTimestamp
    ) internal pure {
        require(snapshot.payeeDetails == payeeId, "UPV: Snapshot payee mismatch");
        require(snapshot.amount == amount, "UPV: Snapshot amount mismatch");
        require(snapshot.paymentMethod == paymentMethod, "UPV: Snapshot method mismatch");
        require(snapshot.fiatCurrency == fiatCurrency, "UPV: Snapshot currency mismatch");
        require(snapshot.conversionRate == conversionRate, "UPV: Snapshot rate mismatch");
        require(snapshot.signalTimestamp == signalTimestamp, "UPV: Snapshot timestamp mismatch");
    }

    function _isV2Orchestrator(address orchestrator) internal view returns (bool isV2Orchestrator) {
        (isV2Orchestrator, ) = orchestrator.staticcall(
            abi.encodeWithSelector(
                GET_DEPOSIT_PRE_INTENT_HOOK_SELECTOR,
                address(0),
                0
            )
        );
    }

    /**
     * Nullifies a payment to prevent double-spending
     * @dev Creates a unique nullifier by encoding both the payment method and payment ID together.
     * This prevents collisions where the same payment ID could exist across different payment
     * methods (e.g., Venmo transaction #123 vs PayPal transaction #123).
     */
    function _nullifyPayment(bytes32 paymentMethod, bytes32 paymentId, bytes32 intentHash) internal {
        bytes32 nullifier = keccak256(abi.encodePacked(paymentMethod, paymentId));
        _validateAndAddNullifier(nullifier, intentHash);
    }

    /**
     * Calculates the release amount for an intent by capping the release amount to the intent amount
     */
    function _calculateReleaseAmount(uint256 releaseAmount, uint256 intentAmount) internal pure returns (uint256) {
        if (releaseAmount > intentAmount) {
            return intentAmount;
        }
        return releaseAmount;
    }

    /**
     * Emits the payment details for offchain reconciliation
     */
    function _emitPaymentDetails(bytes32 intentHash, PaymentDetails memory paymentDetails) internal {
        emit PaymentVerified(
            intentHash,                 // Tie the payment details to the intent hash
            paymentDetails.method,
            paymentDetails.currency,
            paymentDetails.amount,
            paymentDetails.timestamp,
            paymentDetails.paymentId,
            paymentDetails.payeeId
        );
    }
}
