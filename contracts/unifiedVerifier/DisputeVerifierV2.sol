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
 * @dev Evidence data is `abi.encode(IDisputeVerifier.DisputeDetails, bytes32[] nullifiers)`. `originalPaymentId`
 * keeps its DisputeVerifier meaning, the provider payment ID hash, and is not read for binding. `nullifiers` is a
 * candidate set: the evidence binds to the intent when any candidate is bound to it in the registry, which reads
 * through to its predecessor for payments settled before the cutover.
 * @dev The attestation service chooses both the nullifiers a payment settles with and the candidates its evidence
 * names, and keeps the two in step. This contract enforces no shape and no count on the candidates. Duplicates
 * cost only a repeated lookup, and a zero entry never matches because the intent hash must be nonzero. Absence of
 * an identifier that only one side of a transfer can see proves nothing about the other side's records.
 * @dev The attestation service also owns `paymentMethod` and `disputeId`, and so the dispute replay key
 * `keccak256(abi.encodePacked(paymentMethod, disputeId))`, as it owns payment nullifiers. `details.paymentMethod` is
 * a signed label and is not checked against the protection's payment method. `disputeId` is opaque, and the key
 * keeps DisputeVerifier's derivation, so disputes resolved before the cutover keep their keys.
 */
contract DisputeVerifierV2 is IDisputeVerifier, Ownable2Step, EIP712 {
    /* ============ Constants ============ */

    bytes32 public constant DISPUTE_ATTESTATION_TYPEHASH =
        keccak256("DisputeAttestation(bytes32 intentHash,bytes32 dataHash)");

    /* ============ Errors ============ */

    error NoNullifierCandidates();

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
     * @dev View-only and stateless. Ignores the policy's payment method argument: the signed `details.paymentMethod`
     * only feeds the dispute nullifier. Reverts when the payload is malformed or unsigned, names no candidate
     * nullifier, or names none bound to the intent.
     */
    function verifyDispute(DisputeAttestation calldata _attestation, bytes32 /* _paymentMethod */)
        external
        view
        override
        returns (bytes32 disputeId, bytes32 disputeNullifier)
    {
        if (keccak256(_attestation.data) != _attestation.dataHash) revert InvalidAttestation();

        (DisputeDetails memory details, bytes32[] memory nullifiers) =
            abi.decode(_attestation.data, (DisputeDetails, bytes32[]));
        if (nullifiers.length == 0) revert NoNullifierCandidates();

        bytes32 digest = _hashTypedDataV4(_disputeAttestationStructHash(_attestation));
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }

        if (_attestation.intentHash == bytes32(0) || !_anyBoundToIntent(nullifiers, _attestation.intentHash)) {
            revert InvalidPaymentBinding(_attestation.intentHash, nullifiers[0]);
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

    function _anyBoundToIntent(bytes32[] memory _nullifiers, bytes32 _intentHash) internal view returns (bool) {
        for (uint256 i = 0; i < _nullifiers.length; i++) {
            if (nullifierRegistry.intentHashByNullifier(_nullifiers[i]) == _intentHash) return true;
        }
        return false;
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidContract(_dependency);
    }
}
