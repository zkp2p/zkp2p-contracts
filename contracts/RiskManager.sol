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
 * @notice Applies intent-extension and chargeback policy to the generic StakeVault ledger.
 * @dev StakeVault owns custody and accounting only. This contract exclusively decides why stake is locked,
 *      when a lock resolves, and which beneficiaries receive claims.
 */
contract RiskManager is IRiskManager, Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_HOUR = 1 hours;
    uint256 public constant EXTENSION_DENOMINATOR = BPS_DENOMINATOR * SECONDS_PER_HOUR;
    uint64 public constant MAX_TOTAL_INTENT_LIFETIME = 5 days;
    uint64 public constant MAX_RISK_WINDOW = 365 days;
    uint64 public constant NEVER_MATURES = type(uint64).max;
    uint256 public constant MAX_FEE_ALLOCATIONS = 12;

    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH =
        keccak256("ChargebackAttestation(bytes32 intentHash,bytes32 dataHash)");
    bytes32 public constant EXTENSION_LOCK_NAMESPACE = keccak256("ZKP2P_INTENT_EXTENSION");

    IOrchestratorV3 public immutable override orchestrator;
    IStakeVault public immutable override stakeVault;
    INullifierRegistryV2 public immutable override nullifierRegistry;

    IAttestationVerifier public override attestationVerifier;
    bool public override riskTakingPaused;

    mapping(bytes32 => PlatformRiskConfig) internal platformRiskConfigs;
    mapping(bytes32 => RiskPosition) internal riskPositions;
    mapping(bytes32 => FeeAllocation[]) internal deferredFeeAllocations;
    mapping(bytes32 => bool) public override usedChargebackNullifiers;

    modifier onlyOrchestrator() {
        if (msg.sender != address(orchestrator)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

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

    /**
     * @inheritdoc IIntentRiskHook
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
     * @inheritdoc IIntentRiskHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator nonReentrant {
        _cancelPosition(_intentHash, _currentTimestamp());
    }

    /**
     * @inheritdoc IIntentRiskHook
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

    /**
     * @inheritdoc IRiskManager
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

    /**
     * @inheritdoc IRiskManager
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
     * @inheritdoc IRiskManager
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

    /**
     * @inheritdoc IRiskManager
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
    function setRiskTakingPaused(bool _paused) external override onlyOwner {
        riskTakingPaused = _paused;
        emit RiskTakingPausedUpdated(_paused);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function acceptVaultController() external override onlyOwner {
        stakeVault.acceptController();
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /**
     * @inheritdoc IRiskManager
     */
    function getPlatformRiskConfig(bytes32 _paymentMethod) external view override returns (PlatformRiskConfig memory) {
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
     */
    function getDeferredFeeAllocations(bytes32 _intentHash) external view override returns (FeeAllocation[] memory) {
        return deferredFeeAllocations[_intentHash];
    }

    /**
     * @inheritdoc IRiskManager
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

    /**
     * @inheritdoc IRiskManager
     */
    function calculateIntentExtensionCost(
        uint256 _intentAmount,
        uint64 _extensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) external pure override returns (uint256) {
        return _calculateIntentExtensionCost(_intentAmount, _extensionTime, _extensionPenaltyBpsPerHour);
    }

    /**
     * @inheritdoc IRiskManager
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
     * @inheritdoc IRiskManager
     */
    function extensionLockId(bytes32 _intentHash) external pure override returns (bytes32) {
        return _extensionLockId(_intentHash);
    }

    /**
     * @inheritdoc IRiskManager
     */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation)
        external
        view
        override
        returns (bytes32)
    {
        return _hashTypedDataV4(_hashChargebackAttestation(_attestation));
    }

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

    function _reconcileCancellation(bytes32 _intentHash) internal {
        uint64 cancelledAt = orchestrator.getIntentCancellation(_intentHash);
        if (cancelledAt == 0) revert CancellationNotRecorded(_intentHash);
        _cancelPosition(_intentHash, cancelledAt);
        orchestrator.acknowledgeIntentCancellation(_intentHash);
    }

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

    function _deferredClaims(bytes32 _intentHash) internal view returns (IStakeVault.Claim[] memory claims) {
        FeeAllocation[] storage allocations = deferredFeeAllocations[_intentHash];
        claims = new IStakeVault.Claim[](allocations.length);
        for (uint256 feeIndex = 0; feeIndex < allocations.length; feeIndex++) {
            claims[feeIndex] =
                IStakeVault.Claim({beneficiary: allocations[feeIndex].recipient, amount: allocations[feeIndex].amount});
        }
    }

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

    function _validateIntentToken(IERC20 _intentToken) internal view {
        address expectedToken = address(stakeVault.stakeToken());
        if (address(_intentToken) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(_intentToken));
        }
    }

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

    function _extensionLockId(bytes32 _intentHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(EXTENSION_LOCK_NAMESPACE, _intentHash));
    }

    function _hashChargebackAttestation(ChargebackAttestation calldata _attestation) internal pure returns (bytes32) {
        return keccak256(abi.encode(CHARGEBACK_ATTESTATION_TYPEHASH, _attestation.intentHash, _attestation.dataHash));
    }

    function _currentTimestamp() internal view returns (uint64) {
        return _toTimestamp(block.timestamp);
    }

    function _toTimestamp(uint256 _timestamp) internal pure returns (uint64) {
        if (_timestamp > type(uint64).max) revert TimestampOverflow(_timestamp);
        return uint64(_timestamp);
    }

    function _min(uint256 _left, uint256 _right) internal pure returns (uint256) {
        return _left < _right ? _left : _right;
    }
}
