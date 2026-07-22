// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerIntegrationFixture} from "../helpers/RiskManagerIntegrationFixture.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {IntentRiskHookMock} from "contracts/mocks/IntentRiskHookMock.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";

contract RiskManagerExtensionBoundaryTest is RiskManagerIntegrationFixture {
    function _depositAsTaker(uint256 amount) internal {
        vm.prank(taker);
        vault.depositStake(amount);
    }

    function _delegateFromFixtureOwner(uint256 amount) internal {
        token.approve(address(vault), type(uint256).max);
        vault.depositStakeFor(taker, amount);
    }

    function test_ExtensionEnforcesFiveDayLifetimeBeforeReservingMoreStake() public {
        _depositAsTaker(200e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        uint64 maximumExtension = 5 * DAY - BASE_INTENT_PERIOD;
        vm.prank(taker);
        manager.extendIntent(intentHash, maximumExtension);
        IRiskManager.RiskPosition memory beforePosition = manager.getRiskPosition(intentHash);
        vm.expectPartialRevert(IRiskManager.ExtensionExceedsIntentLifetime.selector);
        vm.prank(taker);
        manager.extendIntent(intentHash, 1);
        IRiskManager.RiskPosition memory afterPosition = manager.getRiskPosition(intentHash);
        assertEq(afterPosition.totalExtensionTime, maximumExtension);
        assertEq(afterPosition.extensionReservation, beforePosition.extensionReservation);
    }

    function test_ExtensionTopupRejectsReservationsPause() public {
        _depositAsTaker(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
        vault.setStakeOperationsPaused(false, true);
        vm.expectRevert(StakeVault.StakeActionPaused.selector);
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
    }

    function test_FirstExtensionRejectsPauseForTakerAndDelegatedOwner() public {
        _delegateFromFixtureOwner(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        vault.setStakeOperationsPaused(false, true);
        vm.expectRevert(StakeVault.StakeActionPaused.selector);
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
        vm.expectRevert(StakeVault.StakeActionPaused.selector);
        manager.extendIntent(intentHash, HOUR);
        assertEq(manager.getRiskPosition(intentHash).totalExtensionTime, 0);
    }

    function test_ExtensionTopupRejectsStakeOwnerExit() public {
        _depositAsTaker(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
        vm.prank(taker);
        vault.requestExit();
        vm.expectPartialRevert(StakeVault.AlreadyExiting.selector);
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
    }

    function test_ExtensionUsesCumulativeRoundingAcrossRepeatedSteps() public {
        _depositAsTaker(10);
        bytes32 intentHash = _signalDefault(taker, 1e6, ZELLE);
        vm.startPrank(taker);
        manager.extendIntent(intentHash, 1);
        manager.extendIntent(intentHash, 1);
        vm.stopPrank();
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.totalExtensionTime, 2);
        assertEq(position.extensionReservation, 1);
        assertEq(vault.reservedStake(taker), 1);
    }

    function test_DelegatedOwnerCanExecuteZeroIncrementRoundingStep() public {
        _delegateFromFixtureOwner(10);
        bytes32 intentHash = _signalDefault(taker, 1e6, ZELLE);
        vm.prank(taker);
        manager.extendIntent(intentHash, 1);
        manager.extendIntent(intentHash, 1);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.totalExtensionTime, 2);
        assertEq(position.extensionReservation, 1);
        assertEq(position.extensionStakeOwner, address(this));
        assertEq(vault.reservedStake(address(this)), 1);
        assertEq(
            vault.getReservation(manager.extensionReservationId(intentHash)).releaseTime,
            escrow.getDepositIntent(0, intentHash).expiryTime
        );
    }

    function test_ZeroIncrementExtensionStillEnforcesPauseAndExitGates() public {
        uint256 cleanState = vm.snapshotState();
        _depositAsTaker(10);
        bytes32 pausedIntent = _signalDefault(taker, 1e6, ZELLE);
        vm.prank(taker);
        manager.extendIntent(pausedIntent, 1);
        vault.setStakeOperationsPaused(false, true);
        vm.expectRevert(StakeVault.StakeActionPaused.selector);
        vm.prank(taker);
        manager.extendIntent(pausedIntent, 1);

        assertTrue(vm.revertToState(cleanState));
        _depositAsTaker(10);
        bytes32 exitingIntent = _signalDefault(taker, 1e6, ZELLE);
        vm.prank(taker);
        manager.extendIntent(exitingIntent, 1);
        vm.prank(taker);
        vault.requestExit();
        vm.expectPartialRevert(StakeVault.AlreadyExiting.selector);
        vm.prank(taker);
        manager.extendIntent(exitingIntent, 1);
    }

    function test_HardCutRemovesGiftStyleSponsorshipSelectors() public view {
        (bool managerSelector,) = address(manager)
            .staticcall(abi.encodeWithSignature("stakeAndExtendIntent(bytes32,uint64)", bytes32(0), uint64(1)));
        (bool vaultSelector,) = address(vault)
            .staticcall(
                abi.encodeWithSignature(
                    "depositAndReserveStake(address,address,bytes32,uint256,uint64)",
                    address(this),
                    taker,
                    bytes32(0),
                    1,
                    uint64(1)
                )
            );
        assertFalse(managerSelector);
        assertFalse(vaultSelector);
    }

    function test_FailedTerminalCallbackRecordsOriginalCancellationTime() public {
        IntentRiskHookMock mock = new IntentRiskHookMock();
        vm.prank(maker);
        orchestrator.setDepositRiskHook(address(escrow), 0, IIntentRiskHook(address(mock)));
        bytes32 intentHash = _signalDefault(taker, 10e6, ZELLE);
        mock.setRevertOnCallback(true);
        uint64 beforeCancellation = uint64(block.timestamp);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        uint64 cancelledAt = orchestrator.getIntentCancellation(intentHash);
        assertGe(cancelledAt, beforeCancellation);
        assertEq(cancelledAt, uint64(block.timestamp));
    }
}
