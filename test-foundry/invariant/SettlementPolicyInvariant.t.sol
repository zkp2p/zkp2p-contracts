// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {DisputeProtectionStackV2Fixture} from "../deterministic/helpers/DisputeProtectionStackV2Fixture.sol";
import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";

/// @notice Exercises real O4/UPV4 settlement while governance selection and live exemptions change.
contract SettlementPolicyHandler is DisputeProtectionStackV2Fixture {
    bytes32[] public settled;

    constructor() { setUp(); }

    function settle(bool enabledAtSignal, bool enableAfterSignal, bool staked, bool zeroWindow, bool manual, bool exempt) external {
        if (escrow.getDeposit(depositId).remainingDeposits < INTENT_AMOUNT) return;
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, false);
        orchestrator.setSettlementPolicy(enabledAtSignal ? IIntentSettlementPolicy(address(protection)) : IIntentSettlementPolicy(address(0)));
        if (exempt) {
            address[] memory allowed = new address[](1);
            allowed[0] = taker;
            vm.prank(depositor);
            whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), allowed);
        }
        bytes32 id = _signalDefault();
        orchestrator.setSettlementPolicy(enableAfterSignal ? IIntentSettlementPolicy(address(protection)) : IIntentSettlementPolicy(address(0)));
        if (staked && vault.freeStake(taker) < INTENT_AMOUNT) _stake(vault, taker, INTENT_AMOUNT);
        uint256 recipientBefore = token.balanceOf(other);
        bool protected = enableAfterSignal && !manual && !zeroWindow && !exempt;
        bool hasStake = vault.freeStake(taker) >= INTENT_AMOUNT;
        if (manual) {
            vm.prank(depositor);
            orchestrator.releaseFundsToPayer(id, INTENT_AMOUNT);
        } else {
            _settle(id, INTENT_AMOUNT, zeroWindow ? 0 : RISK_WINDOW);
        }
        (address owner, uint256 amount,) = vault.locks(id);
        if (!protected) {
            assertEq(protection.getProtection(id).depositor, address(0));
            assertEq(amount, 0);
            assertEq(token.balanceOf(other) - recipientBefore, NET);
        } else {
            assertEq(protection.getProtection(id).depositor, depositor);
            assertEq(owner, hasStake ? taker : other);
            assertEq(amount, hasStake ? INTENT_AMOUNT : NET);
            assertEq(token.balanceOf(other) - recipientBefore, hasStake ? NET : 0);
        }
        settled.push(id);
    }

    function release(uint256 index) external {
        if (settled.length == 0) return;
        bytes32 id = settled[index % settled.length];
        if (protection.getProtection(id).depositor == address(0)) return;
        (address owner, uint256 amount, uint64 maturesAt) = vault.locks(id);
        if (block.timestamp < maturesAt) vm.warp(maturesAt);
        uint256 recipientBefore = token.balanceOf(other);
        protection.release(_ids(id));
        if (owner == other) assertEq(token.balanceOf(other) - recipientBefore, amount);
    }

    function assertAccounting() external view {
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
        uint256 totalLocked;
        for (uint256 index; index < settled.length; ++index) {
            bytes32 id = settled[index];
            (address owner, uint256 amount,) = vault.locks(id);
            // A policy record exists exactly while its funded vault lock does.
            assertEq(protection.getProtection(id).depositor != address(0), owner != address(0));
            totalLocked += amount;
        }
        assertEq(totalLocked, vault.lockedStake(taker) + vault.lockedStake(other));
    }

    function _ids(bytes32 id) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }
}

contract SettlementPolicyInvariantTest is StdInvariant, Test {
    SettlementPolicyHandler internal handler;

    function setUp() public {
        handler = new SettlementPolicyHandler();
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = handler.settle.selector;
        selectors[1] = handler.release.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_ProtectedRecordsAreFundedAndVaultCoversLiabilities() public view {
        handler.assertAccounting();
    }
}
