// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";

contract OrchestratorSignalTest is OrchestratorLegacyFixture {
    event IntentSignaled(
        bytes32 indexed intentHash,
        address indexed escrowAddress,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        address owner,
        address to,
        uint256 amount,
        bytes32 fiatCurrency,
        uint256 conversionRate,
        uint256 timestamp
    );
    event IntentPruned(bytes32 indexed intentHash);

    function test_ConstructorSetsEveryStateVariable() public view {
        assertEq(orchestrator.chainId(), CHAIN_ID);
        assertEq(address(orchestrator.escrowRegistry()), address(escrowRegistry));
        assertEq(address(orchestrator.paymentVerifierRegistry()), address(paymentVerifierRegistry));
        assertEq(address(orchestrator.postIntentHookRegistry()), address(postIntentHookRegistry));
        assertEq(address(orchestrator.relayerRegistry()), address(relayerRegistry));
        assertEq(orchestrator.protocolFee(), 0);
        assertEq(orchestrator.protocolFeeRecipient(), feeRecipient);
    }

    function test_SignalIntentStoresCompleteIntent() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        bytes32 intentHash = _signal(onRamper, params);
        IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
        assertEq(intent.owner, onRamper);
        assertEq(intent.to, receiver);
        assertEq(intent.escrow, address(escrow));
        assertEq(intent.depositId, 0);
        assertEq(intent.amount, 50e6);
        assertEq(intent.paymentMethod, VENMO);
        assertEq(intent.fiatCurrency, USD);
        assertEq(intent.conversionRate, 1.02e18);
        assertEq(intent.payeeId, PAYEE);
        assertEq(intent.timestamp, block.timestamp);
        assertEq(intent.referrer, address(0));
        assertEq(intent.referrerFee, 0);
        assertEq(address(intent.postIntentHook), address(0));
        assertEq(intent.data, "");
    }

    function test_SignalIntentLocksEscrowFunds() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        bytes32 intentHash = _signal(onRamper, params);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.outstandingIntentAmount, 50e6);
        assertEq(deposit.remainingDeposits, 50e6);
        bytes32[] memory hashes = escrow.getDepositIntentHashes(0);
        assertEq(hashes.length, 1);
        assertEq(hashes[0], intentHash);
    }

    function test_SignalIntentAddsHashToAccount() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        bytes32 intentHash = _signal(onRamper, params);
        bytes32[] memory hashes = orchestrator.getAccountIntents(onRamper);
        assertEq(hashes.length, 1);
        assertEq(hashes[0], intentHash);
    }

    function test_SignalIntentSnapshotsMinimumAmount() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        bytes32 intentHash = _signal(onRamper, params);
        assertEq(orchestrator.getIntentMinAtSignal(intentHash), 10e6);
    }

    function test_SignalIntentEmitsCompleteEvent() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        bytes32 intentHash = _nextIntentHash();
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit IntentSignaled(
            intentHash, address(escrow), 0, VENMO, onRamper, receiver, 50e6, USD, 1.02e18, block.timestamp
        );
        _callSignal(onRamper, params);
    }

    function _expiredIntentSetup() internal returns (bytes32 oldIntent, IOrchestrator.SignalIntentParams memory next) {
        IOrchestrator.SignalIntentParams memory first = _baseSignalParams(onRamper);
        oldIntent = _signal(onRamper, first);
        vm.warp(block.timestamp + 1 days + 1);
        next = _baseSignalParams(onRamperTwo);
        next.amount = 60e6;
        next.signatureExpiration = block.timestamp + 1 days + 10;
        next.gatingServiceSignature = _resign(next);
    }

    function test_SignalIntentPrunesExpiredIntentAndUpdatesDeposit() public {
        (bytes32 oldIntent, IOrchestrator.SignalIntentParams memory next) = _expiredIntentSetup();
        bytes32 newIntent = _signal(onRamperTwo, next);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.outstandingIntentAmount, 60e6);
        assertEq(deposit.remainingDeposits, 40e6);
        bytes32[] memory hashes = escrow.getDepositIntentHashes(0);
        assertEq(hashes.length, 1);
        assertEq(hashes[0], newIntent);
        assertNotEq(hashes[0], oldIntent);
    }

    function test_SignalIntentPruningDeletesOriginalOrchestratorIntent() public {
        (bytes32 oldIntent, IOrchestrator.SignalIntentParams memory next) = _expiredIntentSetup();
        _signal(onRamperTwo, next);
        assertEq(orchestrator.getIntent(oldIntent).owner, address(0));
    }

    function test_SignalIntentPruningEmitsIntentPruned() public {
        (bytes32 oldIntent, IOrchestrator.SignalIntentParams memory next) = _expiredIntentSetup();
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit IntentPruned(oldIntent);
        _callSignal(onRamperTwo, next);
    }

    function test_SignalIntentRejectsWhenUnexpiredLiquidityCannotCoverAmount() public {
        IOrchestrator.SignalIntentParams memory first = _baseSignalParams(onRamper);
        _signal(onRamper, first);
        vm.warp(block.timestamp + 12 hours);
        IOrchestrator.SignalIntentParams memory next = _baseSignalParams(onRamperTwo);
        next.amount = 60e6;
        next.gatingServiceSignature = _resign(next);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InsufficientDepositLiquidity.selector, 0, 50e6, 60e6));
        _callSignal(onRamperTwo, next);
    }

    function test_SignalIntentRejectsSecondActiveIntentForOrdinaryAccount() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        bytes32 first = _signal(onRamper, params);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.AccountHasActiveIntent.selector, onRamper, first));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentAllowsNewIntentAfterCancellation() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        bytes32 first = _signal(onRamper, params);
        vm.prank(onRamper);
        orchestrator.cancelIntent(first);
        _callSignal(onRamper, params);
        assertEq(orchestrator.getAccountIntents(onRamper).length, 1);
    }

    function test_SignalIntentAllowsMultipleWhenGovernanceEnablesIt() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        _signal(onRamper, params);
        orchestrator.setAllowMultipleIntents(true);
        _callSignal(onRamper, params);
        assertEq(orchestrator.getAccountIntents(onRamper).length, 2);
    }

    function test_SignalIntentAllowsMultipleForWhitelistedRelayer() public {
        relayerRegistry.addRelayer(relayerAccount);
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(relayerAccount);
        _signal(relayerAccount, params);
        _callSignal(relayerAccount, params);
        assertEq(orchestrator.getAccountIntents(relayerAccount).length, 2);
    }

    function test_SignalIntentStoresWhitelistedPostHookAndData() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.postIntentHook = IPostIntentHook(address(postIntentHookMock));
        params.data = hex"1234";
        bytes32 intentHash = _signal(onRamper, params);
        IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
        assertEq(address(intent.postIntentHook), address(postIntentHookMock));
        assertEq(intent.data, hex"1234");
    }

    function test_SignalIntentRejectsUnwhitelistedPostHook() public {
        postIntentHookRegistry.removePostIntentHook(address(postIntentHookMock));
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.postIntentHook = IPostIntentHook(address(postIntentHookMock));
        vm.expectRevert(
            abi.encodeWithSelector(IOrchestrator.PostIntentHookNotWhitelisted.selector, address(postIntentHookMock))
        );
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsMissingDepositAsUnsupportedMethod() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.depositId = 1;
        params.gatingServiceSignature = _resign(params);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.PaymentMethodNotSupported.selector, VENMO));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsPaymentMethodNotConfiguredOnDeposit() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.paymentMethod = PAYPAL;
        params.gatingServiceSignature = _resign(params);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.PaymentMethodNotSupported.selector, PAYPAL));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsMethodRemovedFromRegistry() public {
        paymentVerifierRegistry.removePaymentMethod(VENMO);
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.PaymentMethodDoesNotExist.selector, VENMO));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsCurrencyNotConfiguredOnDeposit() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.fiatCurrency = EUR;
        params.gatingServiceSignature = _resign(params);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.CurrencyNotSupported.selector, VENMO, EUR));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsRateBelowMinimum() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.conversionRate = 0.99e18;
        params.gatingServiceSignature = _resign(params);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.RateBelowMinimum.selector, 0.99e18, 1.01e18));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentAllowsRateEqualToMinimum() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.conversionRate = 1.01e18;
        params.gatingServiceSignature = _resign(params);
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsUnwhitelistedEscrow() public {
        escrowRegistry.removeEscrow(address(escrow));
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.EscrowNotWhitelisted.selector, address(escrow)));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentAllowsAnyEscrowWhenRegistryAcceptsAll() public {
        escrowRegistry.removeEscrow(address(escrow));
        escrowRegistry.setAcceptAllEscrows(true);
        _callSignal(onRamper, _baseSignalParams(onRamper));
    }

    function test_SignalIntentRejectsDepositNotAcceptingIntents() public {
        vm.prank(offRamper);
        escrow.setAcceptingIntents(0, false);
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotAcceptingIntents.selector, 0));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsAmountBelowDepositMinimum() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.amount = 5e6;
        params.gatingServiceSignature = _resign(params);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountBelowMin.selector, 5e6, 10e6));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsAmountAboveDepositMaximum() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.amount = 250e6;
        params.gatingServiceSignature = _resign(params);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountAboveMax.selector, 250e6, 200e6));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsZeroRecipient() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.to = address(0);
        vm.expectRevert(IOrchestrator.ZeroAddress.selector);
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsInvalidGatingSignature() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.gatingServiceSignature = "";
        vm.expectRevert(IOrchestrator.InvalidSignature.selector);
        _callSignal(onRamper, params);
    }

    function test_SignalIntentAllowsEmptySignatureWithoutGatingService() public {
        _createOrchestratorDeposit(address(0), 100e6, 10e6, 200e6, 1.01e18);
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.depositId = 1;
        params.gatingServiceSignature = "";
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsExpiredGatingSignature() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.signatureExpiration = block.timestamp - 1;
        params.gatingServiceSignature = _resign(params);
        vm.expectRevert(
            abi.encodeWithSelector(IOrchestrator.SignatureExpired.selector, params.signatureExpiration, block.timestamp)
        );
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsWhilePaused() public {
        orchestrator.pauseOrchestrator();
        vm.expectRevert("Pausable: paused");
        _callSignal(onRamper, _baseSignalParams(onRamper));
    }

    function test_SignalIntentRejectsReferrerFeeAboveMaximum() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.referrer = receiver;
        params.referrerFee = 0.51e18;
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.FeeExceedsMaximum.selector, 0.51e18, 0.5e18));
        _callSignal(onRamper, params);
    }

    function test_SignalIntentRejectsFeeWithoutReferrer() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.referrerFee = 0.01e18;
        vm.expectRevert(IOrchestrator.InvalidReferrerFeeConfiguration.selector);
        _callSignal(onRamper, params);
    }

    function test_SignalIntentStoresValidReferrerAndFee() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.referrer = receiver;
        params.referrerFee = 0.02e18;
        bytes32 intentHash = _signal(onRamper, params);
        IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
        assertEq(intent.referrer, receiver);
        assertEq(intent.referrerFee, 0.02e18);
    }

    function test_SignalIntentAllowsMaximumReferrerFee() public {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.referrer = receiver;
        params.referrerFee = 0.5e18;
        _callSignal(onRamper, params);
    }
}
