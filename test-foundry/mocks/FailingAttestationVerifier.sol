// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IAttestationVerifier } from "contracts/interfaces/IAttestationVerifier.sol";

/// @notice Test helper that always returns false without reverting.
contract FailingAttestationVerifier is IAttestationVerifier {
    function verify(
        bytes32,
        bytes[] calldata,
        bytes calldata
    ) external pure override returns (bool) {
        return false;
    }
}
