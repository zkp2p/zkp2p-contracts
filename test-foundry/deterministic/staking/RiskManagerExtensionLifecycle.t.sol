// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerIntegrationFixture} from "../helpers/RiskManagerIntegrationFixture.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

contract RiskManagerExtensionLifecycleTest is RiskManagerIntegrationFixture {
    function _depositAsTaker(uint256 amount) internal {
        vm.prank(taker);
        vault.depositStake(amount);
    }

    function _delegateFromFixtureOwner(uint256 amount) internal {
        token.approve(address(vault), type(uint256).max);
        vault.depositStakeFor(taker, amount);
    }

    function test_ExtensionUsesTakerStakeAndChargesElapsedTimeOnCancellation() public {
        _depositAsTaker(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        uint64 baseExpiry = manager.getRiskPosition(intentHash).baseIntentExpiry;
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 * HOUR);
        assertEq(manager.getRiskPosition(intentHash).extensionReservation, 2e6);
        assertEq(vault.reservedStake(taker), 2e6);
        vm.warp(baseExpiry + HOUR);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.extensionPenalty, 1e6);
        assertEq(vault.claimableCompensation(maker), 1e6);
        assertEq(vault.stakeBalance(taker), 9e6);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_ExtensionChargesSameElapsedCurveOnFulfillment() public {
        _depositAsTaker(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        uint64 baseExpiry = manager.getRiskPosition(intentHash).baseIntentExpiry;
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 * HOUR);
        vm.warp(baseExpiry + HOUR);
        _fulfill(intentHash, 1_000e6);
        assertEq(manager.getRiskPosition(intentHash).extensionPenalty, 1e6);
        assertEq(vault.claimableCompensation(maker), 1e6);
        assertEq(vault.stakeBalance(taker), 9e6);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_ExtensionCollateralRemainsSeparateFromChargebackCoverage() public {
        _depositAsTaker(2_000e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, PAYPAL);
        IRiskManager.RiskPosition memory admitted = manager.getRiskPosition(intentHash);
        bytes32 extensionId = manager.extensionReservationId(intentHash);
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 * HOUR);
        assertEq(vault.getReservation(intentHash).amount, 1_000e6);
        assertEq(vault.getReservation(extensionId).amount, 2e6);
        assertEq(vault.reservedStake(taker), 1_002e6);
        vm.warp(admitted.baseIntentExpiry + HOUR);
        _fulfill(intentHash, 600e6);
        IRiskManager.RiskPosition memory settled = manager.getRiskPosition(intentHash);
        assertEq(settled.extensionPenalty, 1e6);
        assertEq(settled.reservedAmount, 600e6);
        assertEq(vault.getReservation(intentHash).amount, 600e6);
        assertFalse(vault.getReservation(extensionId).active);
        assertEq(vault.reservedStake(taker), 600e6);
        assertEq(vault.claimableCompensation(maker), 1e6);
    }

    function test_DelegatedStakeOwnerExtendsWithoutTransferringOwnership() public {
        _delegateFromFixtureOwner(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        uint64 baseExpiry = manager.getRiskPosition(intentHash).baseIntentExpiry;
        manager.extendIntent(intentHash, 2 * HOUR);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        IStakeVault.Reservation memory reservation = vault.getReservation(manager.extensionReservationId(intentHash));
        assertEq(position.extensionStakeOwner, address(this));
        assertEq(reservation.staker, address(this));
        assertEq(vault.stakeBalance(address(this)), 10e6);
        assertEq(vault.freeStake(address(this)), 8e6);
        assertEq(vault.stakeBalance(taker), 0);
        vm.warp(baseExpiry + HOUR);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(vault.stakeBalance(address(this)), 9e6);
        assertEq(vault.freeStake(address(this)), 9e6);
        assertEq(vault.stakeBalance(taker), 0);
        assertEq(vault.claimableCompensation(maker), 1e6);
    }

    function test_ExtensionResolvesDelegatedOwnerAddedAfterAdmission() public {
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        assertEq(manager.getRiskPosition(intentHash).stakeOwner, taker);
        _delegateFromFixtureOwner(10e6);
        manager.extendIntent(intentHash, 2 * HOUR);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.extensionStakeOwner, address(this));
        assertEq(position.totalExtensionTime, 2 * HOUR);
        assertEq(position.extensionReservation, 2e6);
        assertEq(vault.stakeBalance(taker), 0);
        assertEq(vault.reservedStake(address(this)), 2e6);
    }

    function test_ThirdPartyCannotLockTakerStakeForExtension() public {
        _depositAsTaker(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        vm.expectPartialRevert(IRiskManager.UnauthorizedStakeExtension.selector);
        vm.prank(secondTaker);
        manager.extendIntent(intentHash, HOUR);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_RevocationBlocksTakerTopupsButPreservesOriginalOwnerControl() public {
        _delegateFromFixtureOwner(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
        vault.setTakerAuthorization(taker, false);
        vm.expectPartialRevert(IRiskManager.UnauthorizedStakeExtension.selector);
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
        manager.extendIntent(intentHash, HOUR);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.extensionStakeOwner, address(this));
        assertEq(position.totalExtensionTime, 2 * HOUR);
        assertEq(position.extensionReservation, 2e6);
        assertEq(vault.reservedStake(address(this)), 2e6);
    }

    function test_ExtensionCannotReviveExpiredIntent() public {
        _depositAsTaker(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        uint64 baseExpiry = manager.getRiskPosition(intentHash).baseIntentExpiry;
        vm.warp(baseExpiry);
        vm.expectPartialRevert(IRiskManager.IntentAlreadyExpired.selector);
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
    }
}
