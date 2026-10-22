// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IntentGatingPolicy} from "contracts/hooks/IntentGatingPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract IntentGatingPolicyTest is OrchestratorV4Fixture {
    IntentGatingPolicy internal gatingPolicy;

    function setUp() public override {
        super.setUp();
        gatingPolicy = new IntentGatingPolicy(gatingService);
        orchestrator.setSignalPolicy(gatingPolicy);
    }

    function test_AcceptsGatingServiceSignature() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, block.timestamp + 1 days);
        bytes32 id = _signal(taker, params);
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
        vm.expectRevert(IntentGatingPolicy.InvalidSignature.selector);
        _signalCall(taker, params);

        params.gatingServiceSignature = _gatingSignature(gatingServiceKey, taker, params, params.signatureExpiration);
        bytes32 id = _signal(taker, params);
        assertEq(orchestrator.getIntent(id).depositId, gatedDepositId);
    }

    function test_RejectsMissingSignature() public {
        vm.expectRevert(IntentGatingPolicy.InvalidSignature.selector);
        _signalCall(taker, _defaultParams());
    }

    function test_RejectsExpiredSignature() public {
        vm.warp(100);
        uint256 expiration = block.timestamp - 1;
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, expiration);
        vm.expectRevert(
            abi.encodeWithSelector(IntentGatingPolicy.SignatureExpired.selector, expiration, block.timestamp)
        );
        _signalCall(taker, params);
    }

    function test_RejectsSignatureFromWrongSigner() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(0xBAD, taker, block.timestamp + 1 days);
        vm.expectRevert(IntentGatingPolicy.InvalidSignature.selector);
        _signalCall(taker, params);
    }

    function test_RejectsSignatureForAnotherTaker() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, other, block.timestamp + 1 days);
        vm.expectRevert(IntentGatingPolicy.InvalidSignature.selector);
        _signalCall(taker, params);
    }

    function test_SignatureCoversPayerCommitment() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, block.timestamp + 1 days);
        params.payerCommitment = "payer";
        vm.expectRevert(IntentGatingPolicy.InvalidSignature.selector);
        _signalCall(taker, params);

        params.gatingServiceSignature = _gatingSignature(gatingServiceKey, taker, params, params.signatureExpiration);
        bytes32 id = _signal(taker, params);
        assertEq(orchestrator.getIntent(id).payerCommitment, "payer");
    }

    function test_SignatureBindsChain() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, block.timestamp + 1 days);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(IntentGatingPolicy.InvalidSignature.selector);
        _signalCall(taker, params);
    }

    function test_SignatureBindsCallingOrchestrator() public {
        IOrchestratorV4.SignalIntentParams memory params = _gatedParams(gatingServiceKey, taker, block.timestamp + 1 days);
        vm.expectRevert(IntentGatingPolicy.InvalidSignature.selector);
        gatingPolicy.validateSignalIntent(taker, params);

        vm.prank(address(orchestrator));
        gatingPolicy.validateSignalIntent(taker, params);
    }
}
