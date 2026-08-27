// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {
    DisputeMethodScopedTrustSurfaceChecks,
    IActivationPolicy,
    IActivationVault,
    TrustSurface
} from "./DisputeMethodScopedActivationTypes.sol";

/**
 * @title DisputeMethodScopedRotationPostcondition
 * @notice Fork-simulation assertion target for the completed rotation batch.
 */
contract DisputeMethodScopedRotationPostcondition is DisputeMethodScopedTrustSurfaceChecks {
    uint64 private immutable controllerChangeDelay;

    constructor(TrustSurface memory _expected, uint64 _controllerChangeDelay)
        DisputeMethodScopedTrustSurfaceChecks(_expected)
    {
        controllerChangeDelay = _controllerChangeDelay;
    }

    /**
     * @notice Asserts the rotation batch's complete resulting state.
     */
    function assertPostconditions() external view {
        _assertTrustSurface();

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        address actualAddress = fresh.owner();
        if (actualAddress != expected.safe) revert FreshPolicyOwnerMismatch(actualAddress);
        actualAddress = fresh.pendingOwner();
        if (actualAddress != address(0)) revert FreshPolicyPendingOwnerMismatch(actualAddress);

        bool actualBool = IActivationPolicy(expected.predecessorPolicy).admissionsPaused();
        if (!actualBool) revert PredecessorAdmissionsPausedMismatch(actualBool);

        IActivationVault targetVault = IActivationVault(expected.vault);
        actualAddress = targetVault.pendingController();
        if (actualAddress != expected.freshPolicy) revert VaultPendingControllerMismatch(actualAddress);
        actualAddress = targetVault.controller();
        if (actualAddress != expected.predecessorPolicy) revert VaultControllerMismatch(actualAddress);
        uint64 actualValidAt = targetVault.pendingControllerValidAt();
        uint256 minimumValidAt = block.timestamp + controllerChangeDelay;
        if (actualValidAt < minimumValidAt) {
            revert PendingControllerValidAtMismatch(actualValidAt, minimumValidAt);
        }

        _assertSingleWriter(expected.predecessorPolicy);
        _assertLifecycleHook(expected.predecessorHook);
    }
}
