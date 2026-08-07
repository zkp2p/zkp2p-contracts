// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IDisputePolicy} from "../interfaces/IDisputePolicy.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {IEscrowV2} from "../interfaces/IEscrowV2.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";

/**
 * @title DisputePolicy
 * @notice Deposit-scoped, stake-backed dispute coverage for intent settlement.
 * @dev The policy owns no tokens. StakeVault is the source of truth for collateral locks, a dedicated
 * `disputeNullifierRegistry` deployment is the source of truth for consumed dispute nullifiers, and the calling
 * Orchestrator is the source of truth for valid escrows and intents.
 *
 * TRUST: Dispute intents are keyed by intent hash, which embeds the originating orchestrator
 * (OrchestratorV3 hashes its own address into every intent hash), so identities do not collide across orchestrators.
 * Lifecycle entrypoints trust every orchestrator admitted by OrchestratorRegistry to invoke callbacks only for
 * intents it created and already validated against its EscrowRegistry. Registering an orchestrator is therefore a
 * governance assertion about its callback behavior.
 *
 * Governance must authorize a lifecycle hook here before configuring it on an Orchestrator. Predecessor hooks must
 * remain authorized until all intents snapshotted to them have been cancelled or settled. Likewise, an orchestrator
 * must be drained before it is removed from OrchestratorRegistry. This policy must also drain every active dispute
 * intent before StakeVault controller authority moves to a replacement policy unless that replacement explicitly adopts
 * this policy's intent and lock state.
 */
contract DisputePolicy is IDisputePolicy, Ownable2Step, ReentrancyGuard {
    /* ============ Constants ============ */

    uint64 public constant MAX_RISK_WINDOW = 365 days;
    uint64 public constant PENDING_COVERAGE_MATURITY = type(uint64).max;

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVault public immutable stakeVault;

    /// @notice Token released from Escrow and denominating covered intent amounts.
    IERC20 public immutable settlementToken;

    /// @notice ERC-4626 share token used as collateral and priced directly in settlement-token units.
    IERC4626 public immutable collateralVault;

    /// @notice Dedicated replay registry for payment-method-scoped dispute nullifiers.
    INullifierRegistry public immutable disputeNullifierRegistry;

    /// @notice Verifier used to validate signed dispute evidence.
    IDisputeVerifier public disputeVerifier;

    /// @notice Whether new dispute-backed admissions are paused. Terminal transitions remain available.
    bool public admissionsPaused;

    /// @dev Lifecycle-hook authorization keyed by lifecycle hook address.
    mapping(address => bool) internal isLifecycleHookAuthorizedByHook;

    /// @dev Whether disputes are enabled for each escrow deposit.
    mapping(address => mapping(uint256 => bool)) internal isDepositDisputeEnabled;

    /// @dev Minimum collateral lock window for each payment method.
    mapping(bytes32 => uint64) internal paymentMethodRiskWindow;

    /// @dev Dispute lifecycle state keyed by globally unique intent hash.
    mapping(bytes32 => DisputeIntent) internal disputeIntentByIntentHash;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a dispute policy over one StakeVault and one dedicated dispute-nullifier registry.
     * @dev After deployment, authorize this policy as the StakeVault controller and as a writer on the dedicated
     * dispute nullifier registry before enabling deposits.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _settlementToken Token released by covered Escrow deposits, currently canonical Base USDC.
     * @param _collateralVault ERC-4626 vault whose shares are staked and whose underlying asset is settlementToken.
     * @param _stakeVault Vault holding and locking collateralVault shares.
     * @param _disputeVerifier Verifier for signed dispute evidence.
     * @param _disputeNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     */
    constructor(
        address _owner,
        IERC20 _settlementToken,
        IERC4626 _collateralVault,
        IStakeVault _stakeVault,
        IDisputeVerifier _disputeVerifier,
        INullifierRegistry _disputeNullifierRegistry
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_settlementToken));
        _validateDependency(address(_collateralVault));
        _validateDependency(address(_stakeVault));
        _validateDependency(address(_disputeVerifier));
        _validateDependency(address(_disputeNullifierRegistry));

        address collateralAsset = _collateralVault.asset();
        if (collateralAsset != address(_settlementToken)) {
            revert CollateralAssetMismatch(address(_settlementToken), collateralAsset);
        }
        address stakeToken = address(_stakeVault.stakeToken());
        if (stakeToken != address(_collateralVault)) {
            revert StakeTokenMismatch(address(_collateralVault), stakeToken);
        }

        settlementToken = _settlementToken;
        collateralVault = _collateralVault;
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
     * @inheritdoc IDisputePolicy
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
        uint256 collateralAmount = _previewWithdrawOrRevert(_amount);

        disputeIntentByIntentHash[_intentHash] = DisputeIntent({
            taker: _taker,
            stakeOwner: stakeOwner,
            depositor: depositor,
            paymentMethod: _paymentMethod,
            status: DisputeIntentStatus.PENDING,
            riskWindow: riskWindow,
            releaseEligibleAt: 0,
            intentAmount: _amount,
            collateralAmount: collateralAmount,
            releaseAmount: 0
        });

        stakeVault.lockStake(stakeOwner, _intentHash, collateralAmount, PENDING_COVERAGE_MATURITY);
        emit DisputeIntentOpened(
            _intentHash, stakeOwner, depositor, _taker, _paymentMethod, _amount, collateralAmount, riskWindow
        );
    }

    /**
     * @inheritdoc IDisputePolicy
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyLifecycleHook nonReentrant {
        DisputeIntent storage disputeIntent = disputeIntentByIntentHash[_intentHash];
        if (disputeIntent.status == DisputeIntentStatus.NONE) return;
        if (disputeIntent.status != DisputeIntentStatus.PENDING) {
            revert DisputeIntentNotPending(_intentHash, disputeIntent.status);
        }

        (, uint256 releasedAmount,) = stakeVault.locks(_intentHash);
        disputeIntent.status = DisputeIntentStatus.CANCELLED;
        stakeVault.unlockStake(_intentHash);
        emit DisputeIntentCancelled(_intentHash, disputeIntent.stakeOwner, releasedAmount);
    }

    /**
     * @inheritdoc IDisputePolicy
     */
    function onIntentSettled(bytes32 _intentHash, uint256 _releaseAmount, bool _isManualRelease)
        external
        override
        onlyLifecycleHook
        nonReentrant
    {
        DisputeIntent storage disputeIntent = disputeIntentByIntentHash[_intentHash];
        if (disputeIntent.status == DisputeIntentStatus.NONE) return;
        if (disputeIntent.status != DisputeIntentStatus.PENDING) {
            revert DisputeIntentNotPending(_intentHash, disputeIntent.status);
        }

        uint256 intentAmount = disputeIntent.intentAmount;
        if (_releaseAmount > intentAmount) revert ReleaseAmountExceedsIntent(intentAmount, _releaseAmount);
        uint256 collateralAmount =
            Math.mulDiv(disputeIntent.collateralAmount, _releaseAmount, intentAmount, Math.Rounding.Up);
        uint64 releaseEligibleAt = _calculateReleaseEligibleAt(disputeIntent.riskWindow);
        disputeIntent.collateralAmount = collateralAmount;
        disputeIntent.releaseAmount = _releaseAmount;
        disputeIntent.releaseEligibleAt = releaseEligibleAt;
        disputeIntent.status = DisputeIntentStatus.SETTLED;

        stakeVault.resizeLock(_intentHash, collateralAmount, releaseEligibleAt);
        emit DisputeIntentSettled(
            _intentHash,
            disputeIntent.stakeOwner,
            disputeIntent.depositor,
            _releaseAmount,
            collateralAmount,
            releaseEligibleAt,
            _isManualRelease
        );
    }

    /* ============ Permissionless Functions ============ */

    /**
     * @notice Releases collateral for one settled intent once its minimum risk window has elapsed.
     * @dev Disputes remain valid after `releaseEligibleAt` until this release transaction executes.
     * @param _intentHash Settled dispute intent whose collateral should be unlocked.
     */
    function releaseMaturedDisputeIntent(bytes32 _intentHash) external nonReentrant {
        _releaseMaturedDisputeIntent(_intentHash);
    }

    /**
     * @notice Releases collateral for a batch of settled intents whose minimum risk windows have elapsed.
     * @dev The batch is atomic: one invalid or ineligible intent reverts every release in the call.
     * @param _intentHashes Settled dispute intents whose collateral should be unlocked.
     */
    function releaseMaturedDisputeIntents(bytes32[] calldata _intentHashes) external nonReentrant {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _releaseMaturedDisputeIntent(_intentHashes[intentIndex]);
        }
    }

    /**
     * @notice Resolves valid dispute evidence into an immediately claimable depositor award.
     * @dev A settled intent remains disputable until its collateral release executes, even after
     * `releaseEligibleAt`. The dedicated dispute nullifier registry atomically rejects replayed disputes.
     * @param _attestation Signed dispute evidence for a settled intent.
     */
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata _attestation) external nonReentrant {
        DisputeIntent storage disputeIntent = disputeIntentByIntentHash[_attestation.intentHash];
        if (disputeIntent.status != DisputeIntentStatus.SETTLED) {
            revert DisputeIntentNotSettled(_attestation.intentHash, disputeIntent.status);
        }

        (bytes32 disputeId, bytes32 disputeNullifier) =
            disputeVerifier.verifyDispute(_attestation, disputeIntent.paymentMethod);
        disputeNullifierRegistry.addNullifier(disputeNullifier);

        (, uint256 lockedCollateralAmount,) = stakeVault.locks(_attestation.intentHash);
        (bool conversionAvailable, uint256 quotedCollateralAmount) = _tryPreviewWithdraw(disputeIntent.releaseAmount);
        bool collateralCapped = !conversionAvailable || quotedCollateralAmount > lockedCollateralAmount;
        uint256 compensatedCollateralAmount = collateralCapped ? lockedCollateralAmount : quotedCollateralAmount;
        disputeIntent.status = DisputeIntentStatus.DISPUTED;

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: disputeIntent.depositor, amount: compensatedCollateralAmount});
        stakeVault.resolveLock(_attestation.intentHash, claims);

        emit DisputeResolved(
            _attestation.intentHash,
            disputeIntent.stakeOwner,
            disputeIntent.depositor,
            disputeIntent.releaseAmount,
            compensatedCollateralAmount,
            collateralCapped,
            disputeId
        );
    }

    /* ============ Depositor Functions ============ */

    /**
     * @notice DEPOSITOR ONLY: Enables or disables dispute-backed admission for a deposit.
     * @dev OrchestratorV3 validates Escrow registration before signaling an intent. This policy only verifies that
     * the caller is the deposit's current depositor.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose dispute configuration is updated.
     * @param _isEnabled Whether non-whitelisted takers may use stake-backed dispute admission.
     */
    function setDisputeEnabled(address _escrow, uint256 _depositId, bool _isEnabled)
        external
        onlyDepositor(_escrow, _depositId)
    {
        isDepositDisputeEnabled[_escrow][_depositId] = _isEnabled;
        emit DisputeEnabledUpdated(_escrow, _depositId, _isEnabled);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Sets the minimum collateral lock window for future intents of a payment method.
     * @dev Zero disables dispute state and lets the lifecycle hook pass the payment method through without a lock.
     * Existing dispute intents retain their snapshotted risk window.
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
     * @param _isAuthorized Whether the hook may mutate dispute intent state.
     */
    function setLifecycleHookAuthorization(address _hook, bool _isAuthorized) external onlyOwner {
        if (_isAuthorized) _validateDependency(_hook);
        isLifecycleHookAuthorizedByHook[_hook] = _isAuthorized;
        emit LifecycleHookAuthorizationUpdated(_hook, _isAuthorized);
    }

    /**
     * @notice GOVERNANCE ONLY: Pauses or resumes new dispute-backed admissions.
     * @dev Cancellation, settlement, release, and dispute submission remain available while admissions are paused.
     * @param _isPaused Whether new dispute admissions should revert.
     */
    function setAdmissionsPaused(bool _isPaused) external onlyOwner {
        admissionsPaused = _isPaused;
        emit AdmissionsPausedUpdated(_isPaused);
    }

    /**
     * @notice GOVERNANCE ONLY: Accepts this policy as StakeVault's controller after its handover delay.
     * @dev Before replacing another policy, governance must drain its active dispute intents or execute an explicit
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
     * @notice Returns the stored dispute state for an intent.
     * @param _intentHash Intent whose dispute state is queried.
     */
    function getDisputeIntent(bytes32 _intentHash) external view returns (DisputeIntent memory) {
        return disputeIntentByIntentHash[_intentHash];
    }

    /**
     * @inheritdoc IDisputePolicy
     */
    function isDisputeEnabled(address _escrow, uint256 _depositId) external view override returns (bool) {
        return isDepositDisputeEnabled[_escrow][_depositId];
    }

    /**
     * @notice Returns whether a lifecycle hook may mutate dispute intent state.
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

    /**
     * @notice Quotes the ERC-4626 shares required to collateralize a settlement-token amount at 100%.
     * @param _settlementAmount Settlement token amount in its native decimals.
     * @return collateralAmount Required collateralVault shares in their native decimals.
     */
    function quoteCollateral(uint256 _settlementAmount) external view returns (uint256 collateralAmount) {
        return _previewWithdrawOrRevert(_settlementAmount);
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
        if (disputeIntentByIntentHash[_intentHash].status != DisputeIntentStatus.NONE) {
            revert DisputeIntentAlreadyExists(_intentHash);
        }
        if (!isDepositDisputeEnabled[_escrow][_depositId]) {
            revert DisputeNotEnabled(_escrow, _depositId);
        }

        IEscrowV2.Deposit memory deposit = IEscrowV2(_escrow).getDeposit(_depositId);
        address expectedToken = address(settlementToken);
        if (address(deposit.token) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(deposit.token));
        }

        stakeOwner = stakeVault.stakeOwnerOf(_taker);
        depositor = deposit.depositor;
    }

    function _releaseMaturedDisputeIntent(bytes32 _intentHash) internal {
        DisputeIntent storage disputeIntent = disputeIntentByIntentHash[_intentHash];
        if (disputeIntent.status != DisputeIntentStatus.SETTLED) {
            revert DisputeIntentNotSettled(_intentHash, disputeIntent.status);
        }

        uint64 currentTime = _currentTimestamp();
        uint64 releaseEligibleAt = disputeIntent.releaseEligibleAt;
        if (currentTime < releaseEligibleAt) {
            revert DisputeIntentNotReleaseEligible(releaseEligibleAt, currentTime);
        }

        uint256 releasedAmount = disputeIntent.collateralAmount;
        disputeIntent.status = DisputeIntentStatus.RELEASED;
        stakeVault.unlockStake(_intentHash);
        emit DisputeIntentReleased(_intentHash, disputeIntent.stakeOwner, releasedAmount);
    }

    function _calculateReleaseEligibleAt(uint64 _riskWindow) internal view returns (uint64) {
        uint256 releaseEligibleAt = block.timestamp + _riskWindow;
        if (releaseEligibleAt > type(uint64).max) revert TimestampOverflow(releaseEligibleAt);
        return uint64(releaseEligibleAt);
    }

    function _previewWithdrawOrRevert(uint256 _settlementAmount) internal view returns (uint256 collateralAmount) {
        (bool conversionAvailable, uint256 quotedCollateralAmount) = _tryPreviewWithdraw(_settlementAmount);
        if (!conversionAvailable) revert CollateralConversionUnavailable();
        return quotedCollateralAmount;
    }

    function _tryPreviewWithdraw(uint256 _settlementAmount)
        internal
        view
        returns (bool conversionAvailable, uint256 collateralAmount)
    {
        try collateralVault.previewWithdraw(_settlementAmount) returns (uint256 quotedCollateralAmount) {
            if (_settlementAmount != 0 && quotedCollateralAmount == 0) return (false, 0);
            return (true, quotedCollateralAmount);
        } catch {
            return (false, 0);
        }
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
