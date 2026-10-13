// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IActivationPolicy, InventoryTuple} from "./DisputeMethodScopedActivationTypes.sol";
import {
    DisputeBypassTrustSurfaceChecks,
    IBypassActivationVault,
    BypassTrustSurface
} from "./DisputeBypassActivationTypes.sol";

/**
 * @title DisputeBypassCutoverGuard
 * @notice Binds the bypass cutover to its proof-time trust surface and depositor inventory.
 * @dev The predecessor dispute writer stays because pre-cutover intents keep settling through the predecessor policy.
 */
contract DisputeBypassCutoverGuard is DisputeBypassTrustSurfaceChecks {
    bool private immutable expectVaultAcceptOwnership;
    bool private immutable expectPolicyAcceptOwnership;
    InventoryTuple[] private inventoryTuples;

    constructor(
        BypassTrustSurface memory _expected,
        bool _expectVaultAcceptOwnership,
        bool _expectPolicyAcceptOwnership,
        InventoryTuple[] memory _inventoryTuples
    ) DisputeBypassTrustSurfaceChecks(_expected) {
        expectVaultAcceptOwnership = _expectVaultAcceptOwnership;
        expectPolicyAcceptOwnership = _expectPolicyAcceptOwnership;
        inventoryTuples = _inventoryTuples;
    }

    /// @notice Reverts unless the complete prepared cutover state and depositor opt-outs still match.
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

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        for (uint256 tupleIndex = 0; tupleIndex < inventoryTuples.length; tupleIndex++) {
            InventoryTuple memory tuple = inventoryTuples[tupleIndex];
            bool actual = fresh.isDisputeProtectionEnabled(tuple.escrow, tuple.depositId, tuple.paymentMethod);
            if (actual) {
                revert InventoryTupleProtectionMismatch(tuple.escrow, tuple.depositId, tuple.paymentMethod, actual);
            }
        }
    }

    function _assertOwnership() private view {
        IBypassActivationVault vault = IBypassActivationVault(expected.freshVault);
        address actual = vault.owner();
        address wantedOwner = expectVaultAcceptOwnership ? expected.deployer : expected.safe;
        if (actual != wantedOwner) revert FreshVaultOwnerMismatch(actual);
        actual = vault.pendingOwner();
        address wantedPendingOwner = expectVaultAcceptOwnership ? expected.safe : address(0);
        if (actual != wantedPendingOwner) revert FreshVaultPendingOwnerMismatch(actual);

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        actual = fresh.owner();
        wantedOwner = expectPolicyAcceptOwnership ? expected.deployer : expected.safe;
        if (actual != wantedOwner) revert FreshPolicyOwnerMismatch(actual);
        actual = fresh.pendingOwner();
        wantedPendingOwner = expectPolicyAcceptOwnership ? expected.safe : address(0);
        if (actual != wantedPendingOwner) revert FreshPolicyPendingOwnerMismatch(actual);
    }
}
