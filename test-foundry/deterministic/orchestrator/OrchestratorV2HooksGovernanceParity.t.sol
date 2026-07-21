// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV2LegacyFixture} from "../helpers/OrchestratorV2LegacyFixture.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";
import {ReentrantHookSetterMock} from "contracts/mocks/ReentrantHookSetterMock.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IPreIntentHook} from "contracts/interfaces/IPreIntentHook.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

contract OrchestratorV2HooksGovernanceParityTest is OrchestratorV2LegacyFixture {
    event DepositPreIntentHookSet(
        address indexed escrow, uint256 indexed depositId, address indexed hook, address setter
    );
    event DepositWhitelistHookSet(
        address indexed escrow, uint256 indexed depositId, address indexed hook, address setter
    );
    event EscrowRegistryUpdated(address indexed registry);
    event RelayerRegistryUpdated(address indexed registry);
    event AllowMultipleIntentsUpdated(bool allowMultiple);
    event ProtocolFeeUpdated(uint256 fee);
    event ProtocolFeeRecipientUpdated(address indexed recipient);
    event IntentReferralFeeDistributed(bytes32 indexed intentHash, address indexed recipient, uint256 amount);
    event ReentrancyAttempted(bool success);

    function test_DepositorSetsPreIntentHookAndEmits() public {
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositPreIntentHookSet(address(escrow), depositId, address(preIntentHook), depositor);
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
    }

    function test_DepositorSetsWhitelistHookAndEmits() public {
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositWhitelistHookSet(address(escrow), depositId, address(whitelistHook), depositor);
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), depositId, whitelistHook);
    }

    function test_SetDepositWhitelistHookRejectsWhenReentrancyGuardIsEntered() public {
        vm.store(address(orchestrator), bytes32(uint256(1)), bytes32(uint256(2)));
        vm.expectRevert("ReentrancyGuard: reentrant call");
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), depositId, whitelistHook);
    }

    function test_HookSetterRejectsUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(IOrchestratorV2.UnauthorizedCallerOrDelegate.selector, other, depositor, delegate)
        );
        vm.prank(other);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
    }

    function test_HookSetterRejectsZeroEscrow() public {
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(0), depositId, preIntentHook);
    }

    function test_HookSetterRejectsEoaHook() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.InvalidPreIntentHook.selector, other));
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, IPreIntentHook(other));
    }

    function test_SignalExecutesBothHooksWithReferralFeeContext() public {
        vm.startPrank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
        orchestrator.setDepositWhitelistHook(address(escrow), depositId, whitelistHook);
        vm.stopPrank();
        IReferralFee.ReferralFee[] memory fees = _twoReferralFees();
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = fees;
        _signal(taker, params);
        assertEq(preIntentHook.callCount(), 1);
        assertEq(whitelistHook.callCount(), 1);
        assertEq(preIntentHook.lastReferralFeesCount(), 2);
        assertEq(whitelistHook.lastReferralFeesCount(), 2);
        assertEq(preIntentHook.lastReferralFeesHash(), _referralHash(fees));
        assertEq(whitelistHook.lastReferralFeesHash(), _referralHash(fees));
    }

    function test_HookGettersExposeIndependentConfiguredHooks() public {
        vm.startPrank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
        orchestrator.setDepositWhitelistHook(address(escrow), depositId, whitelistHook);
        vm.stopPrank();
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), depositId)), address(preIntentHook));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), depositId)), address(whitelistHook));
    }

    function test_PreIntentHookCannotReenterHookSetter() public {
        ReentrantHookSetterMock reentrantSetter = new ReentrantHookSetterMock(address(orchestrator));
        reentrantSetter.setReplacementHook(preIntentHook);
        vm.startPrank(depositor);
        uint256 hookDepositId = _createDeposit(address(0), address(reentrantSetter));
        orchestrator.setDepositPreIntentHook(address(escrow), hookDepositId, reentrantSetter);
        vm.stopPrank();
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.depositId = hookDepositId;
        _signal(taker, params);
        assertTrue(reentrantSetter.reentryAttempted());
        assertFalse(reentrantSetter.reentrySucceeded());
        assertEq(
            address(orchestrator.getDepositPreIntentHook(address(escrow), hookDepositId)), address(reentrantSetter)
        );
    }

    function test_GovernanceUpdatesRegistriesFeesAndPauseState() public virtual {
        EscrowRegistry newRegistry = new EscrowRegistry();
        RelayerRegistry newRelayerRegistry = new RelayerRegistry();
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit EscrowRegistryUpdated(address(newRegistry));
        orchestrator.setEscrowRegistry(address(newRegistry));
        vm.expectEmit(false, false, false, true, address(orchestrator));
        emit ProtocolFeeUpdated(1e16);
        orchestrator.setProtocolFee(1e16);
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit ProtocolFeeRecipientUpdated(other);
        orchestrator.setProtocolFeeRecipient(other);
        vm.expectEmit(false, false, false, true, address(orchestrator));
        emit AllowMultipleIntentsUpdated(false);
        orchestrator.setAllowMultipleIntents(false);
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit RelayerRegistryUpdated(address(newRelayerRegistry));
        orchestrator.setRelayerRegistry(address(newRelayerRegistry));
        assertEq(address(orchestrator.relayerRegistry()), address(newRelayerRegistry));
        assertFalse(orchestrator.allowMultipleIntents());
        orchestrator.pauseOrchestrator();
        assertTrue(orchestrator.paused());
        orchestrator.unpauseOrchestrator();
        assertFalse(orchestrator.paused());
    }

    function test_GovernanceRejectsInvalidSetterValues() public virtual {
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.setEscrowRegistry(address(0));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.FeeExceedsMaximum.selector, 6e16, 5e16));
        orchestrator.setProtocolFee(6e16);
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.setProtocolFeeRecipient(address(0));
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.setRelayerRegistry(address(0));
    }

    function test_GovernanceRejectsEveryNonOwnerCall() public virtual {
        vm.startPrank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.pauseOrchestrator();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.unpauseOrchestrator();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setEscrowRegistry(address(escrowRegistry));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setProtocolFee(1e16);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setProtocolFeeRecipient(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setAllowMultipleIntents(false);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setRelayerRegistry(address(relayerRegistry));
        vm.stopPrank();
    }

    function test_ViewsReturnAccountIntentsAndSignalMinimumSnapshot() public {
        bytes32 intentHash = _signalDefault();
        bytes32[] memory accountIntents = orchestrator.getAccountIntents(taker);
        assertEq(accountIntents.length, 1);
        assertEq(accountIntents[0], intentHash);
        assertEq(orchestrator.getIntentMinAtSignal(intentHash), 10e6);
    }

    function test_AccountWithActiveIntentRevertsWhenMultipleIntentsDisabled() public virtual {
        orchestrator.setAllowMultipleIntents(false);
        bytes32 first = _signalDefault();
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.AccountHasActiveIntent.selector, taker, first));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalRejectsUnwhitelistedEscrow() public {
        escrowRegistry.removeEscrow(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.EscrowNotWhitelisted.selector, address(escrow)));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalAcceptsUnlistedEscrowWhenRegistryAcceptsAll() public {
        escrowRegistry.removeEscrow(address(escrow));
        escrowRegistry.setAcceptAllEscrows(true);
        assertNotEq(_signal(taker, _defaultParams()), bytes32(0));
    }

    function test_SignalRejectsWhilePaused() public {
        orchestrator.pauseOrchestrator();
        vm.expectRevert(bytes("Pausable: paused"));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalRejectsZeroRecipient() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.to = address(0);
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        _signalCall(taker, params);
    }

    function test_SignalRejectsSingleReferralFeeAboveMaximum() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = new IReferralFee.ReferralFee[](1);
        params.referralFees[0] = IReferralFee.ReferralFee({recipient: referrer, fee: 51e16});
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.ReferralFeeExceedsMaximum.selector, 51e16, 50e16));
        _signalCall(taker, params);
    }

    function test_SignalRejectsTotalReferralFeesAboveMaximum() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = new IReferralFee.ReferralFee[](2);
        params.referralFees[0] = IReferralFee.ReferralFee({recipient: referrer, fee: 30e16});
        params.referralFees[1] = IReferralFee.ReferralFee({recipient: other, fee: 21e16});
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.ReferralFeeExceedsMaximum.selector, 51e16, 50e16));
        _signalCall(taker, params);
    }

    function test_SignalRejectsZeroReferralRecipientWithNonzeroFee() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = new IReferralFee.ReferralFee[](1);
        params.referralFees[0] = IReferralFee.ReferralFee({recipient: address(0), fee: 1e15});
        vm.expectRevert(IReferralFee.InvalidReferralFeeConfiguration.selector);
        _signalCall(taker, params);
    }

    function test_SignalRejectsReferralRecipientWithZeroFee() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = new IReferralFee.ReferralFee[](1);
        params.referralFees[0] = IReferralFee.ReferralFee({recipient: referrer, fee: 0});
        vm.expectRevert(IReferralFee.InvalidReferralFeeConfiguration.selector);
        _signalCall(taker, params);
    }

    function test_SignalRejectsDuplicateReferralRecipients() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = new IReferralFee.ReferralFee[](2);
        params.referralFees[0] = IReferralFee.ReferralFee({recipient: referrer, fee: 2e15});
        params.referralFees[1] = IReferralFee.ReferralFee({recipient: referrer, fee: 1e15});
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.DuplicateReferralFeeRecipient.selector, referrer));
        _signalCall(taker, params);
    }

    function test_SignalRejectsMoreThanTenReferralRecipients() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = new IReferralFee.ReferralFee[](11);
        for (uint256 i; i < 11; ++i) {
            params.referralFees[i] = IReferralFee.ReferralFee({recipient: address(uint160(i + 1)), fee: 1e15});
        }
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.ReferralFeeCountExceedsMaximum.selector, 11, 10));
        _signalCall(taker, params);
    }

    function test_ManualReleaseEmitsDistributionForEveryReferralRecipient() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        bytes32 intentHash = _signal(taker, params);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentReferralFeeDistributed(intentHash, referrer, 150_000);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentReferralFeeDistributed(intentHash, other, 100_000);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
    }

    function test_SignalRejectsRemovedPaymentMethod() public {
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.PaymentMethodDoesNotExist.selector, METHOD));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalRejectsInactiveDepositPaymentMethod() public {
        vm.prank(depositor);
        escrow.setPaymentMethodActive(depositId, METHOD, false);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.PaymentMethodNotSupported.selector, METHOD));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalRejectsDisabledDepositCurrency() public {
        vm.prank(depositor);
        escrow.deactivateCurrency(depositId, METHOD, USD);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.CurrencyNotSupported.selector, METHOD, USD));
        _signalCall(taker, _defaultParams());
    }

    function test_SignalRejectsEoaPostIntentHook() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = IPostIntentHookV2(other);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.InvalidPostIntentHook.selector, other));
        _signalCall(taker, params);
    }

    function test_FulfillExecutesPostIntentHookAndTransfersNetAmount() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = postIntentHook;
        params.data = abi.encode(other);
        bytes32 intentHash = _signal(taker, params);
        uint256 beforeBalance = token.balanceOf(other);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(other) - beforeBalance, INTENT_AMOUNT);
    }

    function test_PreIntentHookBlocksSignalReentry() public {
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, reentrantPreIntentHook);
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.to = address(reentrantSignalCaller);
        reentrantSignalCaller.setReentryParams(params);
        reentrantSignalCaller.signalIntent(params);
        assertEq(reentrantPreIntentHook.reentryAttemptCount(), 1);
        assertFalse(reentrantPreIntentHook.lastReentrySucceeded());
    }

    function test_FulfillRejectsPostIntentHookThatPullsTooLittle() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = partialPostIntentHook;
        params.data = abi.encode(other);
        bytes32 intentHash = _signal(taker, params);
        vm.expectRevert(bytes("PostIntentHook: must pull exact netAmount"));
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_FulfillRejectsPostIntentHookThatIncreasesBalance() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = pushPostIntentHook;
        params.data = abi.encode(other);
        bytes32 intentHash = _signal(taker, params);
        vm.expectRevert(bytes("PostIntentHook: unexpected balance increase"));
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_PostIntentHookCannotReenterFulfill() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = reentrantPostIntentHook;
        bytes32 intentHash = _signal(taker, params);
        bytes memory proof = _paymentProof(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
        reentrantPostIntentHook.setFulfillParams(proof, intentHash, "", "");
        vm.expectEmit(false, false, false, true, address(reentrantPostIntentHook));
        emit ReentrancyAttempted(false);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function _newGatedDeposit() internal returns (uint256 gatedDepositId) {
        vm.startPrank(depositor);
        gatedDepositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
    }

    function test_GatingAcceptsValidSignature() public {
        uint256 gatedDepositId = _newGatedDeposit();
        IOrchestratorV2.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, block.timestamp + 1 days);
        assertNotEq(_signal(taker, params), bytes32(0));
    }

    function test_GatingRejectsExpiredSignature() public {
        vm.warp(100);
        uint256 gatedDepositId = _newGatedDeposit();
        uint256 expiration = block.timestamp - 1;
        IOrchestratorV2.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, expiration);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.SignatureExpired.selector, expiration, block.timestamp));
        _signalCall(taker, params);
    }

    function test_GatingRejectsSignatureFromWrongSigner() public {
        uint256 gatedDepositId = _newGatedDeposit();
        IOrchestratorV2.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, 0xBAD, taker, block.timestamp + 1 days);
        vm.expectRevert(IOrchestratorV2.InvalidSignature.selector);
        _signalCall(taker, params);
    }

    function test_GatingSignatureCannotBeReplayedByDifferentSender() public {
        uint256 gatedDepositId = _newGatedDeposit();
        IOrchestratorV2.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, block.timestamp + 1 days);
        _signal(taker, params);
        uint256 secondGatedDepositId = _newGatedDeposit();
        params = _gatedParams(secondGatedDepositId, gatingServiceKey, taker, block.timestamp + 1 days);
        vm.expectRevert(IOrchestratorV2.InvalidSignature.selector);
        _signalCall(other, params);
    }
}
