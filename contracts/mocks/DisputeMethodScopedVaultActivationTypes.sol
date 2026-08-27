// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {
    ActivationDisputeProtectionIntent,
    IActivationAttestationVerifier,
    IActivationEscrow,
    IActivationLifecycleHook,
    IActivationOrchestrator,
    IActivationOrchestratorRegistry,
    IActivationOwned2Step,
    IActivationPolicy,
    IActivationRegistry,
    IActivationWhitelistPolicy,
    InventoryTuple
} from "./DisputeMethodScopedActivationTypes.sol";

struct VaultIdentities {
    address freshVault;
    address predecessorVault;
}

struct VaultTrustSurface {
    address safe;
    address disputeRegistry;
    address orchestrator;
    address orchestratorRegistry;
    address escrowRegistry;
    address paymentVerifierRegistry;
    address relayerRegistry;
    address protocolFeeRecipient;
    bool allowMultipleIntents;
    address freshHook;
    address whitelistPolicy;
    address groupRegistry;
    address attestationVerifier;
    address[] witnesses;
    address disputeVerifier;
    address nullifierRegistryV2;
    address predecessorPolicy;
    address freshPolicy;
    VaultIdentities vaults;
    address predecessorHook;
    bytes32[] paymentMethods;
    uint64[] riskWindows;
}

interface IActivationVaultWithToken is IActivationOwned2Step {
    function controller() external view returns (address);
    function pendingController() external view returns (address);
    function pendingControllerValidAt() external view returns (uint64);
    function controllerChangeDelay() external view returns (uint64);
    function stakeToken() external view returns (address);
    function locks(bytes32 intentHash) external view returns (address stakeOwner, uint256 amount, uint64 maturesAt);
}

interface IActivationDisputeVerifierWithSurface is IActivationOwned2Step {
    function attestationVerifier() external view returns (address);
    function nullifierRegistry() external view returns (address);
}

/**
 * @title DisputeMethodScopedVaultTrustSurfaceChecks
 * @notice Shared execution-time assertions for the dedicated-vault activation artifacts.
 */
abstract contract DisputeMethodScopedVaultTrustSurfaceChecks {
    uint64 private constant PINNED_CONTROLLER_CHANGE_DELAY = 2 days;
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
    error RegistryWriterCountMismatch(uint256 actual);
    error RegistryWriterMismatch(uint256 index, address actual);
    error LifecycleHookMismatch(address actual);
    error PredecessorIntentStatusMismatch(bytes32 intentHash, uint8 actual);
    error PredecessorIntentLockAmountMismatch(bytes32 intentHash, uint256 actual);
    error DepositCounterBelowProof(uint256 actual, uint256 pinned);
    error InventoryTupleProtectionMismatch(address escrow, uint256 depositId, bytes32 paymentMethod, bool actual);

    VaultTrustSurface internal expected;

    constructor(VaultTrustSurface memory _expected) {
        if (_expected.paymentMethods.length != _expected.riskWindows.length) {
            revert RiskWindowConfigurationLengthMismatch(_expected.paymentMethods.length, _expected.riskWindows.length);
        }
        expected = _expected;
    }

    function _assertTrustSurface() internal view {
        address actualAddress = IActivationRegistry(expected.disputeRegistry).owner();
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
        if (actualBool != expected.allowMultipleIntents) {
            revert OrchestratorAllowMultipleIntentsMismatch(actualBool);
        }
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

        IActivationDisputeVerifierWithSurface targetVerifier =
            IActivationDisputeVerifierWithSurface(expected.disputeVerifier);
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
        if (actualAddress != expected.disputeVerifier) revert PredecessorPolicyDisputeVerifierMismatch(actualAddress);
        actualAddress = predecessor.disputeNullifierRegistry();
        if (actualAddress != expected.disputeRegistry) revert PredecessorPolicyDisputeRegistryMismatch(actualAddress);
        actualAddress = predecessor.stakeVault();
        if (actualAddress != expected.vaults.predecessorVault) {
            revert PredecessorPolicyStakeVaultMismatch(actualAddress);
        }

        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        actualAddress = fresh.disputeVerifier();
        if (actualAddress != expected.disputeVerifier) revert FreshPolicyDisputeVerifierMismatch(actualAddress);
        actualAddress = fresh.disputeNullifierRegistry();
        if (actualAddress != expected.disputeRegistry) revert FreshPolicyDisputeRegistryMismatch(actualAddress);
        actualAddress = fresh.stakeVault();
        if (actualAddress != expected.vaults.freshVault) revert FreshPolicyStakeVaultMismatch(actualAddress);

        IActivationVaultWithToken vault = IActivationVaultWithToken(expected.vaults.freshVault);
        actualAddress = vault.controller();
        if (actualAddress != expected.freshPolicy) revert FreshVaultControllerMismatch(actualAddress);
        actualAddress = vault.pendingController();
        if (actualAddress != address(0)) revert FreshVaultPendingControllerMismatch(actualAddress);
        uint64 actualUint64 = vault.pendingControllerValidAt();
        if (actualUint64 != 0) revert FreshVaultPendingControllerValidAtMismatch(actualUint64);
        actualUint64 = vault.controllerChangeDelay();
        if (actualUint64 != PINNED_CONTROLLER_CHANGE_DELAY) {
            revert FreshVaultControllerChangeDelayMismatch(actualUint64);
        }
        actualAddress = vault.stakeToken();
        address predecessorStakeToken = IActivationVaultWithToken(expected.vaults.predecessorVault).stakeToken();
        if (actualAddress != predecessorStakeToken) revert FreshVaultStakeTokenMismatch(actualAddress);
    }

    function _assertFreshPolicyConfiguration() internal view {
        IActivationPolicy fresh = IActivationPolicy(expected.freshPolicy);
        bool actualBool = fresh.admissionsPaused();
        if (actualBool) revert FreshPolicyAdmissionsPausedMismatch(actualBool);
        actualBool = fresh.isLifecycleHookAuthorized(expected.freshHook);
        if (!actualBool) revert FreshHookAuthorizationMismatch(actualBool);
        actualBool = fresh.isLifecycleHookAuthorized(expected.predecessorHook);
        if (actualBool) revert PredecessorHookAuthorizationMismatch(actualBool);
        for (uint256 methodIndex = 0; methodIndex < expected.paymentMethods.length; methodIndex++) {
            uint64 actualWindow = fresh.getRiskWindow(expected.paymentMethods[methodIndex]);
            if (actualWindow != expected.riskWindows[methodIndex]) {
                revert RiskWindowMismatch(expected.paymentMethods[methodIndex], actualWindow);
            }
        }
    }

    function _assertFreshSafeOwnership() internal view {
        IActivationVaultWithToken vault = IActivationVaultWithToken(expected.vaults.freshVault);
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

    function _assertWriters(address[] memory wanted) internal view {
        address[] memory actual = IActivationRegistry(expected.disputeRegistry).getWriters();
        if (actual.length != wanted.length) revert RegistryWriterCountMismatch(actual.length);
        for (uint256 writerIndex = 0; writerIndex < wanted.length; writerIndex++) {
            if (actual[writerIndex] != wanted[writerIndex]) {
                revert RegistryWriterMismatch(writerIndex, actual[writerIndex]);
            }
        }
    }

    function _assertLifecycleHook(address wanted) internal view {
        address actual = IActivationOrchestrator(expected.orchestrator).lifecycleHook();
        if (actual != wanted) revert LifecycleHookMismatch(actual);
    }
}
