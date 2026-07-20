// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAttestationVerifier } from "./interfaces/IAttestationVerifier.sol";
import { IEscrowV2 } from "./interfaces/IEscrowV2.sol";
import { IIntentExtensionHook } from "./interfaces/IIntentExtensionHook.sol";
import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { IOrchestratorV3 } from "./interfaces/IOrchestratorV3.sol";
import { IRiskManager } from "./interfaces/IRiskManager.sol";
import { IStakeVault } from "./interfaces/IStakeVault.sol";

/**
 * @title RiskManager
 * @notice Enforces prepaid intent extensions and post-settlement chargeback coverage.
 * @dev Cancellation is free and releases all pending reservation. Extensions are owner-initiated,
 *      charged from free stake, and credited to the affected LP before Escrow changes the expiry.
 *      Chargeback policy remains independent and is snapshotted at admission.
 */
contract RiskManager is IRiskManager, Ownable, ReentrancyGuard, EIP712 {
    /* ============ Constants ============ */

    /// @notice Basis-point denominator shared by chargeback and extension rates.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Denominator for annualized paid-extension pricing.
    uint256 internal constant EXTENSION_FEE_DENOMINATOR = BPS_DENOMINATOR * 365 days;

    /// @notice Operational ceiling preventing a governance value that cannot fit in uint64 deadlines.
    /// @dev One year is deliberately far above the approved illustrative 30-day window while keeping
    ///      settlement deadline construction safe for every realistic EVM timestamp horizon.
    uint64 public constant MAX_RISK_WINDOW = 365 days;

    /// @notice EIP-712 type hash binding chargeback evidence to this manager and orchestrator.
    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH = keccak256(
        "ChargebackAttestation(uint256 chainId,address riskManager,address orchestrator,bytes32 intentHash,bytes32 paymentMethod,uint256 chargebackAmount,bytes32 evidenceId,uint256 nonce,uint64 validAfter,uint64 validUntil)"
    );

    /* ============ Immutable Dependencies ============ */

    /// @notice Canonical source of intent admission, settlement, and failed-callback timestamps.
    IOrchestratorV3 public immutable override orchestrator;

    /// @notice Custody and portfolio-accounting boundary for stake and deferred proceeds.
    IStakeVault public immutable override stakeVault;

    /* ============ Mutable Governance State ============ */

    /// @notice Verifier that authenticates typed chargeback attestations.
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

    /// @notice Global replay protection for chargeback attestations accepted by this manager.
    mapping(uint256 => bool) public usedAttestationNonces;

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
     * @dev Admission is fail-closed. It snapshots extension and chargeback terms, then reserves only
     *      chargeback coverage when the platform requires it.
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

        uint64 initialIntentPeriod = _toUint64(IEscrowV2(intent.escrow).intentExpirationPeriod());
        _validateIntentExtensionPolicy(intent.paymentMethod, initialIntentPeriod, config.extension);

        IEscrowV2.Deposit memory deposit = IEscrowV2(intent.escrow).getDeposit(intent.depositId);
        _validateIntentToken(deposit.token);
        address stakeOwner = stakeVault.stakeOwnerOf(intent.owner);
        uint256 chargebackReserve = _calculateChargebackReserve(intent.amount, config.chargeback.reserveBps);

        RiskMode mode;
        uint256 initialReservation;

        if (!config.chargeback.chargebackable) {
            mode = RiskMode.UNBONDED;
        } else {
            uint256 available = stakeVault.freeStake(stakeOwner);
            if (available >= chargebackReserve) {
                mode = RiskMode.STAKE_BACKED;
                initialReservation = chargebackReserve;
            } else if (config.chargeback.deferredPayoutEnabled) {
                if (deferredPayoutHook == address(0) || intent.postIntentHook != deferredPayoutHook) {
                    revert DeferredPayoutHookRequired(deferredPayoutHook, intent.postIntentHook);
                }
                mode = RiskMode.DEFERRED_PAYOUT;
                requiresPostIntentHook = true;
            } else {
                revert InsufficientCollateral(stakeOwner, available, chargebackReserve);
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
        position.deferredPayoutHook = mode == RiskMode.DEFERRED_PAYOUT ? deferredPayoutHook : address(0);
        position.payoutRecipient = intent.to;
        position.chargebackReserveBps = config.chargeback.reserveBps;
        position.extensionFeeBps = config.extension.feeBps;
        position.riskWindow = config.chargeback.riskWindow;
        position.createdAt = intent.createdAt;
        position.maxIntentLifetime = config.extension.maxIntentLifetime;
        position.intentAmount = intent.amount;
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
            _position.chargebackReserveBps,
            _position.riskWindow,
            _position.extensionFeeBps,
            _position.maxIntentLifetime,
            _chargebackReserve,
            _position.initialReservation
        );
    }

    /**
     * @inheritdoc IIntentExtensionHook
     * @dev The cumulative formula prevents a buyer from reducing fees by splitting one extension into
     *      many rounding-sized calls. Delegated stake requires a separate spend authorization.
     */
    function onIntentExpiryExtension(
        bytes32 _intentHash,
        uint256 _extensionSeconds,
        uint256 _newExpiry
    ) external override onlyOrchestrator nonReentrant returns (uint256 fee) {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_intentHash, position.status);
        }
        if (position.extensionFeeBps == 0 || position.maxIntentLifetime == 0) {
            revert IntentExtensionsDisabled(_intentHash);
        }

        uint256 maximumExpiry = uint256(position.createdAt) + position.maxIntentLifetime;
        if (_newExpiry > maximumExpiry) {
            revert IntentExtensionLifetimeExceeded(_intentHash, _newExpiry, maximumExpiry);
        }
        if (stakeVault.isExiting(position.stakeOwner)) {
            revert StakeOwnerExiting(position.taker, position.stakeOwner);
        }
        if (
            position.stakeOwner != position.taker
                && !stakeVault.isExtensionFeeAuthorized(position.stakeOwner, position.taker)
        ) {
            revert ExtensionFeeAuthorizationRequired(_intentHash, position.stakeOwner, position.taker);
        }

        uint256 purchasedExtensionSeconds = uint256(position.purchasedExtensionSeconds) + _extensionSeconds;
        uint256 cumulativeFees = calculateIntentExtensionFee(
            position.intentAmount,
            position.extensionFeeBps,
            purchasedExtensionSeconds
        );
        fee = cumulativeFees - position.extensionFeesPaid;
        uint256 available = stakeVault.freeStake(position.stakeOwner);
        if (fee > available) {
            revert InsufficientExtensionFeeStake(position.stakeOwner, available, fee);
        }

        position.purchasedExtensionSeconds = _toUint64(purchasedExtensionSeconds);
        position.extensionFeesPaid = cumulativeFees;
        if (fee != 0) {
            stakeVault.spendFreeStake(_intentHash, position.stakeOwner, position.lp, fee);
        }

        emit IntentExtensionFeeCharged(
            _intentHash,
            position.stakeOwner,
            position.lp,
            _extensionSeconds,
            fee,
            _newExpiry,
            cumulativeFees
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
        _settlePosition(_intentHash, _releasedAmount, uint64(block.timestamp));
    }

    /**
     * @inheritdoc IIntentRiskHook
     */
    function onIntentReleased(
        bytes32 _intentHash,
        uint256 _releasedAmount
    ) external override onlyOrchestrator nonReentrant {
        _settlePosition(_intentHash, _releasedAmount, uint64(block.timestamp));
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
        _settlePosition(_intentHash, releasedAmount, settledAt);
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
     * @dev A valid attestation consumes its nonce and compensates at most remaining position coverage.
     *      Partial claims preserve the balance for later attestations inside the same window.
     */
    function submitChargeback(
        ChargebackAttestation calldata _attestation,
        bytes[] calldata _signatures,
        bytes calldata _verificationData
    ) external override nonReentrant {
        RiskPosition storage position = riskPositions[_attestation.intentHash];
        if (position.status == PositionStatus.PENDING) _synchronizeSettlement(_attestation.intentHash);
        if (position.status != PositionStatus.SETTLED) {
            revert PositionNotSettled(_attestation.intentHash, position.status);
        }
        if (position.mode != RiskMode.STAKE_BACKED && position.mode != RiskMode.DEFERRED_PAYOUT) {
            revert PositionModeMismatch(_attestation.intentHash, position.mode);
        }

        _validateAttestation(_attestation, position);
        bytes32 digest = _hashTypedDataV4(_hashChargebackAttestation(_attestation));
        if (!attestationVerifier.verify(digest, _signatures, _verificationData)) {
            revert AttestationVerificationFailed();
        }

        uint256 compensatedAmount = _min(_attestation.chargebackAmount, position.reservedAmount);
        if (compensatedAmount == 0) revert ZeroAmount();

        usedAttestationNonces[_attestation.nonce] = true;
        position.slashedAmount += compensatedAmount;
        position.reservedAmount -= compensatedAmount;
        if (position.reservedAmount == 0) position.status = PositionStatus.SLASHED;

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
            _attestation.chargebackAmount,
            compensatedAmount,
            position.slashedAmount,
            position.reservedAmount,
            _attestation.evidenceId
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
            _config.extension.feeBps,
            _config.extension.maxIntentLifetime
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
    function calculateIntentExtensionFee(
        uint256 _amount,
        uint16 _annualFeeBps,
        uint256 _extensionSeconds
    ) public pure override returns (uint256) {
        if (_amount == 0 || _annualFeeBps == 0 || _extensionSeconds == 0) return 0;
        if (_extensionSeconds > type(uint64).max) revert TimestampOverflow(_extensionSeconds);
        uint256 annualizedTime = uint256(_annualFeeBps) * _extensionSeconds;
        return Math.mulDiv(_amount, annualizedTime, EXTENSION_FEE_DENOMINATOR, Math.Rounding.Up);
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
     * @dev Applies one free cancellation using a trustworthy liquidity-unlock timestamp. Effects are written
     *      before vault interactions; any vault failure reverts the complete callback and leaves the
     *      orchestrator's reconciliation record as the recovery path.
     */
    function _cancelPosition(bytes32 _intentHash, uint64 _cancelledAt) internal {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_intentHash, position.status);
        }

        uint256 releasedReservation = position.reservedAmount;

        position.status = PositionStatus.CANCELLED;
        position.cancelledAt = _cancelledAt;
        position.reservedAmount = 0;

        if (releasedReservation != 0) stakeVault.releaseReservation(_intentHash);
        if (position.mode == RiskMode.DEFERRED_PAYOUT) {
            stakeVault.releaseDeferredPayoutAuthorization(_intentHash);
        }

        emit RiskPositionCancelled(
            _intentHash,
            position.stakeOwner,
            position.lp,
            _cancelledAt,
            releasedReservation
        );
    }

    /**
     * @dev Transitions a pending position at settlement. Stake-backed coverage is resized to the exact
     *      released amount; deferred coverage remains zero
     *      until the mandatory hook atomically registers transferred proceeds.
     */
    function _settlePosition(bytes32 _intentHash, uint256 _releasedAmount, uint64 _settledAt) internal {
        if (_releasedAmount == 0) revert ZeroAmount();
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_intentHash, position.status);
        }

        uint256 pendingReservation = position.reservedAmount;
        position.releasedAmount = _releasedAmount;
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
        _settlePosition(_intentHash, releasedAmount, settledAt);
    }

    /* ============ Internal Validation ============ */

    /** @dev Enforces platform rules that do not depend on an Escrow's mutable intent period. */
    function _validatePlatformConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) internal pure {
        if (_paymentMethod == bytes32(0)) revert InvalidPlatformConfig(_paymentMethod);
        if (_config.chargeback.reserveBps > BPS_DENOMINATOR) revert InvalidPlatformConfig(_paymentMethod);

        if (_config.chargeback.chargebackable) {
            if (
                _config.chargeback.reserveBps == 0
                    || _config.chargeback.riskWindow == 0
                    || _config.chargeback.riskWindow > MAX_RISK_WINDOW
            ) {
                revert InvalidPlatformConfig(_paymentMethod);
            }
        } else if (_config.chargeback.reserveBps != 0 || _config.chargeback.deferredPayoutEnabled) {
            revert InvalidPlatformConfig(_paymentMethod);
        }

        bool extensionDisabled = _config.extension.feeBps == 0 && _config.extension.maxIntentLifetime == 0;
        bool extensionEnabled =
            _config.extension.feeBps != 0 && _config.extension.maxIntentLifetime != 0;
        if ((!extensionDisabled && !extensionEnabled) || _config.extension.feeBps > BPS_DENOMINATOR) {
            revert InvalidIntentExtensionConfig(_paymentMethod);
        }
    }

    /** @dev An enabled extension policy must add time beyond the Escrow's initial free period. */
    function _validateIntentExtensionPolicy(
        bytes32 _paymentMethod,
        uint64 _initialIntentPeriod,
        IntentExtensionConfig memory _config
    ) internal pure {
        if (_config.feeBps == 0 && _config.maxIntentLifetime == 0) return;
        if (_initialIntentPeriod == 0 || _config.maxIntentLifetime <= _initialIntentPeriod) {
            revert InvalidIntentExtensionConfig(_paymentMethod);
        }
    }

    /** @dev Binds every risk amount to StakeVault's immutable accounting token before admission. */
    function _validateIntentToken(IERC20 _intentToken) internal view {
        address expectedToken = address(stakeVault.stakeToken());
        if (address(_intentToken) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(_intentToken));
        }
    }

    /** @dev Binds attestation scope, replay protection, validity, and the half-open coverage window. */
    function _validateAttestation(
        ChargebackAttestation calldata _attestation,
        RiskPosition storage _position
    ) internal view {
        if (_attestation.chainId != block.chainid) revert InvalidAttestation();
        if (_attestation.riskManager != address(this)) revert InvalidAttestation();
        if (_attestation.orchestrator != address(orchestrator)) revert InvalidAttestation();
        if (_attestation.paymentMethod != _position.paymentMethod) revert InvalidAttestation();
        if (_attestation.chargebackAmount == 0) revert InvalidAttestation();
        if (_attestation.evidenceId == bytes32(0)) revert InvalidAttestation();
        if (usedAttestationNonces[_attestation.nonce]) revert AttestationNonceUsed(_attestation.nonce);
        if (block.timestamp < _attestation.validAfter) {
            revert AttestationNotYetValid(_attestation.validAfter, uint64(block.timestamp));
        }
        if (block.timestamp > _attestation.validUntil) {
            revert AttestationExpired(_attestation.validUntil, uint64(block.timestamp));
        }
        if (block.timestamp >= _position.coverageDeadline) {
            revert ChargebackWindowClosed(_position.coverageDeadline, uint64(block.timestamp));
        }
    }

    /* ============ Internal Formula Helpers ============ */

    /** @dev Implements ceil(A * r / 10_000) with full-precision multiplication. */
    function _calculateChargebackReserve(uint256 _amount, uint16 _reserveBps) internal pure returns (uint256) {
        if (_reserveBps == 0) return 0;
        return Math.mulDiv(_amount, _reserveBps, BPS_DENOMINATOR, Math.Rounding.Up);
    }

    /** @dev Produces the EIP-712 struct hash for a chargeback attestation. */
    function _hashChargebackAttestation(
        ChargebackAttestation calldata _attestation
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHARGEBACK_ATTESTATION_TYPEHASH,
                _attestation.chainId,
                _attestation.riskManager,
                _attestation.orchestrator,
                _attestation.intentHash,
                _attestation.paymentMethod,
                _attestation.chargebackAmount,
                _attestation.evidenceId,
                _attestation.nonce,
                _attestation.validAfter,
                _attestation.validUntil
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

}
