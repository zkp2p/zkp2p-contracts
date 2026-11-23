// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { BaseUnifiedPaymentVerifierV5 } from "./BaseUnifiedPaymentVerifierV5.sol";
import { INullifierRegistryV3 } from "../interfaces/INullifierRegistryV3.sol";
import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";
import { ERC165Checker } from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import { IOrchestratorV4 } from "../interfaces/IOrchestratorV4.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IPaymentVerifierV2 } from "../interfaces/IPaymentVerifierV2.sol";
import { PaymentNullifierLib } from "../lib/PaymentNullifierLib.sol";

/**
 * @title UnifiedPaymentVerifierV5
 * @notice Preserves V4 payment verification and consumes every signed identifier of a payment, so two proofs of
 * the same transfer that name it by different identifiers cannot both settle.
 *
 * Key features:
 * - Supports Orchestrator V2/V3 and V4 intent layouts; rejects V1
 * - Supports multiple payment methods, each with custom configuration
 * - Uses AttestationVerifier to validate offchain payment attestations
 * - Ensures trust anchor integrity for off-chain verification processes
 * - Verifies standardized payment details against provided data
 * - Consumes one nullifier per signed payment ID, all bound to the same intent
 * @dev attestation.data is `abi.encode(SignedPaymentDetails, IntentSnapshot, bytes settlementData)`, signed under
 * this deployment's EIP-712 domain. settlementData is opaque here and to OrchestratorV4; the settlement policy
 * decodes it.
 * @dev The attestation service lists every identifier it authenticated for the transfer, primary first. The
 * returned `PaymentDetails` and `PaymentVerified` carry the primary only, so the orchestrator's return layout and
 * existing event consumers are unchanged.
 */
contract UnifiedPaymentVerifierV5 is IPaymentVerifierV2, BaseUnifiedPaymentVerifierV5 {

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

    /**
     * @notice One consumed payment ID. `PaymentVerified` carries only the primary; this carries all of them.
     */
    event PaymentIdConsumed(bytes32 indexed intentHash, bytes32 indexed scheme, bytes32 id);

    /* ============ Structs ============ */

    struct PaymentId {
        bytes32 scheme;           // Identifier kind; PaymentNullifierLib.NATIVE_SCHEME for the platform's own ID
        bytes32 id;               // Hashed identifier
    }

    struct SignedPaymentDetails {
        bytes32 method;           // Payment method hash (e.g., "venmo", "paypal", "wise")
        bytes32 payeeId;          // Payment recipient ID (hashed payee details to preserve privacy)
        uint256 amount;           // Payment amount in smallest currency unit (i.e. cents)
        bytes32 currency;         // Payment currency hash (e.g., "USD", "EUR")
        uint256 timestamp;        // Payment timestamp in UTC in milliseconds
        PaymentId[] paymentIds;   // Every authenticated identifier of the transfer, primary first
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
        INullifierRegistryV3 _nullifierRegistry,
        IAttestationVerifier _attestationVerifier
    ) BaseUnifiedPaymentVerifierV5(
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
     * @return result Fully static verified result with the V1 three-word prefix and uncapped attested amount
     * @return settlementData Signed settlement data, returned uninterpreted
     * @dev Ensure the orchestrator verifies the intent exists before calling this function
     */
    function verifyPayment(
        IPaymentVerifierV2.VerifyPaymentData calldata _verifyPaymentData
    )
        external
        override
        onlyOrchestrator()
        returns (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory settlementData)
    {
        PaymentAttestation memory attestation = _decodeAttestation(_verifyPaymentData.paymentProof);
        require(attestation.intentHash == _verifyPaymentData.intentHash, "UPV: Attestation hash mismatch");
        require(attestation.releaseAmount != 0, "UPV: Invalid release amount");

        SignedPaymentDetails memory signedDetails;
        IntentSnapshot memory intentSnapshot;
        (signedDetails, intentSnapshot, settlementData) = _decodeAttestationPayload(attestation.data);
        require(isPaymentMethod[signedDetails.method], "UPV: Invalid payment method");
        require(signedDetails.method == intentSnapshot.paymentMethod, "UPV: Payment method mismatch");
        require(signedDetails.paymentIds.length != 0, "UPV: Invalid payment ID");
        require(signedDetails.amount != 0, "UPV: Invalid payment amount");
        require(signedDetails.currency != bytes32(0), "UPV: Invalid payment currency");

        _validateIntentSnapshot(_verifyPaymentData.intentHash, intentSnapshot);

        bool isValid = _verifyAttestation(attestation);
        require(isValid, "UPV: Invalid attestation");

        // Nullify every payment ID to prevent double-spending
        _nullifyPayment(signedDetails.method, signedDetails.paymentIds, attestation.intentHash);

        PaymentDetails memory paymentDetails = PaymentDetails({
            method: signedDetails.method,
            payeeId: signedDetails.payeeId,
            amount: signedDetails.amount,
            currency: signedDetails.currency,
            timestamp: signedDetails.timestamp,
            paymentId: signedDetails.paymentIds[0].id
        });
        _emitPaymentDetails(attestation.intentHash, paymentDetails);

        uint256 releaseAmount = _calculateReleaseAmount(attestation.releaseAmount, intentSnapshot.amount);
        result = IPaymentVerifierV2.PaymentVerificationResultV2({
            success: true,
            intentHash: attestation.intentHash,
            releaseAmount: releaseAmount,
            attestedReleaseAmount: attestation.releaseAmount,
            payment: paymentDetails,
            intent: intentSnapshot
        });
    }

    /* ============ Internal Functions ============ */

    function _decodeAttestation(bytes memory paymentProof) internal pure returns (PaymentAttestation memory) {
        return abi.decode(paymentProof, (PaymentAttestation));
    }

    function _decodeAttestationPayload(bytes memory paymentData)
        internal
        pure
        returns (
            SignedPaymentDetails memory signedDetails,
            IntentSnapshot memory intentSnapshot,
            bytes memory settlementData
        )
    {
        (signedDetails, intentSnapshot, settlementData) =
            abi.decode(paymentData, (SignedPaymentDetails, IntentSnapshot, bytes));
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

        if (ERC165Checker.supportsInterface(msg.sender, type(IOrchestratorV4).interfaceId)) {
            IOrchestratorV4.Intent memory intentV4 = IOrchestratorV4(msg.sender).getIntent(intentHash);
            _validateSnapshotAgainstIntent(
                snapshot,
                intentV4.payeeId,
                intentV4.amount,
                intentV4.paymentMethod,
                intentV4.fiatCurrency,
                intentV4.conversionRate,
                intentV4.timestamp,
                intentV4.payerCommitment.length == 0 ? bytes32(0) : keccak256(intentV4.payerCommitment),
                intentV4.owner
            );
        } else if (_isV2Orchestrator(msg.sender)) {
            IOrchestratorV2.Intent memory intentV2 = IOrchestratorV2(msg.sender).getIntent(intentHash);
            _validateSnapshotAgainstIntent(
                snapshot,
                intentV2.payeeId,
                intentV2.amount,
                intentV2.paymentMethod,
                intentV2.fiatCurrency,
                intentV2.conversionRate,
                intentV2.timestamp,
                bytes32(0),
                intentV2.owner
            );
        } else {
            revert("UPV: Unsupported orchestrator");
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
        uint256 signalTimestamp,
        bytes32 payerCommitmentHash,
        address intentOwner
    ) internal pure {
        require(snapshot.payeeDetails == payeeId, "UPV: Snapshot payee mismatch");
        require(snapshot.amount == amount, "UPV: Snapshot amount mismatch");
        require(snapshot.paymentMethod == paymentMethod, "UPV: Snapshot method mismatch");
        require(snapshot.fiatCurrency == fiatCurrency, "UPV: Snapshot currency mismatch");
        require(snapshot.conversionRate == conversionRate, "UPV: Snapshot rate mismatch");
        require(snapshot.signalTimestamp == signalTimestamp, "UPV: Snapshot timestamp mismatch");
        require(snapshot.payerCommitmentHash == payerCommitmentHash, "UPV: Snapshot payer commitment mismatch");
        require(snapshot.owner == intentOwner, "UPV: Snapshot owner mismatch");
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
     * Nullifies every signed ID of a payment to prevent double-spending
     * @dev Each nullifier encodes the payment method, the ID's scheme and the ID together. This prevents
     * collisions where the same ID could exist across different payment methods (e.g., Venmo transaction #123
     * vs PayPal transaction #123) or across different kinds of ID on one method.
     * @dev One spent or repeated ID reverts the whole settlement, so no ID of a rejected payment is consumed.
     */
    function _nullifyPayment(bytes32 paymentMethod, PaymentId[] memory paymentIds, bytes32 intentHash) internal {
        bytes32[] storage required = requiredSchemes[paymentMethod];
        for (uint256 i = 0; i < required.length; i++) {
            require(_hasScheme(paymentIds, required[i]), "UPV: Missing required payment ID scheme");
        }

        for (uint256 i = 0; i < paymentIds.length; i++) {
            PaymentId memory paymentId = paymentIds[i];
            require(paymentId.id != bytes32(0), "UPV: Invalid payment ID");
            _validateAndAddNullifier(
                PaymentNullifierLib.key(paymentMethod, paymentId.scheme, paymentId.id), intentHash
            );
            emit PaymentIdConsumed(intentHash, paymentId.scheme, paymentId.id);
        }
    }

    function _hasScheme(PaymentId[] memory paymentIds, bytes32 scheme) internal pure returns (bool) {
        for (uint256 i = 0; i < paymentIds.length; i++) {
            if (paymentIds[i].scheme == scheme) return true;
        }
        return false;
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
