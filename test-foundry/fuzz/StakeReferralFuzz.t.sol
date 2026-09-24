// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeReferralFixture} from "../deterministic/helpers/StakeReferralFixture.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IStakeReferralLifecycleHook} from "contracts/interfaces/IStakeReferralLifecycleHook.sol";

contract StakeReferralFuzzTest is StakeReferralFixture {
    function testFuzz_ReferralSplitConservesExactBuyerOutputAndTotalFees(
        uint256 releaseAmount,
        uint256 l1Rate,
        uint256 donorRate,
        bool backerIsMakerReferrer
    ) public {
        releaseAmount = bound(releaseAmount, 1, INTENT_AMOUNT);
        l1Rate = bound(l1Rate, 1, 4e15);
        donorRate = bound(donorRate, l1Rate, 1e16);
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), peer, l1Rate);
        IOrchestratorV3.SignalIntentParams memory params =
            _feesParams(donorRate, backerIsMakerReferrer ? backer : referrer);
        bytes32 hash = _signal(taker, params);
        _fulfill(hash, releaseAmount, CONVERSION_RATE);

        uint256 originalFees;
        for (uint256 i; i < params.referralFees.length; ++i) {
            originalFees += releaseAmount * params.referralFees[i].fee / 1e18;
        }
        uint256 backerFee = releaseAmount * l1Rate / 1e18;
        if (backerIsMakerReferrer) backerFee += releaseAmount * L1_FEE / 1e18;
        assertEq(token.balanceOf(backer), backerFee);
        assertEq(token.balanceOf(taker), releaseAmount - originalFees);
        assertEq(
            token.balanceOf(peer) + token.balanceOf(referrer) + token.balanceOf(other) + token.balanceOf(backer),
            originalFees
        );
        assertEq(token.balanceOf(address(orchestrator)), 0);
        assertEq(vault.lockedStake(backer), releaseAmount);
        assertEq(vault.freeStake(backer) + vault.lockedStake(backer), STAKE);
    }
}
