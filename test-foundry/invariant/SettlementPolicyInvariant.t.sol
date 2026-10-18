// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {DisputeProtectionStackV2Fixture} from "../deterministic/helpers/DisputeProtectionStackV2Fixture.sol";
import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";

/// @notice Exercises real O4/UPV4 settlement while governance selection and live exemptions change.
contract SettlementPolicyHandler is DisputeProtectionStackV2Fixture {
    bytes32[] public settled;

    constructor() { setUp(); }

    function settle(bool enabledAtSignal, bool enableAfterSignal, bool staked, bool zeroWindow, bool manual, bool exempt) external {
        if (escrow.getDeposit(depositId).remainingDeposits < INTENT_AMOUNT) return;
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, false);
        orchestrator.setSettlementPolicy(enabledAtSignal ? IIntentSettlementPolicy(address(protection)) : IIntentSettlementPolicy(address(0)));
        bytes32 id = _signalDefault();
        orchestrator.setSettlementPolicy(enableAfterSignal ? IIntentSettlementPolicy(address(protection)) : IIntentSettlementPolicy(address(0)));
        if (staked && vault.freeStake(taker) < INTENT_AMOUNT) _stake(vault, taker, INTENT_AMOUNT);
        if (exempt) {
            address[] memory allowed = new address[](1);
            allowed[0] = taker;
            vm.prank(depositor);
            whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), allowed);
        }
        uint256 recipientBefore = token.balanceOf(other);
        bool protected = enabledAtSignal && !manual && !zeroWindow && !exempt;
        bool hasStake = vault.freeStake(taker) >= INTENT_AMOUNT;
        if (manual) {
            vm.prank(depositor);
            orchestrator.releaseFundsToPayer(id);
        } else {
            _settle(id, INTENT_AMOUNT, zeroWindow ? 0 : RISK_WINDOW);
        }
        P.DisputeProtectionIntent memory record = protection.getDisputeProtectionIntent(id);
        if (!protected) {
            assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.NONE));
            assertEq(token.balanceOf(other) - recipientBefore, NET);
        } else {
            assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.SETTLED));
            assertEq(uint256(record.collateralSource), uint256(hasStake ? P.CollateralSource.STAKE : P.CollateralSource.DEFERRED_PAYOUT));
            assertEq(record.lockedAmount, hasStake ? INTENT_AMOUNT : NET);
            assertEq(token.balanceOf(other) - recipientBefore, hasStake ? NET : 0);
        }
        assertEq(address(orchestrator.getIntentSettlementPolicy(id)), address(0));
        settled.push(id);
    }

    function release(uint256 index) external {
        if (settled.length == 0) return;
        bytes32 id = settled[index % settled.length];
        P.DisputeProtectionIntent memory record = protection.getDisputeProtectionIntent(id);
        if (record.status != P.DisputeProtectionIntentStatus.SETTLED) return;
        if (block.timestamp < record.releaseEligibleAt) vm.warp(record.releaseEligibleAt);
        protection.releaseMaturedDisputeProtectionIntent(id);
        if (record.collateralSource == P.CollateralSource.DEFERRED_PAYOUT) {
            vm.prank(taker);
            protection.claimFor(id);
        }
    }

    function assertAccounting() external view {
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
        uint256 totalLocked;
        for (uint256 index; index < settled.length; ++index) {
            bytes32 id = settled[index];
            P.DisputeProtectionIntent memory record = protection.getDisputeProtectionIntent(id);
            (address owner, uint256 amount, uint64 releaseAt) = vault.locks(id);
            if (record.status == P.DisputeProtectionIntentStatus.SETTLED) {
                assertEq(owner, record.stakeOwner);
                assertEq(amount, record.lockedAmount);
                assertEq(releaseAt, record.releaseEligibleAt);
                totalLocked += amount;
            } else {
                assertEq(amount, 0);
            }
            assertLe(record.claimedAmount, record.lockedAmount);
        }
        assertEq(totalLocked, vault.lockedStake(taker) + vault.lockedStake(other));
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
