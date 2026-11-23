// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {INullifierRegistryV3} from "../interfaces/INullifierRegistryV3.sol";

/**
 * @title DisputeVerifierV2
 * @notice Stateless EIP-712 verifier for dispute evidence, mirroring the UnifiedPaymentVerifier
 * layering: the dispute protection policy calls this verifier, which itself calls the
 * attestation verifier for witness-signature checks. Holds no position state and can be
 * swapped on the policy at any time.
 * @dev Swapping this verifier rotates the EIP-712 domain (it binds this contract's address), which
 * invalidates signed-but-unsubmitted attestations. The attestation service must always sign against
 * the policy's currently configured verifier.
 * @dev A settled payment can consume several nullifiers, and evidence naming any of them binds to its intent.
 * The attestation service derives the nullifier it names and owns which one a kind of evidence may use: absence
 * of an identifier that only one side of a transfer can see proves nothing about the other side's records.
 */
contract DisputeVerifierV2 is IDisputeVerifier, Ownable2Step, EIP712 {
    /* ============ Constants ============ */

    bytes32 public constant DISPUTE_ATTESTATION_TYPEHASH =
        keccak256("DisputeAttestation(bytes32 intentHash,bytes32 dataHash)");

    /* ============ State Variables ============ */

    INullifierRegistryV3 public immutable nullifierRegistry;
    IAttestationVerifier public attestationVerifier;

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

        DisputeDetails memory details = abi.decode(_attestation.data, (DisputeDetails));
        if (details.paymentMethod != _paymentMethod) revert InvalidAttestation();

        bytes32 digest = _hashTypedDataV4(_disputeAttestationStructHash(_attestation));
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }

        // `originalPaymentId` carries a nullifier the payment consumed, as the attestation service derived it.
        // It is looked up as given, not hashed with the payment method.
        if (
            _attestation.intentHash == bytes32(0)
                || nullifierRegistry.intentHashByNullifier(details.originalPaymentId) != _attestation.intentHash
        ) {
            revert InvalidPaymentBinding(_attestation.intentHash, details.originalPaymentId);
        }

        disputeId = details.disputeId;
        disputeNullifier = keccak256(abi.encodePacked(details.paymentMethod, details.disputeId));
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
