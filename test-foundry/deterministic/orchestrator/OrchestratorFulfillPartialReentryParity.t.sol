// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";
import {ReentrantPostIntentHook} from "contracts/mocks/ReentrantPostIntentHook.sol";

contract OrchestratorFulfillPartialReentryParityTest is OrchestratorLegacyFixture {
    event IntentFulfilled(
        bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease
    );
    event ReentrancyAttempted(bool success);

    uint256 internal constant PARTIAL_RELEASE = 37_037_037;
    uint256 internal constant PARTIAL_PROTOCOL_FEE = 740_740;
    uint256 internal constant FULL_RELEASE = 46_296_296;

    bytes32 internal subjectIntent;

    function setUp() public override {
        super.setUp();
        vm.prank(offRamper);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.08e18);
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.to = onRamper;
        params.conversionRate = 1.08e18;
        params.gatingServiceSignature = _resign(params);
        subjectIntent = _signal(onRamper, params);
        verifier.setShouldVerifyPayment(false);
    }

    function _proof(bytes32 intentHash, uint256 fiatAmount) internal view returns (bytes memory) {
        return abi.encode(fiatAmount, block.timestamp, PAYEE, USD, intentHash);
    }

    function _fulfill(bytes32 intentHash, uint256 fiatAmount) internal {
        vm.prank(onRamper);
        orchestrator.fulfillIntent(
            IOrchestrator.FulfillIntentParams({
                paymentProof: _proof(intentHash, fiatAmount),
                intentHash: intentHash,
                verificationData: "",
                postIntentHookData: ""
            })
        );
    }

    function _replaceWithReentrantHook() internal returns (ReentrantPostIntentHook hook, bytes32 maliciousIntent) {
        hook = new ReentrantPostIntentHook(address(token), address(orchestrator));
        postIntentHookRegistry.addPostIntentHook(address(hook));
        vm.prank(onRamper);
        orchestrator.cancelIntent(subjectIntent);

        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(onRamper);
        params.to = onRamper;
        params.conversionRate = 1.08e18;
        params.postIntentHook = IPostIntentHook(address(hook));
        params.gatingServiceSignature = _resign(params);
        maliciousIntent = _signal(onRamper, params);
        subjectIntent = maliciousIntent;
        bytes memory proof = _proof(maliciousIntent, 50e6);
        hook.setFulfillParams(proof, maliciousIntent, "", "");
    }

    function test_FulfillPartialPaymentTransfersPartialRelease() public {
        uint256 beforeBalance = token.balanceOf(onRamper);
        _fulfill(subjectIntent, 40e6);
        assertEq(token.balanceOf(onRamper) - beforeBalance, PARTIAL_RELEASE);
    }

    function test_FulfillPartialPaymentReturnsUnusedLiquidity() public {
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        _fulfill(subjectIntent, 40e6);
        IEscrow.Deposit memory afterDeposit = escrow.getDeposit(0);
        assertEq(afterDeposit.remainingDeposits, beforeDeposit.remainingDeposits + (50e6 - PARTIAL_RELEASE));
        assertEq(afterDeposit.outstandingIntentAmount, 0);
    }

    function test_FulfillPartialPaymentEmitsPartialRelease() public {
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, onRamper, PARTIAL_RELEASE, false);
        _fulfill(subjectIntent, 40e6);
    }

    function test_FulfillPartialPaymentCalculatesFeeFromReleasedAmount() public {
        orchestrator.setProtocolFee(0.02e18);
        uint256 takerBefore = token.balanceOf(onRamper);
        uint256 feeBefore = token.balanceOf(feeRecipient);
        _fulfill(subjectIntent, 40e6);
        assertEq(token.balanceOf(onRamper) - takerBefore, PARTIAL_RELEASE - PARTIAL_PROTOCOL_FEE);
        assertEq(token.balanceOf(feeRecipient) - feeBefore, PARTIAL_PROTOCOL_FEE);
    }

    function test_FulfillReentrantHookBlocksNestedFulfillment() public {
        (ReentrantPostIntentHook hook, bytes32 maliciousIntent) = _replaceWithReentrantHook();
        vm.expectEmit(false, false, false, true, address(hook));
        emit ReentrancyAttempted(false);
        _fulfill(maliciousIntent, 50e6);
        assertEq(hook.getReentrancyAttempts(), 1);
        assertEq(orchestrator.getIntent(maliciousIntent).owner, address(0));
    }

    function test_FulfillReentrantHookCompletesOriginalFulfillment() public {
        (ReentrantPostIntentHook hook, bytes32 maliciousIntent) = _replaceWithReentrantHook();
        uint256 beforeBalance = token.balanceOf(onRamper);
        _fulfill(maliciousIntent, 50e6);
        assertEq(token.balanceOf(onRamper) - beforeBalance, FULL_RELEASE);
        assertEq(orchestrator.getIntent(maliciousIntent).owner, address(0));
        assertEq(escrow.getDeposit(0).outstandingIntentAmount, 0);
        assertEq(hook.getReentrancyAttempts(), 1);
    }

    function test_FulfillHookWithoutReentryExecutesNormally() public {
        (ReentrantPostIntentHook hook, bytes32 maliciousIntent) = _replaceWithReentrantHook();
        hook.setAttemptReentry(false);
        uint256 beforeBalance = token.balanceOf(onRamper);
        _fulfill(maliciousIntent, 50e6);
        assertEq(token.balanceOf(onRamper) - beforeBalance, FULL_RELEASE);
        assertEq(orchestrator.getIntent(maliciousIntent).owner, address(0));
        assertEq(hook.getReentrancyAttempts(), 1);
    }

    function test_FulfillIntentRejectsWhenContractPaused() public {
        orchestrator.pauseOrchestrator();
        vm.expectRevert("Pausable: paused");
        _fulfill(subjectIntent, 50e6);
    }
}
