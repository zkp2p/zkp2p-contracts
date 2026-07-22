// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerBoundaryFixture} from "../helpers/RiskManagerBoundaryFixture.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

contract RiskManagerDeferredCustodyTest is RiskManagerBoundaryFixture {
    function test_DeferredSettlementPullsGrossIntoVaultAndClearsAllowance() public {
        _enableDeferred();
        bytes32 intentHash = _signalDefault(taker, 100e6, PAYPAL);
        assertEq(uint256(manager.getRiskPosition(intentHash).mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        uint256 recipientBefore = token.balanceOf(taker);
        _fulfill(intentHash, 100e6);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        IStakeVault.DeferredStake memory deferredStake = vault.getDeferredStake(intentHash);
        assertEq(position.grossReleasedAmount, 100e6);
        assertEq(position.executableAmount, 100e6);
        assertEq(deferredStake.grossAmount, 100e6);
        assertEq(vault.stakeBalance(taker), 100e6);
        assertEq(vault.reservedStake(taker), 100e6);
        assertEq(vault.freeStake(taker), 0);
        assertEq(token.balanceOf(taker), recipientBefore);
        assertEq(token.allowance(address(orchestrator), address(manager)), 0);
    }

    function test_RelayedDeferredSettlementCreditsPayoutRecipient() public {
        _enableDeferred();
        bytes32 intentHash = _signal(taker, recipient, 100e6, PAYPAL);
        IRiskManager.RiskPosition memory admitted = manager.getRiskPosition(intentHash);
        assertEq(admitted.taker, taker);
        assertEq(admitted.stakeOwner, recipient);
        assertEq(admitted.payoutRecipient, recipient);
        assertEq(vault.getDeferredStake(intentHash).staker, recipient);
        _fulfill(intentHash, 100e6);
        assertEq(vault.stakeBalance(taker), 0);
        assertEq(vault.stakeBalance(recipient), 100e6);
        assertEq(vault.reservedStake(recipient), 100e6);
    }

    function test_DeferredSettlementPreservesExactFeePlanUntilMaturity() public {
        _enableDeferred();
        orchestrator.setProtocolFee(ONE_PERCENT);
        _configureManagerFee(recipient);
        uint256 grossAmount = 1e6 + 1;
        bytes32 intentHash =
            _signalCustom(taker, taker, grossAmount, PAYPAL, _oneReferral(other), IPostIntentHookV2(address(0)), "");
        uint256 protocolBefore = token.balanceOf(address(this));
        uint256 referrerBefore = token.balanceOf(other);
        uint256 managerBefore = token.balanceOf(recipient);
        _fulfill(intentHash, grossAmount);
        uint256 feeEach = grossAmount * ONE_PERCENT / 1e18;
        uint256 executableAmount = grossAmount - (feeEach * 3);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(token.balanceOf(address(this)), protocolBefore);
        assertEq(token.balanceOf(other), referrerBefore);
        assertEq(token.balanceOf(recipient), managerBefore);
        assertEq(position.grossReleasedAmount, grossAmount);
        assertEq(position.executableAmount, executableAmount);
        assertEq(position.grossReleasedAmount - position.executableAmount, feeEach * 3);
        assertEq(vault.getDeferredStake(intentHash).grossAmount, grossAmount);
        IIntentRiskHook.FeeAllocation[] memory allocations = vault.getDeferredFeeAllocations(intentHash);
        assertEq(allocations.length, 3);
        assertEq(allocations[0].amount, feeEach);
        assertEq(allocations[1].amount, feeEach);
        assertEq(allocations[2].amount, feeEach);
        assertEq(vault.stakeBalance(taker), grossAmount);
        assertEq(vault.reservedStake(taker), grossAmount);

        vm.warp(position.coverageDeadline);
        manager.releaseMaturedPosition(intentHash);
        assertEq(vault.stakeBalance(taker), executableAmount);
        assertEq(vault.freeStake(taker), executableAmount);
        assertEq(vault.claimableFees(address(this)), feeEach);
        assertEq(vault.claimableFees(other), feeEach);
        assertEq(vault.claimableFees(recipient), feeEach);
        assertEq(token.balanceOf(address(this)), protocolBefore);
        assertEq(token.balanceOf(other), referrerBefore);
        assertEq(token.balanceOf(recipient), managerBefore);

        vault.withdrawFeeClaimFor(address(this));
        vault.withdrawFeeClaimFor(other);
        vault.withdrawFeeClaimFor(recipient);
        assertEq(token.balanceOf(address(this)), protocolBefore + feeEach);
        assertEq(token.balanceOf(other), referrerBefore + feeEach);
        assertEq(token.balanceOf(recipient), managerBefore + feeEach);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    function test_DeferredSettlementHandlesTenReferralsWithinGasBounds() public {
        _enableDeferred();
        orchestrator.setProtocolFee(ONE_PERCENT);
        _configureManagerFee(recipient);
        IReferralFee.ReferralFee[] memory referrals = new IReferralFee.ReferralFee[](10);
        for (uint256 index; index < referrals.length; index++) {
            referrals[index] = IReferralFee.ReferralFee({recipient: address(uint160(1_000 + index)), fee: 1e15});
        }
        bytes32 intentHash = _signalCustom(taker, taker, 100e6, PAYPAL, referrals, IPostIntentHookV2(address(0)), "");
        uint256 gasBefore = gasleft();
        _fulfill(intentHash, 100e6);
        uint256 fulfillmentGas = gasBefore - gasleft();
        assertEq(manager.MAX_FEE_ALLOCATIONS(), 12);
        assertEq(vault.getDeferredFeeAllocations(intentHash).length, 12);
        assertLt(fulfillmentGas, 3_000_000);
        vm.warp(manager.getRiskPosition(intentHash).coverageDeadline);
        gasBefore = gasleft();
        manager.releaseMaturedPosition(intentHash);
        uint256 maturityGas = gasBefore - gasleft();
        assertLt(maturityGas, 1_500_000);
        for (uint256 index; index < referrals.length; index++) {
            assertEq(vault.claimableFees(referrals[index].recipient), 0.1e6);
        }
    }

    function test_ChargebackSlashesGrossDeferredStakeAndCancelsFees() public {
        _enableDeferred();
        orchestrator.setProtocolFee(ONE_PERCENT);
        _configureManagerFee(recipient);
        uint256 grossAmount = 100e6;
        bytes32 intentHash =
            _signalCustom(taker, taker, grossAmount, PAYPAL, _oneReferral(other), IPostIntentHookV2(address(0)), "");
        uint256 protocolBefore = token.balanceOf(address(this));
        uint256 referralBefore = token.balanceOf(other);
        uint256 managerBefore = token.balanceOf(recipient);
        _fulfill(intentHash, grossAmount);
        assertEq(vault.getDeferredStake(intentHash).grossAmount, grossAmount);
        assertEq(vault.stakeBalance(taker), grossAmount);
        assertEq(vault.freeStake(taker), 0);
        assertEq(vault.reservedStake(taker), grossAmount);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
        manager.submitChargeback(_chargebackClaim(intentHash, grossAmount, true));
        assertEq(vault.getDeferredStake(intentHash).staker, address(0));
        assertEq(vault.claimableCompensation(maker), grossAmount);
        assertEq(vault.claimableFees(address(this)), 0);
        assertEq(vault.claimableFees(other), 0);
        assertEq(vault.claimableFees(recipient), 0);
        assertEq(token.balanceOf(address(this)), protocolBefore);
        assertEq(token.balanceOf(other), referralBefore);
        assertEq(token.balanceOf(recipient), managerBefore);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
        uint256 makerBefore = token.balanceOf(maker);
        vm.prank(maker);
        vault.withdrawCompensation(maker);
        assertEq(token.balanceOf(maker), makerBefore + grossAmount);
        assertEq(vault.claimableCompensation(maker), 0);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
        assertEq(vault.stakeBalance(taker), 0);
        assertEq(vault.freeStake(taker), 0);
    }

    function test_MaturedDeferredCustodyBecomesReusableRecipientStake() public {
        _enableDeferred();
        bytes32 intentHash = _signalDefault(taker, 100e6, PAYPAL);
        uint256 stakeBefore = vault.stakeBalance(taker);
        uint256 beneficiaryBefore = token.balanceOf(taker);
        _fulfill(intentHash, 100e6);
        vm.warp(manager.getRiskPosition(intentHash).coverageDeadline);
        manager.releaseMaturedPosition(intentHash);
        assertEq(token.balanceOf(taker), beneficiaryBefore);
        assertEq(vault.getDeferredStake(intentHash).staker, address(0));
        assertEq(vault.stakeBalance(taker), stakeBefore + 100e6);
        assertEq(vault.freeStake(taker), stakeBefore + 100e6);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
    }
}
