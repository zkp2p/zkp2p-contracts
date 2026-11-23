// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {INullifierRegistryV3} from "../interfaces/INullifierRegistryV3.sol";
import {PaymentNullifierLib} from "../lib/PaymentNullifierLib.sol";

/**
 * @title DisputeVerifierV2
 * @notice Stateless EIP-712 verifier for dispute evidence, mirroring the UnifiedPaymentVerifier
 * layering: the dispute protection policy calls this verifier, which itself calls the
 * attestation verifier for witness-signature checks. Holds no position state and can be
 * swapped on the policy at any time.
 * @dev Swapping this verifier rotates the EIP-712 domain (it binds this contract's address), which
 * invalidates signed-but-unsubmitted attestations. The attestation service must always sign against
 * the policy's currently configured verifier.
 * @dev A settled payment can hold several identifiers. Dispute evidence names one by scheme and ID, and governance
 * lists per payment method which schemes may anchor a dispute. An identifier only one side of a transfer can see
 * must stay off that list: evidence of its absence from the other side's records proves nothing.
 */
contract DisputeVerifierV2 is IDisputeVerifier, Ownable2Step, EIP712 {
    /* ============ Constants ============ */

    bytes32 public constant DISPUTE_ATTESTATION_TYPEHASH =
        keccak256("DisputeAttestation(bytes32 intentHash,bytes32 dataHash)");

    /* ============ Events ============ */

    event DisputeSchemeUpdated(bytes32 indexed paymentMethod, bytes32 indexed scheme, bool allowed);

    /* ============ Errors ============ */

    error IneligiblePaymentScheme(bytes32 paymentMethod, bytes32 scheme);

    /* ============ Structs ============ */

    /**
     * @notice Payment and dispute identifiers attested by the dispute witnesses.
     * @param paymentMethod Payment rail used by the original payment.
     * @param originalPaymentScheme Kind of identifier `originalPaymentId` is.
     * @param originalPaymentId Provider identifier for the original payment.
     * @param disputeId Provider identifier for the dispute or reversal.
     * @param paymentAmount Attested off-chain payment amount.
     * @param paymentCurrency Attested off-chain payment currency.
     */
    struct DisputeDetailsV2 {
        bytes32 paymentMethod;
        bytes32 originalPaymentScheme;
        bytes32 originalPaymentId;
        bytes32 disputeId;
        uint256 paymentAmount;
        bytes32 paymentCurrency;
    }

    /* ============ State Variables ============ */

    INullifierRegistryV3 public immutable nullifierRegistry;
    IAttestationVerifier public attestationVerifier;

    /// @notice Whether an identifier of this scheme may anchor a dispute on this payment method.
    mapping(bytes32 => mapping(bytes32 => bool)) public isDisputeScheme;

    /* ============ Constructor ============ */

    constructor(address _owner, INullifierRegistryV3 _nullifierRegistry, IAttestationVerifier _attestationVerifier)
        EIP712("ZKP2P DisputeVerifier", "1")
    {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_nullifierRegistry));
        _validateDependency(address(_attestationVerifier));

        nullifierRegistry = _nullifierRegistry;
        attestationVerifier = _attestationVerifier;
        _transferOwnership(_owner);
    }

    /* ============ External Functions ============ */

    /**
     * @inheritdoc IDisputeVerifier
     */
    function verifyDispute(DisputeAttestation calldata _attestation, bytes32 _paymentMethod)
        external
        view
        override
        returns (bytes32 disputeId, bytes32 disputeNullifier)
    {
        if (keccak256(_attestation.data) != _attestation.dataHash) revert InvalidAttestation();

        DisputeDetailsV2 memory details = abi.decode(_attestation.data, (DisputeDetailsV2));
        if (details.paymentMethod != _paymentMethod) revert InvalidAttestation();
        if (!isDisputeScheme[details.paymentMethod][details.originalPaymentScheme]) {
            revert IneligiblePaymentScheme(details.paymentMethod, details.originalPaymentScheme);
        }

        bytes32 digest = _hashTypedDataV4(_disputeAttestationStructHash(_attestation));
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }

        bytes32 paymentNullifier = PaymentNullifierLib.key(
            details.paymentMethod, details.originalPaymentScheme, details.originalPaymentId
        );
        if (
            _attestation.intentHash == bytes32(0)
                || nullifierRegistry.intentHashByNullifier(paymentNullifier) != _attestation.intentHash
        ) {
            revert InvalidPaymentBinding(_attestation.intentHash, paymentNullifier);
        }

        disputeId = details.disputeId;
        disputeNullifier = keccak256(abi.encodePacked(details.paymentMethod, details.disputeId));
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Sets whether identifiers of a scheme may anchor disputes on a payment method.
     * @param _paymentMethod Payment method the scheme belongs to.
     * @param _scheme Identifier kind; `PaymentNullifierLib.NATIVE_SCHEME` for the platform's own ID.
     * @param _allowed Whether dispute evidence may name the original payment by this scheme.
     */
    function setDisputeScheme(bytes32 _paymentMethod, bytes32 _scheme, bool _allowed) external onlyOwner {
        isDisputeScheme[_paymentMethod][_scheme] = _allowed;
        emit DisputeSchemeUpdated(_paymentMethod, _scheme, _allowed);
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future witness-signature checks.
     * @param _verifier New non-zero deployed attestation-verifier contract.
     */
    function setAttestationVerifier(address _verifier) external onlyOwner {
        _validateDependency(_verifier);
        address previousVerifier = address(attestationVerifier);
        attestationVerifier = IAttestationVerifier(_verifier);
        emit AttestationVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice Disables ownership renunciation so the signature-verification dependency stays managed.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns the EIP-712 digest that witnesses sign for a dispute attestation.
     * @param _attestation Dispute evidence whose intent hash and data hash are included in the digest.
     * @return EIP-712 digest bound to this verifier's address and the current chain.
     */
    function hashDisputeAttestation(DisputeAttestation calldata _attestation) external view returns (bytes32) {
        return _hashTypedDataV4(_disputeAttestationStructHash(_attestation));
    }

    /* ============ Internal Functions ============ */

    function _disputeAttestationStructHash(DisputeAttestation calldata _attestation) internal pure returns (bytes32) {
        return keccak256(abi.encode(DISPUTE_ATTESTATION_TYPEHASH, _attestation.intentHash, _attestation.dataHash));
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidContract(_dependency);
    }
}
