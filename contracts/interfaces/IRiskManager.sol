// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "./IIntentRiskHook.sol";
import { INullifierRegistryV2 } from "./INullifierRegistryV2.sol";
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
        UNBONDED,
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
        /// @notice Portion retained as coverage; chargebackable v1 policy requires 10_000.
        uint16 reserveBps;
        /// @notice Half-open period after settlement during which authenticated chargebacks may slash coverage.
        uint64 riskWindow;
    }

    /// @notice Controls pending-intent liquidity-lock penalties and the reusable unbonded base tranche.
    struct GriefingConfig {
        /// @notice Cancellation grace period after signaling during which the accrued penalty is zero.
        uint64 griefingCliff;
        /// @notice Time-linear penalty slope applied after the cliff, in basis points per hour.
        uint32 griefingPenaltyBpsPerHour;
        /// @notice Reusable per-intent amount excluded from the griefing bond on non-chargebackable platforms.
        uint256 baseUnbondedAmount;
    }

    /// @notice Combines admission status with the independent chargeback and griefing policies for a platform.
    struct PlatformRiskConfig {
        /// @notice Whether new positions may snapshot this policy; disabling never mutates existing positions.
        bool enabled;
        /// @notice Post-settlement reversal policy, independent of pending-intent griefing exposure.
        ChargebackConfig chargeback;
        /// @notice Pending cancellation and reusable base-unbonded policy.
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
        /// @notice Portfolio owner whose shared stake backs any amount above the unbonded base.
        address stakeOwner;
        /// @notice Escrow depositor compensated by griefing penalties and valid chargebacks.
        address lp;
        /// @notice Payment platform whose policy was snapshotted at admission.
        bytes32 paymentMethod;
        /// @notice Economic backing source selected once at admission.
        RiskMode mode;
        /// @notice Current lifecycle state; terminal transitions never return to pending.
        PositionStatus status;
        /// @notice Original intent recipient used to validate settlement context.
        address payoutRecipient;
        /// @notice Snapshotted reserve ratio applied to gross stake or gross deferred coverage.
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
        /// @notice Whether settlement was authorized by the maker without payment-proof nullification.
        bool isManualRelease;
        /// @notice Original locked amount on which maximum pending liabilities were calculated.
        uint256 intentAmount;
        /// @notice Portion of the intent amount exposed to the griefing curve after subtracting the base tranche.
        uint256 bondedAmount;
        /// @notice Maximum time-capped griefing penalty at admission.
        uint256 maxGriefingBond;
        /// @notice Stake reserved at admission before terminal resizing or release.
        uint256 initialReservation;
        /// @notice Remaining slashable stake or deferred proceeds for this position.
        uint256 reservedAmount;
        /// @notice Exact gross amount released from Escrow before protocol, referral, and manager fees.
        uint256 grossReleasedAmount;
        /// @notice Exact post-fee amount reserved for the taker after the hook sees the gross settlement plan.
        uint256 executableAmount;
        /// @notice Exact gross amount compensable by chargeback for either backed mode.
        uint256 coveredAmount;
        /// @notice Gross proceeds converted into fully reserved taker stake for deferred settlement.
        uint256 deferredStakeAmount;
        /// @notice Contingent fee portion that vests only after clean maturity.
        uint256 deferredFeeAmount;
        /// @notice Cumulative compensation already charged against this position.
        uint256 slashedAmount;
    }

    /** @notice Signed evidence authorizing full compensation from an active chargeback position. */
    struct ChargebackAttestation {
        /// @notice Position whose full released amount may be consumed.
        bytes32 intentHash;
        /// @notice Hash of `data`, binding all chargeback details to the witness signatures.
        bytes32 dataHash;
        /// @notice Signatures from the dedicated chargeback witness set.
        bytes[] signatures;
        /// @notice ABI-encoded `ChargebackDetails` authenticated by `dataHash`.
        bytes data;
        /// @notice Optional unsigned metadata for off-chain correlation.
        bytes metadata;
    }

    /** @notice Verifier-derived dispute details bound to the original fulfilled payment. */
    struct ChargebackDetails {
        /// @notice Payment-method hash recorded by the payment verifier.
        bytes32 paymentMethod;
        /// @notice Hashed provider payment identifier recorded by the payment verifier.
        bytes32 originalPaymentId;
        /// @notice Nonzero provider dispute identifier used for global replay protection.
        bytes32 disputeId;
        /// @notice Original fiat amount in the payment method's minor unit (for example, cents).
        uint256 paymentAmount;
        /// @notice Fiat-currency hash recorded by the payment verifier.
        bytes32 paymentCurrency;
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
        uint256 baseUnbondedAmount
    );
    event RiskPositionCreated(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        address taker,
        bytes32 paymentMethod,
        RiskMode mode,
        uint256 intentAmount,
        uint256 bondedAmount,
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
        uint256 grossReleasedAmount,
        uint256 executableAmount,
        uint256 chargebackCoverage,
        uint256 releasedReservation,
        uint64 settledAt,
        uint64 coverageDeadline,
        bool isManualRelease
    );
    event DeferredSettlementFunded(
        bytes32 indexed intentHash,
        address indexed staker,
        uint256 grossAmount,
        uint256 executableAmount,
        uint256 feeAmount,
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
        uint256 grossReleasedAmount,
        uint256 compensatedAmount,
        uint256 totalCompensated,
        uint256 remainingCoverage,
        bytes32 disputeId
    );
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event AdmissionPausedUpdated(bool paused);

    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroAmount();
    error EmptyBatch();
    error UnauthorizedOrchestrator(address caller);
    error AdmissionPaused();
    error InvalidPlatformConfig(bytes32 paymentMethod);
    error PlatformDisabled(bytes32 paymentMethod);
    error InvalidPositionPolicy(bytes32 paymentMethod, uint64 griefingCliff, uint64 maxIntentPeriod);
    error GriefingPenaltyExceedsIntentAmount(bytes32 paymentMethod);
    error StakeOwnerExiting(address taker, address stakeOwner);
    error InsufficientCollateral(address stakeOwner, uint256 available, uint256 required);
    error PositionAlreadyExists(bytes32 intentHash);
    error PositionNotPending(bytes32 intentHash, PositionStatus status);
    error PositionNotSettled(bytes32 intentHash, PositionStatus status);
    error PositionModeMismatch(bytes32 intentHash, RiskMode mode);
    error IntentStateMismatch(bytes32 intentHash);
    error CancellationNotRecorded(bytes32 intentHash);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error InvalidSettlementAmounts(uint256 grossAmount, uint256 executableAmount);
    error DeferredStakeRecipientMismatch(address taker, address recipient);
    error DeferredStakeTransferMismatch(uint256 expectedAmount, uint256 actualAmount);
    error InvalidFeeAllocationCount(uint256 count, uint256 maximum);
    error InvalidFeeAllocations(uint256 expectedAmount, uint256 actualAmount);
    error PositionNotMature(uint64 coverageDeadline, uint64 currentTime);
    error InvalidAttestation();
    error InvalidPaymentBinding(bytes32 intentHash, bytes32 nullifier);
    error ChargebackWindowClosed(uint64 coverageDeadline, uint64 currentTime);
    error ChargebackEvidenceUsed(bytes32 nullifier);
    error IncompleteChargebackCoverage(uint256 available, uint256 required);
    error AttestationVerificationFailed();
    error TimestampOverflow(uint256 timestamp);

    /* ============ Governance Functions ============ */

    /** @notice Sets policy for future positions on a payment method without rewriting existing snapshots. */
    function setPlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) external;
    /** @notice Replaces the evidence verifier used for subsequently submitted chargeback attestations. */
    function setAttestationVerifier(address _verifier) external;
    /** @notice Pauses or resumes new admission while leaving terminal accounting and withdrawals available. */
    function setAdmissionPaused(bool _paused) external;
    /** @notice Accepts a previously proposed delayed StakeVault controller handover on behalf of this manager. */
    function acceptVaultController() external;

    /* ============ Lifecycle Functions ============ */

    /** @notice Permissionlessly applies one durable failed-cancellation record using its original timestamp. */
    function reconcileCancellation(bytes32 _intentHash) external;
    /** @notice Atomically reconciles several durable failed-cancellation records. */
    function reconcileCancellations(bytes32[] calldata _intentHashes) external;
    /** @notice Ends slashability and releases remaining stake coverage at or after its deadline. */
    function releaseMaturedPosition(bytes32 _intentHash) external;
    /** @notice Atomically matures several settled positions. */
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external;
    /** @notice Authenticates chargeback evidence and compensates the LP for the full covered amount. */
    function submitChargeback(ChargebackAttestation calldata _attestation) external;

    /* ============ View and Math Functions ============ */

    /** @notice Returns policy used only by future admissions for a payment method. */
    function getPlatformRiskConfig(bytes32 _paymentMethod) external view returns (PlatformRiskConfig memory);
    /** @notice Returns the complete immutable snapshot and mutable lifecycle accounting for an intent. */
    function getRiskPosition(bytes32 _intentHash) external view returns (RiskPosition memory);
    /** @notice Returns the delegated portfolio owner and current aggregate stake capacity for a taker. */
    function getTakerState(address _taker)
        external
        view
        returns (address stakeOwner, uint256 totalStake, uint256 reserved, uint256 free, bool exiting);
    /** @notice Returns max(intent amount - base unbonded amount, 0). */
    function calculateBondedAmount(uint256 _amount, uint256 _baseUnbondedAmount) external pure returns (uint256);
    /** @notice Returns ceil(bonded amount * slope * (period - cliff) / (10_000 * 1 hour)). */
    function calculateMaxGriefingBond(
        uint256 _intentAmount,
        uint64 _maxIntentPeriod,
        GriefingConfig calldata _config
    ) external pure returns (uint256);
    /** @notice Returns the time-capped penalty for a bonded amount and effective elapsed time at cancellation. */
    function calculateGriefingPenalty(
        uint256 _bondedAmount,
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
        uint256 _intentAmount,
        uint64 _maxIntentPeriod,
        PlatformRiskConfig calldata _config
    ) external pure returns (uint256 maxGriefingBond, uint256 chargebackReserve, uint256 requiredReservation);
    /** @notice Returns the complete EIP-712 digest that an attestation verifier authenticates. */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation) external view returns (bytes32);
    /** @notice Returns the immutable canonical lifecycle source authorized to call position callbacks. */
    function orchestrator() external view returns (IOrchestratorV3);
    /** @notice Returns the immutable policy-agnostic custody and reservation vault. */
    function stakeVault() external view returns (IStakeVault);
    /** @notice Returns the immutable registry that binds verified payment nullifiers to intents. */
    function nullifierRegistry() external view returns (INullifierRegistryV2);
}
