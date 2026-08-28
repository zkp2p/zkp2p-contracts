// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {
    DisputeMethodScopedVaultTrustSurfaceChecks,
    VaultTrustSurface
} from "./DisputeMethodScopedVaultActivationTypes.sol";

contract DisputeMethodScopedVaultCutoverPostcondition is DisputeMethodScopedVaultTrustSurfaceChecks {
    constructor(VaultTrustSurface memory _expected) DisputeMethodScopedVaultTrustSurfaceChecks(_expected) {}

    function assertPostconditions() external view {
        _assertTrustSurface();
        _assertFreshSafeOwnership();
        _assertFreshPolicyConfiguration();
        address[] memory writers = new address[](2);
        writers[0] = expected.predecessorPolicy;
        writers[1] = expected.freshPolicy;
        _assertWriters(writers);
        _assertLifecycleHook(expected.freshHook);
    }
}
