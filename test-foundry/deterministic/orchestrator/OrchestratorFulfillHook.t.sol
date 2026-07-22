// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";
import {PostIntentHookMock} from "contracts/mocks/PostIntentHookMock.sol";
import {PartialPullPostIntentHookMock} from "contracts/mocks/PartialPullPostIntentHookMock.sol";
import {PushPostIntentHookMock} from "contracts/mocks/PushPostIntentHookMock.sol";

contract OrchestratorFulfillHookTest is OrchestratorLegacyFixture {
    event IntentFulfilled(
        bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease
    );

    uint256 internal constant RELEASE_AMOUNT = 46_296_296;
    uint256 internal constant PROTOCOL_FEE = 925_925;

    PostIntentHookMock internal exactHook;
    PartialPullPostIntentHookMock internal partialHook;
    PushPostIntentHookMock internal pushHook;
    bytes32 internal subjectIntent;

    function setUp() public override {
        super.setUp();
        vm.prank(offRamper);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.08e18);
        exactHook = new PostIntentHookMock(address(token), address(orchestrator));
        partialHook = new PartialPullPostIntentHookMock(address(token), address(orchestrator));
        pushHook = new PushPostIntentHookMock(address(token), address(orchestrator));
        postIntentHookRegistry.addPostIntentHook(address(exactHook));
        postIntentHookRegistry.addPostIntentHook(address(partialHook));
        postIntentHookRegistry.addPostIntentHook(address(pushHook));
        subjectIntent = _signalWithHook(IPostIntentHook(address(exactHook)));
        verifier.setShouldVerifyPayment(true);
    }

    function _signalWithHook(IPostIntentHook hook) internal returns (bytes32 intentHash) {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.to = onRamper;
        params.conversionRate = 1.08e18;
        params.postIntentHook = hook;
        params.data = abi.encode(receiver);
        params.gatingServiceSignature = _resign(params);
        intentHash = _signal(onRamper, params);
    }

    function _replaceHook(IPostIntentHook hook) internal returns (bytes32 intentHash) {
        vm.prank(onRamper);
        orchestrator.cancelIntent(subjectIntent);
        intentHash = _signalWithHook(hook);
        subjectIntent = intentHash;
    }

    function _fulfill(bytes32 intentHash) internal {
        bytes memory proof = abi.encode(50e6, block.timestamp, PAYEE, USD, intentHash);
        vm.prank(onRamper);
        orchestrator.fulfillIntent(
            IOrchestrator.FulfillIntentParams({
                paymentProof: proof, intentHash: intentHash, verificationData: "", postIntentHookData: ""
            })
        );
    }

    function test_FulfillHookRoutesFundsToTargetInsteadOfIntentRecipient() public {
        uint256 targetBefore = token.balanceOf(receiver);
        uint256 intentRecipientBefore = token.balanceOf(onRamper);
        uint256 escrowBefore = token.balanceOf(address(escrow));
        _fulfill(subjectIntent);
        assertEq(token.balanceOf(receiver) - targetBefore, RELEASE_AMOUNT);
        assertEq(token.balanceOf(onRamper) - intentRecipientBefore, 0);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), RELEASE_AMOUNT);
    }

    function test_FulfillHookEmitsHookAsFundsRecipient() public {
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, address(exactHook), RELEASE_AMOUNT, false);
        _fulfill(subjectIntent);
    }

    function test_FulfillHookResetsApprovalToZero() public {
        assertEq(token.allowance(address(orchestrator), address(exactHook)), 0);
        _fulfill(subjectIntent);
        assertEq(token.allowance(address(orchestrator), address(exactHook)), 0);
    }

    function test_FulfillHookWithProtocolFeeConservesTransfers() public {
        orchestrator.setProtocolFee(0.02e18);
        uint256 targetBefore = token.balanceOf(receiver);
        uint256 feeBefore = token.balanceOf(feeRecipient);
        uint256 escrowBefore = token.balanceOf(address(escrow));
        _fulfill(subjectIntent);
        assertEq(token.balanceOf(receiver) - targetBefore, RELEASE_AMOUNT - PROTOCOL_FEE);
        assertEq(token.balanceOf(feeRecipient) - feeBefore, PROTOCOL_FEE);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), RELEASE_AMOUNT);
    }

    function test_FulfillHookWithProtocolFeeEmitsNetAmount() public {
        orchestrator.setProtocolFee(0.02e18);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, address(exactHook), RELEASE_AMOUNT - PROTOCOL_FEE, false);
        _fulfill(subjectIntent);
    }

    function test_FulfillHookRejectsPartialPull() public {
        bytes32 partialIntent = _replaceHook(IPostIntentHook(address(partialHook)));
        vm.expectRevert("PostIntentHook: must pull exact netAmount");
        _fulfill(partialIntent);
    }

    function test_FulfillHookRejectsUnexpectedBalanceIncrease() public {
        bytes32 pushIntent = _replaceHook(IPostIntentHook(address(pushHook)));
        token.transfer(address(pushHook), 10e6);
        vm.expectRevert("PostIntentHook: unexpected balance increase");
        _fulfill(pushIntent);
    }
}
