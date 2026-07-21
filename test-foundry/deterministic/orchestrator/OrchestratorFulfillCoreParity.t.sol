// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";

contract OrchestratorFulfillCoreParityTest is OrchestratorLegacyFixture {
    event IntentFulfilled(
        bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease
    );

    uint256 internal constant RELEASE_AMOUNT = 46_296_296;
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
        verifier.setShouldVerifyPayment(true);
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

    function test_FulfillIntentTransfersReleaseAmountToRecipient() public {
        uint256 beforeBalance = token.balanceOf(onRamper);
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
        assertEq(token.balanceOf(onRamper) - beforeBalance, RELEASE_AMOUNT);
    }

    function test_FulfillIntentPrunesIntent() public {
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
        assertEq(orchestrator.getIntent(subjectIntent).owner, address(0));
        assertEq(orchestrator.getIntentMinAtSignal(subjectIntent), 0);
        assertEq(orchestrator.getAccountIntents(onRamper).length, 0);
    }

    function test_FulfillIntentUpdatesDepositAccounting() public {
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
        IEscrow.Deposit memory afterDeposit = escrow.getDeposit(0);
        assertEq(afterDeposit.outstandingIntentAmount, beforeDeposit.outstandingIntentAmount - 50e6);
        assertEq(afterDeposit.remainingDeposits, beforeDeposit.remainingDeposits + (50e6 - RELEASE_AMOUNT));
    }

    function test_FulfillIntentEmitsNetReleaseAmount() public {
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(subjectIntent, onRamper, RELEASE_AMOUNT, false);
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
    }

    function test_FulfillIntentRejectsReleaseBelowSignalMinimum() public {
        uint256 belowMinimumRelease = 4_629_629;
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.AmountBelowMin.selector, belowMinimumRelease, 10e6));
        _fulfill(subjectIntent, _proof(subjectIntent, 5e6));
    }

    function test_FulfillIntentUsesSnapshottedRateAfterDepositRateIncrease() public {
        vm.prank(offRamper);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.09e18);
        uint256 beforeBalance = token.balanceOf(onRamper);
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
        assertEq(token.balanceOf(onRamper) - beforeBalance, RELEASE_AMOUNT);
    }

    function test_FulfillIntentRateUpdateDoesNotChangeDepositAccounting() public {
        vm.prank(offRamper);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.09e18);
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        _fulfill(subjectIntent, _proof(subjectIntent, 50e6));
        IEscrow.Deposit memory afterDeposit = escrow.getDeposit(0);
        assertEq(afterDeposit.outstandingIntentAmount, beforeDeposit.outstandingIntentAmount - 50e6);
        assertEq(afterDeposit.remainingDeposits, beforeDeposit.remainingDeposits + (50e6 - RELEASE_AMOUNT));
    }
}
