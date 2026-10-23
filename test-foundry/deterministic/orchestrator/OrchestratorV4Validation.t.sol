// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IIntentSignalPolicy} from "contracts/interfaces/IIntentSignalPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {SignalPolicyMock} from "../../mocks/SignalPolicyMock.sol";

contract OrchestratorV4ValidationTest is OrchestratorV4Fixture {
    function test_SignalRejectsZeroRecipient() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.to = address(0);
        vm.expectRevert(IOrchestratorV4.ZeroAddress.selector);
        _signalCall(taker, params);
    }



    function test_SignalRejectsUnwhitelistedEscrow() public {
        escrowRegistry.removeEscrow(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.EscrowNotWhitelisted.selector, address(escrow)));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalRejectsRemovedPaymentMethod() public {
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.PaymentMethodDoesNotExist.selector, METHOD));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalRejectsInactiveDepositPaymentMethod() public {
        vm.prank(depositor);
        escrow.setPaymentMethodActive(depositId, METHOD, false);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.PaymentMethodNotSupported.selector, METHOD));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalRejectsDisabledDepositCurrency() public {
        vm.prank(depositor);
        escrow.deactivateCurrency(depositId, METHOD, USD);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.CurrencyNotSupported.selector, METHOD, USD));
        _signalCall(taker, _defaultParams());
    }

    function _useSignalPolicyMock() internal returns (SignalPolicyMock mock) {
        mock = new SignalPolicyMock();
        orchestrator.setSignalPolicy(mock);
    }

    function test_SignalForwardsTakerAndParamsToSignalPolicy() public {
        SignalPolicyMock mock = _useSignalPolicyMock();
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.gatingServiceSignature = hex"5167";
        params.payerCommitment = "payer";
        bytes32 id = _intentHash(orchestrator.intentCounter());
        _signalRaw(taker, params);
        assertEq(mock.signalCalls(), 1);
        assertEq(mock.lastTaker(), taker);
        assertEq(mock.lastParams(), abi.encode(params));
        assertEq(orchestrator.getIntent(id).payerCommitment, "payer");
    }

    function test_SignalStoresTheAdmissionTheSignalPolicyReturns() public {
        SignalPolicyMock mock = _useSignalPolicyMock();
        mock.setAdmission(true, other);
        bytes32 id = _signalDefault();
        assertTrue(orchestrator.getIntent(id).takerWhitelisted);
        assertEq(orchestrator.getIntent(id).arbitrator, other);
    }

    function test_SignalRejectedBySignalPolicy() public {
        _useSignalPolicyMock().setRevertOnSignal(true);
        vm.expectRevert("signal rejected");
        _signalCall(taker, _defaultParams());
    }

    function test_ZeroSignalPolicySkipsSignalChecks() public {
        _whitelist(other);
        orchestrator.setSignalPolicy(IIntentSignalPolicy(address(0)));
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.payerCommitment = "payer";
        bytes32 id = _intentHash(orchestrator.intentCounter());
        _signalRaw(taker, params);
        IOrchestratorV4.Intent memory intent = orchestrator.getIntent(id);
        assertEq(intent.payerCommitment, "payer");
        assertFalse(intent.takerWhitelisted);
        assertEq(intent.arbitrator, address(0));
    }

    function test_FulfillRejectsMissingIntent() public {
        bytes32 missing = bytes32("missing");
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.IntentNotFound.selector, missing));
        _fulfill(missing, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_FulfillRejectsPaymentMethodRemovedAfterSignal() public {
        bytes32 intentHash = _signalDefault();
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.PaymentMethodDoesNotExist.selector, METHOD));
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_FulfillRejectsFailedPaymentVerification() public {
        bytes32 intentHash = _signalDefault();
        verifier.setShouldReturnFalse(true);
        vm.expectRevert(IOrchestratorV4.PaymentVerificationFailed.selector);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_FulfillRejectsVerifierIntentHashMismatch() public {
        bytes32 intentHash = _signalDefault();
        bytes32 mismatchedHash = bytes32("other-hash");
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.HashMismatch.selector, intentHash, mismatchedHash));
        orchestrator.fulfillIntent(
            IOrchestratorV4.FulfillIntentParams({
                paymentProof: _paymentProof(mismatchedHash, INTENT_AMOUNT, CONVERSION_RATE),
                intentHash: intentHash,
                verificationData: ""
            })
        );
    }

    function test_CancelIntentRejectsNonOwner() public {
        bytes32 intentHash = _signalDefault();
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.UnauthorizedCaller.selector, other, taker));
        vm.prank(other);
        orchestrator.cancelIntent(intentHash);
    }

    function test_ManualReleaseRejectsCallerOtherThanDepositor() public {
        bytes32 intentHash = _signalDefault();
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        orchestrator.releaseFundsToPayer(intentHash, INTENT_AMOUNT);
    }

    function test_CancelIntentRejectsMissingIntent() public {
        bytes32 missing = bytes32("missing");
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.IntentNotFound.selector, missing));
        vm.prank(taker);
        orchestrator.cancelIntent(missing);
    }

    function test_ManualReleaseRejectsMissingIntent() public {
        bytes32 missing = bytes32("missing");
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.IntentNotFound.selector, missing));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(missing, INTENT_AMOUNT);
    }
    function test_SignalRejectsRateBelowMinimum() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.conversionRate = CONVERSION_RATE - 1;
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.RateBelowMinimum.selector, params.conversionRate, CONVERSION_RATE));
        _signalCall(taker, params);
    }

    function test_SignalRejectsManagerFeeAboveMaximum() public {
        vm.mockCall(address(escrow), abi.encodeWithSignature("getManagerFee(uint256)", depositId), abi.encode(other, 6e16));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.FeeExceedsMaximum.selector, 6e16, 5e16));
        _signalCall(taker, _defaultParams());
    }
}
