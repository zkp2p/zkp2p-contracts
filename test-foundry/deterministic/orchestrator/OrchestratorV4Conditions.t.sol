// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {LifecycleHookV2Mock} from "../../mocks/LifecycleHookV2Mock.sol";
import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IIntentLifecycleHookV2} from "contracts/interfaces/IIntentLifecycleHookV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract OrchestratorV4ConditionsTest is OrchestratorV4Fixture {
    LifecycleHookV2Mock internal lifecycleHookMock;
    bytes32 internal constant CONDITIONS = keccak256("conditions");

    function setUp() public override {
        super.setUp();
        lifecycleHookMock = new LifecycleHookV2Mock();
        orchestrator.setLifecycleHook(lifecycleHookMock);
    }

    function test_ConditionsRequireGatingService() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.conditionsHash = CONDITIONS;
        vm.expectRevert(IOrchestratorV4.ConditionsRequireGatingService.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
    }

    function _useGatedDeposit() internal {
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
    }

    function test_PlainSignalPreservesGatingAndAcceptsAbsentOrZeroAttestedHash() public {
        _useGatedDeposit();
        bytes[4] memory extensions = [bytes(""), bytes(hex"01"), new bytes(31), abi.encode(bytes32(0))];
        for (uint256 i; i < extensions.length; ++i) {
            IOrchestratorV4.SignalIntentParams memory params =
                _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days);
            bytes32 id = _signal(taker, params);
            assertEq(orchestrator.intentConditions(id), bytes32(0));
            verifier.setExtensionData(extensions[i]);
            _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        }
        assertEq(token.balanceOf(taker), extensions.length * INTENT_AMOUNT);
    }

    function test_ConditionsRequireLifecycleHook() public {
        _useGatedDeposit();
        orchestrator.setLifecycleHook(IIntentLifecycleHookV2(address(0)));
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.conditionsHash = CONDITIONS;
        params.gatingServiceSignature = _conditionsSignature(params, CONDITIONS);
        uint256 counter = orchestrator.intentCounter();
        vm.expectRevert(IOrchestratorV4.ConditionsRequireLifecycleHook.selector);
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), counter);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
    }

    function test_UnconditionedIntentForwardsUninterpretedExtension() public {
        bytes32 id = _signalDefault();
        bytes memory raw = abi.encode(uint256(2), CONDITIONS, keccak256("reserved"));
        verifier.setExtensionData(raw);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        (,,,,, bytes32 conditions, bytes memory forwarded, bool manual) = lifecycleHookMock.lastSettlementContext();
        assertEq(conditions, bytes32(0));
        assertEq(forwarded, raw);
        assertFalse(manual);
    }

    function test_ConditionedSignalStoresHashAndPreservesHookData() public {
        _useGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.data = hex"deadbeef";
        params.conditionsHash = CONDITIONS;
        params.gatingServiceSignature = _conditionsSignature(params, CONDITIONS);
        bytes32 id = _intentHash(orchestrator.intentCounter());
        vm.prank(taker);
        orchestrator.signalIntent(params);
        assertEq(orchestrator.intentConditions(id), CONDITIONS);
        assertEq(orchestrator.getIntent(id).data, hex"deadbeef");
    }

    function test_ZeroConditionsUsesPlainGatingMessage() public {
        _useGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params =
            _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days);
        params.conditionsHash = bytes32(0);
        bytes memory plainSignature = params.gatingServiceSignature;
        params.gatingServiceSignature = _conditionsSignature(params, bytes32(0));
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        _signalCall(taker, params);
        params.gatingServiceSignature = plainSignature;
        bytes32 id = _signal(taker, params);
        assertEq(orchestrator.intentConditions(id), bytes32(0));
        assertEq(orchestrator.getIntent(id).owner, taker);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_GatingSignaturesCannotCrossPathsOrConditions() public {
        _useGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params =
            _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days);
        params.conditionsHash = CONDITIONS;
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
        params.gatingServiceSignature = _conditionsSignature(params, CONDITIONS);
        params.conditionsHash = bytes32(0);
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
        params.conditionsHash = keccak256("other conditions");
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
    }

    function test_ForwardsRawExtensionAndPrePruneConditionsToSnapshottedHook() public {
        _useGatedDeposit();
        bytes32 id = _signalWithConditions(CONDITIONS);
        orchestrator.setLifecycleHook(IIntentLifecycleHookV2(address(0)));
        bytes memory raw = hex"ff010203";
        verifier.setExtensionData(raw);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        (bytes32 settledId,,,,, bytes32 conditions, bytes memory forwarded, bool manual) = lifecycleHookMock.lastSettlementContext();
        assertEq(settledId, id);
        assertEq(conditions, CONDITIONS);
        assertEq(forwarded, raw);
        assertFalse(manual);
        assertEq(lifecycleHookMock.settlementCalls(), 1);
        assertEq(orchestrator.intentConditions(id), bytes32(0));
        assertEq(orchestrator.getIntent(id).owner, address(0));
    }

    function test_CancelClearsConditions() public {
        _useGatedDeposit();
        bytes32 id = _signalWithConditions(CONDITIONS);
        vm.prank(taker);
        orchestrator.cancelIntent(id);
        assertEq(orchestrator.intentConditions(id), bytes32(0));
    }

    function test_PruneClearsConditions() public {
        _useGatedDeposit();
        bytes32 id = _signalWithConditions(CONDITIONS);
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.intentConditions(id), bytes32(0));
    }

    function test_OrphanCleanupClearsConditions() public {
        _useGatedDeposit();
        bytes32 id = _signalWithConditions(CONDITIONS);
        vm.store(address(escrow), keccak256(abi.encode(id, uint256(15))), bytes32(0));
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.intentConditions(id), CONDITIONS);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        orchestrator.cleanupOrphanedIntents(ids);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.intentConditions(id), bytes32(0));
    }

    function test_ManualReleaseIgnoresConditionsAndClearsHash() public {
        _useGatedDeposit();
        bytes32 id = _signalWithConditions(CONDITIONS);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(orchestrator.intentConditions(id), bytes32(0));
        (,,,,, bytes32 conditions, bytes memory forwarded, bool manual) = lifecycleHookMock.lastSettlementContext();
        assertEq(conditions, CONDITIONS);
        assertEq(forwarded, "");
        assertTrue(manual);
    }
}
