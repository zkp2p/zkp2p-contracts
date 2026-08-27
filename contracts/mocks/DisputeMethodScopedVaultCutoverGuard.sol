// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IActivationEscrow, IActivationPolicy, InventoryTuple} from "./DisputeMethodScopedActivationTypes.sol";
import {
    DisputeMethodScopedVaultTrustSurfaceChecks,
    IActivationVaultWithToken,
    VaultTrustSurface
} from "./DisputeMethodScopedVaultActivationTypes.sol";

/**
 * @title DisputeMethodScopedVaultCutoverGuard
 * @notice Binds the dedicated-vault cutover to its proof-time trust surface and depositor inventory.
 * @dev The proof-time deposit counter is a floor because later deposits cannot carry predecessor opt-outs that the
 *      fresh default-on policy would honor. A depositor who needs an opt-out re-applies it on the fresh policy.
 */
contract DisputeMethodScopedVaultCutoverGuard is DisputeMethodScopedVaultTrustSurfaceChecks {
    bool private immutable expectVaultAcceptOwnership;
    bool private immutable expectPolicyAcceptOwnership;
    address private immutable deployer;
    InventoryTuple[] private inventoryTuples;
    address private immutable escrow;
    uint256 private immutable expectedDepositCounter;

    constructor(
        VaultTrustSurface memory _expected,
        bool _expectVaultAcceptOwnership,
        bool _expectPolicyAcceptOwnership,
        InventoryTuple[] memory _inventoryTuples,
        address _escrow,
        uint256 _expectedDepositCounter
    ) DisputeMethodScopedVaultTrustSurfaceChecks(_expected) {
        expectVaultAcceptOwnership = _expectVaultAcceptOwnership;
        expectPolicyAcceptOwnership = _expectPolicyAcceptOwnership;
        deployer = msg.sender;
        inventoryTuples = _inventoryTuples;
        escrow = _escrow;
        expectedDepositCounter = _expectedDepositCounter;
    }

    function assertReady() external view {
        _assertTrustSurface();
        _assertOwnership();
        address[] memory writers = new address[](1);
        writers[0] = expected.predecessorPolicy;
        _assertWriters(writers);
        _assertLifecycleHook(expected.predecessorHook);
        _assertFreshPolicyConfiguration();

        uint256 actualCounter = IActivationEscrow(escrow).depositCounter();
        if (actualCounter < expectedDepositCounter) {
            revert DepositCounterBelowProof(actualCounter, expectedDepositCounter);
        }
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
        IActivationVaultWithToken vault = IActivationVaultWithToken(expected.vaults.freshVault);
        address actual = vault.owner();
        address wantedOwner = expectVaultAcceptOwnership ? deployer : expected.safe;
        if (actual != wantedOwner) revert FreshVaultOwnerMismatch(actual);
        actual = vault.pendingOwner();
        address wantedPendingOwner = expectVaultAcceptOwnership ? expected.safe : address(0);
        if (actual != wantedPendingOwner) revert FreshVaultPendingOwnerMismatch(actual);

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        actual = fresh.owner();
        wantedOwner = expectPolicyAcceptOwnership ? deployer : expected.safe;
        if (actual != wantedOwner) revert FreshPolicyOwnerMismatch(actual);
        actual = fresh.pendingOwner();
        wantedPendingOwner = expectPolicyAcceptOwnership ? expected.safe : address(0);
        if (actual != wantedPendingOwner) revert FreshPolicyPendingOwnerMismatch(actual);
    }
}
