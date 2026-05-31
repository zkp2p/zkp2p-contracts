// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/**
 * @title IAttestationVerifier
 * @notice Interface for verifying attestations from various sources (witnesses, TEE, etc.)
 */
interface IAttestationVerifier {
    /**
     * @notice Verifies attestations for a given digest
     * @param _digest The message digest to verify (EIP-712 formatted)
     * @param _sigs Array of signatures from attestors
     * @param _data Verification data containing attestor identities and threshold requirements
     * @return isValid Returns true if the attestation is valid, false otherwise
     */
    function verify(
        bytes32 _digest,
        bytes[] calldata _sigs,
        bytes calldata _data
    ) external view returns (bool isValid);
}
