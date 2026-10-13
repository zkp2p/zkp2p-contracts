// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {InventoryTuple} from "contracts/mocks/DisputeMethodScopedActivationTypes.sol";
import {BypassTrustSurface, DisputeBypassTrustSurfaceChecks} from "contracts/mocks/DisputeBypassActivationTypes.sol";
import {DisputeBypassCutoverGuard} from "contracts/mocks/DisputeBypassCutoverGuard.sol";
import {DisputeBypassCutoverPostcondition} from "contracts/mocks/DisputeBypassCutoverPostcondition.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

/**
 * @title DisputeBypassActivationTest
 * @notice Exercises bypass activation and execution-time rejection of trust-surface drift.
 */
contract DisputeBypassActivationTest is OrchestratorV3Fixture {
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
    StakeVault internal freshVault;
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
        NullifierRegistry legacy = new NullifierRegistry();
        nullifierRegistryV2 = new NullifierRegistryV2(legacy);
        disputeRegistry = new NullifierRegistry();
        address[] memory witnesses = new address[](1);
        witnesses[0] = witness;
        attestationVerifier = new MultiAttestationVerifier(witnesses, 1);
        disputeVerifier = new DisputeVerifier(address(this), nullifierRegistryV2, attestationVerifier);
        predecessorVault = new StakeVault(address(this), token, address(0), CONTROLLER_CHANGE_DELAY);
        freshVault = new StakeVault(address(this), token, address(0), 0);
        predecessorPolicy =
            new DisputeProtectionPolicy(address(this), predecessorVault, disputeVerifier, disputeRegistry);
        freshPolicy = new DisputeProtectionPolicy(address(this), freshVault, disputeVerifier, disputeRegistry);
        groupRegistry = new AddressGroupRegistry();
        whitelistPolicy = new WhitelistPolicy(groupRegistry, escrowRegistry, orchestratorRegistry);
        predecessorHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, predecessorPolicy);
        freshHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, freshPolicy);
        predecessorVault.initializeController(address(predecessorPolicy));
        freshVault.initializeController(address(freshPolicy));
        disputeRegistry.addWritePermission(address(predecessorPolicy));
        predecessorPolicy.setLifecycleHookAuthorization(address(predecessorHook), true);
        freshPolicy.setLifecycleHookAuthorization(address(freshHook), true);
        predecessorPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        freshPolicy.setRiskWindow(METHOD, predecessorPolicy.getRiskWindow(METHOD));
        orchestrator.setLifecycleHook(predecessorHook);
        orchestrator.setAllowMultipleIntents(false);
        vm.prank(depositor);
        freshPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        vm.prank(depositor);
        predecessorPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        predecessorPolicy.setRiskWindow(PAYPAL, RISK_WINDOW);
        freshPolicy.setRiskWindow(PAYPAL, predecessorPolicy.getRiskWindow(PAYPAL));
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
        _transfer(freshVault, false);
        _transfer(freshPolicy, false);
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
            BypassTrustSurface memory surface = _surface();
            DisputeBypassCutoverGuard guard = _guard(surface, acceptVault, acceptPolicy);
            DisputeBypassCutoverPostcondition postcondition = new DisputeBypassCutoverPostcondition(surface);
            guard.assertReady();
            _executeBatch(guard, acceptVault, acceptPolicy);
            postcondition.assertPostconditions();
        }
    }

    function test_PostconditionRejectsBeforeBatchAndGuardRejectsAfterBatch() public {
        BypassTrustSurface memory surface = _surface();
        DisputeBypassCutoverGuard guard = _guard(surface, true, true);
        DisputeBypassCutoverPostcondition postcondition = new DisputeBypassCutoverPostcondition(surface);
        vm.expectRevert(
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.FreshVaultOwnerMismatch.selector, address(this))
        );
        postcondition.assertPostconditions();
        _executeBatch(guard, true, true);
        postcondition.assertPostconditions();
        vm.expectRevert(abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.FreshVaultOwnerMismatch.selector, safe));
        guard.assertReady();
        DisputeBypassCutoverGuard acceptedGuard = _guard(surface, false, false);
        vm.expectRevert(
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.DisputeWriterCountMismatch.selector, uint256(2))
        );
        acceptedGuard.assertReady();
    }

    function test_GuardRejectsDisputeWriterDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        disputeRegistry.addWritePermission(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.DisputeWriterCountMismatch.selector, uint256(2))
        );
        vm.prank(safe);
        disputeRegistry.removeWritePermission(address(predecessorPolicy));
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.DisputeWriterMismatch.selector, uint256(0), other)
        );
    }

    function test_GuardRejectsNullifierWriterDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        nullifierRegistryV2.addWritePermission(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.NullifierWriterCountMismatch.selector, uint256(2))
        );
        vm.prank(safe);
        nullifierRegistryV2.removeWritePermission(address(retiredVerifier));
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.NullifierWriterMismatch.selector, uint256(0), other)
        );
    }

    function test_GuardRejectsRouteVerifierDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.startPrank(safe);
        paymentVerifierRegistry.removePaymentMethod(CASHAPP);
        paymentVerifierRegistry.addPaymentMethod(CASHAPP, address(freshVerifier), _currencies(2));
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(
                DisputeBypassTrustSurfaceChecks.RouteVerifierMismatch.selector, CASHAPP, address(freshVerifier)
            )
        );
    }

    function test_GuardRejectsCurrencyListDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
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
                DisputeBypassTrustSurfaceChecks.RouteCurrencyMismatch.selector, PAYPAL, uint256(0), EUR
            )
        );
    }

    function test_GuardRejectsCurrencyCountDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.startPrank(safe);
        paymentVerifierRegistry.removePaymentMethod(CASHAPP);
        paymentVerifierRegistry.addPaymentMethod(CASHAPP, address(retiredVerifier), _currencies(1));
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(
                DisputeBypassTrustSurfaceChecks.RouteCurrencyCountMismatch.selector, CASHAPP, uint256(2)
            )
        );
    }

    function test_GuardRejectsRegistryOrderDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.startPrank(safe);
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(retiredVerifier), _currencies(0));
        vm.stopPrank();
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.RegistryMethodMismatch.selector, uint256(0), CASHAPP)
        );
    }

    function test_GuardRejectsHookDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        orchestrator.setLifecycleHook(freshHook);
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.LifecycleHookMismatch.selector, address(freshHook))
        );
    }

    function test_GuardRejectsFreshVaultDelay() public {
        StakeVault delayedVault = new StakeVault(address(this), token, address(0), CONTROLLER_CHANGE_DELAY);
        DisputeProtectionPolicy delayedPolicy =
            new DisputeProtectionPolicy(address(this), delayedVault, disputeVerifier, disputeRegistry);
        IntentLifecycleHookV1 delayedHook =
            new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, delayedPolicy);
        delayedVault.initializeController(address(delayedPolicy));
        BypassTrustSurface memory surface = _surface();
        surface.freshVault = address(delayedVault);
        surface.freshPolicy = address(delayedPolicy);
        surface.freshHook = address(delayedHook);
        DisputeBypassCutoverGuard guard = _guard(surface, true, true);
        _expectReady(
            guard,
            abi.encodeWithSelector(
                DisputeBypassTrustSurfaceChecks.FreshVaultControllerChangeDelayMismatch.selector,
                CONTROLLER_CHANGE_DELAY
            )
        );
    }

    function test_GuardRejectsRiskWindowDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        freshPolicy.setRiskWindow(PAYPAL, RISK_WINDOW + 1);
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.RiskWindowMismatch.selector, PAYPAL, RISK_WINDOW + 1)
        );
    }

    function test_GuardRejectsPredecessorHookDeauthorization() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        predecessorPolicy.setLifecycleHookAuthorization(address(predecessorHook), false);
        _expectReady(
            guard,
            abi.encodeWithSelector(
                DisputeBypassTrustSurfaceChecks.PredecessorPolicyHookAuthorizationMismatch.selector, false
            )
        );
    }

    function test_GuardRejectsVerifierMethodListDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        freshVerifier.removePaymentMethod(METHOD);
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.VerifierMethodCountMismatch.selector, uint256(2))
        );
        vm.prank(safe);
        freshVerifier.addPaymentMethod(METHOD);
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.VerifierMethodMismatch.selector, uint256(0), CASHAPP)
        );
    }

    function test_GuardRejectsOwnershipPredicates() public {
        _expectReady(
            _guard(_surface(), false, true),
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.FreshVaultOwnerMismatch.selector, address(this))
        );
        _expectReady(
            _guard(_surface(), true, false),
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.FreshPolicyOwnerMismatch.selector, address(this))
        );
        vm.startPrank(safe);
        freshVault.acceptOwnership();
        freshPolicy.acceptOwnership();
        vm.stopPrank();
        _expectReady(
            _guard(_surface(), true, false),
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.FreshVaultOwnerMismatch.selector, safe)
        );
        _expectReady(
            _guard(_surface(), false, true),
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.FreshPolicyOwnerMismatch.selector, safe)
        );
    }

    function test_GuardRejectsPendingOwnershipDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        freshVault.transferOwnership(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.FreshVaultPendingOwnerMismatch.selector, other)
        );
        freshVault.transferOwnership(safe);
        freshPolicy.transferOwnership(other);
        _expectReady(
            guard,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.FreshPolicyPendingOwnerMismatch.selector, other)
        );
    }

    function test_GuardRejectsInventoryTupleReenabled() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(depositor);
        freshPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, true);
        _expectReady(
            guard,
            abi.encodeWithSelector(
                DisputeBypassTrustSurfaceChecks.InventoryTupleProtectionMismatch.selector,
                address(escrow),
                depositId,
                METHOD,
                true
            )
        );
    }

    function test_GuardRejectsWhitelistOwnerDrift() public {
        DisputeBypassCutoverGuard guard = _guard(_surface(), true, true);
        vm.prank(safe);
        whitelistPolicy.transferOwnership(other);
        _expectReady(
            guard, abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.WhitelistPolicyOwnerMismatch.selector, other)
        );
    }

    function test_ConstructorsRejectCurrencyCountLengthMismatch() public {
        BypassTrustSurface memory surface = _surface();
        surface.currencyCounts = new uint256[](2);
        _expectConstructorReverts(
            surface,
            abi.encodeWithSelector(DisputeBypassTrustSurfaceChecks.CurrencyCountLengthMismatch.selector, uint256(2))
        );
    }

    function test_ConstructorsRejectFlattenedCurrencyLengthMismatch() public {
        BypassTrustSurface memory surface = _surface();
        surface.currencies = new bytes32[](3);
        _expectConstructorReverts(
            surface,
            abi.encodeWithSelector(
                DisputeBypassTrustSurfaceChecks.CurrencyConfigurationLengthMismatch.selector, uint256(3), uint256(4)
            )
        );
    }

    function test_ConstructorsRejectRiskWindowLengthMismatch() public {
        BypassTrustSurface memory surface = _surface();
        surface.riskWindows = new uint64[](2);
        _expectConstructorReverts(
            surface,
            abi.encodeWithSelector(
                DisputeBypassTrustSurfaceChecks.RiskWindowConfigurationLengthMismatch.selector, uint256(3), uint256(2)
            )
        );
    }

    function _expectConstructorReverts(BypassTrustSurface memory surface, bytes memory reason) internal {
        InventoryTuple[] memory inventory = _inventory();
        vm.expectRevert(reason);
        new DisputeBypassCutoverGuard(surface, true, true, inventory);
        vm.expectRevert(reason);
        new DisputeBypassCutoverPostcondition(surface);
    }

    function _expectReady(DisputeBypassCutoverGuard guard, bytes memory reason) internal {
        vm.expectRevert(reason);
        guard.assertReady();
    }

    function _guard(BypassTrustSurface memory surface, bool acceptVault, bool acceptPolicy)
        internal
        returns (DisputeBypassCutoverGuard)
    {
        return new DisputeBypassCutoverGuard(surface, acceptVault, acceptPolicy, _inventory());
    }

    function _executeBatch(DisputeBypassCutoverGuard guard, bool acceptVault, bool acceptPolicy) internal {
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
        orchestrator.setLifecycleHook(freshHook);
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

    function _surface() internal view returns (BypassTrustSurface memory surface) {
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
        surface.riskWindowMethods = _methods();
        surface.riskWindows = new uint64[](3);
        surface.riskWindows[0] = RISK_WINDOW;
        surface.riskWindows[1] = RISK_WINDOW;
    }

    function _inventory() internal view returns (InventoryTuple[] memory tuples) {
        tuples = new InventoryTuple[](1);
        tuples[0] = InventoryTuple(address(escrow), depositId, METHOD);
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
