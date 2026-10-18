// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {SettlementPolicyMock} from "../../mocks/SettlementPolicyMock.sol";
import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract OrchestratorV4PolicyDataTest is OrchestratorV4Fixture {
    SettlementPolicyMock internal policyMock;
    bytes internal constant POLICY_DATA = hex"ff010203040506070809";

    function setUp() public override {
        super.setUp();
        policyMock = new SettlementPolicyMock();
        orchestrator.setSettlementPolicy(policyMock);
    }

    function test_NonEmptyDataRequiresGatingService() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.data = POLICY_DATA;
        bytes32 id = _intentHash(orchestrator.intentCounter());
        uint256 counter = orchestrator.intentCounter();
        vm.expectRevert(IOrchestratorV4.DataRequiresGatingService.selector);
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), counter);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);

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


    }

    function test_SeparatePolicyDataGetterDoesNotExist() public view {
        (bool success,) = address(orchestrator).staticcall(
            abi.encodeWithSignature("getIntentLifecyclePolicyData(bytes32)", bytes32(0))
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
                _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days + i);
            bytes32 id = _signal(taker, params);
            assertEq(orchestrator.getIntent(id).data, "");
            verifier.setExtensionData(extensions[i]);
            _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        }
        assertEq(token.balanceOf(taker), extensions.length * INTENT_AMOUNT);
    }

    function test_NonEmptyDataRequiresPolicy() public {
        _useGatedDeposit();
        orchestrator.setSettlementPolicy(IIntentSettlementPolicy(address(0)));
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.data = POLICY_DATA;
        params.gatingServiceSignature = _policyDataSignature(params, POLICY_DATA);
        uint256 counter = orchestrator.intentCounter();
        vm.expectRevert(IOrchestratorV4.DataRequiresPolicy.selector);
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), counter);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
    }

    function test_PlainIntentForwardsUninterpretedExtension() public {
        bytes32 id = _signalDefault();
        bytes memory raw = abi.encode(uint256(2), keccak256(POLICY_DATA), keccak256("reserved"));
        verifier.setExtensionData(raw);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        (,,,,,,,,,, bytes memory hookData, bytes memory forwarded, bool manual) = policyMock.lastSettlementContext();
        assertEq(hookData, "");
        assertEq(forwarded, raw);
        assertFalse(manual);
    }

    function test_SignalStoresAndForwardsDataWithZeroPostIntentHook() public {
        _useGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.data = POLICY_DATA;
        params.gatingServiceSignature = _policyDataSignature(params, POLICY_DATA);
        bytes32 id = _intentHash(orchestrator.intentCounter());
        vm.prank(taker);
        orchestrator.signalIntent(params);
        assertEq(orchestrator.getIntent(id).data, POLICY_DATA);


    }

    function test_EmptyDataUsesPlainGatingMessage() public {
        _useGatedDeposit();
        IOrchestratorV4.SignalIntentParams memory params =
            _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days);
        params.data = "";
        bytes memory plainSignature = params.gatingServiceSignature;
        params.gatingServiceSignature = _policyDataSignature(params, "");
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
        params.data = POLICY_DATA;
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
        params.gatingServiceSignature = _policyDataSignature(params, POLICY_DATA);
        params.data = "";
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
        params.data = hex"ff01020304050607080a";
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        vm.prank(taker);
        orchestrator.signalIntent(params);
    }

    function test_ForwardsRawExtensionAndPrePruneDataToSnapshottedPolicy() public {
        _useGatedDeposit();
        bytes32 id = _signalWithPolicyData(POLICY_DATA);
        orchestrator.setSettlementPolicy(IIntentSettlementPolicy(address(0)));
        bytes memory raw = hex"ff010203";
        verifier.setExtensionData(raw);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        (bytes32 settledId,,,,,,,,,, bytes memory hookData, bytes memory forwarded, bool manual) = policyMock.lastSettlementContext();
        assertEq(settledId, id);
        assertEq(hookData, POLICY_DATA);
        assertEq(forwarded, raw);
        assertFalse(manual);
        assertEq(policyMock.settlementCalls(), 1);
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(orchestrator.getIntent(id).owner, address(0));
    }

    function test_CancelClearsPolicyData() public {
        _useGatedDeposit();
        bytes32 id = _signalWithPolicyData(POLICY_DATA);
        vm.prank(taker);
        orchestrator.cancelIntent(id);
        assertEq(orchestrator.getIntent(id).data, "");
    }

    function test_PruneClearsPolicyData() public {
        _useGatedDeposit();
        bytes memory longData = abi.encode(uint256(99), keccak256("opaque"), type(uint256).max);
        bytes32 id = _signalWithPolicyData(longData);
        assertEq(orchestrator.getIntent(id).data, longData);
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.getIntent(id).data, "");
    }

    function test_OrphanCleanupClearsPolicyData() public {
        _useGatedDeposit();
        bytes32 id = _signalWithPolicyData(POLICY_DATA);
        vm.store(address(escrow), keccak256(abi.encode(id, uint256(15))), bytes32(0));
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(id).data, POLICY_DATA);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        orchestrator.cleanupOrphanedIntents(ids);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.getIntent(id).data, "");
    }

    function test_ManualReleaseForwardsPolicyDataAndClearsStorage() public {
        _useGatedDeposit();
        bytes32 id = _signalWithPolicyData(POLICY_DATA);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(orchestrator.getIntent(id).data, "");
        (,,,,,,,,,, bytes memory hookData, bytes memory forwarded, bool manual) = policyMock.lastSettlementContext();
        assertEq(hookData, POLICY_DATA);
        assertEq(forwarded, "");
        assertTrue(manual);
    }
}
