// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {
    DisputeBypassTrustSurfaceChecks,
    IBypassActivationVault,
    IBypassActivationCascadePolicy,
    BypassTrustSurface
} from "./DisputeBypassActivationTypes.sol";

/**
 * @title DisputeBypassCutoverGuard
 * @notice Binds the cutover that registers O4 while O3 keeps its August lifecycle hook.
 * @dev The predecessor dispute writer stays because pre-cutover intents keep settling through the predecessor policy.
 */
contract DisputeBypassCutoverGuard is DisputeBypassTrustSurfaceChecks {
    bool private immutable expectVaultAcceptOwnership;
    bool private immutable expectPolicyAcceptOwnership;

    constructor(
        BypassTrustSurface memory _expected,
        bool _expectVaultAcceptOwnership,
        bool _expectPolicyAcceptOwnership
    ) DisputeBypassTrustSurfaceChecks(_expected) {
        expectVaultAcceptOwnership = _expectVaultAcceptOwnership;
        expectPolicyAcceptOwnership = _expectPolicyAcceptOwnership;
    }

    /// @notice Reverts unless the prepared cutover state matches and O4 remains unregistered.
    function assertReady() external view {
        _assertTrustSurface();
        _assertOwnership();
        address[] memory writers = new address[](1);
        writers[0] = expected.predecessorPolicy;
        _assertDisputeWriters(writers);
        writers[0] = expected.retiredVerifier;
        _assertNullifierWriters(writers);
        _assertRoutes(expected.retiredVerifier);
        _assertLifecycleHook(expected.predecessorHook);
        _assertFreshPolicyConfiguration();

        _assertOrchestratorV4Registration(false);
    }

    function _assertOwnership() private view {
        IBypassActivationVault vault = IBypassActivationVault(expected.freshVault);
        address actual = vault.owner();
        address wantedOwner = expectVaultAcceptOwnership ? expected.deployer : expected.safe;
        if (actual != wantedOwner) revert FreshVaultOwnerMismatch(actual);
        actual = vault.pendingOwner();
        address wantedPendingOwner = expectVaultAcceptOwnership ? expected.safe : address(0);
        if (actual != wantedPendingOwner) revert FreshVaultPendingOwnerMismatch(actual);

        IBypassActivationCascadePolicy fresh = IBypassActivationCascadePolicy(expected.freshPolicy);
        actual = fresh.owner();
        wantedOwner = expectPolicyAcceptOwnership ? expected.deployer : expected.safe;
        if (actual != wantedOwner) revert FreshPolicyOwnerMismatch(actual);
        actual = fresh.pendingOwner();
        wantedPendingOwner = expectPolicyAcceptOwnership ? expected.safe : address(0);
        if (actual != wantedPendingOwner) revert FreshPolicyPendingOwnerMismatch(actual);
    }
}
