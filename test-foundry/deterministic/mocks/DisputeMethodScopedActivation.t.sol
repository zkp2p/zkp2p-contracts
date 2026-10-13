// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {
    DisputeMethodScopedTrustSurfaceChecks,
    InventoryTuple,
    TrustSurface
} from "contracts/mocks/DisputeMethodScopedActivationTypes.sol";
import {DisputeMethodScopedRotationGuard} from "contracts/mocks/DisputeMethodScopedRotationGuard.sol";
import {DisputeMethodScopedCutoverGuard} from "contracts/mocks/DisputeMethodScopedCutoverGuard.sol";
import {DisputeMethodScopedRotationPostcondition} from "contracts/mocks/DisputeMethodScopedRotationPostcondition.sol";
import {DisputeMethodScopedCutoverPostcondition} from "contracts/mocks/DisputeMethodScopedCutoverPostcondition.sol";
import {OrchestratorV3SurfaceMock} from "contracts/mocks/OrchestratorV3SurfaceMock.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract StakeVaultLocksMock {
    address public owner;
    address public pendingOwner;
    address public controller;
    address public pendingController;
    uint64 public pendingControllerValidAt;
    uint64 public controllerChangeDelay;

    address private lockOwner;
    uint256 private lockAmount;
    uint64 private lockMaturesAt;

    constructor(
        address _owner,
        address _controller,
        address _pendingController,
        uint64 _pendingControllerValidAt,
        uint64 _controllerChangeDelay
    ) {
        owner = _owner;
        controller = _controller;
        pendingController = _pendingController;
        pendingControllerValidAt = _pendingControllerValidAt;
        controllerChangeDelay = _controllerChangeDelay;
    }

    function setLock(address _stakeOwner, uint256 _amount, uint64 _maturesAt) external {
        lockOwner = _stakeOwner;
        lockAmount = _amount;
        lockMaturesAt = _maturesAt;
    }

    function setPendingController(address _pendingController) external {
        pendingController = _pendingController;
    }

    function locks(bytes32) external view returns (address stakeOwner, uint256 amount, uint64 maturesAt) {
        return (lockOwner, lockAmount, lockMaturesAt);
    }
}

contract DisputeMethodScopedActivationTest is OrchestratorV3Fixture {
    uint64 internal constant RISK_WINDOW = 30 days;
    uint64 internal constant CONTROLLER_CHANGE_DELAY = 2 days;
    uint256 internal constant STAKE_AMOUNT = 500e6;
    uint256 internal constant RELEASE_AMOUNT = 40e6;
    bytes32 internal constant INTENT_HASH = keccak256("method-scoped-intent");
    bytes32 internal constant CANCELLED_INTENT_HASH = keccak256("cancelled-method-scoped-intent");

    address internal safe;
    address internal witness;
    NullifierRegistry internal legacyNullifierRegistry;
    NullifierRegistryV2 internal nullifierRegistryV2;
    NullifierRegistry internal disputeRegistry;
    MultiAttestationVerifier internal attestationVerifier;
    DisputeVerifier internal disputeVerifier;
    StakeVault internal vault;
    DisputeProtectionPolicy internal predecessorPolicy;
    DisputeProtectionPolicy internal freshPolicy;
    AddressGroupRegistry internal groupRegistry;
    WhitelistPolicy internal whitelistPolicy;
    IntentLifecycleHookV1 internal predecessorHook;
    IntentLifecycleHookV1 internal freshHook;

    function setUp() public override {
        super.setUp();

        safe = makeAddr("safe");
        witness = makeAddr("witness");
        legacyNullifierRegistry = new NullifierRegistry();
        nullifierRegistryV2 = new NullifierRegistryV2(legacyNullifierRegistry);
        disputeRegistry = new NullifierRegistry();

        address[] memory witnesses = new address[](1);
        witnesses[0] = witness;
        attestationVerifier = new MultiAttestationVerifier(witnesses, 1);
        disputeVerifier = new DisputeVerifier(address(this), nullifierRegistryV2, attestationVerifier);
        vault = new StakeVault(address(this), token, address(0), CONTROLLER_CHANGE_DELAY);
        predecessorPolicy = new DisputeProtectionPolicy(address(this), vault, disputeVerifier, disputeRegistry);
        freshPolicy = new DisputeProtectionPolicy(address(this), vault, disputeVerifier, disputeRegistry);

        groupRegistry = new AddressGroupRegistry();
        whitelistPolicy = new WhitelistPolicy(groupRegistry, escrowRegistry, orchestratorRegistry);
        predecessorHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, predecessorPolicy);
        freshHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, freshPolicy);

        vault.initializeController(address(predecessorPolicy));
        disputeRegistry.addWritePermission(address(predecessorPolicy));
        predecessorPolicy.setLifecycleHookAuthorization(address(predecessorHook), true);
        freshPolicy.setLifecycleHookAuthorization(address(freshHook), true);
        predecessorPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        freshPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        orchestrator.setLifecycleHook(predecessorHook);
        orchestrator.setAllowMultipleIntents(false);

        _stake(taker, STAKE_AMOUNT);
        vm.startPrank(address(predecessorHook));
        predecessorPolicy.onIntentSignaled(INTENT_HASH, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        predecessorPolicy.onIntentSettled(INTENT_HASH, RELEASE_AMOUNT, false);
        vm.stopPrank();

        disputeRegistry.transferOwnership(safe);
        orchestrator.transferOwnership(safe);
        whitelistPolicy.transferOwnership(safe);
        attestationVerifier.transferOwnership(safe);
        _transferTwoStepOwnership(vault, safe, true);
        _transferTwoStepOwnership(predecessorPolicy, safe, true);
        _transferTwoStepOwnership(disputeVerifier, safe, true);
        _transferTwoStepOwnership(freshPolicy, safe, false);
    }

    function test_RotationGuardPassesInDeployedState() public {
        new DisputeMethodScopedRotationGuard(_surface(), true, address(this)).assertReady();
    }

    function test_RotationGuardPassesWhenFreshPolicyAlreadyOwnedBySafe() public {
        _acceptFreshOwnership();
        new DisputeMethodScopedRotationGuard(_surface(), false, address(this)).assertReady();
    }

    function test_RotationGuardPassesWhenAllowMultipleIntentsIsPinnedTrue() public {
        vm.prank(safe);
        orchestrator.setAllowMultipleIntents(true);
        new DisputeMethodScopedRotationGuard(_surface(), true, address(this)).assertReady();
    }

    function test_RotationGuardRejectsRegistryOwner() public {
        vm.prank(safe);
        disputeRegistry.transferOwnership(other);
        _expectRotationError(_surface(), DisputeMethodScopedTrustSurfaceChecks.RegistryOwnerMismatch.selector, true);
    }

    function test_RotationGuardRejectsOrchestratorOwner() public {
        TrustSurface memory surface = _surfaceWithOrchestrator(
            other,
            false,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            protocolFeeRecipient
        );
        _expectRotationError(surface, DisputeMethodScopedTrustSurfaceChecks.OrchestratorOwnerMismatch.selector, true);
    }

    function test_RotationGuardRejectsOrchestratorPaused() public {
        TrustSurface memory surface = _surfaceWithOrchestrator(
            safe,
            true,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            protocolFeeRecipient
        );
        _expectRotationError(surface, DisputeMethodScopedTrustSurfaceChecks.OrchestratorPausedMismatch.selector, true);
    }

    function test_RotationGuardRejectsOrchestratorEscrowRegistry() public {
        TrustSurface memory surface = _surfaceWithOrchestrator(
            safe, false, other, address(paymentVerifierRegistry), address(relayerRegistry), protocolFeeRecipient
        );
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.OrchestratorEscrowRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsOrchestratorPaymentVerifierRegistry() public {
        TrustSurface memory surface = _surfaceWithOrchestrator(
            safe, false, address(escrowRegistry), other, address(relayerRegistry), protocolFeeRecipient
        );
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.OrchestratorPaymentVerifierRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsOrchestratorRelayerRegistry() public {
        TrustSurface memory surface = _surfaceWithOrchestrator(
            safe, false, address(escrowRegistry), address(paymentVerifierRegistry), other, protocolFeeRecipient
        );
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.OrchestratorRelayerRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsOrchestratorProtocolFee() public {
        vm.prank(safe);
        orchestrator.setProtocolFee(1);
        _expectRotationError(
            _surface(), DisputeMethodScopedTrustSurfaceChecks.OrchestratorProtocolFeeMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsOrchestratorProtocolFeeRecipient() public {
        TrustSurface memory surface = _surfaceWithOrchestrator(
            safe, false, address(escrowRegistry), address(paymentVerifierRegistry), address(relayerRegistry), other
        );
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.OrchestratorProtocolFeeRecipientMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsOrchestratorAllowMultipleIntents() public {
        TrustSurface memory surface = _surface();
        vm.prank(safe);
        orchestrator.setAllowMultipleIntents(!surface.allowMultipleIntents);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.OrchestratorAllowMultipleIntentsMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsOrchestratorRegistration() public {
        TrustSurface memory surface = _surface();
        surface.orchestratorRegistry = address(new OrchestratorRegistry());
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.OrchestratorRegistrationMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsFreshHookOrchestratorRegistry() public {
        OrchestratorRegistry alternateRegistry = new OrchestratorRegistry();
        TrustSurface memory surface = _surface();
        surface.freshHook = address(new IntentLifecycleHookV1(alternateRegistry, whitelistPolicy, freshPolicy));
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.FreshHookOrchestratorRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsFreshHookWhitelistPolicy() public {
        WhitelistPolicy alternateWhitelist = new WhitelistPolicy(groupRegistry, escrowRegistry, orchestratorRegistry);
        TrustSurface memory surface = _surface();
        surface.freshHook = address(new IntentLifecycleHookV1(orchestratorRegistry, alternateWhitelist, freshPolicy));
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.FreshHookWhitelistPolicyMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsFreshHookDisputeProtectionPolicy() public {
        TrustSurface memory surface = _surface();
        surface.freshHook = address(new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, predecessorPolicy));
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.FreshHookDisputeProtectionPolicyMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsWhitelistPolicyOwner() public {
        TrustSurface memory surface = _surfaceWithWhitelist(
            address(this), address(escrowRegistry), address(groupRegistry), address(orchestratorRegistry)
        );
        _expectRotationError(surface, DisputeMethodScopedTrustSurfaceChecks.WhitelistPolicyOwnerMismatch.selector, true);
    }

    function test_RotationGuardRejectsWhitelistPolicyEscrowRegistry() public {
        TrustSurface memory surface = _surfaceWithWhitelist(
            safe, address(new EscrowRegistry()), address(groupRegistry), address(orchestratorRegistry)
        );
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.WhitelistPolicyEscrowRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsWhitelistPolicyGroupRegistry() public {
        TrustSurface memory surface = _surfaceWithWhitelist(
            safe, address(escrowRegistry), address(new AddressGroupRegistry()), address(orchestratorRegistry)
        );
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.WhitelistPolicyGroupRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsWhitelistPolicyOrchestratorRegistry() public {
        OrchestratorRegistry alternateRegistry = new OrchestratorRegistry();
        TrustSurface memory surface =
            _surfaceWithWhitelist(safe, address(escrowRegistry), address(groupRegistry), address(alternateRegistry));
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.WhitelistPolicyOrchestratorRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsAttestationVerifierOwner() public {
        TrustSurface memory surface = _surfaceWithAttestation(_addresses(witness), 1, address(this));
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.AttestationVerifierOwnerMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsAttestationVerifierRequiredSignatures() public {
        address[] memory alternateWitnesses = new address[](2);
        alternateWitnesses[0] = witness;
        alternateWitnesses[1] = other;
        TrustSurface memory surface = _surfaceWithAttestation(alternateWitnesses, 2, safe);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.AttestationVerifierRequiredSignaturesMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsAttestationVerifierWitnessCount() public {
        TrustSurface memory surface = _surfaceWithAttestation(_addresses(witness, other), 1, safe);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.AttestationVerifierWitnessCountMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsAttestationVerifierWitness() public {
        TrustSurface memory surface = _surfaceWithAttestation(_addresses(other), 1, safe);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.AttestationVerifierWitnessMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsDisputeVerifierOwner() public {
        TrustSurface memory surface =
            _surfaceWithDisputeVerifier(other, address(0), attestationVerifier, nullifierRegistryV2);
        _expectRotationError(surface, DisputeMethodScopedTrustSurfaceChecks.DisputeVerifierOwnerMismatch.selector, true);
    }

    function test_RotationGuardRejectsDisputeVerifierPendingOwner() public {
        TrustSurface memory surface = _surfaceWithDisputeVerifier(safe, other, attestationVerifier, nullifierRegistryV2);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.DisputeVerifierPendingOwnerMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsDisputeVerifierAttestationVerifier() public {
        MultiAttestationVerifier alternate = _newAttestationVerifier(_addresses(witness), 1, safe);
        TrustSurface memory surface = _surfaceWithDisputeVerifier(safe, address(0), alternate, nullifierRegistryV2);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.DisputeVerifierAttestationVerifierMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsDisputeVerifierNullifierRegistry() public {
        NullifierRegistryV2 alternate = new NullifierRegistryV2(legacyNullifierRegistry);
        TrustSurface memory surface = _surfaceWithDisputeVerifier(safe, address(0), attestationVerifier, alternate);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.DisputeVerifierNullifierRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsPredecessorPolicyOwner() public {
        TrustSurface memory surface =
            _surfaceWithPredecessor(address(this), address(0), disputeVerifier, disputeRegistry);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.PredecessorPolicyOwnerMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsPredecessorPolicyPendingOwner() public {
        TrustSurface memory surface = _surfaceWithPredecessor(safe, other, disputeVerifier, disputeRegistry);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.PredecessorPolicyPendingOwnerMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsPredecessorPolicyDisputeVerifier() public {
        DisputeVerifier alternate = new DisputeVerifier(safe, nullifierRegistryV2, attestationVerifier);
        TrustSurface memory surface = _surfaceWithPredecessor(safe, address(0), alternate, disputeRegistry);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.PredecessorPolicyDisputeVerifierMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsPredecessorPolicyDisputeRegistry() public {
        NullifierRegistry alternate = new NullifierRegistry();
        TrustSurface memory surface = _surfaceWithPredecessor(safe, address(0), disputeVerifier, alternate);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.PredecessorPolicyDisputeRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsFreshPolicyDisputeVerifier() public {
        DisputeVerifier alternate = new DisputeVerifier(safe, nullifierRegistryV2, attestationVerifier);
        TrustSurface memory surface = _surfaceWithFresh(alternate, disputeRegistry, vault);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.FreshPolicyDisputeVerifierMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsFreshPolicyDisputeRegistry() public {
        NullifierRegistry alternate = new NullifierRegistry();
        TrustSurface memory surface = _surfaceWithFresh(disputeVerifier, alternate, vault);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.FreshPolicyDisputeRegistryMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsFreshPolicyStakeVault() public {
        StakeVault alternate = new StakeVault(safe, token, address(predecessorPolicy), CONTROLLER_CHANGE_DELAY);
        TrustSurface memory surface = _surfaceWithFresh(disputeVerifier, disputeRegistry, alternate);
        _expectRotationError(
            surface, DisputeMethodScopedTrustSurfaceChecks.FreshPolicyStakeVaultMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsVaultOwner() public {
        StakeVault alternate = new StakeVault(other, token, address(predecessorPolicy), CONTROLLER_CHANGE_DELAY);
        TrustSurface memory surface = _surface();
        surface.vault = address(alternate);
        _expectRotationError(surface, DisputeMethodScopedTrustSurfaceChecks.VaultOwnerMismatch.selector, true);
    }

    function test_RotationGuardRejectsVaultPendingOwner() public {
        StakeVault alternate = new StakeVault(safe, token, address(predecessorPolicy), CONTROLLER_CHANGE_DELAY);
        vm.prank(safe);
        alternate.transferOwnership(other);
        TrustSurface memory surface = _surface();
        surface.vault = address(alternate);
        _expectRotationError(surface, DisputeMethodScopedTrustSurfaceChecks.VaultPendingOwnerMismatch.selector, true);
    }

    function test_RotationGuardRejectsVaultController() public {
        vm.mockCall(address(vault), abi.encodeCall(vault.controller, ()), abi.encode(other));
        _expectRotationError(_surface(), DisputeMethodScopedTrustSurfaceChecks.VaultControllerMismatch.selector, true);
    }

    function test_RotationGuardRejectsVaultPendingController() public {
        vm.prank(safe);
        vault.proposeController(other);
        _expectRotationError(
            _surface(), DisputeMethodScopedTrustSurfaceChecks.VaultPendingControllerMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsPredecessorAdmissionsPaused() public {
        vm.prank(safe);
        predecessorPolicy.setAdmissionsPaused(true);
        _expectRotationError(
            _surface(), DisputeMethodScopedTrustSurfaceChecks.PredecessorAdmissionsPausedMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsWriters() public {
        vm.startPrank(safe);
        disputeRegistry.addWritePermission(address(freshPolicy));
        disputeRegistry.removeWritePermission(address(predecessorPolicy));
        vm.stopPrank();
        _expectRotationError(_surface(), DisputeMethodScopedTrustSurfaceChecks.RegistryWriterMismatch.selector, true);
    }

    function test_RotationGuardRejectsLifecycleHook() public {
        vm.prank(safe);
        orchestrator.setLifecycleHook(freshHook);
        _expectRotationError(_surface(), DisputeMethodScopedTrustSurfaceChecks.LifecycleHookMismatch.selector, true);
    }

    function test_RotationGuardRejectsFreshPolicyOwner() public {
        _expectRotationError(_surface(), DisputeMethodScopedTrustSurfaceChecks.FreshPolicyOwnerMismatch.selector, false);
    }

    function test_RotationGuardRejectsFreshPolicyPendingOwner() public {
        _acceptFreshOwnership();
        vm.prank(safe);
        freshPolicy.transferOwnership(other);
        _expectRotationError(
            _surface(), DisputeMethodScopedTrustSurfaceChecks.FreshPolicyPendingOwnerMismatch.selector, false
        );
    }

    function test_RotationGuardRejectsFreshPolicyAdmissionsPaused() public {
        freshPolicy.setAdmissionsPaused(true);
        _expectRotationError(
            _surface(), DisputeMethodScopedTrustSurfaceChecks.FreshPolicyAdmissionsPausedMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsFreshHookAuthorization() public {
        freshPolicy.setLifecycleHookAuthorization(address(freshHook), false);
        _expectRotationError(
            _surface(), DisputeMethodScopedTrustSurfaceChecks.FreshHookAuthorizationMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsPredecessorHookAuthorization() public {
        freshPolicy.setLifecycleHookAuthorization(address(predecessorHook), true);
        _expectRotationError(
            _surface(), DisputeMethodScopedTrustSurfaceChecks.PredecessorHookAuthorizationMismatch.selector, true
        );
    }

    function test_RotationGuardRejectsRiskWindow() public {
        freshPolicy.setRiskWindow(METHOD, RISK_WINDOW + 1);
        _expectRotationError(_surface(), DisputeMethodScopedTrustSurfaceChecks.RiskWindowMismatch.selector, true);
    }

    function test_CutoverGuardPassesAfterDelayAndDrain() public {
        _prepareCutover(true);
        new DisputeMethodScopedCutoverGuard(
                _surface(), _intentHashes(INTENT_HASH), _inventory(), address(escrow), escrow.depositCounter()
            ).assertReady();
    }

    function test_CutoverGuardRejectsBeforeValidAt() public {
        _prepareRotation();
        _expectCutoverError(
            _intentHashes(INTENT_HASH),
            _inventory(),
            escrow.depositCounter(),
            DisputeMethodScopedTrustSurfaceChecks.ControllerDelayNotElapsed.selector
        );
    }

    function test_CutoverGuardRejectsPendingController() public {
        _acceptFreshOwnership();
        vm.startPrank(safe);
        predecessorPolicy.setAdmissionsPaused(true);
        vault.proposeController(other);
        vm.stopPrank();
        _expectCutoverError(
            _intentHashes(INTENT_HASH),
            _inventory(),
            escrow.depositCounter(),
            DisputeMethodScopedTrustSurfaceChecks.VaultPendingControllerMismatch.selector
        );
    }

    function test_CutoverGuardRejectsPredecessorUnpaused() public {
        _acceptFreshOwnership();
        vm.prank(safe);
        vault.proposeController(address(freshPolicy));
        vm.warp(vault.pendingControllerValidAt());
        _expectCutoverError(
            _intentHashes(INTENT_HASH),
            _inventory(),
            escrow.depositCounter(),
            DisputeMethodScopedTrustSurfaceChecks.PredecessorAdmissionsPausedMismatch.selector
        );
    }

    function test_CutoverGuardRejectsPendingIntent() public {
        vm.prank(address(predecessorHook));
        predecessorPolicy.onIntentSignaled(
            CANCELLED_INTENT_HASH, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT
        );
        _prepareCutover(true);
        _expectCutoverError(
            _intentHashes(CANCELLED_INTENT_HASH),
            _inventory(),
            escrow.depositCounter(),
            DisputeMethodScopedTrustSurfaceChecks.PredecessorIntentStatusMismatch.selector
        );
    }

    function test_CutoverGuardRejectsSettledIntentWithAmount() public {
        _prepareRotation();
        vm.warp(vault.pendingControllerValidAt());
        _optOutInventory();
        _expectCutoverError(
            _intentHashes(INTENT_HASH),
            _inventory(),
            escrow.depositCounter(),
            DisputeMethodScopedTrustSurfaceChecks.PredecessorIntentStatusMismatch.selector
        );
    }

    function test_CutoverGuardRejectsCancelledIntentWithNonzeroLock() public {
        vm.startPrank(address(predecessorHook));
        predecessorPolicy.onIntentSignaled(
            CANCELLED_INTENT_HASH, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT
        );
        predecessorPolicy.onIntentCancelled(CANCELLED_INTENT_HASH);
        vm.stopPrank();

        _acceptFreshOwnership();
        vm.prank(safe);
        predecessorPolicy.setAdmissionsPaused(true);

        StakeVaultLocksMock mockVault = new StakeVaultLocksMock(
            safe, address(predecessorPolicy), address(0), uint64(block.timestamp), CONTROLLER_CHANGE_DELAY
        );
        DisputeProtectionPolicy alternateFresh =
            new DisputeProtectionPolicy(safe, IStakeVault(address(mockVault)), disputeVerifier, disputeRegistry);
        mockVault.setPendingController(address(alternateFresh));
        IntentLifecycleHookV1 alternateFreshHook =
            new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, alternateFresh);
        vm.startPrank(safe);
        alternateFresh.setLifecycleHookAuthorization(address(alternateFreshHook), true);
        alternateFresh.setRiskWindow(METHOD, RISK_WINDOW);
        vm.stopPrank();
        mockVault.setLock(taker, 1, uint64(block.timestamp));

        TrustSurface memory surface = _surface();
        surface.vault = address(mockVault);
        surface.freshPolicy = address(alternateFresh);
        surface.freshHook = address(alternateFreshHook);
        bytes32[] memory hashes = _intentHashes(CANCELLED_INTENT_HASH);
        DisputeMethodScopedCutoverGuard guard = new DisputeMethodScopedCutoverGuard(
            surface, hashes, _inventory(), address(escrow), escrow.depositCounter()
        );
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.PredecessorIntentLockAmountMismatch.selector);
        guard.assertReady();
    }

    function test_CutoverGuardRejectsDepositCounterChanged() public {
        uint256 pinnedCounter = escrow.depositCounter();
        _prepareCutover(true);
        vm.startPrank(depositor);
        _createDeposit(address(0), delegate);
        vm.stopPrank();
        _expectCutoverError(
            _intentHashes(INTENT_HASH),
            _inventory(),
            pinnedCounter,
            DisputeMethodScopedTrustSurfaceChecks.DepositCounterMismatch.selector
        );
    }

    function test_CutoverGuardRejectsEnabledInventoryTuple() public {
        _prepareCutover(false);
        _expectCutoverError(
            _intentHashes(INTENT_HASH),
            _inventory(),
            escrow.depositCounter(),
            DisputeMethodScopedTrustSurfaceChecks.InventoryTupleProtectionMismatch.selector
        );
    }

    function test_CutoverGuardRejectsTrustSurfaceDrift() public {
        _prepareCutover(true);
        TrustSurface memory surface = _surface();
        vm.prank(safe);
        orchestrator.setAllowMultipleIntents(!surface.allowMultipleIntents);
        DisputeMethodScopedCutoverGuard guard = new DisputeMethodScopedCutoverGuard(
            surface, _intentHashes(INTENT_HASH), _inventory(), address(escrow), escrow.depositCounter()
        );
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.OrchestratorAllowMultipleIntentsMismatch.selector);
        guard.assertReady();
    }

    function test_RotationPostconditionPassesWithoutWarpBetweenCalls() public {
        _prepareRotation();
        new DisputeMethodScopedRotationPostcondition(_surface(), CONTROLLER_CHANGE_DELAY).assertPostconditions();
    }

    function test_RotationPostconditionRejectsWarpAfterProposal() public {
        _prepareRotation();
        vm.warp(block.timestamp + 1);
        DisputeMethodScopedRotationPostcondition postcondition =
            new DisputeMethodScopedRotationPostcondition(_surface(), CONTROLLER_CHANGE_DELAY);
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.PendingControllerValidAtMismatch.selector);
        postcondition.assertPostconditions();
    }

    function test_RotationPostconditionRejectsPredecessorUnpaused() public {
        _acceptFreshOwnership();
        vm.prank(safe);
        vault.proposeController(address(freshPolicy));
        DisputeMethodScopedRotationPostcondition postcondition =
            new DisputeMethodScopedRotationPostcondition(_surface(), CONTROLLER_CHANGE_DELAY);
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.PredecessorAdmissionsPausedMismatch.selector);
        postcondition.assertPostconditions();
    }

    function test_RotationPostconditionRejectsTrustSurfaceDrift() public {
        _prepareRotation();
        vm.prank(safe);
        orchestrator.setProtocolFee(1);
        DisputeMethodScopedRotationPostcondition postcondition =
            new DisputeMethodScopedRotationPostcondition(_surface(), CONTROLLER_CHANGE_DELAY);
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.OrchestratorProtocolFeeMismatch.selector);
        postcondition.assertPostconditions();
    }

    function test_CutoverPostconditionPassesAfterBatch() public {
        _prepareCutover(true);
        _executeCutover();
        new DisputeMethodScopedCutoverPostcondition(_surface()).assertPostconditions();
    }

    function test_CutoverPostconditionRejectsVaultController() public {
        _prepareCutover(true);
        vm.startPrank(safe);
        disputeRegistry.addWritePermission(address(freshPolicy));
        disputeRegistry.removeWritePermission(address(predecessorPolicy));
        orchestrator.setLifecycleHook(freshHook);
        vm.stopPrank();
        DisputeMethodScopedCutoverPostcondition postcondition = new DisputeMethodScopedCutoverPostcondition(_surface());
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.VaultControllerMismatch.selector);
        postcondition.assertPostconditions();
    }

    function test_CutoverPostconditionRejectsWriters() public {
        _prepareCutover(true);
        vm.warp(vault.pendingControllerValidAt());
        vm.prank(safe);
        freshPolicy.acceptVaultController();
        vm.prank(safe);
        orchestrator.setLifecycleHook(freshHook);
        DisputeMethodScopedCutoverPostcondition postcondition = new DisputeMethodScopedCutoverPostcondition(_surface());
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.RegistryWriterMismatch.selector);
        postcondition.assertPostconditions();
    }

    function test_CutoverPostconditionRejectsLifecycleHook() public {
        _prepareCutover(true);
        vm.warp(vault.pendingControllerValidAt());
        vm.prank(safe);
        freshPolicy.acceptVaultController();
        vm.startPrank(safe);
        disputeRegistry.addWritePermission(address(freshPolicy));
        disputeRegistry.removeWritePermission(address(predecessorPolicy));
        vm.stopPrank();
        DisputeMethodScopedCutoverPostcondition postcondition = new DisputeMethodScopedCutoverPostcondition(_surface());
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.LifecycleHookMismatch.selector);
        postcondition.assertPostconditions();
    }

    function test_CutoverPostconditionRejectsFreshAuthorization() public {
        _prepareCutover(true);
        _executeCutover();
        vm.prank(safe);
        freshPolicy.setLifecycleHookAuthorization(address(freshHook), false);
        DisputeMethodScopedCutoverPostcondition postcondition = new DisputeMethodScopedCutoverPostcondition(_surface());
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.FreshHookAuthorizationMismatch.selector);
        postcondition.assertPostconditions();
    }

    function test_CutoverPostconditionRejectsRiskWindow() public {
        _prepareCutover(true);
        _executeCutover();
        vm.prank(safe);
        freshPolicy.setRiskWindow(METHOD, RISK_WINDOW + 1);
        DisputeMethodScopedCutoverPostcondition postcondition = new DisputeMethodScopedCutoverPostcondition(_surface());
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.RiskWindowMismatch.selector);
        postcondition.assertPostconditions();
    }

    function test_CutoverPostconditionRejectsTrustSurfaceDrift() public {
        _prepareCutover(true);
        _executeCutover();
        DisputeMethodScopedCutoverPostcondition postcondition = new DisputeMethodScopedCutoverPostcondition(_surface());
        TrustSurface memory surface = _surface();
        vm.prank(safe);
        orchestrator.setAllowMultipleIntents(!surface.allowMultipleIntents);
        vm.expectPartialRevert(DisputeMethodScopedTrustSurfaceChecks.OrchestratorAllowMultipleIntentsMismatch.selector);
        postcondition.assertPostconditions();
    }

    function _surface() internal view returns (TrustSurface memory surface) {
        surface.safe = safe;
        surface.disputeRegistry = address(disputeRegistry);
        surface.orchestrator = address(orchestrator);
        surface.orchestratorRegistry = address(orchestratorRegistry);
        surface.escrowRegistry = address(escrowRegistry);
        surface.paymentVerifierRegistry = address(paymentVerifierRegistry);
        surface.relayerRegistry = address(relayerRegistry);
        surface.protocolFeeRecipient = protocolFeeRecipient;
        surface.allowMultipleIntents = orchestrator.allowMultipleIntents();
        surface.freshHook = address(freshHook);
        surface.whitelistPolicy = address(whitelistPolicy);
        surface.groupRegistry = address(groupRegistry);
        surface.attestationVerifier = address(attestationVerifier);
        surface.witnesses = _addresses(witness);
        surface.disputeVerifier = address(disputeVerifier);
        surface.nullifierRegistryV2 = address(nullifierRegistryV2);
        surface.predecessorPolicy = address(predecessorPolicy);
        surface.freshPolicy = address(freshPolicy);
        surface.vault = address(vault);
        surface.predecessorHook = address(predecessorHook);
        surface.paymentMethods = new bytes32[](1);
        surface.paymentMethods[0] = METHOD;
        surface.riskWindows = new uint64[](1);
        surface.riskWindows[0] = RISK_WINDOW;
    }

    function _surfaceWithOrchestrator(
        address mockOwner,
        bool isPaused,
        address mockEscrowRegistry,
        address mockPaymentVerifierRegistry,
        address mockRelayerRegistry,
        address mockProtocolFeeRecipient
    ) internal returns (TrustSurface memory surface) {
        OrchestratorV3SurfaceMock mock = new OrchestratorV3SurfaceMock(
            mockOwner, mockEscrowRegistry, mockPaymentVerifierRegistry, mockRelayerRegistry, mockProtocolFeeRecipient
        );
        vm.startPrank(mockOwner);
        mock.setLifecycleHook(address(predecessorHook));
        if (isPaused) mock.setPaused(true);
        vm.stopPrank();
        orchestratorRegistry.addOrchestrator(address(mock));
        surface = _surface();
        surface.orchestrator = address(mock);
    }

    function _surfaceWithWhitelist(
        address whitelistOwner,
        address alternateEscrowRegistry,
        address alternateGroupRegistry,
        address alternateOrchestratorRegistry
    ) internal returns (TrustSurface memory surface) {
        WhitelistPolicy alternate = new WhitelistPolicy(
            AddressGroupRegistry(alternateGroupRegistry),
            EscrowRegistry(alternateEscrowRegistry),
            OrchestratorRegistry(alternateOrchestratorRegistry)
        );
        if (whitelistOwner != address(this)) alternate.transferOwnership(whitelistOwner);
        IntentLifecycleHookV1 alternateHook = new IntentLifecycleHookV1(orchestratorRegistry, alternate, freshPolicy);
        surface = _surface();
        surface.whitelistPolicy = address(alternate);
        surface.freshHook = address(alternateHook);
    }

    function _surfaceWithAttestation(address[] memory actualWitnesses, uint256 threshold, address verifierOwner)
        internal
        returns (TrustSurface memory surface)
    {
        MultiAttestationVerifier alternate = _newAttestationVerifier(actualWitnesses, threshold, verifierOwner);
        surface = _surface();
        surface.attestationVerifier = address(alternate);
    }

    function _surfaceWithDisputeVerifier(
        address verifierOwner,
        address pendingVerifierOwner,
        MultiAttestationVerifier verifierAttestation,
        NullifierRegistryV2 verifierNullifierRegistry
    ) internal returns (TrustSurface memory surface) {
        DisputeVerifier alternate = new DisputeVerifier(verifierOwner, verifierNullifierRegistry, verifierAttestation);
        if (pendingVerifierOwner != address(0)) {
            vm.prank(verifierOwner);
            alternate.transferOwnership(pendingVerifierOwner);
        }
        surface = _surface();
        surface.disputeVerifier = address(alternate);
    }

    function _surfaceWithPredecessor(
        address policyOwner,
        address pendingPolicyOwner,
        DisputeVerifier policyVerifier,
        NullifierRegistry policyRegistry
    ) internal returns (TrustSurface memory surface) {
        DisputeProtectionPolicy alternate = new DisputeProtectionPolicy(
            policyOwner, vault, policyVerifier, policyRegistry
        );
        if (pendingPolicyOwner != address(0)) {
            vm.prank(policyOwner);
            alternate.transferOwnership(pendingPolicyOwner);
        }
        surface = _surface();
        surface.predecessorPolicy = address(alternate);
    }

    function _surfaceWithFresh(DisputeVerifier policyVerifier, NullifierRegistry policyRegistry, StakeVault policyVault)
        internal
        returns (TrustSurface memory surface)
    {
        DisputeProtectionPolicy alternate =
            new DisputeProtectionPolicy(address(this), policyVault, policyVerifier, policyRegistry);
        alternate.transferOwnership(safe);
        IntentLifecycleHookV1 alternateHook =
            new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, alternate);
        surface = _surface();
        surface.freshPolicy = address(alternate);
        surface.freshHook = address(alternateHook);
    }

    function _newAttestationVerifier(address[] memory actualWitnesses, uint256 threshold, address verifierOwner)
        internal
        returns (MultiAttestationVerifier alternate)
    {
        alternate = new MultiAttestationVerifier(actualWitnesses, threshold);
        if (verifierOwner != address(this)) alternate.transferOwnership(verifierOwner);
    }

    function _expectRotationError(TrustSurface memory surface, bytes4 errorSelector, bool expectAcceptOwnership)
        internal
    {
        DisputeMethodScopedRotationGuard guard =
            new DisputeMethodScopedRotationGuard(surface, expectAcceptOwnership, address(this));
        vm.expectPartialRevert(errorSelector);
        guard.assertReady();
    }

    function _expectCutoverError(
        bytes32[] memory intentHashes,
        InventoryTuple[] memory tuples,
        uint256 pinnedDepositCounter,
        bytes4 errorSelector
    ) internal {
        DisputeMethodScopedCutoverGuard guard = new DisputeMethodScopedCutoverGuard(
            _surface(), intentHashes, tuples, address(escrow), pinnedDepositCounter
        );
        vm.expectPartialRevert(errorSelector);
        guard.assertReady();
    }

    function _prepareRotation() internal {
        _acceptFreshOwnership();
        vm.startPrank(safe);
        predecessorPolicy.setAdmissionsPaused(true);
        vault.proposeController(address(freshPolicy));
        vm.stopPrank();
    }

    function _prepareCutover(bool optOutInventory) internal {
        _prepareRotation();
        uint256 readyAt = vault.pendingControllerValidAt();
        uint256 releaseAt = predecessorPolicy.getDisputeProtectionIntent(INTENT_HASH).releaseEligibleAt;
        vm.warp(readyAt > releaseAt ? readyAt : releaseAt);
        predecessorPolicy.releaseMaturedDisputeProtectionIntent(INTENT_HASH);
        if (optOutInventory) _optOutInventory();
    }

    function _executeCutover() internal {
        vm.prank(safe);
        freshPolicy.acceptVaultController();
        vm.startPrank(safe);
        disputeRegistry.addWritePermission(address(freshPolicy));
        disputeRegistry.removeWritePermission(address(predecessorPolicy));
        orchestrator.setLifecycleHook(freshHook);
        vm.stopPrank();
    }

    function _acceptFreshOwnership() internal {
        if (freshPolicy.owner() != safe) {
            vm.prank(safe);
            freshPolicy.acceptOwnership();
        }
    }

    function _optOutInventory() internal {
        vm.prank(depositor);
        freshPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
    }

    function _inventory() internal view returns (InventoryTuple[] memory tuples) {
        tuples = new InventoryTuple[](1);
        tuples[0] = InventoryTuple({escrow: address(escrow), depositId: depositId, paymentMethod: METHOD});
    }

    function _intentHashes(bytes32 intentHash) internal pure returns (bytes32[] memory hashes) {
        hashes = new bytes32[](1);
        hashes[0] = intentHash;
    }

    function _addresses(address first) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = first;
    }

    function _addresses(address first, address second) internal pure returns (address[] memory values) {
        values = new address[](2);
        values[0] = first;
        values[1] = second;
    }

    function _stake(address stakeOwner, uint256 amount) internal {
        token.transfer(stakeOwner, amount);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    function _transferTwoStepOwnership(StakeVault target, address newOwner, bool accept) internal {
        target.transferOwnership(newOwner);
        if (accept) {
            vm.prank(newOwner);
            target.acceptOwnership();
        }
    }

    function _transferTwoStepOwnership(DisputeProtectionPolicy target, address newOwner, bool accept) internal {
        target.transferOwnership(newOwner);
        if (accept) {
            vm.prank(newOwner);
            target.acceptOwnership();
        }
    }

    function _transferTwoStepOwnership(DisputeVerifier target, address newOwner, bool accept) internal {
        target.transferOwnership(newOwner);
        if (accept) {
            vm.prank(newOwner);
            target.acceptOwnership();
        }
    }
}
