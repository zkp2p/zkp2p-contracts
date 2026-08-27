// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {
    DisputeMethodScopedVaultTrustSurfaceChecks,
    VaultTrustSurface
} from "./DisputeMethodScopedVaultActivationTypes.sol";

contract DisputeMethodScopedVaultWriterRemovalPostcondition is DisputeMethodScopedVaultTrustSurfaceChecks {
    constructor(VaultTrustSurface memory _expected) DisputeMethodScopedVaultTrustSurfaceChecks(_expected) {}

    function assertPostconditions() external view {
        _assertTrustSurface();
        _assertFreshSafeOwnership();
        address[] memory writers = new address[](1);
        writers[0] = expected.freshPolicy;
        _assertWriters(writers);
        _assertLifecycleHook(expected.freshHook);
    }
}
