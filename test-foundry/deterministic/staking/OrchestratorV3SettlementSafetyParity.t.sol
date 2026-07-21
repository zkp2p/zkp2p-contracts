// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerBoundaryFixture} from "../helpers/RiskManagerBoundaryFixture.sol";
import {IntentRiskHookMock} from "contracts/mocks/IntentRiskHookMock.sol";
import {NullifyingPaymentVerifierMock} from "contracts/mocks/NullifyingPaymentVerifierMock.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";

contract OrchestratorV3SettlementSafetyParityTest is RiskManagerBoundaryFixture {
    event RiskHookCallbackFailed(
        bytes32 indexed intentHash, address indexed riskHook, bytes4 indexed callbackSelector, bytes revertData
    );
    event IntentCancellationRecorded(bytes32 indexed intentHash, uint64 cancelledAt);
    event IntentCancellationReconciled(bytes32 indexed intentHash, address indexed riskHook);

    function test_SettlementRejectsPartialPullAndRollsBackEscrow() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        _selectRiskHook(IIntentRiskHook(address(hook)));
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        hook.setSettlementPullAmount(10e6);
        vm.expectPartialRevert(IOrchestratorV3.InvalidRiskHookSettlementConsumption.selector);
        _fulfill(intentHash, 20e6);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        assertEq(token.allowance(address(orchestrator), address(hook)), 0);
    }

    function test_SettlementRejectsOverpullAndCallbackFailure() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        _selectRiskHook(IIntentRiskHook(address(hook)));
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        hook.setSettlementPullAmount(20e6 + 1);
        vm.expectPartialRevert(IOrchestratorV3.RiskHookSettlementFailed.selector);
        _fulfill(intentHash, 20e6);
        assertEq(token.allowance(address(orchestrator), address(hook)), 0);
        hook.setSettlementPullAmount(0);
        hook.setRevertOnCallback(true);
        vm.expectPartialRevert(IOrchestratorV3.RiskHookSettlementFailed.selector);
        _fulfill(intentHash, 20e6);
    }

    function test_CallbackFailureAtomicallyRollsBackNullificationFeesEscrowAndAllowance() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        hook.setRevertOnCallback(true);
        _selectRiskHook(IIntentRiskHook(address(hook)));
        orchestrator.setProtocolFee(ONE_PERCENT);
        _configureManagerFee(recipient);
        NullifyingPaymentVerifierMock nullifyingVerifier = new NullifyingPaymentVerifierMock(nullifierRegistry, PAYPAL);
        nullifierRegistry.addWritePermission(address(nullifyingVerifier));
        paymentVerifierRegistry.removePaymentMethod(PAYPAL);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(PAYPAL, address(nullifyingVerifier), currencies);
        bytes32 intentHash =
            _signalCustom(taker, taker, 100e6, PAYPAL, _oneReferral(other), IPostIntentHookV2(address(0)), "");
        bytes32 paymentId = keccak256(abi.encode(intentHash));
        bytes32 nullifier = keccak256(abi.encodePacked(PAYPAL, paymentId));
        IEscrowV2.Deposit memory depositBefore = escrow.getDeposit(0);
        uint256 protocolBefore = token.balanceOf(address(this));
        uint256 referralBefore = token.balanceOf(other);
        uint256 managerBefore = token.balanceOf(recipient);
        vm.expectPartialRevert(IOrchestratorV3.RiskHookSettlementFailed.selector);
        _fulfill(intentHash, 100e6);
        IEscrowV2.Deposit memory depositAfter = escrow.getDeposit(0);
        assertEq(nullifierRegistry.intentHashByNullifier(nullifier), bytes32(0));
        assertEq(nullifierRegistry.nullifierByIntentHash(intentHash), bytes32(0));
        assertEq(depositAfter.remainingDeposits, depositBefore.remainingDeposits);
        assertEq(depositAfter.outstandingIntentAmount, depositBefore.outstandingIntentAmount);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        assertEq(token.balanceOf(address(this)), protocolBefore);
        assertEq(token.balanceOf(other), referralBefore);
        assertEq(token.balanceOf(recipient), managerBefore);
        assertEq(token.allowance(address(orchestrator), address(hook)), 0);
        assertEq(token.balanceOf(address(orchestrator)), 0);
    }

    function test_SettlementRejectsBalanceIncrease() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        token.transfer(address(hook), 1);
        hook.setSettlementTransferAmount(1);
        _selectRiskHook(IIntentRiskHook(address(hook)));
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        vm.expectPartialRevert(IOrchestratorV3.RiskHookSettlementBalanceIncreased.selector);
        _fulfill(intentHash, 20e6);
        assertEq(token.allowance(address(orchestrator), address(hook)), 0);
    }

    function test_SettlementFailsClosedWhenSnapshottedHookLosesCode() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        _selectRiskHook(IIntentRiskHook(address(hook)));
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        vm.etch(address(hook), "");
        vm.expectPartialRevert(IOrchestratorV3.InvalidRiskHook.selector);
        _fulfill(intentHash, 20e6);
    }

    function test_AdmissionFailsClosedWhenSelectedHookLosesCode() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        _selectRiskHook(IIntentRiskHook(address(hook)));
        vm.etch(address(hook), "");
        IOrchestratorV3.SignalIntentParams memory params = _signalParams(taker, 20e6, ZELLE);
        vm.expectPartialRevert(IOrchestratorV3.RiskHookAdmissionFailed.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
    }

    function test_CancellationRecordsRecoveryWhenSnapshottedHookLosesCode() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        _selectRiskHook(IIntentRiskHook(address(hook)));
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        vm.etch(address(hook), "");
        vm.expectEmit(true, true, true, false, address(orchestrator));
        emit RiskHookCallbackFailed(intentHash, address(hook), IIntentRiskHook.onIntentCancelled.selector, "");
        vm.expectEmit(true, false, false, false, address(orchestrator));
        emit IntentCancellationRecorded(intentHash, 0);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertNotEq(orchestrator.getIntentCancellation(intentHash), 0);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_OnlyFailedRiskHookCanAcknowledgeCancellationRecovery() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        _selectRiskHook(IIntentRiskHook(address(hook)));
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        hook.setRevertOnCallback(true);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertNotEq(orchestrator.getIntentCancellation(intentHash), 0);
        vm.expectPartialRevert(IOrchestratorV3.UnauthorizedCancellationAcknowledger.selector);
        vm.prank(other);
        orchestrator.acknowledgeIntentCancellation(intentHash);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentCancellationReconciled(intentHash, address(hook));
        hook.acknowledgeIntentCancellation(orchestrator, intentHash);
        assertEq(orchestrator.getIntentCancellation(intentHash), 0);
        vm.expectPartialRevert(IOrchestratorV3.IntentCancellationNotRecorded.selector);
        hook.acknowledgeIntentCancellation(orchestrator, intentHash);
    }
}
