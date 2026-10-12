// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {BypassDisputeStackDeploymentTest} from "./BypassDisputeStackDeployment.t.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";

/// @dev Local already-activated fixture. The TypeScript lane separately gates writer removal on no old activity.
contract StagingBypassReplacementDeploymentTest is BypassDisputeStackDeploymentTest {
    StakeVault internal replacementVault;
    DisputeProtectionPolicy internal replacementPolicy;
    IntentLifecycleHookV1 internal replacementHook;

    function _replaceTrio(bool removeUnusedWriter) internal {
        replacementVault = new StakeVault(address(this), token, address(0), 0);
        replacementPolicy =
            new DisputeProtectionPolicy(address(this), replacementVault, disputeVerifier, disputeNullifiers);
        replacementVault.initializeController(address(replacementPolicy));
        replacementHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, replacementPolicy);
        replacementPolicy.setLifecycleHookAuthorization(address(replacementHook), true);
        replacementPolicy.setRiskWindow(PAYPAL, RISK_WINDOW);
        replacementPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        disputeNullifiers.addWritePermission(address(replacementPolicy));
        orchestrator.setLifecycleHook(replacementHook);
        if (removeUnusedWriter) disputeNullifiers.removeWritePermission(address(freshPolicy));
    }

    function test_ReplacementEndStatePreservesUPV4AndWriterOrder() public {
        _activateLane46();
        _replaceTrio(true);
        assertNotEq(address(replacementVault), address(freshVault));
        assertNotEq(address(replacementPolicy), address(freshPolicy));
        assertNotEq(address(replacementHook), address(freshHook));
        assertEq(replacementVault.owner(), address(this));
        assertEq(replacementVault.pendingOwner(), address(0));
        assertEq(address(replacementVault.stakeToken()), address(token));
        assertEq(replacementVault.controllerChangeDelay(), 0);
        assertEq(replacementVault.controller(), address(replacementPolicy));
        assertEq(replacementVault.pendingController(), address(0));
        assertEq(replacementVault.pendingControllerValidAt(), 0);
        assertEq(replacementPolicy.owner(), address(this));
        assertEq(replacementPolicy.pendingOwner(), address(0));
        assertEq(address(replacementPolicy.stakeVault()), address(replacementVault));
        assertEq(address(replacementPolicy.disputeVerifier()), address(disputeVerifier));
        assertEq(address(replacementPolicy.disputeNullifierRegistry()), address(disputeNullifiers));
        assertFalse(replacementPolicy.admissionsPaused());
        assertTrue(replacementPolicy.isLifecycleHookAuthorized(address(replacementHook)));
        assertFalse(replacementPolicy.isLifecycleHookAuthorized(address(freshHook)));
        assertEq(replacementPolicy.getRiskWindow(PAYPAL), RISK_WINDOW);
        assertEq(replacementPolicy.getRiskWindow(METHOD), RISK_WINDOW);
        assertEq(replacementPolicy.getRiskWindow(ZELLE), 0);
        assertEq(address(replacementHook.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(replacementHook.whitelistPolicy()), address(whitelist));
        assertEq(address(replacementHook.disputeProtectionPolicy()), address(replacementPolicy));
        assertEq(address(orchestrator.lifecycleHook()), address(replacementHook));
        address[] memory writers = new address[](2);
        writers[0] = address(predecessorPolicy);
        writers[1] = address(replacementPolicy);
        assertEq(disputeNullifiers.getWriters(), writers);
        writers = new address[](1);
        writers[0] = address(successor);
        assertEq(nullifiers.getWriters(), writers);
        assertEq(paymentVerifierRegistry.getPaymentMethods(), originalMethods);
        assertEq(successor.getPaymentMethods(), originalMethods);
        for (uint256 index; index < originalMethods.length; index++) {
            bytes32 method = originalMethods[index];
            assertEq(paymentVerifierRegistry.getVerifier(method), address(successor));
            assertEq(paymentVerifierRegistry.getCurrencies(method), originalCurrencies[method]);
        }
        assertEq(freshVault.controller(), address(freshPolicy));
        assertFalse(freshPolicy.admissionsPaused());
        assertTrue(freshPolicy.isLifecycleHookAuthorized(address(freshHook)));
    }

    function test_ReplacementNoStakeUsesZeroOwnerAndStakedIntentLocksNewVault() public {
        _activateLane46();
        _replaceTrio(true);
        bytes32 noStake = _signalProtected(replacementPolicy, true);
        address owner = replacementPolicy.getDisputeProtectionIntent(noStake).stakeOwner;
        assertEq(owner, address(0));
        assertTrue(replacementPolicy.isIntentNoStake(noStake));
        assertEq(replacementVault.lockedStake(taker), 0);
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(replacementVault), INTENT_AMOUNT);
        replacementVault.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
        bytes32 staked = _signalProtected(replacementPolicy, false);
        owner = replacementPolicy.getDisputeProtectionIntent(staked).stakeOwner;
        assertEq(owner, taker);
        assertFalse(replacementPolicy.isIntentNoStake(staked));
        assertEq(replacementVault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(freshVault.lockedStake(taker), 0);
    }

    function test_ReplacementHookRejectsSupersededPolicyData() public {
        _activateLane46();
        _replaceTrio(true);
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.data = abi.encode(address(freshPolicy), abi.encode(true));
        vm.expectRevert("ILH: Invalid payment validation hook");
        _signalCall(taker, params);
    }

    function test_SupersededHookIntentsCanCancelAndSettleAfterSwitch() public {
        _activateLane46();
        token.transfer(taker, 2 * INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(freshVault), 2 * INTENT_AMOUNT);
        freshVault.depositStake(2 * INTENT_AMOUNT);
        vm.stopPrank();
        bytes32 cancelled = _signalProtected(freshPolicy, false);
        bytes32 settled = _signalProtected(freshPolicy, false);
        // Activity would stop lane 47 before writer removal. Reproduce precisely that prefix.
        _replaceTrio(false);
        assertEq(address(orchestrator.getIntentLifecycleHook(cancelled)), address(freshHook));
        assertEq(address(orchestrator.getIntentLifecycleHook(settled)), address(freshHook));
        vm.prank(taker);
        orchestrator.cancelIntent(cancelled);
        _settle(settled, _signedProof(settled, keccak256("old-hook-after-replacement"), successor.DOMAIN_SEPARATOR()));
        IDisputeProtectionPolicy.DisputeProtectionIntentStatus cancelledStatus =
        freshPolicy.getDisputeProtectionIntent(cancelled).status;
        IDisputeProtectionPolicy.DisputeProtectionIntentStatus settledStatus =
        freshPolicy.getDisputeProtectionIntent(settled).status;
        assertEq(uint256(cancelledStatus), uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.CANCELLED));
        assertEq(uint256(settledStatus), uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(freshVault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(replacementVault.lockedStake(taker), 0);
        assertFalse(freshPolicy.admissionsPaused());
        assertTrue(freshPolicy.isLifecycleHookAuthorized(address(freshHook)));
        assertEq(freshVault.controller(), address(freshPolicy));
    }
}
