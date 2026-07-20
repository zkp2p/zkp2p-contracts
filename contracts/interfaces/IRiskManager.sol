// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentExtensionHook } from "./IIntentExtensionHook.sol";
import { IIntentRiskHook } from "./IIntentRiskHook.sol";
import { IOrchestratorV3 } from "./IOrchestratorV3.sol";
import { IStakeVault } from "./IStakeVault.sol";

/**
 * @title IRiskManager
 * @notice Stake policy for paid intent extensions and post-settlement chargebacks.
 * @dev Implementations snapshot mutable platform terms when an intent is admitted.
 */
interface IRiskManager is IIntentRiskHook, IIntentExtensionHook {
    /* ============ Enums ============ */

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

    /* ============ Structs ============ */

    struct ChargebackConfig {
        bool chargebackable;
        bool deferredPayoutEnabled;
        uint16 reserveBps;
        uint64 riskWindow;
    }

    struct IntentExtensionConfig {
        /// @notice Annualized extension price in basis points. Zero disables extensions.
        uint16 feeBps;
        /// @notice Maximum total lifetime from creation. Zero disables extensions.
        uint64 maxIntentLifetime;
    }

    struct PlatformRiskConfig {
        bool enabled;
        ChargebackConfig chargeback;
        IntentExtensionConfig extension;
    }

    struct RiskPosition {
        address taker;
        address stakeOwner;
        address lp;
        bytes32 paymentMethod;
        RiskMode mode;
        PositionStatus status;
        address deferredPayoutHook;
        address payoutRecipient;
        uint16 chargebackReserveBps;
        uint16 extensionFeeBps;
        uint64 riskWindow;
        uint64 createdAt;
        uint64 maxIntentLifetime;
        uint64 purchasedExtensionSeconds;
        uint64 cancelledAt;
        uint64 settledAt;
        uint64 coverageDeadline;
        uint256 intentAmount;
        uint256 initialReservation;
        uint256 reservedAmount;
        uint256 releasedAmount;
        uint256 deferredPayoutAmount;
        uint256 slashedAmount;
        uint256 extensionFeesPaid;
    }

    struct ChargebackAttestation {
        uint256 chainId;
        address riskManager;
        address orchestrator;
        bytes32 intentHash;
        bytes32 paymentMethod;
        uint256 chargebackAmount;
        bytes32 evidenceId;
        uint256 nonce;
        uint64 validAfter;
        uint64 validUntil;
    }

    /* ============ Events ============ */

    event PlatformRiskConfigUpdated(
        bytes32 indexed paymentMethod,
        bool enabled,
        bool chargebackable,
        bool deferredPayoutEnabled,
        uint16 reserveBps,
        uint64 riskWindow,
        uint16 extensionFeeBps,
        uint64 maxIntentLifetime
    );
    event RiskPositionCreated(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        address taker,
        bytes32 paymentMethod,
        RiskMode mode,
        uint256 intentAmount,
        uint64 createdAt,
        uint16 chargebackReserveBps,
        uint64 riskWindow,
        uint16 extensionFeeBps,
        uint64 maxIntentLifetime,
        uint256 chargebackReserve,
        uint256 initialReservation
    );
    event IntentExtensionFeeCharged(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        uint256 extensionSeconds,
        uint256 fee,
        uint256 newExpiry,
        uint256 cumulativeFees
    );
    event RiskPositionCancelled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        uint64 cancelledAt,
        uint256 releasedReservation
    );
    event RiskPositionSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        RiskMode mode,
        uint256 releasedAmount,
        uint256 chargebackCoverage,
        uint256 releasedReservation,
        uint64 settledAt,
        uint64 coverageDeadline
    );
    event DeferredPayoutRegistered(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        uint256 deferredAmount,
        uint256 chargebackCoverage,
        uint64 coverageDeadline
    );
    event RiskPositionReleased(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        RiskMode mode,
        uint256 releasedCoverage
    );
    event ChargebackSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        RiskMode mode,
        uint256 requestedAmount,
        uint256 compensatedAmount,
        uint256 totalCompensated,
        uint256 remainingCoverage,
        bytes32 evidenceId
    );
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event DeferredPayoutHookUpdated(address indexed previousHook, address indexed newHook);
    event AdmissionPausedUpdated(bool paused);

    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroAmount();
    error EmptyBatch();
    error UnauthorizedOrchestrator(address caller);
    error UnauthorizedDeferredPayoutHook(address caller);
    error AdmissionPaused();
    error InvalidPlatformConfig(bytes32 paymentMethod);
    error PlatformDisabled(bytes32 paymentMethod);
    error InvalidIntentExtensionConfig(bytes32 paymentMethod);
    error IntentExtensionsDisabled(bytes32 intentHash);
    error IntentExtensionLifetimeExceeded(bytes32 intentHash, uint256 requestedExpiry, uint256 maximumExpiry);
    error ExtensionFeeAuthorizationRequired(bytes32 intentHash, address stakeOwner, address taker);
    error InsufficientExtensionFeeStake(address stakeOwner, uint256 available, uint256 required);
    error StakeOwnerExiting(address taker, address stakeOwner);
    error InsufficientCollateral(address stakeOwner, uint256 available, uint256 required);
    error DeferredPayoutHookRequired(address expectedHook, address actualHook);
    error DeferredPayoutHookNotAllowed(address hook);
    error PositionAlreadyExists(bytes32 intentHash);
    error PositionNotPending(bytes32 intentHash, PositionStatus status);
    error PositionNotSettled(bytes32 intentHash, PositionStatus status);
    error PositionModeMismatch(bytes32 intentHash, RiskMode mode);
    error IntentStateMismatch(bytes32 intentHash);
    error CancellationNotRecorded(bytes32 intentHash);
    error SettlementNotRecorded(bytes32 intentHash);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error DeferredPayoutAlreadyRegistered(bytes32 intentHash);
    error DeferredPayoutExceedsReleasedAmount(uint256 payoutAmount, uint256 releasedAmount);
    error InsufficientDeferredPayoutCoverage(uint256 availableCoverage, uint256 requiredCoverage);
    error PositionNotMature(uint64 coverageDeadline, uint64 currentTime);
    error InvalidAttestation();
    error AttestationNotYetValid(uint64 validAfter, uint64 currentTime);
    error AttestationExpired(uint64 validUntil, uint64 currentTime);
    error ChargebackWindowClosed(uint64 coverageDeadline, uint64 currentTime);
    error AttestationNonceUsed(uint256 nonce);
    error AttestationVerificationFailed();
    error TimestampOverflow(uint256 timestamp);

    /* ============ Governance Functions ============ */

    function setPlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) external;
    function setAttestationVerifier(address _verifier) external;
    function setDeferredPayoutHook(address _hook) external;
    function setAdmissionPaused(bool _paused) external;
    function acceptVaultController() external;

    /* ============ Lifecycle Functions ============ */

    function registerDeferredPayout(bytes32 _intentHash, address _beneficiary, uint256 _amount) external;
    function reconcileCancellation(bytes32 _intentHash) external;
    function reconcileCancellations(bytes32[] calldata _intentHashes) external;
    function reconcileSettlement(bytes32 _intentHash) external;
    function reconcileSettlements(bytes32[] calldata _intentHashes) external;
    function releaseMaturedPosition(bytes32 _intentHash) external;
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external;
    function submitChargeback(
        ChargebackAttestation calldata _attestation,
        bytes[] calldata _signatures,
        bytes calldata _verificationData
    ) external;

    /* ============ View and Math Functions ============ */

    function getPlatformRiskConfig(bytes32 _paymentMethod) external view returns (PlatformRiskConfig memory);
    function getRiskPosition(bytes32 _intentHash) external view returns (RiskPosition memory);
    function getTakerState(address _taker)
        external
        view
        returns (address stakeOwner, uint256 totalStake, uint256 reserved, uint256 free, bool exiting);
    function calculateChargebackReserve(uint256 _amount, uint16 _reserveBps) external pure returns (uint256);
    function calculateIntentExtensionFee(
        uint256 _amount,
        uint16 _annualFeeBps,
        uint256 _extensionSeconds
    ) external pure returns (uint256);
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation) external view returns (bytes32);
    function orchestrator() external view returns (IOrchestratorV3);
    function stakeVault() external view returns (IStakeVault);
}
