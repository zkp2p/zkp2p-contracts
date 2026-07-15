// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";

/**
 * @title AttestationVerifierMock
 * @notice Configurable verifier used by RiskManager unit and integration tests.
 */
contract AttestationVerifierMock is IAttestationVerifier {
    bool public result = true;

    function setResult(bool _result) external {
        result = _result;
    }

    function verify(
        bytes32,
        bytes[] calldata,
        bytes calldata
    ) external view override returns (bool isValid) {
        return result;
    }
}
