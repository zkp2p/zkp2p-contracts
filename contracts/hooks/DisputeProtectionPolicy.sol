// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IDisputeProtectionPolicy} from "../interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {IEscrowV2} from "../interfaces/IEscrowV2.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV2} from "../interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {UnifiedPaymentVerifierV3} from "../unifiedVerifier/UnifiedPaymentVerifierV3.sol";

/**
 * @title DisputeProtectionPolicy
 * @notice Method-scoped payment policies with signed eligibility and snapshotted collateral windows.
 * @dev The policy owns no tokens. StakeVault is the source of truth for collateral locks, a dedicated
 * `disputeNullifierRegistry` deployment is the source of truth for consumed dispute nullifiers, and the calling
 * Orchestrator is the source of truth for valid escrows and intents.
 *
 * TRUST: Dispute protection intents are keyed by intent hash, which embeds the originating orchestrator
 * (OrchestratorV3 hashes its own address into every intent hash), so identities do not collide across orchestrators.
 * Authorized hooks authenticate the orchestrator, read its intent once, and supply the admission context.
 * Terminal callbacks must match the snapshotted hook and originating orchestrator. Registering an orchestrator
 * remains a governance assertion about its admission data and settlement accounting.
 *
 * Governance must authorize a lifecycle hook here before configuring it on an Orchestrator. Predecessor hooks must
 * remain authorized until all intents snapshotted to them have been cancelled or settled. Likewise, an orchestrator
 * must be drained before it is removed from OrchestratorRegistry. This policy must also drain every active dispute
 * protection intent before StakeVault controller authority moves to a replacement policy unless that replacement
 * explicitly adopts this policy's intent and lock state.
 *
 * Policy routes pin reviewed non-proxy dependencies. The payment verifier must remain the sole V2 payment-registry
 * writer and must call this policy as its attestation checker. Runtime checks fail closed on route
 * changes; they do not remove the existing trust in governance or registered orchestrators' callback behavior.
 */
contract DisputeProtectionPolicy is IDisputeProtectionPolicy, IAttestationVerifier, Ownable2Step, ReentrancyGuard {
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

    /// @dev Whether the depositor opted a deposit payment method out of default dispute protection.
    mapping(address => mapping(uint256 => mapping(bytes32 => bool))) internal
        isPolicyAdmissionDisabledByPaymentMethod;

    /// @dev Dispute protection lifecycle state keyed by globally unique intent hash.
    mapping(bytes32 => PolicyIntent) internal policyIntents;

    struct PolicyRule {
        uint64 riskWindow;
        bool registered;
        bool enabled;
    }

    mapping(bytes32 => mapping(bytes32 => PolicyRule)) public policyRules;
    mapping(address => address) public paymentVerifierByOrchestrator;
    mapping(address => address) public signatureVerifierByPaymentVerifier;

    event PolicyUpdated(bytes32 indexed paymentMethod, bytes32 indexed policyId, uint64 riskWindow, bool enabled);
    event PolicyRouteRegistered(address indexed orchestrator, address indexed paymentVerifier);
    event IntentPolicySelected(bytes32 indexed intentHash, bytes32 indexed policyId, address indexed hook);
    event IntentPolicyAdjusted(
        bytes32 indexed intentHash, bytes32 indexed previousPolicyId, bytes32 indexed policyId, uint64 riskWindow
    );

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
    function onIntentSignaled(AdmissionContext calldata _context)
        external override onlyLifecycleHook nonReentrant
    {
        address depositor = _validateIntentAdmission(
            _context.intentHash, _context.escrow, _context.depositId, _context.paymentMethod
        );
        _assertPolicyRoute(_context.orchestrator, _context.paymentMethod);
        uint64 riskWindow = _requireEnabledPolicy(_context.policyId, _context.paymentMethod);
        require(riskWindow != 0 || !_context.whitelistEnabled, "DPP: Zero-window whitelist enabled");
        address stakeOwner = riskWindow == 0 ? address(0) : stakeVault.stakeOwnerOf(_context.taker);
        policyIntents[_context.intentHash] = PolicyIntent({
            taker: _context.taker,
            stakeOwner: stakeOwner,
            depositor: depositor,
            paymentMethod: _context.paymentMethod,
            status: PolicyIntentStatus.PENDING,
            riskWindow: riskWindow,
            releaseEligibleAt: 0,
            releaseAmount: 0,
            policyId: _context.policyId,
            lifecycleHook: msg.sender,
            orchestrator: _context.orchestrator
        });
        emit IntentPolicySelected(_context.intentHash, _context.policyId, msg.sender);
        if (riskWindow != 0) {
            stakeVault.lockStake(stakeOwner, _context.intentHash, _context.amount, PENDING_COVERAGE_MATURITY);
        }
        emit DisputeProtectionIntentOpened(
            _context.intentHash, stakeOwner, depositor, _context.taker, _context.paymentMethod, _context.amount, riskWindow
        );
    }

    /**
     * @inheritdoc IDisputeProtectionPolicy
     */
    function onIntentCancelled(address _orchestrator, bytes32 _intentHash) external override onlyLifecycleHook nonReentrant {
        PolicyIntent storage intent = policyIntents[_intentHash];
        _assertAdmissionOrigin(intent, _orchestrator);
        if (intent.status == PolicyIntentStatus.NONE) return;
        if (intent.status != PolicyIntentStatus.PENDING) {
            revert DisputeProtectionIntentNotPending(_intentHash, intent.status);
        }

        uint256 releasedAmount;
        if (intent.riskWindow != 0) {
            (, releasedAmount,) = stakeVault.locks(_intentHash);
        }
        intent.status = PolicyIntentStatus.CANCELLED;
        if (intent.riskWindow != 0) stakeVault.unlockStake(_intentHash);
        emit DisputeProtectionIntentCancelled(_intentHash, intent.stakeOwner, releasedAmount);
    }

    /**
     * @inheritdoc IDisputeProtectionPolicy
     */
    function onIntentSettled(address _orchestrator, bytes32 _intentHash, uint256 _releaseAmount, bool _isManualRelease)
        external
        override
        onlyLifecycleHook
        nonReentrant
    {
        PolicyIntent storage intent = policyIntents[_intentHash];
        _assertAdmissionOrigin(intent, _orchestrator);
        if (intent.status == PolicyIntentStatus.NONE) return;
        if (intent.status != PolicyIntentStatus.PENDING) {
            revert DisputeProtectionIntentNotPending(_intentHash, intent.status);
        }

        if (!_isManualRelease) {
            _assertPolicyRoute(intent.orchestrator, intent.paymentMethod);
            INullifierRegistryV2 registry =
                UnifiedPaymentVerifierV3(paymentVerifierByOrchestrator[intent.orchestrator]).nullifierRegistry();
            bytes32 nullifier = registry.nullifierByIntentHash(_intentHash);
            require(nullifier != bytes32(0), "DPP: Missing payment binding");
        }
        uint64 releaseEligibleAt = intent.riskWindow == 0
            ? 0
            : _calculateReleaseEligibleAt(intent.riskWindow);
        intent.releaseAmount = _releaseAmount;
        intent.releaseEligibleAt = releaseEligibleAt;
        intent.status = PolicyIntentStatus.SETTLED;

        if (intent.riskWindow != 0) {
            stakeVault.resizeLock(_intentHash, _releaseAmount, releaseEligibleAt);
        }
        emit DisputeProtectionIntentSettled(
            _intentHash,
            intent.stakeOwner,
            intent.depositor,
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
        PolicyIntent storage intent =
            policyIntents[_attestation.intentHash];
        if (intent.status != PolicyIntentStatus.SETTLED) {
            revert DisputeProtectionIntentNotSettled(_attestation.intentHash, intent.status);
        }
        if (intent.riskWindow == 0) revert DisputeProtectionIntentNotCovered(_attestation.intentHash);

        (bytes32 disputeId, bytes32 disputeNullifier) =
            disputeVerifier.verifyDispute(_attestation, intent.paymentMethod);
        disputeNullifierRegistry.addNullifier(disputeNullifier);

        uint256 compensatedAmount = intent.releaseAmount;
        intent.status = PolicyIntentStatus.DISPUTED;

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: intent.depositor, amount: compensatedAmount});
        stakeVault.resolveLock(_attestation.intentHash, claims);

        emit DisputeResolved(
            _attestation.intentHash,
            intent.stakeOwner,
            intent.depositor,
            compensatedAmount,
            disputeId
        );
    }

    /* ============ Protection Policies ============ */

    /// @notice Sets a method's policy terms for future admissions; admitted intents retain their snapshots.
    /// @dev Register policy zero first to enroll the method. Registration persists even when all rules are disabled.
    function setPolicy(bytes32 _paymentMethod, bytes32 _policyId, uint64 _riskWindow, bool _enabled)
        external
        onlyOwner
    {
        if (_riskWindow > MAX_RISK_WINDOW) revert InvalidRiskWindow(_riskWindow);
        require(_paymentMethod != bytes32(0), "DPP: Zero method");
        require(
            _policyId == bytes32(0) || policyRules[_paymentMethod][bytes32(0)].registered, "DPP: Method not enrolled"
        );
        policyRules[_paymentMethod][_policyId] = PolicyRule(_riskWindow, true, _enabled);
        emit PolicyUpdated(_paymentMethod, _policyId, _riskWindow, _enabled);
    }

    /// @notice Pins one orchestrator's payment verifier and its underlying signature checker.
    /// @dev The same authorized lifecycle hook may serve every registered orchestrator.
    function registerPolicyRoute(address _orchestrator, address _paymentVerifier, address _signatureVerifier)
        external onlyOwner
    {
        require(paymentVerifierByOrchestrator[_orchestrator] == address(0), "DPP: Route already registered");
        _validateDependency(_orchestrator);
        _validateDependency(_paymentVerifier);
        _validateDependency(_signatureVerifier);
        require(
            _signatureVerifier != address(this) && _signatureVerifier != _paymentVerifier, "DPP: Recursive verifier"
        );
        require(
            UnifiedPaymentVerifierV3(_paymentVerifier).orchestratorRegistry().isOrchestrator(_orchestrator),
            "DPP: Orchestrator route mismatch"
        );
        address existingVerifier = signatureVerifierByPaymentVerifier[_paymentVerifier];
        require(
            existingVerifier == address(0) || existingVerifier == _signatureVerifier, "DPP: Signature route mismatch"
        );
        signatureVerifierByPaymentVerifier[_paymentVerifier] = _signatureVerifier;
        paymentVerifierByOrchestrator[_orchestrator] = _paymentVerifier;
        emit PolicyRouteRegistered(_orchestrator, _paymentVerifier);
    }

    /// @notice Corrects the caller's pending order policy, locking any newly required collateral atomically.
    /// @dev Existing stake ownership and collateral are preserved. The snapshotted risk window never decreases.
    function adjustPolicy(bytes32 _intentHash, bytes32 _policyId) external nonReentrant {
        PolicyIntent storage intent = policyIntents[_intentHash];
        require(intent.status == PolicyIntentStatus.PENDING, "DPP: Admission not pending");
        require(msg.sender == intent.taker, "DPP: Not policy taker");
        if (admissionsPaused) revert AdmissionsPaused();
        IOrchestratorV3.Intent memory activeIntent =
            IOrchestratorV3(intent.orchestrator).getIntent(_intentHash);
        IEscrowV2.Intent memory escrowIntent =
            IEscrowV2(activeIntent.escrow).getDepositIntent(activeIntent.depositId, _intentHash);
        require(
            escrowIntent.intentHash == _intentHash && block.timestamp < escrowIntent.expiryTime,
            "DPP: Policy intent expired"
        );
        uint64 riskWindow = _requireEnabledPolicy(_policyId, intent.paymentMethod);
        address depositor =
            _validateProtectionConfiguration(activeIntent.escrow, activeIntent.depositId, intent.paymentMethod);
        if (intent.riskWindow == 0 && riskWindow != 0) {
            address stakeOwner = stakeVault.stakeOwnerOf(intent.taker);
            stakeVault.lockStake(stakeOwner, _intentHash, activeIntent.amount, PENDING_COVERAGE_MATURITY);
            intent.stakeOwner = stakeOwner;
            intent.depositor = depositor;
        }
        if (riskWindow > intent.riskWindow) intent.riskWindow = riskWindow;
        bytes32 previousPolicyId = intent.policyId;
        intent.policyId = _policyId;
        emit IntentPolicyAdjusted(_intentHash, previousPolicyId, _policyId, intent.riskWindow);
    }

    /// @notice Verifies signatures and the intent's signed policy through UPV's existing read-only extension point.
    /// @dev Only approved UPVs may supply the digest/data pair: they hash all data and validate the intent snapshot.
    /// The exact payload is PaymentDetails (6 words), IntentSnapshot (8 words), then policyId (1 word).
    function verify(bytes32 _digest, bytes[] calldata _sigs, bytes calldata _data)
        external
        view
        override
        returns (bool)
    {
        address signatureVerifier = signatureVerifierByPaymentVerifier[msg.sender];
        require(signatureVerifier != address(0), "DPP: Unauthorized payment verifier");
        require(_data.length == 480, "DPP: Invalid policy payload");
        require(IAttestationVerifier(signatureVerifier).verify(_digest, _sigs, _data), "DPP: Invalid signature");
        (, UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot, bytes32 policyId) = abi.decode(
            _data, (UnifiedPaymentVerifierV3.PaymentDetails, UnifiedPaymentVerifierV3.IntentSnapshot, bytes32)
        );
        PolicyIntent storage selected = policyIntents[snapshot.intentHash];
        require(policyId == selected.policyId, "DPP: Policy mismatch");
        if (selected.lifecycleHook != address(0)) {
            require(msg.sender == paymentVerifierByOrchestrator[selected.orchestrator], "DPP: Wrong policy verifier");
        }
        return true;
    }

    /* ============ Depositor Functions ============ */

    /**
     * @notice DEPOSITOR ONLY: Updates policy admission for one deposit payment method.
     * @dev Policy admission is enabled by default on every enrolled method; passing false opts the
     * tuple out and true undoes the opt-out. The requested value is emitted as-is; the effective state also depends on
     * payment method's enrollment. OrchestratorV3 validates Escrow registration before signaling an
     * intent; this policy only verifies that the caller is the deposit's current depositor.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose payment-method-specific configuration is updated.
     * @param _paymentMethod Payment method whose dispute protection configuration is updated.
     * @param _isEnabled Whether non-whitelisted takers may use configured policies on this payment method;
     * false opts out.
     */
    function setPolicyAdmissionEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _isEnabled)
        external
        onlyDepositor(_escrow, _depositId)
    {
        isPolicyAdmissionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod] = !_isEnabled;
        emit PolicyAdmissionEnabledUpdated(_escrow, _depositId, _paymentMethod, _isEnabled);
    }

    /* ============ Governance Functions ============ */

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
     * @dev It rejects managed admissions, including zero-window rules. Whitelisted takers return from the lifecycle
     * hook before this policy is reached. Opted-out and unenrolled methods remain gated by the whitelist or open.
     * Cancellation, settlement,
     * release, and dispute submission remain available while admissions are paused.
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
    function getPolicyIntent(bytes32 _intentHash) external view returns (PolicyIntent memory) {
        return policyIntents[_intentHash];
    }

    /**
     * @notice Returns whether a deposit payment method routes through policy admission.
     * @dev True when the depositor has not opted the tuple out and the default rule is registered.
     * Performs no validation: any escrow, any deposit id (including nonexistent ones), and any payment method with a
     * registered default rule read true. Disabled selections reject during admission instead of opening the route.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose payment-method-specific configuration is queried.
     * @param _paymentMethod Payment method whose dispute protection configuration is queried.
     */
    function isPolicyAdmissionEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod)
        external
        view
        override
        returns (bool)
    {
        return !isPolicyAdmissionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod]
            && policyRules[_paymentMethod][bytes32(0)].registered;
    }

    /**
     * @notice Returns whether a lifecycle hook may mutate dispute protection intent state.
     * @param _hook Lifecycle hook whose callback authorization is queried.
     */
    function isLifecycleHookAuthorized(address _hook) external view returns (bool) {
        return isLifecycleHookAuthorizedByHook[_hook];
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Validates policy-owned admission requirements and returns the depositor to snapshot.
     * StakeVault remains authoritative for collateral sufficiency and reverts from `lockStake` when free stake is
     * insufficient.
     */
    function _validateIntentAdmission(bytes32 _intentHash, address _escrow, uint256 _depositId, bytes32 _paymentMethod)
        internal
        view
        returns (address depositor)
    {
        if (admissionsPaused) revert AdmissionsPaused();
        if (policyIntents[_intentHash].status != PolicyIntentStatus.NONE) {
            revert DisputeProtectionIntentAlreadyExists(_intentHash);
        }
        return _validateProtectionConfiguration(_escrow, _depositId, _paymentMethod);
    }

    function _validateProtectionConfiguration(address _escrow, uint256 _depositId, bytes32 _paymentMethod)
        internal
        view
        returns (address depositor)
    {
        if (isPolicyAdmissionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod]) {
            revert PolicyAdmissionDisabled(_escrow, _depositId, _paymentMethod);
        }

        IEscrowV2.Deposit memory deposit = IEscrowV2(_escrow).getDeposit(_depositId);
        address expectedToken = address(stakeVault.stakeToken());
        if (address(deposit.token) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(deposit.token));
        }

        depositor = deposit.depositor;
    }

    function _requireEnabledPolicy(bytes32 _policyId, bytes32 _paymentMethod) internal view returns (uint64) {
        PolicyRule storage rule = policyRules[_paymentMethod][_policyId];
        require(rule.enabled, "DPP: Policy unavailable");
        return rule.riskWindow;
    }

    function _assertAdmissionOrigin(PolicyIntent storage _intent, address _orchestrator) internal view {
        if (_intent.status == PolicyIntentStatus.NONE) return;
        require(msg.sender == _intent.lifecycleHook, "DPP: Wrong admission hook");
        require(_orchestrator == _intent.orchestrator, "DPP: Wrong admission orchestrator");
    }

    function _assertPolicyRoute(address _orchestrator, bytes32 _paymentMethod) internal view {
        address paymentVerifier = paymentVerifierByOrchestrator[_orchestrator];
        require(paymentVerifier != address(0), "DPP: Missing policy route");
        require(
            IOrchestratorV3(_orchestrator).paymentVerifierRegistry().getVerifier(_paymentMethod) == paymentVerifier,
            "DPP: Payment route changed"
        );
        require(
            address(UnifiedPaymentVerifierV3(paymentVerifier).attestationVerifier()) == address(this),
            "DPP: Policy checker changed"
        );
        address[] memory writers = UnifiedPaymentVerifierV3(paymentVerifier).nullifierRegistry().getWriters();
        require(writers.length == 1 && writers[0] == paymentVerifier, "DPP: Unsafe payment writers");
    }

    function _releaseMaturedDisputeProtectionIntent(bytes32 _intentHash) internal {
        PolicyIntent storage intent = policyIntents[_intentHash];
        if (intent.status != PolicyIntentStatus.SETTLED) {
            revert DisputeProtectionIntentNotSettled(_intentHash, intent.status);
        }
        if (intent.riskWindow == 0) revert DisputeProtectionIntentNotCovered(_intentHash);

        uint64 currentTime = _currentTimestamp();
        uint64 releaseEligibleAt = intent.releaseEligibleAt;
        if (currentTime < releaseEligibleAt) {
            revert DisputeProtectionIntentNotReleaseEligible(releaseEligibleAt, currentTime);
        }

        uint256 releasedAmount = intent.releaseAmount;
        intent.status = PolicyIntentStatus.RELEASED;
        stakeVault.unlockStake(_intentHash);
        emit DisputeProtectionIntentReleased(_intentHash, intent.stakeOwner, releasedAmount);
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
