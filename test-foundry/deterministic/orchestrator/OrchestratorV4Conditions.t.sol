// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract OrchestratorV4ConditionsTest is OrchestratorV4Fixture {
    bytes32 internal constant CONDITIONS = keccak256("conditions");

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

    function test_UnconditionedIntentRejectsNonZeroAttestedHash() public {
        bytes32 id = _signalDefault();
        uint256 escrowBalance = token.balanceOf(address(escrow));
        verifier.setExtensionData(abi.encode(CONDITIONS));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.ConditionsNotAttested.selector, id));
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(orchestrator.intentConditions(id), bytes32(0));
        assertEq(orchestrator.getIntent(id).owner, taker);
        assertEq(token.balanceOf(address(escrow)), escrowBalance);
        assertEq(token.balanceOf(taker), 0);
    }

    function test_UnconditionedIntentAcceptsZeroAttestedHashWithTrailingBytes() public {
        bytes32 id = _signalDefault();
        verifier.setExtensionData(bytes.concat(abi.encode(bytes32(0)), hex"010203"));
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
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

    function test_ConditionsEchoRequiredBeforeFundsMove() public {
        _useGatedDeposit();
        bytes32 id = _signalWithConditions(CONDITIONS);
        uint256 escrowBalance = token.balanceOf(address(escrow));
        bytes[4] memory extensions = [bytes(""), new bytes(31), abi.encode(bytes32(0)), abi.encode(keccak256("wrong"))];
        for (uint256 i; i < extensions.length; ++i) {
            verifier.setExtensionData(extensions[i]);
            vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.ConditionsNotAttested.selector, id));
            _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
            assertEq(orchestrator.intentConditions(id), CONDITIONS);
            assertEq(orchestrator.getIntent(id).owner, taker);
            assertEq(token.balanceOf(address(escrow)), escrowBalance);
            assertEq(token.balanceOf(taker), 0);
        }
    }

    function test_MatchingEchoAndReservedTrailingBytesAccepted() public {
        _useGatedDeposit();
        for (uint256 i; i < 2; ++i) {
            bytes32 id = _signalWithConditions(CONDITIONS);
            verifier.setExtensionData(
                i == 0 ? abi.encode(CONDITIONS) : bytes.concat(abi.encode(CONDITIONS), hex"010203")
            );
            _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
            assertEq(orchestrator.intentConditions(id), bytes32(0));
        }
        assertEq(token.balanceOf(taker), 2 * INTENT_AMOUNT);
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
    }
}
