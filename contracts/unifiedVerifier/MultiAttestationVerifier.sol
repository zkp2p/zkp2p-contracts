// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";
import { ThresholdSigVerifierUtils } from "../lib/ThresholdSigVerifierUtils.sol";

/**
 * @title MultiAttestationVerifier
 * @notice Verifies attestations against depositor-selected witness configuration.
 * @dev The caller supplies witness configuration in `_data` as
 *      `abi.encode(address[] witnesses, uint256 requiredSignatures)`.
 */
contract MultiAttestationVerifier is IAttestationVerifier {
    /* ============ External Functions ============ */

    /**
     * @notice Verifies attestation signatures against depositor-selected witnesses.
     * @param _digest The message digest to verify
     * @param _sigs Array of signatures from witnesses
     * @param _data ABI-encoded witness config: `abi.encode(address[] witnesses, uint256 requiredSignatures)`
     * @return isValid True if the witness threshold is met
     */
    function verify(
        bytes32 _digest,
        bytes[] calldata _sigs,
        bytes calldata _data
    ) external view override returns (bool isValid) {
        (address[] memory witnesses, uint256 requiredSignatures) = _decodeWitnessConfig(_data);

        isValid = ThresholdSigVerifierUtils.verifyWitnessSignatures(
            _digest,
            _sigs,
            witnesses,
            requiredSignatures
        );

        return isValid;
    }

    /* ============ Internal Functions ============ */

    function _decodeWitnessConfig(bytes calldata _data)
        internal
        pure
        returns (address[] memory witnesses, uint256 requiredSignatures)
    {
        require(_data.length > 0, "MAV: witness config required");

        (witnesses, requiredSignatures) = abi.decode(_data, (address[], uint256));

        require(witnesses.length > 0, "MAV: empty witnesses");
        require(requiredSignatures > 0, "MAV: threshold must be > 0");
        require(requiredSignatures <= witnesses.length, "MAV: threshold exceeds count");

        for (uint256 i = 0; i < witnesses.length; i++) {
            require(witnesses[i] != address(0), "MAV: zero witness");

            for (uint256 j = 0; j < i; j++) {
                require(witnesses[i] != witnesses[j], "MAV: duplicate witness");
            }
        }
    }
}
