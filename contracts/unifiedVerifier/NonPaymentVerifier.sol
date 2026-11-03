// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {INonPaymentVerifier} from "../interfaces/INonPaymentVerifier.sol";

/**
 * @title NonPaymentVerifier
 * @notice Stateless EIP-712 verifier for seller-history scans, laid out like DisputeVerifier: the arbitrator calls
 * this verifier, which calls the attestation verifier for the witness-signature check.
 * @dev Replacing this verifier rotates the EIP-712 domain and invalidates signed but unsubmitted scans.
 */
contract NonPaymentVerifier is INonPaymentVerifier, Ownable2Step, EIP712 {
    bytes32 public constant NON_PAYMENT_ATTESTATION_TYPEHASH =
        keccak256("NonPaymentAttestation(bytes32 intentHash,bytes32 dataHash)");

    IAttestationVerifier public attestationVerifier;

    constructor(address _owner, IAttestationVerifier _attestationVerifier) EIP712("ZKP2P NonPaymentVerifier", "1") {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_attestationVerifier));
        attestationVerifier = _attestationVerifier;
        _transferOwnership(_owner);
    }

    /// @inheritdoc INonPaymentVerifier
    function verifyNonPayment(NonPaymentAttestation calldata _attestation)
        external
        view
        override
        returns (NonPaymentDetails memory details)
    {
        if (keccak256(_attestation.data) != _attestation.dataHash) revert InvalidAttestation();
        if (!attestationVerifier.verify(hashNonPaymentAttestation(_attestation), _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }
        details = abi.decode(_attestation.data, (NonPaymentDetails));
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for witness-signature checks.
     * @param _verifier New deployed attestation-verifier contract.
     */
    function setAttestationVerifier(address _verifier) external onlyOwner {
        _validateDependency(_verifier);
        emit AttestationVerifierUpdated(address(attestationVerifier), _verifier);
        attestationVerifier = IAttestationVerifier(_verifier);
    }

    /// @notice Ownership renunciation is disabled so the signature dependency stays managed.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /// @notice Returns the EIP-712 digest witnesses sign for a scan.
    function hashNonPaymentAttestation(NonPaymentAttestation calldata _attestation) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(NON_PAYMENT_ATTESTATION_TYPEHASH, _attestation.intentHash, _attestation.dataHash))
        );
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidContract(_dependency);
    }
}
