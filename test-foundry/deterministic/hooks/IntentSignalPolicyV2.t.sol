// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IntentSignalPolicyV2} from "contracts/hooks/IntentSignalPolicyV2.sol";
import {IAddressGroupRegistry} from "contracts/interfaces/IAddressGroupRegistry.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract IntentSignalPolicyV2Test is OrchestratorV4Fixture {
    address internal defaultArbitrator;
    IntentSignalPolicyV2 internal policyV2;

    function setUp() public override {
        super.setUp();
        defaultArbitrator = makeAddr("defaultArbitrator");
        policyV2 = new IntentSignalPolicyV2(gatingService, whitelist, defaultArbitrator);
        orchestrator.setSignalPolicy(policyV2);
    }

    function test_PublicIntentGetsDefaultArbitrator() public {
        bytes32 id = _signalDefault();
        IOrchestratorV4.Intent memory intent = orchestrator.getIntent(id);
        assertEq(intent.arbitrator, defaultArbitrator);
        assertFalse(intent.takerWhitelisted);
    }

    function test_GroupArbitratorTakesPrecedence() public {
        address groupArbitrator = makeAddr("groupArbitrator");
        bytes32 groupId = _gateWithNewGroup();
        IAddressGroupRegistry groupRegistry = whitelist.groupRegistry();
        vm.prank(makeAddr("curator"));
        groupRegistry.setArbitrator(groupId, groupArbitrator);

        bytes32 id = _signal(taker, _groupParams(groupId));
        assertEq(orchestrator.getIntent(id).arbitrator, groupArbitrator);
        assertTrue(orchestrator.getIntent(id).takerWhitelisted);
    }

    function test_GroupWithoutArbitratorGetsDefault() public {
        bytes32 id = _signal(taker, _groupParams(_gateWithNewGroup()));
        assertEq(orchestrator.getIntent(id).arbitrator, defaultArbitrator);
    }

    function test_ZeroDefaultLeavesPublicIntentWithoutArbitrator() public {
        orchestrator.setSignalPolicy(new IntentSignalPolicyV2(gatingService, whitelist, address(0)));
        assertEq(orchestrator.getIntent(_signalDefault()).arbitrator, address(0));
    }

    function test_StillRequiresGatingSignature() public {
        vm.expectRevert(IntentSignalPolicyV2.InvalidSignature.selector);
        _signalRaw(taker, _defaultParams());
    }

    function test_SignatureAdmitsOneIntent() public {
        IOrchestratorV4.SignalIntentParams memory params = _signedDefaultParams();
        bytes32 messageHash = _gatingMessageHash(taker, params, params.signatureExpiration);
        bytes32 id = _intentHash(orchestrator.intentCounter());
        _signalRaw(taker, params);
        assertTrue(policyV2.usedMessageHashes(messageHash));

        // Cancelling restores the deposit's liquidity, so only the spent signature stops the replay.
        vm.prank(taker);
        orchestrator.cancelIntent(id);
        vm.expectRevert(abi.encodeWithSelector(IntentSignalPolicyV2.SignatureAlreadyUsed.selector, messageHash));
        _signalRaw(taker, params);
    }

    function test_FreshSignatureAdmitsAnotherIntent() public {
        _signalDefault();
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.signatureExpiration += 1;
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), 2);
    }

    function test_OtherCallerCannotSpendSignature() public {
        IOrchestratorV4.SignalIntentParams memory params = _signedDefaultParams();
        vm.prank(makeAddr("griefer"));
        vm.expectRevert(IntentSignalPolicyV2.InvalidSignature.selector);
        policyV2.validateSignalIntent(taker, params);

        _signalRaw(taker, params);
        assertTrue(policyV2.usedMessageHashes(_gatingMessageHash(taker, params, params.signatureExpiration)));
    }

    function _signedDefaultParams() internal view returns (IOrchestratorV4.SignalIntentParams memory params) {
        params = _defaultParams();
        params.gatingServiceSignature = _gatingSignature(gatingServiceKey, taker, params, params.signatureExpiration);
    }

    function _gateWithNewGroup() internal returns (bytes32 groupId) {
        IAddressGroupRegistry groupRegistry = whitelist.groupRegistry();
        address[] memory members = new address[](1);
        members[0] = taker;
        vm.startPrank(makeAddr("curator"));
        groupId = groupRegistry.createGroup("bonded");
        groupRegistry.addMembers(groupId, members);
        vm.stopPrank();

        bytes32[] memory groups = new bytes32[](1);
        groups[0] = groupId;
        vm.startPrank(depositor);
        whitelist.setEnabled(address(escrow), depositId, true);
        whitelist.setGroups(address(escrow), depositId, groups, true);
        vm.stopPrank();
    }

    function _groupParams(bytes32 _groupId) internal view returns (IOrchestratorV4.SignalIntentParams memory params) {
        params = _defaultParams();
        params.groupId = _groupId;
    }
}
