// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IReceiptVerifier
 * @notice Verification surface for enclave-signed receipt confirmations consumed by DisputeProtectionPolicyV3.
 * @dev The concrete verifier exposes its governance and digest helper functions directly.
 */
interface IReceiptVerifier {
    /**
     * @notice Signed confirmation that the maker's history shows the intent's payment arrived in full.
     * @param intentHash Intent whose off-chain payment was confirmed.
     * @param releaseAt Earliest time the protected payout may be released; nonzero.
     * @param dataHash Hash of `data`.
     * @param signatures Witness signatures over the verifier's EIP-712 digest.
     * @param data `abi.encode(bytes32 paymentMethod, bytes32[] nullifiers)`.
     */
    struct ReceiptAttestation {
        bytes32 intentHash;
        uint64 releaseAt;
        bytes32 dataHash;
        bytes[] signatures;
        bytes data;
    }

    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error InvalidAttestation();
    error NoNullifierCandidates();
    error InvalidPaymentBinding(bytes32 intentHash, bytes32 nullifier);
    error AttestationVerificationFailed();
    error OwnershipRenunciationDisabled();

    /**
     * @notice Validates a receipt confirmation against the payment method the policy recorded for the intent.
     * @dev View-only and stateless. Reverts when the payload is malformed, mismatched, unsigned, names no candidate
     * nullifier, or names none bound to the intent.
     * @param _attestation Signed receipt confirmation for an intent.
     * @param _paymentMethod Payment method the policy recorded when it opened the protection.
     * @return releaseAt Signed earliest release time.
     */
    function verifyReceipt(ReceiptAttestation calldata _attestation, bytes32 _paymentMethod)
        external
        view
        returns (uint64 releaseAt);
}
