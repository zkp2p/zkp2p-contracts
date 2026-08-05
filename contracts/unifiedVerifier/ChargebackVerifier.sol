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

    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH =
        keccak256("ChargebackAttestation(bytes32 intentHash,bytes32 dataHash)");

    /* ============ State Variables ============ */

    INullifierRegistryV2 public immutable nullifierRegistry;
    IAttestationVerifier public attestationVerifier;

    /* ============ Constructor ============ */

    constructor(address _owner, INullifierRegistryV2 _nullifierRegistry, IAttestationVerifier _attestationVerifier)
        EIP712("ZKP2P ChargebackVerifier", "1")
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
    function verifyChargeback(ChargebackAttestation calldata _attestation, bytes32 _paymentMethod)
        external
        view
        override
        returns (bytes32 disputeId, bytes32 disputeNullifier)
    {
        if (keccak256(_attestation.data) != _attestation.dataHash) revert InvalidAttestation();

        ChargebackDetails memory details = abi.decode(_attestation.data, (ChargebackDetails));
        if (details.paymentMethod != _paymentMethod) revert InvalidAttestation();

        bytes32 digest = _hashTypedDataV4(_chargebackAttestationStructHash(_attestation));
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }

        bytes32 paymentNullifier = keccak256(abi.encodePacked(details.paymentMethod, details.originalPaymentId));
        if (
            nullifierRegistry.intentHashByNullifier(paymentNullifier) != _attestation.intentHash
                || nullifierRegistry.nullifierByIntentHash(_attestation.intentHash) != paymentNullifier
        ) {
            revert InvalidPaymentBinding(_attestation.intentHash, paymentNullifier);
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
     * @notice Returns the EIP-712 digest that witnesses sign for a chargeback attestation.
     * @param _attestation Chargeback evidence whose intent hash and data hash are included in the digest.
     * @return EIP-712 digest bound to this verifier's address and the current chain.
     */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation) external view returns (bytes32) {
        return _hashTypedDataV4(_chargebackAttestationStructHash(_attestation));
    }

    /* ============ Internal Functions ============ */

    function _chargebackAttestationStructHash(ChargebackAttestation calldata _attestation)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(CHARGEBACK_ATTESTATION_TYPEHASH, _attestation.intentHash, _attestation.dataHash));
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidContract(_dependency);
    }
}
