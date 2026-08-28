// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {
    DisputeMethodScopedTrustSurfaceChecks,
    IActivationPolicy,
    IActivationVault,
    TrustSurface
} from "./DisputeMethodScopedActivationTypes.sol";

/**
 * @title DisputeMethodScopedRotationGuard
 * @notice Fails a rotation Safe batch unless every pinned pre-rotation invariant still holds.
 */
contract DisputeMethodScopedRotationGuard is DisputeMethodScopedTrustSurfaceChecks {
    bool private immutable expectAcceptOwnership;
    address private immutable deployer;

    constructor(TrustSurface memory _expected, bool _expectAcceptOwnership, address _deployer)
        DisputeMethodScopedTrustSurfaceChecks(_expected)
    {
        expectAcceptOwnership = _expectAcceptOwnership;
        deployer = _deployer;
    }

    /**
     * @notice Asserts the exact state from which the rotation batch may execute.
     */
    function assertReady() external view {
        _assertTrustSurface();

        IActivationVault targetVault = IActivationVault(expected.vault);
        address actualAddress = targetVault.controller();
        if (actualAddress != expected.predecessorPolicy) revert VaultControllerMismatch(actualAddress);
        actualAddress = targetVault.pendingController();
        if (actualAddress != address(0)) revert VaultPendingControllerMismatch(actualAddress);

        bool actualBool = IActivationPolicy(expected.predecessorPolicy).admissionsPaused();
        if (actualBool) revert PredecessorAdmissionsPausedMismatch(actualBool);
        _assertSingleWriter(expected.predecessorPolicy);
        _assertLifecycleHook(expected.predecessorHook);

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        actualAddress = fresh.owner();
        address expectedOwner = expectAcceptOwnership ? deployer : expected.safe;
        if (actualAddress != expectedOwner) revert FreshPolicyOwnerMismatch(actualAddress);
        actualAddress = fresh.pendingOwner();
        address expectedPendingOwner = expectAcceptOwnership ? expected.safe : address(0);
        if (actualAddress != expectedPendingOwner) revert FreshPolicyPendingOwnerMismatch(actualAddress);
        _assertFreshPolicyConfiguration();
    }
}
