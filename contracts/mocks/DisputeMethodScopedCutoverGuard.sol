// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {
    ActivationDisputeProtectionIntent,
    DisputeMethodScopedTrustSurfaceChecks,
    IActivationEscrow,
    IActivationPolicy,
    IActivationVault,
    InventoryTuple,
    TrustSurface
} from "./DisputeMethodScopedActivationTypes.sol";

/**
 * @title DisputeMethodScopedCutoverGuard
 * @notice Fails a cutover Safe batch unless the delayed rotation, drain, and inventory proofs still hold.
 */
contract DisputeMethodScopedCutoverGuard is DisputeMethodScopedTrustSurfaceChecks {
    uint8 private constant CANCELLED = 2;
    uint8 private constant RELEASED = 4;
    uint8 private constant DISPUTED = 5;

    bytes32[] private intentHashes;
    InventoryTuple[] private inventoryTuples;
    address private immutable escrow;
    uint256 private immutable expectedDepositCounter;

    constructor(
        TrustSurface memory _expected,
        bytes32[] memory _intentHashes,
        InventoryTuple[] memory _inventoryTuples,
        address _escrow,
        uint256 _expectedDepositCounter
    ) DisputeMethodScopedTrustSurfaceChecks(_expected) {
        intentHashes = _intentHashes;
        inventoryTuples = _inventoryTuples;
        escrow = _escrow;
        expectedDepositCounter = _expectedDepositCounter;
    }

    /**
     * @notice Asserts the exact state from which the cutover batch may execute.
     */
    function assertReady() external view {
        _assertTrustSurface();

        IActivationVault targetVault = IActivationVault(expected.vault);
        address actualAddress = targetVault.pendingController();
        if (actualAddress != expected.freshPolicy) revert VaultPendingControllerMismatch(actualAddress);
        uint64 validAt = targetVault.pendingControllerValidAt();
        if (block.timestamp < validAt) revert ControllerDelayNotElapsed(validAt, block.timestamp);
        actualAddress = targetVault.controller();
        if (actualAddress != expected.predecessorPolicy) revert VaultControllerMismatch(actualAddress);

        bool actualBool = IActivationPolicy(expected.predecessorPolicy).admissionsPaused();
        if (!actualBool) revert PredecessorAdmissionsPausedMismatch(actualBool);
        _assertSingleWriter(expected.predecessorPolicy);
        _assertLifecycleHook(expected.predecessorHook);

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        actualAddress = fresh.owner();
        if (actualAddress != expected.safe) revert FreshPolicyOwnerMismatch(actualAddress);
        actualAddress = fresh.pendingOwner();
        if (actualAddress != address(0)) revert FreshPolicyPendingOwnerMismatch(actualAddress);
        _assertFreshPolicyConfiguration();

        IActivationPolicy predecessor = IActivationPolicy(expected.predecessorPolicy);
        for (uint256 intentIndex = 0; intentIndex < intentHashes.length; intentIndex++) {
            bytes32 intentHash = intentHashes[intentIndex];
            ActivationDisputeProtectionIntent memory intent = predecessor.getDisputeProtectionIntent(intentHash);
            if (intent.status != CANCELLED && intent.status != RELEASED && intent.status != DISPUTED) {
                revert PredecessorIntentStatusMismatch(intentHash, intent.status);
            }
            (, uint256 amount,) = targetVault.locks(intentHash);
            if (amount != 0) revert PredecessorIntentLockAmountMismatch(intentHash, amount);
        }

        uint256 actualCounter = IActivationEscrow(escrow).depositCounter();
        if (actualCounter != expectedDepositCounter) revert DepositCounterMismatch(actualCounter);
        for (uint256 tupleIndex = 0; tupleIndex < inventoryTuples.length; tupleIndex++) {
            InventoryTuple memory tuple = inventoryTuples[tupleIndex];
            actualBool = fresh.isDisputeProtectionEnabled(tuple.escrow, tuple.depositId, tuple.paymentMethod);
            if (actualBool) {
                revert InventoryTupleProtectionMismatch(tuple.escrow, tuple.depositId, tuple.paymentMethod, actualBool);
            }
        }
    }
}
