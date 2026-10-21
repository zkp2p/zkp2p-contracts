// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {WhitelistPolicyV2} from "contracts/hooks/WhitelistPolicyV2.sol";
import {OrchestratorV4} from "contracts/OrchestratorV4.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {OrchestratorV4TrustSurface, OrchestratorV4TrustSurfaceChecks} from "contracts/mocks/OrchestratorV4ActivationTypes.sol";
import {OrchestratorV4CutoverGuard} from "contracts/mocks/OrchestratorV4CutoverGuard.sol";
import {OrchestratorV4CutoverPostcondition} from "contracts/mocks/OrchestratorV4CutoverPostcondition.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

/**
 * @title OrchestratorV4ActivationTest
 * @notice Exercises OrchestratorV4 activation and execution-time rejection of trust-surface drift.
 */
contract OrchestratorV4ActivationTest is OrchestratorV3Fixture {
    uint64 internal constant RISK_WINDOW = 30 days;
    uint64 internal constant CONTROLLER_CHANGE_DELAY = 2 days;
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant CASHAPP = keccak256("cashapp");
    bytes32 internal constant EUR = keccak256("EUR");
    UnifiedPaymentVerifierV3 internal retiredVerifier;
    UnifiedPaymentVerifierV4 internal freshVerifier;

    address internal safe;
    address internal witness;
    NullifierRegistry internal disputeRegistry;
    NullifierRegistryV2 internal nullifierRegistryV2;
    MultiAttestationVerifier internal attestationVerifier;
    DisputeVerifier internal disputeVerifier;
    StakeVault internal predecessorVault;
    StakeVaultV2 internal freshVault;
    DisputeProtectionPolicy internal predecessorPolicy;
    DisputeProtectionPolicyV2 internal freshPolicy;
    AddressGroupRegistry internal groupRegistry;
    AddressGroupRegistry internal freshGroupRegistry;
    WhitelistPolicy internal whitelistPolicy;
    WhitelistPolicyV2 internal freshWhitelistPolicy;
    IntentLifecycleHookV1 internal predecessorHook;
    OrchestratorV4 internal orchestratorV4;

    function setUp() public override {
        super.setUp();
        safe = makeAddr("safe");
        witness = makeAddr("witness");
        NullifierRegistry legacy = new NullifierRegistry();
        nullifierRegistryV2 = new NullifierRegistryV2(legacy);
        disputeRegistry = new NullifierRegistry();
        address[] memory witnesses = new address[](1);
        witnesses[0] = witness;
        attestationVerifier = new MultiAttestationVerifier(witnesses, 1);
        disputeVerifier = new DisputeVerifier(address(this), nullifierRegistryV2, attestationVerifier);
        predecessorVault = new StakeVault(address(this), token, address(0), CONTROLLER_CHANGE_DELAY);
        freshVault = new StakeVaultV2(address(this), token);
        predecessorPolicy =
            new DisputeProtectionPolicy(address(this), predecessorVault, disputeVerifier, disputeRegistry);
        groupRegistry = new AddressGroupRegistry();
        whitelistPolicy = new WhitelistPolicy(groupRegistry, escrowRegistry, orchestratorRegistry);
        freshGroupRegistry = new AddressGroupRegistry();
        freshWhitelistPolicy = new WhitelistPolicyV2(freshGroupRegistry);
        freshPolicy = new DisputeProtectionPolicyV2(
            address(this), freshVault, disputeVerifier, disputeRegistry, orchestratorRegistry
        );
        predecessorHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, predecessorPolicy);
        predecessorVault.initializeController(address(predecessorPolicy));
        freshVault.setController(address(freshPolicy), true);
        disputeRegistry.addWritePermission(address(predecessorPolicy));
        predecessorPolicy.setLifecycleHookAuthorization(address(predecessorHook), true);
        predecessorPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        orchestrator.setLifecycleHook(predecessorHook);
        orchestrator.setAllowMultipleIntents(false);
        orchestratorV4 = new OrchestratorV4(
            address(this),
            orchestrator.chainId(),
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            orchestrator.protocolFee(),
            orchestrator.protocolFeeRecipient(),
            freshWhitelistPolicy
        );
        orchestratorV4.setSettlementPolicy(freshPolicy);
        orchestratorV4.setAllowMultipleIntents(orchestrator.allowMultipleIntents());
        orchestratorV4.transferOwnership(safe);
        vm.prank(depositor);
        predecessorPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        predecessorPolicy.setRiskWindow(PAYPAL, RISK_WINDOW);
        retiredVerifier = new UnifiedPaymentVerifierV3(orchestratorRegistry, nullifierRegistryV2, attestationVerifier);
        freshVerifier = new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifierRegistryV2, attestationVerifier);
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory methods = _methods();
        for (uint256 methodIndex = 0; methodIndex < methods.length; methodIndex++) {
            retiredVerifier.addPaymentMethod(methods[methodIndex]);
            freshVerifier.addPaymentMethod(methods[methodIndex]);
            paymentVerifierRegistry.addPaymentMethod(
                methods[methodIndex], address(retiredVerifier), _currencies(methodIndex)
            );
        }
        nullifierRegistryV2.addWritePermission(address(retiredVerifier));
        nullifierRegistryV2.transferOwnership(safe);
        paymentVerifierRegistry.transferOwnership(safe);
        retiredVerifier.transferOwnership(safe);
        freshVerifier.transferOwnership(safe);
        escrowRegistry.transferOwnership(safe);
        orchestratorRegistry.transferOwnership(safe);
        relayerRegistry.transferOwnership(safe);
        escrow.transferOwnership(safe);
        legacy.transferOwnership(safe);
        disputeRegistry.transferOwnership(safe);
        orchestrator.transferOwnership(safe);
        whitelistPolicy.transferOwnership(safe);
        attestationVerifier.transferOwnership(safe);
        _transfer(predecessorVault, true);
        _transfer(predecessorPolicy, true);
        _transfer(disputeVerifier, true);
        freshVault.transferOwnership(safe);
        freshPolicy.transferOwnership(safe);
    }

    function test_CutoverPassesForEveryConditionalAcceptanceCombination() public {
        for (uint256 mask = 0; mask < 4; mask++) {
            setUp();
            bool acceptVault = (mask & 1) == 0;
            bool acceptPolicy = (mask & 2) == 0;
            vm.startPrank(safe);
            if (!acceptVault) freshVault.acceptOwnership();
            if (!acceptPolicy) freshPolicy.acceptOwnership();
            vm.stopPrank();
            OrchestratorV4TrustSurface memory surface = _surface();
            OrchestratorV4CutoverGuard guard = _guard(surface, acceptVault, acceptPolicy);
            OrchestratorV4CutoverPostcondition postcondition = new OrchestratorV4CutoverPostcondition(surface);
            guard.assertReady();
            _executeBatch(guard, acceptVault, acceptPolicy);
            postcondition.assertPostconditions();
        }
    }

    function test_GuardAcceptsMatchingStoredChainIdsOnFork() public {
        assertTrue(block.chainid != orchestrator.chainId());
        assertEq(orchestratorV4.chainId(), orchestrator.chainId());
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        guard.assertReady();
        OrchestratorV4CutoverPostcondition postcondition = new OrchestratorV4CutoverPostcondition(_surface());
        _executeBatch(guard, true, true);
        postcondition.assertPostconditions();
    }

    function test_GuardRejectsMismatchedStoredChainIds() public {
        orchestratorV4 = new OrchestratorV4(
            address(this),
            block.chainid,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            orchestrator.protocolFee(),
            orchestrator.protocolFeeRecipient(),
            freshWhitelistPolicy
        );
        orchestratorV4.setSettlementPolicy(freshPolicy);
        orchestratorV4.transferOwnership(safe);
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.OrchestratorV4ChainIdMismatch.selector, block.chainid
            )
        );
    }

    function test_PostconditionRejectsBeforeBatchAndGuardRejectsAfterBatch() public {
        OrchestratorV4TrustSurface memory surface = _surface();
        OrchestratorV4CutoverGuard guard = _guard(surface, true, true);
        OrchestratorV4CutoverPostcondition postcondition = new OrchestratorV4CutoverPostcondition(surface);
        vm.expectRevert(
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshVaultOwnerMismatch.selector, address(this))
        );
        postcondition.assertPostconditions();
        _executeBatch(guard, true, true);
        postcondition.assertPostconditions();
        vm.expectRevert(abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshVaultOwnerMismatch.selector, safe));
        guard.assertReady();
        OrchestratorV4CutoverGuard acceptedGuard = _guard(surface, false, false);
        vm.expectRevert(
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.DisputeWriterCountMismatch.selector, uint256(2))
        );
        acceptedGuard.assertReady();
    }

    function test_GuardRejectsDisputeWriterDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        disputeRegistry.addWritePermission(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.DisputeWriterCountMismatch.selector, uint256(2))
        );
        vm.prank(safe);
        disputeRegistry.removeWritePermission(address(predecessorPolicy));
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.DisputeWriterMismatch.selector, uint256(0), other)
        );
    }

    function test_GuardRejectsNullifierWriterDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        nullifierRegistryV2.addWritePermission(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.NullifierWriterCountMismatch.selector, uint256(2))
        );
        vm.prank(safe);
        nullifierRegistryV2.removeWritePermission(address(retiredVerifier));
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.NullifierWriterMismatch.selector, uint256(0), other)
        );
    }

    function test_GuardRejectsRouteVerifierDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.startPrank(safe);
        paymentVerifierRegistry.removePaymentMethod(CASHAPP);
        paymentVerifierRegistry.addPaymentMethod(CASHAPP, address(freshVerifier), _currencies(2));
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.RouteVerifierMismatch.selector, CASHAPP, address(freshVerifier)
            )
        );
    }

    function test_GuardRejectsCurrencyListDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        bytes32[] memory currencies = _currencies(1);
        currencies[0] = EUR;
        currencies[1] = USD;
        vm.startPrank(safe);
        paymentVerifierRegistry.removePaymentMethod(CASHAPP);
        paymentVerifierRegistry.removePaymentMethod(PAYPAL);
        paymentVerifierRegistry.addPaymentMethod(PAYPAL, address(retiredVerifier), currencies);
        paymentVerifierRegistry.addPaymentMethod(CASHAPP, address(retiredVerifier), _currencies(2));
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.RouteCurrencyMismatch.selector, PAYPAL, uint256(0), EUR
            )
        );
    }

    function test_GuardRejectsCurrencyCountDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.startPrank(safe);
        paymentVerifierRegistry.removePaymentMethod(CASHAPP);
        paymentVerifierRegistry.addPaymentMethod(CASHAPP, address(retiredVerifier), _currencies(1));
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.RouteCurrencyCountMismatch.selector, CASHAPP, uint256(2)
            )
        );
    }

    function test_GuardRejectsRegistryOrderDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.startPrank(safe);
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(retiredVerifier), _currencies(0));
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.RegistryMethodMismatch.selector, uint256(0), CASHAPP)
        );
    }

    function test_GuardRejectsO3HookDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        orchestrator.setLifecycleHook(IIntentLifecycleHook(address(freshPolicy)));
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.LifecycleHookMismatch.selector, address(freshPolicy))
        );
    }

    function test_GuardRejectsFreshVaultControllerDeauthorization() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        freshVault.setController(address(freshPolicy), false);
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.FreshVaultControllerAuthorizationMismatch.selector, false
            )
        );
    }

    function test_GuardRejectsPredecessorHookDeauthorization() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        predecessorPolicy.setLifecycleHookAuthorization(address(predecessorHook), false);
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.PredecessorPolicyHookAuthorizationMismatch.selector, false
            )
        );
    }

    function test_GuardRejectsVerifierMethodListDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        freshVerifier.removePaymentMethod(METHOD);
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.VerifierMethodCountMismatch.selector, uint256(2))
        );
        vm.prank(safe);
        freshVerifier.addPaymentMethod(METHOD);
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.VerifierMethodMismatch.selector, uint256(0), CASHAPP)
        );
    }

    function test_GuardRejectsOwnershipPredicates() public {
        _expectReady(
            _guard(_surface(), false, true),
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshVaultOwnerMismatch.selector, address(this))
        );
        _expectReady(
            _guard(_surface(), true, false),
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshPolicyOwnerMismatch.selector, address(this))
        );
        vm.startPrank(safe);
        freshVault.acceptOwnership();
        freshPolicy.acceptOwnership();
        vm.stopPrank();
        _expectReady(
            _guard(_surface(), true, false),
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshVaultOwnerMismatch.selector, safe)
        );
        _expectReady(
            _guard(_surface(), false, true),
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshPolicyOwnerMismatch.selector, safe)
        );
    }

    function test_GuardRejectsPendingOwnershipDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        freshVault.transferOwnership(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshVaultPendingOwnerMismatch.selector, other)
        );
        freshVault.transferOwnership(safe);
        freshPolicy.transferOwnership(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshPolicyPendingOwnerMismatch.selector, other)
        );
    }

    function test_GuardRejectsOrchestratorV4AlreadyRegistered() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        orchestratorRegistry.addOrchestrator(address(orchestratorV4));
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.OrchestratorV4RegistrationMismatch.selector, true)
        );
    }

    function test_GuardRejectsOrchestratorV4PolicyDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        orchestratorV4.setSettlementPolicy(IIntentSettlementPolicy(address(0)));
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.OrchestratorV4SettlementPolicyMismatch.selector, address(0)
            )
        );
    }

    function test_GuardRejectsOrchestratorV4WhitelistDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.mockCall(address(orchestratorV4), abi.encodeWithSignature("whitelistPolicy()"), abi.encode(other));
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.OrchestratorV4WhitelistPolicyMismatch.selector, other
            )
        );
    }

    function test_GuardRejectsFreshPolicyOrchestratorRegistryDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.mockCall(address(freshPolicy), abi.encodeWithSignature("orchestratorRegistry()"), abi.encode(other));
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.FreshPolicyOrchestratorRegistryMismatch.selector, other
            )
        );
    }

    function test_GuardRejectsOrchestratorV4ConfigDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        orchestratorV4.setProtocolFeeRecipient(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.OrchestratorV4ProtocolFeeRecipientMismatch.selector, other
            )
        );
        vm.startPrank(safe);
        orchestratorV4.setProtocolFeeRecipient(protocolFeeRecipient);
        orchestratorV4.setAllowMultipleIntents(true);
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.OrchestratorV4AllowMultipleIntentsMismatch.selector, true
            )
        );
        vm.startPrank(safe);
        orchestratorV4.setAllowMultipleIntents(false);
        orchestratorV4.setRelayerRegistry(other);
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.OrchestratorV4RelayerRegistryMismatch.selector, other
            )
        );
    }

    function test_GuardRejectsOrchestratorV4OwnerDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        orchestratorV4.transferOwnership(other);
        _expectReady(
            guard, abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.OrchestratorV4OwnerMismatch.selector, other)
        );
    }

    function test_GuardRejectsOrchestratorRegistryOwnerDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        orchestratorRegistry.transferOwnership(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.OrchestratorRegistryOwnerMismatch.selector, other)
        );
    }

    function test_PostconditionRejectsO3HookChange() public {
        OrchestratorV4TrustSurface memory surface = _surface();
        OrchestratorV4CutoverPostcondition postcondition = new OrchestratorV4CutoverPostcondition(surface);
        _executeBatch(_guard(surface, true, true), true, true);
        vm.prank(safe);
        orchestrator.setLifecycleHook(IIntentLifecycleHook(address(freshPolicy)));
        vm.expectRevert(
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.LifecycleHookMismatch.selector, address(freshPolicy))
        );
        postcondition.assertPostconditions();
    }

    function test_PostconditionRejectsUnregisteredO4() public {
        OrchestratorV4TrustSurface memory surface = _surface();
        OrchestratorV4CutoverPostcondition postcondition = new OrchestratorV4CutoverPostcondition(surface);
        _executeBatch(_guard(surface, true, true), true, true);
        vm.prank(safe);
        orchestratorRegistry.removeOrchestrator(address(orchestratorV4));
        vm.expectRevert(
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.OrchestratorV4RegistrationMismatch.selector, false)
        );
        postcondition.assertPostconditions();
    }

    function test_GuardRejectsReusedWhitelist() public {
        OrchestratorV4TrustSurface memory surface = _surface();
        surface.freshWhitelistPolicy = address(whitelistPolicy);
        _expectConstructorReverts(
            surface, abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshWhitelistPolicyNotDistinct.selector)
        );
    }

    function test_GuardRejectsFreshWhitelistGroupRegistryDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.mockCall(address(freshWhitelistPolicy), abi.encodeWithSignature("groupRegistry()"), abi.encode(other));
        _expectReady(
            guard,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.FreshWhitelistPolicyGroupRegistryMismatch.selector, other)
        );
    }

    function test_GuardRejectsWhitelistOwnerDrift() public {
        OrchestratorV4CutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        whitelistPolicy.transferOwnership(other);
        _expectReady(
            guard, abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.WhitelistPolicyOwnerMismatch.selector, other)
        );
    }

    function test_ConstructorsRejectCurrencyCountLengthMismatch() public {
        OrchestratorV4TrustSurface memory surface = _surface();
        surface.currencyCounts = new uint256[](2);
        _expectConstructorReverts(
            surface,
            abi.encodeWithSelector(OrchestratorV4TrustSurfaceChecks.CurrencyCountLengthMismatch.selector, uint256(2))
        );
    }

    function test_ConstructorsRejectFlattenedCurrencyLengthMismatch() public {
        OrchestratorV4TrustSurface memory surface = _surface();
        surface.currencies = new bytes32[](3);
        _expectConstructorReverts(
            surface,
            abi.encodeWithSelector(
                OrchestratorV4TrustSurfaceChecks.CurrencyConfigurationLengthMismatch.selector, uint256(3), uint256(4)
            )
        );
    }

    function _expectConstructorReverts(OrchestratorV4TrustSurface memory surface, bytes memory reason) internal {
        vm.expectRevert(reason);
        new OrchestratorV4CutoverGuard(surface, true, true);
        vm.expectRevert(reason);
        new OrchestratorV4CutoverPostcondition(surface);
    }

    function _expectReady(OrchestratorV4CutoverGuard guard, bytes memory reason) internal {
        vm.expectRevert(reason);
        guard.assertReady();
    }

    function _guard(OrchestratorV4TrustSurface memory surface, bool acceptVault, bool acceptPolicy)
        internal
        returns (OrchestratorV4CutoverGuard)
    {
        return new OrchestratorV4CutoverGuard(surface, acceptVault, acceptPolicy);
    }

    function _executeBatch(OrchestratorV4CutoverGuard guard, bool acceptVault, bool acceptPolicy) internal {
        bytes32[] memory methods = _methods();
        vm.startPrank(safe);
        guard.assertReady();
        if (acceptVault) freshVault.acceptOwnership();
        if (acceptPolicy) freshPolicy.acceptOwnership();
        disputeRegistry.addWritePermission(address(freshPolicy));
        nullifierRegistryV2.addWritePermission(address(freshVerifier));
        for (uint256 remaining = methods.length; remaining > 0; remaining--) {
            paymentVerifierRegistry.removePaymentMethod(methods[remaining - 1]);
        }
        for (uint256 methodIndex = 0; methodIndex < methods.length; methodIndex++) {
            paymentVerifierRegistry.addPaymentMethod(
                methods[methodIndex], address(freshVerifier), _currencies(methodIndex)
            );
        }
        nullifierRegistryV2.removeWritePermission(address(retiredVerifier));
        orchestratorRegistry.addOrchestrator(address(orchestratorV4));
        vm.stopPrank();
    }

    function _methods() internal pure returns (bytes32[] memory methods) {
        methods = new bytes32[](3);
        methods[0] = METHOD;
        methods[1] = PAYPAL;
        methods[2] = CASHAPP;
    }

    function _currencies(uint256 methodIndex) internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](methodIndex == 1 ? 2 : 1);
        currencies[0] = USD;
        if (methodIndex == 1) currencies[1] = EUR;
    }

    function _surface() internal view returns (OrchestratorV4TrustSurface memory surface) {
        surface.safe = safe;
        surface.disputeRegistry = address(disputeRegistry);
        surface.orchestrator = address(orchestrator);
        surface.orchestratorV4 = address(orchestratorV4);
        surface.orchestratorRegistry = address(orchestratorRegistry);
        surface.escrowRegistry = address(escrowRegistry);
        surface.paymentVerifierRegistry = address(paymentVerifierRegistry);
        surface.relayerRegistry = address(relayerRegistry);
        surface.protocolFeeRecipient = protocolFeeRecipient;
        surface.allowMultipleIntents = orchestrator.allowMultipleIntents();
        surface.whitelistPolicy = address(whitelistPolicy);
        surface.freshWhitelistPolicy = address(freshWhitelistPolicy);
        surface.groupRegistry = address(groupRegistry);
        surface.freshGroupRegistry = address(freshGroupRegistry);
        surface.attestationVerifier = address(attestationVerifier);
        surface.witnesses = new address[](1);
        surface.witnesses[0] = witness;
        surface.disputeVerifier = address(disputeVerifier);
        surface.nullifierRegistryV2 = address(nullifierRegistryV2);
        surface.predecessorPolicy = address(predecessorPolicy);
        surface.freshPolicy = address(freshPolicy);
        surface.freshVault = address(freshVault);
        surface.predecessorVault = address(predecessorVault);
        surface.predecessorHook = address(predecessorHook);
        surface.deployer = address(this);
        surface.whitelistPolicyOwner = safe;
        surface.stakeToken = address(token);
        surface.retiredVerifier = address(retiredVerifier);
        surface.verifier = address(freshVerifier);
        surface.paymentMethods = _methods();
        surface.currencyCounts = new uint256[](3);
        surface.currencyCounts[0] = 1;
        surface.currencyCounts[1] = 2;
        surface.currencyCounts[2] = 1;
        surface.currencies = new bytes32[](4);
        surface.currencies[0] = USD;
        surface.currencies[1] = USD;
        surface.currencies[2] = EUR;
        surface.currencies[3] = USD;
    }

    function _transfer(StakeVault target, bool accept) internal {
        target.transferOwnership(safe);
        if (accept) {
            vm.prank(safe);
            target.acceptOwnership();
        }
    }

    function _transfer(DisputeProtectionPolicy target, bool accept) internal {
        target.transferOwnership(safe);
        if (accept) {
            vm.prank(safe);
            target.acceptOwnership();
        }
    }

    function _transfer(DisputeVerifier target, bool accept) internal {
        target.transferOwnership(safe);
        if (accept) {
            vm.prank(safe);
            target.acceptOwnership();
        }
    }
}
