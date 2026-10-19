// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {OrchestratorV4TrustSurfaceChecks, OrchestratorV4TrustSurface} from "./OrchestratorV4ActivationTypes.sol";

/**
 * @title OrchestratorV4CutoverPostcondition
 * @notice Verifies O4 registration and the unchanged O3 hook in fork simulation only.
 */
contract OrchestratorV4CutoverPostcondition is OrchestratorV4TrustSurfaceChecks {
    constructor(OrchestratorV4TrustSurface memory _expected) OrchestratorV4TrustSurfaceChecks(_expected) {}

    /// @notice Reverts unless the activated stack matches and O3 keeps its August lifecycle hook.
    function assertPostconditions() external view {
        _assertTrustSurface();
        _assertFreshSafeOwnership();
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
