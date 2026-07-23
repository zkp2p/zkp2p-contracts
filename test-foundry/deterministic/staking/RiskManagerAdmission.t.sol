// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentRiskHook} from "../../../contracts/interfaces/IIntentRiskHook.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";
import {IPostIntentHookV2} from "../../../contracts/interfaces/IPostIntentHookV2.sol";
import {RiskManagerFixture} from "../helpers/RiskManagerFixture.sol";

contract RiskManagerAdmissionTest is RiskManagerFixture {
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
        _setConfig(false, false, 0);
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(position.coverageAmount, 0);
        (address lockOwner,,) = vault.locks(intentHash);
        assertEq(lockOwner, address(0));
    }

    function test_AdmissionFailsWithoutStakeOrDeferredPayout() public {
        _setConfig(true, false, RISK_WINDOW);
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

    function test_RiskTakingPauseBlocksAdmissionButNotCancellation() public {
        bytes32 admittedIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        vm.prank(owner);
        manager.setRiskTakingPaused(true);

        (bytes32 newIntent,) = _newIntent(taker, payoutRecipient, INTENT_AMOUNT);
        vm.expectRevert(IRiskManager.RiskTakingPaused.selector);
        orchestrator.admit(manager, newIntent);

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
            })
        });
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, PAYMENT_METHOD));
        manager.setPlatformRiskConfig(PAYMENT_METHOD, config);

        config.chargeback =
            IRiskManager.ChargebackConfig({chargebackable: true, deferredPayoutEnabled: true, riskWindow: 0});
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, PAYMENT_METHOD));
        manager.setPlatformRiskConfig(PAYMENT_METHOD, config);
    }

    function test_CancellationBeforeBaseExpiryFreesTheCoverageLock() public {
        uint256 safeBalanceBefore = vault.stakeBalance(safe);
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);

        orchestrator.cancel(manager, intentHash);

        assertEq(vault.lockedStake(safe), 0);
        assertEq(vault.stakeBalance(safe), safeBalanceBefore);
        assertEq(vault.claimable(lp), 0);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.CANCELLED));
    }

    function test_FailedCancellationReconciliationUsesOriginalTimestamp() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        uint64 cancelledAt = uint64(block.timestamp + 30 minutes);
        orchestrator.recordFailedCancellation(intentHash, cancelledAt);
        vm.warp(uint256(cancelledAt) + 7 days);

        manager.reconcileCancellation(intentHash);

        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.CANCELLED));
        assertTrue(orchestrator.cancellationAcknowledged(intentHash));
    }
}
