// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { ThresholdSigVerifierUtils } from "contracts/lib/ThresholdSigVerifierUtils.sol";

/**
 * @title ThresholdSigVerifierUtilsMock
 * @notice Mock contract for testing ThresholdSigVerifierUtils library
 */
contract ThresholdSigVerifierUtilsMock {
    
    using ThresholdSigVerifierUtils for bytes32;
    
    /**
     * @notice Exposes the internal verifyWitnessSignatures function for testing
     */
    function verifyWitnessSignatures(
        bytes32 _messageHash,
        bytes[] memory _signatures,
        address[] memory _witnesses,
        uint256 _reqThreshold
    )
        external
        view
        returns (bool)
    {
        return _messageHash.verifyWitnessSignatures(
            _signatures,
            _witnesses,
            _reqThreshold
        );
    }
}
