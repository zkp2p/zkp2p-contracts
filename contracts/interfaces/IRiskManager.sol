// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAttestationVerifier} from "./IAttestationVerifier.sol";
import {IIntentRiskHook} from "./IIntentRiskHook.sol";
import {INullifierRegistryV2} from "./INullifierRegistryV2.sol";
import {IOrchestratorV3} from "./IOrchestratorV3.sol";
import {IStakeVault} from "./IStakeVault.sol";

/**
 * @title IRiskManager
 * @notice Intent-extension and chargeback policy for the generic StakeVault ledger.
 */
interface IRiskManager is IIntentRiskHook {
    enum RiskMode {
        NONE,
        UNBONDED,
        STAKE_BACKED,
        DEFERRED_PAYOUT
    }

    enum PositionStatus {
        NONE,
        PENDING,
        CANCELLED,
        SETTLED,
        RELEASED,
        SLASHED
    }

    struct ChargebackConfig {
        bool chargebackable;
        bool deferredPayoutEnabled;
        uint64 riskWindow;
    }

    struct PlatformRiskConfig {
        bool enabled;
        ChargebackConfig chargeback;
        uint32 extensionPenaltyBpsPerHour;
    }

    /**
     * @dev Mutable platform policy and Escrow timing are snapshotted when the intent is admitted.
     *      Vault lock state is deliberately not duplicated beyond the amounts needed to validate transitions.
     */
    struct RiskPosition {
        address taker;
        address stakeOwner;
        address extensionStakeOwner;
        address lp;
        address payoutRecipient;
        bytes32 paymentMethod;
        RiskMode mode;
        PositionStatus status;
        bool isManualRelease;
        uint32 extensionPenaltyBpsPerHour;
        uint64 riskWindow;
        uint64 createdAt;
        uint64 baseIntentExpiry;
        uint64 totalExtensionTime;
        uint64 coverageDeadline;
        uint256 intentAmount;
        uint256 extensionAmount;
        uint256 coverageAmount;
        uint256 grossReleasedAmount;
        uint256 executableAmount;
    }

    struct ChargebackAttestation {
        bytes32 intentHash;
        bytes32 dataHash;
        bytes[] signatures;
        bytes data;
    }

    struct ChargebackDetails {
        bytes32 paymentMethod;
        bytes32 originalPaymentId;
        bytes32 disputeId;
        uint256 paymentAmount;
        bytes32 paymentCurrency;
    }

    event PlatformRiskConfigUpdated(
        bytes32 indexed paymentMethod,
        bool enabled,
        bool chargebackable,
        bool deferredPayoutEnabled,
        uint64 riskWindow,
        uint32 extensionPenaltyBpsPerHour
    );
    event RiskPositionCreated(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        address taker,
        bytes32 paymentMethod,
        RiskMode mode,
        uint256 intentAmount,
        uint256 coverageAmount,
        uint64 baseIntentExpiry,
        uint64 riskWindow,
        uint32 extensionPenaltyBpsPerHour
    );
    event IntentExtended(
        bytes32 indexed intentHash,
        address indexed taker,
        address indexed extensionStakeOwner,
        address caller,
        uint64 additionalTime,
        uint64 newExpiry,
        uint256 additionalAmount,
        uint256 totalAmount
    );
    event IntentExtensionResolved(
        bytes32 indexed intentHash,
        address indexed extensionStakeOwner,
        address indexed lp,
        uint64 terminalAt,
        uint64 chargeableTime,
        uint256 penalty,
        uint256 releasedAmount
    );
    event RiskPositionCancelled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        uint64 cancelledAt,
        uint256 extensionPenalty,
        uint256 releasedCoverage
    );
    event RiskPositionSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        RiskMode mode,
        uint256 grossAmount,
        uint256 executableAmount,
        uint256 coverageAmount,
        uint64 coverageDeadline,
        bool isManualRelease
    );
    event DeferredSettlementFunded(
        bytes32 indexed intentHash,
        address indexed payoutRecipient,
        uint256 grossAmount,
        uint256 executableAmount,
        uint256 deferredFees,
        uint64 coverageDeadline
    );
    event RiskPositionReleased(
        bytes32 indexed intentHash, address indexed stakeOwner, RiskMode mode, uint256 releasedCoverage
    );
    event ChargebackSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        RiskMode mode,
        uint256 compensatedAmount,
        bytes32 disputeId
    );
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event RiskTakingPausedUpdated(bool paused);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error ZeroAmount();
    error UnauthorizedOrchestrator(address caller);
    error RiskTakingPaused();
    error InvalidPlatformConfig(bytes32 paymentMethod);
    error PlatformDisabled(bytes32 paymentMethod);
    error InvalidIntentGuardian(address expected, address actual);
    error ExtensionPenaltyExceedsIntentAmount(bytes32 paymentMethod);
    error InsufficientCollateral(address stakeOwner, uint256 available, uint256 required);
    error PositionAlreadyExists(bytes32 intentHash);
    error PositionNotPending(bytes32 intentHash, PositionStatus status);
    error PositionNotSettled(bytes32 intentHash, PositionStatus status);
    error PositionModeMismatch(bytes32 intentHash, RiskMode mode);
    error IntentStateMismatch(bytes32 intentHash);
    error ExtensionsDisabled(bytes32 paymentMethod);
    error UnauthorizedStakeExtension(address caller, address taker, address extensionStakeOwner);
    error IntentAlreadyExpired(bytes32 intentHash, uint64 expiry, uint64 currentTime);
    error ExtensionTimeOverflow(uint256 extensionTime);
    error ExtensionExceedsIntentLifetime(uint64 newExpiry, uint64 maximumExpiry);
    error CancellationNotRecorded(bytes32 intentHash);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error DeferredStakeTransferMismatch(uint256 expectedAmount, uint256 actualAmount);
    error DeferredPostIntentHookUnsupported(bytes32 intentHash, address postIntentHook);
    error PositionNotMature(uint64 coverageDeadline, uint64 currentTime);
    error InvalidAttestation();
    error InvalidPaymentBinding(bytes32 intentHash, bytes32 nullifier);
    error ChargebackWindowClosed(uint64 coverageDeadline, uint64 currentTime);
    error ChargebackEvidenceUsed(bytes32 nullifier);
    error IncompleteChargebackCoverage(uint256 available, uint256 required);
    error AttestationVerificationFailed();
    error TimestampOverflow(uint256 timestamp);
    error OwnershipRenunciationDisabled();

    function setPlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) external;
    function setAttestationVerifier(address _verifier) external;
    function setRiskTakingPaused(bool _paused) external;
    function acceptVaultController() external;

    function extendIntent(bytes32 _intentHash, uint64 _additionalTime) external;
    function reconcileCancellation(bytes32 _intentHash) external;
    function reconcileCancellations(bytes32[] calldata _intentHashes) external;
    function releaseMaturedPosition(bytes32 _intentHash) external;
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external;
    function submitChargeback(ChargebackAttestation calldata _attestation) external;

    function getPlatformRiskConfig(bytes32 _paymentMethod) external view returns (PlatformRiskConfig memory);
    function getRiskPosition(bytes32 _intentHash) external view returns (RiskPosition memory);
    function getDeferredFeeAllocations(bytes32 _intentHash) external view returns (FeeAllocation[] memory);
    function getTakerState(address _taker)
        external
        view
        returns (address stakeOwner, uint256 totalStake, uint256 lockedStake, uint256 freeStake);
    function calculateIntentExtensionCost(
        uint256 _intentAmount,
        uint64 _extensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) external pure returns (uint256);
    function calculateIntentExtensionPenalty(
        uint256 _intentAmount,
        uint64 _baseIntentExpiry,
        uint64 _terminalAt,
        uint64 _totalExtensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) external pure returns (uint256 penalty, uint64 chargeableTime);
    function extensionLockId(bytes32 _intentHash) external pure returns (bytes32);
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation) external view returns (bytes32);

    function orchestrator() external view returns (IOrchestratorV3);
    function stakeVault() external view returns (IStakeVault);
    function nullifierRegistry() external view returns (INullifierRegistryV2);
    function attestationVerifier() external view returns (IAttestationVerifier);
    function riskTakingPaused() external view returns (bool);
    function usedChargebackNullifiers(bytes32 _nullifier) external view returns (bool);
}
