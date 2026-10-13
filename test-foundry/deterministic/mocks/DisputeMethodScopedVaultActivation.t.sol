// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {InventoryTuple} from "contracts/mocks/DisputeMethodScopedActivationTypes.sol";
import {
    DisputeMethodScopedVaultTrustSurfaceChecks,
    VaultIdentities,
    VaultTrustSurface
} from "contracts/mocks/DisputeMethodScopedVaultActivationTypes.sol";
import {DisputeMethodScopedVaultCutoverGuard} from "contracts/mocks/DisputeMethodScopedVaultCutoverGuard.sol";
import {
    DisputeMethodScopedVaultWriterRemovalGuard
} from "contracts/mocks/DisputeMethodScopedVaultWriterRemovalGuard.sol";
import {
    DisputeMethodScopedVaultCutoverPostcondition
} from "contracts/mocks/DisputeMethodScopedVaultCutoverPostcondition.sol";
import {
    DisputeMethodScopedVaultWriterRemovalPostcondition
} from "contracts/mocks/DisputeMethodScopedVaultWriterRemovalPostcondition.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract DisputeMethodScopedVaultActivationTest is OrchestratorV3Fixture {
    uint64 internal constant RISK_WINDOW = 30 days;
    uint64 internal constant CONTROLLER_CHANGE_DELAY = 2 days;
    bytes32 internal constant SETTLED_INTENT = keccak256("vault-settled");
    bytes32 internal constant CANCELLED_INTENT = keccak256("vault-cancelled");

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
        freshVault = new StakeVault(address(this), token, address(0), CONTROLLER_CHANGE_DELAY);
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
        freshPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        orchestrator.setLifecycleHook(predecessorHook);
        orchestrator.setAllowMultipleIntents(false);
        vm.prank(depositor);
        freshPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        _stake(taker, 500e6);
        vm.startPrank(address(predecessorHook));
        predecessorPolicy.onIntentSignaled(SETTLED_INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        predecessorPolicy.onIntentSettled(SETTLED_INTENT, 40e6, false);
        predecessorPolicy.onIntentSignaled(CANCELLED_INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        predecessorPolicy.onIntentCancelled(CANCELLED_INTENT);
        vm.stopPrank();
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

    function test_CutoverGuardPassesForEveryConditionalAcceptanceCombination() public {
        for (uint256 mask = 0; mask < 4; mask++) {
            setUp();
            bool vaultAccepted = mask & 1 != 0;
            bool policyAccepted = mask & 2 != 0;
            if (vaultAccepted) {
                vm.prank(safe);
                freshVault.acceptOwnership();
            }
            if (policyAccepted) {
                vm.prank(safe);
                freshPolicy.acceptOwnership();
            }
            _cutover(!vaultAccepted, !policyAccepted, escrow.depositCounter()).assertReady();
        }
    }

    function test_CutoverGuardPassesWhenDepositCounterAdvancesAboveProof() public {
        _cutover(true, true, escrow.depositCounter() - 1).assertReady();
    }

    function test_CutoverGuardRejectsDepositCounterBelowProof() public {
        uint256 actualCounter = escrow.depositCounter();
        uint256 pinnedCounter = actualCounter + 1;
        DisputeMethodScopedVaultCutoverGuard guard = _cutover(true, true, pinnedCounter);
        vm.expectRevert(
            abi.encodeWithSelector(
                DisputeMethodScopedVaultTrustSurfaceChecks.DepositCounterBelowProof.selector,
                actualCounter,
                pinnedCounter
            )
        );
        guard.assertReady();
    }

    function test_CutoverGuardRejectsOwnershipPredicates() public {
        _expectCutover(
            _surface(),
            false,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.FreshVaultOwnerMismatch.selector
        );
        setUp();
        freshVault.transferOwnership(other);
        _expectCutover(
            _surface(),
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.FreshVaultPendingOwnerMismatch.selector
        );
        setUp();
        _expectCutover(
            _surface(),
            true,
            false,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.FreshPolicyOwnerMismatch.selector
        );
        setUp();
        freshPolicy.transferOwnership(other);
        _expectCutover(
            _surface(),
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.FreshPolicyPendingOwnerMismatch.selector
        );
    }

    function test_CutoverGuardRejectsBothVaultIdentityDrifts() public {
        VaultTrustSurface memory surface = _surface();
        surface.vaults.freshVault = address(predecessorVault);
        _expectCutover(
            surface,
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.FreshPolicyStakeVaultMismatch.selector
        );
        surface = _surface();
        surface.vaults.predecessorVault = address(freshVault);
        _expectCutover(
            surface,
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.PredecessorPolicyStakeVaultMismatch.selector
        );
    }

    function test_CutoverGuardRejectsWriterHookInventoryAndCounter() public {
        vm.prank(safe);
        disputeRegistry.addWritePermission(address(freshPolicy));
        _expectCutover(
            _surface(),
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.RegistryWriterCountMismatch.selector
        );
        vm.prank(safe);
        disputeRegistry.removeWritePermission(address(freshPolicy));
        vm.prank(safe);
        orchestrator.setLifecycleHook(freshHook);
        _expectCutover(
            _surface(),
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.LifecycleHookMismatch.selector
        );
        vm.prank(safe);
        orchestrator.setLifecycleHook(predecessorHook);
        vm.prank(depositor);
        freshPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, true);
        _expectCutover(
            _surface(),
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.InventoryTupleProtectionMismatch.selector
        );
        vm.prank(depositor);
        freshPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
    }

    function test_CutoverGuardRejectsFreshPolicyAndSharedSurfaceDrift() public {
        freshPolicy.setLifecycleHookAuthorization(address(freshHook), false);
        _expectCutover(
            _surface(),
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.FreshHookAuthorizationMismatch.selector
        );
        freshPolicy.setLifecycleHookAuthorization(address(freshHook), true);
        freshPolicy.setRiskWindow(METHOD, RISK_WINDOW + 1);
        _expectCutover(
            _surface(),
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.RiskWindowMismatch.selector
        );
        freshPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        VaultTrustSurface memory pinnedSurface = _surface();
        vm.prank(safe);
        orchestrator.setAllowMultipleIntents(true);
        _expectCutover(
            pinnedSurface,
            true,
            true,
            escrow.depositCounter(),
            DisputeMethodScopedVaultTrustSurfaceChecks.OrchestratorAllowMultipleIntentsMismatch.selector
        );
    }

    function test_WriterRemovalGuardPassesReleasedAndCancelledStatusMatrix() public {
        _activateAndDrain();
        new DisputeMethodScopedVaultWriterRemovalGuard(_surface(), _hashes(SETTLED_INTENT, CANCELLED_INTENT))
            .assertReady();
    }

    function test_WriterRemovalGuardRejectsNonterminalAndTerminalLockedMatrix() public {
        _activate();
        DisputeMethodScopedVaultWriterRemovalGuard guard =
            new DisputeMethodScopedVaultWriterRemovalGuard(_surface(), _hashes(SETTLED_INTENT));
        vm.expectPartialRevert(DisputeMethodScopedVaultTrustSurfaceChecks.PredecessorIntentStatusMismatch.selector);
        guard.assertReady();
        vm.prank(address(predecessorPolicy));
        predecessorVault.lockStake(taker, CANCELLED_INTENT, 1, uint64(block.timestamp + 1));
        guard = new DisputeMethodScopedVaultWriterRemovalGuard(_surface(), _hashes(CANCELLED_INTENT));
        vm.expectPartialRevert(DisputeMethodScopedVaultTrustSurfaceChecks.PredecessorIntentLockAmountMismatch.selector);
        guard.assertReady();
    }

    function test_WriterRemovalGuardRejectsWriterOrderAndHook() public {
        _acceptFresh();
        vm.startPrank(safe);
        disputeRegistry.removeWritePermission(address(predecessorPolicy));
        disputeRegistry.addWritePermission(address(freshPolicy));
        disputeRegistry.addWritePermission(address(predecessorPolicy));
        orchestrator.setLifecycleHook(freshHook);
        vm.stopPrank();
        DisputeMethodScopedVaultWriterRemovalGuard guard =
            new DisputeMethodScopedVaultWriterRemovalGuard(_surface(), new bytes32[](0));
        vm.expectPartialRevert(DisputeMethodScopedVaultTrustSurfaceChecks.RegistryWriterMismatch.selector);
        guard.assertReady();
        setUp();
        _activateAndDrain();
        vm.prank(safe);
        orchestrator.setLifecycleHook(predecessorHook);
        guard = new DisputeMethodScopedVaultWriterRemovalGuard(_surface(), _hashes(SETTLED_INTENT));
        vm.expectPartialRevert(DisputeMethodScopedVaultTrustSurfaceChecks.LifecycleHookMismatch.selector);
        guard.assertReady();
    }

    function test_PostconditionsCoverCutoverAndWriterRemoval() public {
        _activate();
        new DisputeMethodScopedVaultCutoverPostcondition(_surface()).assertPostconditions();
        vm.prank(safe);
        disputeRegistry.removeWritePermission(address(predecessorPolicy));
        new DisputeMethodScopedVaultWriterRemovalPostcondition(_surface()).assertPostconditions();
        vm.prank(safe);
        disputeRegistry.addWritePermission(address(predecessorPolicy));
        DisputeMethodScopedVaultWriterRemovalPostcondition postcondition =
            new DisputeMethodScopedVaultWriterRemovalPostcondition(_surface());
        vm.expectPartialRevert(DisputeMethodScopedVaultTrustSurfaceChecks.RegistryWriterCountMismatch.selector);
        postcondition.assertPostconditions();
    }

    function _activate() internal {
        _acceptFresh();
        vm.startPrank(safe);
        disputeRegistry.addWritePermission(address(freshPolicy));
        orchestrator.setLifecycleHook(freshHook);
        vm.stopPrank();
    }

    function _activateAndDrain() internal {
        _activate();
        vm.warp(predecessorPolicy.getDisputeProtectionIntent(SETTLED_INTENT).releaseEligibleAt);
        predecessorPolicy.releaseMaturedDisputeProtectionIntent(SETTLED_INTENT);
    }

    function _acceptFresh() internal {
        vm.startPrank(safe);
        freshVault.acceptOwnership();
        freshPolicy.acceptOwnership();
        vm.stopPrank();
    }

    function _cutover(bool vaultAcceptance, bool policyAcceptance, uint256 counter)
        internal
        returns (DisputeMethodScopedVaultCutoverGuard)
    {
        return _cutoverFor(_surface(), vaultAcceptance, policyAcceptance, counter);
    }

    function _cutoverFor(VaultTrustSurface memory surface, bool vaultAcceptance, bool policyAcceptance, uint256 counter)
        internal
        returns (DisputeMethodScopedVaultCutoverGuard)
    {
        return new DisputeMethodScopedVaultCutoverGuard(
            surface, vaultAcceptance, policyAcceptance, _inventory(), address(escrow), counter
        );
    }

    function _expectCutover(
        VaultTrustSurface memory surface,
        bool vaultAcceptance,
        bool policyAcceptance,
        uint256 counter,
        bytes4 selector
    ) internal {
        DisputeMethodScopedVaultCutoverGuard guard = _cutoverFor(surface, vaultAcceptance, policyAcceptance, counter);
        vm.expectPartialRevert(selector);
        guard.assertReady();
    }

    function _surface() internal view returns (VaultTrustSurface memory surface) {
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
        surface.vaults = VaultIdentities(address(freshVault), address(predecessorVault));
        surface.predecessorHook = address(predecessorHook);
        surface.paymentMethods = new bytes32[](1);
        surface.paymentMethods[0] = METHOD;
        surface.riskWindows = new uint64[](1);
        surface.riskWindows[0] = RISK_WINDOW;
    }

    function _inventory() internal view returns (InventoryTuple[] memory tuples) {
        tuples = new InventoryTuple[](1);
        tuples[0] = InventoryTuple(address(escrow), depositId, METHOD);
    }

    function _hashes(bytes32 value) internal pure returns (bytes32[] memory values) {
        values = new bytes32[](1);
        values[0] = value;
    }

    function _hashes(bytes32 first, bytes32 second) internal pure returns (bytes32[] memory values) {
        values = new bytes32[](2);
        values[0] = first;
        values[1] = second;
    }

    function _stake(address owner, uint256 amount) internal {
        token.transfer(owner, amount);
        vm.startPrank(owner);
        token.approve(address(predecessorVault), amount);
        predecessorVault.depositStake(amount);
        vm.stopPrank();
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
