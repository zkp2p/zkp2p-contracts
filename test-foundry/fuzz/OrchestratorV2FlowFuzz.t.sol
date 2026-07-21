// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV2LegacyFixture} from "../deterministic/helpers/OrchestratorV2LegacyFixture.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

/// @dev Properties exercise real EscrowV2/OrchestratorV2 settlement and add broad amount/fee/role coverage.
contract OrchestratorV2FlowFuzzTest is OrchestratorV2LegacyFixture {
    uint256 internal constant MAX_PROTOCOL_FEE = 5e16;
    uint256 internal constant MAX_REFERRAL_FEE = 5e17;
    uint256 internal constant DEPOSIT_AMOUNT = 500e6;
    uint256 internal constant MIN_INTENT = 10e6;
    uint256 internal constant MAX_INTENT = 200e6;

    function setUp() public override {
        super.setUp();
        verifier.setShouldVerifyPayment(true);
    }

    function _fees(bool enabled, uint256 fee) internal view returns (IReferralFee.ReferralFee[] memory fees) {
        fees = new IReferralFee.ReferralFee[](enabled ? 1 : 0);
        if (enabled) fees[0] = IReferralFee.ReferralFee({recipient: referrer, fee: fee});
    }

    /// Risk: rounding or fee composition can leak value or overdraw the recipient across valid protocol bounds.
    function testFuzz_FulfillmentConservesReleaseAcrossRecipientAndFees(
        uint96 rawAmount,
        uint96 rawRelease,
        uint64 rawProtocolFee,
        uint64 rawReferralFee,
        bool withReferral,
        bool throughHook
    ) public {
        uint256 amount = bound(uint256(rawAmount), MIN_INTENT, MAX_INTENT);
        uint256 releaseAmount = bound(uint256(rawRelease), MIN_INTENT, amount);
        uint256 protocolFee = bound(uint256(rawProtocolFee), 0, MAX_PROTOCOL_FEE);
        uint256 referralFee = bound(uint256(rawReferralFee), 1, MAX_REFERRAL_FEE);

        orchestrator.setProtocolFee(protocolFee);
        IOrchestratorV2.SignalIntentParams memory params = _params(
            depositId,
            taker,
            amount,
            CONVERSION_RATE,
            _fees(withReferral, referralFee),
            throughHook ? IPostIntentHookV2(address(postIntentHook)) : IPostIntentHookV2(address(0)),
            throughHook ? abi.encode(other) : bytes("")
        );
        bytes32 intentHash = _signal(taker, params);

        uint256 escrowBefore = token.balanceOf(address(escrow));
        uint256 recipientBefore = token.balanceOf(throughHook ? other : taker);
        uint256 protocolBefore = token.balanceOf(protocolFeeRecipient);
        uint256 referralBefore = token.balanceOf(referrer);

        _fulfill(intentHash, releaseAmount, CONVERSION_RATE);

        uint256 expectedProtocolFee = releaseAmount * protocolFee / 1e18;
        uint256 expectedReferralFee = withReferral ? releaseAmount * referralFee / 1e18 : 0;
        uint256 expectedRecipient = releaseAmount - expectedProtocolFee - expectedReferralFee;
        assertEq(token.balanceOf(throughHook ? other : taker) - recipientBefore, expectedRecipient);
        assertEq(token.balanceOf(protocolFeeRecipient) - protocolBefore, expectedProtocolFee);
        assertEq(token.balanceOf(referrer) - referralBefore, expectedReferralFee);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), releaseAmount);
        assertEq(expectedRecipient + expectedProtocolFee + expectedReferralFee, releaseAmount);

        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        assertEq(deposit.remainingDeposits, DEPOSIT_AMOUNT - releaseAmount);
        assertEq(deposit.outstandingIntentAmount, 0);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    /// Risk: cancellation by a wrong actor or incomplete cleanup can strand or duplicate locked liquidity.
    function testFuzz_CancellationRestoresExactLiquidityAndRejectsWrongActor(uint96 rawAmount, address attacker)
        public
    {
        uint256 amount = bound(uint256(rawAmount), MIN_INTENT, MAX_INTENT);
        vm.assume(attacker != address(0) && attacker != taker);
        IOrchestratorV2.SignalIntentParams memory params =
            _params(depositId, taker, amount, CONVERSION_RATE, _emptyReferralFees(), IPostIntentHookV2(address(0)), "");
        bytes32 intentHash = _signal(taker, params);

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.UnauthorizedCaller.selector, attacker, taker));
        vm.prank(attacker);
        orchestrator.cancelIntent(intentHash);

        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        assertEq(deposit.remainingDeposits, DEPOSIT_AMOUNT);
        assertEq(deposit.outstandingIntentAmount, 0);
        assertEq(escrow.getDepositIntentHashes(depositId).length, 0);
        assertEq(orchestrator.getAccountIntents(taker).length, 0);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    /// Risk: amount bounds might diverge between Orchestrator and Escrow and admit unusable intents.
    function testFuzz_SignalRejectsEveryOutOfRangeAmount(uint96 rawAmount, bool belowMinimum) public {
        uint256 amount = belowMinimum
            ? bound(uint256(rawAmount), 0, MIN_INTENT - 1)
            : bound(uint256(rawAmount), MAX_INTENT + 1, type(uint96).max);
        IOrchestratorV2.SignalIntentParams memory params =
            _params(depositId, taker, amount, CONVERSION_RATE, _emptyReferralFees(), IPostIntentHookV2(address(0)), "");
        if (belowMinimum) {
            vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.AmountBelowMin.selector, amount, MIN_INTENT));
        } else {
            vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.AmountAboveMax.selector, amount, MAX_INTENT));
        }
        _signalCall(taker, params);
    }

    /// Risk: expired locks can leave account and deposit indexes inconsistent during automatic reclamation.
    function testFuzz_ExpiredIntentReclamationPreservesLifecycleIndexes(uint96 firstRaw, uint96 secondRaw) public {
        uint256 firstAmount = bound(uint256(firstRaw), MIN_INTENT, MAX_INTENT);
        uint256 secondAmount = bound(uint256(secondRaw), MIN_INTENT, MAX_INTENT);
        uint256 targetLiquidity = firstAmount > secondAmount ? firstAmount : secondAmount;
        vm.prank(depositor);
        escrow.removeFunds(depositId, DEPOSIT_AMOUNT - targetLiquidity);
        bytes32 firstIntent = _signal(
            taker,
            _params(
                depositId, taker, firstAmount, CONVERSION_RATE, _emptyReferralFees(), IPostIntentHookV2(address(0)), ""
            )
        );
        vm.warp(block.timestamp + escrow.intentExpirationPeriod() + 1);
        bytes32 secondIntent = _signal(
            other,
            _params(
                depositId, other, secondAmount, CONVERSION_RATE, _emptyReferralFees(), IPostIntentHookV2(address(0)), ""
            )
        );

        assertEq(orchestrator.getIntent(firstIntent).owner, address(0));
        assertEq(orchestrator.getAccountIntents(taker).length, 0);
        assertEq(orchestrator.getIntent(secondIntent).owner, other);
        assertEq(orchestrator.getAccountIntents(other).length, 1);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        assertEq(deposit.remainingDeposits, targetLiquidity - secondAmount);
        assertEq(deposit.outstandingIntentAmount, secondAmount);
        assertEq(escrow.getDepositIntentHashes(depositId).length, 1);
    }
}
