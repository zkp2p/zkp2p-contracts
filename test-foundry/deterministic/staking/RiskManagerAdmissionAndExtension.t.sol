// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentRiskHook} from "../../../contracts/interfaces/IIntentRiskHook.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";
import {IPostIntentHookV2} from "../../../contracts/interfaces/IPostIntentHookV2.sol";
import {RiskManagerFixture} from "../helpers/RiskManagerFixture.sol";

contract RiskManagerAdmissionAndExtensionTest is RiskManagerFixture {
    function test_StakeBackedAdmissionLocksTheSelectedSponsorsFullCoverage() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.STAKE_BACKED));
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.PENDING));
        assertEq(position.stakeOwner, safe);
        assertEq(position.coverageAmount, INTENT_AMOUNT);

        (address lockOwner, uint256 lockAmount, uint64 maturesAt) = vault.locks(intentHash);
        assertEq(lockOwner, safe);
        assertEq(lockAmount, INTENT_AMOUNT);
        assertEq(maturesAt, type(uint64).max);
        assertEq(vault.lockedStake(safe), INTENT_AMOUNT);
    }

    function test_DeferredAdmissionCreatesNoVaultStateUntilSettlement() public {
        address unstakedTaker = makeAddr("unstakedTaker");
        bytes32 intentHash = _admit(unstakedTaker, payoutRecipient, INTENT_AMOUNT);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(position.stakeOwner, payoutRecipient);
        assertEq(position.coverageAmount, 0);
        (address lockOwner,,) = vault.locks(intentHash);
        assertEq(lockOwner, address(0));
    }

    function test_DeferredAdmissionRejectsPostIntentHookBeforeFundsCanBeStranded() public {
        address unfundedTaker = makeAddr("unfundedTaker");
        (bytes32 intentHash,) = _newIntent(unfundedTaker, payoutRecipient, INTENT_AMOUNT);
        address postIntentHook = makeAddr("postIntentHook");
        orchestrator.setPostIntentHook(intentHash, IPostIntentHookV2(postIntentHook));

        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.DeferredPostIntentHookUnsupported.selector, intentHash, postIntentHook)
        );
        orchestrator.admit(manager, intentHash);

        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.NONE));
        assertEq(vault.lockedStake(payoutRecipient), 0);
    }

    function test_UnbondedAdmissionDoesNotCreateChargebackLock() public {
        _setConfig(false, false, 0, EXTENSION_SLOPE);
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(position.coverageAmount, 0);
        (address lockOwner,,) = vault.locks(intentHash);
        assertEq(lockOwner, address(0));
    }

    function test_AdmissionFailsWithoutStakeOrDeferredPayout() public {
        _setConfig(true, false, RISK_WINDOW, EXTENSION_SLOPE);
        address unstakedTaker = makeAddr("unstakedTaker");
        (bytes32 intentHash,) = _newIntent(unstakedTaker, payoutRecipient, INTENT_AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.InsufficientCollateral.selector, unstakedTaker, 0, INTENT_AMOUNT)
        );
        orchestrator.admit(manager, intentHash);
    }

    function test_AdmissionUsesTakersOwnAdditiveStakeAfterSelectionIsCleared() public {
        _depositStake(taker, INTENT_AMOUNT);
        vm.prank(taker);
        vault.clearStakeOwner();

        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.stakeOwner, taker);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.STAKE_BACKED));
    }

    function test_AttackerAuthorizationCannotChangeTheSponsorUsedAtAdmission() public {
        address attacker = makeAddr("attacker");
        token.mint(attacker, INTENT_AMOUNT);
        _depositStake(attacker, INTENT_AMOUNT);
        vm.prank(attacker);
        vault.setTakerAuthorization(taker, true);

        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        assertEq(manager.getRiskPosition(intentHash).stakeOwner, safe);
    }

    function test_OnlyOrchestratorCanRunLifecycleCallbacks() public {
        (bytes32 intentHash,) = _newIntent(taker, payoutRecipient, INTENT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.UnauthorizedOrchestrator.selector, address(this)));
        manager.onIntentCreated(intentHash);

        vm.expectRevert(abi.encodeWithSelector(IRiskManager.UnauthorizedOrchestrator.selector, address(this)));
        manager.onIntentCancelled(intentHash);

        IIntentRiskHook.RiskSettlementContext memory context =
            _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, false);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.UnauthorizedOrchestrator.selector, address(this)));
        manager.settleIntent(context);
    }

    function test_RiskTakingPauseBlocksAdmissionAndExtensionButNotCancellation() public {
        bytes32 admittedIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        vm.prank(owner);
        manager.setRiskTakingPaused(true);

        (bytes32 newIntent,) = _newIntent(taker, payoutRecipient, INTENT_AMOUNT);
        vm.expectRevert(IRiskManager.RiskTakingPaused.selector);
        orchestrator.admit(manager, newIntent);

        vm.prank(taker);
        vm.expectRevert(IRiskManager.RiskTakingPaused.selector);
        manager.extendIntent(admittedIntent, 1 hours);

        orchestrator.cancel(manager, admittedIntent);
        assertEq(
            uint256(manager.getRiskPosition(admittedIntent).status), uint256(IRiskManager.PositionStatus.CANCELLED)
        );
    }

    function test_PlatformConfigurationRejectsInvalidCombinations() public {
        IRiskManager.PlatformRiskConfig memory config = IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: false, deferredPayoutEnabled: true, riskWindow: 0
            }),
            extensionPenaltyBpsPerHour: EXTENSION_SLOPE
        });
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, PAYMENT_METHOD));
        manager.setPlatformRiskConfig(PAYMENT_METHOD, config);

        config.chargeback =
            IRiskManager.ChargebackConfig({chargebackable: true, deferredPayoutEnabled: true, riskWindow: 0});
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, PAYMENT_METHOD));
        manager.setPlatformRiskConfig(PAYMENT_METHOD, config);

        config.chargeback.riskWindow = RISK_WINDOW;
        config.extensionPenaltyBpsPerHour = 10_000;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.ExtensionPenaltyExceedsIntentAmount.selector, PAYMENT_METHOD)
        );
        manager.setPlatformRiskConfig(PAYMENT_METHOD, config);
    }

    function test_ExtensionUsesAnIndependentNeverMaturingLock() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        uint64 additionalTime = 2 hours;
        uint256 expectedAmount = manager.calculateIntentExtensionCost(INTENT_AMOUNT, additionalTime, EXTENSION_SLOPE);

        vm.prank(taker);
        manager.extendIntent(intentHash, additionalTime);

        bytes32 extensionId = manager.extensionLockId(intentHash);
        (address lockOwner, uint256 lockAmount, uint64 maturesAt) = vault.locks(extensionId);
        assertTrue(extensionId != intentHash);
        assertEq(lockOwner, safe);
        assertEq(lockAmount, expectedAmount);
        assertEq(maturesAt, type(uint64).max);

        (, uint256 chargebackAmount,) = vault.locks(intentHash);
        assertEq(chargebackAmount, INTENT_AMOUNT);
    }

    function test_DeferredPositionUsesTakersOwnStakeForItsIndependentExtensionLock() public {
        address deferredTaker = makeAddr("deferredTaker");
        bytes32 intentHash = _admit(deferredTaker, payoutRecipient, INTENT_AMOUNT);
        token.mint(deferredTaker, 10e6);
        _depositStake(deferredTaker, 10e6);

        vm.prank(deferredTaker);
        manager.extendIntent(intentHash, 1 hours);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(position.stakeOwner, payoutRecipient);
        assertEq(position.extensionStakeOwner, deferredTaker);
        assertEq(position.extensionAmount, 1e6);
        (address lockOwner, uint256 lockAmount, uint64 maturesAt) = vault.locks(manager.extensionLockId(intentHash));
        assertEq(lockOwner, deferredTaker);
        assertEq(lockAmount, 1e6);
        assertEq(maturesAt, type(uint64).max);
    }

    function test_ExtensionTopUpsAreAdditiveAndRevocationStopsTakerButNotSponsor() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        vm.prank(taker);
        manager.extendIntent(intentHash, 1 hours);

        vm.prank(safe);
        vault.setTakerAuthorization(taker, false);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.UnauthorizedStakeExtension.selector, taker, taker, safe));
        manager.extendIntent(intentHash, 1 hours);

        vm.prank(safe);
        manager.extendIntent(intentHash, 1 hours);

        uint256 expectedAmount = manager.calculateIntentExtensionCost(INTENT_AMOUNT, 2 hours, EXTENSION_SLOPE);
        (, uint256 lockAmount,) = vault.locks(manager.extensionLockId(intentHash));
        assertEq(lockAmount, expectedAmount);
        assertEq(manager.getRiskPosition(intentHash).extensionAmount, expectedAmount);
    }

    function test_CancellationBeforeBaseExpiryFreesBothLocksWithoutPenalty() public {
        uint256 safeBalanceBefore = vault.stakeBalance(safe);
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 hours);

        orchestrator.cancel(manager, intentHash);

        assertEq(vault.lockedStake(safe), 0);
        assertEq(vault.stakeBalance(safe), safeBalanceBefore);
        assertEq(vault.claimable(lp), 0);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.CANCELLED));
    }

    function test_CancellationChargesOnlyElapsedPurchasedTimeAndFreesRemainder() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory admitted = manager.getRiskPosition(intentHash);
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 hours);

        vm.warp(uint256(admitted.baseIntentExpiry) + 1 hours);
        uint256 expectedPenalty = manager.calculateIntentExtensionCost(INTENT_AMOUNT, 1 hours, EXTENSION_SLOPE);
        orchestrator.cancel(manager, intentHash);

        assertEq(vault.claimable(lp), expectedPenalty);
        assertEq(vault.lockedStake(safe), 0);
        assertEq(vault.stakeBalance(safe), 50_000e6 - expectedPenalty);
        assertEq(vault.freeStake(safe), 50_000e6 - expectedPenalty);
    }

    function test_FailedCancellationReconciliationUsesOriginalTimestamp() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory admitted = manager.getRiskPosition(intentHash);
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 hours);

        uint64 cancelledAt = admitted.baseIntentExpiry + 30 minutes;
        orchestrator.recordFailedCancellation(intentHash, cancelledAt);
        vm.warp(uint256(cancelledAt) + 7 days);

        manager.reconcileCancellation(intentHash);

        uint256 expectedPenalty = manager.calculateIntentExtensionCost(INTENT_AMOUNT, 30 minutes, EXTENSION_SLOPE);
        assertEq(vault.claimable(lp), expectedPenalty);
        assertTrue(orchestrator.cancellationAcknowledged(intentHash));
    }

    function test_ExtensionDisabledAndLifetimeBoundaryRevertBeforeVaultMutation() public {
        _setConfig(true, true, RISK_WINDOW, 0);
        bytes32 disabledIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.ExtensionsDisabled.selector, PAYMENT_METHOD));
        manager.extendIntent(disabledIntent, 1 hours);

        _setConfig(true, true, RISK_WINDOW, EXTENSION_SLOPE);
        bytes32 limitedIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(limitedIntent);
        uint64 maximumExtension = uint64(uint256(position.createdAt) + 5 days - position.baseIntentExpiry);
        vm.prank(taker);
        manager.extendIntent(limitedIntent, maximumExtension);

        uint256 lockedBefore = vault.lockedStake(safe);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.ExtensionExceedsIntentLifetime.selector,
                uint64(uint256(position.createdAt) + 5 days + 1),
                uint64(uint256(position.createdAt) + 5 days)
            )
        );
        manager.extendIntent(limitedIntent, 1);
        assertEq(vault.lockedStake(safe), lockedBefore);
    }

    function test_ExtensionRejectsTotalTimeOverflowBeforeMutatingVault() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        uint64 totalExtensionTime = type(uint64).max - position.baseIntentExpiry;
        uint64 additionalTime = position.baseIntentExpiry + 1;

        manager.setPositionTotalExtensionTime(intentHash, totalExtensionTime);
        escrow.setIntentExpiry(intentHash, type(uint64).max);

        uint256 lockedBefore = vault.lockedStake(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.ExtensionTimeOverflow.selector, uint256(totalExtensionTime) + additionalTime
            )
        );
        vm.prank(taker);
        manager.extendIntent(intentHash, additionalTime);

        assertEq(vault.lockedStake(safe), lockedBefore);
    }
}
