// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEpochAttestationVerifier } from "../interfaces/IEpochAttestationVerifier.sol";

/**
 * @title AttestationVerifierMock
 * @notice Configurable verifier used by RiskManager unit and integration tests.
 */
contract AttestationVerifierMock is IEpochAttestationVerifier {
    bool public result = true;
    uint64 public override currentEpoch = 1;
    mapping(uint64 => uint8) public epochResults;

    function setResult(bool _result) external {
        result = _result;
    }

    function setCurrentEpoch(uint64 _epoch) external {
        currentEpoch = _epoch;
    }

    function setEpochResult(uint64 _epoch, bool _result) external {
        epochResults[_epoch] = _result ? 1 : 2;
    }

    function verify(
        bytes32,
        bytes[] calldata,
        bytes calldata
    ) external view override returns (bool isValid) {
        return result;
    }

    function verifyAtEpoch(
        uint64 _epoch,
        bytes32,
        bytes[] calldata,
        bytes calldata
    ) external view override returns (bool isValid) {
        uint8 epochResult = epochResults[_epoch];
        if (epochResult == 1) return true;
        if (epochResult == 2) return false;
        return result;
    }

    function epochAt(uint64) external pure override returns (uint64) {
        return 1;
    }
}
