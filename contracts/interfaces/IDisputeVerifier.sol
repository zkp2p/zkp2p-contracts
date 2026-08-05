// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IDisputeVerifier
 * @notice Minimal verification surface consumed by DisputePolicy.
 * @dev The concrete verifier exposes its governance and digest helper functions directly.
 */
interface IDisputeVerifier {
    /**
     * @notice Signed evidence tying a dispute payload to one intent.
     * @param intentHash Intent whose off-chain payment was disputed.
     * @param dataHash Hash of the ABI-encoded `DisputeDetails`.
     * @param signatures Witness signatures over the verifier's EIP-712 digest.
     * @param data ABI-encoded `DisputeDetails`.
     */
    struct DisputeAttestation {
        bytes32 intentHash;
        bytes32 dataHash;
        bytes[] signatures;
        bytes data;
    }

    /**
     * @notice Payment and dispute identifiers attested by the dispute witnesses.
     * @param paymentMethod Payment rail used by the original payment.
     * @param originalPaymentId Provider identifier for the original payment.
     * @param disputeId Provider identifier for the chargeback or reversal.
     * @param paymentAmount Attested off-chain payment amount.
     * @param paymentCurrency Attested off-chain payment currency.
     */
    struct DisputeDetails {
        bytes32 paymentMethod;
        bytes32 originalPaymentId;
        bytes32 disputeId;
        uint256 paymentAmount;
        bytes32 paymentCurrency;
    }

    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error InvalidAttestation();
    error InvalidPaymentBinding(bytes32 intentHash, bytes32 nullifier);
    error AttestationVerificationFailed();
    error OwnershipRenunciationDisabled();

    /**
     * @notice Validates dispute evidence against the intent context supplied by the policy.
     * @dev View-only and stateless. Reverts when the payload is malformed, mismatched, unsigned, or not bound to the
     * intent's original payment nullifier.
     * @param _attestation Signed dispute evidence for an intent.
     * @param _paymentMethod Payment method snapshotted by the policy when the intent was admitted.
     * @return disputeId Payment-platform dispute identifier decoded from the evidence.
     * @return disputeNullifier Payment-method-scoped replay key for the dispute.
     */
    function verifyDispute(DisputeAttestation calldata _attestation, bytes32 _paymentMethod)
        external
        view
        returns (bytes32 disputeId, bytes32 disputeNullifier);
}
