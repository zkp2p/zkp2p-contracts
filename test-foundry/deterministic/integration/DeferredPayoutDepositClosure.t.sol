// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {DisputeProtectionStackV2Fixture} from "../helpers/DisputeProtectionStackV2Fixture.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

contract DeferredPayoutDepositClosureTest is DisputeProtectionStackV2Fixture {
    uint256 internal constant DUST = 1e5;

    function test_ProtectedFulfilClosesExhaustedDepositAndDefersNet() public {
        _fulfilFinalDeposit(0);
    }

    function test_ProtectedFulfilClosesDustDepositAndDefersNet() public {
        _fulfilFinalDeposit(DUST);
    }

    function test_ProtectedManualReleaseClosesExhaustedDepositAndPaysRecipient() public {
        _releaseFinalDeposit(0);
    }

    function test_ProtectedManualReleaseClosesDustDepositAndPaysRecipient() public {
        _releaseFinalDeposit(DUST);
    }

    function test_FailedSettlementPreservesFinalDepositAndRollsBackPayment() public {
        bytes32 id = _signalFinalDeposit(DUST);
        bytes memory invalidProof = _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, 180 days + 1);
        uint256 dustRecipientBalance = token.balanceOf(address(this));
        uint256 depositorBalance = token.balanceOf(depositor);

        vm.expectRevert(abi.encodeWithSelector(P.InvalidDisputeWindow.selector, 180 days + 1));
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(invalidProof, id, ""));

        assertEq(orchestrator.getIntent(id).owner, taker);
        assertEq(escrow.getDeposit(depositId).depositor, depositor);
        assertEq(address(escrow.getDeposit(depositId).token), address(token));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, DUST);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, INTENT_AMOUNT);
        assertEq(escrow.getDepositIntent(depositId, id).amount, INTENT_AMOUNT);
        assertEq(token.balanceOf(address(escrow)), INTENT_AMOUNT + DUST);
        assertEq(token.balanceOf(address(this)), dustRecipientBalance);
        assertEq(token.balanceOf(depositor), depositorBalance);
        assertEq(token.balanceOf(protocolFeeRecipient), 0);
        assertEq(token.balanceOf(referrer), 0);
        assertEq(token.balanceOf(other), 0);
        assertEq(token.balanceOf(address(orchestrator)), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalAccounted(), 0);
        assertEq(protection.getProtection(id).depositor, address(0));
        assertEq(nullifiers.nullifierByIntentHash(id), bytes32(0));
        assertEq(nullifiers.intentHashByNullifier(keccak256(abi.encodePacked(METHOD, _paymentId(id)))), bytes32(0));

        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        _assertClosedDeposit(id);
        assertEq(token.balanceOf(address(vault)), NET);
    }

    function _signalFinalDeposit(uint256 dust) internal returns (bytes32 id) {
        if (dust != 0) escrow.setDustThreshold(dust);
        uint256 remaining = escrow.getDeposit(depositId).remainingDeposits;
        vm.prank(depositor);
        escrow.removeFunds(depositId, remaining - INTENT_AMOUNT - dust);
        id = _signalDefault();
        assertFalse(escrow.getDeposit(depositId).retainOnEmpty);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, dust);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, INTENT_AMOUNT);
    }

    function _fulfilFinalDeposit(uint256 dust) internal {
        bytes32 id = _signalFinalDeposit(dust);
        uint256 dustRecipientBalance = token.balanceOf(address(this));
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);

        _assertClosedDeposit(id);
        P.Protection memory record = protection.getProtection(id);
        assertEq(record.depositor, depositor);
        assertEq(record.paymentMethod, METHOD);
        (address lockOwner, uint256 lockAmount, uint64 maturesAt) = vault.locks(id);
        assertEq(lockOwner, other);
        assertEq(lockAmount, NET);
        assertEq(maturesAt, block.timestamp + RISK_WINDOW);
        assertEq(vault.lockedStake(other), NET);
        assertEq(vault.totalAccounted(), NET);
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(token.balanceOf(other), 0);
        assertEq(token.balanceOf(address(this)), dustRecipientBalance + dust);
        assertEq(nullifiers.nullifierByIntentHash(id), keccak256(abi.encodePacked(METHOD, _paymentId(id))));
    }

    function _releaseFinalDeposit(uint256 dust) internal {
        bytes32 id = _signalFinalDeposit(dust);
        uint256 dustRecipientBalance = token.balanceOf(address(this));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id, INTENT_AMOUNT);

        _assertClosedDeposit(id);
        assertEq(protection.getProtection(id).depositor, address(0));
        assertEq(vault.totalAccounted(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(other), NET);
        assertEq(token.balanceOf(address(this)), dustRecipientBalance + dust);
        assertEq(nullifiers.nullifierByIntentHash(id), bytes32(0));
    }

    function _assertClosedDeposit(bytes32 id) internal view {
        assertEq(escrow.getDeposit(depositId).depositor, address(0));
        assertEq(address(escrow.getDeposit(depositId).token), address(0));
        assertEq(escrow.getDepositIntent(depositId, id).amount, 0);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(address(orchestrator)), 0);
        assertEq(token.balanceOf(protocolFeeRecipient), INTENT_AMOUNT * PROTOCOL_FEE / 1e18);
        assertEq(token.balanceOf(referrer), INTENT_AMOUNT * REFERRAL_FEE / 1e18);
    }
}
