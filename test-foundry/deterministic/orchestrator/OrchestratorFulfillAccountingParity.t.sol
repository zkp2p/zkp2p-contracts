// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";

contract OrchestratorFulfillAccountingParityTest is OrchestratorLegacyFixture {
    event IntentFulfilled(
        bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease
    );
    event DepositClosed(uint256 depositId, address depositor);

    uint256 internal constant RELEASE_AMOUNT = 46_296_296;
    uint256 internal constant PROTOCOL_FEE = 925_925;
    uint256 internal constant REFERRER_FEE = 462_962;

    bytes32 internal subjectIntent;

    function setUp() public override {
        super.setUp();
        vm.prank(offRamper);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.08e18);
        subjectIntent = _signalStandardIntent(address(0), 0);
        verifier.setShouldVerifyPayment(true);
    }

    function _signalStandardIntent(address referrer, uint256 referrerFee) internal returns (bytes32 intentHash) {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.to = onRamper;
        params.conversionRate = 1.08e18;
        params.referrer = referrer;
        params.referrerFee = referrerFee;
        params.gatingServiceSignature = _resign(params);
        intentHash = _signal(onRamper, params);
    }

    function _proof(bytes32 paymentIntent, uint256 fiatAmount) internal view returns (bytes memory) {
        return abi.encode(fiatAmount, block.timestamp, PAYEE, USD, paymentIntent);
    }

    function _fulfill(bytes32 intentHash, bytes memory proof) internal {
        vm.prank(onRamper);
        orchestrator.fulfillIntent(
            IOrchestrator.FulfillIntentParams({
                paymentProof: proof, intentHash: intentHash, verificationData: "", postIntentHookData: ""
            })
        );
    }

    function _prepareClosingFulfillment() internal returns (bytes32 closingIntent) {
        _fulfill(subjectIntent, _proof(subjectIntent, 60e6));
        closingIntent = _signalStandardIntent(address(0), 0);
    }

    function _replaceWithReferrer() internal returns (bytes32 referrerIntent) {
        vm.prank(onRamper);
        orchestrator.cancelIntent(subjectIntent);
        referrerIntent = _signalStandardIntent(receiver, 0.01e18);
        subjectIntent = referrerIntent;
    }

    function test_FulfillIntentClosesFullyConsumedDeposit() public {
        bytes32 closingIntent = _prepareClosingFulfillment();
        _fulfill(closingIntent, _proof(closingIntent, 60e6));
        assertEq(escrow.getDeposit(0).depositor, address(0));
    }

    function test_FulfillIntentCloseDeletesPaymentMethodData() public {
        bytes32 closingIntent = _prepareClosingFulfillment();
        _fulfill(closingIntent, _proof(closingIntent, 60e6));
        assertEq(escrow.getDepositPaymentMethodData(0, VENMO).intentGatingService, address(0));
    }

    function test_FulfillIntentCloseDeletesCurrencyRate() public {
        bytes32 closingIntent = _prepareClosingFulfillment();
        _fulfill(closingIntent, _proof(closingIntent, 60e6));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_FulfillIntentCloseEmitsDepositClosed() public {
        bytes32 closingIntent = _prepareClosingFulfillment();
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(0, offRamper);
        _fulfill(closingIntent, _proof(closingIntent, 60e6));
    }

    function test_FulfillIntentProtocolFeeTransfersNetAndFee() public {
        orchestrator.setProtocolFee(0.02e18);
        uint256 takerBefore = token.balanceOf(onRamper);
        uint256 feeBefore = token.balanceOf(feeRecipient);
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
        assertEq(token.balanceOf(onRamper) - takerBefore, RELEASE_AMOUNT - PROTOCOL_FEE);
        assertEq(token.balanceOf(feeRecipient) - feeBefore, PROTOCOL_FEE);
    }

    function test_FulfillIntentProtocolFeeEmitsNetAmount() public {
        orchestrator.setProtocolFee(0.02e18);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, onRamper, RELEASE_AMOUNT - PROTOCOL_FEE, false);
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
    }

    function test_FulfillIntentReferrerFeeTransfersNetAndFee() public {
        bytes32 referrerIntent = _replaceWithReferrer();
        uint256 takerBefore = token.balanceOf(onRamper);
        uint256 referrerBefore = token.balanceOf(receiver);
        _fulfill(referrerIntent, _proof(referrerIntent, 50e6));
        assertEq(token.balanceOf(onRamper) - takerBefore, RELEASE_AMOUNT - REFERRER_FEE);
        assertEq(token.balanceOf(receiver) - referrerBefore, REFERRER_FEE);
    }

    function test_FulfillIntentReferrerFeeEmitsNetAmount() public {
        bytes32 referrerIntent = _replaceWithReferrer();
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(referrerIntent, onRamper, RELEASE_AMOUNT - REFERRER_FEE, false);
        _fulfill(referrerIntent, _proof(referrerIntent, 50e6));
    }

    function test_FulfillIntentCombinedFeesTransferEveryShare() public {
        bytes32 referrerIntent = _replaceWithReferrer();
        orchestrator.setProtocolFee(0.02e18);
        uint256 takerBefore = token.balanceOf(onRamper);
        uint256 feeBefore = token.balanceOf(feeRecipient);
        uint256 referrerBefore = token.balanceOf(receiver);
        _fulfill(referrerIntent, _proof(referrerIntent, 50e6));
        assertEq(token.balanceOf(onRamper) - takerBefore, RELEASE_AMOUNT - PROTOCOL_FEE - REFERRER_FEE);
        assertEq(token.balanceOf(feeRecipient) - feeBefore, PROTOCOL_FEE);
        assertEq(token.balanceOf(receiver) - referrerBefore, REFERRER_FEE);
    }

    function test_FulfillIntentCombinedFeesEmitNetAmount() public {
        bytes32 referrerIntent = _replaceWithReferrer();
        orchestrator.setProtocolFee(0.02e18);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(referrerIntent, onRamper, RELEASE_AMOUNT - PROTOCOL_FEE - REFERRER_FEE, false);
        _fulfill(referrerIntent, _proof(referrerIntent, 50e6));
    }

    function test_FulfillIntentRejectsMissingIntent() public {
        bytes32 missingIntent = keccak256("invalid");
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.IntentNotFound.selector, missingIntent));
        _fulfill(missingIntent, _proof(missingIntent, 50e6));
    }

    function test_FulfillIntentRejectsVerifierHashMismatch() public {
        verifier.setShouldVerifyPayment(false);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.HashMismatch.selector, subjectIntent, bytes32(0)));
        _fulfill(subjectIntent, _proof(bytes32(0), 50e6));
    }

    function test_FulfillIntentRejectsMethodRemovedAfterSignal() public {
        paymentVerifierRegistry.removePaymentMethod(VENMO);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.PaymentMethodDoesNotExist.selector, VENMO));
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
    }

    function test_FulfillIntentRejectsFailedPaymentVerification() public {
        verifier.setShouldReturnFalse(true);
        vm.expectRevert(IOrchestrator.PaymentVerificationFailed.selector);
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
    }

    function test_FulfillIntentRejectsWhilePaused() public {
        orchestrator.pauseOrchestrator();
        vm.expectRevert("Pausable: paused");
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
    }

    function test_FulfillIntentSucceedsAfterUnpause() public {
        orchestrator.pauseOrchestrator();
        orchestrator.unpauseOrchestrator();
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
        assertEq(orchestrator.getIntent(subjectIntent).owner, address(0));
    }
}
