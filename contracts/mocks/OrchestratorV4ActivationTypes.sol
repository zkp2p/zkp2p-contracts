// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {
    IActivationAttestationVerifier,
    IActivationDisputeVerifier,
    IActivationOrchestrator,
    IActivationOrchestratorRegistry,
    IActivationOwned,
    IActivationPolicy,
    IActivationRegistry,
    IActivationVault,
    IActivationWhitelistPolicy
} from "./DisputeMethodScopedActivationTypes.sol";

struct OrchestratorV4TrustSurface {
    address safe;
    address deployer;
    address orchestrator;
    address orchestratorV4;
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
    address freshWhitelistPolicy;
    address groupRegistry;
    address stakeToken;
    address predecessorVault;
    address predecessorPolicy;
    address predecessorHook;
    address freshVault;
    address freshPolicy;
    bytes32[] paymentMethods;
    bytes32[] currencies;
    uint256[] currencyCounts;
}

interface IActivationOrchestratorV4 is IActivationOrchestrator {
    /// @notice Returns the configured settlement policy.
    function settlementPolicy() external view returns (address);
    /// @notice Returns the immutable whitelist policy.
    function whitelistPolicy() external view returns (address);
    /// @notice Returns the orchestrator signing chain ID.
    function chainId() external view returns (uint256);
}

interface IActivationOwnedOrchestratorRegistry is IActivationOwned, IActivationOrchestratorRegistry {}

interface IActivationPolicyV2 is IActivationOwned {
    /// @notice Returns the pending governance owner.
    function pendingOwner() external view returns (address);
    /// @notice Returns the dispute verifier.
    function disputeVerifier() external view returns (address);
    /// @notice Returns the dispute nullifier registry.
    function disputeNullifierRegistry() external view returns (address);
    /// @notice Returns the stake vault.
    function stakeVault() external view returns (address);
    /// @notice Returns the registry that authorizes calling orchestrators.
    function orchestratorRegistry() external view returns (address);
}

interface IActivationPaymentVerifierRegistry is IActivationOwned {
    /// @notice Returns payment methods in their stored order.
    function getPaymentMethods() external view returns (bytes32[] memory);
    /// @notice Returns the verifier routing for a payment method.
    function getVerifier(bytes32 paymentMethod) external view returns (address);
    /// @notice Returns the ordered currency list for a payment method.
    function getCurrencies(bytes32 paymentMethod) external view returns (bytes32[] memory);
}

interface IActivationVerifierV4 is IActivationOwned {
    /// @notice Returns payment methods in their stored order.
    function getPaymentMethods() external view returns (bytes32[] memory);
    /// @notice Returns the verifier orchestrator registry.
    function orchestratorRegistry() external view returns (address);
    /// @notice Returns the verifier payment nullifier registry.
    function nullifierRegistry() external view returns (address);
    /// @notice Returns the verifier attestation verifier.
    function attestationVerifier() external view returns (address);
}

interface IActivationVaultV2 is IActivationOwned {
    /// @notice Returns the pending governance owner.
    function pendingOwner() external view returns (address);
    /// @notice Returns whether the policy may create and service its own locks.
    function isController(address controller) external view returns (bool);
    /// @notice Returns the vault stake token.
    function stakeToken() external view returns (address);
}

/**
 * @title OrchestratorV4TrustSurfaceChecks
 * @notice Shared execution-time assertions for the OrchestratorV4 activation artifacts.
 */
abstract contract OrchestratorV4TrustSurfaceChecks {
    error RegistryOwnerMismatch(address actual);
    error OrchestratorRegistryOwnerMismatch(address actual);
    error OrchestratorV4OwnerMismatch(address actual);
    error OrchestratorV4PausedMismatch(bool actual);
    error OrchestratorV4ChainIdMismatch(uint256 actual);
    error OrchestratorV4EscrowRegistryMismatch(address actual);
    error OrchestratorV4PaymentVerifierRegistryMismatch(address actual);
    error OrchestratorV4RelayerRegistryMismatch(address actual);
    error OrchestratorV4ProtocolFeeMismatch(uint256 actual);
    error OrchestratorV4ProtocolFeeRecipientMismatch(address actual);
    error OrchestratorV4AllowMultipleIntentsMismatch(bool actual);
    error OrchestratorV4SettlementPolicyMismatch(address actual);
    error OrchestratorV4RegistrationMismatch(bool actual);

    error OrchestratorOwnerMismatch(address actual);
    error OrchestratorPausedMismatch(bool actual);
    error OrchestratorEscrowRegistryMismatch(address actual);
    error OrchestratorPaymentVerifierRegistryMismatch(address actual);
    error OrchestratorRelayerRegistryMismatch(address actual);
    error OrchestratorProtocolFeeMismatch(uint256 actual);
    error OrchestratorProtocolFeeRecipientMismatch(address actual);
    error OrchestratorAllowMultipleIntentsMismatch(bool actual);
    error OrchestratorRegistrationMismatch(bool actual);
    error OrchestratorV4WhitelistPolicyMismatch(address actual);
    error FreshPolicyOrchestratorRegistryMismatch(address actual);
    error WhitelistPolicyOwnerMismatch(address actual);
    error FreshWhitelistPolicyNotDistinct();
    error FreshWhitelistPolicyOwnerMismatch(address actual);
    error FreshWhitelistPolicyEscrowRegistryMismatch(address actual);
    error FreshWhitelistPolicyGroupRegistryMismatch(address actual);
    error FreshWhitelistPolicyOrchestratorRegistryMismatch(address actual);
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
    error FreshVaultControllerAuthorizationMismatch(bool actual);
    error FreshVaultStakeTokenMismatch(address actual);
    error FreshVaultOwnerMismatch(address actual);
    error FreshVaultPendingOwnerMismatch(address actual);
    error FreshPolicyOwnerMismatch(address actual);
    error FreshPolicyPendingOwnerMismatch(address actual);
    error DisputeWriterCountMismatch(uint256 actual);
    error DisputeWriterMismatch(uint256 index, address actual);
    error LifecycleHookMismatch(address actual);

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

    OrchestratorV4TrustSurface internal expected;

    constructor(OrchestratorV4TrustSurface memory _expected) {
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
        if (_expected.freshWhitelistPolicy == _expected.whitelistPolicy) revert FreshWhitelistPolicyNotDistinct();
        expected = _expected;
    }

    function _assertTrustSurface() internal view {
        _assertVerifierSurface();
        address actual = IActivationRegistry(expected.disputeRegistry).owner();
        if (actual != expected.safe) revert RegistryOwnerMismatch(actual);
        actual = IActivationOwnedOrchestratorRegistry(expected.orchestratorRegistry).owner();
        if (actual != expected.safe) revert OrchestratorRegistryOwnerMismatch(actual);
        _assertOrchestratorSurface();
        _assertOrchestratorV4Surface();
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

    function _assertOrchestratorV4Surface() private view {
        IActivationOrchestratorV4 targetOrchestrator = IActivationOrchestratorV4(expected.orchestratorV4);
        address actualAddress = targetOrchestrator.owner();
        if (actualAddress != expected.safe) revert OrchestratorV4OwnerMismatch(actualAddress);
        bool actualBool = targetOrchestrator.paused();
        if (actualBool) revert OrchestratorV4PausedMismatch(actualBool);
        actualAddress = targetOrchestrator.escrowRegistry();
        if (actualAddress != expected.escrowRegistry) revert OrchestratorV4EscrowRegistryMismatch(actualAddress);
        actualAddress = targetOrchestrator.paymentVerifierRegistry();
        if (actualAddress != expected.paymentVerifierRegistry) {
            revert OrchestratorV4PaymentVerifierRegistryMismatch(actualAddress);
        }
        actualAddress = targetOrchestrator.relayerRegistry();
        if (actualAddress != expected.relayerRegistry) revert OrchestratorV4RelayerRegistryMismatch(actualAddress);
        uint256 actualUint256 = targetOrchestrator.protocolFee();
        if (actualUint256 != 0) revert OrchestratorV4ProtocolFeeMismatch(actualUint256);
        actualAddress = targetOrchestrator.protocolFeeRecipient();
        if (actualAddress != expected.protocolFeeRecipient) {
            revert OrchestratorV4ProtocolFeeRecipientMismatch(actualAddress);
        }
        actualBool = targetOrchestrator.allowMultipleIntents();
        if (actualBool != expected.allowMultipleIntents) {
            revert OrchestratorV4AllowMultipleIntentsMismatch(actualBool);
        }
        actualUint256 = targetOrchestrator.chainId();
        if (actualUint256 != IActivationOrchestratorV4(expected.orchestrator).chainId()) {
            revert OrchestratorV4ChainIdMismatch(actualUint256);
        }
        actualAddress = targetOrchestrator.settlementPolicy();
        if (actualAddress != expected.freshPolicy) revert OrchestratorV4SettlementPolicyMismatch(actualAddress);
        actualAddress = targetOrchestrator.whitelistPolicy();
        if (actualAddress != expected.freshWhitelistPolicy) {
            revert OrchestratorV4WhitelistPolicyMismatch(actualAddress);
        }
    }

    function _assertOrchestratorV4Registration(bool wanted) internal view {
        bool actual =
            IActivationOwnedOrchestratorRegistry(expected.orchestratorRegistry).isOrchestrator(expected.orchestratorV4);
        if (actual != wanted) revert OrchestratorV4RegistrationMismatch(actual);
    }

    function _assertWhitelistSurface() private view {
        IActivationWhitelistPolicy freshWhitelist = IActivationWhitelistPolicy(expected.freshWhitelistPolicy);
        address freshAddress = freshWhitelist.owner();
        if (freshAddress != expected.safe) revert FreshWhitelistPolicyOwnerMismatch(freshAddress);
        freshAddress = freshWhitelist.escrowRegistry();
        if (freshAddress != expected.escrowRegistry) revert FreshWhitelistPolicyEscrowRegistryMismatch(freshAddress);
        freshAddress = freshWhitelist.groupRegistry();
        if (freshAddress != expected.groupRegistry) revert FreshWhitelistPolicyGroupRegistryMismatch(freshAddress);
        freshAddress = freshWhitelist.orchestratorRegistry();
        if (freshAddress != expected.orchestratorRegistry) {
            revert FreshWhitelistPolicyOrchestratorRegistryMismatch(freshAddress);
        }
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
        IActivationVault predecessorVault = IActivationVault(expected.predecessorVault);
        actualAddress = predecessorVault.owner();
        if (actualAddress != expected.safe) revert PredecessorVaultOwnerMismatch(actualAddress);
        actualAddress = predecessorVault.controller();
        if (actualAddress != expected.predecessorPolicy) revert PredecessorVaultControllerMismatch(actualAddress);
    }

    function _assertFreshStackSurface() private view {
        IActivationPolicyV2 fresh = IActivationPolicyV2(expected.freshPolicy);
        address actualAddress = fresh.disputeVerifier();
        if (actualAddress != expected.disputeVerifier) revert FreshPolicyDisputeVerifierMismatch(actualAddress);
        actualAddress = fresh.disputeNullifierRegistry();
        if (actualAddress != expected.disputeRegistry) revert FreshPolicyDisputeRegistryMismatch(actualAddress);
        actualAddress = fresh.orchestratorRegistry();
        if (actualAddress != expected.orchestratorRegistry) {
            revert FreshPolicyOrchestratorRegistryMismatch(actualAddress);
        }
        actualAddress = fresh.stakeVault();
        if (actualAddress != expected.freshVault) revert FreshPolicyStakeVaultMismatch(actualAddress);

        IActivationVaultV2 vault = IActivationVaultV2(expected.freshVault);
        bool policyAuthorized = vault.isController(expected.freshPolicy);
        if (!policyAuthorized) revert FreshVaultControllerAuthorizationMismatch(policyAuthorized);
        actualAddress = vault.stakeToken();
        if (actualAddress != expected.stakeToken) revert FreshVaultStakeTokenMismatch(actualAddress);
    }

    function _assertFreshSafeOwnership() internal view {
        IActivationVaultV2 vault = IActivationVaultV2(expected.freshVault);
        address actual = vault.owner();
        if (actual != expected.safe) revert FreshVaultOwnerMismatch(actual);
        actual = vault.pendingOwner();
        if (actual != address(0)) revert FreshVaultPendingOwnerMismatch(actual);
        IActivationPolicyV2 fresh = IActivationPolicyV2(expected.freshPolicy);
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
        IActivationVerifierV4 targetVerifier = IActivationVerifierV4(expected.verifier);
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
        IActivationPaymentVerifierRegistry registry =
            IActivationPaymentVerifierRegistry(expected.paymentVerifierRegistry);
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
