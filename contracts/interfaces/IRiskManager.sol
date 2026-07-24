// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAttestationVerifier} from "./IAttestationVerifier.sol";
import {IAddressGroupRegistry} from "./IAddressGroupRegistry.sol";
import {IIntentRiskHook} from "./IIntentRiskHook.sol";
import {INullifierRegistryV2} from "./INullifierRegistryV2.sol";
import {IOrchestratorV3} from "./IOrchestratorV3.sol";
import {IStakeVault} from "./IStakeVault.sol";

/**
 * @title IRiskManager
 * @notice Chargeback policy for the generic StakeVault ledger.
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

    enum AdmissionOutcome {
        ADMIT_UNBONDED,
        REJECT_NOT_WHITELISTED,
        STAKING_PATH
    }

    struct MakerProtectionConfig {
        bool whitelistEnabled;
        bool requireBothProtections;
    }

    struct MakerInit {
        address maker;
        bool whitelistEnabled;
        bool requireBothProtections;
        bytes32[] chargebackPlatforms;
    }

    struct ChargebackConfig {
        bool chargebackable;
        bool deferredPayoutEnabled;
        uint64 riskWindow;
    }

    struct PlatformRiskConfig {
        bool enabled;
        ChargebackConfig chargeback;
    }

    /**
     * @dev Mutable platform policy and Escrow timing are snapshotted when the intent is admitted.
     *      Vault lock state is deliberately not duplicated beyond the amounts needed to validate transitions.
     */
    struct RiskPosition {
        address taker;
        address stakeOwner;
        address lp;
        address payoutRecipient;
        bytes32 paymentMethod;
        RiskMode mode;
        PositionStatus status;
        bool isManualRelease;
        uint64 riskWindow;
        uint64 createdAt;
        uint64 coverageDeadline;
        uint256 intentAmount;
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
        bytes32 indexed paymentMethod, bool enabled, bool chargebackable, bool deferredPayoutEnabled, uint64 riskWindow
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
        uint64 riskWindow
    );
    event RiskPositionCancelled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        uint64 cancelledAt,
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
    event MakerWhitelistProtectionUpdated(address indexed maker, bool enabled);
    event MakerChargebackProtectionUpdated(address indexed maker, bytes32 indexed paymentMethod, bool enabled);
    event MakerProtectionModeUpdated(address indexed maker, bool requireBothProtections);
    event TakerWhitelisted(address indexed maker, address indexed taker);
    event TakerRemovedFromWhitelist(address indexed maker, address indexed taker);
    event GroupAttached(address indexed maker, uint256 indexed groupId);
    event GroupDetached(address indexed maker, uint256 indexed groupId);
    event MakerConfigsInitialized(uint256 makerCount);

    error ZeroAddress();
    error EmptyArray();
    error InvalidContract(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error RiskTakingPaused();
    error InvalidPlatformConfig(bytes32 paymentMethod);
    error PlatformDisabled(bytes32 paymentMethod);
    error InsufficientCollateral(address stakeOwner, uint256 available, uint256 required);
    error PositionAlreadyExists(bytes32 intentHash);
    error PositionNotPending(bytes32 intentHash, PositionStatus status);
    error PositionNotSettled(bytes32 intentHash, PositionStatus status);
    error PositionModeMismatch(bytes32 intentHash, RiskMode mode);
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
    error TakerNotWhitelisted(address taker, address maker);
    error GroupDoesNotExist(uint256 groupId);
    error MaxGroupsExceeded(uint256 attempted, uint256 max);
    error MakerConfigsAlreadyInitialized();

    function setPlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) external;
    function setAttestationVerifier(address _verifier) external;
    function setRiskTakingPaused(bool _paused) external;
    function acceptVaultController() external;
    function setWhitelistProtection(bool _enabled) external;
    function setChargebackProtection(bytes32 _paymentMethod, bool _enabled) external;
    function setProtectionMode(bool _requireBothProtections) external;
    function addToWhitelist(address[] calldata _takers) external;
    function removeFromWhitelist(address[] calldata _takers) external;
    function attachGroups(uint256[] calldata _groupIds) external;
    function detachGroups(uint256[] calldata _groupIds) external;
    function initializeMakerConfigs(MakerInit[] calldata _makers) external;

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
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation) external view returns (bytes32);
    function getMakerProtectionConfig(address _maker) external view returns (MakerProtectionConfig memory);
    function getAttachedGroups(address _maker) external view returns (uint256[] memory);
    function getEffectiveAdmission(address _maker, bytes32 _paymentMethod, address _taker)
        external
        view
        returns (AdmissionOutcome);

    function orchestrator() external view returns (IOrchestratorV3);
    function stakeVault() external view returns (IStakeVault);
    function nullifierRegistry() external view returns (INullifierRegistryV2);
    function attestationVerifier() external view returns (IAttestationVerifier);
    function riskTakingPaused() external view returns (bool);
    function usedChargebackNullifiers(bytes32 _nullifier) external view returns (bool);
    function chargebackProtectionEnabled(address _maker, bytes32 _paymentMethod) external view returns (bool);
    function whitelist(address _maker, address _taker) external view returns (bool);
    function makerConfigsInitialized() external view returns (bool);
    function groupRegistry() external view returns (IAddressGroupRegistry);
}
