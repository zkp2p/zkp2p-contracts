// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IntentSignalPolicy} from "contracts/hooks/IntentSignalPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract IntentSignalPolicyTest is OrchestratorV4Fixture {
    function test_AcceptsGatingServiceSignature() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, block.timestamp + 1 days);
        bytes32 id = _intentHash(orchestrator.intentCounter());
        _signalRaw(taker, params);
        assertEq(orchestrator.getIntent(id).owner, taker);
    }

    function test_IgnoresDepositGatingService() public {
        (address depositGatingService, uint256 depositGatingServiceKey) = makeAddrAndKey("depositGatingService");
        vm.startPrank(depositor);
        uint256 gatedDepositId = _createDeposit(depositGatingService, delegate);
        vm.stopPrank();
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.depositId = gatedDepositId;
        params.gatingServiceSignature =
            _gatingSignature(depositGatingServiceKey, taker, params, params.signatureExpiration);
        vm.expectRevert(IntentSignalPolicy.InvalidSignature.selector);
        _signalRaw(taker, params);

        bytes32 id = _signal(taker, params);
        assertEq(orchestrator.getIntent(id).depositId, gatedDepositId);
    }

    function test_RejectsMissingSignature() public {
        vm.expectRevert(IntentSignalPolicy.InvalidSignature.selector);
        _signalRaw(taker, _defaultParams());
    }

    function test_RejectsExpiredSignature() public {
        vm.warp(100);
        uint256 expiration = block.timestamp - 1;
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, expiration);
        vm.expectRevert(
            abi.encodeWithSelector(IntentSignalPolicy.SignatureExpired.selector, expiration, block.timestamp)
        );
        _signalRaw(taker, params);
    }

    function test_RejectsSignatureFromWrongSigner() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(0xBAD, taker, block.timestamp + 1 days);
        vm.expectRevert(IntentSignalPolicy.InvalidSignature.selector);
        _signalRaw(taker, params);
    }

    function test_RejectsSignatureForAnotherTaker() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, other, block.timestamp + 1 days);
        vm.expectRevert(IntentSignalPolicy.InvalidSignature.selector);
        _signalRaw(taker, params);
    }

    function test_SignatureCoversPayerCommitment() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, block.timestamp + 1 days);
        params.payerCommitment = "payer";
        vm.expectRevert(IntentSignalPolicy.InvalidSignature.selector);
        _signalRaw(taker, params);

        bytes32 id = _signal(taker, params);
        assertEq(orchestrator.getIntent(id).payerCommitment, "payer");
    }

    function test_SignatureBindsChain() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, block.timestamp + 1 days);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(IntentSignalPolicy.InvalidSignature.selector);
        _signalRaw(taker, params);
    }

    function test_SignatureBindsCallingOrchestrator() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, block.timestamp + 1 days);
        vm.expectRevert(IntentSignalPolicy.InvalidSignature.selector);
        signalPolicy.validateSignalIntent(taker, params);

        vm.prank(address(orchestrator));
        signalPolicy.validateSignalIntent(taker, params);
    }

    function test_NonRelayerMayHoldTwoOpenIntents() public {
        assertFalse(relayerRegistry.isWhitelistedRelayer(taker));
        _signalDefault();
        _signalDefault();
        assertEq(orchestrator.getAccountIntents(taker).length, 2);
    }
}
