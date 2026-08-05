// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IntentLifecycleHookV1Mock} from "contracts/mocks/IntentLifecycleHookV1Mock.sol";
import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract OrchestratorV3LifecycleTest is OrchestratorV3Fixture {
    event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool manual);

    IntentLifecycleHookV1Mock internal lifecycleHookMock;

    function setUp() public override {
        super.setUp();
        lifecycleHookMock = new IntentLifecycleHookV1Mock();
    }

    function test_SignalWithoutLifecycleHookSnapshotsZeroAddress() public {
        bytes32 intentHash = _signalDefault();
        assertEq(address(orchestrator.getIntentLifecycleHook(intentHash)), address(0));
    }

    function test_SignalWithLifecycleHookExecutesAdmissionAndSnapshotsHook() public {
        orchestrator.setLifecycleHook(IIntentLifecycleHook(address(lifecycleHookMock)));

        bytes32 intentHash = _signalDefault();

        assertEq(lifecycleHookMock.signaledCalls(), 1);
        assertEq(address(orchestrator.getIntentLifecycleHook(intentHash)), address(lifecycleHookMock));
    }

    function test_RevertingAdmissionFailsClosedBeforeEscrowLock() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        lifecycleHookMock.setRevertOnCreate(true);
        uint256 counterBefore = orchestrator.intentCounter();
        uint256 availableBefore = escrow.getDeposit(depositId).remainingDeposits;
        vm.expectRevert(bytes("risk admission failed"));
        _signalCall(taker, _defaultParams());
        assertEq(orchestrator.intentCounter(), counterBefore);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, availableBefore);
    }

    function test_CancelHealthyHookUnlocksAndCallsCallback() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        bytes32 intentHash = _signalDefault();
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(lifecycleHookMock.cancelledCalls(), 1);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6);
    }

    function test_CancelRevertingHookBlocksCancellation() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        bytes32 intentHash = _signalDefault();
        lifecycleHookMock.setRevertOnCallback(true);
        vm.expectRevert(bytes("risk cancellation failed"));
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertNotEq(orchestrator.getIntent(intentHash).owner, address(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6 - INTENT_AMOUNT);

        lifecycleHookMock.setRevertOnCallback(false);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6);
    }

    function test_EscrowPruneRevertingHookBlocksPrune() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        bytes32 intentHash = _signalDefault();
        lifecycleHookMock.setRevertOnCallback(true);
        vm.warp(block.timestamp + 3601);
        vm.expectRevert(bytes("risk cancellation failed"));
        escrow.pruneExpiredIntents(depositId);
        assertNotEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_OrphanCleanupRevertingHookBlocksCleanup() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        bytes32 intentHash = _signalDefault();
        bytes32 depositIntentsSlot = keccak256(abi.encode(depositId, uint256(14)));
        bytes32 storageSlot = keccak256(abi.encode(intentHash, depositIntentsSlot));
        vm.store(address(escrow), storageSlot, bytes32(0));
        lifecycleHookMock.setRevertOnCallback(true);
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = intentHash;
        vm.expectRevert(bytes("risk cancellation failed"));
        orchestrator.cleanupOrphanedIntents(hashes);
        assertNotEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_SettlementNotifiesHookAndFundsFlowNormally() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        bytes32 intentHash = _signal(taker, params);
        uint256 recipientBefore = token.balanceOf(taker);
        uint256 referrerBefore = token.balanceOf(referrer);
        uint256 otherBefore = token.balanceOf(other);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);

        assertEq(lifecycleHookMock.settlementCalls(), 1);
        (
            bytes32 settledIntentHash,
            address settlementToken,
            address recipient,
            uint256 releaseAmount,
            uint256 netAmount,
            bytes32 paymentId,
            bool isManualRelease
        ) = lifecycleHookMock.lastSettlementContext();
        assertEq(settledIntentHash, intentHash);
        assertEq(settlementToken, address(token));
        assertEq(recipient, taker);
        assertEq(releaseAmount, INTENT_AMOUNT);
        assertEq(netAmount, INTENT_AMOUNT - 250_000);
        assertEq(paymentId, bytes32(0));
        assertFalse(isManualRelease);
        assertEq(token.balanceOf(referrer) - referrerBefore, 150_000);
        assertEq(token.balanceOf(other) - otherBefore, 100_000);
        assertEq(token.balanceOf(taker) - recipientBefore, INTENT_AMOUNT - 250_000);
    }

    function test_FulfillBelowDepositMinimumSettlesVerifiedAmountAndReturnsRemainder() public {
        uint256 releaseAmount = 5e6;
        bytes32 intentHash = _signalDefault();
        uint256 recipientBefore = token.balanceOf(taker);
        uint256 remainingBefore = escrow.getDeposit(depositId).remainingDeposits;

        _fulfill(intentHash, releaseAmount, CONVERSION_RATE);

        assertEq(token.balanceOf(taker) - recipientBefore, releaseAmount);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, remainingBefore + INTENT_AMOUNT - releaseAmount);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_SettlementRevertFailsClosed() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        lifecycleHookMock.setRevertOnCallback(true);
        bytes32 intentHash = _signalDefault();
        vm.expectRevert(bytes("risk settlement failed"));
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_ManualReleaseRoutesThroughLifecycleAndPostIntentHook() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        params.postIntentHook = postIntentHook;
        params.data = abi.encode(delegate);
        bytes32 intentHash = _signal(taker, params);
        uint256 recipientBefore = token.balanceOf(taker);
        uint256 hookRecipientBefore = token.balanceOf(delegate);
        uint256 netAmount = INTENT_AMOUNT - 250_000;
        vm.expectEmit(true, true, true, true);
        emit IntentFulfilled(intentHash, address(postIntentHook), netAmount, true);
        bytes32 paymentId = keccak256("manual-payment");
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash, paymentId);
        assertEq(lifecycleHookMock.settlementCalls(), 1);
        (,,,,, bytes32 settledPaymentId, bool isManualRelease) = lifecycleHookMock.lastSettlementContext();
        assertEq(settledPaymentId, paymentId);
        assertTrue(isManualRelease);
        assertEq(token.balanceOf(taker), recipientBefore);
        assertEq(token.balanceOf(delegate) - hookRecipientBefore, netAmount);
        assertEq(postIntentHook.lastPostIntentHookData(), "");
    }

    function test_ManualReleaseRejectsZeroPaymentIdBeforePruning() public {
        bytes32 intentHash = _signalDefault();

        vm.expectRevert(IOrchestratorV3.ZeroPaymentId.selector);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash, bytes32(0));

        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);
    }

    function test_GovernanceLifecycleHookSetterValidatesOwnerAndCode() public {
        orchestrator.setLifecycleHook(lifecycleHookMock);
        assertEq(address(orchestrator.lifecycleHook()), address(lifecycleHookMock));
        orchestrator.setLifecycleHook(IIntentLifecycleHook(address(0)));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.InvalidLifecycleHook.selector, other));
        orchestrator.setLifecycleHook(IIntentLifecycleHook(other));
    }

    function test_DepositWhitelistSelectorsNoLongerExist() public view {
        (bool setter,) = address(orchestrator)
            .staticcall(
                abi.encodeWithSignature(
                    "setDepositWhitelistHook(address,uint256,address)", address(escrow), depositId, address(0)
                )
            );
        (bool getter,) = address(orchestrator)
            .staticcall(abi.encodeWithSignature("getDepositWhitelistHook(address,uint256)", address(escrow), depositId));
        assertFalse(setter);
        assertFalse(getter);
    }

    function test_IntentMinAtSignalGetterNoLongerExists() public view {
        (bool success,) =
            address(orchestrator).staticcall(abi.encodeWithSignature("getIntentMinAtSignal(bytes32)", bytes32(0)));
        assertFalse(success);
    }
}
