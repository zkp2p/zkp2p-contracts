// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IOrchestratorV2 } from "../../contracts/interfaces/IOrchestratorV2.sol";
import { IPostIntentHookV2 } from "../../contracts/interfaces/IPostIntentHookV2.sol";
import { IReferralFee } from "../../contracts/interfaces/IReferralFee.sol";
import { OrchestratorV2LegacyTestBase } from "../helpers/OrchestratorV2LegacyTestBase.sol";

contract OrchestratorV2LegacyFulfillAndSignalTest is OrchestratorV2LegacyTestBase {
    event ReentrancyAttempted(bool success);

    function setUp() public {
        _setUpOrchestratorV2LegacyHarness();
    }

    function test_fulfillIntentRevertsWhenVerifierReleaseAmountIsBelowMinAtSignal() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));
        IOrchestratorV2.FulfillIntentParams memory params = _buildFulfillParams(intentHash, 5e6, intentHash);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.AmountBelowMin.selector, 5e6, 10e6));
        orchestrator.fulfillIntent(params);
    }

    function test_fulfillIntentRevertsWhenIntentDoesNotExist() public {
        bytes32 missingIntentHash = bytes32("missing");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.IntentNotFound.selector, missingIntentHash));
        orchestrator.fulfillIntent(_buildFulfillParams(missingIntentHash, 50e6, missingIntentHash));
    }

    function test_fulfillIntentRevertsWhenPaymentMethodIsRemovedAfterSignal() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        vm.prank(owner);
        paymentVerifierRegistry.removePaymentMethod(VENMO);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.PaymentMethodDoesNotExist.selector, VENMO));
        orchestrator.fulfillIntent(_buildFulfillParams(intentHash, 50e6, intentHash));
    }

    function test_fulfillIntentRevertsWhenVerifierMarksPaymentAsFailed() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));
        paymentVerifierMock.setShouldReturnFalse(true);

        vm.prank(owner);
        vm.expectRevert(IOrchestratorV2.PaymentVerificationFailed.selector);
        orchestrator.fulfillIntent(_buildFulfillParams(intentHash, 50e6, intentHash));
    }

    function test_fulfillIntentRevertsOnIntentHashMismatch() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));
        bytes32 otherIntentHash = bytes32("other-hash");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.HashMismatch.selector, intentHash, otherIntentHash));
        orchestrator.fulfillIntent(_buildFulfillParams(intentHash, 50e6, otherIntentHash));
    }

    function test_fulfillIntentRevertsWhenOrchestratorIsPaused() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        vm.prank(owner);
        orchestrator.pauseOrchestrator();

        vm.prank(owner);
        vm.expectRevert("Pausable: paused");
        orchestrator.fulfillIntent(_buildFulfillParams(intentHash, 50e6, intentHash));
    }

    function test_signalIntentRevertsWhenAccountAlreadyHasActiveIntent() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        bytes32 intentHash = _signalIntent(taker, params);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.AccountHasActiveIntent.selector, taker, intentHash));
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenEscrowIsNotWhitelisted() public {
        vm.prank(owner);
        escrowRegistry.removeEscrow(address(escrow));

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.EscrowNotWhitelisted.selector, address(escrow)));
        orchestrator.signalIntent(_buildSignalIntentParams(taker));
    }

    function test_signalIntentRevertsWhenOrchestratorIsPaused() public {
        vm.prank(owner);
        orchestrator.pauseOrchestrator();

        vm.prank(taker);
        vm.expectRevert("Pausable: paused");
        orchestrator.signalIntent(_buildSignalIntentParams(taker));
    }

    function test_signalIntentRevertsWhenRecipientIsZero() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.to = address(0);

        vm.prank(taker);
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenSingleReferralFeeExceedsMaximum() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = _singleReferralFee(referrer, 0.51e18);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.ReferralFeeExceedsMaximum.selector, 0.51e18, 0.5e18));
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenTotalReferralFeesExceedMaximum() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = _twoReferralFees(referrer, 0.3e18, other, 0.21e18);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.ReferralFeeExceedsMaximum.selector, 0.51e18, 0.5e18));
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenReferralFeeRecipientIsZero() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = _singleReferralFee(address(0), 0.001e18);

        vm.prank(taker);
        vm.expectRevert(IReferralFee.InvalidReferralFeeConfiguration.selector);
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenReferralFeeRecipientsContainDuplicates() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = _twoReferralFees(referrer, 0.002e18, referrer, 0.001e18);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.DuplicateReferralFeeRecipient.selector, referrer));
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenReferralFeeRecipientCountExceedsMaximum() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = _sixReferralFees();

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.ReferralFeeCountExceedsMaximum.selector, uint256(6), uint256(5)));
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenPaymentMethodIsRemovedFromRegistry() public {
        vm.prank(owner);
        paymentVerifierRegistry.removePaymentMethod(VENMO);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.PaymentMethodDoesNotExist.selector, VENMO));
        orchestrator.signalIntent(_buildSignalIntentParams(taker));
    }

    function test_signalIntentRevertsWhenPaymentMethodIsInactiveOnDeposit() public {
        vm.prank(depositor);
        escrow.setPaymentMethodActive(defaultDepositId, VENMO, false);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.PaymentMethodNotSupported.selector, VENMO));
        orchestrator.signalIntent(_buildSignalIntentParams(taker));
    }

    function test_signalIntentRevertsWhenCurrencyIsDisabledOnDeposit() public {
        vm.prank(depositor);
        escrow.deactivateCurrency(defaultDepositId, VENMO, USD);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.CurrencyNotSupported.selector, VENMO, USD));
        orchestrator.signalIntent(_buildSignalIntentParams(taker));
    }

    function test_signalIntentRevertsWhenPostIntentHookIsEoa() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.postIntentHook = IPostIntentHookV2(other);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.InvalidPostIntentHook.selector, other));
        orchestrator.signalIntent(params);
    }

    function test_fulfillIntentExecutesPostIntentHookFlow() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.postIntentHook = postIntentHookMock;
        params.data = abi.encode(other);
        bytes32 intentHash = _signalIntent(taker, params);

        uint256 targetBefore = usdc.balanceOf(other);

        vm.prank(owner);
        orchestrator.fulfillIntent(_buildFulfillParams(intentHash, 50e6, intentHash));

        assertGt(usdc.balanceOf(other), targetBefore);
    }

    function test_fulfillIntentRevertsWhenPostIntentHookPullsLessThanNetAmount() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.postIntentHook = partialPostIntentHookMock;
        params.data = abi.encode(other);
        bytes32 intentHash = _signalIntent(taker, params);

        vm.prank(owner);
        vm.expectRevert("PostIntentHook: must pull exact netAmount");
        orchestrator.fulfillIntent(_buildFulfillParams(intentHash, 50e6, intentHash));
    }

    function test_fulfillIntentRevertsWhenPostIntentHookIncreasesBalance() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.postIntentHook = pushPostIntentHookMock;
        params.data = abi.encode(other);
        bytes32 intentHash = _signalIntent(taker, params);

        vm.prank(owner);
        vm.expectRevert("PostIntentHook: unexpected balance increase");
        orchestrator.fulfillIntent(_buildFulfillParams(intentHash, 50e6, intentHash));
    }

    function test_fulfillIntentBlocksReentrantCallsFromPostIntentHook() public {
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.postIntentHook = reentrantPostIntentHook;
        bytes32 intentHash = _signalIntent(taker, params);
        IOrchestratorV2.FulfillIntentParams memory fulfillParams = _buildFulfillParams(intentHash, 50e6, intentHash);

        reentrantPostIntentHook.setFulfillParams(
            fulfillParams.paymentProof,
            fulfillParams.intentHash,
            fulfillParams.verificationData,
            fulfillParams.postIntentHookData
        );

        vm.expectEmit(false, false, false, true, address(reentrantPostIntentHook));
        emit ReentrancyAttempted(false);

        vm.prank(owner);
        orchestrator.fulfillIntent(fulfillParams);
    }

    function test_signalIntentAcceptsValidGatingServiceSignature() public {
        uint256 gatedDepositId = _createDeposit(gatingService);
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.depositId = gatedDepositId;
        params.signatureExpiration = block.timestamp + 1 hours;
        params.gatingServiceSignature = _signGatingSignature(params, GATING_SERVICE_KEY, taker);

        _signalIntent(taker, params);
    }

    function test_signalIntentRevertsWhenGatingServiceSignatureIsExpired() public {
        uint256 gatedDepositId = _createDeposit(gatingService);
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.depositId = gatedDepositId;
        params.signatureExpiration = block.timestamp - 1;
        params.gatingServiceSignature = _signGatingSignature(params, GATING_SERVICE_KEY, taker);

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(IOrchestratorV2.SignatureExpired.selector, block.timestamp - 1, block.timestamp)
        );
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenGatingServiceSignatureSignerIsInvalid() public {
        uint256 gatedDepositId = _createDeposit(gatingService);
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.depositId = gatedDepositId;
        params.signatureExpiration = block.timestamp + 1 hours;
        params.gatingServiceSignature = _signGatingSignature(params, ALT_SIGNER_KEY, taker);

        vm.prank(taker);
        vm.expectRevert(IOrchestratorV2.InvalidSignature.selector);
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenDifferentSenderReplaysValidGatingSignature() public {
        uint256 firstGatedDepositId = _createDeposit(gatingService);
        IOrchestratorV2.SignalIntentParams memory firstParams = _buildSignalIntentParams(taker);
        firstParams.depositId = firstGatedDepositId;
        firstParams.signatureExpiration = block.timestamp + 1 hours;
        firstParams.gatingServiceSignature = _signGatingSignature(firstParams, GATING_SERVICE_KEY, taker);
        _signalIntent(taker, firstParams);

        uint256 secondGatedDepositId = _createDeposit(gatingService);
        IOrchestratorV2.SignalIntentParams memory secondParams = _buildSignalIntentParams(taker);
        secondParams.depositId = secondGatedDepositId;
        secondParams.to = taker;
        secondParams.signatureExpiration = block.timestamp + 1 hours;
        secondParams.gatingServiceSignature = _signGatingSignature(secondParams, GATING_SERVICE_KEY, taker);

        vm.prank(other);
        vm.expectRevert(IOrchestratorV2.InvalidSignature.selector);
        orchestrator.signalIntent(secondParams);
    }
}
