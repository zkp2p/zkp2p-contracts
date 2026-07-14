// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAttestationVerifier } from "./interfaces/IAttestationVerifier.sol";
import { IEscrow } from "./interfaces/IEscrow.sol";
import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { IOrchestratorV3 } from "./interfaces/IOrchestratorV3.sol";
import { IRiskTierManager } from "./interfaces/IRiskTierManager.sol";
import { IStakeVault } from "./interfaces/IStakeVault.sol";

/**
 * @title RiskTierManager
 * @notice Replaceable policy and accounting layer for stake-derived taker access and chargeback coverage.
 * @dev This contract never holds tokens. It reads canonical intent state from OrchestratorV3 and
 *      instructs StakeVault to reserve, release, or slash funds.
 */
contract RiskTierManager is IRiskTierManager, Ownable, ReentrancyGuard, EIP712 {
    /* ============ Constants ============ */

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH = keccak256(
        "ChargebackAttestation(uint256 chainId,address riskTierManager,address orchestrator,bytes32 intentHash,bytes32 paymentMethod,uint256 chargebackAmount,bytes32 evidenceId,uint256 nonce,uint64 validAfter,uint64 validUntil)"
    );

    /* ============ State Variables ============ */

    IOrchestratorV3 public immutable orchestrator;
    IStakeVault public immutable stakeVault;

    IAttestationVerifier public attestationVerifier;
    address public deferredPayoutHook;
    uint64 public maxIntentLifetime;
    uint64 public settlementBuffer;
    bool public admissionPaused;

    uint256[4] public tierThresholds;
    // Concurrency counts unsettled intents across every taker using the same stake owner.
    // Settled chargeback windows remain bounded by collateral.
    uint256[5] public concurrencyLimits;

    mapping(bytes32 => PlatformRiskConfig) internal platformRiskConfigs;
    mapping(bytes32 => RiskPosition) internal riskPositions;
    mapping(address => uint256) public override activeIntentCount;
    mapping(uint256 => bool) public usedAttestationNonces;

    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedOrchestrator(address caller);
    error UnauthorizedDeferredPayoutHook(address caller);
    error AdmissionPaused();
    error InvalidTierThresholds();
    error InvalidConcurrencyLimit(Tier tier);
    error InvalidPlatformConfig(bytes32 paymentMethod);
    error PlatformDisabled(bytes32 paymentMethod);
    error StakeOwnerExiting(address taker, address stakeOwner);
    error TierNotEligible(address taker, Tier tier, bytes32 paymentMethod);
    error AmountExceedsTierCap(uint256 amount, uint256 cap);
    error ConcurrentIntentLimitReached(address stakeOwner, uint256 activeIntents, uint256 limit);
    error InsufficientCollateral(address stakeOwner, uint256 available, uint256 required);
    error DeferredPayoutHookRequired(address expectedHook, address actualHook);
    error PositionAlreadyExists(bytes32 intentHash);
    error PositionNotActive(bytes32 intentHash, PositionStatus status);
    error PositionModeMismatch(bytes32 intentHash, RiskMode mode);
    error IntentStateMismatch(bytes32 intentHash);
    error DeferredPayoutAlreadyRegistered(bytes32 intentHash);
    error DeferredPayoutExceedsReleasedAmount(uint256 payoutAmount, uint256 releasedAmount);
    error PositionNotMature(uint64 releaseTime, uint64 currentTime);
    error PositionNotSettled(bytes32 intentHash);
    error InvalidAttestation();
    error AttestationNotYetValid(uint64 validAfter, uint64 currentTime);
    error AttestationExpired(uint64 validUntil, uint64 currentTime);
    error ChargebackWindowClosed(uint64 slashDeadline, uint64 currentTime);
    error AttestationNonceUsed(uint256 nonce);
    error AttestationVerificationFailed();
    error InvalidTimingConfig();

    /* ============ Modifiers ============ */

    modifier onlyOrchestrator() {
        if (msg.sender != address(orchestrator)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Creates a risk manager for one orchestrator and one stable vault.
     * @param _owner Governance owner.
     * @param _orchestrator Canonical lifecycle source.
     * @param _stakeVault Stable stake vault.
     * @param _attestationVerifier Initial chargeback attestation verifier.
     * @param _tierThresholds Positive Peer, Plus, Pro, and Platinum thresholds.
     * @param _concurrencyLimits Peasant through Platinum active-intent ceilings.
     * @param _maxIntentLifetime Conservative maximum pre-settlement intent lifetime.
     * @param _settlementBuffer Additional delay after the chargeback claim deadline.
     */
    constructor(
        address _owner,
        IOrchestratorV3 _orchestrator,
        IStakeVault _stakeVault,
        IAttestationVerifier _attestationVerifier,
        uint256[4] memory _tierThresholds,
        uint256[5] memory _concurrencyLimits,
        uint64 _maxIntentLifetime,
        uint64 _settlementBuffer
    ) Ownable() EIP712("ZKP2P RiskTierManager", "1") {
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
        _setTierThresholds(_tierThresholds);
        _setConcurrencyLimits(_concurrencyLimits);
        _setTimingConfig(_maxIntentLifetime, _settlementBuffer);
        attestationVerifier = _attestationVerifier;

        transferOwnership(_owner);
    }

    /* ============ Orchestrator Lifecycle Functions ============ */

    /**
     * @inheritdoc IIntentRiskHook
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
        if (intent.owner == address(0)) revert IntentStateMismatch(_intentHash);
        address stakeOwner = stakeVault.stakeOwnerOf(intent.owner);

        PlatformRiskConfig memory config = platformRiskConfigs[intent.paymentMethod];
        if (!config.enabled) revert PlatformDisabled(intent.paymentMethod);
        if (stakeVault.isExiting(stakeOwner)) revert StakeOwnerExiting(intent.owner, stakeOwner);

        Tier tier = getTier(intent.owner);
        uint256 tierCap = config.tierCaps[uint256(tier)];
        if (tierCap == 0) revert TierNotEligible(intent.owner, tier, intent.paymentMethod);
        if (intent.amount > tierCap) revert AmountExceedsTierCap(intent.amount, tierCap);

        uint256 activeIntents = activeIntentCount[stakeOwner];
        uint256 concurrencyLimit = concurrencyLimits[uint256(tier)];
        if (activeIntents >= concurrencyLimit) {
            revert ConcurrentIntentLimitReached(stakeOwner, activeIntents, concurrencyLimit);
        }

        IEscrow.Deposit memory deposit = IEscrow(intent.escrow).getDeposit(intent.depositId);
        RiskMode mode = RiskMode.NONE;
        uint256 reservedAmount;
        uint64 fallbackReleaseTime;
        uint64 fallbackSlashDeadline;
        address positionDeferredPayoutHook;

        if (config.chargebackable) {
            uint256 requiredReserve = _calculateReserve(intent.amount, config.reserveBps);
            fallbackReleaseTime = _toTimestamp(
                block.timestamp + maxIntentLifetime + config.riskWindow + settlementBuffer
            );
            fallbackSlashDeadline = fallbackReleaseTime - settlementBuffer;

            uint256 available = stakeVault.freeStake(stakeOwner);
            if (available >= requiredReserve) {
                mode = RiskMode.STAKE_BACKED;
                reservedAmount = requiredReserve;
            } else if (config.deferredPayoutEnabled) {
                address actualHook = intent.postIntentHook;
                if (deferredPayoutHook == address(0) || actualHook != deferredPayoutHook) {
                    revert DeferredPayoutHookRequired(deferredPayoutHook, actualHook);
                }
                mode = RiskMode.DEFERRED_PAYOUT;
                positionDeferredPayoutHook = deferredPayoutHook;
                requiresPostIntentHook = true;
            } else {
                revert InsufficientCollateral(stakeOwner, available, requiredReserve);
            }
        }

        riskPositions[_intentHash] = RiskPosition({
            taker: intent.owner,
            stakeOwner: stakeOwner,
            maker: deposit.depositor,
            paymentMethod: intent.paymentMethod,
            mode: mode,
            status: PositionStatus.ACTIVE,
            countsTowardConcurrency: true,
            deferredPayoutHook: positionDeferredPayoutHook,
            payoutRecipient: intent.to,
            reserveBps: config.reserveBps,
            riskWindow: config.riskWindow,
            settlementBuffer: settlementBuffer,
            settledAt: 0,
            slashDeadline: fallbackSlashDeadline,
            releaseTime: fallbackReleaseTime,
            reservedAmount: reservedAmount,
            releasedAmount: 0,
            slashedAmount: 0
        });
        activeIntentCount[stakeOwner] = activeIntents + 1;

        if (mode == RiskMode.STAKE_BACKED) {
            stakeVault.reserveStake(stakeOwner, _intentHash, reservedAmount, fallbackReleaseTime);
        } else if (mode == RiskMode.DEFERRED_PAYOUT) {
            stakeVault.authorizeDeferredPayout(_intentHash, intent.to, fallbackReleaseTime);
        }

        emit RiskPositionCreated(
            _intentHash,
            intent.owner,
            deposit.depositor,
            stakeOwner,
            intent.paymentMethod,
            mode,
            positionDeferredPayoutHook,
            intent.to,
            reservedAmount,
            settlementBuffer,
            fallbackReleaseTime
        );
    }

    /**
     * @inheritdoc IIntentRiskHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator nonReentrant {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.ACTIVE) revert PositionNotActive(_intentHash, position.status);

        uint256 releasedReservation = position.reservedAmount;
        position.status = PositionStatus.CANCELLED;
        position.reservedAmount = 0;
        _releaseConcurrency(position);

        if (position.mode == RiskMode.STAKE_BACKED) {
            stakeVault.releaseReservation(_intentHash);
        } else if (position.mode == RiskMode.DEFERRED_PAYOUT) {
            stakeVault.releaseDeferredPayoutAuthorization(_intentHash);
        }

        emit RiskPositionCancelled(_intentHash, position.taker, releasedReservation);
    }

    /**
     * @inheritdoc IIntentRiskHook
     */
    function onIntentFulfilled(
        bytes32 _intentHash,
        uint256 _releasedAmount
    ) external override onlyOrchestrator nonReentrant {
        _recordSettlement(_intentHash, _releasedAmount);
    }

    /**
     * @inheritdoc IIntentRiskHook
     */
    function onIntentReleased(
        bytes32 _intentHash,
        uint256 _releasedAmount
    ) external override onlyOrchestrator nonReentrant {
        _recordSettlement(_intentHash, _releasedAmount);
    }

    /* ============ Deferred Payout Functions ============ */

    /**
     * @inheritdoc IRiskTierManager
     */
    function registerDeferredPayout(
        bytes32 _intentHash,
        address _beneficiary,
        uint256 _amount
    ) external override nonReentrant {
        if (_amount == 0) revert ZeroAmount();

        RiskPosition storage position = riskPositions[_intentHash];
        if (msg.sender != position.deferredPayoutHook) revert UnauthorizedDeferredPayoutHook(msg.sender);
        if (position.status != PositionStatus.ACTIVE) revert PositionNotActive(_intentHash, position.status);
        if (position.mode != RiskMode.DEFERRED_PAYOUT) revert PositionModeMismatch(_intentHash, position.mode);
        if (position.payoutRecipient != _beneficiary) revert IntentStateMismatch(_intentHash);
        _synchronizeSettlement(_intentHash, position);
        if (position.reservedAmount != 0) revert DeferredPayoutAlreadyRegistered(_intentHash);
        if (_amount > position.releasedAmount) {
            revert DeferredPayoutExceedsReleasedAmount(_amount, position.releasedAmount);
        }

        position.reservedAmount = _amount;
        stakeVault.recordDeferredPayout(_intentHash, _beneficiary, _amount, position.releaseTime);

        emit DeferredPayoutRegistered(_intentHash, _beneficiary, _amount, position.releaseTime);
    }

    /* ============ Chargeback and Maturity Functions ============ */

    /**
     * @inheritdoc IRiskTierManager
     */
    function releaseMaturedPosition(bytes32 _intentHash) external override nonReentrant {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.ACTIVE) revert PositionNotActive(_intentHash, position.status);

        if (position.settledAt == 0) {
            (uint256 settlementAmount, uint64 settledAt) = orchestrator.getIntentSettlement(_intentHash);
            if (settlementAmount != 0 && settledAt != 0) {
                _applySettlement(_intentHash, position, settlementAmount, settledAt);
                if (position.status != PositionStatus.ACTIVE) return;
            } else if (orchestrator.getRiskIntent(_intentHash).owner != address(0)) {
                revert PositionNotSettled(_intentHash);
            }
        }

        if (position.releaseTime == 0 || block.timestamp < position.releaseTime) {
            revert PositionNotMature(position.releaseTime, uint64(block.timestamp));
        }

        position.status = PositionStatus.RELEASED;
        uint256 releasedAmount = position.reservedAmount;
        position.reservedAmount = 0;
        _releaseConcurrency(position);

        if (position.mode == RiskMode.STAKE_BACKED) {
            stakeVault.releaseReservation(_intentHash);
        } else if (position.mode == RiskMode.DEFERRED_PAYOUT && position.settledAt == 0) {
            stakeVault.releaseDeferredPayoutAuthorization(_intentHash);
        }

        emit RiskPositionReleased(_intentHash, position.taker, position.mode, releasedAmount);
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function reconcileSettlement(bytes32 _intentHash) external override nonReentrant {
        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.ACTIVE) revert PositionNotActive(_intentHash, position.status);
        _synchronizeSettlement(_intentHash, position);
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function submitChargeback(
        ChargebackAttestation calldata _attestation,
        bytes[] calldata _signatures,
        bytes calldata _verificationData
    ) external override nonReentrant {
        RiskPosition storage position = riskPositions[_attestation.intentHash];
        if (position.status != PositionStatus.ACTIVE) {
            revert PositionNotActive(_attestation.intentHash, position.status);
        }
        if (position.mode == RiskMode.NONE) revert PositionModeMismatch(_attestation.intentHash, position.mode);
        _synchronizeSettlement(_attestation.intentHash, position);

        _validateAttestation(_attestation, position);

        bytes32 digest = _hashTypedDataV4(_hashChargebackAttestation(_attestation));
        bool isValid = attestationVerifier.verify(digest, _signatures, _verificationData);
        if (!isValid) revert AttestationVerificationFailed();

        uint256 remainingReleasedAmount = position.releasedAmount - position.slashedAmount;
        uint256 slashAmount = _min(_attestation.chargebackAmount, _min(remainingReleasedAmount, position.reservedAmount));
        if (slashAmount == 0) revert ZeroAmount();

        usedAttestationNonces[_attestation.nonce] = true;
        position.slashedAmount += slashAmount;
        position.reservedAmount -= slashAmount;
        if (position.reservedAmount == 0) position.status = PositionStatus.SLASHED;

        if (position.mode == RiskMode.STAKE_BACKED) {
            stakeVault.slashReservation(_attestation.intentHash, position.maker, slashAmount);
        } else {
            stakeVault.slashDeferredPayout(_attestation.intentHash, position.maker, slashAmount);
        }

        emit ChargebackSettled(
            _attestation.intentHash,
            position.taker,
            position.maker,
            position.mode,
            _attestation.chargebackAmount,
            slashAmount,
            position.slashedAmount,
            position.reservedAmount,
            _attestation.evidenceId
        );
    }

    /* ============ Governance Functions ============ */

    /**
     * @inheritdoc IRiskTierManager
     */
    function setTierThresholds(uint256[4] calldata _thresholds) external override onlyOwner {
        _setTierThresholds(_thresholds);
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function setConcurrencyLimits(uint256[5] calldata _limits) external override onlyOwner {
        _setConcurrencyLimits(_limits);
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function setPlatformRiskConfig(
        bytes32 _paymentMethod,
        PlatformRiskConfig calldata _config
    ) external override onlyOwner {
        if (_paymentMethod == bytes32(0)) revert InvalidPlatformConfig(_paymentMethod);
        if (_config.reserveBps > BPS_DENOMINATOR) revert InvalidPlatformConfig(_paymentMethod);
        if (_config.chargebackable) {
            if (_config.reserveBps == 0 || _config.riskWindow == 0) revert InvalidPlatformConfig(_paymentMethod);
        } else if (_config.reserveBps != 0 || _config.deferredPayoutEnabled) {
            revert InvalidPlatformConfig(_paymentMethod);
        }

        platformRiskConfigs[_paymentMethod] = _config;

        emit PlatformRiskConfigUpdated(
            _paymentMethod,
            _config.enabled,
            _config.chargebackable,
            _config.deferredPayoutEnabled,
            _config.reserveBps,
            _config.riskWindow,
            _config.tierCaps[0],
            _config.tierCaps[1],
            _config.tierCaps[2],
            _config.tierCaps[3],
            _config.tierCaps[4]
        );
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function setAttestationVerifier(address _verifier) external override onlyOwner {
        if (_verifier == address(0) || _verifier.code.length == 0) revert ZeroAddress();

        address previousVerifier = address(attestationVerifier);
        attestationVerifier = IAttestationVerifier(_verifier);
        emit AttestationVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function setDeferredPayoutHook(address _hook) external override onlyOwner {
        if (_hook != address(0) && _hook.code.length == 0) revert ZeroAddress();

        address previousHook = deferredPayoutHook;
        deferredPayoutHook = _hook;
        emit DeferredPayoutHookUpdated(previousHook, _hook);
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function setTimingConfig(
        uint64 _maxIntentLifetime,
        uint64 _settlementBuffer
    ) external override onlyOwner {
        _setTimingConfig(_maxIntentLifetime, _settlementBuffer);
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function setAdmissionPaused(bool _paused) external override onlyOwner {
        admissionPaused = _paused;
        emit AdmissionPausedUpdated(_paused);
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function acceptVaultController() external override onlyOwner {
        stakeVault.acceptController();
    }

    /* ============ View Functions ============ */

    /**
     * @inheritdoc IRiskTierManager
     */
    function getTier(address _taker) public view override returns (Tier) {
        address stakeOwner = stakeVault.stakeOwnerOf(_taker);
        return getTierForStake(stakeVault.eligibleStake(stakeOwner));
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function getTierForStake(uint256 _stake) public view override returns (Tier) {
        if (_stake >= tierThresholds[3]) return Tier.PLATINUM;
        if (_stake >= tierThresholds[2]) return Tier.PRO;
        if (_stake >= tierThresholds[1]) return Tier.PLUS;
        if (_stake >= tierThresholds[0]) return Tier.PEER;
        return Tier.PEASANT;
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function getPlatformRiskConfig(
        bytes32 _paymentMethod
    ) external view override returns (PlatformRiskConfig memory) {
        return platformRiskConfigs[_paymentMethod];
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function getRiskPosition(bytes32 _intentHash) external view override returns (RiskPosition memory) {
        return riskPositions[_intentHash];
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function getTakerState(address _taker)
        external
        view
        override
        returns (Tier tier, uint256 totalStake, uint256 reserved, uint256 free, bool exiting, uint256 activeIntents)
    {
        address stakeOwner = stakeVault.stakeOwnerOf(_taker);
        totalStake = stakeVault.stakeBalance(stakeOwner);
        reserved = stakeVault.reservedStake(stakeOwner);
        free = stakeVault.freeStake(stakeOwner);
        exiting = stakeVault.isExiting(stakeOwner);
        activeIntents = activeIntentCount[stakeOwner];
        tier = getTierForStake(stakeVault.eligibleStake(stakeOwner));
    }

    /**
     * @inheritdoc IRiskTierManager
     */
    function hashChargebackAttestation(
        ChargebackAttestation calldata _attestation
    ) external view override returns (bytes32) {
        return _hashTypedDataV4(_hashChargebackAttestation(_attestation));
    }

    /* ============ Internal Functions ============ */

    function _recordSettlement(bytes32 _intentHash, uint256 _releasedAmount) internal {
        if (_releasedAmount == 0) revert ZeroAmount();

        RiskPosition storage position = riskPositions[_intentHash];
        if (position.status != PositionStatus.ACTIVE) revert PositionNotActive(_intentHash, position.status);

        _applySettlement(_intentHash, position, _releasedAmount, uint64(block.timestamp));
    }

    function _synchronizeSettlement(bytes32 _intentHash, RiskPosition storage _position) internal {
        if (_position.settledAt != 0) return;

        (uint256 releasedAmount, uint64 settledAt) = orchestrator.getIntentSettlement(_intentHash);
        if (releasedAmount == 0 || settledAt == 0) revert PositionNotSettled(_intentHash);

        _applySettlement(_intentHash, _position, releasedAmount, settledAt);
    }

    function _applySettlement(
        bytes32 _intentHash,
        RiskPosition storage _position,
        uint256 _releasedAmount,
        uint64 _settledAt
    ) internal {
        _position.settledAt = _settledAt;
        _position.releasedAmount = _releasedAmount;
        _releaseConcurrency(_position);

        if (_position.mode == RiskMode.NONE) {
            _position.status = PositionStatus.RELEASED;
            emit RiskPositionFulfilled(
                _intentHash,
                _position.taker,
                _position.mode,
                _releasedAmount,
                0,
                _settledAt,
                0,
                0
            );
            return;
        }

        uint64 slashDeadline = _toTimestamp(uint256(_settledAt) + _position.riskWindow);
        uint64 releaseTime = _toTimestamp(uint256(slashDeadline) + _position.settlementBuffer);
        _position.slashDeadline = slashDeadline;
        _position.releaseTime = releaseTime;

        if (_position.mode == RiskMode.STAKE_BACKED) {
            uint256 exactReservation = _min(
                _position.reservedAmount,
                _calculateReserve(_releasedAmount, _position.reserveBps)
            );
            _position.reservedAmount = exactReservation;
            stakeVault.updateReservation(_intentHash, exactReservation, releaseTime);
        }

        emit RiskPositionFulfilled(
            _intentHash,
            _position.taker,
            _position.mode,
            _releasedAmount,
            _position.reservedAmount,
            _settledAt,
            slashDeadline,
            releaseTime
        );
    }

    function _validateAttestation(
        ChargebackAttestation calldata _attestation,
        RiskPosition storage _position
    ) internal view {
        if (
            _attestation.chainId != block.chainid
                || _attestation.riskTierManager != address(this)
                || _attestation.orchestrator != address(orchestrator)
                || _attestation.paymentMethod != _position.paymentMethod
                || _attestation.chargebackAmount == 0
                || _attestation.evidenceId == bytes32(0)
        ) {
            revert InvalidAttestation();
        }
        if (usedAttestationNonces[_attestation.nonce]) revert AttestationNonceUsed(_attestation.nonce);
        if (block.timestamp < _attestation.validAfter) {
            revert AttestationNotYetValid(_attestation.validAfter, uint64(block.timestamp));
        }
        if (block.timestamp > _attestation.validUntil) {
            revert AttestationExpired(_attestation.validUntil, uint64(block.timestamp));
        }
        if (block.timestamp >= _position.slashDeadline) {
            revert ChargebackWindowClosed(_position.slashDeadline, uint64(block.timestamp));
        }
    }

    function _setTierThresholds(uint256[4] memory _thresholds) internal {
        if (
            _thresholds[0] == 0
                || _thresholds[0] >= _thresholds[1]
                || _thresholds[1] >= _thresholds[2]
                || _thresholds[2] >= _thresholds[3]
        ) {
            revert InvalidTierThresholds();
        }

        tierThresholds = _thresholds;
        emit TierThresholdsUpdated(_thresholds[0], _thresholds[1], _thresholds[2], _thresholds[3]);
    }

    function _setConcurrencyLimits(uint256[5] memory _limits) internal {
        for (uint256 tierIndex = 0; tierIndex < _limits.length; tierIndex++) {
            if (_limits[tierIndex] == 0) revert InvalidConcurrencyLimit(Tier(tierIndex));
        }

        concurrencyLimits = _limits;
        emit ConcurrencyLimitsUpdated(_limits[0], _limits[1], _limits[2], _limits[3], _limits[4]);
    }

    function _setTimingConfig(uint64 _maxIntentLifetime, uint64 _settlementBuffer) internal {
        if (_maxIntentLifetime == 0) revert InvalidTimingConfig();

        maxIntentLifetime = _maxIntentLifetime;
        settlementBuffer = _settlementBuffer;
        emit TimingConfigUpdated(_maxIntentLifetime, _settlementBuffer);
    }

    function _hashChargebackAttestation(
        ChargebackAttestation calldata _attestation
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHARGEBACK_ATTESTATION_TYPEHASH,
                _attestation.chainId,
                _attestation.riskTierManager,
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

    function _calculateReserve(uint256 _amount, uint16 _reserveBps) internal pure returns (uint256) {
        return Math.mulDiv(_amount, _reserveBps, BPS_DENOMINATOR, Math.Rounding.Up);
    }

    function _toTimestamp(uint256 _timestamp) internal pure returns (uint64) {
        if (_timestamp > type(uint64).max) revert InvalidTimingConfig();
        return uint64(_timestamp);
    }

    function _min(uint256 _left, uint256 _right) internal pure returns (uint256) {
        return _left < _right ? _left : _right;
    }

    function _releaseConcurrency(RiskPosition storage _position) internal {
        if (!_position.countsTowardConcurrency) return;

        _position.countsTowardConcurrency = false;
        activeIntentCount[_position.stakeOwner] -= 1;
    }
}
