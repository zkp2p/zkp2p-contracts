// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";

contract OrchestratorManualReleaseTest is OrchestratorLegacyFixture {
    event IntentFulfilled(
        bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease
    );
    event DepositClosed(uint256 depositId, address depositor);

    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant PROTOCOL_FEE = 1e6;
    uint256 internal constant REFERRER_FEE = 500_000;

    bytes32 internal subjectIntent;

    function setUp() public override {
        super.setUp();
        vm.prank(offRamper);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.08e18);
        subjectIntent = _signalManualIntent(address(0), 0, IPostIntentHook(address(0)), "");
    }

    function _manualParams(address referrer, uint256 referrerFee, IPostIntentHook hook, bytes memory data)
        internal
        view
        returns (IOrchestrator.SignalIntentParams memory params)
    {
        params = _baseSignalParams(onRamper);
        params.to = onRamper;
        params.conversionRate = 1.08e18;
        params.referrer = referrer;
        params.referrerFee = referrerFee;
        params.postIntentHook = hook;
        params.data = data;
        params.gatingServiceSignature = _resign(params);
    }

    function _signalManualIntent(address referrer, uint256 referrerFee, IPostIntentHook hook, bytes memory data)
        internal
        returns (bytes32)
    {
        return _signal(onRamper, _manualParams(referrer, referrerFee, hook, data));
    }

    function _release(bytes32 intentHash) internal {
        vm.prank(offRamper);
        orchestrator.releaseFundsToPayer(intentHash);
    }

    function test_ManualReleaseRejectsWhenReentrancyGuardIsEntered() public {
        vm.store(address(orchestrator), bytes32(uint256(1)), bytes32(uint256(2)));
        vm.expectRevert("ReentrancyGuard: reentrant call");
        vm.prank(offRamper);
        orchestrator.releaseFundsToPayer(keccak256("legacy-guarded-release"));
    }

    function _replaceIntent(address referrer, uint256 referrerFee, IPostIntentHook hook, bytes memory data)
        internal
        returns (bytes32)
    {
        vm.prank(onRamper);
        orchestrator.cancelIntent(subjectIntent);
        subjectIntent = _signalManualIntent(referrer, referrerFee, hook, data);
        return subjectIntent;
    }

    function _signalSecondIntent() internal returns (bytes32) {
        _release(subjectIntent);
        subjectIntent = _signalManualIntent(address(0), 0, IPostIntentHook(address(0)), "");
        return subjectIntent;
    }

    function test_ManualReleaseTransfersFullIntentAmountToPayer() public {
        uint256 beforeBalance = token.balanceOf(onRamper);
        _release(subjectIntent);
        assertEq(token.balanceOf(onRamper) - beforeBalance, INTENT_AMOUNT);
    }

    function test_ManualReleaseDeletesIntentAndAccountIntent() public {
        _release(subjectIntent);
        assertEq(orchestrator.getIntent(subjectIntent).owner, address(0));
        assertEq(orchestrator.getAccountIntents(onRamper).length, 0);
    }

    function test_ManualReleaseUpdatesEscrowAccounting() public {
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        _release(subjectIntent);
        IEscrow.Deposit memory afterDeposit = escrow.getDeposit(0);
        assertEq(afterDeposit.remainingDeposits, beforeDeposit.remainingDeposits);
        assertEq(afterDeposit.outstandingIntentAmount, beforeDeposit.outstandingIntentAmount - INTENT_AMOUNT);
    }

    function test_ManualReleaseEmitsIntentFulfilled() public {
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, onRamper, INTENT_AMOUNT, true);
        _release(subjectIntent);
    }

    function test_ManualReleaseClosingDepositDeletesDeposit() public {
        bytes32 secondIntent = _signalSecondIntent();
        _release(secondIntent);
        assertEq(escrow.getDeposit(0).depositor, address(0));
    }

    function test_ManualReleaseClosingDepositDeletesPaymentMethodData() public {
        bytes32 secondIntent = _signalSecondIntent();
        _release(secondIntent);
        assertEq(escrow.getDepositPaymentMethodData(0, VENMO).intentGatingService, address(0));
    }

    function test_ManualReleaseClosingDepositDeletesCurrencyData() public {
        bytes32 secondIntent = _signalSecondIntent();
        _release(secondIntent);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_ManualReleaseClosingDepositEmitsDepositClosed() public {
        bytes32 secondIntent = _signalSecondIntent();
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(0, offRamper);
        _release(secondIntent);
    }

    function test_ManualReleaseProtocolFeeTransfersCorrectAmounts() public {
        orchestrator.setProtocolFee(0.02e18);
        uint256 payerBefore = token.balanceOf(onRamper);
        uint256 feeRecipientBefore = token.balanceOf(feeRecipient);
        _release(subjectIntent);
        assertEq(token.balanceOf(onRamper) - payerBefore, INTENT_AMOUNT - PROTOCOL_FEE);
        assertEq(token.balanceOf(feeRecipient) - feeRecipientBefore, PROTOCOL_FEE);
    }

    function test_ManualReleaseProtocolFeeEmitsNetAmount() public {
        orchestrator.setProtocolFee(0.02e18);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, onRamper, INTENT_AMOUNT - PROTOCOL_FEE, true);
        _release(subjectIntent);
    }

    function test_ManualReleaseReferrerFeeTransfersCorrectAmounts() public {
        _replaceIntent(receiver, 0.01e18, IPostIntentHook(address(0)), "");
        uint256 payerBefore = token.balanceOf(onRamper);
        uint256 referrerBefore = token.balanceOf(receiver);
        _release(subjectIntent);
        assertEq(token.balanceOf(onRamper) - payerBefore, INTENT_AMOUNT - REFERRER_FEE);
        assertEq(token.balanceOf(receiver) - referrerBefore, REFERRER_FEE);
    }

    function test_ManualReleaseReferrerFeeEmitsNetAmount() public {
        _replaceIntent(receiver, 0.01e18, IPostIntentHook(address(0)), "");
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, onRamper, INTENT_AMOUNT - REFERRER_FEE, true);
        _release(subjectIntent);
    }

    function test_ManualReleaseProtocolAndReferrerFeesTransferCorrectAmounts() public {
        _replaceIntent(receiver, 0.01e18, IPostIntentHook(address(0)), "");
        orchestrator.setProtocolFee(0.02e18);
        uint256 payerBefore = token.balanceOf(onRamper);
        uint256 protocolBefore = token.balanceOf(feeRecipient);
        uint256 referrerBefore = token.balanceOf(receiver);
        _release(subjectIntent);
        assertEq(token.balanceOf(onRamper) - payerBefore, INTENT_AMOUNT - PROTOCOL_FEE - REFERRER_FEE);
        assertEq(token.balanceOf(feeRecipient) - protocolBefore, PROTOCOL_FEE);
        assertEq(token.balanceOf(receiver) - referrerBefore, REFERRER_FEE);
    }

    function test_ManualReleaseProtocolAndReferrerFeesEmitNetAmount() public {
        _replaceIntent(receiver, 0.01e18, IPostIntentHook(address(0)), "");
        orchestrator.setProtocolFee(0.02e18);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, onRamper, INTENT_AMOUNT - PROTOCOL_FEE - REFERRER_FEE, true);
        _release(subjectIntent);
    }

    function test_ManualReleaseRejectsMissingIntent() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.IntentNotFound.selector, bytes32(0)));
        _release(bytes32(0));
    }

    function test_ManualReleaseWithHookStillTransfersToIntentRecipient() public {
        _replaceIntent(address(0), 0, IPostIntentHook(address(postIntentHookMock)), abi.encode(receiver));
        uint256 payerBefore = token.balanceOf(onRamper);
        _release(subjectIntent);
        assertEq(token.balanceOf(onRamper) - payerBefore, INTENT_AMOUNT);
        assertEq(token.balanceOf(receiver), 0);
    }

    function test_ManualReleaseWithHookAndFeeTransfersNetToIntentRecipient() public {
        _replaceIntent(address(0), 0, IPostIntentHook(address(postIntentHookMock)), abi.encode(receiver));
        orchestrator.setProtocolFee(0.02e18);
        uint256 payerBefore = token.balanceOf(onRamper);
        _release(subjectIntent);
        assertEq(token.balanceOf(onRamper) - payerBefore, INTENT_AMOUNT - PROTOCOL_FEE);
        assertEq(token.balanceOf(receiver), 0);
    }

    function test_ManualReleaseWithHookAndFeeEmitsIntentRecipientAndNetAmount() public {
        _replaceIntent(address(0), 0, IPostIntentHook(address(postIntentHookMock)), abi.encode(receiver));
        orchestrator.setProtocolFee(0.02e18);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, onRamper, INTENT_AMOUNT - PROTOCOL_FEE, true);
        _release(subjectIntent);
    }

    function test_ManualReleaseRejectsNonDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.UnauthorizedCaller.selector, onRamperTwo, offRamper));
        vm.prank(onRamperTwo);
        orchestrator.releaseFundsToPayer(subjectIntent);
    }
}
