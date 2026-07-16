// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IAttestationVerifier } from "./IAttestationVerifier.sol";

/**
 * @title IEpochAttestationVerifier
 * @notice Attestation verifier with immutable historical witness epochs.
 * @dev Consumers snapshot an epoch when economic exposure is admitted and verify against that
 *      epoch even after governance activates a later witness configuration.
 */
interface IEpochAttestationVerifier is IAttestationVerifier {
    function currentEpoch() external view returns (uint64);

    function epochAt(uint64 _timestamp) external view returns (uint64);

    function verifyAtEpoch(
        uint64 _epoch,
        bytes32 _digest,
        bytes[] calldata _sigs,
        bytes calldata _data
    ) external view returns (bool isValid);
}
