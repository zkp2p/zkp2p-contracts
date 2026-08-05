// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IChargebackPolicy} from "../interfaces/IChargebackPolicy.sol";
import {IChargebackVerifier} from "../interfaces/IChargebackVerifier.sol";
import {IEscrowV2} from "../interfaces/IEscrowV2.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";

/**
 * @title ChargebackPolicy
 * @notice Deposit-scoped, stake-backed chargeback coverage for intent settlement.
 * @dev The policy owns no tokens. StakeVault is the source of truth for collateral locks, a dedicated
 * `chargebackNullifierRegistry` deployment is the source of truth for consumed dispute nullifiers, and the calling
 * Orchestrator is the source of truth for valid escrows and intents.
 *
 * TRUST: Chargeback intents are keyed by intent hash, which embeds the originating orchestrator
 * (OrchestratorV3 hashes its own address into every intent hash), so identities do not collide across orchestrators.
 * Lifecycle entrypoints trust every orchestrator admitted by OrchestratorRegistry to invoke callbacks only for
 * intents it created and already validated against its EscrowRegistry. Registering an orchestrator is therefore a
 * governance assertion about its callback behavior.
 *
 * Governance must authorize a lifecycle hook here before configuring it on an Orchestrator. Predecessor hooks must
 * remain authorized until all intents snapshotted to them have been cancelled or settled. Likewise, an orchestrator
 * must be drained before it is removed from OrchestratorRegistry. This policy must also drain every active chargeback
 * intent before StakeVault controller authority moves to a replacement policy unless that replacement explicitly adopts
 * this policy's intent and lock state.
 */
contract ChargebackPolicy is IChargebackPolicy, Ownable2Step, ReentrancyGuard {
    /* ============ Constants ============ */

    uint64 public constant MAX_RISK_WINDOW = 365 days;
    uint64 public constant PENDING_COVERAGE_MATURITY = type(uint64).max;

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVault public immutable stakeVault;

    /// @notice Dedicated replay registry for payment-method-scoped chargeback dispute nullifiers.
    INullifierRegistry public immutable chargebackNullifierRegistry;

    /// @notice Verifier used to validate signed chargeback evidence.
    IChargebackVerifier public chargebackVerifier;

    /// @notice Whether new chargeback-backed admissions are paused. Terminal transitions remain available.
    bool public admissionsPaused;

    /// @dev Lifecycle-hook authorization keyed by lifecycle hook address.
    mapping(address => bool) internal isLifecycleHookAuthorizedByHook;

    /// @dev Whether chargebacks are enabled for each escrow deposit.
    mapping(address => mapping(uint256 => bool)) internal isDepositChargebackEnabled;

    /// @dev Minimum collateral lock window for each payment method.
    mapping(bytes32 => uint64) internal paymentMethodRiskWindow;

    /// @dev Chargeback lifecycle state keyed by globally unique intent hash.
    mapping(bytes32 => ChargebackIntent) internal chargebackIntentByIntentHash;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a chargeback policy over one StakeVault and one dedicated dispute-nullifier registry.
     * @dev After deployment, authorize this policy as the StakeVault controller and as a writer on the dedicated
     * chargeback nullifier registry before enabling deposits.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _stakeVault Vault holding and locking taker collateral.
     * @param _chargebackVerifier Verifier for signed chargeback evidence.
     * @param _chargebackNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     */
    constructor(
        address _owner,
        IStakeVault _stakeVault,
        IChargebackVerifier _chargebackVerifier,
        INullifierRegistry _chargebackNullifierRegistry
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_stakeVault));
        _validateDependency(address(_chargebackVerifier));
        _validateDependency(address(_chargebackNullifierRegistry));

        stakeVault = _stakeVault;
        chargebackVerifier = _chargebackVerifier;
        chargebackNullifierRegistry = _chargebackNullifierRegistry;
        _transferOwnership(_owner);
    }

    /* ============ Modifiers ============ */

    modifier onlyLifecycleHook() {
        if (!isLifecycleHookAuthorizedByHook[msg.sender]) {
            revert UnauthorizedLifecycleHook(msg.sender);
        }
        _;
    }

    modifier onlyDepositor(address _escrow, uint256 _depositId) {
        address depositor = IEscrowV2(_escrow).getDeposit(_depositId).depositor;
        if (msg.sender != depositor) revert NotDepositor(_escrow, _depositId, msg.sender);
        _;
    }

    /* ============ Lifecycle Functions ============ */

    /**
     * @inheritdoc IChargebackPolicy
     */
    function onIntentSignaled(
        bytes32 _intentHash,
        address _escrow,
        uint256 _depositId,
        address _taker,
        bytes32 _paymentMethod,
        uint256 _amount
    ) external override onlyLifecycleHook nonReentrant {
        uint64 riskWindow = paymentMethodRiskWindow[_paymentMethod];
        if (riskWindow == 0) return;

        (address stakeOwner, address depositor) = _validateIntentAdmission(_intentHash, _escrow, _depositId, _taker);

        chargebackIntentByIntentHash[_intentHash] = ChargebackIntent({
            taker: _taker,
            stakeOwner: stakeOwner,
            depositor: depositor,
            paymentMethod: _paymentMethod,
            status: ChargebackIntentStatus.PENDING,
            isManualRelease: false,
            riskWindow: riskWindow,
            releaseEligibleAt: 0,
            releaseAmount: 0
        });

        stakeVault.lockStake(stakeOwner, _intentHash, _amount, PENDING_COVERAGE_MATURITY);
        emit ChargebackIntentOpened(_intentHash, stakeOwner, depositor, _taker, _paymentMethod, _amount, riskWindow);
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyLifecycleHook nonReentrant {
        ChargebackIntent storage chargebackIntent = chargebackIntentByIntentHash[_intentHash];
        if (chargebackIntent.status == ChargebackIntentStatus.NONE) return;
        if (chargebackIntent.status != ChargebackIntentStatus.PENDING) {
            revert ChargebackIntentNotPending(_intentHash, chargebackIntent.status);
        }

        (, uint256 releasedAmount,) = stakeVault.locks(_intentHash);
        chargebackIntent.status = ChargebackIntentStatus.CANCELLED;
        stakeVault.unlockStake(_intentHash);
        emit ChargebackIntentCancelled(_intentHash, chargebackIntent.stakeOwner, releasedAmount);
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function onIntentSettled(bytes32 _intentHash, uint256 _releaseAmount, bool _isManualRelease)
        external
        override
        onlyLifecycleHook
        nonReentrant
    {
        ChargebackIntent storage chargebackIntent = chargebackIntentByIntentHash[_intentHash];
        if (chargebackIntent.status == ChargebackIntentStatus.NONE) return;
        if (chargebackIntent.status != ChargebackIntentStatus.PENDING) {
            revert ChargebackIntentNotPending(_intentHash, chargebackIntent.status);
        }

        if (_isManualRelease) {
            uint64 releasedAt = _currentTimestamp();
            (, uint256 releasedAmount,) = stakeVault.locks(_intentHash);

            chargebackIntent.releaseAmount = _releaseAmount;
            chargebackIntent.isManualRelease = true;
            chargebackIntent.releaseEligibleAt = releasedAt;
            chargebackIntent.status = ChargebackIntentStatus.RELEASED;

            stakeVault.unlockStake(_intentHash);
            emit ChargebackIntentSettled(
                _intentHash, chargebackIntent.stakeOwner, chargebackIntent.depositor, _releaseAmount, releasedAt, true
            );
            emit ChargebackIntentReleased(_intentHash, chargebackIntent.stakeOwner, releasedAmount);
            return;
        }

        uint64 releaseEligibleAt = _calculateReleaseEligibleAt(chargebackIntent.riskWindow);
        chargebackIntent.releaseAmount = _releaseAmount;
        chargebackIntent.releaseEligibleAt = releaseEligibleAt;
        chargebackIntent.status = ChargebackIntentStatus.SETTLED;

        stakeVault.resizeLock(_intentHash, _releaseAmount, releaseEligibleAt);
        emit ChargebackIntentSettled(
            _intentHash,
            chargebackIntent.stakeOwner,
            chargebackIntent.depositor,
            _releaseAmount,
            releaseEligibleAt,
            false
        );
    }

    /* ============ Permissionless Functions ============ */

    /**
     * @notice Releases collateral for one settled intent once its minimum risk window has elapsed.
     * @dev Chargebacks remain valid after `releaseEligibleAt` until this release transaction executes.
     * @param _intentHash Settled chargeback intent whose collateral should be unlocked.
     */
    function releaseMaturedChargebackIntent(bytes32 _intentHash) external nonReentrant {
        _releaseMaturedChargebackIntent(_intentHash);
    }

    /**
     * @notice Releases collateral for a batch of settled intents whose minimum risk windows have elapsed.
     * @dev The batch is atomic: one invalid or ineligible intent reverts every release in the call.
     * @param _intentHashes Settled chargeback intents whose collateral should be unlocked.
     */
    function releaseMaturedChargebackIntents(bytes32[] calldata _intentHashes) external nonReentrant {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _releaseMaturedChargebackIntent(_intentHashes[intentIndex]);
        }
    }

    /**
     * @notice Resolves valid chargeback evidence into an immediately claimable depositor award.
     * @dev A settled intent remains chargebackable until its collateral release executes, even after
     * `releaseEligibleAt`. The dedicated chargeback nullifier registry atomically rejects replayed disputes.
     * @param _attestation Signed chargeback evidence for a settled intent.
     */
    function submitChargeback(IChargebackVerifier.ChargebackAttestation calldata _attestation) external nonReentrant {
        ChargebackIntent storage chargebackIntent = chargebackIntentByIntentHash[_attestation.intentHash];
        if (chargebackIntent.isManualRelease) {
            revert ManualReleaseNotChargebackable(_attestation.intentHash);
        }
        if (chargebackIntent.status != ChargebackIntentStatus.SETTLED) {
            revert ChargebackIntentNotSettled(_attestation.intentHash, chargebackIntent.status);
        }

        (bytes32 disputeId, bytes32 disputeNullifier) = chargebackVerifier.verifyChargeback(
            _attestation, chargebackIntent.paymentMethod, chargebackIntent.isManualRelease
        );
        chargebackNullifierRegistry.addNullifier(disputeNullifier);

        uint256 compensatedAmount = chargebackIntent.releaseAmount;
        chargebackIntent.status = ChargebackIntentStatus.CHARGED_BACK;

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: chargebackIntent.depositor, amount: compensatedAmount});
        stakeVault.resolveLock(_attestation.intentHash, claims);

        emit ChargebackSettled(
            _attestation.intentHash,
            chargebackIntent.stakeOwner,
            chargebackIntent.depositor,
            compensatedAmount,
            disputeId
        );
    }

    /* ============ Depositor Functions ============ */

    /**
     * @notice DEPOSITOR ONLY: Enables or disables chargeback-backed admission for a deposit.
     * @dev OrchestratorV3 validates Escrow registration before signaling an intent. This policy only verifies that
     * the caller is the deposit's current depositor.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose chargeback configuration is updated.
     * @param _isEnabled Whether non-whitelisted takers may use stake-backed chargeback admission.
     */
    function setChargebackEnabled(address _escrow, uint256 _depositId, bool _isEnabled)
        external
        onlyDepositor(_escrow, _depositId)
    {
        isDepositChargebackEnabled[_escrow][_depositId] = _isEnabled;
        emit ChargebackEnabledUpdated(_escrow, _depositId, _isEnabled);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Sets the minimum collateral lock window for future intents of a payment method.
     * @dev Zero disables chargeback state and lets the lifecycle hook pass the payment method through without a lock.
     * Existing chargeback intents retain their snapshotted risk window.
     * @param _paymentMethod Payment method whose future risk window is updated.
     * @param _riskWindow Minimum seconds collateral remains locked after settlement.
     */
    function setRiskWindow(bytes32 _paymentMethod, uint64 _riskWindow) external onlyOwner {
        if (_riskWindow > MAX_RISK_WINDOW) revert InvalidRiskWindow(_riskWindow);
        paymentMethodRiskWindow[_paymentMethod] = _riskWindow;
        emit RiskWindowUpdated(_paymentMethod, _riskWindow);
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future chargeback submissions.
     * @param _verifier New non-zero deployed chargeback verifier.
     */
    function setChargebackVerifier(address _verifier) external onlyOwner {
        _validateDependency(_verifier);
        address previousVerifier = address(chargebackVerifier);
        chargebackVerifier = IChargebackVerifier(_verifier);
        emit ChargebackVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice GOVERNANCE ONLY: Authorizes or revokes one lifecycle hook.
     * @dev Authorize a hook before configuring it on an Orchestrator. Revoke a predecessor only after every intent
     * snapshotted to it has been cancelled or settled.
     * @param _hook Lifecycle hook whose callback authority is updated.
     * @param _isAuthorized Whether the hook may mutate chargeback intent state.
     */
    function setLifecycleHookAuthorization(address _hook, bool _isAuthorized) external onlyOwner {
        if (_isAuthorized) _validateDependency(_hook);
        isLifecycleHookAuthorizedByHook[_hook] = _isAuthorized;
        emit LifecycleHookAuthorizationUpdated(_hook, _isAuthorized);
    }

    /**
     * @notice GOVERNANCE ONLY: Pauses or resumes new chargeback-backed admissions.
     * @dev Cancellation, settlement, release, and chargeback submission remain available while admissions are paused.
     * @param _isPaused Whether new chargeback admissions should revert.
     */
    function setAdmissionsPaused(bool _isPaused) external onlyOwner {
        admissionsPaused = _isPaused;
        emit AdmissionsPausedUpdated(_isPaused);
    }

    /**
     * @notice GOVERNANCE ONLY: Accepts this policy as StakeVault's controller after its handover delay.
     * @dev Before replacing another policy, governance must drain its active chargeback intents or execute an explicit
     * state-and-lock migration. Accepting controller authority alone cannot import the predecessor's intent state.
     */
    function acceptVaultController() external onlyOwner {
        stakeVault.acceptController();
    }

    /**
     * @notice Disables ownership renunciation so governed safety controls cannot become unreachable.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns the stored chargeback state for an intent.
     * @param _intentHash Intent whose chargeback state is queried.
     */
    function getChargebackIntent(bytes32 _intentHash) external view returns (ChargebackIntent memory) {
        return chargebackIntentByIntentHash[_intentHash];
    }

    /**
     * @inheritdoc IChargebackPolicy
     */
    function isChargebackEnabled(address _escrow, uint256 _depositId) external view override returns (bool) {
        return isDepositChargebackEnabled[_escrow][_depositId];
    }

    /**
     * @notice Returns whether a lifecycle hook may mutate chargeback intent state.
     * @param _hook Lifecycle hook whose callback authorization is queried.
     */
    function isLifecycleHookAuthorized(address _hook) external view returns (bool) {
        return isLifecycleHookAuthorizedByHook[_hook];
    }

    /**
     * @notice Returns the risk window applied to future intents for a payment method.
     * @param _paymentMethod Payment method whose configured risk window is queried.
     */
    function getRiskWindow(bytes32 _paymentMethod) external view returns (uint64) {
        return paymentMethodRiskWindow[_paymentMethod];
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Validates policy-owned admission requirements and returns the collateral owner and depositor to snapshot.
     * StakeVault remains authoritative for collateral sufficiency and reverts from `lockStake` when free stake is
     * insufficient.
     */
    function _validateIntentAdmission(bytes32 _intentHash, address _escrow, uint256 _depositId, address _taker)
        internal
        view
        returns (address stakeOwner, address depositor)
    {
        if (admissionsPaused) revert AdmissionsPaused();
        if (chargebackIntentByIntentHash[_intentHash].status != ChargebackIntentStatus.NONE) {
            revert ChargebackIntentAlreadyExists(_intentHash);
        }
        if (!isDepositChargebackEnabled[_escrow][_depositId]) {
            revert ChargebackNotEnabled(_escrow, _depositId);
        }

        IEscrowV2.Deposit memory deposit = IEscrowV2(_escrow).getDeposit(_depositId);
        address expectedToken = address(stakeVault.stakeToken());
        if (address(deposit.token) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(deposit.token));
        }

        stakeOwner = stakeVault.stakeOwnerOf(_taker);
        depositor = deposit.depositor;
    }

    function _releaseMaturedChargebackIntent(bytes32 _intentHash) internal {
        ChargebackIntent storage chargebackIntent = chargebackIntentByIntentHash[_intentHash];
        if (chargebackIntent.status != ChargebackIntentStatus.SETTLED) {
            revert ChargebackIntentNotSettled(_intentHash, chargebackIntent.status);
        }

        uint64 currentTime = _currentTimestamp();
        uint64 releaseEligibleAt = chargebackIntent.releaseEligibleAt;
        if (currentTime < releaseEligibleAt) {
            revert ChargebackIntentNotReleaseEligible(releaseEligibleAt, currentTime);
        }

        uint256 releasedAmount = chargebackIntent.releaseAmount;
        chargebackIntent.status = ChargebackIntentStatus.RELEASED;
        stakeVault.unlockStake(_intentHash);
        emit ChargebackIntentReleased(_intentHash, chargebackIntent.stakeOwner, releasedAmount);
    }

    function _calculateReleaseEligibleAt(uint64 _riskWindow) internal view returns (uint64) {
        uint256 releaseEligibleAt = block.timestamp + _riskWindow;
        if (releaseEligibleAt > type(uint64).max) revert TimestampOverflow(releaseEligibleAt);
        return uint64(releaseEligibleAt);
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
