// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {
    DisputeMethodScopedTrustSurfaceChecks,
    IActivationPolicy,
    IActivationVault,
    TrustSurface
} from "./DisputeMethodScopedActivationTypes.sol";

/**
 * @title DisputeMethodScopedCutoverPostcondition
 * @notice Fork-simulation assertion target for the completed method-scoped dispute cutover.
 */
contract DisputeMethodScopedCutoverPostcondition is DisputeMethodScopedTrustSurfaceChecks {
    constructor(TrustSurface memory _expected) DisputeMethodScopedTrustSurfaceChecks(_expected) {}

    /**
     * @notice Asserts the cutover batch's complete resulting state.
     */
    function assertPostconditions() external view {
        _assertTrustSurface();

        IActivationVault targetVault = IActivationVault(expected.vault);
        address actualAddress = targetVault.controller();
        if (actualAddress != expected.freshPolicy) revert VaultControllerMismatch(actualAddress);
        actualAddress = targetVault.pendingController();
        if (actualAddress != address(0)) revert VaultPendingControllerMismatch(actualAddress);

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        actualAddress = fresh.owner();
        if (actualAddress != expected.safe) revert FreshPolicyOwnerMismatch(actualAddress);
        actualAddress = fresh.pendingOwner();
        if (actualAddress != address(0)) revert FreshPolicyPendingOwnerMismatch(actualAddress);
        _assertFreshPolicyConfiguration();
        _assertSingleWriter(expected.freshPolicy);
        _assertLifecycleHook(expected.freshHook);
    }
}
