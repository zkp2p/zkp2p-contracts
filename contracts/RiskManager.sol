// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAttestationVerifier } from "./interfaces/IAttestationVerifier.sol";
import { IEscrowV2 } from "./interfaces/IEscrowV2.sol";
import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { INullifierRegistryV2 } from "./interfaces/INullifierRegistryV2.sol";
import { IOrchestratorV3 } from "./interfaces/IOrchestratorV3.sol";
import { IRiskManager } from "./interfaces/IRiskManager.sol";
import { IStakeVault } from "./interfaces/IStakeVault.sol";

/**
 * @title RiskManager
 * @notice Enforces continuous, stake-backed taker risk without tiers, amount caps, cooldowns, or
 *         stake-derived intent-count limits.
 *
 * @dev ECONOMIC MODEL
 *      A pending bonded intent can end in exactly one of two mutually exclusive ways: cancellation,
 *      which may owe the LP a griefing penalty, or settlement, which may create chargeback exposure.
 *      Admission therefore reserves the maximum of those liabilities instead of their sum:
 *
 *        B = max(A - U, 0)
 *        maxGriefingBond = ceil(B * s * (T - C) / (10_000 * 1 hour))
 *        chargebackReserve = ceil(A * r / 10_000)
 *        initialReservation = max(maxGriefingBond, chargebackReserve)
 *
 *      where A is intent amount, U is the platform's reusable unbonded base, B is the bonded amount,
 *      s is penalty basis points per hour, T is the Escrow's snapshotted maximum intent period, C is
 *      the griefing cliff, and r is the chargeback reserve ratio. Chargebackable platforms require U=0.
 *
 * @dev CANCELLATION CURVE
 *      At cancellation, elapsed time is capped at T so an intent-guardian extension cannot increase
 *      taker liability. The charged penalty is:
 *
 *        effectiveElapsed = min(cancelledAt - createdAt, T)
 *        chargeableTime = max(effectiveElapsed - C, 0)
 *        penalty = ceil(B * s * chargeableTime / (10_000 * 1 hour))
 *
 *      Rounding is always upward. Every cancellation strictly after the cliff therefore pays at
 *      least one smallest token unit whenever the slope and amount are nonzero.
 *
 * @dev LIFECYCLE
 *      - Non-chargebackable intents receive the reusable unbonded base on every admission.
 *      - Only the amount above that base enters the griefing curve and reserves stake.
 *      - Cancellation slashes only the accrued griefing penalty and releases every unused unit.
 *      - Non-chargebackable settlement releases the full pending reservation immediately.
 *      - Stake-backed settlement resizes coverage to the gross Escrow release and consumes no payout funds.
 *      - Deferred settlement pulls the complete gross release directly into StakeVault and converts it
 *        into taker-owned stake that remains fully reserved through the chargeback window.
 *      - Deferred fees remain contingent inside that reservation. Clean maturity vests fee claims and
 *        releases the net amount as reusable stake; chargeback cancels the fee plan and compensates gross.
 *
 * @dev SECURITY INVARIANTS AND RATIONALE
 *      1. Mutable platform and Escrow policy is snapshotted at admission; governance cannot rewrite
 *         existing liabilities.
 *      2. All positions for one stake owner share StakeVault.freeStake, so reservations compose across
 *         takers and platforms without a protocol-wide exposure gate.
 *      3. The base unbonded amount is stateless contract policy. Sybil-resistant account gating is a
 *         separate admission concern and is not approximated with wallet-local usage state.
 *      4. Token-bearing settlement is fail-closed. Cancellation alone is fail-open for liquidity
 *         liveness: failed cancellations retain the full reservation and reconcile against the durable
 *         original unlock timestamp, preventing delay-based overcharging or escaped liability.
 *      5. Chargeback compensation is full-only: remaining coverage must equal the gross Escrow release,
 *         whether backed by pre-existing stake or newly converted deferred stake.
 *      6. This contract never retains tokens. Deferred proceeds move directly from OrchestratorV3 to
 *         StakeVault, which is the sole accounting and custody boundary.
 *      7. Escrow intent amounts and StakeVault liabilities must use the same immutable token, otherwise
 *         raw units, griefing penalties, base limits, and chargeback ratios would have no shared meaning.
 *      8. Proof-based chargeback evidence must resolve the supplied payment ID to this exact intent in
 *         both binding directions. Manual releases have no payment nullifier, so their dedicated witness
 *         signature binds evidence to the exact intent while the dispute identifier remains single-use.
 */
contract RiskManager is IRiskManager, Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /* ============ Constants ============ */

    /// @notice Basis-point denominator shared by both affine curves.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Seconds per hour used to convert the configured hourly griefing slope.
    uint256 public constant SECONDS_PER_HOUR = 1 hours;

    /// @notice Combined denominator for the time-linear griefing formula.
    uint256 public constant GRIEFING_DENOMINATOR = BPS_DENOMINATOR * SECONDS_PER_HOUR;

    /// @notice Operational ceiling preventing a governance value that cannot fit in uint64 deadlines.
    /// @dev One year is deliberately far above the approved illustrative 30-day window while keeping
    ///      settlement deadline construction safe for every realistic EVM timestamp horizon.
    uint64 public constant MAX_RISK_WINDOW = 365 days;

    /// @notice Protocol + up to five referrals + manager fee.
    uint256 public constant MAX_FEE_ALLOCATIONS = 7;

    /// @notice Minimal EIP-712 type hash; chain and manager binding live in the EIP-712 domain.
    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH = keccak256(
        "ChargebackAttestation(bytes32 intentHash,bytes32 dataHash)"
    );

    /* ============ Immutable Dependencies ============ */

    /// @notice Canonical source of intent admission, settlement, and failed-callback timestamps.
    IOrchestratorV3 public immutable override orchestrator;

    /// @notice Custody and portfolio-accounting boundary for stake and deferred proceeds.
    IStakeVault public immutable override stakeVault;

    /// @notice Canonical source binding each post-cutover payment nullifier to its fulfilled intent.
    INullifierRegistryV2 public immutable override nullifierRegistry;

    /* ============ Mutable Governance State ============ */

    /// @notice Dedicated verifier that authenticates typed chargeback attestations.
    /// @dev Deployments must use credentials independent from payment-attestation witnesses.
    IAttestationVerifier public attestationVerifier;

    /// @notice Emergency admission switch; terminal accounting remains available while paused.
    bool public admissionPaused;

    /* ============ Position State ============ */

    /// @dev Mutable policy for future positions only. Every admitted position snapshots its terms.
    mapping(bytes32 => PlatformRiskConfig) internal platformRiskConfigs;

    /// @dev Complete per-intent policy snapshot and lifecycle accounting.
    mapping(bytes32 => RiskPosition) internal riskPositions;

    /// @notice Global replay protection for payment-method-scoped dispute identifiers.
    mapping(bytes32 => bool) public usedChargebackNullifiers;

    /* ============ Modifiers ============ */

    /** @dev Restricts canonical lifecycle callbacks to the immutable orchestrator. */
    modifier onlyOrchestrator() {
        if (msg.sender != address(orchestrator)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Creates an independently replaceable policy controller for one orchestrator and vault.
     * @param _owner Governance owner allowed to configure future platform policy.
     * @param _orchestrator Canonical intent lifecycle source.
     * @param _stakeVault Policy-agnostic stake and deferred-payout vault.
     * @param _attestationVerifier Initial chargeback evidence verifier.
     * @param _nullifierRegistry Canonical registry binding verified payments to fulfilled intents.
     */
    constructor(
        address _owner,
        IOrchestratorV3 _orchestrator,
        IStakeVault _stakeVault,
        IAttestationVerifier _attestationVerifier,
        INullifierRegistryV2 _nullifierRegistry
    ) Ownable() EIP712("ZKP2P RiskManager", "1") {
        if (
            _owner == address(0)
                || address(_orchestrator) == address(0)
                || address(_stakeVault) == address(0)
                || address(_attestationVerifier) == address(0)
                || address(_nullifierRegistry) == address(0)
        ) {
            revert ZeroAddress();
        }
        if (
            address(_orchestrator).code.length == 0
                || address(_stakeVault).code.length == 0
                || address(_attestationVerifier).code.length == 0
                || address(_nullifierRegistry).code.length == 0
        ) revert ZeroAddress();

        orchestrator = _orchestrator;
        stakeVault = _stakeVault;
        attestationVerifier = _attestationVerifier;
        nullifierRegistry = _nullifierRegistry;
        transferOwnership(_owner);
    }

    /* ============ Orchestrator Lifecycle ============ */

    /**
     * @inheritdoc IIntentRiskHook
     * @dev Admission is fail-closed. This function resolves delegation, validates the current platform
     *      against the intent's Escrow period, snapshots every liability input, applies the configured
     *      base tranche, and reserves shared portfolio stake before returning.
     */
    function onIntentCreated(bytes32 _intentHash)
        external
        override
        onlyOrchestrator
        nonReentrant
    {
        if (admissionPaused) revert AdmissionPaused();
        if (riskPositions[_intentHash].status != PositionStatus.NONE) revert PositionAlreadyExists(_intentHash);

        IOrchestratorV3.RiskIntentData memory intent = orchestrator.getRiskIntent(_intentHash);
        if (intent.owner == address(0) || intent.createdAt == 0) revert IntentStateMismatch(_intentHash);

        PlatformRiskConfig memory config = platformRiskConfigs[intent.paymentMethod];
        if (!config.enabled) revert PlatformDisabled(intent.paymentMethod);

        uint64 maxIntentPeriod = _toUint64(IEscrowV2(intent.escrow).intentExpirationPeriod());
        _validatePositionPolicy(intent.paymentMethod, maxIntentPeriod, config.griefing);

        IEscrowV2.Deposit memory deposit = IEscrowV2(intent.escrow).getDeposit(intent.depositId);
        _validateIntentToken(deposit.token);
        address stakeOwner = stakeVault.stakeOwnerOf(intent.owner);
        uint256 bondedAmount = _calculateBondedAmount(intent.amount, config.griefing.baseUnbondedAmount);

        (uint256 maxGriefingBond, uint256 chargebackReserve, uint256 requiredReservation) =
            _calculateRequiredReservation(intent.amount, maxIntentPeriod, config);

        RiskMode mode;
        uint256 initialReservation;

        if (bondedAmount == 0) {
            mode = RiskMode.UNBONDED;
        } else {
            uint256 available = stakeVault.freeStake(stakeOwner);
            if (available >= requiredReservation) {
                mode = RiskMode.STAKE_BACKED;
                initialReservation = requiredReservation;
            } else if (
                config.chargeback.chargebackable
                    && config.chargeback.deferredPayoutEnabled
                    && available >= maxGriefingBond
            ) {
                if (intent.to != intent.owner) {
                    revert DeferredStakeRecipientMismatch(intent.owner, intent.to);
                }
                mode = RiskMode.DEFERRED_PAYOUT;
                initialReservation = maxGriefingBond;
            } else {
                revert InsufficientCollateral(stakeOwner, available, requiredReservation);
            }

            if (initialReservation != 0 && stakeVault.isExiting(stakeOwner)) {
                revert StakeOwnerExiting(intent.owner, stakeOwner);
            }
        }

        RiskPosition storage position = riskPositions[_intentHash];
        position.taker = intent.owner;
        position.stakeOwner = stakeOwner;
        position.lp = deposit.depositor;
        position.paymentMethod = intent.paymentMethod;
        position.mode = mode;
        position.status = PositionStatus.PENDING;
        position.payoutRecipient = intent.to;
        position.chargebackReserveBps = config.chargeback.reserveBps;
        position.griefingPenaltyBpsPerHour = config.griefing.griefingPenaltyBpsPerHour;
        position.riskWindow = config.chargeback.riskWindow;
        position.createdAt = intent.createdAt;
        position.maxIntentPeriod = maxIntentPeriod;
        position.griefingCliff = config.griefing.griefingCliff;
        position.intentAmount = intent.amount;
        position.bondedAmount = bondedAmount;
        position.maxGriefingBond = maxGriefingBond;
        position.initialReservation = initialReservation;
        position.reservedAmount = initialReservation;

        if (initialReservation != 0) {
            stakeVault.reserveStake(stakeOwner, _intentHash, initialReservation, 0);
        }
        if (mode == RiskMode.DEFERRED_PAYOUT) {
            stakeVault.authorizeDeferredStake(_intentHash, intent.owner, 0);
        }

        _emitRiskPositionCreated(_intentHash, position, chargebackReserve);
    }

    /** @dev Emits the complete admission snapshot from storage to keep admission stack usage bounded. */
    function _emitRiskPositionCreated(
        bytes32 _intentHash,
        RiskPosition storage _position,
        uint256 _chargebackReserve
    ) internal {
        emit RiskPositionCreated(
            _intentHash,
            _position.stakeOwner,
            _position.lp,
            _position.taker,
            _position.paymentMethod,
            _position.mode,
            _position.intentAmount,
            _position.bondedAmount,
            _position.createdAt,
            _position.maxIntentPeriod,
            _position.griefingCliff,
            _position.griefingPenaltyBpsPerHour,
            _position.chargebackReserveBps,
            _position.riskWindow,
            _position.maxGriefingBond,
            _chargebackReserve,
            _position.initialReservation
        );
    }

    /**
     * @inheritdoc IIntentRiskHook
     * @dev Uses the same transaction timestamp at which OrchestratorV3 stops tracking the liquidity lock.
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator nonReentrant {
        _cancelPosition(_intentHash, uint64(block.timestamp));
    }

    /**
     * @inheritdoc IIntentRiskHook
     * @dev This callback runs before distribution. Stake-backed settlement consumes zero tokens.
     *      Deferred settlement pulls gross funds and preserves the independently rounded fee plan
     *      inside fully reserved taker stake until chargeback or clean maturity.
     */
    function settleIntent(
        RiskSettlementContext calldata _context
    ) external override onlyOrchestrator nonReentrant {
        if (_context.token != address(stakeVault.stakeToken())) {
            revert IntentTokenMismatch(address(stakeVault.stakeToken()), _context.token);
        }
        if (
            _context.grossAmount == 0
                || _context.executableAmount == 0
                || _context.executableAmount > _context.grossAmount
        ) {
            revert InvalidSettlementAmounts(_context.grossAmount, _context.executableAmount);
        }
        if (_context.feeAllocations.length > MAX_FEE_ALLOCATIONS) {
            revert InvalidFeeAllocationCount(_context.feeAllocations.length, MAX_FEE_ALLOCATIONS);
        }

        uint256 allocatedFees;
        for (uint256 allocationIndex = 0; allocationIndex < _context.feeAllocations.length; allocationIndex++) {
            FeeAllocation calldata allocation = _context.feeAllocations[allocationIndex];
            if (allocation.recipient == address(0)) revert ZeroAddress();
            allocatedFees += allocation.amount;
        }
        uint256 expectedFees = _context.grossAmount - _context.executableAmount;
        if (allocatedFees != expectedFees) revert InvalidFeeAllocations(expectedFees, allocatedFees);

        RiskPosition storage position = riskPositions[_context.intentHash];
        if (position.payoutRecipient != _context.recipient) revert IntentStateMismatch(_context.intentHash);

        _settlePosition(
            _context.intentHash,
            IERC20(_context.token),
            _context.grossAmount,
            _context.executableAmount,
            uint64(block.timestamp),
            _context.isManualRelease,
            _context.feeAllocations
        );
    }

    /* ============ Failed-Callback Reconciliation ============ */

    /**
     * @inheritdoc IRiskManager
     * @dev Permissionless reconciliation charges against the orchestrator's durable cancellation
     *      timestamp, never the timestamp of this later transaction.
     */
    function reconcileCancellation(bytes32 _intentHash) external override nonReentrant {
        _reconcileCancellation(_intentHash);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function reconcileCancellations(bytes32[] calldata _intentHashes) external override nonReentrant {
        if (_intentHashes.length == 0) revert EmptyBatch();
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _reconcileCancellation(_intentHashes[intentIndex]);
        }
    }

    /**
     * @inheritdoc IRiskManager
     */
    /** @dev Reads and applies one failed cancellation record. */
    function _reconcileCancellation(bytes32 _intentHash) internal {
        uint64 cancelledAt = orchestrator.getIntentCancellation(_intentHash);
        if (cancelledAt == 0) revert CancellationNotRecorded(_intentHash);
        _cancelPosition(_intentHash, cancelledAt);
    }

    /* ============ Chargebacks and Maturity ============ */

    /**
     * @inheritdoc IRiskManager
     */
    function releaseMaturedPosition(bytes32 _intentHash) external override nonReentrant {
        _releaseMaturedPosition(_intentHash);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external override nonReentrant {
        if (_intentHashes.length == 0) revert EmptyBatch();
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _releaseMaturedPosition(_intentHashes[intentIndex]);
        }
    }

    /** @dev Releases stake-backed coverage or vests deferred fee claims and frees the taker's net stake. */
    function _releaseMaturedPosition(bytes32 _intentHash) internal {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.SETTLED) revert PositionNotSettled(_intentHash, position.status);
        if (position.coverageDeadline == 0 || block.timestamp < position.coverageDeadline) {
            revert PositionNotMature(position.coverageDeadline, uint64(block.timestamp));
        }

        uint256 releasedCoverage = position.reservedAmount;
        position.status = PositionStatus.RELEASED;
        position.reservedAmount = 0;

        address releasedStakeOwner = position.stakeOwner;
        if (position.mode == RiskMode.STAKE_BACKED && releasedCoverage != 0) {
            stakeVault.releaseReservation(_intentHash);
        } else if (position.mode == RiskMode.DEFERRED_PAYOUT && releasedCoverage != 0) {
            releasedStakeOwner = position.taker;
            stakeVault.releaseDeferredStake(_intentHash);
        }

        emit RiskPositionReleased(_intentHash, releasedStakeOwner, position.mode, releasedCoverage);
    }

    /**
     * @inheritdoc IRiskManager
     * @dev V1 is deliberately full-only: a valid attestation consumes the dispute nullifier and
     *      compensates exactly the covered amount derived from settlement state. That amount is gross
     *      for both stake-backed and deferred-stake positions.
     */
    function submitChargeback(ChargebackAttestation calldata _attestation) external override nonReentrant {
        RiskPosition storage position = riskPositions[_attestation.intentHash];
        if (position.status != PositionStatus.SETTLED) {
            revert PositionNotSettled(_attestation.intentHash, position.status);
        }
        if (position.mode != RiskMode.STAKE_BACKED && position.mode != RiskMode.DEFERRED_PAYOUT) {
            revert PositionModeMismatch(_attestation.intentHash, position.mode);
        }

        (ChargebackDetails memory details, bytes32 nullifier) = _validateAttestation(_attestation, position);
        bytes32 digest = _hashTypedDataV4(_hashChargebackAttestation(_attestation));
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }

        uint256 compensatedAmount = position.coveredAmount;
        if (position.reservedAmount != compensatedAmount) {
            revert IncompleteChargebackCoverage(position.reservedAmount, compensatedAmount);
        }

        usedChargebackNullifiers[nullifier] = true;
        position.slashedAmount = compensatedAmount;
        position.reservedAmount = 0;
        position.status = PositionStatus.SLASHED;

        if (position.mode == RiskMode.STAKE_BACKED) {
            stakeVault.slashReservation(_attestation.intentHash, position.lp, compensatedAmount);
        } else {
            stakeVault.slashDeferredStake(_attestation.intentHash, position.lp);
        }

        emit ChargebackSettled(
            _attestation.intentHash,
            position.mode == RiskMode.DEFERRED_PAYOUT ? position.taker : position.stakeOwner,
            position.lp,
            position.mode,
            position.grossReleasedAmount,
            compensatedAmount,
            position.slashedAmount,
            position.reservedAmount,
            details.disputeId
        );
    }

    /* ============ Governance ============ */

    /**
     * @inheritdoc IRiskManager
     * @dev Configuration affects future admissions only. Escrow-period-dependent constraints are
     *      validated again at admission because different Escrows may expose different periods.
     */
    function setPlatformRiskConfig(
        bytes32 _paymentMethod,
        PlatformRiskConfig calldata _config
    ) external override onlyOwner {
        _validatePlatformConfig(_paymentMethod, _config);
        platformRiskConfigs[_paymentMethod] = _config;

        emit PlatformRiskConfigUpdated(
            _paymentMethod,
            _config.enabled,
            _config.chargeback.chargebackable,
            _config.chargeback.deferredPayoutEnabled,
            _config.chargeback.reserveBps,
            _config.chargeback.riskWindow,
            _config.griefing.griefingCliff,
            _config.griefing.griefingPenaltyBpsPerHour,
            _config.griefing.baseUnbondedAmount
        );
    }

    /**
     * @inheritdoc IRiskManager
     */
    function setAttestationVerifier(address _verifier) external override onlyOwner {
        if (_verifier == address(0) || _verifier.code.length == 0) revert ZeroAddress();
        address previousVerifier = address(attestationVerifier);
        attestationVerifier = IAttestationVerifier(_verifier);
        emit AttestationVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function setAdmissionPaused(bool _paused) external override onlyOwner {
        admissionPaused = _paused;
        emit AdmissionPausedUpdated(_paused);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function acceptVaultController() external override onlyOwner {
        stakeVault.acceptController();
    }

    /* ============ Views ============ */

    /**
     * @inheritdoc IRiskManager
     */
    function getPlatformRiskConfig(
        bytes32 _paymentMethod
    ) external view override returns (PlatformRiskConfig memory) {
        return platformRiskConfigs[_paymentMethod];
    }

    /**
     * @inheritdoc IRiskManager
     */
    function getRiskPosition(bytes32 _intentHash) external view override returns (RiskPosition memory) {
        return riskPositions[_intentHash];
    }

    /**
     * @inheritdoc IRiskManager
     * @dev `reserved` and `free` are portfolio-wide values shared by all delegated takers and platforms.
     */
    function getTakerState(address _taker)
        external
        view
        override
        returns (address stakeOwner, uint256 totalStake, uint256 reserved, uint256 free, bool exiting)
    {
        stakeOwner = stakeVault.stakeOwnerOf(_taker);
        totalStake = stakeVault.stakeBalance(stakeOwner);
        reserved = stakeVault.reservedStake(stakeOwner);
        free = stakeVault.freeStake(stakeOwner);
        exiting = stakeVault.isExiting(stakeOwner);
    }

    /* ============ Public Formula Helpers ============ */

    /**
     * @inheritdoc IRiskManager
     */
    function calculateBondedAmount(
        uint256 _amount,
        uint256 _baseUnbondedAmount
    ) external pure override returns (uint256) {
        return _calculateBondedAmount(_amount, _baseUnbondedAmount);
    }

    /**
     * @inheritdoc IRiskManager
     * @dev Uses full-precision multiplication and upward rounding. Invalid `cliff >= period` inputs
     *      return zero here; platform admission separately rejects such a configuration.
     */
    function calculateMaxGriefingBond(
        uint256 _intentAmount,
        uint64 _maxIntentPeriod,
        GriefingConfig calldata _config
    ) external pure override returns (uint256) {
        return _calculateMaxGriefingBond(
            _calculateBondedAmount(_intentAmount, _config.baseUnbondedAmount),
            _maxIntentPeriod,
            _config.griefingCliff,
            _config.griefingPenaltyBpsPerHour
        );
    }

    /**
     * @inheritdoc IRiskManager
     * @dev `effectiveElapsed` is elapsed wall time capped by the snapshotted maximum intent period.
     */
    function calculateGriefingPenalty(
        uint256 _bondedAmount,
        uint64 _createdAt,
        uint64 _cancelledAt,
        uint64 _maxIntentPeriod,
        uint64 _griefingCliff,
        uint32 _griefingPenaltyBpsPerHour
    ) external pure override returns (uint256 penalty, uint256 effectiveElapsed) {
        return _calculateGriefingPenalty(
            _bondedAmount,
            _createdAt,
            _cancelledAt,
            _maxIntentPeriod,
            _griefingCliff,
            _griefingPenaltyBpsPerHour
        );
    }

    /**
     * @inheritdoc IRiskManager
     */
    function calculateChargebackReserve(
        uint256 _amount,
        uint16 _reserveBps
    ) external pure override returns (uint256) {
        return _calculateChargebackReserve(_amount, _reserveBps);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function calculateRequiredReservation(
        uint256 _intentAmount,
        uint64 _maxIntentPeriod,
        PlatformRiskConfig calldata _config
    ) external pure override returns (
        uint256 maxGriefingBond,
        uint256 chargebackReserve,
        uint256 requiredReservation
    ) {
        return _calculateRequiredReservation(_intentAmount, _maxIntentPeriod, _config);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function hashChargebackAttestation(
        ChargebackAttestation calldata _attestation
    ) external view override returns (bytes32) {
        return _hashTypedDataV4(_hashChargebackAttestation(_attestation));
    }

    /* ============ Internal Lifecycle Accounting ============ */

    /**
     * @dev Applies one cancellation using a trustworthy liquidity-unlock timestamp. Effects are written
     *      before vault interactions; any vault failure reverts the complete callback and leaves the
     *      orchestrator's reconciliation record as the recovery path.
     */
    function _cancelPosition(bytes32 _intentHash, uint64 _cancelledAt) internal {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_intentHash, position.status);
        }

        (uint256 penalty, uint256 effectiveElapsed) = _calculateGriefingPenalty(
            position.bondedAmount,
            position.createdAt,
            _cancelledAt,
            position.maxIntentPeriod,
            position.griefingCliff,
            position.griefingPenaltyBpsPerHour
        );
        uint256 releasedReservation = position.reservedAmount - penalty;

        position.status = PositionStatus.CANCELLED;
        position.cancelledAt = _cancelledAt;
        position.reservedAmount = 0;
        position.slashedAmount = penalty;

        if (position.initialReservation != 0) {
            if (penalty != 0) stakeVault.slashReservation(_intentHash, position.lp, penalty);
            if (releasedReservation != 0) stakeVault.releaseReservation(_intentHash);
        }
        if (position.mode == RiskMode.DEFERRED_PAYOUT) {
            stakeVault.releaseDeferredStakeAuthorization(_intentHash);
        }

        emit GriefingPenaltyCharged(
            _intentHash,
            position.stakeOwner,
            position.lp,
            penalty,
            effectiveElapsed
        );
        emit RiskPositionCancelled(
            _intentHash,
            position.stakeOwner,
            position.lp,
            _cancelledAt,
            penalty,
            releasedReservation
        );
    }

    /**
     * @dev Transitions a pending position at settlement. Griefing liability disappears without penalty.
     *      Stake-backed coverage is resized against the gross release and consumes no funds. Deferred
     *      settlement transfers gross into fully reserved taker stake and keeps fee claims contingent.
     */
    function _settlePosition(
        bytes32 _intentHash,
        IERC20 _token,
        uint256 _grossAmount,
        uint256 _executableAmount,
        uint64 _settledAt,
        bool _isManualRelease,
        FeeAllocation[] calldata _feeAllocations
    ) internal {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_intentHash, position.status);
        }

        uint256 pendingReservation = position.reservedAmount;
        position.grossReleasedAmount = _grossAmount;
        position.executableAmount = _executableAmount;
        position.settledAt = _settledAt;
        position.isManualRelease = _isManualRelease;

        if (position.chargebackReserveBps == 0) {
            position.status = PositionStatus.RELEASED;
            position.reservedAmount = 0;
            if (pendingReservation != 0) stakeVault.releaseReservation(_intentHash);

            emit RiskPositionSettled(
                _intentHash,
                position.stakeOwner,
                position.lp,
                position.mode,
                _grossAmount,
                _executableAmount,
                0,
                pendingReservation,
                _settledAt,
                0,
                _isManualRelease
            );
            return;
        }

        uint64 coverageDeadline = _toTimestamp(uint256(_settledAt) + position.riskWindow);
        position.status = PositionStatus.SETTLED;
        position.coverageDeadline = coverageDeadline;

        uint256 chargebackCoverage;
        uint256 releasedReservation;
        if (position.mode == RiskMode.STAKE_BACKED) {
            chargebackCoverage = _calculateChargebackReserve(
                _grossAmount,
                position.chargebackReserveBps
            );
            releasedReservation = pendingReservation - chargebackCoverage;
            position.reservedAmount = chargebackCoverage;
            position.coveredAmount = chargebackCoverage;
            stakeVault.updateReservation(_intentHash, chargebackCoverage, coverageDeadline);
        } else if (position.mode == RiskMode.DEFERRED_PAYOUT) {
            // Admission already enforces this before fiat payment; retain the settlement check as
            // defense-in-depth against corrupted or non-canonical orchestrator state.
            if (position.payoutRecipient != position.taker) {
                revert DeferredStakeRecipientMismatch(position.taker, position.payoutRecipient);
            }
            chargebackCoverage = _calculateChargebackReserve(
                _grossAmount,
                position.chargebackReserveBps
            );
            if (chargebackCoverage != _grossAmount) {
                revert IncompleteChargebackCoverage(chargebackCoverage, _grossAmount);
            }
            releasedReservation = pendingReservation;
            if (pendingReservation != 0) stakeVault.releaseReservation(_intentHash);

            uint256 vaultBalanceBefore = _token.balanceOf(address(stakeVault));
            _token.safeTransferFrom(msg.sender, address(stakeVault), _grossAmount);
            uint256 vaultBalanceAfter = _token.balanceOf(address(stakeVault));
            uint256 receivedAmount = vaultBalanceAfter > vaultBalanceBefore
                ? vaultBalanceAfter - vaultBalanceBefore
                : 0;
            if (receivedAmount != _grossAmount) {
                revert DeferredStakeTransferMismatch(_grossAmount, receivedAmount);
            }

            position.reservedAmount = chargebackCoverage;
            position.coveredAmount = chargebackCoverage;
            position.deferredStakeAmount = _grossAmount;
            position.deferredFeeAmount = _grossAmount - _executableAmount;
            stakeVault.recordDeferredStake(
                _intentHash,
                position.taker,
                _grossAmount,
                coverageDeadline,
                _feeAllocations
            );
            emit DeferredSettlementFunded(
                _intentHash,
                position.taker,
                _grossAmount,
                _executableAmount,
                position.deferredFeeAmount,
                chargebackCoverage,
                coverageDeadline
            );
        } else {
            revert PositionModeMismatch(_intentHash, position.mode);
        }

        emit RiskPositionSettled(
            _intentHash,
            position.stakeOwner,
            position.lp,
            position.mode,
            _grossAmount,
            _executableAmount,
            chargebackCoverage,
            releasedReservation,
            _settledAt,
            coverageDeadline,
            _isManualRelease
        );
    }

    /* ============ Internal Validation ============ */

    /** @dev Enforces platform rules that do not depend on an Escrow's mutable intent period. */
    function _validatePlatformConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) internal pure {
        if (_paymentMethod == bytes32(0)) revert InvalidPlatformConfig(_paymentMethod);
        if (_config.chargeback.reserveBps > BPS_DENOMINATOR) revert InvalidPlatformConfig(_paymentMethod);

        if (_config.chargeback.chargebackable) {
            if (
                _config.chargeback.reserveBps != BPS_DENOMINATOR
                    || _config.chargeback.riskWindow == 0
                    || _config.chargeback.riskWindow > MAX_RISK_WINDOW
            ) {
                revert InvalidPlatformConfig(_paymentMethod);
            }
            if (_config.griefing.baseUnbondedAmount != 0) revert InvalidPlatformConfig(_paymentMethod);
        } else if (_config.chargeback.reserveBps != 0 || _config.chargeback.deferredPayoutEnabled) {
            revert InvalidPlatformConfig(_paymentMethod);
        }
    }

    /**
     * @dev Enforces cliff and maximum-liability constraints against the exact Escrow period that will
     *      be snapshotted. The rate check is amount-independent because both sides scale linearly in A.
     */
    function _validatePositionPolicy(
        bytes32 _paymentMethod,
        uint64 _maxIntentPeriod,
        GriefingConfig memory _config
    ) internal pure {
        if (_maxIntentPeriod == 0 || _config.griefingCliff >= _maxIntentPeriod) {
            revert InvalidPositionPolicy(_paymentMethod, _config.griefingCliff, _maxIntentPeriod);
        }
        uint256 maximumRateNumerator =
            uint256(_config.griefingPenaltyBpsPerHour) * (_maxIntentPeriod - _config.griefingCliff);
        if (maximumRateNumerator > GRIEFING_DENOMINATOR) {
            revert GriefingPenaltyExceedsIntentAmount(_paymentMethod);
        }
    }

    /** @dev Binds every risk amount to StakeVault's immutable accounting token before admission. */
    function _validateIntentToken(IERC20 _intentToken) internal view {
        address expectedToken = address(stakeVault.stakeToken());
        if (address(_intentToken) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(_intentToken));
        }
    }

    /**
     * @dev Binds signed dispute details to settlement state and the half-open coverage window.
     *      Proof-based fulfillment additionally requires the canonical payment-nullifier binding.
     *      Manual release has no payment-verifier call, so its dedicated chargeback witnesses are
     *      the binding authority: their EIP-712 signature already commits to this exact intent hash
     *      and data hash, while the dispute nullifier remains globally single-use.
     */
    function _validateAttestation(
        ChargebackAttestation calldata _attestation,
        RiskPosition storage _position
    ) internal view returns (ChargebackDetails memory details, bytes32 nullifier) {
        if (_attestation.intentHash == bytes32(0)) revert InvalidAttestation();
        if (keccak256(_attestation.data) != _attestation.dataHash) revert InvalidAttestation();
        if (block.timestamp >= _position.coverageDeadline) {
            revert ChargebackWindowClosed(_position.coverageDeadline, uint64(block.timestamp));
        }

        details = abi.decode(_attestation.data, (ChargebackDetails));
        if (details.paymentMethod != _position.paymentMethod) revert InvalidAttestation();
        if (details.originalPaymentId == bytes32(0)) revert InvalidAttestation();
        if (details.disputeId == bytes32(0)) revert InvalidAttestation();
        if (details.paymentAmount == 0 || details.paymentCurrency == bytes32(0)) revert InvalidAttestation();
        if (!_position.isManualRelease) {
            bytes32 paymentNullifier = keccak256(
                abi.encodePacked(details.paymentMethod, details.originalPaymentId)
            );
            if (
                nullifierRegistry.intentHashByNullifier(paymentNullifier) != _attestation.intentHash
                    || nullifierRegistry.nullifierByIntentHash(_attestation.intentHash) != paymentNullifier
            ) revert InvalidPaymentBinding(_attestation.intentHash, paymentNullifier);
        }

        nullifier = keccak256(abi.encodePacked(details.paymentMethod, details.disputeId));
        if (usedChargebackNullifiers[nullifier]) revert ChargebackEvidenceUsed(nullifier);
    }

    /* ============ Internal Formula Helpers ============ */

    /** @dev Returns the reusable base-subtracted amount exposed to the griefing curve. */
    function _calculateBondedAmount(
        uint256 _amount,
        uint256 _baseUnbondedAmount
    ) internal pure returns (uint256) {
        return _amount > _baseUnbondedAmount ? _amount - _baseUnbondedAmount : 0;
    }

    /** @dev Implements ceil(B * s * (T - C) / (10_000 * 1 hour)) without intermediate overflow. */
    function _calculateMaxGriefingBond(
        uint256 _bondedAmount,
        uint64 _maxIntentPeriod,
        uint64 _griefingCliff,
        uint32 _griefingPenaltyBpsPerHour
    ) internal pure returns (uint256) {
        if (_griefingPenaltyBpsPerHour == 0 || _maxIntentPeriod <= _griefingCliff) return 0;
        uint256 rateNumerator =
            uint256(_griefingPenaltyBpsPerHour) * (_maxIntentPeriod - _griefingCliff);
        return Math.mulDiv(_bondedAmount, rateNumerator, GRIEFING_DENOMINATOR, Math.Rounding.Up);
    }

    /** @dev Implements the capped time-linear cancellation formula with exact upward rounding. */
    function _calculateGriefingPenalty(
        uint256 _bondedAmount,
        uint64 _createdAt,
        uint64 _cancelledAt,
        uint64 _maxIntentPeriod,
        uint64 _griefingCliff,
        uint32 _griefingPenaltyBpsPerHour
    ) internal pure returns (uint256 penalty, uint256 effectiveElapsed) {
        if (_cancelledAt <= _createdAt) return (0, 0);
        effectiveElapsed = _min(uint256(_cancelledAt - _createdAt), _maxIntentPeriod);
        if (_griefingPenaltyBpsPerHour == 0 || effectiveElapsed <= _griefingCliff) {
            return (0, effectiveElapsed);
        }
        uint256 chargeableTime = effectiveElapsed - _griefingCliff;
        uint256 rateNumerator = uint256(_griefingPenaltyBpsPerHour) * chargeableTime;
        penalty = Math.mulDiv(_bondedAmount, rateNumerator, GRIEFING_DENOMINATOR, Math.Rounding.Up);
    }

    /** @dev Implements ceil(A * r / 10_000) with full-precision multiplication. */
    function _calculateChargebackReserve(uint256 _amount, uint16 _reserveBps) internal pure returns (uint256) {
        if (_reserveBps == 0) return 0;
        return Math.mulDiv(_amount, _reserveBps, BPS_DENOMINATOR, Math.Rounding.Up);
    }

    /** @dev Computes both mutually exclusive liabilities and reserves their maximum. */
    function _calculateRequiredReservation(
        uint256 _intentAmount,
        uint64 _maxIntentPeriod,
        PlatformRiskConfig memory _config
    ) internal pure returns (
        uint256 maxGriefingBond,
        uint256 chargebackReserve,
        uint256 requiredReservation
    ) {
        maxGriefingBond = _calculateMaxGriefingBond(
            _calculateBondedAmount(_intentAmount, _config.griefing.baseUnbondedAmount),
            _maxIntentPeriod,
            _config.griefing.griefingCliff,
            _config.griefing.griefingPenaltyBpsPerHour
        );
        chargebackReserve = _calculateChargebackReserve(_intentAmount, _config.chargeback.reserveBps);
        requiredReservation = _max(maxGriefingBond, chargebackReserve);
    }

    /** @dev Produces the EIP-712 struct hash for a chargeback attestation. */
    function _hashChargebackAttestation(
        ChargebackAttestation calldata _attestation
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHARGEBACK_ATTESTATION_TYPEHASH,
                _attestation.intentHash,
                _attestation.dataHash
            )
        );
    }

    /** @dev Narrows a duration read from Escrow after rejecting unsafe values. */
    function _toUint64(uint256 _value) internal pure returns (uint64) {
        if (_value > type(uint64).max) revert TimestampOverflow(_value);
        return uint64(_value);
    }

    /** @dev Narrows an absolute timestamp after rejecting unsafe values. */
    function _toTimestamp(uint256 _timestamp) internal pure returns (uint64) {
        if (_timestamp > type(uint64).max) revert TimestampOverflow(_timestamp);
        return uint64(_timestamp);
    }

    /** @dev Small branch helpers keep formula code explicit and auditable. */
    function _min(uint256 _left, uint256 _right) internal pure returns (uint256) {
        return _left < _right ? _left : _right;
    }

    /** @dev Small branch helpers keep formula code explicit and auditable. */
    function _max(uint256 _left, uint256 _right) internal pure returns (uint256) {
        return _left > _right ? _left : _right;
    }
}
