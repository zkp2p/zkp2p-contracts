// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";
import {IAddressGroupRegistry} from "./interfaces/IAddressGroupRegistry.sol";
import {IEscrowV2} from "./interfaces/IEscrowV2.sol";
import {INullifierRegistryV2} from "./interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV3} from "./interfaces/IOrchestratorV3.sol";
import {IRiskManager} from "./interfaces/IRiskManager.sol";
import {IStakeVault} from "./interfaces/IStakeVault.sol";
import {ChargebackManager} from "./risk/ChargebackManager.sol";
import {MakerProtectionManager} from "./risk/MakerProtectionManager.sol";

/**
 * @title RiskManager
 * @notice Coordinates chargeback policy against a shared StakeVault.
 *
 * @dev ARCHITECTURE
 *      This is the only deployed risk-policy contract and the only StakeVault controller. Common intent identity and
 *      lifecycle state live here. `ChargebackManager` owns chargeback policy and the raw-intent coverage lock.
 *      `MakerProtectionManager` owns maker-scoped whitelist and chargeback opt-ins. The modules expose only internal
 *      lifecycle entrypoints, so Orchestrator integration remains one contract and every terminal transition stays
 *      atomic.
 *
 * @dev TRUST MODEL
 *      Orchestrator callbacks are authenticated and their canonical intent or settlement values are not redundantly
 *      shape-validated. Admission still enforces policy and Vault-token boundaries. Public maturity, reconciliation,
 *      and evidence paths retain their authorization, lifecycle, timing, cryptographic, replay, and accounting checks.
 *
 * @dev LIFECYCLE
 *      Admission snapshots common facts and chargeback policy. Unbonded settlement completes immediately; backed
 *      settlement retains full gross coverage until clean maturity or a valid chargeback. Failed-open cancellation
 *      callbacks can be reconciled permissionlessly using Orchestrator's durable original cancellation timestamp.
 */
contract RiskManager is ChargebackManager, MakerProtectionManager, Ownable2Step, ReentrancyGuard {
    /* ============ Constants ============ */

    /// @notice Compatibility getter for the sentinel maturity used by pending risk exposure.
    /// @dev Each policy module owns its operational sentinel so its lock policy remains self-contained.
    uint64 public constant NEVER_MATURES = type(uint64).max;

    /* ============ Structs ============ */

    /**
     * @dev Common intent facts composed with chargeback accounting by `getRiskPosition`.
     */
    struct IntentPosition {
        address taker;
        address depositor;
        address payoutRecipient;
        bytes32 paymentMethod;
        PositionStatus status;
        uint64 createdAt;
        uint256 intentAmount;
    }

    /* ============ Immutable Dependencies ============ */

    /// @notice Canonical source of intent admission, settlement, and failed-cancellation timestamps.
    IOrchestratorV3 public immutable override orchestrator;

    /// @notice Policy-agnostic custody, delegation, lock, and claim ledger.
    IStakeVault public immutable override stakeVault;

    /* ============ Coordinator State ============ */

    /// @notice Emergency switch for new admissions; terminal accounting remains available.
    bool public override riskTakingPaused;

    /// @dev Admission switch for future intents under each payment method.
    mapping(bytes32 => bool) internal platformEnabled;

    /// @dev Common immutable facts and aggregate lifecycle state for each admitted intent.
    mapping(bytes32 => IntentPosition) internal intentPositions;

    /* ============ Modifiers ============ */

    /**
     * @dev Restricts canonical intent lifecycle callbacks to the immutable Orchestrator.
     */
    modifier onlyOrchestrator() {
        if (msg.sender != address(orchestrator)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Creates the single coordinator for one Orchestrator and StakeVault.
     * @dev Deployment is responsible for supplying the intended dependencies. The attestation verifier may be the same
     *      verifier used by the unified payment verifier.
     * @param _owner Governance owner allowed to configure future risk policy.
     * @param _orchestratorContract Canonical intent lifecycle source.
     * @param _stakeVaultContract Shared custody and accounting ledger controlled by this contract after handover.
     * @param _attestationVerifier Initial verifier for signed chargeback evidence.
     * @param _nullifierRegistry Registry binding verified payment nullifiers to fulfilled intents.
     * @param _groupRegistry Registry resolving attached maker whitelist groups.
     */
    constructor(
        address _owner,
        IOrchestratorV3 _orchestratorContract,
        IStakeVault _stakeVaultContract,
        IAttestationVerifier _attestationVerifier,
        INullifierRegistryV2 _nullifierRegistry,
        IAddressGroupRegistry _groupRegistry
    ) ChargebackManager(_attestationVerifier, _nullifierRegistry) MakerProtectionManager(_groupRegistry) {
        orchestrator = _orchestratorContract;
        stakeVault = _stakeVaultContract;
        _transferOwnership(_owner);
    }

    /* ============ Orchestrator Lifecycle ============ */

    /**
     * @notice Records a canonical newly created intent and initializes chargeback policy.
     * @dev ORCHESTRATOR ONLY. Maker protection preferences select pass-through, whitelist rejection, or the staking
     *      path. Only the staking path applies pause, platform, and Vault-token gates and may reserve full coverage.
     * @param _intentHash Identifier of the intent readable from the calling Orchestrator.
     */
    function onIntentCreated(bytes32 _intentHash) external override onlyOrchestrator nonReentrant {
        IntentPosition storage position = intentPositions[_intentHash];
        if (position.status != PositionStatus.NONE) revert PositionAlreadyExists(_intentHash);

        IOrchestratorV3.RiskIntentData memory intent = orchestrator.getRiskIntent(_intentHash);
        IEscrowV2 escrow = IEscrowV2(intent.escrow);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(intent.depositId);
        AdmissionOutcome admission = _getEffectiveAdmission(deposit.depositor, intent.paymentMethod, intent.owner);
        if (admission == AdmissionOutcome.REJECT_NOT_WHITELISTED) {
            revert TakerNotWhitelisted(intent.owner, deposit.depositor);
        }

        bool stakingPath = admission == AdmissionOutcome.STAKING_PATH;
        if (stakingPath) {
            if (riskTakingPaused) revert RiskTakingPaused();
            if (!platformEnabled[intent.paymentMethod]) revert PlatformDisabled(intent.paymentMethod);
            _validateAdmissionBoundary(deposit);
        }

        position.taker = intent.owner;
        position.depositor = deposit.depositor;
        position.payoutRecipient = intent.to;
        position.paymentMethod = intent.paymentMethod;
        position.status = PositionStatus.PENDING;
        position.createdAt = intent.createdAt;
        position.intentAmount = intent.amount;

        (RiskMode mode, address stakeOwner, uint256 coverageAmount, uint64 riskWindow) =
            _admitChargeback(_intentHash, intent.owner, intent.to, intent.paymentMethod, intent.amount, stakingPath);

        emit RiskPositionCreated(
            _intentHash,
            stakeOwner,
            deposit.depositor,
            intent.owner,
            intent.paymentMethod,
            mode,
            intent.amount,
            coverageAmount,
            riskWindow
        );
    }

    /**
     * @notice Resolves risk accounting for an intent cancelled or expired by Orchestrator.
     * @dev ORCHESTRATOR ONLY. A failed callback can be replayed through `reconcileCancellation` using Orchestrator's
     *      stored original cancellation timestamp.
     * @param _intentHash Identifier of the intent being cancelled.
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator nonReentrant {
        _cancelPosition(_intentHash, _chargebackTimestamp());
    }

    /**
     * @notice Atomically resolves chargeback policy before settlement distribution.
     * @dev ORCHESTRATOR ONLY. Canonical settlement context is trusted. The hook consumes no tokens for unbonded or
     *      stake-backed settlement and exactly `grossAmount` for deferred settlement.
     * @param _context Canonical settlement amounts, fee plan, intent identifier, and release type.
     */
    function settleIntent(RiskSettlementContext calldata _context) external override onlyOrchestrator nonReentrant {
        IntentPosition storage position = intentPositions[_context.intentHash];
        if (position.status != PositionStatus.PENDING) {
            revert PositionNotPending(_context.intentHash, position.status);
        }

        (address stakeOwner, RiskMode mode, uint256 coverageAmount, uint64 coverageDeadline) =
            _settleChargeback(_context);

        position.status = mode == RiskMode.UNBONDED ? PositionStatus.RELEASED : PositionStatus.SETTLED;

        emit RiskPositionSettled(
            _context.intentHash,
            stakeOwner,
            position.depositor,
            mode,
            _context.grossAmount,
            _context.executableAmount,
            coverageAmount,
            coverageDeadline,
            _context.isManualRelease
        );
    }

    /* ============ Permissionless Lifecycle Recovery ============ */

    /**
     * @notice Completes risk accounting for one cancellation whose original callback failed open.
     * @dev ANYONE. Uses the durable original cancellation timestamp and acknowledges it only after accounting succeeds.
     * @param _intentHash Identifier of the cancelled intent to reconcile.
     */
    function reconcileCancellation(bytes32 _intentHash) external override nonReentrant {
        _reconcileCancellation(_intentHash);
    }

    /**
     * @notice Completes risk accounting for a batch of failed-open cancellation callbacks.
     * @dev ANYONE. An empty batch is a successful no-op. Any failure otherwise reverts the complete batch.
     * @param _intentHashes Identifiers of cancelled intents to reconcile in order.
     */
    function reconcileCancellations(bytes32[] calldata _intentHashes) external override nonReentrant {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _reconcileCancellation(_intentHashes[intentIndex]);
        }
    }

    /**
     * @notice Releases one settled chargeback position after its risk window matures cleanly.
     * @dev ANYONE. Backed stake becomes free; deferred coverage vests stored fee claims and frees the net amount.
     * @param _intentHash Identifier of the matured position.
     */
    function releaseMaturedPosition(bytes32 _intentHash) external override nonReentrant {
        _releaseMaturedPosition(_intentHash);
    }

    /**
     * @notice Releases a batch of settled positions whose risk windows have matured cleanly.
     * @dev ANYONE. An empty batch is a successful no-op. Any failure otherwise reverts the complete batch.
     * @param _intentHashes Identifiers of matured positions to release in order.
     */
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external override nonReentrant {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _releaseMaturedPosition(_intentHashes[intentIndex]);
        }
    }

    /* ============ Chargebacks ============ */

    /**
     * @notice Resolves a fully covered settled position into an immediately claimable LP award.
     * @dev ANYONE may relay valid evidence before the half-open coverage deadline. Proof-based settlements require the
     *      original payment nullifier to bind to this exact intent; manual releases do not.
     * @param _attestation Intent-bound evidence, payload hash, signatures, and encoded chargeback details.
     */
    function submitChargeback(ChargebackAttestation calldata _attestation) external override nonReentrant {
        IntentPosition storage position = intentPositions[_attestation.intentHash];
        if (position.status != PositionStatus.SETTLED) {
            revert PositionNotSettled(_attestation.intentHash, position.status);
        }

        (address stakeOwner, RiskMode mode, uint256 compensatedAmount, bytes32 disputeId) =
            _submitChargeback(_attestation, position.paymentMethod, position.depositor);
        position.status = PositionStatus.SLASHED;

        emit ChargebackSettled(
            _attestation.intentHash, stakeOwner, position.depositor, mode, compensatedAmount, disputeId
        );
    }

    /* ============ Governance ============ */

    /**
     * @notice GOVERNANCE ONLY: Seeds existing makers' protection opt-ins after redeployment.
     * @dev This one-time initialization reverts after its first successful call.
     * @param _makers Existing maker configurations to seed.
     */
    function initializeMakerConfigs(MakerInit[] calldata _makers) external override onlyOwner {
        _initializeMakerConfigs(_makers);
    }

    /**
     * @notice GOVERNANCE ONLY: Sets policy used by future intents for one payment method.
     * @dev Existing positions retain their snapshots.
     * @param _paymentMethod Payment-method key whose future policy is configured.
     * @param _config Enabled state and chargeback policy.
     */
    function setPlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config)
        external
        override
        onlyOwner
    {
        platformEnabled[_paymentMethod] = _config.enabled;
        _setChargebackConfig(_paymentMethod, _config.chargeback);

        emit PlatformRiskConfigUpdated(
            _paymentMethod,
            _config.enabled,
            _config.chargeback.chargebackable,
            _config.chargeback.deferredPayoutEnabled,
            _config.chargeback.riskWindow
        );
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for subsequent chargeback submissions.
     * @dev The verifier may be the same instance used for payment attestations. The update affects unresolved positions.
     * @param _verifier New non-zero deployed chargeback attestation verifier.
     */
    function setAttestationVerifier(address _verifier) external override onlyOwner {
        address previousVerifier = _setChargebackAttestationVerifier(IAttestationVerifier(_verifier));
        emit AttestationVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice GOVERNANCE ONLY: Pauses or resumes new admissions.
     * @dev Existing positions can still cancel, settle, reconcile, mature, or process a chargeback while paused.
     * @param _paused True to stop new risk taking; false to resume it.
     */
    function setRiskTakingPaused(bool _paused) external override onlyOwner {
        riskTakingPaused = _paused;
        emit RiskTakingPausedUpdated(_paused);
    }

    /**
     * @notice GOVERNANCE ONLY: Accepts this contract as StakeVault controller after its handover delay.
     */
    function acceptVaultController() external override onlyOwner {
        stakeVault.acceptController();
    }

    /**
     * @notice Disables ownership renunciation so governed safety controls cannot become unreachable.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ Views ============ */

    /**
     * @notice Returns policy that will apply to future intents for a payment method.
     * @param _paymentMethod Payment-method key to query.
     * @return config Current aggregate platform risk configuration.
     */
    function getPlatformRiskConfig(bytes32 _paymentMethod) external view override returns (PlatformRiskConfig memory) {
        return PlatformRiskConfig({
            enabled: platformEnabled[_paymentMethod], chargeback: _getChargebackConfig(_paymentMethod)
        });
    }

    /**
     * @notice Returns the maker protection matrix outcome for a maker, payment method, and taker.
     * @dev This view excludes pause, platform-enabled, token, and live free-stake checks.
     * @param _maker Maker whose protection preferences apply.
     * @param _paymentMethod Payment method selecting maker and platform chargeback policy.
     * @param _taker Taker evaluated against the maker's direct and group whitelist.
     * @return outcome Pass-through admission, whitelist rejection, or the staking path.
     */
    function getEffectiveAdmission(address _maker, bytes32 _paymentMethod, address _taker)
        external
        view
        override
        returns (AdmissionOutcome outcome)
    {
        return _getEffectiveAdmission(_maker, _paymentMethod, _taker);
    }

    /**
     * @notice Returns the aggregate policy snapshot and lifecycle accounting for one intent.
     * @dev Fields are composed from common and chargeback-module storage.
     * @param _intentHash Intent identifier to query.
     * @return position Aggregate risk position, or a zero-valued position before admission.
     */
    function getRiskPosition(bytes32 _intentHash) external view override returns (RiskPosition memory position) {
        IntentPosition storage common = intentPositions[_intentHash];
        ChargebackPosition memory chargeback = _getChargebackPosition(_intentHash);

        position = RiskPosition({
            taker: common.taker,
            stakeOwner: chargeback.stakeOwner,
            lp: common.depositor,
            payoutRecipient: common.payoutRecipient,
            paymentMethod: common.paymentMethod,
            mode: chargeback.mode,
            status: common.status,
            isManualRelease: chargeback.isManualRelease,
            riskWindow: chargeback.riskWindow,
            createdAt: common.createdAt,
            coverageDeadline: chargeback.coverageDeadline,
            intentAmount: common.intentAmount,
            coverageAmount: chargeback.coverageAmount,
            grossReleasedAmount: chargeback.grossReleasedAmount,
            executableAmount: chargeback.executableAmount
        });
    }

    /**
     * @notice Returns contingent fee allocations retained for a deferred-payout position.
     * @param _intentHash Deferred-payout intent identifier.
     * @return allocations Exact non-zero fee claims that vest on clean maturity.
     */
    function getDeferredFeeAllocations(bytes32 _intentHash)
        external
        view
        override
        returns (FeeAllocation[] memory allocations)
    {
        return _getDeferredFeeAllocations(_intentHash);
    }

    /**
     * @notice Returns the selected stake owner and its portfolio-wide Vault balances for a taker.
     * @param _taker Taker whose live selected stake owner should be resolved.
     * @return stakeOwner Live selected stake owner.
     * @return totalStake Stake owner's total principal balance.
     * @return lockedStake Stake owner's principal committed across active locks.
     * @return freeStake Stake owner's immediately available principal.
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

    /* ============ Public Helpers ============ */

    /**
     * @notice Returns the manager- and chain-bound digest signed for chargeback evidence.
     * @dev Commits to the attestation's intent and payload hash under this manager's EIP-712 domain.
     * @param _attestation Chargeback evidence whose typed-data digest should be derived.
     * @return EIP-712 digest consumed by the configured attestation verifier.
     */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation)
        external
        view
        override
        returns (bytes32)
    {
        return _chargebackAttestationDigest(_attestation);
    }

    /* ============ Internal Lifecycle ============ */

    function _getEffectiveAdmission(address _maker, bytes32 _paymentMethod, address _taker)
        internal
        view
        returns (AdmissionOutcome)
    {
        MakerProtectionConfig storage config = makerProtectionConfigs[_maker];
        bool whitelistEnabled = config.whitelistEnabled;
        bool effectiveChargeback =
            chargebackProtectionEnabled[_maker][_paymentMethod] && chargebackConfigs[_paymentMethod].chargebackable;

        if (!whitelistEnabled) {
            return effectiveChargeback ? AdmissionOutcome.STAKING_PATH : AdmissionOutcome.ADMIT_UNBONDED;
        }

        bool whitelistPassed = _isTakerAllowed(_maker, _taker);
        if (!effectiveChargeback) {
            return whitelistPassed ? AdmissionOutcome.ADMIT_UNBONDED : AdmissionOutcome.REJECT_NOT_WHITELISTED;
        }
        if (config.requireBothProtections) {
            return whitelistPassed ? AdmissionOutcome.STAKING_PATH : AdmissionOutcome.REJECT_NOT_WHITELISTED;
        }
        return whitelistPassed ? AdmissionOutcome.ADMIT_UNBONDED : AdmissionOutcome.STAKING_PATH;
    }

    /**
     * @dev Resolves pending chargeback exposure and records cancellation.
     */
    function _cancelPosition(bytes32 _intentHash, uint64 _cancelledAt) internal {
        IntentPosition storage position = intentPositions[_intentHash];
        if (position.status != PositionStatus.PENDING) revert PositionNotPending(_intentHash, position.status);

        (address stakeOwner,, uint256 releasedCoverage) = _cancelChargeback(_intentHash);
        position.status = PositionStatus.CANCELLED;

        emit RiskPositionCancelled(_intentHash, stakeOwner, position.depositor, _cancelledAt, releasedCoverage);
    }

    /**
     * @dev Replays one failed-open cancellation and acknowledges it only after complete accounting succeeds.
     */
    function _reconcileCancellation(bytes32 _intentHash) internal {
        uint64 cancelledAt = orchestrator.getIntentCancellation(_intentHash);
        if (cancelledAt == 0) revert CancellationNotRecorded(_intentHash);
        _cancelPosition(_intentHash, cancelledAt);
        orchestrator.acknowledgeIntentCancellation(_intentHash);
    }

    /**
     * @dev Applies clean maturity and records the aggregate RELEASED state.
     */
    function _releaseMaturedPosition(bytes32 _intentHash) internal {
        IntentPosition storage position = intentPositions[_intentHash];
        if (position.status != PositionStatus.SETTLED) revert PositionNotSettled(_intentHash, position.status);

        position.status = PositionStatus.RELEASED;
        (address stakeOwner, RiskMode mode, uint256 releasedCoverage) = _releaseMaturedChargeback(_intentHash);
        emit RiskPositionReleased(_intentHash, stakeOwner, mode, releasedCoverage);
    }

    /**
     * @dev Enforces external protocol boundaries that are not guaranteed merely by callback authentication.
     */
    function _validateAdmissionBoundary(IEscrowV2.Deposit memory _deposit) internal view {
        address expectedToken = address(stakeVault.stakeToken());
        if (address(_deposit.token) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(_deposit.token));
        }
    }

    /* ============ Module Dependencies ============ */

    /**
     * @dev Lazily reads the post-intent hook only when chargeback admission needs deferred payout.
     */
    function _getPostIntentHook(bytes32 _intentHash) internal view override returns (address) {
        return address(orchestrator.getIntent(_intentHash).postIntentHook);
    }

    /**
     * @dev Supplies the shared custody ledger to the chargeback module.
     */
    function _stakeVault() internal view override returns (IStakeVault) {
        return stakeVault;
    }
}
