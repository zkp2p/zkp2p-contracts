// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {DisputeProtectionStackV2Fixture} from "../helpers/DisputeProtectionStackV2Fixture.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";

contract SettlementPolicySwapTest is DisputeProtectionStackV2Fixture {
    function test_SuccessorSettlesWhilePredecessorReleasesAndClaimsOwnLock() public {
        bytes32 first = _signalDefault();
        _settle(first, INTENT_AMOUNT, RISK_WINDOW);
        P.DisputeProtectionIntent memory firstIntent = protection.getDisputeProtectionIntent(first);
        assertEq(uint256(firstIntent.collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
        assertEq(vault.lockController(first), address(protection));

        DisputeProtectionPolicyV2 successor =
            new DisputeProtectionPolicyV2(address(this), vault, disputeVerifier, disputeNullifiers);
        vault.setController(address(successor), true);
        disputeNullifiers.addWritePermission(address(successor));
        successor.setOrchestratorAuthorization(address(orchestrator), true);
        orchestrator.setSettlementPolicy(successor);
        assertTrue(vault.isController(address(protection)));
        assertTrue(vault.isController(address(successor)));

        vm.warp(block.timestamp + 1 hours);
        bytes32 second = _signalDefault();
        _settle(second, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(vault.lockController(second), address(successor));
        assertEq(
            uint256(successor.getDisputeProtectionIntent(second).status),
            uint256(P.DisputeProtectionIntentStatus.SETTLED)
        );
        assertEq(
            uint256(protection.getDisputeProtectionIntent(second).status), uint256(P.DisputeProtectionIntentStatus.NONE)
        );
        assertEq(
            uint256(successor.getDisputeProtectionIntent(first).status), uint256(P.DisputeProtectionIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(other), 2 * NET);

        vm.warp(firstIntent.releaseEligibleAt);
        protection.releaseMaturedDisputeProtectionIntent(first);
        assertEq(vault.lockController(first), address(0));
        assertEq(vault.lockedStake(other), NET);
        assertEq(vault.freeStake(other), NET);
        vm.prank(taker);
        protection.claimFor(first);
        assertEq(token.balanceOf(other), NET);
        assertEq(protection.getDisputeProtectionIntent(first).claimedAmount, NET);
        assertEq(vault.lockController(second), address(successor));
        assertEq(vault.freeStake(other), 0);

        vault.setController(address(protection), false);
        assertFalse(vault.isController(address(protection)));
        vm.warp(successor.getDisputeProtectionIntent(second).releaseEligibleAt);
        vm.prank(other);
        successor.claimFor(second);
        assertEq(token.balanceOf(other), 2 * NET);
        assertEq(vault.lockController(second), address(0));
        assertEq(vault.totalStaked(), 0);
        assertEq(vault.totalAccounted(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }
}
