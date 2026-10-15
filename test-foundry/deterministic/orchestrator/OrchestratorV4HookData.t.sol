// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {LifecycleHookV2Mock} from "../../mocks/LifecycleHookV2Mock.sol";
import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IIntentLifecycleHookV2} from "contracts/interfaces/IIntentLifecycleHookV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract OrchestratorV4HookDataTest is OrchestratorV4Fixture {
    LifecycleHookV2Mock internal lifecycleHookMock;
    bytes internal constant HOOK_DATA = hex"ff010203040506070809";

    function setUp() public override {
        super.setUp();
        lifecycleHookMock = new LifecycleHookV2Mock();
        orchestrator.setLifecycleHook(lifecycleHookMock);
    }

    function test_NonEmptyDataRequiresGatingService() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.data = HOOK_DATA;
        bytes32 id = _intentHash(orchestrator.intentCounter());
        uint256 counter = orchestrator.intentCounter();
        vm.expectRevert(IOrchestratorV4.LifecycleHookDataRequiresGatingService.selector);
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), counter);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
        assertEq(lifecycleHookMock.signaledCalls(), 0);
    }

    function test_EmptyDataWithoutGatingServiceSignalsPlainly() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        assertEq(escrow.getDepositGatingService(depositId, METHOD), address(0));
        assertEq(params.data, "");
        assertEq(params.gatingServiceSignature, "");
        bytes32 id = _signal(taker, params);
        assertEq(orchestrator.getIntent(id).owner, taker);
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, INTENT_AMOUNT);
        assertEq(lifecycleHookMock.lastSignaledLifecycleHookData(), "");
        assertEq(lifecycleHookMock.signaledCalls(), 1);
    }

    function test_SeparateHookDataGetterDoesNotExist() public view {
        (bool success,) = address(orchestrator).staticcall(
            abi.encodeWithSignature("getIntentLifecycleHookData(bytes32)", bytes32(0))
        );
        assertFalse(success);
    }

    function _useGatedDeposit() internal {
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
    }

    function test_PlainSignalPreservesGatingAndForwardsAnyExtension() public {
        _useGatedDeposit();
        bytes[4] memory extensions = [bytes(""), bytes(hex"01"), new bytes(31), abi.encode(bytes32(0))];
        for (uint256 i; i < extensions.length; ++i) {
            IOrchestratorV4.SignalIntentParams memory params =
                _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days);
            bytes32 id = _signal(taker, params);
            assertEq(orchestrator.getIntent(id).data, "");
            verifier.setExtensionData(extensions[i]);
            _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        }
        assertEq(token.balanceOf(taker), extensions.length * INTENT_AMOUNT);
    }

    function test_NonEmptyDataRequiresLifecycleHook() public {
        _useGatedDeposit();
        orchestrator.setLifecycleHook(IIntentLifecycleHookV2(address(0)));
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.data = HOOK_DATA;
        params.gatingServiceSignature = _lifecycleHookDataSignature(params, HOOK_DATA);
        uint256 counter = orchestrator.intentCounter();
        vm.expectRevert(IOrchestratorV4.LifecycleHookDataRequiresHook.selector);
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), counter);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
    }

    function test_PlainIntentForwardsUninterpretedExtension() public {
        bytes32 id = _signalDefault();
        bytes memory raw = abi.encode(uint256(2), keccak256(HOOK_DATA), keccak256("reserved"));
        verifier.setExtensionData(raw);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        (,,,,,,,,,, bytes memory hookData, bytes memory forwarded, bool manual) = lifecycleHookMock.lastSettlementContext();
        assertEq(hookData, "");
        assertEq(forwarded, raw);
        assertFalse(manual);
    }

    function test_SignalStoresAndForwardsDataWithZeroPostIntentHook() public {
        _useGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.data = HOOK_DATA;
        params.gatingServiceSignature = _lifecycleHookDataSignature(params, HOOK_DATA);
        bytes32 id = _intentHash(orchestrator.intentCounter());
        vm.prank(taker);
        orchestrator.signalIntent(params);
        assertEq(orchestrator.getIntent(id).data, HOOK_DATA);
        assertEq(lifecycleHookMock.lastSignaledLifecycleHookData(), HOOK_DATA);
        assertEq(lifecycleHookMock.lastIntentHash(), id);
    }

    function test_EmptyDataUsesPlainGatingMessage() public {
        _useGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params =
            _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days);
        params.data = "";
        bytes memory plainSignature = params.gatingServiceSignature;
        params.gatingServiceSignature = _lifecycleHookDataSignature(params, "");
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        _signalCall(taker, params);
        params.gatingServiceSignature = plainSignature;
        bytes32 id = _signal(taker, params);
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(orchestrator.getIntent(id).owner, taker);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_GatingSignaturesCannotCrossPathsOrData() public {
        _useGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params =
            _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days);
        params.data = HOOK_DATA;
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
        params.gatingServiceSignature = _lifecycleHookDataSignature(params, HOOK_DATA);
        params.data = "";
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
        params.data = hex"ff01020304050607080a";
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
    }

    function test_ForwardsRawExtensionAndPrePruneDataToSnapshottedHook() public {
        _useGatedDeposit();
        bytes32 id = _signalWithLifecycleHookData(HOOK_DATA);
        orchestrator.setLifecycleHook(IIntentLifecycleHookV2(address(0)));
        bytes memory raw = hex"ff010203";
        verifier.setExtensionData(raw);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        (bytes32 settledId,,,,,,,,,, bytes memory hookData, bytes memory forwarded, bool manual) = lifecycleHookMock.lastSettlementContext();
        assertEq(settledId, id);
        assertEq(hookData, HOOK_DATA);
        assertEq(forwarded, raw);
        assertFalse(manual);
        assertEq(lifecycleHookMock.settlementCalls(), 1);
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(orchestrator.getIntent(id).owner, address(0));
    }

    function test_CancelClearsHookData() public {
        _useGatedDeposit();
        bytes32 id = _signalWithLifecycleHookData(HOOK_DATA);
        vm.prank(taker);
        orchestrator.cancelIntent(id);
        assertEq(orchestrator.getIntent(id).data, "");
    }

    function test_PruneClearsHookData() public {
        _useGatedDeposit();
        bytes memory longData = abi.encode(uint256(99), keccak256("opaque"), type(uint256).max);
        bytes32 id = _signalWithLifecycleHookData(longData);
        assertEq(orchestrator.getIntent(id).data, longData);
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.getIntent(id).data, "");
    }

    function test_OrphanCleanupClearsHookData() public {
        _useGatedDeposit();
        bytes32 id = _signalWithLifecycleHookData(HOOK_DATA);
        vm.store(address(escrow), keccak256(abi.encode(id, uint256(15))), bytes32(0));
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(id).data, HOOK_DATA);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        orchestrator.cleanupOrphanedIntents(ids);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.getIntent(id).data, "");
    }

    function test_ManualReleaseForwardsHookDataAndClearsStorage() public {
        _useGatedDeposit();
        bytes32 id = _signalWithLifecycleHookData(HOOK_DATA);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(orchestrator.getIntent(id).data, "");
        (,,,,,,,,,, bytes memory hookData, bytes memory forwarded, bool manual) = lifecycleHookMock.lastSettlementContext();
        assertEq(hookData, HOOK_DATA);
        assertEq(forwarded, "");
        assertTrue(manual);
    }
}
