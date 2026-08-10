// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IDisputeProtectionPolicy} from "../interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {IEscrowV2} from "../interfaces/IEscrowV2.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";

/**
 * @title DisputeProtectionPolicy
 * @notice Deposit-scoped, stake-backed dispute protection that is enabled by default with depositor opt-out.
 * @dev The policy owns no tokens. StakeVault is the source of truth for collateral locks, a dedicated
 * `disputeNullifierRegistry` deployment is the source of truth for consumed dispute nullifiers, and the calling
 * Orchestrator is the source of truth for valid escrows and intents.
 *
 * TRUST: Dispute protection intents are keyed by intent hash, which embeds the originating orchestrator
 * (OrchestratorV3 hashes its own address into every intent hash), so identities do not collide across orchestrators.
 * Lifecycle entrypoints trust every orchestrator admitted by OrchestratorRegistry to invoke callbacks only for
 * intents it created and already validated against its EscrowRegistry. Registering an orchestrator is therefore a
 * governance assertion about its callback behavior.
 *
 * Governance must authorize a lifecycle hook here before configuring it on an Orchestrator. Predecessor hooks must
 * remain authorized until all intents snapshotted to them have been cancelled or settled. Likewise, an orchestrator
 * must be drained before it is removed from OrchestratorRegistry. This policy must also drain every active dispute
 * protection intent before StakeVault controller authority moves to a replacement policy unless that replacement
 * explicitly adopts this policy's intent and lock state.
 */
contract DisputeProtectionPolicy is IDisputeProtectionPolicy, Ownable2Step, ReentrancyGuard {
    /* ============ Constants ============ */

    uint64 public constant MAX_RISK_WINDOW = 365 days;
    uint64 public constant PENDING_COVERAGE_MATURITY = type(uint64).max;

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVault public immutable stakeVault;

    /// @notice Dedicated replay registry for payment-method-scoped dispute nullifiers.
    INullifierRegistry public immutable disputeNullifierRegistry;

    /// @notice Verifier used to validate signed dispute evidence.
    IDisputeVerifier public disputeVerifier;

    /// @notice Whether new dispute-protection admissions are paused. Terminal transitions remain available.
    bool public admissionsPaused;

    /// @dev Lifecycle-hook authorization keyed by lifecycle hook address.
    mapping(address => bool) internal isLifecycleHookAuthorizedByHook;

    /// @dev Whether default stake-backed dispute protection is disabled for each escrow deposit.
    mapping(address => mapping(uint256 => bool)) internal isDepositDisputeProtectionDisabled;

    /// @dev Minimum collateral lock window for each payment method.
    mapping(bytes32 => uint64) internal paymentMethodRiskWindow;

    /// @dev Dispute protection lifecycle state keyed by globally unique intent hash.
    mapping(bytes32 => DisputeProtectionIntent) internal disputeProtectionIntentByIntentHash;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a dispute protection policy over one StakeVault and one dedicated dispute-nullifier registry.
     * @dev After deployment, authorize this policy as the StakeVault controller and as a writer on the dedicated
     * dispute nullifier registry before enabling deposits.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _stakeVault Vault holding and locking taker collateral.
     * @param _disputeVerifier Verifier for signed dispute evidence.
     * @param _disputeNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     */
    constructor(
        address _owner,
        IStakeVault _stakeVault,
        IDisputeVerifier _disputeVerifier,
        INullifierRegistry _disputeNullifierRegistry
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_stakeVault));
        _validateDependency(address(_disputeVerifier));
        _validateDependency(address(_disputeNullifierRegistry));

        stakeVault = _stakeVault;
        disputeVerifier = _disputeVerifier;
        disputeNullifierRegistry = _disputeNullifierRegistry;
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
     * @inheritdoc IDisputeProtectionPolicy
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

        disputeProtectionIntentByIntentHash[_intentHash] = DisputeProtectionIntent({
            taker: _taker,
            stakeOwner: stakeOwner,
            depositor: depositor,
            paymentMethod: _paymentMethod,
            status: DisputeProtectionIntentStatus.PENDING,
            riskWindow: riskWindow,
            releaseEligibleAt: 0,
            releaseAmount: 0
        });

        stakeVault.lockStake(stakeOwner, _intentHash, _amount, PENDING_COVERAGE_MATURITY);
        emit DisputeProtectionIntentOpened(
            _intentHash, stakeOwner, depositor, _taker, _paymentMethod, _amount, riskWindow
        );
    }

    /**
     * @inheritdoc IDisputeProtectionPolicy
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyLifecycleHook nonReentrant {
        DisputeProtectionIntent storage disputeProtectionIntent = disputeProtectionIntentByIntentHash[_intentHash];
        if (disputeProtectionIntent.status == DisputeProtectionIntentStatus.NONE) return;
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.PENDING) {
            revert DisputeProtectionIntentNotPending(_intentHash, disputeProtectionIntent.status);
        }

        (, uint256 releasedAmount,) = stakeVault.locks(_intentHash);
        disputeProtectionIntent.status = DisputeProtectionIntentStatus.CANCELLED;
        stakeVault.unlockStake(_intentHash);
        emit DisputeProtectionIntentCancelled(_intentHash, disputeProtectionIntent.stakeOwner, releasedAmount);
    }

    /**
     * @inheritdoc IDisputeProtectionPolicy
     */
    function onIntentSettled(bytes32 _intentHash, uint256 _releaseAmount, bool _isManualRelease)
        external
        override
        onlyLifecycleHook
        nonReentrant
    {
        DisputeProtectionIntent storage disputeProtectionIntent = disputeProtectionIntentByIntentHash[_intentHash];
        if (disputeProtectionIntent.status == DisputeProtectionIntentStatus.NONE) return;
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.PENDING) {
            revert DisputeProtectionIntentNotPending(_intentHash, disputeProtectionIntent.status);
        }

        uint64 releaseEligibleAt = _calculateReleaseEligibleAt(disputeProtectionIntent.riskWindow);
        disputeProtectionIntent.releaseAmount = _releaseAmount;
        disputeProtectionIntent.releaseEligibleAt = releaseEligibleAt;
        disputeProtectionIntent.status = DisputeProtectionIntentStatus.SETTLED;

        stakeVault.resizeLock(_intentHash, _releaseAmount, releaseEligibleAt);
        emit DisputeProtectionIntentSettled(
            _intentHash,
            disputeProtectionIntent.stakeOwner,
            disputeProtectionIntent.depositor,
            _releaseAmount,
            releaseEligibleAt,
            _isManualRelease
        );
    }

    /* ============ Permissionless Functions ============ */

    /**
     * @notice Releases collateral for one settled intent once its minimum risk window has elapsed.
     * @dev Disputes remain valid after `releaseEligibleAt` until this release transaction executes.
     * @param _intentHash Settled dispute protection intent whose collateral should be unlocked.
     */
    function releaseMaturedDisputeProtectionIntent(bytes32 _intentHash) external nonReentrant {
        _releaseMaturedDisputeProtectionIntent(_intentHash);
    }

    /**
     * @notice Releases collateral for a batch of settled intents whose minimum risk windows have elapsed.
     * @dev The batch is atomic: one invalid or ineligible intent reverts every release in the call.
     * @param _intentHashes Settled dispute protection intents whose collateral should be unlocked.
     */
    function releaseMaturedDisputeProtectionIntents(bytes32[] calldata _intentHashes) external nonReentrant {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _releaseMaturedDisputeProtectionIntent(_intentHashes[intentIndex]);
        }
    }

    /**
     * @notice Resolves valid dispute evidence into an immediately claimable depositor award.
     * @dev A settled intent remains disputable until its collateral release executes, even after
     * `releaseEligibleAt`. The dedicated dispute nullifier registry atomically rejects replayed disputes.
     * @param _attestation Signed dispute evidence for a settled intent.
     */
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata _attestation) external nonReentrant {
        DisputeProtectionIntent storage disputeProtectionIntent =
            disputeProtectionIntentByIntentHash[_attestation.intentHash];
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.SETTLED) {
            revert DisputeProtectionIntentNotSettled(_attestation.intentHash, disputeProtectionIntent.status);
        }

        (bytes32 disputeId, bytes32 disputeNullifier) =
            disputeVerifier.verifyDispute(_attestation, disputeProtectionIntent.paymentMethod);
        disputeNullifierRegistry.addNullifier(disputeNullifier);

        uint256 compensatedAmount = disputeProtectionIntent.releaseAmount;
        disputeProtectionIntent.status = DisputeProtectionIntentStatus.DISPUTED;

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: disputeProtectionIntent.depositor, amount: compensatedAmount});
        stakeVault.resolveLock(_attestation.intentHash, claims);

        emit DisputeResolved(
            _attestation.intentHash,
            disputeProtectionIntent.stakeOwner,
            disputeProtectionIntent.depositor,
            compensatedAmount,
            disputeId
        );
    }

    /* ============ Depositor Functions ============ */

    /**
     * @notice DEPOSITOR ONLY: Updates the default-on dispute protection setting for a deposit.
     * @dev Protection is enabled by default. OrchestratorV3 validates Escrow registration before signaling an intent;
     * this policy only verifies that the caller is the deposit's current depositor.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose dispute protection configuration is updated.
     * @param _isEnabled Whether non-whitelisted takers may use stake-backed dispute protection; false opts out.
     */
    function setDisputeProtectionEnabled(address _escrow, uint256 _depositId, bool _isEnabled)
        external
        onlyDepositor(_escrow, _depositId)
    {
        isDepositDisputeProtectionDisabled[_escrow][_depositId] = !_isEnabled;
        emit DisputeProtectionEnabledUpdated(_escrow, _depositId, _isEnabled);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Sets the minimum collateral lock window for future intents of a payment method.
     * @dev Zero disables dispute protection state and lets the lifecycle hook pass the payment method through without
     * a lock. Existing dispute protection intents retain their snapshotted risk window.
     * @param _paymentMethod Payment method whose future risk window is updated.
     * @param _riskWindow Minimum seconds collateral remains locked after settlement.
     */
    function setRiskWindow(bytes32 _paymentMethod, uint64 _riskWindow) external onlyOwner {
        if (_riskWindow > MAX_RISK_WINDOW) revert InvalidRiskWindow(_riskWindow);
        paymentMethodRiskWindow[_paymentMethod] = _riskWindow;
        emit RiskWindowUpdated(_paymentMethod, _riskWindow);
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future dispute submissions.
     * @param _verifier New non-zero deployed dispute verifier.
     */
    function setDisputeVerifier(address _verifier) external onlyOwner {
        _validateDependency(_verifier);
        address previousVerifier = address(disputeVerifier);
        disputeVerifier = IDisputeVerifier(_verifier);
        emit DisputeVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice GOVERNANCE ONLY: Authorizes or revokes one lifecycle hook.
     * @dev Authorize a hook before configuring it on an Orchestrator. Revoke a predecessor only after every intent
     * snapshotted to it has been cancelled or settled.
     * @param _hook Lifecycle hook whose callback authority is updated.
     * @param _isAuthorized Whether the hook may mutate dispute protection intent state.
     */
    function setLifecycleHookAuthorization(address _hook, bool _isAuthorized) external onlyOwner {
        if (_isAuthorized) _validateDependency(_hook);
        isLifecycleHookAuthorizedByHook[_hook] = _isAuthorized;
        emit LifecycleHookAuthorizationUpdated(_hook, _isAuthorized);
    }

    /**
     * @notice GOVERNANCE ONLY: Pauses or resumes new dispute-protection admissions.
     * @dev Protection is enabled by default, so pausing acts as a protocol-wide kill switch, not as a per-deposit
     * control. It rejects every non-whitelisted taker on every covered deposit whose payment method has a nonzero risk
     * window. Whitelisted takers return from the lifecycle hook before this policy is reached, and payment methods with
     * a zero risk window return before the pause check. Deposits that opt out do not call this policy; when their
     * whitelist is disabled, they remain open. Cancellation, settlement, release, and dispute submission remain
     * available while admissions are paused.
     * @param _isPaused Whether new dispute protection admissions should revert.
     */
    function setAdmissionsPaused(bool _isPaused) external onlyOwner {
        admissionsPaused = _isPaused;
        emit AdmissionsPausedUpdated(_isPaused);
    }

    /**
     * @notice GOVERNANCE ONLY: Accepts this policy as StakeVault's controller after its handover delay.
     * @dev Before replacing another policy, governance must drain its active dispute protection intents or execute an
     * explicit state-and-lock migration. Accepting controller authority alone cannot import the predecessor's intent
     * state.
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
     * @notice Returns the stored dispute protection state for an intent.
     * @param _intentHash Intent whose dispute protection state is queried.
     */
    function getDisputeProtectionIntent(bytes32 _intentHash) external view returns (DisputeProtectionIntent memory) {
        return disputeProtectionIntentByIntentHash[_intentHash];
    }

    /**
     * @notice Returns whether default-on stake-backed dispute protection remains enabled for a deposit.
     * @dev Returns true for untouched deposits and false only after the depositor opts out.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose dispute protection configuration is queried.
     */
    function isDisputeProtectionEnabled(address _escrow, uint256 _depositId) external view override returns (bool) {
        return !isDepositDisputeProtectionDisabled[_escrow][_depositId];
    }

    /**
     * @notice Returns whether a lifecycle hook may mutate dispute protection intent state.
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
        if (disputeProtectionIntentByIntentHash[_intentHash].status != DisputeProtectionIntentStatus.NONE) {
            revert DisputeProtectionIntentAlreadyExists(_intentHash);
        }
        if (isDepositDisputeProtectionDisabled[_escrow][_depositId]) {
            revert DisputeProtectionNotEnabled(_escrow, _depositId);
        }

        IEscrowV2.Deposit memory deposit = IEscrowV2(_escrow).getDeposit(_depositId);
        address expectedToken = address(stakeVault.stakeToken());
        if (address(deposit.token) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(deposit.token));
        }

        stakeOwner = stakeVault.stakeOwnerOf(_taker);
        depositor = deposit.depositor;
    }

    function _releaseMaturedDisputeProtectionIntent(bytes32 _intentHash) internal {
        DisputeProtectionIntent storage disputeProtectionIntent = disputeProtectionIntentByIntentHash[_intentHash];
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.SETTLED) {
            revert DisputeProtectionIntentNotSettled(_intentHash, disputeProtectionIntent.status);
        }

        uint64 currentTime = _currentTimestamp();
        uint64 releaseEligibleAt = disputeProtectionIntent.releaseEligibleAt;
        if (currentTime < releaseEligibleAt) {
            revert DisputeProtectionIntentNotReleaseEligible(releaseEligibleAt, currentTime);
        }

        uint256 releasedAmount = disputeProtectionIntent.releaseAmount;
        disputeProtectionIntent.status = DisputeProtectionIntentStatus.RELEASED;
        stakeVault.unlockStake(_intentHash);
        emit DisputeProtectionIntentReleased(_intentHash, disputeProtectionIntent.stakeOwner, releasedAmount);
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
