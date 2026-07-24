// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "../../contracts/interfaces/IIntentLifecycleHook.sol";
import {IRiskManager} from "../../contracts/interfaces/IRiskManager.sol";
import {RiskManagerFixture} from "../deterministic/helpers/RiskManagerFixture.sol";

contract RiskManagerFuzzTest is RiskManagerFixture {
    function testFuzz_ExtensionPenaltyNeverExceedsReservedAmount(
        uint96 rawIntentAmount,
        uint32 rawPurchasedTime,
        uint32 rawElapsedTime,
        uint16 rawSlope
    ) public view {
        uint256 intentAmount = bound(uint256(rawIntentAmount), 1, type(uint96).max);
        uint64 purchasedTime = uint64(bound(uint256(rawPurchasedTime), 1, 5 days));
        uint64 elapsedTime = uint64(bound(uint256(rawElapsedTime), 0, purchasedTime));
        uint32 slope = uint32(bound(uint256(rawSlope), 1, 83));

        uint256 reserved = manager.calculateIntentExtensionCost(intentAmount, purchasedTime, slope);
        (uint256 penalty, uint64 chargeableTime) =
            manager.calculateIntentExtensionPenalty(intentAmount, 1, uint64(1 + elapsedTime), purchasedTime, slope);

        assertLe(penalty, reserved);
        assertEq(chargeableTime, elapsedTime);
    }

    function testFuzz_ExtensionReservationIsCumulativelyMonotonic(
        uint96 rawIntentAmount,
        uint32 rawFirstTime,
        uint32 rawSecondTime,
        uint16 rawSlope
    ) public view {
        uint256 intentAmount = bound(uint256(rawIntentAmount), 1, type(uint96).max);
        uint64 firstTime = uint64(bound(uint256(rawFirstTime), 1, 2 days));
        uint64 secondTime = uint64(bound(uint256(rawSecondTime), 1, 2 days));
        uint32 slope = uint32(bound(uint256(rawSlope), 1, 83));

        uint256 firstCost = manager.calculateIntentExtensionCost(intentAmount, firstTime, slope);
        uint256 totalCost = manager.calculateIntentExtensionCost(intentAmount, firstTime + secondTime, slope);

        assertGe(totalCost, firstCost);
        assertEq(firstCost + (totalCost - firstCost), totalCost);
    }

    function testFuzz_StakeBackedSettlementAndMaturityConserveStake(uint96 rawIntentAmount, uint96 rawGrossAmount)
        public
    {
        uint256 intentAmount = bound(uint256(rawIntentAmount), 1, 10_000e6);
        uint256 grossAmount = bound(uint256(rawGrossAmount), 1, intentAmount);
        bytes32 intentHash = _admit(taker, payoutRecipient, intentAmount);

        IIntentLifecycleHook.FeeAllocation[] memory allocations = new IIntentLifecycleHook.FeeAllocation[](0);
        IIntentLifecycleHook.SettlementContext memory context = IIntentLifecycleHook.SettlementContext({
            intentHash: intentHash,
            token: address(token),
            recipient: payoutRecipient,
            grossAmount: grossAmount,
            executableAmount: grossAmount,
            isManualRelease: false,
            feeAllocations: allocations
        });
        orchestrator.settle(manager, context);

        (, uint256 lockedAmount,) = vault.locks(intentHash);
        assertEq(lockedAmount, grossAmount);
        vm.warp(manager.getRiskPosition(intentHash).coverageDeadline);
        manager.releaseMaturedPosition(intentHash);

        assertEq(vault.stakeBalance(safe), 50_000e6);
        assertEq(vault.freeStake(safe), 50_000e6);
        assertEq(vault.totalClaimable(), 0);
    }

    function testFuzz_DeferredMaturityConservesGrossAcrossNetAndClaims(
        uint96 rawIntentAmount,
        uint96 rawGrossAmount,
        uint96 rawProtocolFee,
        uint96 rawReferralFee
    ) public {
        uint256 intentAmount = bound(uint256(rawIntentAmount), 1, 10_000e6);
        uint256 grossAmount = bound(uint256(rawGrossAmount), 1, intentAmount);
        uint256 maximumFees = grossAmount - 1;
        uint256 protocolFee = bound(uint256(rawProtocolFee), 0, maximumFees);
        uint256 referralFee = bound(uint256(rawReferralFee), 0, maximumFees - protocolFee);
        address unstakedTaker = makeAddr("unstakedTaker");
        bytes32 intentHash = _admit(unstakedTaker, payoutRecipient, intentAmount);

        IIntentLifecycleHook.SettlementContext memory context =
            _settlementContext(intentHash, grossAmount, protocolFee, referralFee, false);
        orchestrator.settle(manager, context);
        vm.warp(manager.getRiskPosition(intentHash).coverageDeadline);
        manager.releaseMaturedPosition(intentHash);

        uint256 netAmount = grossAmount - protocolFee - referralFee;
        assertEq(vault.freeStake(payoutRecipient), netAmount);
        assertEq(vault.claimable(protocolFeeRecipient), protocolFee);
        assertEq(vault.claimable(referralFeeRecipient), referralFee);
        assertEq(
            vault.freeStake(payoutRecipient) + vault.claimable(protocolFeeRecipient)
                + vault.claimable(referralFeeRecipient),
            grossAmount
        );
        assertEq(vault.totalAccounted(), 50_000e6 + grossAmount);
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
    }

    function testFuzz_CancellationChargeMatchesElapsedPurchasedTime(uint32 rawPurchasedTime, uint32 rawElapsedTime)
        public
    {
        uint64 purchasedTime = uint64(bound(uint256(rawPurchasedTime), 1, 2 days));
        uint64 elapsedTime = uint64(bound(uint256(rawElapsedTime), 0, purchasedTime));
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory admitted = manager.getRiskPosition(intentHash);
        vm.prank(taker);
        manager.extendIntent(intentHash, purchasedTime);

        vm.warp(uint256(admitted.baseIntentExpiry) + elapsedTime);
        orchestrator.cancel(manager, intentHash);

        uint256 expectedPenalty = manager.calculateIntentExtensionCost(INTENT_AMOUNT, elapsedTime, EXTENSION_SLOPE);
        assertEq(vault.claimable(lp), expectedPenalty);
        assertEq(vault.lockedStake(safe), 0);
    }
}
