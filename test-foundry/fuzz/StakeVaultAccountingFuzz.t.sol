// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVaultLegacyFixture} from "../deterministic/helpers/StakeVaultLegacyFixture.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

/// @dev Properties exercise real StakeVault custody, reservation, slashing, fee, and exit paths.
contract StakeVaultAccountingFuzzTest is StakeVaultLegacyFixture {
    uint256 internal constant MAX_FUZZ_AMOUNT = 10_000e6;

    function _feePlan(uint256 protocolAmount, uint256 referralAmount)
        internal
        view
        returns (IIntentRiskHook.FeeAllocation[] memory fees)
    {
        fees = new IIntentRiskHook.FeeAllocation[](2);
        fees[0] = IIntentRiskHook.FeeAllocation({
            feeType: IIntentRiskHook.FeeType.PROTOCOL, recipient: recipient, amount: protocolAmount
        });
        fees[1] = IIntentRiskHook.FeeAllocation({
            feeType: IIntentRiskHook.FeeType.REFERRAL, recipient: maker, amount: referralAmount
        });
    }

    /// Risk: partial slashing can desynchronize stake, reservation, compensation, and token liabilities.
    function testFuzz_SlashAndCompensationClaimConserveEveryToken(uint96 rawDeposit, uint96 rawReserve, uint96 rawSlash)
        public
    {
        uint256 depositAmount = bound(uint256(rawDeposit), 1, MAX_FUZZ_AMOUNT);
        uint256 reserveAmount = bound(uint256(rawReserve), 1, depositAmount);
        uint256 slashAmount = bound(uint256(rawSlash), 1, reserveAmount);
        bytes32 intentHash = keccak256(abi.encode("slash", depositAmount, reserveAmount, slashAmount));

        _deposit(depositAmount);
        _reserve(intentHash, reserveAmount, uint64(block.timestamp + DAY));
        vm.prank(controller);
        vault.slashReservation(intentHash, maker, slashAmount);

        assertEq(vault.stakeBalance(staker), depositAmount - slashAmount);
        assertEq(vault.reservedStake(staker), reserveAmount - slashAmount);
        assertEq(vault.claimableCompensation(maker), slashAmount);
        assertEq(vault.totalLiabilities(), depositAmount);
        assertEq(token.balanceOf(address(vault)), depositAmount);

        uint256 makerBefore = token.balanceOf(maker);
        vm.prank(maker);
        vault.withdrawCompensation(maker);
        assertEq(token.balanceOf(maker) - makerBefore, slashAmount);
        assertEq(vault.totalLiabilities(), depositAmount - slashAmount);
        assertEq(token.balanceOf(address(vault)), depositAmount - slashAmount);
    }

    /// Risk: deferred fee rounding can create liabilities above backing or destroy gross settlement value.
    function testFuzz_DeferredMaturityConservesGrossAcrossNetStakeAndFees(
        uint96 rawGross,
        uint96 rawTotalFee,
        uint96 rawProtocolShare
    ) public {
        uint256 gross = bound(uint256(rawGross), 2, MAX_FUZZ_AMOUNT);
        uint256 totalFee = bound(uint256(rawTotalFee), 0, gross - 1);
        uint256 protocolShare = bound(uint256(rawProtocolShare), 0, totalFee);
        uint256 referralShare = totalFee - protocolShare;
        bytes32 intentHash = keccak256(abi.encode("deferred", gross, totalFee, protocolShare));
        uint64 releaseTime = uint64(block.timestamp + DAY);

        vm.prank(controller);
        vault.authorizeDeferredStake(intentHash, staker, releaseTime);
        token.transfer(address(vault), gross);
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, gross, releaseTime, _feePlan(protocolShare, referralShare));
        assertEq(vault.totalLiabilities(), gross);
        assertEq(token.balanceOf(address(vault)), gross);

        vm.warp(releaseTime);
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);
        assertEq(vault.stakeBalance(staker), gross - totalFee);
        assertEq(vault.reservedStake(staker), 0);
        assertEq(vault.claimableFees(recipient), protocolShare);
        assertEq(vault.claimableFees(maker), referralShare);
        assertEq(vault.totalClaimableFees(), totalFee);
        assertEq(vault.totalDeferredFees(), 0);
        assertEq(vault.totalLiabilities(), gross);
        assertEq(token.balanceOf(address(vault)), gross);
    }

    /// Risk: an exit could bypass active coverage and withdraw tokens still reserved for a maker.
    function testFuzz_FullExitCannotBypassReservation(uint96 rawDeposit, uint96 rawReserve) public {
        uint256 depositAmount = bound(uint256(rawDeposit), 1, MAX_FUZZ_AMOUNT);
        uint256 reserveAmount = bound(uint256(rawReserve), 1, depositAmount);
        bytes32 intentHash = keccak256(abi.encode("exit", depositAmount, reserveAmount));
        _deposit(depositAmount);
        _reserve(intentHash, reserveAmount, uint64(block.timestamp + DAY));

        vm.prank(staker);
        vault.requestExit();
        vm.warp(block.timestamp + EXIT_DELAY);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.ActiveReservations.selector, staker, reserveAmount));
        vm.prank(staker);
        vault.withdrawStake(staker);

        vm.prank(controller);
        vault.releaseReservation(intentHash);
        uint256 beforeBalance = token.balanceOf(staker);
        vm.prank(staker);
        vault.withdrawStake(staker);
        assertEq(token.balanceOf(staker) - beforeBalance, depositAmount);
        assertEq(vault.totalLiabilities(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    /// Risk: delegated use must never grant withdrawal ownership to the taker across arbitrary role addresses.
    function testFuzz_DelegationPreservesStakeOwnerWithdrawalRights(address delegatedTaker, uint96 rawAmount) public {
        vm.assume(delegatedTaker != address(0) && delegatedTaker != staker && delegatedTaker != address(vault));
        uint256 amount = bound(uint256(rawAmount), 1, MAX_FUZZ_AMOUNT);
        vm.startPrank(staker);
        vault.depositStakeFor(delegatedTaker, amount);
        vault.requestExit();
        vm.stopPrank();

        assertEq(vault.stakeOwnerOf(delegatedTaker), staker);
        assertEq(vault.stakeBalance(delegatedTaker), 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.NotExiting.selector, delegatedTaker));
        vm.prank(delegatedTaker);
        vault.withdrawStake(delegatedTaker);
        vm.warp(block.timestamp + EXIT_DELAY);
        uint256 beforeBalance = token.balanceOf(staker);
        vm.prank(staker);
        vault.withdrawStake(staker);
        assertEq(token.balanceOf(staker) - beforeBalance, amount);
    }
}
