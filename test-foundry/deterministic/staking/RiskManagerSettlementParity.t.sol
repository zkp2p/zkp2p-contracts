// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerIntegrationFixture} from "../helpers/RiskManagerIntegrationFixture.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";

contract RiskManagerSettlementParityTest is RiskManagerIntegrationFixture {
    function _depositAsTaker(uint256 amount) internal {
        vm.prank(taker);
        vault.depositStake(amount);
    }

    function test_NonChargebackableIntentSettlesWithoutAdmissionReservation() public {
        _depositAsTaker(10e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, ZELLE);
        _fulfill(intentHash, 1_000e6);
        assertEq(vault.reservedStake(taker), 0);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
    }

    function test_SettlementResizesCoverageToExactGrossRelease() public {
        _depositAsTaker(1_000e6);
        bytes32 intentHash = _signalDefault(taker, 1_000e6, PAYPAL);
        _fulfill(intentHash, 600e6);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertEq(position.reservedAmount, 600e6);
        assertEq(vault.reservedStake(taker), 600e6);
    }

    function test_ManualReleaseUsesStakeBackedSettlementAccounting() public {
        _depositAsTaker(500e6);
        bytes32 intentHash = _signalDefault(taker, 500e6, PAYPAL);
        uint256 balanceBefore = token.balanceOf(taker);
        vm.prank(maker);
        orchestrator.releaseFundsToPayer(intentHash);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertTrue(position.isManualRelease);
        assertGt(position.coverageDeadline, 0);
        assertEq(position.reservedAmount, 500e6);
        assertEq(vault.reservedStake(taker), 500e6);
        assertEq(token.balanceOf(taker), balanceBefore + 500e6);
    }

    function test_ManualReleaseChargesElapsedExtensionPenalty() public {
        _depositAsTaker(510e6);
        bytes32 intentHash = _signalDefault(taker, 500e6, PAYPAL);
        uint64 baseExpiry = manager.getRiskPosition(intentHash).baseIntentExpiry;
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 * HOUR);
        vm.warp(baseExpiry + HOUR);
        vm.prank(maker);
        orchestrator.releaseFundsToPayer(intentHash);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertTrue(position.isManualRelease);
        assertEq(position.extensionPenalty, 0.5e6);
        assertEq(position.reservedAmount, 500e6);
        assertEq(vault.claimableCompensation(maker), 0.5e6);
        assertEq(vault.reservedStake(taker), 500e6);
    }
}
