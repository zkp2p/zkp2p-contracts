// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";

contract OrchestratorCancelTest is OrchestratorLegacyFixture {
    bytes32 internal subjectIntent;

    function setUp() public override {
        super.setUp();
        subjectIntent = _signal(onRamper, _baseSignalParams(onRamper));
    }

    function _cancel(address caller, bytes32 intentHash) internal {
        vm.prank(caller);
        orchestrator.cancelIntent(intentHash);
    }

    function test_CancelIntentUnlocksEscrowFunds() public {
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        assertEq(beforeDeposit.remainingDeposits, 50e6);
        assertEq(beforeDeposit.outstandingIntentAmount, 50e6);
        _cancel(onRamper, subjectIntent);
        IEscrow.Deposit memory afterDeposit = escrow.getDeposit(0);
        assertEq(afterDeposit.remainingDeposits, 100e6);
        assertEq(afterDeposit.outstandingIntentAmount, 0);
        assertEq(escrow.getDepositIntentHashes(0).length, 0);
    }

    function test_CancelIntentDeletesIntent() public {
        _cancel(onRamper, subjectIntent);
        assertEq(orchestrator.getIntent(subjectIntent).owner, address(0));
    }

    function test_CancelIntentDeletesMinimumSnapshot() public {
        assertEq(orchestrator.getIntentMinAtSignal(subjectIntent), 10e6);
        _cancel(onRamper, subjectIntent);
        assertEq(orchestrator.getIntentMinAtSignal(subjectIntent), 0);
    }

    function test_CancelIntentRemovesAccountIndex() public {
        assertEq(orchestrator.getAccountIntents(onRamper).length, 1);
        _cancel(onRamper, subjectIntent);
        assertEq(orchestrator.getAccountIntents(onRamper).length, 0);
    }

    function test_CancelIntentRejectsMissingIntent() public {
        bytes32 missingIntent = keccak256("nonexistent");
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.IntentNotFound.selector, missingIntent));
        _cancel(onRamper, missingIntent);
    }

    function test_CancelIntentRejectsNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.UnauthorizedCaller.selector, maliciousOnRamper, onRamper));
        _cancel(maliciousOnRamper, subjectIntent);
    }

    function test_CancelIntentSucceedsWhileEscrowPaused() public {
        escrow.pauseEscrow();
        _cancel(onRamper, subjectIntent);
        assertEq(orchestrator.getIntent(subjectIntent).owner, address(0));
        assertEq(escrow.getDeposit(0).remainingDeposits, 100e6);
    }
}
