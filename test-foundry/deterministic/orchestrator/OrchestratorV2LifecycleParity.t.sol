// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV2LegacyFixture} from "../helpers/OrchestratorV2LegacyFixture.sol";
import {ReentrantReleaseEscrowMock} from "contracts/mocks/ReentrantReleaseEscrowMock.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

contract OrchestratorV2LifecycleParityTest is OrchestratorV2LegacyFixture {
    event IntentPruned(bytes32 indexed intentHash);
    event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool manual);
    event ReentryAttempted(bool success);

    function _oneReferral(address recipient, uint256 fee)
        internal
        pure
        returns (IReferralFee.ReferralFee[] memory fees)
    {
        fees = new IReferralFee.ReferralFee[](1);
        fees[0] = IReferralFee.ReferralFee({recipient: recipient, fee: fee});
    }

    function test_CancelIntentPrunesAndUnlocksFunds() public {
        bytes32 intentHash = _signalDefault();
        vm.expectEmit(true, false, false, false, address(orchestrator));
        emit IntentPruned(intentHash);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
        assertEq(escrow.getDeposit(0).remainingDeposits, 500e6);
    }

    function test_CancelIntentRejectsMissingIntent() public {
        bytes32 missing = bytes32("missing");
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.IntentNotFound.selector, missing));
        vm.prank(taker);
        orchestrator.cancelIntent(missing);
    }

    function test_CancelIntentRejectsNonOwner() public {
        bytes32 intentHash = _signalDefault();
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.UnauthorizedCaller.selector, other, taker));
        vm.prank(other);
        orchestrator.cancelIntent(intentHash);
    }

    function test_ManualReleaseTransfersFundsToTakerAndEmits() public {
        bytes32 intentHash = _signalDefault();
        uint256 takerBefore = token.balanceOf(taker);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(intentHash, taker, INTENT_AMOUNT, true);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(token.balanceOf(taker) - takerBefore, INTENT_AMOUNT);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_ManualReleaseAppliesProtocolAndReferralFees() public {
        orchestrator.setProtocolFee(1e16);
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _oneReferral(referrer, 5e15);
        bytes32 intentHash = _signal(taker, params);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(token.balanceOf(protocolFeeRecipient), 500_000);
        assertEq(token.balanceOf(referrer), 250_000);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT - 750_000);
    }

    function test_ManualReleaseSplitsMultipleReferralFeesExactly() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        bytes32 intentHash = _signal(taker, params);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(token.balanceOf(referrer), 150_000);
        assertEq(token.balanceOf(other), 100_000);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT - 250_000);
    }

    function test_ManualReleaseRejectsMissingIntent() public {
        bytes32 missing = bytes32("missing");
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.IntentNotFound.selector, missing));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(missing);
    }

    function test_ManualReleaseRejectsCallerOtherThanDepositor() public {
        bytes32 intentHash = _signalDefault();
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        orchestrator.releaseFundsToPayer(intentHash);
    }

    function test_ManualReleaseBlocksEscrowTriggeredReentry() public {
        ReentrantReleaseEscrowMock reentrantEscrow =
            new ReentrantReleaseEscrowMock(address(token), address(orchestrator), depositor, PAYEE);
        escrowRegistry.addEscrow(address(reentrantEscrow));
        token.transfer(address(reentrantEscrow), 100e6);
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.escrow = address(reentrantEscrow);
        params.depositId = 0;
        bytes32 intentHash = _signal(taker, params);
        reentrantEscrow.setReentryIntent(intentHash, true);
        vm.expectEmit(false, false, false, true, address(reentrantEscrow));
        emit ReentryAttempted(false);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_FulfillRejectsReleaseAmountBelowSignalMinimum() public {
        bytes32 intentHash = _signalDefault();
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.AmountBelowMin.selector, 5e6, 10e6));
        _fulfill(intentHash, 5e6, CONVERSION_RATE);
    }

    function test_FulfillWithZeroProtocolFeeTransfersEntireRelease() public {
        bytes32 intentHash = _signalDefault();
        uint256 beforeBalance = token.balanceOf(taker);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(taker) - beforeBalance, INTENT_AMOUNT);
        assertEq(token.balanceOf(protocolFeeRecipient), 0);
    }

    function test_FulfillRejectsMissingIntent() public {
        bytes32 missing = bytes32("missing");
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.IntentNotFound.selector, missing));
        _fulfill(missing, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_FulfillRejectsPaymentMethodRemovedAfterSignal() public {
        bytes32 intentHash = _signalDefault();
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.PaymentMethodDoesNotExist.selector, METHOD));
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_FulfillRejectsFailedPaymentVerification() public {
        bytes32 intentHash = _signalDefault();
        verifier.setShouldReturnFalse(true);
        vm.expectRevert(IOrchestratorV2.PaymentVerificationFailed.selector);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_FulfillRejectsVerifierIntentHashMismatch() public {
        bytes32 intentHash = _signalDefault();
        bytes32 mismatchedHash = bytes32("other-hash");
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.HashMismatch.selector, intentHash, mismatchedHash));
        orchestrator.fulfillIntent(
            IOrchestratorV2.FulfillIntentParams({
                paymentProof: _paymentProof(mismatchedHash, INTENT_AMOUNT, CONVERSION_RATE),
                intentHash: intentHash,
                verificationData: "",
                postIntentHookData: ""
            })
        );
    }

    function test_FulfillRejectsWhilePaused() public {
        bytes32 intentHash = _signalDefault();
        orchestrator.pauseOrchestrator();
        vm.expectRevert(bytes("Pausable: paused"));
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_EscrowPrunesExpiredIntentFromOrchestrator() public {
        bytes32 intentHash = _signalDefault();
        vm.warp(block.timestamp + 3601);
        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_AnyoneCleansUpIntentOrphanedByEscrow() public {
        bytes32 intentHash = _signalDefault();
        bytes32 storageSlot = keccak256(abi.encode(intentHash, uint256(15)));
        vm.store(address(escrow), storageSlot, bytes32(0));
        vm.warp(block.timestamp + 3601);
        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = intentHash;
        vm.prank(other);
        orchestrator.cleanupOrphanedIntents(hashes);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_OrphanCleanupSkipsUnknownIntent() public {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = bytes32("unknown-intent");
        orchestrator.cleanupOrphanedIntents(hashes);
    }

    function test_OrphanCleanupPreservesActiveEscrowIntent() public {
        bytes32 intentHash = _signalDefault();
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = intentHash;
        orchestrator.cleanupOrphanedIntents(hashes);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
    }

    function test_PruneIntentsIgnoresZeroAndNonEscrowCaller() public {
        bytes32 intentHash = _signalDefault();
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = bytes32(0);
        hashes[1] = intentHash;
        vm.prank(other);
        orchestrator.pruneIntents(hashes);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
    }
}
