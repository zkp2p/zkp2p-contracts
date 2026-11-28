// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title INonPaymentVerifier
 * @notice Verifies attestor-signed scans of a seller account: how much of a claimed payment actually arrived.
 */
interface INonPaymentVerifier {
    /**
     * @param intentHash Released intent the evidence is about.
     * @param dataHash Hash of the ABI-encoded `NonPaymentDetails`.
     * @param signatures Witness signatures over the verifier's EIP-712 digest.
     * @param data ABI-encoded `NonPaymentDetails`.
     */
    struct NonPaymentAttestation {
        bytes32 intentHash;
        bytes32 dataHash;
        bytes[] signatures;
        bytes data;
    }

    /**
     * @notice The scan the attestor ran and the largest incoming payment it found that matches the claim.
     * @param paymentMethod Rail of the scanned account.
     * @param payeeId Hashed payee id of the scanned account.
     * @param fiatCurrency Currency the claim was made in.
     * @param windowStart Start of the scanned history, unix seconds.
     * @param windowEnd End of the scanned history, unix seconds; the scan time.
     * @param claimedAmount Fiat amount the operator claimed arrived, in the deposit token's decimals.
     * @param receivedAmount Matching fiat amount that did arrive, same units; zero when nothing matched.
     * @param payerHash Claimed payer; zero when the claim named none.
     * @param txIdHash Claimed platform payment id; zero when the claim named none.
     * @param historyHash Commitment to the normalized rows scanned, kept for audit.
     * @param excludedPaymentIds Matching payments the scan skipped because another intent already consumed them.
     */
    struct NonPaymentDetails {
        bytes32 paymentMethod;
        bytes32 payeeId;
        bytes32 fiatCurrency;
        uint64 windowStart;
        uint64 windowEnd;
        uint256 claimedAmount;
        uint256 receivedAmount;
        bytes32 payerHash;
        bytes32 txIdHash;
        bytes32 historyHash;
        bytes32[] excludedPaymentIds;
    }

    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error InvalidAttestation();
    error AttestationVerificationFailed();
    error OwnershipRenunciationDisabled();

    /**
     * @notice Checks the witness signatures and returns the signed scan.
     * @dev View-only and stateless; the caller binds the returned details to its own release record.
     */
    function verifyNonPayment(NonPaymentAttestation calldata _attestation)
        external
        view
        returns (NonPaymentDetails memory details);
}
