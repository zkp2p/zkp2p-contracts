// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "./IIntentRiskHook.sol";
import { IOrchestratorV3 } from "./IOrchestratorV3.sol";
import { IStakeVault } from "./IStakeVault.sol";

/**
 * @title IRiskManager
 * @notice Continuous stake-risk policy for pending-intent griefing and post-settlement chargebacks.
 * @dev Implementations must snapshot mutable platform and Escrow terms when an intent is admitted.
 */
interface IRiskManager is IIntentRiskHook {
    /* ============ Enums ============ */

    /** @notice Economic source backing a position. */
    enum RiskMode {
        NONE,
        FREE,
        STAKE_BACKED,
        DEFERRED_PAYOUT
    }

    /** @notice Lifecycle state of a snapshotted risk position. */
    enum PositionStatus {
        NONE,
        PENDING,
        CANCELLED,
        SETTLED,
        RELEASED,
        SLASHED
    }

    /* ============ Structs ============ */

    /// @notice Controls post-settlement chargeback protection for a payment platform.
    struct ChargebackConfig {
        /// @notice Whether a fulfilled payment can later reverse and create LP loss.
        bool chargebackable;
        /// @notice Whether held settlement proceeds may replace membership stake as post-settlement coverage.
        bool deferredPayoutEnabled;
        /// @notice Upward-rounded portion of the exact released amount retained as coverage, in basis points.
        uint16 reserveBps;
        /// @notice Half-open period after settlement during which authenticated chargebacks may slash coverage.
        uint64 riskWindow;
    }

    /// @notice Controls pending-intent liquidity-lock penalties and onboarding free intents.
    struct GriefingConfig {
        /// @notice Cancellation grace period after signaling during which the accrued penalty is zero.
        uint64 griefingCliff;
        /// @notice Time-linear penalty slope applied after the cliff, in basis points per hour.
        uint32 griefingPenaltyBpsPerHour;
        /// @notice Lifetime number of whole unbonded intents available to each stake owner on this platform.
        uint32 freeTakeCount;
        /// @notice Maximum amount of each whole free intent; no portion is applied to a larger intent.
        uint256 freeTakeAmount;
    }

    /// @notice Combines admission status with the independent chargeback and griefing policies for a platform.
    struct PlatformRiskConfig {
        /// @notice Whether new positions may snapshot this policy; disabling never mutates existing positions.
        bool enabled;
        /// @notice Post-settlement reversal policy, independent of pending-intent griefing exposure.
        ChargebackConfig chargeback;
        /// @notice Pending cancellation and lifetime onboarding-subsidy policy.
        GriefingConfig griefing;
    }

    /**
     * @notice Immutable admission terms plus mutable lifecycle accounting for one intent.
     * @dev Fields through `initialReservation` are snapshots. Later governance and Escrow changes cannot
     *      alter the position's liability. `reservedAmount` is the remaining slashable amount.
     */
    struct RiskPosition {
        /// @notice Intent owner whose action created the position.
        address taker;
        /// @notice Portfolio owner whose shared stake or free allowance backs the position.
        address stakeOwner;
        /// @notice Escrow depositor compensated by griefing penalties and valid chargebacks.
        address lp;
        /// @notice Payment platform whose policy was snapshotted at admission.
        bytes32 paymentMethod;
        /// @notice Economic backing source selected once at admission.
        RiskMode mode;
        /// @notice Current lifecycle state; terminal transitions never return to pending.
        PositionStatus status;
        /// @notice Whether admission permanently consumed one lifetime free allowance.
        bool consumedFreeTake;
        /// @notice Canonical deferred hook snapshotted only for a deferred-payout position.
        address deferredPayoutHook;
        /// @notice Original intent recipient entitled to unslashed deferred proceeds.
        address payoutRecipient;
        /// @notice Snapshotted chargeback reserve ratio applied to the exact released amount.
        uint16 chargebackReserveBps;
        /// @notice Snapshotted hourly slope used by the time-linear cancellation formula.
        uint32 griefingPenaltyBpsPerHour;
        /// @notice Snapshotted duration of post-settlement chargeback coverage.
        uint64 riskWindow;
        /// @notice Canonical Orchestrator intent-creation timestamp.
        uint64 createdAt;
        /// @notice Escrow intent period at admission, which caps griefing liability.
        uint64 maxIntentPeriod;
        /// @notice Snapshotted zero-penalty cancellation interval.
        uint64 griefingCliff;
        /// @notice Liquidity-unlock timestamp used for cancellation accounting.
        uint64 cancelledAt;
        /// @notice Fulfillment or manual-release timestamp that starts coverage.
        uint64 settledAt;
        /// @notice First timestamp excluded from the half-open chargeback window.
        uint64 coverageDeadline;
        /// @notice Original locked amount on which maximum pending liabilities were calculated.
        uint256 intentAmount;
        /// @notice Maximum time-capped griefing penalty at admission.
        uint256 maxGriefingBond;
        /// @notice Stake reserved at admission before terminal resizing or release.
        uint256 initialReservation;
        /// @notice Remaining slashable stake or deferred proceeds for this position.
        uint256 reservedAmount;
        /// @notice Exact amount released from Escrow at settlement before post-hook fees.
        uint256 releasedAmount;
        /// @notice Total net proceeds recorded in StakeVault for a deferred payout.
        uint256 deferredPayoutAmount;
        /// @notice Cumulative compensation already charged against this position.
        uint256 slashedAmount;
    }

    /** @notice Signed evidence authorizing compensation from an active chargeback position. */
    struct ChargebackAttestation {
        /// @notice Chain domain preventing cross-chain replay.
        uint256 chainId;
        /// @notice RiskManager domain preventing replay across manager replacements.
        address riskManager;
        /// @notice Orchestrator domain preventing replay across intent namespaces.
        address orchestrator;
        /// @notice Position whose remaining coverage may be consumed.
        bytes32 intentHash;
        /// @notice Payment platform bound to the position snapshot.
        bytes32 paymentMethod;
        /// @notice LP loss requested; compensation is capped at remaining coverage.
        uint256 chargebackAmount;
        /// @notice Nonzero off-chain evidence identifier emitted for audit correlation.
        bytes32 evidenceId;
        /// @notice Manager-wide one-time nonce preventing attestation replay.
        uint256 nonce;
        /// @notice First timestamp at which the attestation is valid.
        uint64 validAfter;
        /// @notice Last timestamp at which the attestation itself is valid.
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
        uint64 griefingCliff,
        uint32 griefingPenaltyBpsPerHour,
        uint32 freeTakeCount,
        uint256 freeTakeAmount
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
        uint64 maxIntentPeriod,
        uint64 griefingCliff,
        uint32 griefingPenaltyBpsPerHour,
        uint16 chargebackReserveBps,
        uint64 riskWindow,
        uint256 maxGriefingBond,
        uint256 chargebackReserve,
        uint256 initialReservation
    );
    event FreeTakeConsumed(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        bytes32 indexed paymentMethod,
        uint256 amount,
        uint32 freeTakesUsed,
        uint32 freeTakeCount
    );
    event GriefingPenaltyCharged(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        uint256 penalty,
        uint256 elapsedTime
    );
    event RiskPositionCancelled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        uint64 cancelledAt,
        uint256 penalty,
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
    error InvalidPositionPolicy(bytes32 paymentMethod, uint64 griefingCliff, uint64 maxIntentPeriod);
    error GriefingPenaltyExceedsIntentAmount(bytes32 paymentMethod);
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
    error DeferredPayoutAlreadyRegistered(bytes32 intentHash);
    error DeferredPayoutExceedsReleasedAmount(uint256 payoutAmount, uint256 releasedAmount);
    error PositionNotMature(uint64 coverageDeadline, uint64 currentTime);
    error InvalidAttestation();
    error AttestationNotYetValid(uint64 validAfter, uint64 currentTime);
    error AttestationExpired(uint64 validUntil, uint64 currentTime);
    error ChargebackWindowClosed(uint64 coverageDeadline, uint64 currentTime);
    error AttestationNonceUsed(uint256 nonce);
    error AttestationVerificationFailed();
    error TimestampOverflow(uint256 timestamp);

    /* ============ Governance Functions ============ */

    /** @notice Sets policy for future positions on a payment method without rewriting existing snapshots. */
    function setPlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) external;
    /** @notice Replaces the evidence verifier used for subsequently submitted chargeback attestations. */
    function setAttestationVerifier(address _verifier) external;
    /** @notice Sets the canonical deferred hook snapshotted by future deferred-payout positions. */
    function setDeferredPayoutHook(address _hook) external;
    /** @notice Pauses or resumes new admission while leaving terminal accounting and withdrawals available. */
    function setAdmissionPaused(bool _paused) external;
    /** @notice Accepts a previously proposed delayed StakeVault controller handover on behalf of this manager. */
    function acceptVaultController() external;

    /* ============ Lifecycle Functions ============ */

    /** @notice Records net proceeds already transferred to StakeVault by the snapshotted canonical hook. */
    function registerDeferredPayout(bytes32 _intentHash, address _beneficiary, uint256 _amount) external;
    /** @notice Permissionlessly applies one durable failed-cancellation record using its original timestamp. */
    function reconcileCancellation(bytes32 _intentHash) external;
    /** @notice Atomically reconciles several durable failed-cancellation records. */
    function reconcileCancellations(bytes32[] calldata _intentHashes) external;
    /** @notice Permissionlessly applies one durable failed-settlement record. */
    function reconcileSettlement(bytes32 _intentHash) external;
    /** @notice Atomically reconciles several durable failed-settlement records. */
    function reconcileSettlements(bytes32[] calldata _intentHashes) external;
    /** @notice Ends slashability and releases remaining stake coverage at or after its deadline. */
    function releaseMaturedPosition(bytes32 _intentHash) external;
    /** @notice Atomically matures several settled positions. */
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external;
    /** @notice Authenticates chargeback evidence and compensates the LP up to remaining coverage. */
    function submitChargeback(
        ChargebackAttestation calldata _attestation,
        bytes[] calldata _signatures,
        bytes calldata _verificationData
    ) external;

    /* ============ View and Math Functions ============ */

    /** @notice Returns policy used only by future admissions for a payment method. */
    function getPlatformRiskConfig(bytes32 _paymentMethod) external view returns (PlatformRiskConfig memory);
    /** @notice Returns the complete immutable snapshot and mutable lifecycle accounting for an intent. */
    function getRiskPosition(bytes32 _intentHash) external view returns (RiskPosition memory);
    /** @notice Returns lifetime free intents consumed by one stake owner on one platform. */
    function freeTakesUsed(address _stakeOwner, bytes32 _paymentMethod) external view returns (uint32);
    /** @notice Returns the delegated portfolio owner and current aggregate stake capacity for a taker. */
    function getTakerState(address _taker)
        external
        view
        returns (address stakeOwner, uint256 totalStake, uint256 reserved, uint256 free, bool exiting);
    /** @notice Returns ceil(amount * slope * (period - cliff) / (10_000 * 1 hour)). */
    function calculateMaxGriefingBond(
        uint256 _amount,
        uint64 _maxIntentPeriod,
        GriefingConfig calldata _config
    ) external pure returns (uint256);
    /** @notice Returns the time-capped, upward-rounded penalty and effective elapsed time at cancellation. */
    function calculateGriefingPenalty(
        uint256 _amount,
        uint64 _createdAt,
        uint64 _cancelledAt,
        uint64 _maxIntentPeriod,
        uint64 _griefingCliff,
        uint32 _griefingPenaltyBpsPerHour
    ) external pure returns (uint256 penalty, uint256 effectiveElapsed);
    /** @notice Returns ceil(amount * reserveBps / 10_000). */
    function calculateChargebackReserve(uint256 _amount, uint16 _reserveBps) external pure returns (uint256);
    /** @notice Returns both mutually exclusive liabilities and their maximum admission reservation. */
    function calculateRequiredReservation(
        uint256 _amount,
        uint64 _maxIntentPeriod,
        PlatformRiskConfig calldata _config
    ) external pure returns (uint256 maxGriefingBond, uint256 chargebackReserve, uint256 requiredReservation);
    /** @notice Returns the complete EIP-712 digest that an attestation verifier authenticates. */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation) external view returns (bytes32);
    /** @notice Returns the immutable canonical lifecycle source authorized to call position callbacks. */
    function orchestrator() external view returns (IOrchestratorV3);
    /** @notice Returns the immutable policy-agnostic custody and reservation vault. */
    function stakeVault() external view returns (IStakeVault);
}
