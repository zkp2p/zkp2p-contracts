// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAttestationVerifier } from "./interfaces/IAttestationVerifier.sol";
import { IEscrowV2 } from "./interfaces/IEscrowV2.sol";
import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { IOrchestratorV3 } from "./interfaces/IOrchestratorV3.sol";
import {
    IPaymentEvidenceVerifier,
    IOrchestratorPaymentVerifier
} from "./interfaces/IPaymentEvidenceVerifier.sol";
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
 *        maxGriefingBond = ceil(A * s * (T - C) / (10_000 * 1 hour))
 *        chargebackReserve = ceil(A * r / 10_000)
 *        initialReservation = max(maxGriefingBond, chargebackReserve)
 *
 *      where A is intent amount, s is penalty basis points per hour, T is the Escrow's snapshotted
 *      maximum intent period, C is the griefing cliff, and r is the chargeback reserve ratio.
 *
 * @dev CANCELLATION CURVE
 *      At cancellation, elapsed time is capped at T so an intent-guardian extension cannot increase
 *      taker liability. The charged penalty is:
 *
 *        effectiveElapsed = min(cancelledAt - createdAt, T)
 *        chargeableTime = max(effectiveElapsed - C, 0)
 *        penalty = ceil(A * s * chargeableTime / (10_000 * 1 hour))
 *
 *      Rounding is always upward. Every cancellation strictly after the cliff therefore pays at
 *      least one smallest token unit whenever the slope and amount are nonzero.
 *
 * @dev LIFECYCLE
 *      - Eligible free intents consume one lifetime allowance, reserve no stake, and are never slashed.
 *      - Bonded pending intents reserve stake once using the maximum formula above.
 *      - Cancellation slashes only the accrued griefing penalty and releases every unused unit.
 *      - Non-chargebackable settlement releases the full pending reservation immediately.
 *      - Chargebackable settlement resizes stake coverage to the exact released amount and starts the
 *        snapshotted coverage window.
 *      - Deferred payout is an explicit exception: pending stake covers only griefing, while settled
 *        proceeds held in StakeVault replace chargeback stake coverage.
 *      - Maturity releases remaining stake coverage; valid chargebacks can consume coverage partially.
 *
 * @dev SECURITY INVARIANTS AND RATIONALE
 *      1. Mutable platform and Escrow policy is snapshotted at admission; governance cannot rewrite
 *         existing liabilities.
 *      2. All positions for one stake owner share StakeVault.freeStake, so reservations compose across
 *         takers and platforms without a protocol-wide exposure gate.
 *      3. Free allowances are keyed by stake owner and platform, consumed before admission completes,
 *         and never restored after a terminal outcome. Transaction reverts restore the increment.
 *      4. Terminal callbacks are intentionally fail-open in OrchestratorV3 for liquidity liveness.
 *         Failed cancellations retain the full reservation and use the orchestrator-recorded unlock
 *         timestamp during permissionless reconciliation, preventing delay-based overcharging and
 *         callback failure from escaping liability.
 *      5. Chargeback compensation cannot exceed remaining snapshotted coverage. Uncovered losses and
 *         claims after maturity remain the LP's risk by design.
 *      6. This contract never holds tokens. StakeVault is the sole accounting and custody boundary.
 *      7. Escrow intent amounts and StakeVault liabilities must use the same immutable token, otherwise
 *         raw units, griefing penalties, free limits, and chargeback ratios would have no shared meaning.
 *      8. Deferred proceeds must cover the complete configured reserve after fees. A shortfall fails
 *         settlement rather than silently advertising less protection than governance configured.
 */
contract RiskManager is IRiskManager, Ownable, ReentrancyGuard, EIP712 {
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

    /// @notice Minimal EIP-712 type hash; chain and manager binding live in the EIP-712 domain.
    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH = keccak256(
        "ChargebackAttestation(bytes32 intentHash,bytes32 dataHash)"
    );

    /* ============ Immutable Dependencies ============ */

    /// @notice Canonical source of intent admission, settlement, and failed-callback timestamps.
    IOrchestratorV3 public immutable override orchestrator;

    /// @notice Custody and portfolio-accounting boundary for stake and deferred proceeds.
    IStakeVault public immutable override stakeVault;

    /* ============ Mutable Governance State ============ */

    /// @notice Dedicated verifier that authenticates typed chargeback attestations.
    /// @dev Deployments must use credentials independent from payment-attestation witnesses.
    IAttestationVerifier public attestationVerifier;

    /// @notice Canonical post-intent hook used only by deferred-payout positions.
    address public deferredPayoutHook;

    /// @notice Emergency admission switch; terminal accounting remains available while paused.
    bool public admissionPaused;

    /* ============ Position State ============ */

    /// @dev Mutable policy for future positions only. Every admitted position snapshots its terms.
    mapping(bytes32 => PlatformRiskConfig) internal platformRiskConfigs;

    /// @dev Complete per-intent policy snapshot and lifecycle accounting.
    mapping(bytes32 => RiskPosition) internal riskPositions;

    /// @inheritdoc IRiskManager
    mapping(address => mapping(bytes32 => uint32)) public override freeTakesUsed;

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
     */
    constructor(
        address _owner,
        IOrchestratorV3 _orchestrator,
        IStakeVault _stakeVault,
        IAttestationVerifier _attestationVerifier
    ) Ownable() EIP712("ZKP2P RiskManager", "1") {
        if (
            _owner == address(0)
                || address(_orchestrator) == address(0)
                || address(_stakeVault) == address(0)
                || address(_attestationVerifier) == address(0)
        ) {
            revert ZeroAddress();
        }
        if (address(_attestationVerifier).code.length == 0) revert ZeroAddress();

        orchestrator = _orchestrator;
        stakeVault = _stakeVault;
        attestationVerifier = _attestationVerifier;
        transferOwnership(_owner);
    }

    /* ============ Orchestrator Lifecycle ============ */

    /**
     * @inheritdoc IIntentRiskHook
     * @dev Admission is fail-closed. This function resolves delegation, validates the current platform
     *      against the intent's Escrow period, snapshots every liability input, consumes a whole free
     *      allowance when eligible, and reserves shared portfolio stake before returning.
     */
    function onIntentCreated(bytes32 _intentHash)
        external
        override
        onlyOrchestrator
        nonReentrant
        returns (bool requiresPostIntentHook)
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

        (uint256 maxGriefingBond, uint256 chargebackReserve, uint256 requiredReservation) =
            _calculateRequiredReservation(intent.amount, maxIntentPeriod, config);

        bool consumedFreeTake = _isFreeTakeEligible(stakeOwner, intent, config);
        RiskMode mode;
        uint256 initialReservation;

        if (consumedFreeTake) {
            mode = RiskMode.FREE;
            uint32 used = freeTakesUsed[stakeOwner][intent.paymentMethod] + 1;
            freeTakesUsed[stakeOwner][intent.paymentMethod] = used;
            emit FreeTakeConsumed(
                _intentHash,
                stakeOwner,
                intent.paymentMethod,
                intent.amount,
                used,
                config.griefing.freeTakeCount
            );
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
                if (deferredPayoutHook == address(0) || intent.postIntentHook != deferredPayoutHook) {
                    revert DeferredPayoutHookRequired(deferredPayoutHook, intent.postIntentHook);
                }
                mode = RiskMode.DEFERRED_PAYOUT;
                initialReservation = maxGriefingBond;
                requiresPostIntentHook = true;
            } else {
                revert InsufficientCollateral(stakeOwner, available, requiredReservation);
            }

            if (initialReservation != 0 && stakeVault.isExiting(stakeOwner)) {
                revert StakeOwnerExiting(intent.owner, stakeOwner);
            }
        }

        if (
            mode != RiskMode.DEFERRED_PAYOUT
                && deferredPayoutHook != address(0)
                && intent.postIntentHook == deferredPayoutHook
        ) {
            revert DeferredPayoutHookNotAllowed(deferredPayoutHook);
        }

        RiskPosition storage position = riskPositions[_intentHash];
        position.taker = intent.owner;
        position.stakeOwner = stakeOwner;
        position.lp = deposit.depositor;
        position.paymentMethod = intent.paymentMethod;
        position.mode = mode;
        position.status = PositionStatus.PENDING;
        position.consumedFreeTake = consumedFreeTake;
        position.deferredPayoutHook = mode == RiskMode.DEFERRED_PAYOUT ? deferredPayoutHook : address(0);
        if (config.chargeback.chargebackable) {
            address paymentVerifier = IOrchestratorPaymentVerifier(address(orchestrator))
                .paymentVerifierRegistry()
                .getVerifier(intent.paymentMethod);
            (bool exposesEvidence, bytes memory response) = paymentVerifier.staticcall(
                abi.encodeCall(
                    IPaymentEvidenceVerifier.getPaymentDetailsHash,
                    (address(orchestrator), bytes32(0))
                )
            );
            if (!exposesEvidence || response.length != 32) revert InvalidPaymentEvidence(_intentHash);
            position.paymentVerifier = paymentVerifier;
        }
        position.payoutRecipient = intent.to;
        position.chargebackReserveBps = config.chargeback.reserveBps;
        position.griefingPenaltyBpsPerHour = config.griefing.griefingPenaltyBpsPerHour;
        position.riskWindow = config.chargeback.riskWindow;
        position.createdAt = intent.createdAt;
        position.maxIntentPeriod = maxIntentPeriod;
        position.griefingCliff = config.griefing.griefingCliff;
        position.intentAmount = intent.amount;
        position.maxGriefingBond = maxGriefingBond;
        position.initialReservation = initialReservation;
        position.reservedAmount = initialReservation;

        if (initialReservation != 0) {
            stakeVault.reserveStake(stakeOwner, _intentHash, initialReservation, 0);
        }
        if (mode == RiskMode.DEFERRED_PAYOUT) {
            stakeVault.authorizeDeferredPayout(_intentHash, intent.to, 0);
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
     */
    function onIntentFulfilled(
        bytes32 _intentHash,
        uint256 _releasedAmount
    ) external override onlyOrchestrator nonReentrant {
        bytes32 paymentDetailsHash = _getPaymentDetailsHash(_intentHash);
        if (
            riskPositions[_intentHash].chargebackReserveBps != 0
                && paymentDetailsHash == bytes32(0)
        ) revert InvalidPaymentEvidence(_intentHash);
        _settlePosition(
            _intentHash,
            _releasedAmount,
            paymentDetailsHash,
            uint64(block.timestamp)
        );
    }

    /**
     * @inheritdoc IIntentRiskHook
     */
    function onIntentReleased(
        bytes32 _intentHash,
        uint256 _releasedAmount
    ) external override onlyOrchestrator nonReentrant {
        _settlePosition(
            _intentHash,
            _releasedAmount,
            bytes32(0),
            uint64(block.timestamp)
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
    function reconcileSettlement(bytes32 _intentHash) external override nonReentrant {
        _reconcileSettlement(_intentHash);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function reconcileSettlements(bytes32[] calldata _intentHashes) external override nonReentrant {
        if (_intentHashes.length == 0) revert EmptyBatch();
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _reconcileSettlement(_intentHashes[intentIndex]);
        }
    }

    /** @dev Reads and applies one failed cancellation record. */
    function _reconcileCancellation(bytes32 _intentHash) internal {
        uint64 cancelledAt = orchestrator.getIntentCancellation(_intentHash);
        if (cancelledAt == 0) revert CancellationNotRecorded(_intentHash);
        _cancelPosition(_intentHash, cancelledAt);
    }

    /** @dev Reads and applies one failed settlement record. */
    function _reconcileSettlement(bytes32 _intentHash) internal {
        (uint256 releasedAmount, uint64 settledAt) = orchestrator.getIntentSettlement(_intentHash);
        if (releasedAmount == 0 || settledAt == 0) revert SettlementNotRecorded(_intentHash);
        _settlePosition(
            _intentHash,
            releasedAmount,
            _getPaymentDetailsHash(_intentHash),
            settledAt
        );
    }

    /* ============ Deferred Payout ============ */

    /**
     * @inheritdoc IRiskManager
     * @dev The canonical hook transfers net proceeds into StakeVault before calling this function.
     *      Held proceeds must cover the complete configured reserve after fees; otherwise settlement
     *      fails closed instead of silently weakening coverage. Any excess remains the beneficiary's
     *      property but matures on the same deadline.
     */
    function registerDeferredPayout(
        bytes32 _intentHash,
        address _beneficiary,
        uint256 _amount
    ) external override nonReentrant {
        if (_amount == 0) revert ZeroAmount();

        RiskPosition storage position = riskPositions[_intentHash];
        if (msg.sender != position.deferredPayoutHook) revert UnauthorizedDeferredPayoutHook(msg.sender);
        if (position.mode != RiskMode.DEFERRED_PAYOUT) revert PositionModeMismatch(_intentHash, position.mode);
        if (position.status == PositionStatus.PENDING) _synchronizeSettlement(_intentHash);
        if (position.status != PositionStatus.SETTLED) revert PositionNotSettled(_intentHash, position.status);
        if (position.payoutRecipient != _beneficiary) revert IntentStateMismatch(_intentHash);
        if (position.deferredPayoutAmount != 0) revert DeferredPayoutAlreadyRegistered(_intentHash);
        if (_amount > position.releasedAmount) {
            revert DeferredPayoutExceedsReleasedAmount(_amount, position.releasedAmount);
        }

        uint256 expectedCoverage = _calculateChargebackReserve(
            position.releasedAmount,
            position.chargebackReserveBps
        );
        if (_amount < expectedCoverage) {
            revert InsufficientDeferredPayoutCoverage(_amount, expectedCoverage);
        }

        position.deferredPayoutAmount = _amount;
        position.reservedAmount = expectedCoverage;
        stakeVault.recordDeferredPayout(_intentHash, _beneficiary, _amount, position.coverageDeadline);

        emit DeferredPayoutRegistered(
            _intentHash,
            _beneficiary,
            _amount,
            expectedCoverage,
            position.coverageDeadline
        );
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

    /**
     * @dev Releases only remaining stake coverage. Deferred proceeds stay in StakeVault until their
     *      beneficiary withdraws them; marking the risk position released merely ends slashability.
     */
    function _releaseMaturedPosition(bytes32 _intentHash) internal {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status == PositionStatus.PENDING) _synchronizeSettlement(_intentHash);
        if (position.status != PositionStatus.SETTLED) revert PositionNotSettled(_intentHash, position.status);
        if (position.coverageDeadline == 0 || block.timestamp < position.coverageDeadline) {
            revert PositionNotMature(position.coverageDeadline, uint64(block.timestamp));
        }

        uint256 releasedCoverage = position.reservedAmount;
        position.status = PositionStatus.RELEASED;
        position.reservedAmount = 0;

        if (position.mode == RiskMode.STAKE_BACKED && releasedCoverage != 0) {
            stakeVault.releaseReservation(_intentHash);
        }

        emit RiskPositionReleased(_intentHash, position.stakeOwner, position.mode, releasedCoverage);
    }

    /**
     * @inheritdoc IRiskManager
     * @dev V1 is deliberately full-only: a valid attestation consumes the dispute nullifier and
     *      compensates exactly the gross released token amount derived from settlement state.
     */
    function submitChargeback(ChargebackAttestation calldata _attestation) external override nonReentrant {
        RiskPosition storage position = riskPositions[_attestation.intentHash];
        if (position.status == PositionStatus.PENDING) _synchronizeSettlement(_attestation.intentHash);
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

        uint256 compensatedAmount = position.releasedAmount;
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
            stakeVault.slashDeferredPayout(_attestation.intentHash, position.lp, compensatedAmount);
        }

        emit ChargebackSettled(
            _attestation.intentHash,
            position.stakeOwner,
            position.lp,
            position.mode,
            compensatedAmount,
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
            _config.griefing.freeTakeCount,
            _config.griefing.freeTakeAmount
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
    function setDeferredPayoutHook(address _hook) external override onlyOwner {
        if (_hook != address(0) && _hook.code.length == 0) revert ZeroAddress();
        address previousHook = deferredPayoutHook;
        deferredPayoutHook = _hook;
        emit DeferredPayoutHookUpdated(previousHook, _hook);
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
     * @dev Uses full-precision multiplication and upward rounding. Invalid `cliff >= period` inputs
     *      return zero here; platform admission separately rejects such a configuration.
     */
    function calculateMaxGriefingBond(
        uint256 _amount,
        uint64 _maxIntentPeriod,
        GriefingConfig calldata _config
    ) external pure override returns (uint256) {
        return _calculateMaxGriefingBond(
            _amount,
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
        uint256 _amount,
        uint64 _createdAt,
        uint64 _cancelledAt,
        uint64 _maxIntentPeriod,
        uint64 _griefingCliff,
        uint32 _griefingPenaltyBpsPerHour
    ) external pure override returns (uint256 penalty, uint256 effectiveElapsed) {
        return _calculateGriefingPenalty(
            _amount,
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
        uint256 _amount,
        uint64 _maxIntentPeriod,
        PlatformRiskConfig calldata _config
    ) external pure override returns (
        uint256 maxGriefingBond,
        uint256 chargebackReserve,
        uint256 requiredReservation
    ) {
        return _calculateRequiredReservation(_amount, _maxIntentPeriod, _config);
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

        uint256 penalty;
        uint256 effectiveElapsed;
        if (position.mode != RiskMode.FREE) {
            (penalty, effectiveElapsed) = _calculateGriefingPenalty(
                position.intentAmount,
                position.createdAt,
                _cancelledAt,
                position.maxIntentPeriod,
                position.griefingCliff,
                position.griefingPenaltyBpsPerHour
            );
        }
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
            stakeVault.releaseDeferredPayoutAuthorization(_intentHash);
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
     *      Stake-backed coverage is resized to the exact released amount; deferred coverage remains zero
     *      until the mandatory hook atomically registers transferred proceeds.
     */
    function _settlePosition(
        bytes32 _intentHash,
        uint256 _releasedAmount,
        bytes32 _paymentDetailsHash,
        uint64 _settledAt
    ) internal {
        if (_releasedAmount == 0) revert ZeroAmount();
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_intentHash, position.status);
        }

        uint256 pendingReservation = position.reservedAmount;
        position.releasedAmount = _releasedAmount;
        position.paymentDetailsHash = _paymentDetailsHash;
        position.settledAt = _settledAt;

        if (position.chargebackReserveBps == 0) {
            position.status = PositionStatus.RELEASED;
            position.reservedAmount = 0;
            if (pendingReservation != 0) stakeVault.releaseReservation(_intentHash);

            emit RiskPositionSettled(
                _intentHash,
                position.stakeOwner,
                position.lp,
                position.mode,
                _releasedAmount,
                0,
                pendingReservation,
                _settledAt,
                0
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
                _releasedAmount,
                position.chargebackReserveBps
            );
            releasedReservation = pendingReservation - chargebackCoverage;
            position.reservedAmount = chargebackCoverage;
            stakeVault.updateReservation(_intentHash, chargebackCoverage, coverageDeadline);
        } else if (position.mode == RiskMode.DEFERRED_PAYOUT) {
            releasedReservation = pendingReservation;
            position.reservedAmount = 0;
            if (pendingReservation != 0) stakeVault.releaseReservation(_intentHash);
        } else {
            revert PositionModeMismatch(_intentHash, position.mode);
        }

        emit RiskPositionSettled(
            _intentHash,
            position.stakeOwner,
            position.lp,
            position.mode,
            _releasedAmount,
            chargebackCoverage,
            releasedReservation,
            _settledAt,
            coverageDeadline
        );
    }

    /** @dev Applies a durable failed-settlement record only when the position remains pending. */
    function _synchronizeSettlement(bytes32 _intentHash) internal {
        (uint256 releasedAmount, uint64 settledAt) = orchestrator.getIntentSettlement(_intentHash);
        if (releasedAmount == 0) revert SettlementNotRecorded(_intentHash);
        if (settledAt == 0) revert SettlementNotRecorded(_intentHash);
        _settlePosition(
            _intentHash,
            releasedAmount,
            _getPaymentDetailsHash(_intentHash),
            settledAt
        );
    }

    /** @dev Reads evidence from the payment verifier snapshotted before funds were locked. */
    function _getPaymentDetailsHash(bytes32 _intentHash) internal view returns (bytes32) {
        address paymentVerifier = riskPositions[_intentHash].paymentVerifier;
        if (paymentVerifier == address(0)) return bytes32(0);
        return IPaymentEvidenceVerifier(paymentVerifier).getPaymentDetailsHash(
            address(orchestrator),
            _intentHash
        );
    }

    /* ============ Internal Validation ============ */

    /** @dev Enforces platform rules that do not depend on an Escrow's mutable intent period. */
    function _validatePlatformConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) internal pure {
        if (_paymentMethod == bytes32(0)) revert InvalidPlatformConfig(_paymentMethod);
        if (_config.chargeback.reserveBps > BPS_DENOMINATOR) revert InvalidPlatformConfig(_paymentMethod);

        bool hasFreeCount = _config.griefing.freeTakeCount != 0;
        bool hasFreeAmount = _config.griefing.freeTakeAmount != 0;
        if (hasFreeCount != hasFreeAmount) revert InvalidPlatformConfig(_paymentMethod);

        if (_config.chargeback.chargebackable) {
            if (
                _config.chargeback.reserveBps != BPS_DENOMINATOR
                    || _config.chargeback.riskWindow == 0
                    || _config.chargeback.riskWindow > MAX_RISK_WINDOW
            ) {
                revert InvalidPlatformConfig(_paymentMethod);
            }
            // The equality check above guarantees both free-take fields are either set or unset.
            if (hasFreeCount) revert InvalidPlatformConfig(_paymentMethod);
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

    /** @dev Returns true only for a whole, non-chargebackable intent within an unused lifetime allowance. */
    function _isFreeTakeEligible(
        address _stakeOwner,
        IOrchestratorV3.RiskIntentData memory _intent,
        PlatformRiskConfig memory _config
    ) internal view returns (bool) {
        return !_config.chargeback.chargebackable
            && _config.griefing.freeTakeCount != 0
            && _config.griefing.freeTakeAmount != 0
            && freeTakesUsed[_stakeOwner][_intent.paymentMethod] < _config.griefing.freeTakeCount
            && _intent.amount <= _config.griefing.freeTakeAmount;
    }

    /** @dev Binds signed dispute details to verified settlement state and the half-open coverage window. */
    function _validateAttestation(
        ChargebackAttestation calldata _attestation,
        RiskPosition storage _position
    ) internal view returns (ChargebackDetails memory details, bytes32 nullifier) {
        if (_attestation.intentHash == bytes32(0)) revert InvalidAttestation();
        if (keccak256(_attestation.data) != _attestation.dataHash) revert InvalidAttestation();
        if (_position.paymentDetailsHash == bytes32(0)) revert InvalidAttestation();
        if (block.timestamp >= _position.coverageDeadline) {
            revert ChargebackWindowClosed(_position.coverageDeadline, uint64(block.timestamp));
        }

        details = abi.decode(_attestation.data, (ChargebackDetails));
        if (details.paymentMethod != _position.paymentMethod) revert InvalidAttestation();
        if (details.originalPaymentId == bytes32(0)) revert InvalidAttestation();
        if (details.disputeId == bytes32(0)) revert InvalidAttestation();
        if (details.paymentAmount == 0 || details.paymentCurrency == bytes32(0)) revert InvalidAttestation();
        if (
            keccak256(abi.encode(
                details.paymentMethod,
                details.originalPaymentId,
                details.paymentAmount,
                details.paymentCurrency
            )) != _position.paymentDetailsHash
        ) revert InvalidAttestation();

        nullifier = keccak256(abi.encodePacked(details.paymentMethod, details.disputeId));
        if (usedChargebackNullifiers[nullifier]) revert ChargebackEvidenceUsed(nullifier);
    }

    /* ============ Internal Formula Helpers ============ */

    /** @dev Implements ceil(A * s * (T - C) / (10_000 * 1 hour)) without intermediate overflow. */
    function _calculateMaxGriefingBond(
        uint256 _amount,
        uint64 _maxIntentPeriod,
        uint64 _griefingCliff,
        uint32 _griefingPenaltyBpsPerHour
    ) internal pure returns (uint256) {
        if (_griefingPenaltyBpsPerHour == 0 || _maxIntentPeriod <= _griefingCliff) return 0;
        uint256 rateNumerator =
            uint256(_griefingPenaltyBpsPerHour) * (_maxIntentPeriod - _griefingCliff);
        return Math.mulDiv(_amount, rateNumerator, GRIEFING_DENOMINATOR, Math.Rounding.Up);
    }

    /** @dev Implements the capped time-linear cancellation formula with exact upward rounding. */
    function _calculateGriefingPenalty(
        uint256 _amount,
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
        penalty = Math.mulDiv(_amount, rateNumerator, GRIEFING_DENOMINATOR, Math.Rounding.Up);
    }

    /** @dev Implements ceil(A * r / 10_000) with full-precision multiplication. */
    function _calculateChargebackReserve(uint256 _amount, uint16 _reserveBps) internal pure returns (uint256) {
        if (_reserveBps == 0) return 0;
        return Math.mulDiv(_amount, _reserveBps, BPS_DENOMINATOR, Math.Rounding.Up);
    }

    /** @dev Computes both mutually exclusive liabilities and reserves their maximum. */
    function _calculateRequiredReservation(
        uint256 _amount,
        uint64 _maxIntentPeriod,
        PlatformRiskConfig memory _config
    ) internal pure returns (
        uint256 maxGriefingBond,
        uint256 chargebackReserve,
        uint256 requiredReservation
    ) {
        maxGriefingBond = _calculateMaxGriefingBond(
            _amount,
            _maxIntentPeriod,
            _config.griefing.griefingCliff,
            _config.griefing.griefingPenaltyBpsPerHour
        );
        chargebackReserve = _calculateChargebackReserve(_amount, _config.chargeback.reserveBps);
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
