// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IChargebackPolicy} from "../interfaces/IChargebackPolicy.sol";
import {IEscrowRegistry} from "../interfaces/IEscrowRegistry.sol";
import {IEscrowV2} from "../interfaces/IEscrowV2.sol";
import {INullifierRegistryV2} from "../interfaces/INullifierRegistryV2.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";

/**
 * @title ChargebackPolicy
 * @notice Deposit-scoped, stake-backed chargeback coverage for intent settlement.
 * @dev The policy owns no tokens. It controls StakeVault locks and converts valid chargebacks into depositor claims.
 * `escrowRegistry` is governance-settable and MUST be kept in sync with the orchestrator's escrow registry, because
 * divergence can leave deposits admitted by one component but unavailable for depositor chargeback configuration.
 *
 * TRUST: Positions are keyed by intent hash, which embeds the originating orchestrator (OrchestratorV3 hashes its own
 * address into every intent hash), so identities never collide across orchestrators. Positions are NOT
 * orchestrator-bound: lifecycle entrypoints trust that every orchestrator admitted to OrchestratorRegistry (and
 * therefore able to reach this policy through the lifecycle hook) invokes callbacks only for intents it created. A
 * registered orchestrator that reported foreign intent hashes could cancel or settle another orchestrator's
 * coverage. Registering an orchestrator is a governance action that vouches for exactly this behavior.
 */
contract ChargebackPolicy is IChargebackPolicy, Ownable2Step, ReentrancyGuard, EIP712 {
    /* ============ Constants ============ */

    uint64 public constant MAX_RISK_WINDOW = 365 days;
    uint64 public constant PENDING_COVERAGE_MATURITY = type(uint64).max;
    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH =
        keccak256("ChargebackAttestation(bytes32 intentHash,bytes32 dataHash)");

    /* ============ State Variables ============ */

    IStakeVault public immutable override stakeVault;
    INullifierRegistryV2 public immutable override nullifierRegistry;
    IAttestationVerifier public override attestationVerifier;
    IEscrowRegistry public override escrowRegistry;
    address public override lifecycleHook;
    bool public override admissionsPaused;

    mapping(address => mapping(uint256 => bool)) public override enabled;
    mapping(bytes32 => uint64) public override riskWindows;
    mapping(bytes32 => Position) internal positions;
    mapping(bytes32 => bool) public override usedChargebackNullifiers;

    /* ============ Constructor ============ */

    constructor(
        address _owner,
        IStakeVault _stakeVault,
        INullifierRegistryV2 _nullifierRegistry,
        IAttestationVerifier _attestationVerifier,
        IEscrowRegistry _escrowRegistry
    ) EIP712("ZKP2P ChargebackPolicy", "1") {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_stakeVault));
        _validateDependency(address(_nullifierRegistry));
        _validateDependency(address(_attestationVerifier));
        _validateDependency(address(_escrowRegistry));

        stakeVault = _stakeVault;
        nullifierRegistry = _nullifierRegistry;
        attestationVerifier = _attestationVerifier;
        escrowRegistry = _escrowRegistry;
        _transferOwnership(_owner);
    }

    /* ============ Modifiers ============ */

    modifier onlyLifecycleHook() {
        if (msg.sender != lifecycleHook) revert UnauthorizedLifecycleHook(msg.sender);
        _;
    }

    modifier onlyDepositor(address _escrow, uint256 _depositId) {
        if (!escrowRegistry.isWhitelistedEscrow(_escrow) && !escrowRegistry.isAcceptingAllEscrows()) {
            revert EscrowNotWhitelisted(_escrow);
        }

        address depositor = IEscrowV2(_escrow).getDeposit(_depositId).depositor;
        if (depositor == address(0)) revert DepositNotFound(_escrow, _depositId);
        if (msg.sender != depositor) revert NotDepositor(_escrow, _depositId, msg.sender);
        _;
    }

    /* ============ Lifecycle Functions ============ */

    /**
     * @notice Opens stake-backed coverage for a chargeback-enabled intent.
     * @dev A zero risk window passes through before paused, enabled, or duplicate checks because a
     * non-chargebackable method uses direct access and pass-through is not an admission.
     */
    function admitIntent(
        bytes32 _intentHash,
        address _escrow,
        uint256 _depositId,
        address _taker,
        bytes32 _paymentMethod,
        uint256 _amount
    ) external override onlyLifecycleHook nonReentrant {
        uint64 riskWindow = riskWindows[_paymentMethod];
        if (riskWindow == 0) return;

        if (admissionsPaused) revert AdmissionsPaused();
        if (positions[_intentHash].status != PositionStatus.NONE) revert PositionAlreadyExists(_intentHash);
        if (!enabled[_escrow][_depositId]) revert ChargebackNotEnabled(_escrow, _depositId);

        IEscrowV2.Deposit memory deposit = IEscrowV2(_escrow).getDeposit(_depositId);
        address expectedToken = address(stakeVault.stakeToken());
        if (address(deposit.token) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(deposit.token));
        }

        address stakeOwner = stakeVault.stakeOwnerOf(_taker);
        uint256 available = stakeVault.freeStake(stakeOwner);
        if (available < _amount) revert InsufficientCollateral(stakeOwner, available, _amount);

        positions[_intentHash] = Position({
            taker: _taker,
            stakeOwner: stakeOwner,
            depositor: deposit.depositor,
            paymentMethod: _paymentMethod,
            status: PositionStatus.PENDING,
            isManualRelease: false,
            riskWindow: riskWindow,
            coverageDeadline: 0,
            intentAmount: _amount,
            coverageAmount: _amount,
            grossReleasedAmount: 0
        });

        stakeVault.lockStake(stakeOwner, _intentHash, _amount, PENDING_COVERAGE_MATURITY);
        emit PositionOpened(
            _intentHash, stakeOwner, deposit.depositor, _taker, _paymentMethod, _amount, riskWindow
        );
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyLifecycleHook nonReentrant {
        Position storage position = positions[_intentHash];
        if (position.status == PositionStatus.NONE) return;
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_intentHash, position.status);
        }

        uint256 releasedCoverage = position.coverageAmount;
        position.coverageAmount = 0;
        position.status = PositionStatus.CANCELLED;
        stakeVault.unlockStake(_intentHash);
        emit PositionCancelled(_intentHash, position.stakeOwner, releasedCoverage);
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function onIntentSettled(bytes32 _intentHash, uint256 _grossAmount, bool _isManualRelease)
        external
        override
        onlyLifecycleHook
        nonReentrant
    {
        Position storage position = positions[_intentHash];
        if (position.status == PositionStatus.NONE) return;
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_intentHash, position.status);
        }

        uint64 coverageDeadline = _calculateCoverageDeadline(position.riskWindow);
        position.grossReleasedAmount = _grossAmount;
        position.isManualRelease = _isManualRelease;
        position.coverageDeadline = coverageDeadline;
        position.coverageAmount = _grossAmount;
        position.status = PositionStatus.SETTLED;

        stakeVault.resizeLock(_intentHash, _grossAmount, coverageDeadline);
        emit PositionSettled(
            _intentHash,
            position.stakeOwner,
            position.depositor,
            _grossAmount,
            coverageDeadline,
            _isManualRelease
        );
    }

    /* ============ Permissionless Functions ============ */

    /**
     * @inheritdoc IChargebackPolicy
     */
    function releaseMaturedPosition(bytes32 _intentHash) external override nonReentrant {
        _releaseMaturedPosition(_intentHash);
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external override nonReentrant {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _releaseMaturedPosition(_intentHashes[intentIndex]);
        }
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function submitChargeback(ChargebackAttestation calldata _attestation) external override nonReentrant {
        Position storage position = positions[_attestation.intentHash];
        if (position.status != PositionStatus.SETTLED) {
            revert PositionNotSettled(_attestation.intentHash, position.status);
        }

        (bytes32 disputeId, bytes32 disputeNullifier) = _validateChargebackAttestation(_attestation, position);
        bytes32 digest = _hashTypedDataV4(_chargebackAttestationStructHash(_attestation));
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }

        uint256 compensatedAmount = position.grossReleasedAmount;
        if (position.coverageAmount != compensatedAmount) {
            revert IncompleteChargebackCoverage(position.coverageAmount, compensatedAmount);
        }

        usedChargebackNullifiers[disputeNullifier] = true;
        position.coverageAmount = 0;
        position.status = PositionStatus.SLASHED;

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: position.depositor, amount: compensatedAmount});
        stakeVault.resolveLock(_attestation.intentHash, claims);

        emit ChargebackSettled(
            _attestation.intentHash,
            position.stakeOwner,
            position.depositor,
            compensatedAmount,
            disputeId
        );
    }

    /* ============ Depositor Functions ============ */

    /**
     * @inheritdoc IChargebackPolicy
     */
    function setEnabled(address _escrow, uint256 _depositId, bool _enabled)
        external
        override
        onlyDepositor(_escrow, _depositId)
    {
        enabled[_escrow][_depositId] = _enabled;
        emit EnabledUpdated(_escrow, _depositId, _enabled);
    }

    /* ============ Governance Functions ============ */

    /**
     * @inheritdoc IChargebackPolicy
     */
    function setRiskWindow(bytes32 _paymentMethod, uint64 _riskWindow) external override onlyOwner {
        if (_riskWindow > MAX_RISK_WINDOW) revert InvalidRiskWindow(_riskWindow);
        riskWindows[_paymentMethod] = _riskWindow;
        emit RiskWindowUpdated(_paymentMethod, _riskWindow);
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function setAttestationVerifier(address _verifier) external override onlyOwner {
        _validateDependency(_verifier);
        address previousVerifier = address(attestationVerifier);
        attestationVerifier = IAttestationVerifier(_verifier);
        emit AttestationVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function setLifecycleHook(address _hook) external override onlyOwner {
        _validateDependency(_hook);
        address previousHook = lifecycleHook;
        lifecycleHook = _hook;
        emit LifecycleHookUpdated(previousHook, _hook);
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function setEscrowRegistry(IEscrowRegistry _escrowRegistry) external override onlyOwner {
        _validateDependency(address(_escrowRegistry));
        escrowRegistry = _escrowRegistry;
        emit EscrowRegistryUpdated(address(_escrowRegistry));
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function setAdmissionsPaused(bool _paused) external override onlyOwner {
        admissionsPaused = _paused;
        emit AdmissionsPausedUpdated(_paused);
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function acceptVaultController() external override onlyOwner {
        stakeVault.acceptController();
    }

    /**
     * @notice Disables ownership renunciation so governed safety controls cannot become unreachable.
     */
    function renounceOwnership() public view override(IChargebackPolicy, Ownable) onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /**
     * @inheritdoc IChargebackPolicy
     */
    function getPosition(bytes32 _intentHash) external view override returns (Position memory) {
        return positions[_intentHash];
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation)
        external
        view
        override
        returns (bytes32)
    {
        return _hashTypedDataV4(_chargebackAttestationStructHash(_attestation));
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function getTakerState(address _taker)
        external
        view
        override
        returns (address stakeOwner, uint256 totalStake, uint256 lockedStake, uint256 freeStake)
    {
        stakeOwner = stakeVault.stakeOwnerOf(_taker);
        totalStake = stakeVault.stakeBalance(stakeOwner);
        lockedStake = stakeVault.lockedStake(stakeOwner);
        freeStake = stakeVault.freeStake(stakeOwner);
    }

    /* ============ Internal Functions ============ */

    function _releaseMaturedPosition(bytes32 _intentHash) internal {
        Position storage position = positions[_intentHash];
        if (position.status != PositionStatus.SETTLED) {
            revert PositionNotSettled(_intentHash, position.status);
        }

        uint64 currentTime = _currentTimestamp();
        uint64 coverageDeadline = position.coverageDeadline;
        if (coverageDeadline == 0 || currentTime < coverageDeadline) {
            revert PositionNotMature(coverageDeadline, currentTime);
        }

        uint256 releasedCoverage = position.coverageAmount;
        position.coverageAmount = 0;
        position.status = PositionStatus.RELEASED;
        stakeVault.unlockStake(_intentHash);
        emit PositionReleased(_intentHash, position.stakeOwner, releasedCoverage);
    }

    function _validateChargebackAttestation(
        ChargebackAttestation calldata _attestation,
        Position storage _position
    ) internal view returns (bytes32 disputeId, bytes32 disputeNullifier) {
        if (keccak256(_attestation.data) != _attestation.dataHash) {
            revert InvalidAttestation();
        }
        if (block.timestamp >= _position.coverageDeadline) {
            revert ChargebackWindowClosed(_position.coverageDeadline, _currentTimestamp());
        }

        ChargebackDetails memory details = abi.decode(_attestation.data, (ChargebackDetails));
        if (details.paymentMethod != _position.paymentMethod) revert InvalidAttestation();

        if (!_position.isManualRelease) {
            bytes32 paymentNullifier = keccak256(abi.encodePacked(details.paymentMethod, details.originalPaymentId));
            if (
                nullifierRegistry.intentHashByNullifier(paymentNullifier) != _attestation.intentHash
                    || nullifierRegistry.nullifierByIntentHash(_attestation.intentHash) != paymentNullifier
            ) {
                revert InvalidPaymentBinding(_attestation.intentHash, paymentNullifier);
            }
        }

        disputeId = details.disputeId;
        disputeNullifier = keccak256(abi.encodePacked(details.paymentMethod, details.disputeId));
        if (usedChargebackNullifiers[disputeNullifier]) revert ChargebackEvidenceUsed(disputeNullifier);
    }

    function _chargebackAttestationStructHash(ChargebackAttestation calldata _attestation)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(CHARGEBACK_ATTESTATION_TYPEHASH, _attestation.intentHash, _attestation.dataHash));
    }

    function _calculateCoverageDeadline(uint64 _riskWindow) internal view returns (uint64) {
        uint256 deadline = block.timestamp + _riskWindow;
        if (deadline > type(uint64).max) revert TimestampOverflow(deadline);
        return uint64(deadline);
    }

    function _currentTimestamp() internal view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow(block.timestamp);
        return uint64(block.timestamp);
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidContract(_dependency);
    }
}
