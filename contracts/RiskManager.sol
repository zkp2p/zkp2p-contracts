// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";
import {IEscrowV2} from "./interfaces/IEscrowV2.sol";
import {IIntentRiskHook} from "./interfaces/IIntentRiskHook.sol";
import {INullifierRegistryV2} from "./interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV3} from "./interfaces/IOrchestratorV3.sol";
import {IRiskManager} from "./interfaces/IRiskManager.sol";
import {IStakeVault} from "./interfaces/IStakeVault.sol";

/**
 * @title RiskManager
 * @notice Applies intent-extension and chargeback policy to the generic StakeVault custody and accounting ledger.
 *
 * @dev ECONOMIC MODEL
 *      The Escrow's original intent period is free. A taker or its selected stake owner can purchase additional
 *      time by locking the maximum extension charge under a lock separate from chargeback coverage:
 *
 *        extensionLock = ceil(intentAmount * slope * purchasedTime / (10_000 * 1 hour))
 *        extensionFee  = ceil(intentAmount * slope * elapsedPurchasedTime / (10_000 * 1 hour))
 *
 *      The extension fee is paid to the LP when the intent reaches any terminal path. Any purchased time that was
 *      not used is unlocked back into the extension stake owner's free stake.
 *
 *      A chargebackable intent is admitted in one of two modes. STAKE_BACKED locks the full intent amount from the
 *      taker's selected stake owner. DEFERRED_PAYOUT admits the intent without an initial chargeback lock, then moves
 *      the full gross settlement into StakeVault as payout-recipient-owned stake. Both modes hold the full gross
 *      settlement amount until the snapshotted risk window ends or a valid chargeback awards it to the LP.
 *
 * @dev LIFECYCLE
 *      - Admission validates canonical intent and Escrow state, then snapshots all mutable risk-policy inputs.
 *      - Pending chargeback and extension locks use `NEVER_MATURES`; only this controller resolves pending exposure.
 *      - Settlement resolves the extension lock before creating or retiming post-settlement chargeback coverage.
 *      - Clean maturity unlocks stake-backed coverage. For deferred coverage, exact fee claims are created and the
 *        executable remainder becomes free stake owned by the payout recipient.
 *      - A valid chargeback resolves the complete coverage lock into one immediately claimable LP allocation and
 *        discards any contingent deferred-fee plan.
 *
 * @dev SECURITY INVARIANTS AND RATIONALE
 *      1. StakeVault owns custody and generic accounting only. This contract exclusively decides why stake is locked,
 *         when a lock resolves, and which beneficiaries receive claims.
 *      2. Mutable platform and Escrow policy is snapshotted at admission; later governance changes cannot rewrite an
 *         existing position's liabilities.
 *      3. All takers selecting one stake owner share that owner's `freeStake`. Locks compose additively, so delegation
 *         cannot replace the stake owner's funds or prevent either party from adding independent stake.
 *      4. Extension and chargeback exposure use distinct lock identifiers. Resolving one cannot resize, mature, or
 *         distribute the other.
 *      5. Token-bearing settlement is fail-closed. Cancellation may fail open in OrchestratorV3 for liquidity liveness;
 *         reconciliation uses the durable original cancellation timestamp so delay cannot increase extension fees.
 *      6. Chargeback compensation is full-only: coverage must equal the gross Escrow release in both backed modes.
 *      7. This contract receives a temporary allowance but never receives settlement tokens. For deferred settlement
 *         it spends that allowance by transferring proceeds directly from OrchestratorV3 to StakeVault, the sole
 *         custody boundary; balance-delta validation rejects fee-on-transfer shortfalls.
 *      8. Escrow intent amounts and StakeVault liabilities use the same immutable token so raw accounting units match.
 *      9. Proof-based chargebacks must bind the supplied payment ID to the exact intent in both registry directions.
 *         Manual releases instead rely on an EIP-712 witness signature binding evidence to the exact intent, while
 *         every payment-method-scoped dispute identifier remains single-use.
 */
contract RiskManager is IRiskManager, Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /* ============ Constants ============ */

    /// @notice Basis-point denominator used by extension pricing.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Seconds per hour used to convert the configured hourly extension slope.
    uint256 public constant SECONDS_PER_HOUR = 1 hours;

    /// @notice Combined denominator for the time-linear extension formula.
    uint256 public constant EXTENSION_DENOMINATOR = BPS_DENOMINATOR * SECONDS_PER_HOUR;

    /// @notice Maximum time from original intent creation through final extended expiry.
    uint64 public constant MAX_TOTAL_INTENT_LIFETIME = 5 days;

    /// @notice Operational ceiling that keeps settlement deadlines safely representable as `uint64`.
    uint64 public constant MAX_RISK_WINDOW = 365 days;

    /// @notice Maturity used for pending exposure that only a RiskManager terminal transition may resolve.
    uint64 public constant NEVER_MATURES = type(uint64).max;

    /// @notice Protocol fee, up to ten referral fees, and one manager fee.
    uint256 public constant MAX_FEE_ALLOCATIONS = 12;

    /// @notice EIP-712 type hash; chain and manager binding are supplied by the domain separator.
    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH =
        keccak256("ChargebackAttestation(bytes32 intentHash,bytes32 dataHash)");

    /// @notice Namespace separating extension lock IDs from intent-hash chargeback lock IDs.
    bytes32 public constant EXTENSION_LOCK_NAMESPACE = keccak256("ZKP2P_INTENT_EXTENSION");

    /* ============ Immutable Dependencies ============ */

    /// @notice Canonical source of intent admission, settlement, and failed-cancellation timestamps.
    IOrchestratorV3 public immutable override orchestrator;

    /// @notice Policy-agnostic custody, delegation, lock, and claim ledger.
    IStakeVault public immutable override stakeVault;

    /// @notice Canonical source binding each verified payment nullifier to its fulfilled intent.
    INullifierRegistryV2 public immutable override nullifierRegistry;

    /* ============ Mutable Governance State ============ */

    /// @notice Verifier responsible for authenticating typed chargeback attestations.
    /// @dev Deployments should use witness credentials independent from payment-attestation credentials.
    IAttestationVerifier public override attestationVerifier;

    /// @notice Emergency switch for new admissions and extensions; terminal accounting remains available.
    bool public override riskTakingPaused;

    /* ============ Position State ============ */

    /// @dev Mutable policy for future positions only. Every admitted position snapshots its applicable values.
    mapping(bytes32 => PlatformRiskConfig) internal platformRiskConfigs;

    /// @dev Complete per-intent policy snapshot and lifecycle accounting.
    mapping(bytes32 => RiskPosition) internal riskPositions;

    /// @dev Contingent fee allocations retained only while a deferred-payout lock can still be charged back.
    mapping(bytes32 => FeeAllocation[]) internal deferredFeeAllocations;

    /// @notice Global replay protection for payment-method-scoped dispute identifiers.
    mapping(bytes32 => bool) public override usedChargebackNullifiers;

    /* ============ Modifiers ============ */

    /**
     * @dev Restricts canonical intent lifecycle callbacks to the immutable orchestrator.
     */
    modifier onlyOrchestrator() {
        if (msg.sender != address(orchestrator)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Creates a replaceable policy controller for one immutable orchestrator and StakeVault.
     * @dev Every dependency must be a deployed contract. Ownership is transferred directly to `_owner`; future
     *      ownership changes use Ownable2Step. The vault separately enforces its delayed controller handover.
     * @param _owner Governance owner allowed to configure future risk policy.
     * @param _orchestrator Canonical intent lifecycle source.
     * @param _stakeVault Policy-agnostic custody and accounting ledger controlled by this contract after handover.
     * @param _attestationVerifier Initial chargeback evidence verifier.
     * @param _nullifierRegistry Canonical registry binding verified payments to fulfilled intents.
     */
    constructor(
        address _owner,
        IOrchestratorV3 _orchestrator,
        IStakeVault _stakeVault,
        IAttestationVerifier _attestationVerifier,
        INullifierRegistryV2 _nullifierRegistry
    ) EIP712("ZKP2P RiskManager", "1") {
        if (
            _owner == address(0) || address(_orchestrator) == address(0) || address(_stakeVault) == address(0)
                || address(_attestationVerifier) == address(0) || address(_nullifierRegistry) == address(0)
        ) revert ZeroAddress();
        if (
            address(_orchestrator).code.length == 0 || address(_stakeVault).code.length == 0
                || address(_attestationVerifier).code.length == 0 || address(_nullifierRegistry).code.length == 0
        ) revert ZeroAddress();

        orchestrator = _orchestrator;
        stakeVault = _stakeVault;
        nullifierRegistry = _nullifierRegistry;
        attestationVerifier = _attestationVerifier;
        _transferOwnership(_owner);
    }

    /* ============ Orchestrator Lifecycle ============ */

    /**
     * @notice Validates and records a newly created intent, reserving full chargeback coverage when required.
     * @dev ORCHESTRATOR ONLY. Admission is fail-closed and blocked while risk taking is paused. The function:
     *      1. Reads canonical intent and deposit state and verifies this contract is the deposit's intent guardian.
     *      2. Snapshots payment-method policy, original expiry, parties, amount, and the current delegated stake owner.
     *      3. Selects UNBONDED, STAKE_BACKED, or DEFERRED_PAYOUT mode from policy and available free stake.
     *      4. For STAKE_BACKED mode, creates an intent-hash lock for the full intent amount with no autonomous maturity.
     *
     *      Deferred mode records the payout recipient as stake owner and defers funding until settlement. It rejects
     *      post-intent hooks because deferred settlement consumes the full gross release instead of executing the
     *      orchestrator's ordinary payout path.
     * @param _intentHash Identifier of the intent readable from the calling orchestrator.
     */
    function onIntentCreated(bytes32 _intentHash) external override onlyOrchestrator nonReentrant {
        if (riskTakingPaused) revert RiskTakingPaused();
        if (_intentHash == bytes32(0)) revert IntentStateMismatch(_intentHash);
        if (riskPositions[_intentHash].status != PositionStatus.NONE) revert PositionAlreadyExists(_intentHash);

        IOrchestratorV3.RiskIntentData memory intent = orchestrator.getRiskIntent(_intentHash);
        if (intent.owner == address(0) || intent.to == address(0) || intent.createdAt == 0 || intent.amount == 0) {
            revert IntentStateMismatch(_intentHash);
        }

        PlatformRiskConfig memory config = platformRiskConfigs[intent.paymentMethod];
        if (!config.enabled) revert PlatformDisabled(intent.paymentMethod);

        IEscrowV2 escrow = IEscrowV2(intent.escrow);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(intent.depositId);
        _validateIntentToken(deposit.token);
        if (deposit.intentGuardian != address(this)) {
            revert InvalidIntentGuardian(address(this), deposit.intentGuardian);
        }

        address stakeOwner = stakeVault.stakeOwnerOf(intent.owner);
        RiskMode mode = RiskMode.UNBONDED;
        uint256 coverageAmount;

        if (config.chargeback.chargebackable) {
            uint256 available = stakeVault.freeStake(stakeOwner);
            if (available >= intent.amount) {
                mode = RiskMode.STAKE_BACKED;
                coverageAmount = intent.amount;
            } else if (config.chargeback.deferredPayoutEnabled) {
                address postIntentHook = address(orchestrator.getIntent(_intentHash).postIntentHook);
                if (postIntentHook != address(0)) {
                    revert DeferredPostIntentHookUnsupported(_intentHash, postIntentHook);
                }
                mode = RiskMode.DEFERRED_PAYOUT;
                stakeOwner = intent.to;
            } else {
                revert InsufficientCollateral(stakeOwner, available, intent.amount);
            }
        }

        uint64 baseIntentExpiry = _toTimestamp(uint256(intent.createdAt) + escrow.intentExpirationPeriod());
        RiskPosition storage position = riskPositions[_intentHash];
        position.taker = intent.owner;
        position.stakeOwner = stakeOwner;
        position.lp = deposit.depositor;
        position.payoutRecipient = intent.to;
        position.paymentMethod = intent.paymentMethod;
        position.mode = mode;
        position.status = PositionStatus.PENDING;
        position.extensionPenaltyBpsPerHour = config.extensionPenaltyBpsPerHour;
        position.riskWindow = config.chargeback.riskWindow;
        position.createdAt = intent.createdAt;
        position.baseIntentExpiry = baseIntentExpiry;
        position.intentAmount = intent.amount;
        position.coverageAmount = coverageAmount;

        if (coverageAmount != 0) {
            stakeVault.lockStake(stakeOwner, _intentHash, coverageAmount, NEVER_MATURES);
        }

        emit RiskPositionCreated(
            _intentHash,
            stakeOwner,
            deposit.depositor,
            intent.owner,
            intent.paymentMethod,
            mode,
            intent.amount,
            coverageAmount,
            baseIntentExpiry,
            config.chargeback.riskWindow,
            config.extensionPenaltyBpsPerHour
        );
    }

    /**
     * @notice Resolves risk accounting for an intent cancelled or expired by the orchestrator.
     * @dev ORCHESTRATOR ONLY. Charges elapsed purchased extension time, unlocks any pending stake-backed coverage,
     *      and transitions the position from PENDING to CANCELLED. The callback timestamp is captured once and used
     *      for extension pricing. If this callback fails open in OrchestratorV3, anyone may later execute the same
     *      transition through `reconcileCancellation` using the orchestrator's persisted cancellation timestamp.
     * @param _intentHash Identifier of the intent being cancelled.
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator nonReentrant {
        _cancelPosition(_intentHash, _currentTimestamp());
    }

    /**
     * @notice Atomically resolves extension and chargeback policy before settlement funds are distributed.
     * @dev ORCHESTRATOR ONLY. The supplied token, recipient, gross amount, executable amount, and fee allocations must
     *      exactly describe the canonical settlement. Extension exposure is resolved first on every settlement path.
     *
     *      UNBONDED positions become RELEASED and consume no tokens. STAKE_BACKED positions resize their existing
     *      intent lock to the gross released amount and give it the chargeback deadline. DEFERRED_PAYOUT positions
     *      transfer the full gross amount directly from the orchestrator into StakeVault, create an equally sized lock,
     *      and retain the exact fee plan for clean maturity. Thus the hook consumes either zero tokens or exactly the
     *      gross settlement amount, matching OrchestratorV3's settlement invariant.
     * @param _context Token, parties, amounts, fee plan, intent hash, and manual-release flag for this settlement.
     */
    function settleIntent(RiskSettlementContext calldata _context) external override onlyOrchestrator nonReentrant {
        RiskPosition storage position = riskPositions[_context.intentHash];
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_context.intentHash, position.status);
        }
        _validateSettlementContext(_context, position);

        _resolveExtension(_context.intentHash, position, _currentTimestamp());

        position.grossReleasedAmount = _context.grossAmount;
        position.executableAmount = _context.executableAmount;
        position.isManualRelease = _context.isManualRelease;

        if (position.mode == RiskMode.UNBONDED) {
            position.status = PositionStatus.RELEASED;
            emit RiskPositionSettled(
                _context.intentHash,
                position.stakeOwner,
                position.lp,
                position.mode,
                _context.grossAmount,
                _context.executableAmount,
                0,
                0,
                _context.isManualRelease
            );
            return;
        }

        uint64 coverageDeadline = _toTimestamp(block.timestamp + position.riskWindow);
        position.status = PositionStatus.SETTLED;
        position.coverageDeadline = coverageDeadline;
        position.coverageAmount = _context.grossAmount;

        if (position.mode == RiskMode.STAKE_BACKED) {
            stakeVault.resizeLock(_context.intentHash, _context.grossAmount, coverageDeadline);
        } else if (position.mode == RiskMode.DEFERRED_PAYOUT) {
            _fundDeferredLock(_context, position, coverageDeadline);
        } else {
            revert PositionModeMismatch(_context.intentHash, position.mode);
        }

        emit RiskPositionSettled(
            _context.intentHash,
            position.stakeOwner,
            position.lp,
            position.mode,
            _context.grossAmount,
            _context.executableAmount,
            _context.grossAmount,
            coverageDeadline,
            _context.isManualRelease
        );
    }

    /* ============ Intent Extensions ============ */

    /**
     * @notice Purchases additional lifetime for a pending intent by locking the maximum resulting extension fee.
     * @dev Callable by the taker or the stake owner snapshotted by the first extension. On the first extension, the
     *      taker's current selected stake owner is captured and cannot change for this intent. The taker may fund later
     *      extensions only while that delegation remains current; the captured stake owner may always add exposure from
     *      its own stake. The extension lock is distinct from the intent-hash chargeback lock and never self-matures.
     *
     *      Cost is recalculated over total purchased time and only the incremental difference is locked. The Escrow
     *      expiry extension and local accounting update are atomic, and the final expiry cannot exceed five days from
     *      original intent creation.
     * @param _intentHash Identifier of the pending intent to extend.
     * @param _additionalTime Number of seconds to add to the current Escrow expiry.
     */
    function extendIntent(bytes32 _intentHash, uint64 _additionalTime) external override nonReentrant {
        if (riskTakingPaused) revert RiskTakingPaused();
        if (_additionalTime == 0) revert ZeroAmount();

        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) revert PositionNotPending(_intentHash, position.status);
        if (position.extensionPenaltyBpsPerHour == 0) revert ExtensionsDisabled(position.paymentMethod);

        address currentStakeOwner = stakeVault.stakeOwnerOf(position.taker);
        address extensionStakeOwner = position.extensionStakeOwner;
        if (extensionStakeOwner == address(0)) extensionStakeOwner = currentStakeOwner;

        bool callerIsTaker = msg.sender == position.taker;
        bool callerIsStakeOwner = msg.sender == extensionStakeOwner;
        if (
            (!callerIsTaker && !callerIsStakeOwner)
                || (callerIsTaker && !callerIsStakeOwner && currentStakeOwner != extensionStakeOwner)
        ) {
            revert UnauthorizedStakeExtension(msg.sender, position.taker, extensionStakeOwner);
        }

        IOrchestratorV3.RiskIntentData memory intent = orchestrator.getRiskIntent(_intentHash);
        if (intent.owner != position.taker || intent.escrow == address(0)) revert IntentStateMismatch(_intentHash);

        IEscrowV2 escrow = IEscrowV2(intent.escrow);
        IEscrowV2.Intent memory escrowIntent = escrow.getDepositIntent(intent.depositId, _intentHash);
        if (escrowIntent.intentHash != _intentHash || escrowIntent.timestamp != position.createdAt) {
            revert IntentStateMismatch(_intentHash);
        }

        uint64 currentTime = _currentTimestamp();
        uint64 currentExpiry = _toTimestamp(escrowIntent.expiryTime);
        if (currentTime >= currentExpiry) revert IntentAlreadyExpired(_intentHash, currentExpiry, currentTime);
        if (currentExpiry != uint256(position.baseIntentExpiry) + position.totalExtensionTime) {
            revert IntentStateMismatch(_intentHash);
        }

        uint256 newTotalExtensionTime = uint256(position.totalExtensionTime) + _additionalTime;
        if (newTotalExtensionTime > type(uint64).max) revert ExtensionTimeOverflow(newTotalExtensionTime);
        uint64 newExpiry = _toTimestamp(uint256(currentExpiry) + _additionalTime);
        uint64 maximumExpiry = _toTimestamp(uint256(position.createdAt) + MAX_TOTAL_INTENT_LIFETIME);
        if (newExpiry > maximumExpiry) revert ExtensionExceedsIntentLifetime(newExpiry, maximumExpiry);

        uint256 totalAmount = _calculateIntentExtensionCost(
            position.intentAmount, uint64(newTotalExtensionTime), position.extensionPenaltyBpsPerHour
        );
        uint256 additionalAmount = totalAmount - position.extensionAmount;
        bytes32 lockId = _extensionLockId(_intentHash);

        if (position.extensionAmount == 0) {
            stakeVault.lockStake(extensionStakeOwner, lockId, totalAmount, NEVER_MATURES);
        } else if (additionalAmount != 0) {
            stakeVault.increaseLock(lockId, additionalAmount);
        }

        escrow.extendIntentExpiry(intent.depositId, _intentHash, _additionalTime);

        if (position.extensionStakeOwner == address(0)) position.extensionStakeOwner = extensionStakeOwner;
        position.totalExtensionTime = uint64(newTotalExtensionTime);
        position.extensionAmount = totalAmount;

        emit IntentExtended(
            _intentHash,
            position.taker,
            extensionStakeOwner,
            msg.sender,
            _additionalTime,
            newExpiry,
            additionalAmount,
            totalAmount
        );
    }

    /* ============ Permissionless Lifecycle Recovery ============ */

    /**
     * @notice Completes risk accounting for one cancellation whose original callback failed open.
     * @dev ANYONE. Reads the durable cancellation timestamp from OrchestratorV3, applies the same cancellation transition
     *      that the original callback would have applied, then acknowledges the recovery record. Extension fees are
     *      calculated at the original liquidity-unlock time rather than the later reconciliation time.
     * @param _intentHash Identifier of the cancelled intent to reconcile.
     */
    function reconcileCancellation(bytes32 _intentHash) external override nonReentrant {
        _reconcileCancellation(_intentHash);
    }

    /**
     * @notice Completes risk accounting for a non-empty batch of failed-open cancellation callbacks.
     * @dev ANYONE. Reverts atomically if any supplied intent has no recorded cancellation or cannot be reconciled.
     *      Duplicate hashes therefore also revert after the first occurrence consumes its recovery record.
     * @param _intentHashes Identifiers of cancelled intents to reconcile in order.
     */
    function reconcileCancellations(bytes32[] calldata _intentHashes) external override nonReentrant {
        if (_intentHashes.length == 0) revert EmptyBatch();
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _reconcileCancellation(_intentHashes[intentIndex]);
        }
    }

    /**
     * @notice Releases one settled chargeback position after its risk window has matured cleanly.
     * @dev ANYONE. STAKE_BACKED coverage becomes free stake. DEFERRED_PAYOUT coverage is resolved into the stored fee
     *      claims, while the executable remainder becomes free stake of the payout recipient. The position transitions
     *      from SETTLED to RELEASED before the external vault call.
     * @param _intentHash Identifier of the matured settled position.
     */
    function releaseMaturedPosition(bytes32 _intentHash) external override nonReentrant {
        _releaseMaturedPosition(_intentHash);
    }

    /**
     * @notice Releases a non-empty batch of settled positions whose chargeback windows have matured cleanly.
     * @dev ANYONE. Reverts atomically if any supplied position is not settled or has not reached its coverage deadline.
     * @param _intentHashes Identifiers of matured positions to release in order.
     */
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external override nonReentrant {
        if (_intentHashes.length == 0) revert EmptyBatch();
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _releaseMaturedPosition(_intentHashes[intentIndex]);
        }
    }

    /* ============ Chargebacks ============ */

    /**
     * @notice Resolves a fully covered settled position into an immediately claimable LP chargeback award.
     * @dev ANYONE may relay evidence before the half-open coverage window ends. The signed EIP-712 attestation must bind
     *      to its exact data payload and payment method. Non-manual settlements additionally require the original payment
     *      ID to map to this intent in both directions through the nullifier registry. The payment-method-scoped dispute
     *      ID is consumed globally before the vault interaction.
     *
     *      Chargebacks are deliberately all-or-nothing: the position's coverage must equal its gross release. Resolving
     *      the lock creates one claim for that complete amount in favor of the LP. Any deferred fee plan is discarded,
     *      because no settlement fee vests when gross proceeds compensate the LP.
     * @param _attestation Intent-bound chargeback evidence, payload hash, witness signatures, and encoded details.
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

        uint256 compensatedAmount = position.grossReleasedAmount;
        if (position.coverageAmount != compensatedAmount) {
            revert IncompleteChargebackCoverage(position.coverageAmount, compensatedAmount);
        }

        usedChargebackNullifiers[nullifier] = true;
        position.status = PositionStatus.SLASHED;
        position.coverageAmount = 0;
        delete deferredFeeAllocations[_attestation.intentHash];

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: position.lp, amount: compensatedAmount});
        stakeVault.resolveLock(_attestation.intentHash, claims);

        emit ChargebackSettled(
            _attestation.intentHash,
            position.stakeOwner,
            position.lp,
            position.mode,
            compensatedAmount,
            details.disputeId
        );
    }

    /* ============ Governance ============ */

    /**
     * @notice GOVERNANCE ONLY: Sets risk policy used by future intents for one payment method.
     * @dev Existing positions are unaffected because all liability inputs are snapshotted at admission. Enabling
     *      chargebacks requires a non-zero bounded risk window. Deferred payout cannot be enabled without chargebacks.
     *      The maximum extension slope is bounded so buying the maximum lifetime cannot cost more than the intent amount.
     * @param _paymentMethod Payment-method key whose future policy is being configured.
     * @param _config Enabled state, chargeback settings, and hourly extension slope to validate and store.
     */
    function setPlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config)
        external
        override
        onlyOwner
    {
        _validatePlatformConfig(_paymentMethod, _config);
        platformRiskConfigs[_paymentMethod] = _config;
        emit PlatformRiskConfigUpdated(
            _paymentMethod,
            _config.enabled,
            _config.chargeback.chargebackable,
            _config.chargeback.deferredPayoutEnabled,
            _config.chargeback.riskWindow,
            _config.extensionPenaltyBpsPerHour
        );
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future chargeback submissions.
     * @dev The new address must contain deployed code. Updating the verifier affects unresolved settled positions because
     *      attestations are verified at submission time rather than against a per-position verifier snapshot.
     * @param _verifier New chargeback attestation verifier contract.
     */
    function setAttestationVerifier(address _verifier) external override onlyOwner {
        if (_verifier == address(0) || _verifier.code.length == 0) revert ZeroAddress();
        address previousVerifier = address(attestationVerifier);
        attestationVerifier = IAttestationVerifier(_verifier);
        emit AttestationVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice GOVERNANCE ONLY: Pauses or resumes new risk admissions and intent extensions.
     * @dev Pausing does not block cancellations, settlement, maturity release, reconciliation, or chargebacks, ensuring
     *      existing liabilities can still reach a terminal state.
     * @param _paused True to stop new risk taking; false to resume it.
     */
    function setRiskTakingPaused(bool _paused) external override onlyOwner {
        riskTakingPaused = _paused;
        emit RiskTakingPausedUpdated(_paused);
    }

    /**
     * @notice GOVERNANCE ONLY: Accepts this RiskManager as StakeVault controller after the vault's handover delay.
     * @dev The StakeVault independently verifies that this contract is the matured pending controller. Once accepted,
     *      this RiskManager can create, resize, unlock, fund, and resolve locks according to the policies above.
     */
    function acceptVaultController() external override onlyOwner {
        stakeVault.acceptController();
    }

    /**
     * @notice Ownership renunciation is disabled so governed safety controls cannot be made permanently unreachable.
     * @dev Always reverts for the owner; non-owners revert through the inherited ownership check first.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ Views ============ */

    /**
     * @notice Returns the mutable policy that will apply to future intents for a payment method.
     * @param _paymentMethod Payment-method key to query.
     * @return config Current platform risk configuration.
     */
    function getPlatformRiskConfig(bytes32 _paymentMethod) external view override returns (PlatformRiskConfig memory) {
        return platformRiskConfigs[_paymentMethod];
    }

    /**
     * @notice Returns the immutable policy snapshot and current lifecycle accounting for an intent.
     * @param _intentHash Intent identifier to query.
     * @return position Stored risk position, or the zero-valued position if it was never admitted.
     */
    function getRiskPosition(bytes32 _intentHash) external view override returns (RiskPosition memory) {
        return riskPositions[_intentHash];
    }

    /**
     * @notice Returns contingent fee allocations retained for a deferred-payout position.
     * @dev Allocations exist only between deferred settlement and either clean maturity or chargeback resolution.
     * @param _intentHash Deferred-payout intent identifier to query.
     * @return allocations Exact fee claims that will vest on clean maturity.
     */
    function getDeferredFeeAllocations(bytes32 _intentHash) external view override returns (FeeAllocation[] memory) {
        return deferredFeeAllocations[_intentHash];
    }

    /**
     * @notice Returns the selected stake owner and its portfolio-wide StakeVault balances for a taker.
     * @dev Locked and free values are shared across every taker and position using the selected stake owner; they are not
     *      taker-specific exposure figures.
     * @param _taker Taker whose currently selected stake owner should be resolved.
     * @return stakeOwner Current selected stake owner, falling back to the taker itself when no delegation is selected.
     * @return totalStake Stake owner's total principal balance, excluding beneficiary claim balances.
     * @return locked Stake owner's principal currently committed across all locks.
     * @return free Stake owner's immediately withdrawable or lockable principal.
     */
    function getTakerState(address _taker)
        external
        view
        override
        returns (address stakeOwner, uint256 totalStake, uint256 locked, uint256 free)
    {
        stakeOwner = stakeVault.stakeOwnerOf(_taker);
        totalStake = stakeVault.stakeBalance(stakeOwner);
        locked = stakeVault.lockedStake(stakeOwner);
        free = stakeVault.freeStake(stakeOwner);
    }

    /* ============ Public Formula Helpers ============ */

    /**
     * @notice Calculates the maximum stake lock required to purchase a total amount of extension time.
     * @dev Implements `ceil(intentAmount * slope * extensionTime / (10_000 * 1 hour))` with full-precision
     *      multiplication and upward rounding. Returns zero if any multiplicative input is zero.
     * @param _intentAmount Full amount of liquidity locked by the intent.
     * @param _extensionTime Total number of extension seconds being purchased.
     * @param _extensionPenaltyBpsPerHour Hourly extension slope in basis points.
     * @return Maximum extension fee to lock for the supplied total purchased time.
     */
    function calculateIntentExtensionCost(
        uint256 _intentAmount,
        uint64 _extensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) external pure override returns (uint256) {
        return _calculateIntentExtensionCost(_intentAmount, _extensionTime, _extensionPenaltyBpsPerHour);
    }

    /**
     * @notice Calculates the extension fee owed when an intent reaches a terminal state.
     * @dev Only time elapsed after the original expiry is chargeable, capped by total time actually purchased. The fee
     *      uses the same upward-rounded pricing formula as the extension lock, so it can never exceed that lock.
     * @param _intentAmount Full amount of liquidity locked by the intent.
     * @param _baseIntentExpiry Original expiry before any purchased extensions.
     * @param _terminalAt Timestamp at which the intent settled, cancelled, or expired.
     * @param _totalExtensionTime Total number of extension seconds purchased.
     * @param _extensionPenaltyBpsPerHour Hourly extension slope in basis points.
     * @return penalty Amount awarded to the LP from the extension lock.
     * @return chargeableTime Elapsed purchased seconds included in the fee.
     */
    function calculateIntentExtensionPenalty(
        uint256 _intentAmount,
        uint64 _baseIntentExpiry,
        uint64 _terminalAt,
        uint64 _totalExtensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) external pure override returns (uint256 penalty, uint64 chargeableTime) {
        return _calculateIntentExtensionPenalty(
            _intentAmount, _baseIntentExpiry, _terminalAt, _totalExtensionTime, _extensionPenaltyBpsPerHour
        );
    }

    /**
     * @notice Derives the StakeVault lock ID used for an intent's extension exposure.
     * @dev Namespacing prevents collision with the raw intent hash used for chargeback coverage.
     * @param _intentHash Intent identifier to namespace.
     * @return Collision-resistant extension lock identifier.
     */
    function extensionLockId(bytes32 _intentHash) external pure override returns (bytes32) {
        return _extensionLockId(_intentHash);
    }

    /**
     * @notice Returns the complete EIP-712 digest that chargeback witnesses must sign.
     * @dev The struct commits to the intent hash and payload hash. The EIP-712 domain additionally binds the signature to
     *      this RiskManager, its configured name and version, and the current chain.
     * @param _attestation Attestation whose intent and data hash should be signed.
     * @return Typed-data digest consumed by the configured attestation verifier.
     */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation)
        external
        view
        override
        returns (bytes32)
    {
        return _hashTypedDataV4(_hashChargebackAttestation(_attestation));
    }

    /* ============ Internal Lifecycle Accounting ============ */

    /**
     * @dev Applies the common cancellation transition using a trustworthy liquidity-unlock timestamp. Extension
     *      exposure is resolved first, then pending chargeback coverage is unlocked and the position becomes CANCELLED.
     *      Any vault failure reverts the complete transition.
     * @param _intentHash Identifier of the pending position being cancelled.
     * @param _cancelledAt Original timestamp at which the orchestrator released intent liquidity.
     */
    function _cancelPosition(bytes32 _intentHash, uint64 _cancelledAt) internal {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) revert PositionNotPending(_intentHash, position.status);

        (uint256 extensionPenalty,) = _resolveExtension(_intentHash, position, _cancelledAt);
        uint256 releasedCoverage = position.coverageAmount;

        position.status = PositionStatus.CANCELLED;
        position.coverageAmount = 0;
        if (position.mode == RiskMode.STAKE_BACKED && releasedCoverage != 0) {
            stakeVault.unlockStake(_intentHash);
        }

        emit RiskPositionCancelled(
            _intentHash, position.stakeOwner, position.lp, _cancelledAt, extensionPenalty, releasedCoverage
        );
    }

    /**
     * @dev Charges identical elapsed extension time on every terminal path and frees all unused extension collateral.
     *      `resolveLock` turns the charged portion into an immediately claimable LP allocation and returns the remainder
     *      to the extension stake owner's free stake. The isolated extension lock cannot mutate chargeback coverage.
     * @param _intentHash Intent whose extension lock is being resolved.
     * @param _position Stored position containing the snapshotted extension terms and current lock amount.
     * @param _terminalAt Timestamp at which the intent reached its terminal path.
     * @return penalty Amount converted into an LP claim.
     * @return releasedAmount Amount returned to the extension stake owner's free stake.
     */
    function _resolveExtension(bytes32 _intentHash, RiskPosition storage _position, uint64 _terminalAt)
        internal
        returns (uint256 penalty, uint256 releasedAmount)
    {
        if (_position.extensionAmount == 0) return (0, 0);

        uint64 chargeableTime;
        (penalty, chargeableTime) = _calculateIntentExtensionPenalty(
            _position.intentAmount,
            _position.baseIntentExpiry,
            _terminalAt,
            _position.totalExtensionTime,
            _position.extensionPenaltyBpsPerHour
        );
        releasedAmount = _position.extensionAmount - penalty;
        _position.extensionAmount = 0;

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](penalty == 0 ? 0 : 1);
        if (penalty != 0) claims[0] = IStakeVault.Claim({beneficiary: _position.lp, amount: penalty});
        stakeVault.resolveLock(_extensionLockId(_intentHash), claims);

        emit IntentExtensionResolved(
            _intentHash,
            _position.extensionStakeOwner,
            _position.lp,
            _terminalAt,
            chargeableTime,
            penalty,
            releasedAmount
        );
    }

    /**
     * @dev Replays a failed-open cancellation using OrchestratorV3's persisted original timestamp, then acknowledges the
     *      recovery record only after all RiskManager and StakeVault accounting succeeds.
     * @param _intentHash Identifier of the cancelled intent being reconciled.
     */
    function _reconcileCancellation(bytes32 _intentHash) internal {
        uint64 cancelledAt = orchestrator.getIntentCancellation(_intentHash);
        if (cancelledAt == 0) revert CancellationNotRecorded(_intentHash);
        _cancelPosition(_intentHash, cancelledAt);
        orchestrator.acknowledgeIntentCancellation(_intentHash);
    }

    /**
     * @dev Applies clean maturity after the half-open chargeback window has ended. Stake-backed locks are simply
     *      unlocked. Deferred locks resolve into their contingent fee claims, leaving unallocated principal as free
     *      payout-recipient stake. State is updated before the vault interaction and the transaction remains atomic.
     * @param _intentHash Identifier of the settled position being released.
     */
    function _releaseMaturedPosition(bytes32 _intentHash) internal {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.SETTLED) revert PositionNotSettled(_intentHash, position.status);

        uint64 currentTime = _currentTimestamp();
        if (position.coverageDeadline == 0 || currentTime < position.coverageDeadline) {
            revert PositionNotMature(position.coverageDeadline, currentTime);
        }

        uint256 releasedCoverage = position.coverageAmount;
        position.status = PositionStatus.RELEASED;
        position.coverageAmount = 0;

        if (position.mode == RiskMode.STAKE_BACKED) {
            stakeVault.unlockStake(_intentHash);
        } else if (position.mode == RiskMode.DEFERRED_PAYOUT) {
            IStakeVault.Claim[] memory claims = _deferredClaims(_intentHash);
            delete deferredFeeAllocations[_intentHash];
            stakeVault.resolveLock(_intentHash, claims);
        } else {
            revert PositionModeMismatch(_intentHash, position.mode);
        }

        emit RiskPositionReleased(_intentHash, position.stakeOwner, position.mode, releasedCoverage);
    }

    /**
     * @dev Converts a deferred settlement's complete gross release into payout-recipient-owned locked stake. Tokens move
     *      directly from the orchestrator to StakeVault; an exact balance-delta check rejects transfer-tax or otherwise
     *      non-conforming tokens. Non-zero fee allocations are stored as contingent claims until maturity.
     * @param _context Canonical settlement amounts, token, recipient, fee plan, and intent identifier.
     * @param _position Deferred position being funded; its stake owner must equal the settlement recipient.
     * @param _coverageDeadline Timestamp at which clean maturity becomes permissionlessly releasable.
     */
    function _fundDeferredLock(
        RiskSettlementContext calldata _context,
        RiskPosition storage _position,
        uint64 _coverageDeadline
    ) internal {
        if (_position.stakeOwner != _context.recipient) {
            revert DeferredStakeRecipientMismatch(_position.stakeOwner, _context.recipient);
        }

        IERC20 token = IERC20(_context.token);
        uint256 balanceBefore = token.balanceOf(address(stakeVault));
        token.safeTransferFrom(msg.sender, address(stakeVault), _context.grossAmount);
        uint256 balanceAfter = token.balanceOf(address(stakeVault));
        uint256 received = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (received != _context.grossAmount) {
            revert DeferredStakeTransferMismatch(_context.grossAmount, received);
        }

        stakeVault.fundLock(_position.stakeOwner, _context.intentHash, _context.grossAmount, _coverageDeadline);

        delete deferredFeeAllocations[_context.intentHash];
        for (uint256 feeIndex = 0; feeIndex < _context.feeAllocations.length; feeIndex++) {
            FeeAllocation calldata allocation = _context.feeAllocations[feeIndex];
            if (allocation.amount != 0) deferredFeeAllocations[_context.intentHash].push(allocation);
        }

        emit DeferredSettlementFunded(
            _context.intentHash,
            _position.stakeOwner,
            _context.grossAmount,
            _context.executableAmount,
            _context.grossAmount - _context.executableAmount,
            _coverageDeadline
        );
    }

    /**
     * @dev Converts stored deferred fee allocations into StakeVault claims. The returned claims intentionally cover only
     *      fees; `resolveLock` returns every unallocated unit to the payout recipient's free stake.
     * @param _intentHash Deferred-payout intent whose fee plan should be materialized.
     * @return claims Immediately claimable fee allocations for clean maturity.
     */
    function _deferredClaims(bytes32 _intentHash) internal view returns (IStakeVault.Claim[] memory claims) {
        FeeAllocation[] storage allocations = deferredFeeAllocations[_intentHash];
        claims = new IStakeVault.Claim[](allocations.length);
        for (uint256 feeIndex = 0; feeIndex < allocations.length; feeIndex++) {
            claims[feeIndex] =
                IStakeVault.Claim({beneficiary: allocations[feeIndex].recipient, amount: allocations[feeIndex].amount});
        }
    }

    /* ============ Internal Validation ============ */

    /**
     * @dev Binds settlement to the vault token, snapshotted payout recipient, admitted intent amount, and an exact fee
     *      plan. The fee sum must equal `grossAmount - executableAmount`, and every allocation needs a non-zero recipient.
     * @param _context Settlement data supplied by the canonical orchestrator.
     * @param _position Pending position against which settlement is validated.
     */
    function _validateSettlementContext(RiskSettlementContext calldata _context, RiskPosition storage _position)
        internal
        view
    {
        address expectedToken = address(stakeVault.stakeToken());
        if (_context.token != expectedToken) revert IntentTokenMismatch(expectedToken, _context.token);
        if (
            _context.grossAmount == 0 || _context.executableAmount == 0
                || _context.executableAmount > _context.grossAmount || _context.grossAmount > _position.intentAmount
        ) revert InvalidSettlementAmounts(_context.grossAmount, _context.executableAmount);
        if (_context.recipient != _position.payoutRecipient) revert IntentStateMismatch(_context.intentHash);
        if (_context.feeAllocations.length > MAX_FEE_ALLOCATIONS) {
            revert InvalidFeeAllocationCount(_context.feeAllocations.length, MAX_FEE_ALLOCATIONS);
        }

        uint256 allocatedFees;
        for (uint256 feeIndex = 0; feeIndex < _context.feeAllocations.length; feeIndex++) {
            FeeAllocation calldata allocation = _context.feeAllocations[feeIndex];
            if (allocation.recipient == address(0)) {
                revert InvalidFeeAllocation(allocation.recipient, allocation.amount);
            }
            allocatedFees += allocation.amount;
        }
        uint256 expectedFees = _context.grossAmount - _context.executableAmount;
        if (allocatedFees != expectedFees) revert InvalidFeeAllocations(expectedFees, allocatedFees);
    }

    /**
     * @dev Enforces internally consistent future policy and bounds every derived timestamp and extension amount.
     *      Chargebackable platforms need a non-zero risk window of at most one year; non-chargebackable platforms cannot
     *      enable deferred payout or retain a risk window. Maximum-lifetime extension cost cannot exceed intent principal.
     * @param _paymentMethod Non-zero platform key associated with the configuration.
     * @param _config Proposed platform configuration.
     */
    function _validatePlatformConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) internal pure {
        if (_paymentMethod == bytes32(0)) revert InvalidPlatformConfig(_paymentMethod);

        if (_config.chargeback.chargebackable) {
            if (_config.chargeback.riskWindow == 0 || _config.chargeback.riskWindow > MAX_RISK_WINDOW) {
                revert InvalidPlatformConfig(_paymentMethod);
            }
        } else if (_config.chargeback.deferredPayoutEnabled || _config.chargeback.riskWindow != 0) {
            revert InvalidPlatformConfig(_paymentMethod);
        }

        uint256 maximumRateNumerator = uint256(_config.extensionPenaltyBpsPerHour) * MAX_TOTAL_INTENT_LIFETIME;
        if (maximumRateNumerator > EXTENSION_DENOMINATOR) {
            revert ExtensionPenaltyExceedsIntentAmount(_paymentMethod);
        }
    }

    /**
     * @dev Binds every risk amount to StakeVault's immutable accounting token before admission.
     * @param _intentToken Token configured on the intent's Escrow deposit.
     */
    function _validateIntentToken(IERC20 _intentToken) internal view {
        address expectedToken = address(stakeVault.stakeToken());
        if (address(_intentToken) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(_intentToken));
        }
    }

    /**
     * @dev Binds encoded dispute details to settlement state and the half-open coverage window. Proof-based fulfillment
     *      additionally requires the canonical payment-nullifier binding in both directions. Manual releases have no
     *      payment-verifier call, so their dedicated witnesses are the binding authority: the EIP-712 signature commits
     *      to the exact intent and data hash while the derived dispute nullifier remains globally single-use.
     * @param _attestation Intent-bound evidence and encoded chargeback details.
     * @param _position Settled position whose snapshotted terms constrain the evidence.
     * @return details Decoded chargeback details used by subsequent settlement and event emission.
     * @return nullifier Payment-method-scoped dispute identifier consumed on successful settlement.
     */
    function _validateAttestation(ChargebackAttestation calldata _attestation, RiskPosition storage _position)
        internal
        view
        returns (ChargebackDetails memory details, bytes32 nullifier)
    {
        if (_attestation.intentHash == bytes32(0) || keccak256(_attestation.data) != _attestation.dataHash) {
            revert InvalidAttestation();
        }
        if (block.timestamp >= _position.coverageDeadline) {
            revert ChargebackWindowClosed(_position.coverageDeadline, _currentTimestamp());
        }

        details = abi.decode(_attestation.data, (ChargebackDetails));
        if (
            details.paymentMethod != _position.paymentMethod || details.originalPaymentId == bytes32(0)
                || details.disputeId == bytes32(0) || details.paymentAmount == 0
                || details.paymentCurrency == bytes32(0)
        ) revert InvalidAttestation();

        if (!_position.isManualRelease) {
            bytes32 paymentNullifier = keccak256(abi.encodePacked(details.paymentMethod, details.originalPaymentId));
            if (
                nullifierRegistry.intentHashByNullifier(paymentNullifier) != _attestation.intentHash
                    || nullifierRegistry.nullifierByIntentHash(_attestation.intentHash) != paymentNullifier
            ) revert InvalidPaymentBinding(_attestation.intentHash, paymentNullifier);
        }

        nullifier = keccak256(abi.encodePacked(details.paymentMethod, details.disputeId));
        if (usedChargebackNullifiers[nullifier]) revert ChargebackEvidenceUsed(nullifier);
    }

    /* ============ Internal Formula Helpers ============ */

    /**
     * @dev Implements `ceil(A * slope * time / (10_000 * 1 hour))` without intermediate multiplication overflow.
     * @param _intentAmount Full amount of liquidity locked by the intent.
     * @param _extensionTime Number of purchased extension seconds being priced.
     * @param _extensionPenaltyBpsPerHour Hourly extension slope in basis points.
     * @return Upward-rounded extension cost.
     */
    function _calculateIntentExtensionCost(
        uint256 _intentAmount,
        uint64 _extensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) internal pure returns (uint256) {
        if (_intentAmount == 0 || _extensionTime == 0 || _extensionPenaltyBpsPerHour == 0) {
            return 0;
        }
        uint256 rateNumerator = uint256(_extensionPenaltyBpsPerHour) * _extensionTime;
        return Math.mulDiv(_intentAmount, rateNumerator, EXTENSION_DENOMINATOR, Math.Rounding.Up);
    }

    /**
     * @dev Charges only elapsed time after the original expiry, capped by time actually purchased.
     * @param _intentAmount Full amount of liquidity locked by the intent.
     * @param _baseIntentExpiry Original expiry before purchased extensions.
     * @param _terminalAt Timestamp of the terminal lifecycle transition.
     * @param _totalExtensionTime Total number of purchased extension seconds.
     * @param _extensionPenaltyBpsPerHour Hourly extension slope in basis points.
     * @return penalty Upward-rounded amount owed to the LP.
     * @return chargeableTime Purchased extension seconds that had elapsed at the terminal timestamp.
     */
    function _calculateIntentExtensionPenalty(
        uint256 _intentAmount,
        uint64 _baseIntentExpiry,
        uint64 _terminalAt,
        uint64 _totalExtensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) internal pure returns (uint256 penalty, uint64 chargeableTime) {
        if (_terminalAt <= _baseIntentExpiry || _totalExtensionTime == 0) {
            return (0, 0);
        }
        uint256 elapsedAfterBase = uint256(_terminalAt - _baseIntentExpiry);
        chargeableTime = uint64(_min(elapsedAfterBase, _totalExtensionTime));
        penalty = _calculateIntentExtensionCost(_intentAmount, chargeableTime, _extensionPenaltyBpsPerHour);
    }

    /**
     * @dev Derives a collision-resistant StakeVault key independent from the raw intent-hash chargeback key.
     * @param _intentHash Intent identifier to namespace.
     * @return Extension lock identifier.
     */
    function _extensionLockId(bytes32 _intentHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(EXTENSION_LOCK_NAMESPACE, _intentHash));
    }

    /**
     * @dev Produces the EIP-712 struct hash; `_hashTypedDataV4` adds domain and chain binding separately.
     * @param _attestation Attestation whose intent and data hash should be committed.
     * @return EIP-712 struct hash for the chargeback attestation.
     */
    function _hashChargebackAttestation(ChargebackAttestation calldata _attestation) internal pure returns (bytes32) {
        return keccak256(abi.encode(CHARGEBACK_ATTESTATION_TYPEHASH, _attestation.intentHash, _attestation.dataHash));
    }

    /**
     * @dev Returns the current block timestamp after checked narrowing to the storage timestamp width.
     * @return Current EVM timestamp represented as `uint64`.
     */
    function _currentTimestamp() internal view returns (uint64) {
        return _toTimestamp(block.timestamp);
    }

    /**
     * @dev Narrows an absolute timestamp after rejecting values that cannot be represented in position or lock storage.
     * @param _timestamp Timestamp to narrow.
     * @return Safely narrowed timestamp.
     */
    function _toTimestamp(uint256 _timestamp) internal pure returns (uint64) {
        if (_timestamp > type(uint64).max) revert TimestampOverflow(_timestamp);
        return uint64(_timestamp);
    }

    /**
     * @dev Returns the smaller of two unsigned integers.
     * @param _left First value.
     * @param _right Second value.
     * @return Minimum value.
     */
    function _min(uint256 _left, uint256 _right) internal pure returns (uint256) {
        return _left < _right ? _left : _right;
    }
}
