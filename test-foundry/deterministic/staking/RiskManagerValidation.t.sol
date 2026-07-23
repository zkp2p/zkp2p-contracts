// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {RiskManager} from "../../../contracts/RiskManager.sol";
import {IIntentRiskHook} from "../../../contracts/interfaces/IIntentRiskHook.sol";
import {INullifierRegistryV2} from "../../../contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV3} from "../../../contracts/interfaces/IOrchestratorV3.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";
import {RiskAttestationVerifierMock, RiskManagerFixture} from "../helpers/RiskManagerFixture.sol";

contract RiskManagerValidationTest is RiskManagerFixture {
    function test_ConstructorRejectsZeroAndNonContractDependencies() public {
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        new RiskManager(
            address(0),
            IOrchestratorV3(address(orchestrator)),
            vault,
            verifier,
            INullifierRegistryV2(address(nullifierRegistry))
        );

        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        new RiskManager(
            owner,
            IOrchestratorV3(makeAddr("nonContractOrchestrator")),
            vault,
            verifier,
            INullifierRegistryV2(address(nullifierRegistry))
        );
    }

    function test_AdmissionRejectsMalformedDisabledAndMismatchedInputs() public {
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, bytes32(0)));
        orchestrator.admit(manager, bytes32(0));

        bytes32 missingIntent = keccak256("missing-intent");
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, missingIntent));
        orchestrator.admit(manager, missingIntent);

        IRiskManager.PlatformRiskConfig memory disabledConfig = IRiskManager.PlatformRiskConfig({
            enabled: false,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: true, deferredPayoutEnabled: true, riskWindow: RISK_WINDOW
            }),
            extensionPenaltyBpsPerHour: EXTENSION_SLOPE
        });
        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYMENT_METHOD, disabledConfig);
        (bytes32 disabledIntent,) = _newIntent(taker, payoutRecipient, INTENT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.PlatformDisabled.selector, PAYMENT_METHOD));
        orchestrator.admit(manager, disabledIntent);

        _setConfig(true, true, RISK_WINDOW, EXTENSION_SLOPE);
        escrow.setToken(otherToken);
        (bytes32 wrongTokenIntent,) = _newIntent(taker, payoutRecipient, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.IntentTokenMismatch.selector, address(token), address(otherToken))
        );
        orchestrator.admit(manager, wrongTokenIntent);

        escrow.setToken(token);
        address wrongGuardian = makeAddr("wrongGuardian");
        escrow.setGuardian(wrongGuardian);
        (bytes32 wrongGuardianIntent,) = _newIntent(taker, payoutRecipient, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.InvalidIntentGuardian.selector, address(manager), wrongGuardian)
        );
        orchestrator.admit(manager, wrongGuardianIntent);

        escrow.setGuardian(address(manager));
        bytes32 duplicateIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.PositionAlreadyExists.selector, duplicateIntent));
        orchestrator.admit(manager, duplicateIntent);
    }

    function test_AdmissionRejectsTimestampOverflow() public {
        escrow.setIntentExpirationPeriod(type(uint64).max);
        (bytes32 intentHash,) = _newIntent(taker, payoutRecipient, INTENT_AMOUNT);

        vm.expectPartialRevert(IRiskManager.TimestampOverflow.selector);
        orchestrator.admit(manager, intentHash);
    }

    function test_ExtensionRejectsEveryStaleIntentShape() public {
        bytes32 zeroAmountIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        vm.prank(taker);
        vm.expectRevert(IRiskManager.ZeroAmount.selector);
        manager.extendIntent(zeroAmountIntent, 0);

        bytes32 unknownIntent = keccak256("unknown-extension-intent");
        vm.expectPartialRevert(IRiskManager.PositionNotPending.selector);
        manager.extendIntent(unknownIntent, 1 hours);

        bytes32 ownerMismatchIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory ownerMismatchPosition = manager.getRiskPosition(ownerMismatchIntent);
        orchestrator.setIntent(
            ownerMismatchIntent,
            makeAddr("replacementTaker"),
            payoutRecipient,
            address(escrow),
            INTENT_AMOUNT,
            PAYMENT_METHOD,
            ownerMismatchPosition.createdAt
        );
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, ownerMismatchIntent));
        manager.extendIntent(ownerMismatchIntent, 1 hours);

        bytes32 timestampMismatchIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory timestampMismatchPosition = manager.getRiskPosition(timestampMismatchIntent);
        escrow.setIntent(timestampMismatchIntent, INTENT_AMOUNT, timestampMismatchPosition.createdAt + 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, timestampMismatchIntent));
        manager.extendIntent(timestampMismatchIntent, 1 hours);

        bytes32 expiredIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory expiredPosition = manager.getRiskPosition(expiredIntent);
        vm.warp(expiredPosition.baseIntentExpiry);
        vm.prank(taker);
        vm.expectPartialRevert(IRiskManager.IntentAlreadyExpired.selector);
        manager.extendIntent(expiredIntent, 1 hours);

        bytes32 expiryMismatchIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.RiskPosition memory expiryMismatchPosition = manager.getRiskPosition(expiryMismatchIntent);
        escrow.setIntentExpiry(expiryMismatchIntent, uint256(expiryMismatchPosition.baseIntentExpiry) + 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, expiryMismatchIntent));
        manager.extendIntent(expiryMismatchIntent, 1 hours);
    }

    function test_BatchCancellationAndMaturityValidateAndProcessEveryPosition() public {
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert(IRiskManager.EmptyBatch.selector);
        manager.reconcileCancellations(empty);
        vm.expectRevert(IRiskManager.EmptyBatch.selector);
        manager.releaseMaturedPositions(empty);

        bytes32 unrecordedIntent = keccak256("unrecorded-cancellation");
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.CancellationNotRecorded.selector, unrecordedIntent));
        manager.reconcileCancellation(unrecordedIntent);

        bytes32[] memory cancellations = new bytes32[](2);
        cancellations[0] = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        cancellations[1] = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.recordFailedCancellation(cancellations[0], uint64(block.timestamp));
        orchestrator.recordFailedCancellation(cancellations[1], uint64(block.timestamp));
        manager.reconcileCancellations(cancellations);
        assertEq(
            uint256(manager.getRiskPosition(cancellations[0]).status), uint256(IRiskManager.PositionStatus.CANCELLED)
        );
        assertEq(
            uint256(manager.getRiskPosition(cancellations[1]).status), uint256(IRiskManager.PositionStatus.CANCELLED)
        );

        bytes32[] memory matured = new bytes32[](2);
        matured[0] = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        matured[1] = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(matured[0], INTENT_AMOUNT, 10e6, 5e6, false));
        orchestrator.settle(manager, _settlementContext(matured[1], INTENT_AMOUNT, 10e6, 5e6, false));
        uint64 deadline = manager.getRiskPosition(matured[0]).coverageDeadline;
        vm.warp(deadline);
        manager.releaseMaturedPositions(matured);
        assertEq(uint256(manager.getRiskPosition(matured[0]).status), uint256(IRiskManager.PositionStatus.RELEASED));
        assertEq(uint256(manager.getRiskPosition(matured[1]).status), uint256(IRiskManager.PositionStatus.RELEASED));
    }

    function test_GovernanceViewsAndCalculationHelpersExposeLedgerState() public {
        IRiskManager.PlatformRiskConfig memory config = manager.getPlatformRiskConfig(PAYMENT_METHOD);
        assertTrue(config.enabled);
        assertTrue(config.chargeback.chargebackable);
        assertEq(config.chargeback.riskWindow, RISK_WINDOW);

        (address stakeOwner, uint256 totalStake, uint256 locked, uint256 free) = manager.getTakerState(taker);
        assertEq(stakeOwner, safe);
        assertEq(totalStake, 50_000e6);
        assertEq(locked, 0);
        assertEq(free, 50_000e6);

        (uint256 penalty, uint64 chargeableTime) =
            manager.calculateIntentExtensionPenalty(INTENT_AMOUNT, 100, 150, 40, EXTENSION_SLOPE);
        assertEq(chargeableTime, 40);
        assertEq(penalty, manager.calculateIntentExtensionCost(INTENT_AMOUNT, 40, EXTENSION_SLOPE));
        assertEq(manager.calculateIntentExtensionCost(0, 1 hours, EXTENSION_SLOPE), 0);

        IRiskManager.ChargebackAttestation memory attestation =
            _chargebackAttestation(keccak256("hash-only"), keccak256("payment"), keccak256("dispute"));
        assertNotEq(manager.hashChargebackAttestation(attestation), bytes32(0));

        vm.prank(owner);
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        manager.setAttestationVerifier(makeAddr("nonContractVerifier"));

        RiskAttestationVerifierMock replacement = new RiskAttestationVerifierMock();
        vm.prank(owner);
        manager.setAttestationVerifier(address(replacement));
        assertEq(address(manager.attestationVerifier()), address(replacement));

        address temporaryController = makeAddr("temporaryController");
        vm.prank(owner);
        vault.proposeController(temporaryController);
        uint256 temporaryControllerActivation = block.timestamp + vault.controllerChangeDelay();
        vm.warp(temporaryControllerActivation);
        vm.prank(temporaryController);
        vault.acceptController();
        vm.prank(owner);
        vault.proposeController(address(manager));
        vm.warp(temporaryControllerActivation + vault.controllerChangeDelay());
        vm.prank(owner);
        manager.acceptVaultController();
        assertEq(vault.controller(), address(manager));

        vm.prank(owner);
        vm.expectRevert(IRiskManager.OwnershipRenunciationDisabled.selector);
        manager.renounceOwnership();
    }

    function test_SettlementRejectsInvalidAmountsRecipientAndFeePlan() public {
        bytes32 unknownIntent = keccak256("unknown-settlement-intent");
        vm.expectPartialRevert(IRiskManager.PositionNotPending.selector);
        orchestrator.settle(manager, _settlementContext(unknownIntent, INTENT_AMOUNT, 10e6, 5e6, false));

        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IIntentRiskHook.RiskSettlementContext memory context =
            _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, false);
        context.grossAmount = 0;
        vm.expectPartialRevert(IRiskManager.InvalidSettlementAmounts.selector);
        orchestrator.settle(manager, context);

        context = _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, false);
        context.recipient = makeAddr("wrongRecipient");
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, intentHash));
        orchestrator.settle(manager, context);

        context = _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, false);
        context.feeAllocations = new IIntentRiskHook.FeeAllocation[](13);
        vm.expectPartialRevert(IRiskManager.InvalidFeeAllocationCount.selector);
        orchestrator.settle(manager, context);

        context = _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, false);
        context.feeAllocations[0].recipient = address(0);
        vm.expectPartialRevert(IRiskManager.InvalidFeeAllocation.selector);
        orchestrator.settle(manager, context);
    }

    function test_DeferredSettlementRejectsFundingMismatches() public {
        address firstDeferredTaker = makeAddr("firstDeferredTaker");
        bytes32 recipientMismatchIntent = _admit(firstDeferredTaker, payoutRecipient, INTENT_AMOUNT);
        manager.setPositionStakeOwner(recipientMismatchIntent, makeAddr("wrongStakeOwner"));
        vm.expectPartialRevert(IRiskManager.DeferredStakeRecipientMismatch.selector);
        orchestrator.settle(manager, _settlementContext(recipientMismatchIntent, INTENT_AMOUNT, 10e6, 5e6, false));

        address secondDeferredTaker = makeAddr("secondDeferredTaker");
        bytes32 transferMismatchIntent = _admit(secondDeferredTaker, payoutRecipient, INTENT_AMOUNT);
        token.setTransferFeeEnabled(true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.DeferredStakeTransferMismatch.selector, INTENT_AMOUNT, INTENT_AMOUNT - 1
            )
        );
        orchestrator.settle(manager, _settlementContext(transferMismatchIntent, INTENT_AMOUNT, 10e6, 5e6, false));
        token.setTransferFeeEnabled(false);
    }

    function test_ChargebackRejectsNonSettledAndIncompletePositions() public {
        bytes32 pendingIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IRiskManager.ChargebackAttestation memory pendingAttestation =
            _chargebackAttestation(pendingIntent, keccak256("pending-payment"), keccak256("pending-dispute"));
        vm.expectPartialRevert(IRiskManager.PositionNotSettled.selector);
        manager.submitChargeback(pendingAttestation);

        bytes32 incompleteCoverageIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(incompleteCoverageIntent, INTENT_AMOUNT, 10e6, 5e6, true));
        manager.setPositionCoverageAmount(incompleteCoverageIntent, INTENT_AMOUNT - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.IncompleteChargebackCoverage.selector, INTENT_AMOUNT - 1, INTENT_AMOUNT)
        );
        manager.submitChargeback(
            _chargebackAttestation(
                incompleteCoverageIntent, keccak256("coverage-payment"), keccak256("coverage-dispute")
            )
        );
    }

    function test_DefensiveModeGuardsRejectContradictoryPositionState() public {
        bytes32 pendingIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        manager.setPositionMode(pendingIntent, IRiskManager.RiskMode.NONE);
        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.PositionModeMismatch.selector, pendingIntent, IRiskManager.RiskMode.NONE)
        );
        orchestrator.settle(manager, _settlementContext(pendingIntent, INTENT_AMOUNT, 10e6, 5e6, false));
        assertEq(
            uint256(manager.getRiskPosition(pendingIntent).status), uint256(IRiskManager.PositionStatus.PENDING)
        );

        bytes32 chargebackIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(chargebackIntent, INTENT_AMOUNT, 10e6, 5e6, true));
        manager.setPositionMode(chargebackIntent, IRiskManager.RiskMode.NONE);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.PositionModeMismatch.selector, chargebackIntent, IRiskManager.RiskMode.NONE
            )
        );
        manager.submitChargeback(
            _chargebackAttestation(chargebackIntent, keccak256("mode-payment"), keccak256("mode-dispute"))
        );
        assertEq(
            uint256(manager.getRiskPosition(chargebackIntent).status), uint256(IRiskManager.PositionStatus.SETTLED)
        );

        bytes32 maturityIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(maturityIntent, INTENT_AMOUNT, 10e6, 5e6, false));
        uint64 deadline = manager.getRiskPosition(maturityIntent).coverageDeadline;
        manager.setPositionMode(maturityIntent, IRiskManager.RiskMode.NONE);
        vm.warp(deadline);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.PositionModeMismatch.selector, maturityIntent, IRiskManager.RiskMode.NONE
            )
        );
        manager.releaseMaturedPosition(maturityIntent);
        assertEq(
            uint256(manager.getRiskPosition(maturityIntent).status), uint256(IRiskManager.PositionStatus.SETTLED)
        );
    }

    function test_ChargebackRejectsInvalidHashAndDetails() public {
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, true));

        IRiskManager.ChargebackAttestation memory invalidHash =
            _chargebackAttestation(intentHash, keccak256("hash-payment"), keccak256("hash-dispute"));
        invalidHash.dataHash = keccak256("wrong-data-hash");
        vm.expectRevert(IRiskManager.InvalidAttestation.selector);
        manager.submitChargeback(invalidHash);

        IRiskManager.ChargebackDetails memory details = IRiskManager.ChargebackDetails({
            paymentMethod: keccak256("wrong-method"),
            originalPaymentId: keccak256("details-payment"),
            disputeId: keccak256("details-dispute"),
            paymentAmount: 1,
            paymentCurrency: keccak256("USD")
        });
        bytes memory data = abi.encode(details);
        IRiskManager.ChargebackAttestation memory invalidDetails = IRiskManager.ChargebackAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
        vm.expectRevert(IRiskManager.InvalidAttestation.selector);
        manager.submitChargeback(invalidDetails);
    }

    function test_CancellationRejectsNonPendingPosition() public {
        bytes32 unknownIntent = keccak256("unknown-cancellation-intent");
        vm.expectPartialRevert(IRiskManager.PositionNotPending.selector);
        orchestrator.cancel(manager, unknownIntent);
    }
}
