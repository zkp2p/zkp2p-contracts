// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {INullifierRegistryV2} from "./INullifierRegistryV2.sol";

/**
 * @title IChargebackVerifier
 * @notice Minimal verification surface consumed by ChargebackPolicy.
 * @dev The concrete verifier exposes its governance and digest helper functions directly.
 */
interface IChargebackVerifier {
    /**
     * @notice Signed evidence tying a chargeback payload to one intent.
     * @param intentHash Intent whose off-chain payment was disputed.
     * @param dataHash Hash of the ABI-encoded `ChargebackDetails`.
     * @param signatures Witness signatures over the verifier's EIP-712 digest.
     * @param data ABI-encoded `ChargebackDetails`.
     */
    struct ChargebackAttestation {
        bytes32 intentHash;
        bytes32 dataHash;
        bytes[] signatures;
        bytes data;
    }

    /**
     * @notice Payment and dispute identifiers attested by the chargeback witnesses.
     * @param paymentMethod Payment rail used by the original payment.
     * @param originalPaymentId Provider identifier for the original payment.
     * @param disputeId Provider identifier for the chargeback or reversal.
     * @param paymentAmount Attested off-chain payment amount.
     * @param paymentCurrency Attested off-chain payment currency.
     */
    struct ChargebackDetails {
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

    function nullifierRegistry() external view returns (INullifierRegistryV2);

    /**
     * @notice Validates chargeback evidence against the intent context supplied by the policy.
     * @dev View-only and stateless. Reverts when the payload is malformed, mismatched, unsigned, or—unless the
     * legacy bypass is explicitly selected—not bound to the intent's original payment nullifier.
     * @param _attestation Signed chargeback evidence for an intent.
     * @param _paymentMethod Payment method snapshotted by the policy when the intent was admitted.
     * @param _skipPaymentBinding Legacy compatibility switch. ChargebackPolicy always passes false because both
     * proof and manual settlements have canonical payment-to-intent bindings.
     * @return disputeId Payment-platform dispute identifier decoded from the evidence.
     * @return disputeNullifier Payment-method-scoped replay key for the dispute.
     */
    function verifyChargeback(
        ChargebackAttestation calldata _attestation,
        bytes32 _paymentMethod,
        bool _skipPaymentBinding
    ) external view returns (bytes32 disputeId, bytes32 disputeNullifier);
}
