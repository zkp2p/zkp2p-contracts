// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerBoundaryFixture} from "../helpers/RiskManagerBoundaryFixture.sol";
import {IntentRiskHookMock} from "contracts/mocks/IntentRiskHookMock.sol";
import {
    IOrchestratorV3ReentryTarget,
    OrchestratorV3ReentrantRiskHook
} from "contracts/mocks/OrchestratorV3HarnessMocks.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";

contract OrchestratorV3ControlRecoveryTest is RiskManagerBoundaryFixture {
    event RiskCallbackGasLimitUpdated(uint256 gasLimit);

    function test_DepositorCanSetAndClearRiskHookButRegisteredDelegateCannot() public {
        assertEq(escrow.getDeposit(0).delegate, makerDelegate);
        IntentRiskHookMock hook = new IntentRiskHookMock();
        vm.prank(maker);
        orchestrator.setDepositRiskHook(address(escrow), 0, IIntentRiskHook(address(hook)));
        assertEq(address(orchestrator.getDepositRiskHook(address(escrow), 0)), address(hook));

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.UnauthorizedCaller.selector, makerDelegate, maker));
        vm.prank(makerDelegate);
        orchestrator.setDepositRiskHook(address(escrow), 0, IIntentRiskHook(address(0)));

        vm.prank(maker);
        orchestrator.setDepositRiskHook(address(escrow), 0, IIntentRiskHook(address(0)));
        assertEq(address(orchestrator.getDepositRiskHook(address(escrow), 0)), address(0));
    }

    function test_OrchestratorV3ExposesHookSnapshotsAndGuardedGovernance() public {
        assertEq(address(orchestrator.getDepositRiskHook(address(escrow), 0)), address(manager));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        vm.prank(other);
        orchestrator.setRiskCallbackGasLimit(1_000_000);
        vm.expectPartialRevert(IOrchestratorV3.RiskCallbackGasLimitTooLow.selector);
        orchestrator.setRiskCallbackGasLimit(749_999);
        vm.expectEmit(false, false, false, true, address(orchestrator));
        emit RiskCallbackGasLimitUpdated(1_000_000);
        orchestrator.setRiskCallbackGasLimit(1_000_000);

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.UnauthorizedCaller.selector, other, maker));
        vm.prank(other);
        orchestrator.setDepositRiskHook(address(escrow), 0, IIntentRiskHook(address(0)));
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        vm.prank(maker);
        orchestrator.setDepositRiskHook(address(0), 0, IIntentRiskHook(address(0)));
        vm.expectPartialRevert(IOrchestratorV3.InvalidRiskHook.selector);
        vm.prank(maker);
        orchestrator.setDepositRiskHook(address(escrow), 0, IIntentRiskHook(other));

        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        assertEq(address(orchestrator.getIntentRiskHook(intentHash)), address(manager));
        assertEq(orchestrator.getRiskIntent(intentHash).owner, taker);
        bytes32[] memory candidates = new bytes32[](2);
        candidates[0] = keccak256("unknown-orphan");
        candidates[1] = intentHash;
        orchestrator.cleanupOrphanedIntents(candidates);
        assertEq(address(orchestrator.getIntentRiskHook(intentHash)), address(manager));
    }

    function test_OrchestratorV3FailsClosedWhenVerifiedOrManualSettlementReverts() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        _selectRiskHook(IIntentRiskHook(address(hook)));
        hook.setRevertOnCallback(true);
        bytes32 verifiedIntent = _signalDefault(taker, 20e6, ZELLE);
        vm.expectPartialRevert(IOrchestratorV3.RiskHookSettlementFailed.selector);
        _fulfill(verifiedIntent, 20e6);
        assertEq(orchestrator.getIntent(verifiedIntent).owner, taker);
        bytes32 manualIntent = _signalDefault(taker, 20e6, ZELLE);
        vm.expectPartialRevert(IOrchestratorV3.RiskHookSettlementFailed.selector);
        vm.prank(maker);
        orchestrator.releaseFundsToPayer(manualIntent);
        assertEq(orchestrator.getIntent(manualIntent).owner, taker);
    }

    function test_OrchestratorV3UsesSnapshottedHookAfterDepositHookChanges() public {
        IntentRiskHookMock hook = new IntentRiskHookMock();
        _selectRiskHook(IIntentRiskHook(address(hook)));
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        vm.prank(maker);
        orchestrator.setDepositRiskHook(address(escrow), 0, IIntentRiskHook(address(0)));
        vm.prank(maker);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(hook.settlementCalls(), 1);
    }

    function test_OrchestratorV3BlocksReentryAcrossGuardedLifecycleEntrypoints() public {
        OrchestratorV3ReentrantRiskHook hook =
            new OrchestratorV3ReentrantRiskHook(IOrchestratorV3ReentryTarget(address(orchestrator)), address(escrow));
        hook.setReenterOnCreate(true);
        _selectRiskHook(IIntentRiskHook(address(hook)));
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        assertFalse(hook.setterReentrySucceeded());
        _fulfill(intentHash, 20e6);
        assertFalse(hook.cancelReentrySucceeded());
        assertFalse(hook.cleanupReentrySucceeded());
    }
}
