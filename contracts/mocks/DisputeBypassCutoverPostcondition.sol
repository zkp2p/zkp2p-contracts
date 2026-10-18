// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {DisputeBypassTrustSurfaceChecks, BypassTrustSurface} from "./DisputeBypassActivationTypes.sol";

/**
 * @title DisputeBypassCutoverPostcondition
 * @notice Verifies O4 registration and the unchanged O3 hook in fork simulation only.
 */
contract DisputeBypassCutoverPostcondition is DisputeBypassTrustSurfaceChecks {
    constructor(BypassTrustSurface memory _expected) DisputeBypassTrustSurfaceChecks(_expected) {}

    /// @notice Reverts unless the activated stack matches and O3 keeps its August lifecycle hook.
    function assertPostconditions() external view {
        _assertTrustSurface();
        _assertFreshSafeOwnership();
        _assertFreshPolicyConfiguration();
        address[] memory writers = new address[](2);
        writers[0] = expected.predecessorPolicy;
        writers[1] = expected.freshPolicy;
        _assertDisputeWriters(writers);
        address[] memory nullifierWriters = new address[](1);
        nullifierWriters[0] = expected.verifier;
        _assertNullifierWriters(nullifierWriters);
        _assertRoutes(expected.verifier);
        _assertLifecycleHook(expected.predecessorHook);
        _assertOrchestratorV4Registration(true);
    }
}
