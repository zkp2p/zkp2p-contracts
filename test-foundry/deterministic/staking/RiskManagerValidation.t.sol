// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {RiskManager} from "../../../contracts/RiskManager.sol";
import {IAttestationVerifier} from "../../../contracts/interfaces/IAttestationVerifier.sol";
import {IIntentRiskHook} from "../../../contracts/interfaces/IIntentRiskHook.sol";
import {INullifierRegistryV2} from "../../../contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV3} from "../../../contracts/interfaces/IOrchestratorV3.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";
import {IStakeVault} from "../../../contracts/interfaces/IStakeVault.sol";
import {NullifierRegistry} from "../../../contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "../../../contracts/registries/NullifierRegistryV2.sol";
import {OrchestratorRegistry} from "../../../contracts/registries/OrchestratorRegistry.sol";
import {UnifiedPaymentVerifierV3} from "../../../contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {RiskAttestationVerifierMock, RiskManagerFixture} from "../helpers/RiskManagerFixture.sol";

contract RiskManagerValidationTest is RiskManagerFixture {
    function test_ConstructorRejectsZeroDependenciesWithoutCodeLengthChecks() public {
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
            owner, IOrchestratorV3(address(0)), vault, verifier, INullifierRegistryV2(address(nullifierRegistry))
        );

        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        new RiskManager(
            owner,
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(0)),
            verifier,
            INullifierRegistryV2(address(nullifierRegistry))
        );

        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        new RiskManager(
            owner,
            IOrchestratorV3(address(orchestrator)),
            vault,
            IAttestationVerifier(address(0)),
            INullifierRegistryV2(address(nullifierRegistry))
        );

        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        new RiskManager(
            owner, IOrchestratorV3(address(orchestrator)), vault, verifier, INullifierRegistryV2(address(0))
        );

        address nonContractOrchestrator = makeAddr("nonContractOrchestrator");
        address nonContractVault = makeAddr("nonContractVault");
        address nonContractVerifier = makeAddr("nonContractVerifier");
        address nonContractRegistry = makeAddr("nonContractRegistry");
        RiskManager dependencyShapeAgnosticManager = new RiskManager(
            owner,
            IOrchestratorV3(nonContractOrchestrator),
            IStakeVault(nonContractVault),
            IAttestationVerifier(nonContractVerifier),
            INullifierRegistryV2(nonContractRegistry)
        );
        assertEq(address(dependencyShapeAgnosticManager.orchestrator()), nonContractOrchestrator);
        assertEq(address(dependencyShapeAgnosticManager.stakeVault()), nonContractVault);
        assertEq(address(dependencyShapeAgnosticManager.attestationVerifier()), nonContractVerifier);
        assertEq(address(dependencyShapeAgnosticManager.nullifierRegistry()), nonContractRegistry);
    }

    function test_RiskAndPaymentVerificationCanShareOneAttestationVerifier() public {
        NullifierRegistry legacyNullifierRegistry = new NullifierRegistry();
        NullifierRegistryV2 sharedNullifierRegistry = new NullifierRegistryV2(legacyNullifierRegistry);
        OrchestratorRegistry sharedOrchestratorRegistry = new OrchestratorRegistry();
        UnifiedPaymentVerifierV3 paymentVerifier =
            new UnifiedPaymentVerifierV3(sharedOrchestratorRegistry, sharedNullifierRegistry, verifier);
        RiskManager sharedVerifierManager =
            new RiskManager(owner, IOrchestratorV3(address(orchestrator)), vault, verifier, sharedNullifierRegistry);

        assertEq(address(paymentVerifier.attestationVerifier()), address(verifier));
        assertEq(address(sharedVerifierManager.attestationVerifier()), address(verifier));
    }

    function test_AdmissionRejectsDisabledAndMismatchedProtocolBoundaries() public {
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
        manager.reconcileCancellations(empty);
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
        manager.setAttestationVerifier(address(0));

        address nonContractVerifier = makeAddr("nonContractVerifier");
        vm.prank(owner);
        manager.setAttestationVerifier(nonContractVerifier);
        assertEq(address(manager.attestationVerifier()), nonContractVerifier);

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

    function test_SettlementRequiresPendingStateButTrustsCanonicalContextShape() public {
        bytes32 unknownIntent = keccak256("unknown-settlement-intent");
        vm.expectPartialRevert(IRiskManager.PositionNotPending.selector);
        orchestrator.settle(manager, _settlementContext(unknownIntent, INTENT_AMOUNT, 10e6, 5e6, false));

        _setConfig(false, false, 0, EXTENSION_SLOPE);
        bytes32 intentHash = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        IIntentRiskHook.RiskSettlementContext memory context =
            _settlementContext(intentHash, INTENT_AMOUNT, 10e6, 5e6, false);
        context.grossAmount = 0;
        context.executableAmount = type(uint256).max;
        context.recipient = makeAddr("wrongRecipient");
        context.token = address(otherToken);
        context.feeAllocations = new IIntentRiskHook.FeeAllocation[](13);
        context.feeAllocations[0].recipient = address(0);
        orchestrator.settle(manager, context);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.RELEASED));
        assertEq(position.grossReleasedAmount, 0);
        assertEq(position.executableAmount, type(uint256).max);
    }

    function test_DeferredSettlementRejectsTransferAmountMismatch() public {
        address deferredTaker = makeAddr("deferredTaker");
        bytes32 transferMismatchIntent = _admit(deferredTaker, payoutRecipient, INTENT_AMOUNT);
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
        bytes32 cancellationIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        manager.setPositionMode(cancellationIntent, IRiskManager.RiskMode.NONE);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.PositionModeMismatch.selector, cancellationIntent, IRiskManager.RiskMode.NONE
            )
        );
        orchestrator.cancel(manager, cancellationIntent);
        assertEq(
            uint256(manager.getRiskPosition(cancellationIntent).status), uint256(IRiskManager.PositionStatus.PENDING)
        );

        bytes32 pendingIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        manager.setPositionMode(pendingIntent, IRiskManager.RiskMode.NONE);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.PositionModeMismatch.selector, pendingIntent, IRiskManager.RiskMode.NONE
            )
        );
        orchestrator.settle(manager, _settlementContext(pendingIntent, INTENT_AMOUNT, 10e6, 5e6, false));
        assertEq(uint256(manager.getRiskPosition(pendingIntent).status), uint256(IRiskManager.PositionStatus.PENDING));

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
        assertEq(uint256(manager.getRiskPosition(maturityIntent).status), uint256(IRiskManager.PositionStatus.SETTLED));
    }

    function test_SettlementAndMaturityRejectTimestampOverflow() public {
        bytes32 settlementIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        vm.warp(type(uint64).max);
        vm.expectPartialRevert(IRiskManager.TimestampOverflow.selector);
        orchestrator.settle(manager, _settlementContext(settlementIntent, INTENT_AMOUNT, 10e6, 5e6, false));

        vm.warp(1);
        bytes32 maturityIntent = _admit(taker, payoutRecipient, INTENT_AMOUNT);
        orchestrator.settle(manager, _settlementContext(maturityIntent, INTENT_AMOUNT, 10e6, 5e6, false));
        vm.warp(uint256(type(uint64).max) + 1);
        vm.expectPartialRevert(IRiskManager.TimestampOverflow.selector);
        manager.releaseMaturedPosition(maturityIntent);
    }

    function test_ChargebackValidatesBindingsButAcceptsUnusedZeroFields() public {
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

        IRiskManager.ChargebackDetails memory zeroUnusedDetails = IRiskManager.ChargebackDetails({
            paymentMethod: PAYMENT_METHOD,
            originalPaymentId: bytes32(0),
            disputeId: bytes32(0),
            paymentAmount: 0,
            paymentCurrency: bytes32(0)
        });
        bytes memory zeroUnusedData = abi.encode(zeroUnusedDetails);
        IRiskManager.ChargebackAttestation memory zeroUnusedAttestation = IRiskManager.ChargebackAttestation({
            intentHash: intentHash,
            dataHash: keccak256(zeroUnusedData),
            signatures: new bytes[](0),
            data: zeroUnusedData
        });
        manager.submitChargeback(zeroUnusedAttestation);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SLASHED));
    }

    function test_CancellationRejectsNonPendingPosition() public {
        bytes32 unknownIntent = keccak256("unknown-cancellation-intent");
        vm.expectPartialRevert(IRiskManager.PositionNotPending.selector);
        orchestrator.cancel(manager, unknownIntent);
    }
}
