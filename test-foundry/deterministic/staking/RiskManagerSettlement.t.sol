// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "../../../contracts/interfaces/IIntentLifecycleHook.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";
import {RiskManagerFixture} from "../helpers/RiskManagerFixture.sol";

contract RiskManagerSettlementTest is RiskManagerFixture {
    function test_AdmissionSnapshotsRiskWindowAndExtensionSlopeAcrossGovernanceChanges() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        _setConfig(true, true, 7 days, 20);

        vm.prank(taker);
        manager.extendIntent(intentHash, 1 hours);
        IIntentLifecycleHook.SettlementContext memory context =
            _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, true);
        orchestrator.settle(manager, context);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.riskWindow, RISK_WINDOW);
        assertEq(position.extensionPenaltyBpsPerHour, EXTENSION_SLOPE);
        assertEq(position.coverageDeadline, block.timestamp + RISK_WINDOW);
    }

    function test_StakeBackedSettlementResolvesExtensionAndRetimesCoverageLock() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory admitted = manager.getRiskPosition(intentHash);
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 hours);
        vm.warp(uint256(admitted.baseIntentExpiry) + 1 hours);

        uint256 grossAmount = 800e6;
        IIntentLifecycleHook.SettlementContext memory context =
            _settlementContext(intentHash, grossAmount, 8e6, 4e6, false);
        uint256 orchestratorBalanceBefore = token.balanceOf(address(orchestrator));
        orchestrator.settle(manager, context);

        uint256 expectedPenalty = manager.calculateIntentExtensionCost(INTENT_AMOUNT, 1 hours, EXTENSION_SLOPE);
        IRiskManager.RiskPosition memory settled = manager.getRiskPosition(intentHash);
        assertEq(uint256(settled.status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertEq(settled.coverageAmount, grossAmount);
        assertEq(settled.coverageDeadline, uint64(block.timestamp + RISK_WINDOW));
        assertEq(vault.claimable(lp), expectedPenalty);
        assertEq(token.balanceOf(address(orchestrator)), orchestratorBalanceBefore);

        (address coverageOwner, uint256 coverageAmount, uint64 maturesAt) = vault.locks(intentHash);
        assertEq(coverageOwner, safe);
        assertEq(coverageAmount, grossAmount);
        assertEq(maturesAt, settled.coverageDeadline);
        (address extensionOwner,,) = vault.locks(manager.extensionLockId(intentHash));
        assertEq(extensionOwner, address(0));
    }

    function test_StakeBackedMaturityFreesCoverageWithoutCreatingClaim() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IIntentLifecycleHook.SettlementContext memory context = _settlementContext(intentHash, 700e6, 7e6, 3e6, false);
        orchestrator.settle(manager, context);
        IRiskManager.RiskPosition memory settled = manager.getRiskPosition(intentHash);

        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.PositionNotMature.selector, settled.coverageDeadline, uint64(block.timestamp)
            )
        );
        manager.releaseMaturedPosition(intentHash);

        vm.warp(settled.coverageDeadline);
        manager.releaseMaturedPosition(intentHash);

        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
        assertEq(vault.lockedStake(safe), 0);
        assertEq(vault.freeStake(safe), 50_000e6);
        assertEq(vault.claimable(safe), 0);
    }

    function test_UnbondedSettlementConsumesNoTokensAndNeedsNoMaturityAction() public {
        _setConfig(false, false, 0, EXTENSION_SLOPE);
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IIntentLifecycleHook.SettlementContext memory context =
            _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, false);
        uint256 balanceBefore = token.balanceOf(address(orchestrator));

        orchestrator.settle(manager, context);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.RELEASED));
        assertEq(token.balanceOf(address(orchestrator)), balanceBefore);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.PositionNotSettled.selector, intentHash, IRiskManager.PositionStatus.RELEASED
            )
        );
        manager.releaseMaturedPosition(intentHash);
    }

    function test_DeferredSettlementFundsOneGrossLockAndStoresFeePlan() public {
        address unstakedTaker = makeAddr("unstakedTaker");
        bytes32 intentHash = _admit(unstakedTaker, payoutRecipient, INTENT_AMOUNT);
        uint256 grossAmount = 800e6;
        IIntentLifecycleHook.SettlementContext memory context =
            _settlementContext(intentHash, grossAmount, 8e6, 4e6, false);
        uint256 orchestratorBalanceBefore = token.balanceOf(address(orchestrator));

        orchestrator.settle(manager, context);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertEq(token.balanceOf(address(orchestrator)), orchestratorBalanceBefore - grossAmount);
        assertEq(vault.stakeBalance(payoutRecipient), grossAmount);
        assertEq(vault.lockedStake(payoutRecipient), grossAmount);
        assertEq(vault.unaccountedBalance(), 0);

        IIntentLifecycleHook.FeeAllocation[] memory fees = manager.getDeferredFeeAllocations(intentHash);
        assertEq(fees.length, 2);
        assertEq(fees[0].recipient, protocolFeeRecipient);
        assertEq(fees[0].amount, 8e6);
        assertEq(fees[1].recipient, referralFeeRecipient);
        assertEq(fees[1].amount, 4e6);
    }

    function test_DeferredMaturityCreatesImmediateFeeClaimsAndLeavesNetFreeStake() public {
        address unstakedTaker = makeAddr("unstakedTaker");
        bytes32 intentHash = _admit(unstakedTaker, payoutRecipient, INTENT_AMOUNT);
        uint256 grossAmount = 800e6;
        uint256 protocolFee = 8e6;
        uint256 referralFee = 4e6;
        IIntentLifecycleHook.SettlementContext memory context =
            _settlementContext(intentHash, grossAmount, protocolFee, referralFee, false);
        orchestrator.settle(manager, context);
        uint64 deadline = manager.getRiskPosition(intentHash).coverageDeadline;

        vm.warp(deadline);
        manager.releaseMaturedPosition(intentHash);

        uint256 netAmount = grossAmount - protocolFee - referralFee;
        assertEq(vault.stakeBalance(payoutRecipient), netAmount);
        assertEq(vault.freeStake(payoutRecipient), netAmount);
        assertEq(vault.lockedStake(payoutRecipient), 0);
        assertEq(vault.claimable(protocolFeeRecipient), protocolFee);
        assertEq(vault.claimable(referralFeeRecipient), referralFee);
        assertEq(manager.getDeferredFeeAllocations(intentHash).length, 0);
        assertEq(vault.totalAccounted(), 50_000e6 + grossAmount);
        assertEq(token.balanceOf(address(vault)), grossAmount + 50_000e6);
    }

    function test_DeferredZeroValueFeeEntriesAreNotStoredOrConvertedIntoClaims() public {
        address unstakedTaker = makeAddr("unstakedTaker");
        bytes32 intentHash = _admit(unstakedTaker, payoutRecipient, 1);
        IIntentLifecycleHook.SettlementContext memory context = _settlementContext(intentHash, 1, 0, 0, false);

        orchestrator.settle(manager, context);
        assertEq(manager.getDeferredFeeAllocations(intentHash).length, 0);
        vm.warp(manager.getRiskPosition(intentHash).coverageDeadline);
        manager.releaseMaturedPosition(intentHash);

        assertEq(vault.freeStake(payoutRecipient), 1);
        assertEq(vault.totalClaimable(), 0);
    }

    function test_StakeBackedSettlementTrustsCanonicalOrchestratorContextShape() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IIntentLifecycleHook.SettlementContext memory context =
            _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, false);
        context.feeAllocations[0].amount += 1;
        context.token = address(otherToken);
        context.recipient = makeAddr("canonicalContextIsTrusted");
        orchestrator.settle(manager, context);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        (, uint256 lockAmount, uint64 maturesAt) = vault.locks(intentHash);
        assertEq(lockAmount, INTENT_AMOUNT);
        assertEq(maturesAt, position.coverageDeadline);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.SETTLED));
    }

    function test_StakeBackedChargebackAtWindowStartCreatesFullLpClaim() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IIntentLifecycleHook.SettlementContext memory context = _settlementContext(intentHash, 800e6, 8e6, 4e6, false);
        orchestrator.settle(manager, context);

        bytes32 paymentId = keccak256("payment");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(PAYMENT_METHOD, paymentId));
        nullifierRegistry.setPaymentBinding(paymentNullifier, intentHash);
        IRiskManager.ChargebackAttestation memory attestation =
            _chargebackAttestation(intentHash, paymentId, keccak256("dispute"));

        manager.submitChargeback(attestation);

        assertEq(vault.claimable(lp), 800e6);
        assertEq(vault.stakeBalance(safe), 50_000e6 - 800e6);
        assertEq(vault.lockedStake(safe), 0);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SLASHED));
    }

    function test_DeferredChargebackCancelsFeesAndCompensatesGross() public {
        address unstakedTaker = makeAddr("unstakedTaker");
        bytes32 intentHash = _admit(unstakedTaker, payoutRecipient, INTENT_AMOUNT);
        IIntentLifecycleHook.SettlementContext memory context = _settlementContext(intentHash, 800e6, 8e6, 4e6, true);
        orchestrator.settle(manager, context);

        manager.submitChargeback(
            _chargebackAttestation(intentHash, keccak256("manual-payment"), keccak256("manual-dispute"))
        );

        assertEq(vault.claimable(lp), 800e6);
        assertEq(vault.stakeBalance(payoutRecipient), 0);
        assertEq(vault.claimable(protocolFeeRecipient), 0);
        assertEq(vault.claimable(referralFeeRecipient), 0);
        assertEq(manager.getDeferredFeeAllocations(intentHash).length, 0);
    }

    function test_ChargebackWindowIsHalfOpenAtExactDeadline() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IIntentLifecycleHook.SettlementContext memory context = _settlementContext(intentHash, 800e6, 8e6, 4e6, true);
        orchestrator.settle(manager, context);
        uint64 deadline = manager.getRiskPosition(intentHash).coverageDeadline;
        vm.warp(deadline);

        IRiskManager.ChargebackAttestation memory attestation =
            _chargebackAttestation(intentHash, keccak256("payment"), keccak256("dispute"));
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.ChargebackWindowClosed.selector, deadline, deadline));
        manager.submitChargeback(attestation);

        manager.releaseMaturedPosition(intentHash);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
    }

    function test_ChargebackEvidenceCannotBeReusedAcrossPositions() public {
        bytes32 disputeId = keccak256("shared-dispute");
        bytes32 firstIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(firstIntent, 800e6, 8e6, 4e6, true));
        manager.submitChargeback(_chargebackAttestation(firstIntent, keccak256("one"), disputeId));

        bytes32 secondIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(secondIntent, 700e6, 7e6, 3e6, true));
        bytes32 nullifier = keccak256(abi.encodePacked(PAYMENT_METHOD, disputeId));
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.ChargebackEvidenceUsed.selector, nullifier));
        manager.submitChargeback(_chargebackAttestation(secondIntent, keccak256("two"), disputeId));

        assertEq(uint256(manager.getRiskPosition(secondIntent).status), uint256(IRiskManager.PositionStatus.SETTLED));
    }

    function test_ChargebackRequiresCanonicalPaymentBindingAndVerifierApproval() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(intentHash, 800e6, 8e6, 4e6, false));
        bytes32 paymentId = keccak256("payment");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(PAYMENT_METHOD, paymentId));
        IRiskManager.ChargebackAttestation memory attestation =
            _chargebackAttestation(intentHash, paymentId, keccak256("dispute"));

        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.InvalidPaymentBinding.selector, intentHash, paymentNullifier)
        );
        manager.submitChargeback(attestation);

        nullifierRegistry.setPaymentBinding(paymentNullifier, intentHash);
        verifier.setResult(false);
        vm.expectRevert(IRiskManager.AttestationVerificationFailed.selector);
        manager.submitChargeback(attestation);

        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertFalse(manager.usedChargebackNullifiers(keccak256(abi.encodePacked(PAYMENT_METHOD, keccak256("dispute")))));
    }
}
