// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAttestationVerifier} from "./IAttestationVerifier.sol";
import {INullifierRegistryV2} from "./INullifierRegistryV2.sol";

/**
 * @title IChargebackVerifier
 * @notice Stateless verifier for chargeback attestations. Owns the EIP-712 domain for chargeback
 * evidence, delegates signature verification to a configurable attestation verifier, and checks
 * payment binding against the nullifier registry. Mirrors the UnifiedPaymentVerifier layering:
 * policy -> chargeback verifier -> attestation verifier.
 */
interface IChargebackVerifier {
    struct ChargebackAttestation {
        bytes32 intentHash;
        bytes32 dataHash;
        bytes[] signatures;
        bytes data;
    }

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

    /**
     * @notice Validates chargeback evidence against the position context supplied by the caller.
     * @dev View-only and stateless: the caller owns all replay bookkeeping and state transitions.
     * Reverts when the evidence is malformed, mismatched, unsigned, or unbound to the settled payment.
     * @param _attestation Signed chargeback evidence for an intent.
     * @param _paymentMethod Payment method snapshotted on the caller's position.
     * @param _isManualRelease True when the position settled without an on-chain payment proof,
     * which skips the payment-binding check.
     * @return disputeId Payment-platform dispute identifier decoded from the evidence.
     * @return disputeNullifier Payment-method-scoped replay key for the dispute.
     */
    function verifyChargeback(
        ChargebackAttestation calldata _attestation,
        bytes32 _paymentMethod,
        bool _isManualRelease
    ) external view returns (bytes32 disputeId, bytes32 disputeNullifier);

    /** @notice Returns the EIP-712 digest signed for a chargeback attestation. */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation)
        external
        view
        returns (bytes32);

    /** @notice Replaces the verifier used for future chargeback signature checks. */
    function setAttestationVerifier(address _verifier) external;

    /** @notice Always reverts so the signature-verification dependency cannot become unmanaged. */
    function renounceOwnership() external;

    /** @notice Returns the verifier used to validate witness signatures. */
    function attestationVerifier() external view returns (IAttestationVerifier);

    /** @notice Returns the canonical payment-nullifier binding registry. */
    function nullifierRegistry() external view returns (INullifierRegistryV2);
}
