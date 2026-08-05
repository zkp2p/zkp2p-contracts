// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IChargebackVerifier} from "../interfaces/IChargebackVerifier.sol";
import {INullifierRegistryV2} from "../interfaces/INullifierRegistryV2.sol";

/**
 * @title ChargebackVerifier
 * @notice Stateless EIP-712 verifier for chargeback evidence, mirroring the UnifiedPaymentVerifier
 * layering: the chargeback policy calls this verifier, which itself calls the attestation verifier
 * for witness-signature checks. Holds no position state and can be swapped on the policy at any time.
 * @dev Swapping this verifier rotates the EIP-712 domain (it binds this contract's address), which
 * invalidates signed-but-unsubmitted attestations. The attestation service must always sign against
 * the policy's currently configured verifier.
 */
contract ChargebackVerifier is IChargebackVerifier, Ownable2Step, EIP712 {
    /* ============ Constants ============ */

    bytes32 public constant DISPUTE_SCHEMA_ID = keccak256("zkp2p.attestation.dispute.v1");
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(bytes32 schemaId,bytes32 transformerId,bytes input,bytes output)");

    /* ============ State Variables ============ */

    INullifierRegistryV2 public immutable nullifierRegistry;
    IAttestationVerifier public attestationVerifier;

    /* ============ Constructor ============ */

    constructor(address _owner, INullifierRegistryV2 _nullifierRegistry, IAttestationVerifier _attestationVerifier)
        EIP712("ZKP2P Attestation", "1")
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
     * @inheritdoc IChargebackVerifier
     */
    function verifyChargeback(
        ChargebackAttestation calldata _attestation,
        bytes32 _paymentMethod,
        bool _isManualRelease
    ) external view override returns (bytes32 disputeId, bytes32 disputeNullifier) {
        if (_isManualRelease) revert ManualReleaseNotChargebackable();
        if (_attestation.schemaId != DISPUTE_SCHEMA_ID) {
            revert InvalidAttestationSchema(_attestation.schemaId);
        }
        if (_attestation.transformerId == bytes32(0)) revert InvalidAttestation();
        if (_attestation.input.length != 32 || _attestation.output.length != 64) revert InvalidAttestation();
        if (_attestation.signatures.length == 0) revert InvalidAttestation();

        bytes32 intentHash = abi.decode(_attestation.input, (bytes32));
        (bytes32 originalPaymentId, bytes32 decodedDisputeId) = abi.decode(_attestation.output, (bytes32, bytes32));
        if (intentHash == bytes32(0) || originalPaymentId == bytes32(0) || decodedDisputeId == bytes32(0)) {
            revert InvalidAttestation();
        }

        bytes32 digest = _hashTypedDataV4(_attestationStructHash(_attestation));
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.output)) {
            revert AttestationVerificationFailed();
        }

        bytes32 paymentNullifier = keccak256(abi.encodePacked(_paymentMethod, originalPaymentId));
        if (
            nullifierRegistry.intentHashByNullifier(paymentNullifier) != intentHash
                || nullifierRegistry.nullifierByIntentHash(intentHash) != paymentNullifier
        ) {
            revert InvalidPaymentBinding(intentHash, paymentNullifier);
        }

        disputeId = decodedDisputeId;
        disputeNullifier = keccak256(abi.encodePacked(_paymentMethod, decodedDisputeId));
    }

    /* ============ Governance Functions ============ */

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
     * @notice Returns the EIP-712 digest that witnesses sign for a chargeback attestation.
     * @param _attestation Generic chargeback attestation included in the digest.
     * @return EIP-712 digest bound to this verifier's address and the current chain.
     */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation) external view returns (bytes32) {
        return _hashTypedDataV4(_attestationStructHash(_attestation));
    }

    /* ============ Internal Functions ============ */

    function _attestationStructHash(ChargebackAttestation calldata _attestation) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                _attestation.schemaId,
                _attestation.transformerId,
                keccak256(_attestation.input),
                keccak256(_attestation.output)
            )
        );
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidContract(_dependency);
    }
}
