// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {DisputeProtectionStackV2Fixture} from "../helpers/DisputeProtectionStackV2Fixture.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";

contract SettlementPolicySwapTest is DisputeProtectionStackV2Fixture {
    function test_SuccessorSettlesWhilePredecessorReleasesOwnLock() public {
        bytes32 first = _signalDefault();
        _settle(first, INTENT_AMOUNT, RISK_WINDOW);
        (address firstOwner,, uint64 firstMaturesAt) = vault.locks(first);
        assertEq(firstOwner, other);
        assertEq(vault.lockController(first), address(protection));

        DisputeProtectionPolicyV2 successor =
            new DisputeProtectionPolicyV2(address(this), vault, disputeVerifier, disputeNullifiers, orchestratorRegistry);
        vault.setController(address(successor), true);
        disputeNullifiers.addWritePermission(address(successor));
        orchestrator.setSettlementPolicy(successor);
        assertTrue(vault.isController(address(protection)));
        assertTrue(vault.isController(address(successor)));

        vm.warp(block.timestamp + 1 hours);
        bytes32 second = _signalDefault();
        _settle(second, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(vault.lockController(second), address(successor));
        assertEq(successor.getProtection(second).depositor, depositor);
        assertEq(protection.getProtection(second).depositor, address(0));
        assertEq(successor.getProtection(first).depositor, address(0));
        assertEq(vault.lockedStake(other), 2 * NET);

        vm.warp(firstMaturesAt);
        protection.release(_ids(first));
        assertEq(vault.lockController(first), address(0));
        assertEq(vault.lockedStake(other), NET);
        assertEq(vault.freeStake(other), 0);
        assertEq(token.balanceOf(other), NET);
        assertEq(vault.lockController(second), address(successor));

        vault.setController(address(protection), false);
        assertFalse(vault.isController(address(protection)));
        (,, uint64 secondMaturesAt) = vault.locks(second);
        vm.warp(secondMaturesAt);
        successor.release(_ids(second));
        assertEq(token.balanceOf(other), 2 * NET);
        assertEq(vault.lockController(second), address(0));
        assertEq(vault.totalStaked(), 0);
        assertEq(vault.totalAccounted(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function _ids(bytes32 id) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }
}
