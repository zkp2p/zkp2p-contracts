// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {
    IActivationAttestationVerifier,
    IActivationDisputeVerifier,
    IActivationLifecycleHook,
    IActivationOrchestrator,
    IActivationOrchestratorRegistry,
    IActivationOwned,
    IActivationPolicy,
    IActivationRegistry,
    IActivationVault,
    IActivationWhitelistPolicy
} from "./DisputeMethodScopedActivationTypes.sol";

struct BypassTrustSurface {
    address safe;
    address deployer;
    address orchestrator;
    address orchestratorRegistry;
    address escrowRegistry;
    address paymentVerifierRegistry;
    address relayerRegistry;
    address protocolFeeRecipient;
    bool allowMultipleIntents;
    address nullifierRegistryV2;
    address retiredVerifier;
    address verifier;
    address attestationVerifier;
    address[] witnesses;
    address disputeRegistry;
    address disputeVerifier;
    address whitelistPolicy;
    address whitelistPolicyOwner;
    address groupRegistry;
    address stakeToken;
    address predecessorVault;
    address predecessorPolicy;
    address predecessorHook;
    address freshVault;
    address freshPolicy;
    address freshHook;
    bytes32[] paymentMethods;
    bytes32[] currencies;
    uint256[] currencyCounts;
    bytes32[] riskWindowMethods;
    uint64[] riskWindows;
}

interface IBypassActivationPaymentVerifierRegistry is IActivationOwned {
    /// @notice Returns payment methods in their stored order.
    function getPaymentMethods() external view returns (bytes32[] memory);
    /// @notice Returns the verifier routing for a payment method.
    function getVerifier(bytes32 paymentMethod) external view returns (address);
    /// @notice Returns the ordered currency list for a payment method.
    function getCurrencies(bytes32 paymentMethod) external view returns (bytes32[] memory);
}

interface IBypassActivationVerifier is IActivationOwned {
    /// @notice Returns payment methods in their stored order.
    function getPaymentMethods() external view returns (bytes32[] memory);
    /// @notice Returns the verifier orchestrator registry.
    function orchestratorRegistry() external view returns (address);
    /// @notice Returns the verifier payment nullifier registry.
    function nullifierRegistry() external view returns (address);
    /// @notice Returns the verifier attestation verifier.
    function attestationVerifier() external view returns (address);
}

interface IBypassActivationVault is IActivationVault {
    /// @notice Returns the vault stake token.
    function stakeToken() external view returns (address);
}

/**
 * @title DisputeBypassTrustSurfaceChecks
 * @notice Shared execution-time assertions for the bypass activation artifacts.
 */
abstract contract DisputeBypassTrustSurfaceChecks {
    error RiskWindowConfigurationLengthMismatch(uint256 paymentMethodCount, uint256 riskWindowCount);
    error RegistryOwnerMismatch(address actual);
    error OrchestratorOwnerMismatch(address actual);
    error OrchestratorPausedMismatch(bool actual);
    error OrchestratorEscrowRegistryMismatch(address actual);
    error OrchestratorPaymentVerifierRegistryMismatch(address actual);
    error OrchestratorRelayerRegistryMismatch(address actual);
    error OrchestratorProtocolFeeMismatch(uint256 actual);
    error OrchestratorProtocolFeeRecipientMismatch(address actual);
    error OrchestratorAllowMultipleIntentsMismatch(bool actual);
    error OrchestratorRegistrationMismatch(bool actual);
    error FreshHookOrchestratorRegistryMismatch(address actual);
    error FreshHookWhitelistPolicyMismatch(address actual);
    error FreshHookDisputeProtectionPolicyMismatch(address actual);
    error WhitelistPolicyOwnerMismatch(address actual);
    error WhitelistPolicyEscrowRegistryMismatch(address actual);
    error WhitelistPolicyGroupRegistryMismatch(address actual);
    error WhitelistPolicyOrchestratorRegistryMismatch(address actual);
    error AttestationVerifierOwnerMismatch(address actual);
    error AttestationVerifierRequiredSignaturesMismatch(uint256 actual);
    error AttestationVerifierWitnessCountMismatch(uint256 actual);
    error AttestationVerifierWitnessMismatch(uint256 index, address actual);
    error DisputeVerifierOwnerMismatch(address actual);
    error DisputeVerifierPendingOwnerMismatch(address actual);
    error DisputeVerifierAttestationVerifierMismatch(address actual);
    error DisputeVerifierNullifierRegistryMismatch(address actual);
    error PredecessorPolicyOwnerMismatch(address actual);
    error PredecessorPolicyPendingOwnerMismatch(address actual);
    error PredecessorPolicyDisputeVerifierMismatch(address actual);
    error PredecessorPolicyDisputeRegistryMismatch(address actual);
    error PredecessorPolicyStakeVaultMismatch(address actual);
    error FreshPolicyDisputeVerifierMismatch(address actual);
    error FreshPolicyDisputeRegistryMismatch(address actual);
    error FreshPolicyStakeVaultMismatch(address actual);
    error FreshVaultControllerMismatch(address actual);
    error FreshVaultPendingControllerMismatch(address actual);
    error FreshVaultPendingControllerValidAtMismatch(uint64 actual);
    error FreshVaultControllerChangeDelayMismatch(uint64 actual);
    error FreshVaultStakeTokenMismatch(address actual);
    error FreshVaultOwnerMismatch(address actual);
    error FreshVaultPendingOwnerMismatch(address actual);
    error FreshPolicyOwnerMismatch(address actual);
    error FreshPolicyPendingOwnerMismatch(address actual);
    error FreshPolicyAdmissionsPausedMismatch(bool actual);
    error FreshHookAuthorizationMismatch(bool actual);
    error PredecessorHookAuthorizationMismatch(bool actual);
    error RiskWindowMismatch(bytes32 paymentMethod, uint64 actual);
    error DisputeWriterCountMismatch(uint256 actual);
    error DisputeWriterMismatch(uint256 index, address actual);
    error LifecycleHookMismatch(address actual);
    error InventoryTupleProtectionMismatch(address escrow, uint256 depositId, bytes32 paymentMethod, bool actual);

    error CurrencyCountLengthMismatch(uint256 actual);
    error CurrencyConfigurationLengthMismatch(uint256 actual, uint256 expectedTotal);
    error NullifierRegistryOwnerMismatch(address actual);
    error PaymentVerifierRegistryOwnerMismatch(address actual);
    error RetiredVerifierOwnerMismatch(address actual);
    error VerifierOwnerMismatch(address actual);
    error VerifierOrchestratorRegistryMismatch(address actual);
    error VerifierNullifierRegistryMismatch(address actual);
    error VerifierAttestationVerifierMismatch(address actual);
    error VerifierMethodCountMismatch(uint256 actual);
    error VerifierMethodMismatch(uint256 index, bytes32 actual);
    error PredecessorVaultOwnerMismatch(address actual);
    error PredecessorVaultControllerMismatch(address actual);
    error PredecessorPolicyHookAuthorizationMismatch(bool actual);
    error NullifierWriterCountMismatch(uint256 actual);
    error NullifierWriterMismatch(uint256 index, address actual);
    error RegistryMethodCountMismatch(uint256 actual);
    error RegistryMethodMismatch(uint256 index, bytes32 actual);
    error RouteVerifierMismatch(bytes32 paymentMethod, address actual);
    error RouteCurrencyCountMismatch(bytes32 paymentMethod, uint256 actual);
    error RouteCurrencyMismatch(bytes32 paymentMethod, uint256 index, bytes32 actual);

    BypassTrustSurface internal expected;

    constructor(BypassTrustSurface memory _expected) {
        if (_expected.riskWindowMethods.length != _expected.riskWindows.length) {
            revert RiskWindowConfigurationLengthMismatch(
                _expected.riskWindowMethods.length, _expected.riskWindows.length
            );
        }
        if (_expected.paymentMethods.length != _expected.currencyCounts.length) {
            revert CurrencyCountLengthMismatch(_expected.currencyCounts.length);
        }
        uint256 totalCurrencies;
        for (uint256 methodIndex = 0; methodIndex < _expected.currencyCounts.length; methodIndex++) {
            totalCurrencies += _expected.currencyCounts[methodIndex];
        }
        if (totalCurrencies != _expected.currencies.length) {
            revert CurrencyConfigurationLengthMismatch(_expected.currencies.length, totalCurrencies);
        }
        expected = _expected;
    }

    function _assertTrustSurface() internal view {
        _assertVerifierSurface();
        address actual = IActivationRegistry(expected.disputeRegistry).owner();
        if (actual != expected.safe) revert RegistryOwnerMismatch(actual);
        _assertOrchestratorSurface();
        _assertFreshHookSurface();
        _assertWhitelistSurface();
        _assertAttestationSurface();
        _assertDisputeVerifierSurface();
        _assertPredecessorSurface();
        _assertFreshStackSurface();
    }

    function _assertOrchestratorSurface() private view {
        IActivationOrchestrator targetOrchestrator = IActivationOrchestrator(expected.orchestrator);
        address actualAddress = targetOrchestrator.owner();
        if (actualAddress != expected.safe) revert OrchestratorOwnerMismatch(actualAddress);
        bool actualBool = targetOrchestrator.paused();
        if (actualBool) revert OrchestratorPausedMismatch(actualBool);
        actualAddress = targetOrchestrator.escrowRegistry();
        if (actualAddress != expected.escrowRegistry) revert OrchestratorEscrowRegistryMismatch(actualAddress);
        actualAddress = targetOrchestrator.paymentVerifierRegistry();
        if (actualAddress != expected.paymentVerifierRegistry) {
            revert OrchestratorPaymentVerifierRegistryMismatch(actualAddress);
        }
        actualAddress = targetOrchestrator.relayerRegistry();
        if (actualAddress != expected.relayerRegistry) revert OrchestratorRelayerRegistryMismatch(actualAddress);
        uint256 actualUint256 = targetOrchestrator.protocolFee();
        if (actualUint256 != 0) revert OrchestratorProtocolFeeMismatch(actualUint256);
        actualAddress = targetOrchestrator.protocolFeeRecipient();
        if (actualAddress != expected.protocolFeeRecipient) {
            revert OrchestratorProtocolFeeRecipientMismatch(actualAddress);
        }
        actualBool = targetOrchestrator.allowMultipleIntents();
        if (actualBool != expected.allowMultipleIntents) {
            revert OrchestratorAllowMultipleIntentsMismatch(actualBool);
        }
        actualBool =
            IActivationOrchestratorRegistry(expected.orchestratorRegistry).isOrchestrator(expected.orchestrator);
        if (!actualBool) revert OrchestratorRegistrationMismatch(actualBool);
    }

    function _assertFreshHookSurface() private view {
        IActivationLifecycleHook targetHook = IActivationLifecycleHook(expected.freshHook);
        address actualAddress = targetHook.orchestratorRegistry();
        if (actualAddress != expected.orchestratorRegistry) {
            revert FreshHookOrchestratorRegistryMismatch(actualAddress);
        }
        actualAddress = targetHook.whitelistPolicy();
        if (actualAddress != expected.whitelistPolicy) revert FreshHookWhitelistPolicyMismatch(actualAddress);
        actualAddress = targetHook.disputeProtectionPolicy();
        if (actualAddress != expected.freshPolicy) revert FreshHookDisputeProtectionPolicyMismatch(actualAddress);
    }

    function _assertWhitelistSurface() private view {
        IActivationWhitelistPolicy targetWhitelist = IActivationWhitelistPolicy(expected.whitelistPolicy);
        address actualAddress = targetWhitelist.owner();
        if (actualAddress != expected.whitelistPolicyOwner) revert WhitelistPolicyOwnerMismatch(actualAddress);
        actualAddress = targetWhitelist.escrowRegistry();
        if (actualAddress != expected.escrowRegistry) revert WhitelistPolicyEscrowRegistryMismatch(actualAddress);
        actualAddress = targetWhitelist.groupRegistry();
        if (actualAddress != expected.groupRegistry) revert WhitelistPolicyGroupRegistryMismatch(actualAddress);
        actualAddress = targetWhitelist.orchestratorRegistry();
        if (actualAddress != expected.orchestratorRegistry) {
            revert WhitelistPolicyOrchestratorRegistryMismatch(actualAddress);
        }
    }

    function _assertAttestationSurface() private view {
        IActivationAttestationVerifier targetAttestation = IActivationAttestationVerifier(expected.attestationVerifier);
        address actualAddress = targetAttestation.owner();
        if (actualAddress != expected.safe) revert AttestationVerifierOwnerMismatch(actualAddress);
        uint256 actualUint256 = targetAttestation.requiredSignatures();
        if (actualUint256 != 1) revert AttestationVerifierRequiredSignaturesMismatch(actualUint256);
        address[] memory actualWitnesses = targetAttestation.witnesses();
        if (actualWitnesses.length != expected.witnesses.length) {
            revert AttestationVerifierWitnessCountMismatch(actualWitnesses.length);
        }
        for (uint256 witnessIndex = 0; witnessIndex < actualWitnesses.length; witnessIndex++) {
            if (actualWitnesses[witnessIndex] != expected.witnesses[witnessIndex]) {
                revert AttestationVerifierWitnessMismatch(witnessIndex, actualWitnesses[witnessIndex]);
            }
        }
    }

    function _assertDisputeVerifierSurface() private view {
        IActivationDisputeVerifier targetVerifier = IActivationDisputeVerifier(expected.disputeVerifier);
        address actualAddress = targetVerifier.owner();
        if (actualAddress != expected.safe) revert DisputeVerifierOwnerMismatch(actualAddress);
        actualAddress = targetVerifier.pendingOwner();
        if (actualAddress != address(0)) revert DisputeVerifierPendingOwnerMismatch(actualAddress);
        actualAddress = targetVerifier.attestationVerifier();
        if (actualAddress != expected.attestationVerifier) {
            revert DisputeVerifierAttestationVerifierMismatch(actualAddress);
        }
        actualAddress = targetVerifier.nullifierRegistry();
        if (actualAddress != expected.nullifierRegistryV2) {
            revert DisputeVerifierNullifierRegistryMismatch(actualAddress);
        }
    }

    function _assertPredecessorSurface() private view {
        IActivationPolicy predecessor = IActivationPolicy(expected.predecessorPolicy);
        address actualAddress = predecessor.owner();
        if (actualAddress != expected.safe) revert PredecessorPolicyOwnerMismatch(actualAddress);
        actualAddress = predecessor.pendingOwner();
        if (actualAddress != address(0)) revert PredecessorPolicyPendingOwnerMismatch(actualAddress);
        actualAddress = predecessor.disputeVerifier();
        if (actualAddress != expected.disputeVerifier) revert PredecessorPolicyDisputeVerifierMismatch(actualAddress);
        actualAddress = predecessor.disputeNullifierRegistry();
        if (actualAddress != expected.disputeRegistry) revert PredecessorPolicyDisputeRegistryMismatch(actualAddress);
        actualAddress = predecessor.stakeVault();
        if (actualAddress != expected.predecessorVault) {
            revert PredecessorPolicyStakeVaultMismatch(actualAddress);
        }

        bool predecessorAuthorized = predecessor.isLifecycleHookAuthorized(expected.predecessorHook);
        if (!predecessorAuthorized) revert PredecessorPolicyHookAuthorizationMismatch(predecessorAuthorized);
        IBypassActivationVault predecessorVault = IBypassActivationVault(expected.predecessorVault);
        actualAddress = predecessorVault.owner();
        if (actualAddress != expected.safe) revert PredecessorVaultOwnerMismatch(actualAddress);
        actualAddress = predecessorVault.controller();
        if (actualAddress != expected.predecessorPolicy) revert PredecessorVaultControllerMismatch(actualAddress);
    }

    function _assertFreshStackSurface() private view {
        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        address actualAddress = fresh.disputeVerifier();
        if (actualAddress != expected.disputeVerifier) revert FreshPolicyDisputeVerifierMismatch(actualAddress);
        actualAddress = fresh.disputeNullifierRegistry();
        if (actualAddress != expected.disputeRegistry) revert FreshPolicyDisputeRegistryMismatch(actualAddress);
        actualAddress = fresh.stakeVault();
        if (actualAddress != expected.freshVault) revert FreshPolicyStakeVaultMismatch(actualAddress);

        IBypassActivationVault vault = IBypassActivationVault(expected.freshVault);
        actualAddress = vault.controller();
        if (actualAddress != expected.freshPolicy) revert FreshVaultControllerMismatch(actualAddress);
        actualAddress = vault.pendingController();
        if (actualAddress != address(0)) revert FreshVaultPendingControllerMismatch(actualAddress);
        uint64 actualUint64 = vault.pendingControllerValidAt();
        if (actualUint64 != 0) revert FreshVaultPendingControllerValidAtMismatch(actualUint64);
        actualUint64 = vault.controllerChangeDelay();
        if (actualUint64 != 0) {
            revert FreshVaultControllerChangeDelayMismatch(actualUint64);
        }
        actualAddress = vault.stakeToken();
        if (actualAddress != expected.stakeToken) revert FreshVaultStakeTokenMismatch(actualAddress);
    }

    function _assertFreshPolicyConfiguration() internal view {
        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        bool actualBool = fresh.admissionsPaused();
        if (actualBool) revert FreshPolicyAdmissionsPausedMismatch(actualBool);
        actualBool = fresh.isLifecycleHookAuthorized(expected.freshHook);
        if (!actualBool) revert FreshHookAuthorizationMismatch(actualBool);
        actualBool = fresh.isLifecycleHookAuthorized(expected.predecessorHook);
        if (actualBool) revert PredecessorHookAuthorizationMismatch(actualBool);
        for (uint256 methodIndex = 0; methodIndex < expected.riskWindowMethods.length; methodIndex++) {
            uint64 actualWindow = fresh.getRiskWindow(expected.riskWindowMethods[methodIndex]);
            if (actualWindow != expected.riskWindows[methodIndex]) {
                revert RiskWindowMismatch(expected.riskWindowMethods[methodIndex], actualWindow);
            }
        }
    }

    function _assertFreshSafeOwnership() internal view {
        IBypassActivationVault vault = IBypassActivationVault(expected.freshVault);
        address actual = vault.owner();
        if (actual != expected.safe) revert FreshVaultOwnerMismatch(actual);
        actual = vault.pendingOwner();
        if (actual != address(0)) revert FreshVaultPendingOwnerMismatch(actual);
        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        actual = fresh.owner();
        if (actual != expected.safe) revert FreshPolicyOwnerMismatch(actual);
        actual = fresh.pendingOwner();
        if (actual != address(0)) revert FreshPolicyPendingOwnerMismatch(actual);
    }

    function _assertDisputeWriters(address[] memory wanted) internal view {
        address[] memory actual = IActivationRegistry(expected.disputeRegistry).getWriters();
        if (actual.length != wanted.length) revert DisputeWriterCountMismatch(actual.length);
        for (uint256 writerIndex = 0; writerIndex < wanted.length; writerIndex++) {
            if (actual[writerIndex] != wanted[writerIndex]) {
                revert DisputeWriterMismatch(writerIndex, actual[writerIndex]);
            }
        }
    }

    function _assertLifecycleHook(address wanted) internal view {
        address actual = IActivationOrchestrator(expected.orchestrator).lifecycleHook();
        if (actual != wanted) revert LifecycleHookMismatch(actual);
    }

    function _assertVerifierSurface() private view {
        address actual = IActivationOwned(expected.nullifierRegistryV2).owner();
        if (actual != expected.safe) revert NullifierRegistryOwnerMismatch(actual);
        actual = IActivationOwned(expected.paymentVerifierRegistry).owner();
        if (actual != expected.safe) revert PaymentVerifierRegistryOwnerMismatch(actual);
        actual = IActivationOwned(expected.retiredVerifier).owner();
        if (actual != expected.safe) revert RetiredVerifierOwnerMismatch(actual);
        IBypassActivationVerifier targetVerifier = IBypassActivationVerifier(expected.verifier);
        actual = targetVerifier.owner();
        if (actual != expected.safe) revert VerifierOwnerMismatch(actual);
        actual = targetVerifier.orchestratorRegistry();
        if (actual != expected.orchestratorRegistry) revert VerifierOrchestratorRegistryMismatch(actual);
        actual = targetVerifier.nullifierRegistry();
        if (actual != expected.nullifierRegistryV2) revert VerifierNullifierRegistryMismatch(actual);
        actual = targetVerifier.attestationVerifier();
        if (actual != expected.attestationVerifier) revert VerifierAttestationVerifierMismatch(actual);
        bytes32[] memory methods = targetVerifier.getPaymentMethods();
        if (methods.length != expected.paymentMethods.length) revert VerifierMethodCountMismatch(methods.length);
        for (uint256 methodIndex = 0; methodIndex < methods.length; methodIndex++) {
            if (methods[methodIndex] != expected.paymentMethods[methodIndex]) {
                revert VerifierMethodMismatch(methodIndex, methods[methodIndex]);
            }
        }
    }

    function _assertNullifierWriters(address[] memory wanted) internal view {
        address[] memory actual = IActivationRegistry(expected.nullifierRegistryV2).getWriters();
        if (actual.length != wanted.length) revert NullifierWriterCountMismatch(actual.length);
        for (uint256 writerIndex = 0; writerIndex < wanted.length; writerIndex++) {
            if (actual[writerIndex] != wanted[writerIndex]) {
                revert NullifierWriterMismatch(writerIndex, actual[writerIndex]);
            }
        }
    }

    function _assertRoutes(address wantedVerifier) internal view {
        IBypassActivationPaymentVerifierRegistry registry =
            IBypassActivationPaymentVerifierRegistry(expected.paymentVerifierRegistry);
        bytes32[] memory methods = registry.getPaymentMethods();
        if (methods.length != expected.paymentMethods.length) revert RegistryMethodCountMismatch(methods.length);
        uint256 currencyOffset;
        for (uint256 methodIndex = 0; methodIndex < methods.length; methodIndex++) {
            bytes32 method = methods[methodIndex];
            if (method != expected.paymentMethods[methodIndex]) revert RegistryMethodMismatch(methodIndex, method);
            address actualVerifier = registry.getVerifier(method);
            if (actualVerifier != wantedVerifier) revert RouteVerifierMismatch(method, actualVerifier);
            bytes32[] memory actualCurrencies = registry.getCurrencies(method);
            if (actualCurrencies.length != expected.currencyCounts[methodIndex]) {
                revert RouteCurrencyCountMismatch(method, actualCurrencies.length);
            }
            for (uint256 currencyIndex = 0; currencyIndex < actualCurrencies.length; currencyIndex++) {
                if (actualCurrencies[currencyIndex] != expected.currencies[currencyOffset + currencyIndex]) {
                    revert RouteCurrencyMismatch(method, currencyIndex, actualCurrencies[currencyIndex]);
                }
            }
            currencyOffset += actualCurrencies.length;
        }
    }
}
