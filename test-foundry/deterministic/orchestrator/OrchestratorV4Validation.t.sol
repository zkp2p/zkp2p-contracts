// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract OrchestratorV4ValidationTest is OrchestratorV4Fixture {
    function test_AccountWithActiveIntentRevertsWhenMultipleIntentsDisabled() public virtual {
        orchestrator.setAllowMultipleIntents(false);
        bytes32 first = _signalDefault();
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.AccountHasActiveIntent.selector, taker, first));
        _signalCall(taker, _defaultParams());
    }

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

    function _newGatedDeposit() internal returns (uint256 gatedDepositId) {
        vm.startPrank(depositor);
        gatedDepositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
    }

    function test_SignalWithGatingSignature() public {
        uint256 gatedDepositId = _newGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, block.timestamp + 1 days);
        assertNotEq(_signal(taker, params), bytes32(0));
    }

    function test_GatingRejectsExpiredSignature() public {
        vm.warp(100);
        uint256 gatedDepositId = _newGatedDeposit();
        uint256 expiration = block.timestamp - 1;
        IOrchestratorV4.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, expiration);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.SignatureExpired.selector, expiration, block.timestamp));
        _signalCall(taker, params);
    }

    function test_GatingRejectsSignatureFromWrongSigner() public {
        uint256 gatedDepositId = _newGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, 0xBAD, taker, block.timestamp + 1 days);
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        _signalCall(taker, params);
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
        orchestrator.releaseFundsToPayer(intentHash);
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
        orchestrator.releaseFundsToPayer(missing);
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
