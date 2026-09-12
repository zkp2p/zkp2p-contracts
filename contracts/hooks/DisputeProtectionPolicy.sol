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
import {IPaymentVerifierRegistry} from "../interfaces/IPaymentVerifierRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {OrchestratorV3} from "../OrchestratorV3.sol";
import {IntentLifecycleHookV1} from "./IntentLifecycleHookV1.sol";
import {UnifiedPaymentVerifierV3} from "../unifiedVerifier/UnifiedPaymentVerifierV3.sol";

/**
 * @title DisputeProtectionPolicy
 * @notice Default stake-backed dispute protection with explicitly selected, signed-evidence bypass policies.
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
 *
 * Bypass routes pin reviewed non-proxy dependencies. The payment verifier must remain the sole V2 payment-registry
 * writer and must call this policy as its attestation checker. Runtime checks fail closed on route changes; they do
 * not remove the existing trust in governance or registered orchestrators' callback behavior.
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
        isDisputeProtectionDisabledByPaymentMethod;

    /// @dev Minimum collateral lock window for each payment method.
    mapping(bytes32 => uint64) internal paymentMethodRiskWindow;

    /// @dev Dispute protection lifecycle state keyed by globally unique intent hash.
    mapping(bytes32 => DisputeProtectionIntent) internal disputeProtectionIntentByIntentHash;

    struct BypassRule {
        bytes32 paymentMethod;
        bool enabled;
    }

    /// @dev A hook has one immutable bypass route. A replacement route requires a new hook instance.
    struct BypassRoute {
        address orchestrator;
        address paymentVerifier;
        address paymentVerifierRegistry;
        address nullifierRegistry;
    }

    /// @dev Retained after recovery; the ordinary coverage status then requires policy zero.
    struct BypassAdmission {
        bytes32 policyId;
        address lifecycleHook;
        address escrow;
        uint256 depositId;
        uint256 amount;
    }

    mapping(bytes32 => BypassRule) public bypassRules;
    mapping(address => BypassRoute) public bypassRoutes;
    mapping(address => address) public signatureVerifierByPaymentVerifier;
    mapping(bytes32 => bytes32) internal bypassPolicyChoices;
    mapping(bytes32 => BypassAdmission) internal bypassAdmissions;

    event BypassPolicyRegistered(bytes32 indexed policyId, bytes32 indexed paymentMethod);
    event BypassPolicyEnabled(bytes32 indexed policyId, bool enabled);
    event BypassRouteRegistered(address indexed hook, address indexed orchestrator, address indexed paymentVerifier);
    event BypassPolicyChoiceUpdated(
        address indexed taker,
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        bytes32 policyId
    );
    event BypassIntentOpened(bytes32 indexed intentHash, bytes32 indexed policyId, address indexed hook);
    event BypassIntentProtected(bytes32 indexed intentHash, address indexed stakeOwner, uint256 amount);

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

        address depositor = _validateIntentAdmission(_intentHash, _escrow, _depositId, _paymentMethod);
        bytes32 policyId = getBypassPolicyChoice(_taker, _escrow, _depositId, _paymentMethod);
        address stakeOwner;
        if (policyId != bytes32(0)) {
            _requireEnabledBypassPolicy(policyId, _paymentMethod);
            _assertBypassRoute(msg.sender, _paymentMethod);
            // Whitelisted takers already use the hook's existing no-coverage route. A new
            // no-stake admission must not let a nonmember evade an enabled whitelist.
            require(
                !IntentLifecycleHookV1(msg.sender).whitelistPolicy().enabled(_escrow, _depositId, _paymentMethod),
                "DPP: Bypass whitelist enabled"
            );
            bypassAdmissions[_intentHash] = BypassAdmission(policyId, msg.sender, _escrow, _depositId, _amount);
        } else {
            stakeOwner = stakeVault.stakeOwnerOf(_taker);
        }

        disputeProtectionIntentByIntentHash[_intentHash] = DisputeProtectionIntent({
            taker: _taker,
            stakeOwner: stakeOwner,
            depositor: depositor,
            paymentMethod: _paymentMethod,
            status: DisputeProtectionIntentStatus.PENDING,
            riskWindow: policyId == bytes32(0) ? riskWindow : 0,
            releaseEligibleAt: 0,
            releaseAmount: 0
        });

        if (policyId != bytes32(0)) {
            _assertActiveBypassIntent(_intentHash);
            emit BypassIntentOpened(_intentHash, policyId, msg.sender);
            return;
        }
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
        _assertAdmissionHook(_intentHash);
        if (disputeProtectionIntent.status == DisputeProtectionIntentStatus.NONE) return;
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.PENDING) {
            revert DisputeProtectionIntentNotPending(_intentHash, disputeProtectionIntent.status);
        }

        uint256 releasedAmount;
        if (disputeProtectionIntent.riskWindow != 0) {
            (, releasedAmount,) = stakeVault.locks(_intentHash);
        }
        disputeProtectionIntent.status = DisputeProtectionIntentStatus.CANCELLED;
        if (disputeProtectionIntent.riskWindow != 0) stakeVault.unlockStake(_intentHash);
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
        _assertAdmissionHook(_intentHash);
        if (disputeProtectionIntent.status == DisputeProtectionIntentStatus.NONE) return;
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.PENDING) {
            revert DisputeProtectionIntentNotPending(_intentHash, disputeProtectionIntent.status);
        }

        uint64 releaseEligibleAt;
        if (disputeProtectionIntent.riskWindow == 0) {
            BypassAdmission storage admission = bypassAdmissions[_intentHash];
            require(_releaseAmount != 0 && _releaseAmount <= admission.amount, "DPP: Invalid bypass amount");
            if (!_isManualRelease) {
                _assertBypassRoute(admission.lifecycleHook, disputeProtectionIntent.paymentMethod);
                INullifierRegistryV2 registry =
                    INullifierRegistryV2(bypassRoutes[admission.lifecycleHook].nullifierRegistry);
                bytes32 nullifier = registry.nullifierByIntentHash(_intentHash);
                require(
                    nullifier != bytes32(0) && registry.intentHashByNullifier(nullifier) == _intentHash,
                    "DPP: Missing payment binding"
                );
            }
        } else {
            releaseEligibleAt = _calculateReleaseEligibleAt(disputeProtectionIntent.riskWindow);
        }
        disputeProtectionIntent.releaseAmount = _releaseAmount;
        disputeProtectionIntent.releaseEligibleAt = releaseEligibleAt;
        disputeProtectionIntent.status = DisputeProtectionIntentStatus.SETTLED;

        if (disputeProtectionIntent.riskWindow != 0) {
            stakeVault.resizeLock(_intentHash, _releaseAmount, releaseEligibleAt);
        }
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
        if (disputeProtectionIntent.riskWindow == 0) revert DisputeProtectionIntentNotCovered(_attestation.intentHash);

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

    /* ============ Bypass Policies ============ */

    /// @notice Registers an immutable evidence-rule identity for one payment method, globally for all makers.
    function registerBypassPolicy(bytes32 _policyId, bytes32 _paymentMethod) external onlyOwner {
        require(_policyId != bytes32(0) && _paymentMethod != bytes32(0), "DPP: Zero bypass policy");
        require(bypassRules[_policyId].paymentMethod == bytes32(0), "DPP: Policy already registered");
        bypassRules[_policyId] = BypassRule(_paymentMethod, true);
        emit BypassPolicyRegistered(_policyId, _paymentMethod);
    }

    /// @notice Enables or disables new admissions; existing admissions retain their evidence obligation.
    function setBypassPolicyEnabled(bytes32 _policyId, bool _enabled) external onlyOwner {
        require(bypassRules[_policyId].paymentMethod != bytes32(0), "DPP: Unknown bypass policy");
        bypassRules[_policyId].enabled = _enabled;
        emit BypassPolicyEnabled(_policyId, _enabled);
    }

    /// @notice Pins the reviewed non-proxy dependencies for a hook's bypass admissions.
    /// @dev Configure UPV's attestation verifier to this policy in the same governance cutover.
    /// The hook omits its originating caller, so one originating orchestrator is registered per hook.
    function registerBypassRoute(
        address _hook,
        address _orchestrator,
        address _paymentVerifier,
        address _signatureVerifier
    ) external onlyOwner {
        require(isLifecycleHookAuthorizedByHook[_hook], "DPP: Unauthorized bypass hook");
        require(bypassRoutes[_hook].orchestrator == address(0), "DPP: Route already registered");
        _validateDependency(_orchestrator);
        _validateDependency(_paymentVerifier);
        _validateDependency(_signatureVerifier);
        require(
            _signatureVerifier != address(this) && _signatureVerifier != _paymentVerifier, "DPP: Recursive verifier"
        );
        IntentLifecycleHookV1 hook = IntentLifecycleHookV1(_hook);
        UnifiedPaymentVerifierV3 paymentVerifier = UnifiedPaymentVerifierV3(_paymentVerifier);
        require(address(hook.disputeProtectionPolicy()) == address(this), "DPP: Hook policy mismatch");
        require(
            address(hook.orchestratorRegistry()) == address(paymentVerifier.orchestratorRegistry())
                && hook.orchestratorRegistry().isOrchestrator(_orchestrator),
            "DPP: Orchestrator route mismatch"
        );
        address existingVerifier = signatureVerifierByPaymentVerifier[_paymentVerifier];
        require(
            existingVerifier == address(0) || existingVerifier == _signatureVerifier, "DPP: Signature route mismatch"
        );
        signatureVerifierByPaymentVerifier[_paymentVerifier] = _signatureVerifier;
        bypassRoutes[_hook] = BypassRoute(
            _orchestrator,
            _paymentVerifier,
            address(OrchestratorV3(_orchestrator).paymentVerifierRegistry()),
            address(paymentVerifier.nullifierRegistry())
        );
        emit BypassRouteRegistered(_hook, _orchestrator, _paymentVerifier);
    }

    /// @notice Saves the caller's choice for future intents; zero chooses ordinary stake-backed protection.
    function setBypassPolicyChoice(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bytes32 _policyId)
        external
    {
        if (_policyId != bytes32(0)) _requireEnabledBypassPolicy(_policyId, _paymentMethod);
        bypassPolicyChoices[keccak256(abi.encode(msg.sender, _escrow, _depositId, _paymentMethod))] = _policyId;
        emit BypassPolicyChoiceUpdated(msg.sender, _escrow, _depositId, _paymentMethod, _policyId);
    }

    /// @notice Returns a buyer's saved choice, not the admission outcome for an existing order.
    function getBypassPolicyChoice(address _taker, address _escrow, uint256 _depositId, bytes32 _paymentMethod)
        public
        view
        returns (bytes32)
    {
        return bypassPolicyChoices[keccak256(abi.encode(_taker, _escrow, _depositId, _paymentMethod))];
    }

    /// @notice Returns the immutable bypass origin, including after conversion to protected admission.
    function getBypassAdmission(bytes32 _intentHash) external view returns (BypassAdmission memory) {
        return bypassAdmissions[_intentHash];
    }

    /// @notice Locks collateral and irreversibly converts the caller's active bypass order to protected admission.
    function convertBypassToProtected(bytes32 _intentHash) external nonReentrant {
        DisputeProtectionIntent storage intent = disputeProtectionIntentByIntentHash[_intentHash];
        require(
            intent.status == DisputeProtectionIntentStatus.PENDING && intent.riskWindow == 0, "DPP: Bypass not pending"
        );
        require(msg.sender == intent.taker, "DPP: Not bypass taker");
        if (admissionsPaused) revert AdmissionsPaused();
        _assertActiveBypassIntent(_intentHash);
        BypassAdmission storage admission = bypassAdmissions[_intentHash];
        IEscrowV2.Intent memory escrowIntent =
            IEscrowV2(admission.escrow).getDepositIntent(admission.depositId, _intentHash);
        require(
            escrowIntent.intentHash == _intentHash && block.timestamp < escrowIntent.expiryTime, "DPP: Bypass expired"
        );
        uint64 riskWindow = paymentMethodRiskWindow[intent.paymentMethod];
        require(riskWindow != 0, "DPP: Protection unavailable");
        address depositor =
            _validateProtectionConfiguration(admission.escrow, admission.depositId, intent.paymentMethod);
        address stakeOwner = stakeVault.stakeOwnerOf(intent.taker);
        stakeVault.lockStake(stakeOwner, _intentHash, admission.amount, PENDING_COVERAGE_MATURITY);
        intent.stakeOwner = stakeOwner;
        intent.depositor = depositor;
        intent.riskWindow = riskWindow;
        emit DisputeProtectionIntentOpened(
            _intentHash, stakeOwner, depositor, intent.taker, intent.paymentMethod, admission.amount, riskWindow
        );
        emit BypassIntentProtected(_intentHash, stakeOwner, admission.amount);
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
        (
            UnifiedPaymentVerifierV3.PaymentDetails memory payment,
            UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot,
            bytes32 policyId
        ) = abi.decode(
            _data, (UnifiedPaymentVerifierV3.PaymentDetails, UnifiedPaymentVerifierV3.IntentSnapshot, bytes32)
        );
        DisputeProtectionIntent storage intent = disputeProtectionIntentByIntentHash[snapshot.intentHash];
        if (intent.status == DisputeProtectionIntentStatus.PENDING && intent.riskWindow == 0) {
            BypassAdmission storage admission = bypassAdmissions[snapshot.intentHash];
            require(
                policyId == admission.policyId && payment.method == intent.paymentMethod, "DPP: Bypass policy mismatch"
            );
            require(msg.sender == bypassRoutes[admission.lifecycleHook].paymentVerifier, "DPP: Wrong bypass verifier");
            _assertBypassRoute(admission.lifecycleHook, intent.paymentMethod);
            _assertActiveBypassIntent(snapshot.intentHash);
        } else {
            require(policyId == bytes32(0), "DPP: Bypass admission required");
            require(
                intent.status == DisputeProtectionIntentStatus.NONE
                    || intent.status == DisputeProtectionIntentStatus.PENDING,
                "DPP: Admission not pending"
            );
        }
        return true;
    }

    /* ============ Depositor Functions ============ */

    /**
     * @notice DEPOSITOR ONLY: Updates dispute protection for one deposit payment method.
     * @dev Protection is enabled by default on every payment method with a nonzero risk window; passing false opts the
     * tuple out and true undoes the opt-out. The requested value is emitted as-is; the effective state also depends on
     * the payment method's current risk window. OrchestratorV3 validates Escrow registration before signaling an
     * intent; this policy only verifies that the caller is the deposit's current depositor.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose payment-method-specific configuration is updated.
     * @param _paymentMethod Payment method whose dispute protection configuration is updated.
     * @param _isEnabled Whether non-whitelisted takers may use stake-backed dispute protection on this payment method;
     * false opts out.
     */
    function setDisputeProtectionEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _isEnabled)
        external
        onlyDepositor(_escrow, _depositId)
    {
        isDisputeProtectionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod] = !_isEnabled;
        emit DisputeProtectionEnabledUpdated(_escrow, _depositId, _paymentMethod, _isEnabled);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Sets the minimum collateral lock window for future intents of a payment method.
     * @dev A zero window means the payment method is never routed through dispute protection: the lifecycle hook then
     * applies the deposit's whitelist (rejecting non-members when it is enabled) or admits openly when it is disabled.
     * Changing the window affects future admissions only; admitted intents keep their snapshotted window.
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
     * @dev It rejects every non-whitelisted taker on every non-opted-out deposit payment method with a nonzero risk
     * window. Whitelisted takers return from the lifecycle hook before this policy is reached, and payment methods with
     * a zero risk window return before the pause check. Explicitly opted-out deposit payment methods and zero-window
     * payment methods never reach this policy and stay gated by the whitelist or open. Cancellation, settlement,
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
    function getDisputeProtectionIntent(bytes32 _intentHash) external view returns (DisputeProtectionIntent memory) {
        return disputeProtectionIntentByIntentHash[_intentHash];
    }

    /**
     * @notice Returns the effective stake-backed dispute protection state for a deposit payment method.
     * @dev True when the depositor has not opted the tuple out and the payment method has a nonzero risk window.
     * Performs no validation: any escrow, any deposit id (including nonexistent ones), and any payment method with a
     * nonzero window read true.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose payment-method-specific configuration is queried.
     * @param _paymentMethod Payment method whose dispute protection configuration is queried.
     */
    function isDisputeProtectionEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod)
        external
        view
        override
        returns (bool)
    {
        return !isDisputeProtectionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod]
            && paymentMethodRiskWindow[_paymentMethod] != 0;
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
        if (disputeProtectionIntentByIntentHash[_intentHash].status != DisputeProtectionIntentStatus.NONE) {
            revert DisputeProtectionIntentAlreadyExists(_intentHash);
        }
        return _validateProtectionConfiguration(_escrow, _depositId, _paymentMethod);
    }

    function _validateProtectionConfiguration(address _escrow, uint256 _depositId, bytes32 _paymentMethod)
        internal
        view
        returns (address depositor)
    {
        if (isDisputeProtectionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod]) {
            revert DisputeProtectionNotEnabled(_escrow, _depositId, _paymentMethod);
        }

        IEscrowV2.Deposit memory deposit = IEscrowV2(_escrow).getDeposit(_depositId);
        address expectedToken = address(stakeVault.stakeToken());
        if (address(deposit.token) != expectedToken) {
            revert IntentTokenMismatch(expectedToken, address(deposit.token));
        }

        depositor = deposit.depositor;
    }

    function _requireEnabledBypassPolicy(bytes32 _policyId, bytes32 _paymentMethod) internal view {
        BypassRule storage rule = bypassRules[_policyId];
        require(rule.enabled && rule.paymentMethod == _paymentMethod, "DPP: Bypass policy unavailable");
    }

    function _assertAdmissionHook(bytes32 _intentHash) internal view {
        address hook = bypassAdmissions[_intentHash].lifecycleHook;
        require(hook == address(0) || msg.sender == hook, "DPP: Wrong admission hook");
    }

    function _assertActiveBypassIntent(bytes32 _intentHash) internal view {
        BypassAdmission storage admission = bypassAdmissions[_intentHash];
        DisputeProtectionIntent storage recorded = disputeProtectionIntentByIntentHash[_intentHash];
        IOrchestratorV3 orchestrator = IOrchestratorV3(bypassRoutes[admission.lifecycleHook].orchestrator);
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(_intentHash);
        require(
            intent.owner != address(0) && intent.owner == recorded.taker && intent.escrow == admission.escrow
                && intent.depositId == admission.depositId && intent.amount == admission.amount
                && intent.paymentMethod == recorded.paymentMethod
                && address(orchestrator.getIntentLifecycleHook(_intentHash)) == admission.lifecycleHook,
            "DPP: Bypass intent mismatch"
        );
    }

    function _assertBypassRoute(address _hook, bytes32 _paymentMethod) internal view {
        BypassRoute storage route = bypassRoutes[_hook];
        require(route.orchestrator != address(0), "DPP: Missing bypass route");
        require(
            address(OrchestratorV3(route.orchestrator).paymentVerifierRegistry()) == route.paymentVerifierRegistry
                && IPaymentVerifierRegistry(route.paymentVerifierRegistry).getVerifier(_paymentMethod)
                    == route.paymentVerifier,
            "DPP: Payment route changed"
        );
        require(
            address(UnifiedPaymentVerifierV3(route.paymentVerifier).attestationVerifier()) == address(this),
            "DPP: Policy checker changed"
        );
        address[] memory writers = INullifierRegistryV2(route.nullifierRegistry).getWriters();
        require(writers.length == 1 && writers[0] == route.paymentVerifier, "DPP: Unsafe payment writers");
    }

    function _releaseMaturedDisputeProtectionIntent(bytes32 _intentHash) internal {
        DisputeProtectionIntent storage disputeProtectionIntent = disputeProtectionIntentByIntentHash[_intentHash];
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.SETTLED) {
            revert DisputeProtectionIntentNotSettled(_intentHash, disputeProtectionIntent.status);
        }
        if (disputeProtectionIntent.riskWindow == 0) revert DisputeProtectionIntentNotCovered(_intentHash);

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
