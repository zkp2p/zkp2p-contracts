// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {DisputePolicyFixture} from "../helpers/DisputePolicyFixture.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {WhitelistLifecycleHook} from "contracts/hooks/WhitelistLifecycleHook.sol";

contract PaymentPolicyAdmissionTest is DisputePolicyFixture {
    function test_SharedHookAdmitsAndSettlesAcrossOrchestrators() public {
        bytes32 first = _bypass();
        OrchestratorV3 firstOrchestrator = orchestrator;
        orchestrator = new OrchestratorV3(
            address(this), CHAIN_ID, address(escrowRegistry), address(paymentVerifierRegistry),
            address(relayerRegistry), 0, protocolFeeRecipient
        );
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        orchestrator.setLifecycleHook(hook);
        policy.registerPolicyRoute(address(orchestrator), address(upv), address(signatures));
        bytes32 second = _bypass();
        assertNotEq(first, second);
        assertEq(policy.getPolicyIntent(first).orchestrator, address(firstOrchestrator));
        assertEq(policy.getPolicyIntent(second).orchestrator, address(orchestrator));
        assertEq(policy.getPolicyIntent(first).lifecycleHook, address(hook));
        assertEq(policy.getPolicyIntent(second).lifecycleHook, address(hook));

        vm.prank(address(orchestrator));
        vm.expectRevert("DPP: Wrong admission orchestrator");
        hook.onIntentCancelled(first);
        vm.prank(address(orchestrator));
        vm.expectRevert("DPP: Wrong admission orchestrator");
        hook.settleIntent(IIntentLifecycleHook.SettlementContext(first, address(token), taker, INTENT_AMOUNT, INTENT_AMOUNT, true));
        _status(first, IDisputeProtectionPolicy.PolicyIntentStatus.PENDING);

        _complete(second, _attestation(second, keccak256("second-payment"), POLICY, INTENT_AMOUNT));
        orchestrator = firstOrchestrator;
        _complete(first, _attestation(first, PAYMENT, POLICY, INTENT_AMOUNT));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT * 2);
    }

    function test_MissingRouteRejectsBeforeCollateralOrLiquidityIsLocked() public {
        orchestrator = new OrchestratorV3(
            address(this), CHAIN_ID, address(escrowRegistry), address(paymentVerifierRegistry),
            address(relayerRegistry), 0, protocolFeeRecipient
        );
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        orchestrator.setLifecycleHook(hook);
        vm.expectRevert("DPP: Missing policy route");
        _signalCall(taker, _policyParams(POLICY));
        assertEq(orchestrator.intentCounter(), 0);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_NoHookRejectsUnconsumedAdmissionData() public {
        orchestrator.setLifecycleHook(IIntentLifecycleHook(address(0)));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.InvalidLifecycleHook.selector, address(0)));
        _signalCall(taker, _policyParams(POLICY));
        assertEq(orchestrator.intentCounter(), 0);
    }

    function test_WhitelistHookRejectsPolicyData() public {
        orchestrator.setLifecycleHook(new WhitelistLifecycleHook(orchestratorRegistry, whitelist));
        vm.expectRevert("Whitelist: Unexpected admission data");
        _signalCall(taker, _policyParams(POLICY));
        assertEq(orchestrator.intentCounter(), 0);
    }

    function test_UnmanagedOrderCannotSilentlyDropNamedPolicy() public {
        vm.prank(depositor);
        policy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, false);
        vm.expectRevert("Hook: Unmanaged policy");
        _signalCall(taker, _policyParams(POLICY));
        assertEq(orchestrator.intentCounter(), 0);
    }

    function testFuzz_TrailingAdmissionBytesReject(uint8 extraLength) public {
        extraLength = uint8(bound(extraLength, 1, 255));
        IOrchestratorV3.SignalIntentParams memory params = _policyParams(POLICY);
        params.lifecycleHookData = bytes.concat(params.lifecycleHookData, new bytes(extraLength));
        vm.expectRevert("Hook: Invalid policy data");
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), 0);
    }
}
