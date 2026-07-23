// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentRiskHook} from "../../contracts/interfaces/IIntentRiskHook.sol";
import {RiskManagerFixture} from "../deterministic/helpers/RiskManagerFixture.sol";

contract RiskManagerFuzzTest is RiskManagerFixture {
    function testFuzz_StakeBackedSettlementAndMaturityConserveStake(uint96 rawIntentAmount, uint96 rawGrossAmount)
        public
    {
        uint256 intentAmount = bound(uint256(rawIntentAmount), 1, 10_000e6);
        uint256 grossAmount = bound(uint256(rawGrossAmount), 1, intentAmount);
        bytes32 intentHash = _admit(taker, payoutRecipient, intentAmount);

        IIntentRiskHook.FeeAllocation[] memory allocations = new IIntentRiskHook.FeeAllocation[](0);
        IIntentRiskHook.RiskSettlementContext memory context = IIntentRiskHook.RiskSettlementContext({
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

        IIntentRiskHook.RiskSettlementContext memory context =
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
}
