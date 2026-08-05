// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IChargebackVerifier
 * @notice Minimal verification surface consumed by ChargebackPolicy.
 * @dev The concrete verifier exposes its governance and digest helper functions directly.
 */
interface IChargebackVerifier {
    /**
     * @notice Generic attestation produced by the attestation service.
     * @param schemaId Versioned identifier for the ABI schema consumed by this verifier.
     * @param transformerId Identifier committed to by the attestation service.
     * @param input ABI-encoded `(bytes32 intentHash)` supplied by the caller.
     * @param output ABI-encoded `(bytes32 originalPaymentId, bytes32 disputeId)` verified from evidence.
     * @param signatures Witness signatures over the EIP-712 attestation.
     */
    struct ChargebackAttestation {
        bytes32 schemaId;
        bytes32 transformerId;
        bytes input;
        bytes output;
        bytes[] signatures;
    }

    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error InvalidAttestation();
    error InvalidAttestationSchema(bytes32 schemaId);
    error ManualReleaseNotChargebackable();
    error InvalidPaymentBinding(bytes32 intentHash, bytes32 nullifier);
    error AttestationVerificationFailed();
    error OwnershipRenunciationDisabled();

    /**
     * @notice Validates chargeback evidence against the intent context supplied by the policy.
     * @dev View-only and stateless. The trusted witness determines which transformer is acceptable. This contract
     * validates the signed input/output against live protocol state and does not maintain a transformer allowlist.
     * @param _attestation Signed chargeback evidence for an intent.
     * @param _paymentMethod Payment method snapshotted by the policy when the intent was admitted.
     * @param _isManualRelease Whether settlement occurred without an on-chain payment proof. Manual releases are
     * rejected because no original-payment nullifier exists to bind the dispute.
     * @return disputeId Payment-platform dispute identifier decoded from the evidence.
     * @return disputeNullifier Payment-method-scoped replay key for the dispute.
     */
    function verifyChargeback(
        ChargebackAttestation calldata _attestation,
        bytes32 _paymentMethod,
        bool _isManualRelease
    ) external view returns (bytes32 disputeId, bytes32 disputeNullifier);
}
