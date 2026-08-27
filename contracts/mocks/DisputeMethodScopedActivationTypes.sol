// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

struct TrustSurface {
    address safe;
    address disputeRegistry;
    address orchestrator;
    address orchestratorRegistry;
    address escrowRegistry;
    address paymentVerifierRegistry;
    address relayerRegistry;
    address protocolFeeRecipient;
    address freshHook;
    address whitelistPolicy;
    address groupRegistry;
    address attestationVerifier;
    address[] witnesses;
    address disputeVerifier;
    address nullifierRegistryV2;
    address predecessorPolicy;
    address freshPolicy;
    address vault;
    address predecessorHook;
    bytes32[] paymentMethods;
    uint64[] riskWindows;
}

struct InventoryTuple {
    address escrow;
    uint256 depositId;
    bytes32 paymentMethod;
}

struct ActivationDisputeProtectionIntent {
    address taker;
    address stakeOwner;
    address depositor;
    bytes32 paymentMethod;
    uint8 status;
    uint64 riskWindow;
    uint64 releaseEligibleAt;
    uint256 releaseAmount;
}

interface IActivationOwned {
    function owner() external view returns (address);
}

interface IActivationOwned2Step is IActivationOwned {
    function pendingOwner() external view returns (address);
}

interface IActivationRegistry is IActivationOwned {
    function getWriters() external view returns (address[] memory);
}

interface IActivationOrchestrator is IActivationOwned {
    function paused() external view returns (bool);
    function lifecycleHook() external view returns (address);
    function escrowRegistry() external view returns (address);
    function paymentVerifierRegistry() external view returns (address);
    function relayerRegistry() external view returns (address);
    function protocolFee() external view returns (uint256);
    function protocolFeeRecipient() external view returns (address);
    function allowMultipleIntents() external view returns (bool);
}

interface IActivationOrchestratorRegistry {
    function isOrchestrator(address orchestrator) external view returns (bool);
}

interface IActivationLifecycleHook {
    function orchestratorRegistry() external view returns (address);
    function whitelistPolicy() external view returns (address);
    function disputeProtectionPolicy() external view returns (address);
}

interface IActivationWhitelistPolicy is IActivationOwned {
    function escrowRegistry() external view returns (address);
    function groupRegistry() external view returns (address);
    function orchestratorRegistry() external view returns (address);
}

interface IActivationAttestationVerifier is IActivationOwned {
    function requiredSignatures() external view returns (uint256);
    function witnesses() external view returns (address[] memory);
}

interface IActivationDisputeVerifier is IActivationOwned2Step {
    function attestationVerifier() external view returns (address);
    function nullifierRegistry() external view returns (address);
}

interface IActivationPolicy is IActivationOwned2Step {
    function admissionsPaused() external view returns (bool);
    function disputeVerifier() external view returns (address);
    function disputeNullifierRegistry() external view returns (address);
    function stakeVault() external view returns (address);
    function isLifecycleHookAuthorized(address hook) external view returns (bool);
    function getRiskWindow(bytes32 paymentMethod) external view returns (uint64);
    function getDisputeProtectionIntent(bytes32 intentHash)
        external
        view
        returns (ActivationDisputeProtectionIntent memory);
    function isDisputeProtectionEnabled(address escrow, uint256 depositId, bytes32 paymentMethod)
        external
        view
        returns (bool);
}

interface IActivationVault is IActivationOwned2Step {
    function controller() external view returns (address);
    function pendingController() external view returns (address);
    function pendingControllerValidAt() external view returns (uint64);
    function controllerChangeDelay() external view returns (uint64);
    function locks(bytes32 intentHash) external view returns (address stakeOwner, uint256 amount, uint64 maturesAt);
}

interface IActivationEscrow {
    function depositCounter() external view returns (uint256);
    function getDepositPaymentMethods(uint256 depositId) external view returns (bytes32[] memory);
}

/**
 * @title DisputeMethodScopedTrustSurfaceChecks
 * @notice Shared, read-only execution-time assertions for method-scoped dispute activation artifacts.
 */
abstract contract DisputeMethodScopedTrustSurfaceChecks {
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
    error VaultOwnerMismatch(address actual);
    error VaultPendingOwnerMismatch(address actual);
    error FreshPolicyDisputeVerifierMismatch(address actual);
    error FreshPolicyDisputeRegistryMismatch(address actual);
    error FreshPolicyStakeVaultMismatch(address actual);
    error VaultControllerMismatch(address actual);
    error VaultPendingControllerMismatch(address actual);
    error PendingControllerValidAtMismatch(uint64 actual, uint256 minimum);
    error ControllerDelayNotElapsed(uint64 validAt, uint256 currentTimestamp);
    error PredecessorAdmissionsPausedMismatch(bool actual);
    error RegistryWriterCountMismatch(uint256 actual);
    error RegistryWriterMismatch(uint256 index, address actual);
    error LifecycleHookMismatch(address actual);
    error FreshPolicyOwnerMismatch(address actual);
    error FreshPolicyPendingOwnerMismatch(address actual);
    error FreshPolicyAdmissionsPausedMismatch(bool actual);
    error FreshHookAuthorizationMismatch(bool actual);
    error PredecessorHookAuthorizationMismatch(bool actual);
    error RiskWindowMismatch(bytes32 paymentMethod, uint64 actual);
    error PredecessorIntentStatusMismatch(bytes32 intentHash, uint8 actual);
    error PredecessorIntentLockAmountMismatch(bytes32 intentHash, uint256 actual);
    error DepositCounterMismatch(uint256 actual);
    error InventoryTupleProtectionMismatch(address escrow, uint256 depositId, bytes32 paymentMethod, bool actual);

    TrustSurface internal expected;

    constructor(TrustSurface memory _expected) {
        if (_expected.paymentMethods.length != _expected.riskWindows.length) {
            revert RiskWindowConfigurationLengthMismatch(_expected.paymentMethods.length, _expected.riskWindows.length);
        }
        expected = _expected;
    }

    function _assertTrustSurface() internal view {
        address actualAddress = IActivationOwned(expected.disputeRegistry).owner();
        if (actualAddress != expected.safe) revert RegistryOwnerMismatch(actualAddress);

        IActivationOrchestrator targetOrchestrator = IActivationOrchestrator(expected.orchestrator);
        actualAddress = targetOrchestrator.owner();
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
        if (actualBool) revert OrchestratorAllowMultipleIntentsMismatch(actualBool);
        actualBool =
            IActivationOrchestratorRegistry(expected.orchestratorRegistry).isOrchestrator(expected.orchestrator);
        if (!actualBool) revert OrchestratorRegistrationMismatch(actualBool);

        IActivationLifecycleHook targetHook = IActivationLifecycleHook(expected.freshHook);
        actualAddress = targetHook.orchestratorRegistry();
        if (actualAddress != expected.orchestratorRegistry) {
            revert FreshHookOrchestratorRegistryMismatch(actualAddress);
        }
        actualAddress = targetHook.whitelistPolicy();
        if (actualAddress != expected.whitelistPolicy) revert FreshHookWhitelistPolicyMismatch(actualAddress);
        actualAddress = targetHook.disputeProtectionPolicy();
        if (actualAddress != expected.freshPolicy) revert FreshHookDisputeProtectionPolicyMismatch(actualAddress);

        IActivationWhitelistPolicy targetWhitelist = IActivationWhitelistPolicy(expected.whitelistPolicy);
        actualAddress = targetWhitelist.owner();
        if (actualAddress != expected.safe) revert WhitelistPolicyOwnerMismatch(actualAddress);
        actualAddress = targetWhitelist.escrowRegistry();
        if (actualAddress != expected.escrowRegistry) revert WhitelistPolicyEscrowRegistryMismatch(actualAddress);
        actualAddress = targetWhitelist.groupRegistry();
        if (actualAddress != expected.groupRegistry) revert WhitelistPolicyGroupRegistryMismatch(actualAddress);
        actualAddress = targetWhitelist.orchestratorRegistry();
        if (actualAddress != expected.orchestratorRegistry) {
            revert WhitelistPolicyOrchestratorRegistryMismatch(actualAddress);
        }

        IActivationAttestationVerifier targetAttestation = IActivationAttestationVerifier(expected.attestationVerifier);
        actualAddress = targetAttestation.owner();
        if (actualAddress != expected.safe) revert AttestationVerifierOwnerMismatch(actualAddress);
        actualUint256 = targetAttestation.requiredSignatures();
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

        IActivationDisputeVerifier targetVerifier = IActivationDisputeVerifier(expected.disputeVerifier);
        actualAddress = targetVerifier.owner();
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

        IActivationPolicy predecessor = IActivationPolicy(expected.predecessorPolicy);
        actualAddress = predecessor.owner();
        if (actualAddress != expected.safe) revert PredecessorPolicyOwnerMismatch(actualAddress);
        actualAddress = predecessor.pendingOwner();
        if (actualAddress != address(0)) revert PredecessorPolicyPendingOwnerMismatch(actualAddress);
        actualAddress = predecessor.disputeVerifier();
        if (actualAddress != expected.disputeVerifier) {
            revert PredecessorPolicyDisputeVerifierMismatch(actualAddress);
        }
        actualAddress = predecessor.disputeNullifierRegistry();
        if (actualAddress != expected.disputeRegistry) {
            revert PredecessorPolicyDisputeRegistryMismatch(actualAddress);
        }

        IActivationVault targetVault = IActivationVault(expected.vault);
        actualAddress = targetVault.owner();
        if (actualAddress != expected.safe) revert VaultOwnerMismatch(actualAddress);
        actualAddress = targetVault.pendingOwner();
        if (actualAddress != address(0)) revert VaultPendingOwnerMismatch(actualAddress);

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        actualAddress = fresh.disputeVerifier();
        if (actualAddress != expected.disputeVerifier) revert FreshPolicyDisputeVerifierMismatch(actualAddress);
        actualAddress = fresh.disputeNullifierRegistry();
        if (actualAddress != expected.disputeRegistry) revert FreshPolicyDisputeRegistryMismatch(actualAddress);
        actualAddress = fresh.stakeVault();
        if (actualAddress != expected.vault) revert FreshPolicyStakeVaultMismatch(actualAddress);
    }

    function _assertSingleWriter(address expectedWriter) internal view {
        address[] memory actualWriters = IActivationRegistry(expected.disputeRegistry).getWriters();
        if (actualWriters.length != 1) revert RegistryWriterCountMismatch(actualWriters.length);
        if (actualWriters[0] != expectedWriter) revert RegistryWriterMismatch(0, actualWriters[0]);
    }

    function _assertLifecycleHook(address expectedHook) internal view {
        address actualHook = IActivationOrchestrator(expected.orchestrator).lifecycleHook();
        if (actualHook != expectedHook) revert LifecycleHookMismatch(actualHook);
    }

    function _assertFreshPolicyConfiguration() internal view {
        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        bool actualBool = fresh.admissionsPaused();
        if (actualBool) revert FreshPolicyAdmissionsPausedMismatch(actualBool);
        actualBool = fresh.isLifecycleHookAuthorized(expected.freshHook);
        if (!actualBool) revert FreshHookAuthorizationMismatch(actualBool);
        actualBool = fresh.isLifecycleHookAuthorized(expected.predecessorHook);
        if (actualBool) revert PredecessorHookAuthorizationMismatch(actualBool);
        _assertRiskWindows(fresh);
    }

    function _assertRiskWindows(IActivationPolicy fresh) internal view {
        for (uint256 methodIndex = 0; methodIndex < expected.paymentMethods.length; methodIndex++) {
            uint64 actualWindow = fresh.getRiskWindow(expected.paymentMethods[methodIndex]);
            if (actualWindow != expected.riskWindows[methodIndex]) {
                revert RiskWindowMismatch(expected.paymentMethods[methodIndex], actualWindow);
            }
        }
    }
}
