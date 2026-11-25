// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV3} from "../interfaces/INullifierRegistryV3.sol";
import {IReceiptVerifier} from "../interfaces/IReceiptVerifier.sol";

/**
 * @title ReceiptVerifier
 * @notice Stateless EIP-712 verifier for receipt confirmations, the enclave's proof that a protected payment arrived.
 * DisputeProtectionPolicyV3 calls it to release a held payout early; it calls the attestation verifier for the
 * witness-signature check, as DisputeVerifierV2 does for disputes.
 * @dev Receipts have their own EIP-712 domain and type, so a dispute signature can never verify as a receipt or the
 * reverse, even though the same witness signs both. Swapping this verifier rotates the domain (it binds this
 * contract's address), which invalidates signed-but-unsubmitted confirmations.
 * @dev Evidence data is `abi.encode(bytes32 paymentMethod, bytes32[] nullifiers)`. `nullifiers` is a candidate set
 * with DisputeVerifierV2's rule: the receipt binds to the intent when any candidate is bound to it in the registry,
 * which reads through to its predecessor for payments settled before the cutover. Duplicates cost only a repeated
 * lookup, and a zero entry never matches because the intent hash must be nonzero.
 */
contract ReceiptVerifier is IReceiptVerifier, Ownable2Step, EIP712 {
    /* ============ Constants ============ */

    bytes32 public constant RECEIPT_CONFIRMATION_TYPEHASH =
        keccak256("ReceiptConfirmation(bytes32 intentHash,uint64 releaseAt,bytes32 dataHash)");

    /* ============ State Variables ============ */

    INullifierRegistryV3 public immutable nullifierRegistry;
    IAttestationVerifier public attestationVerifier;

    /* ============ Constructor ============ */

    /**
     * @notice Creates the verifier.
     * @param _owner Governance owner for the attestation-verifier dependency.
     * @param _nullifierRegistry Payment nullifier registry that binds each consumed nullifier to its intent.
     * @param _attestationVerifier Witness-signature verifier.
     */
    constructor(address _owner, INullifierRegistryV3 _nullifierRegistry, IAttestationVerifier _attestationVerifier)
        EIP712("ZKP2P ReceiptVerifier", "1")
    {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_nullifierRegistry));
        _validateDependency(address(_attestationVerifier));

        nullifierRegistry = _nullifierRegistry;
        attestationVerifier = _attestationVerifier;
        _transferOwnership(_owner);
    }

    /* ============ External Functions ============ */

    /// @inheritdoc IReceiptVerifier
    function verifyReceipt(ReceiptAttestation calldata _attestation, bytes32 _paymentMethod)
        external
        view
        override
        returns (uint64 releaseAt)
    {
        if (_attestation.releaseAt == 0 || keccak256(_attestation.data) != _attestation.dataHash) {
            revert InvalidAttestation();
        }

        (bytes32 paymentMethod, bytes32[] memory nullifiers) = abi.decode(_attestation.data, (bytes32, bytes32[]));
        if (paymentMethod != _paymentMethod) revert InvalidAttestation();
        if (nullifiers.length == 0) revert NoNullifierCandidates();

        bytes32 digest = _hashTypedDataV4(_receiptStructHash(_attestation));
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }

        if (_attestation.intentHash == bytes32(0) || !_anyBoundToIntent(nullifiers, _attestation.intentHash)) {
            revert InvalidPaymentBinding(_attestation.intentHash, nullifiers[0]);
        }

        releaseAt = _attestation.releaseAt;
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
     * @notice Returns the EIP-712 digest that witnesses sign for a receipt confirmation.
     * @param _attestation Receipt confirmation whose intent hash, release time and data hash are in the digest.
     * @return EIP-712 digest bound to this verifier's address and the current chain.
     */
    function hashReceiptAttestation(ReceiptAttestation calldata _attestation) external view returns (bytes32) {
        return _hashTypedDataV4(_receiptStructHash(_attestation));
    }

    /* ============ Internal Functions ============ */

    function _receiptStructHash(ReceiptAttestation calldata _attestation) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RECEIPT_CONFIRMATION_TYPEHASH, _attestation.intentHash, _attestation.releaseAt, _attestation.dataHash
            )
        );
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
