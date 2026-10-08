// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OrchestratorV3} from "../OrchestratorV3.sol";
import {UnifiedPaymentVerifierV3} from "../unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IDisputeProtectionPolicy} from "../interfaces/IDisputeProtectionPolicy.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title IntentLifecycleHookV1
 * @notice Lifecycle hook combining tuple-scoped whitelist admission with default-on, opt-out stake-backed dispute
 * protection. Whitelisted takers bypass staking. Non-whitelisted takers use stake-backed admission on payment methods
 * with a nonzero risk window unless the depositor opted the deposit payment method out; otherwise an enabled whitelist
 * rejects them while a whitelist-disabled deposit stays open. A payment method with a zero risk window is never routed
 * through dispute protection, so its whitelist remains the only gate.
 * Protected intents select a payment policy whose signed tag determines the collateral window at settlement.
 * @dev Reads canonical intent data from the calling orchestrator and forwards cancellation and settlement accounting
 * to DisputeProtectionPolicy. Protected intents record their originating orchestrator for terminal callbacks.
 * Bind the payment verifier before installing this hook as its attestation verifier; all callbacks fail closed.
 * Deregistering an orchestrator with unresolved intents snapshotted to this hook permanently blocks their terminal
 * callbacks, so governance must drain its intents before removing it from OrchestratorRegistry.
 */
contract IntentLifecycleHookV1 is IIntentLifecycleHook, IAttestationVerifier {
    /* ============ Policy Types ============ */

    bytes32 public constant POLICY_MARKER = keccak256("payment_policy");

    enum PolicyKind {
        DEFAULT,
        OVERRIDE
    }

    struct PaymentPolicy {
        bytes32 paymentMethod;
        PolicyKind kind;
        uint64 window;
        bool noStakeAdmissionEnabled;
    }

    struct PolicyIntent {
        bytes32 policyId;
        address orchestrator;
    }

    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    IDisputeProtectionPolicy public immutable disputeProtectionPolicy;

    UnifiedPaymentVerifierV3 public paymentVerifier;
    IAttestationVerifier public signatureVerifier;
    mapping(bytes32 => PaymentPolicy) public policies;
    mapping(bytes32 => PolicyIntent) public policyIntents;

    /* ============ Events ============ */

    event PolicyUpdated(
        bytes32 indexed policyId,
        bytes32 indexed paymentMethod,
        PolicyKind kind,
        uint64 window,
        bool noStakeAdmissionEnabled
    );
    event PaymentPolicySelected(bytes32 indexed intentHash, bytes32 indexed policyId);
    event PolicyIntentSignaled(bytes32 indexed intentHash, bytes32 indexed policyId, address indexed orchestrator);

    /* ============ Errors ============ */

    error ZeroAddress();
    error InvalidDependency(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error TakerNotWhitelisted(address escrow, uint256 depositId, bytes32 paymentMethod, address taker);

    /* ============ Constructor ============ */

    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        IWhitelistPolicy _whitelistPolicy,
        IDisputeProtectionPolicy _disputeProtectionPolicy
    ) {
        _validateDependency(address(_orchestratorRegistry));
        _validateDependency(address(_whitelistPolicy));
        _validateDependency(address(_disputeProtectionPolicy));

        orchestratorRegistry = _orchestratorRegistry;
        whitelistPolicy = _whitelistPolicy;
        disputeProtectionPolicy = _disputeProtectionPolicy;
    }

    /* ============ Lifecycle Callbacks ============ */

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentSignaled(bytes32 _intentHash) external override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);
        bytes32 policyId;
        if (intent.data.length >= 32 && abi.decode(intent.data, (bytes32)) == POLICY_MARKER) {
            require(intent.data.length == 64, "ILH: Invalid policy envelope");
            (, policyId) = abi.decode(intent.data, (bytes32, bytes32));
            PaymentPolicy memory rule = policies[policyId];
            require(rule.paymentMethod == intent.paymentMethod, "ILH: Policy method mismatch");
            require(rule.kind == PolicyKind.OVERRIDE && rule.window == 0, "ILH: Not a zero policy");
            require(rule.noStakeAdmissionEnabled, "ILH: Admissions disabled");
            require(address(intent.postIntentHook) == address(0), "ILH: Only direct payout");
            require(
                disputeProtectionPolicy.isDisputeProtectionEnabled(
                    intent.escrow, intent.depositId, intent.paymentMethod
                ),
                "ILH: Dispute protection disabled"
            );
            if (
                whitelistPolicy.enabled(intent.escrow, intent.depositId, intent.paymentMethod)
                    && !whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner)
            ) {
                revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
            }
        } else {
            bool isWhitelistEnabled = whitelistPolicy.enabled(intent.escrow, intent.depositId, intent.paymentMethod);
            if (
                isWhitelistEnabled
                    && whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner)
            ) {
                return;
            }
            // Dispute protection admission is stateful, so the configuration query only selects the route.
            // onIntentSignaled remains authoritative for token compatibility, collateral, and pause checks.
            if (
                disputeProtectionPolicy.isDisputeProtectionEnabled(
                    intent.escrow, intent.depositId, intent.paymentMethod
                )
            ) {
                disputeProtectionPolicy.onIntentSignaled(
                    _intentHash, intent.escrow, intent.depositId, intent.owner, intent.paymentMethod, intent.amount
                );
            } else if (isWhitelistEnabled) {
                revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
            } else {
                return;
            }
            policyId = _personalPolicy(intent.paymentMethod);
            require(
                policies[policyId].paymentMethod == intent.paymentMethod
                    && policies[policyId].kind == PolicyKind.DEFAULT,
                "ILH: Missing personal policy"
            );
        }
        _requireVerifierInstalled(msg.sender, intent.paymentMethod);
        policyIntents[_intentHash] = PolicyIntent(policyId, msg.sender);
        emit PolicyIntentSignaled(_intentHash, policyId, msg.sender);
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        address origin = policyIntents[_intentHash].orchestrator;
        require(origin == address(0) || origin == msg.sender, "ILH: Foreign intent");
        disputeProtectionPolicy.onIntentCancelled(_intentHash);
        delete policyIntents[_intentHash];
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function settleIntent(SettlementContext calldata _context) external override onlyOrchestrator {
        PolicyIntent memory selected = policyIntents[_context.intentHash];
        IDisputeProtectionPolicy.DisputeProtectionIntent memory stake =
            disputeProtectionPolicy.getDisputeProtectionIntent(_context.intentHash);
        if (selected.orchestrator == address(0)) {
            require(
                stake.status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE,
                "ILH: Missing policy intent"
            );
            return;
        }
        // O3 deletes its live intent before this callback, so use the origin recorded at admission.
        require(selected.orchestrator == msg.sender, "ILH: Foreign intent");
        uint64 window = stake.riskWindow;
        if (!_context.isManualRelease) {
            PaymentPolicy memory rule = policies[selected.policyId];
            _requireVerifierInstalled(msg.sender, rule.paymentMethod);
            if (stake.status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE) {
                require(rule.kind == PolicyKind.OVERRIDE && rule.window == 0, "ILH: Missing stake");
            }
            if (rule.kind == PolicyKind.OVERRIDE) window = rule.window;
        }
        disputeProtectionPolicy.onIntentSettled(
            _context.intentHash, _context.releaseAmount, window, _context.isManualRelease
        );
        delete policyIntents[_context.intentHash];
    }

    /* ============ Payment Policies ============ */

    /// @notice DPP OWNER ONLY: Binds UPV and captures its witness verifier once, before this hook is installed.
    function initializePaymentVerifier(UnifiedPaymentVerifierV3 _paymentVerifier) external {
        require(msg.sender == Ownable(address(disputeProtectionPolicy)).owner(), "ILH: Only governance");
        require(address(paymentVerifier) == address(0), "ILH: Verifier initialized");
        require(_paymentVerifier.orchestratorRegistry() == orchestratorRegistry, "ILH: Registry mismatch");
        IAttestationVerifier verifier = _paymentVerifier.attestationVerifier();
        require(address(verifier) != address(this), "ILH: Hook already installed");
        paymentVerifier = _paymentVerifier;
        signatureVerifier = verifier;
    }

    /// @notice UPV3 OWNER ONLY: Registers immutable policy terms or toggles admission for an existing zero-window rule.
    function setPolicy(
        bytes32 _policyId,
        bytes32 _method,
        PolicyKind _kind,
        uint64 _window,
        bool _noStakeAdmissionEnabled
    ) external {
        require(msg.sender == paymentVerifier.owner(), "ILH: Only governance");
        require(_policyId != bytes32(0) && _method != bytes32(0), "ILH: Zero policy or method");
        require(_window <= disputeProtectionPolicy.MAX_RISK_WINDOW(), "ILH: Invalid window");
        if (_kind == PolicyKind.DEFAULT) {
            require(_policyId == _personalPolicy(_method) && _window == 0, "ILH: Invalid default policy");
        }
        require(
            !_noStakeAdmissionEnabled || (_kind == PolicyKind.OVERRIDE && _window == 0), "ILH: Invalid no-stake policy"
        );
        PaymentPolicy storage policy = policies[_policyId];
        require(
            policy.paymentMethod == bytes32(0)
                || (policy.paymentMethod == _method && policy.kind == _kind && policy.window == _window),
            "ILH: Policy terms immutable"
        );
        policies[_policyId] = PaymentPolicy(_method, _kind, _window, _noStakeAdmissionEnabled);
        emit PolicyUpdated(_policyId, _method, _kind, _window, _noStakeAdmissionEnabled);
    }

    /// @notice INTENT OWNER ONLY: Selects the policy the payment proof must establish. Selection never unlocks stake.
    /// @dev First positive selection on an unstaked intent locks its full amount using current admission permissions.
    function selectPaymentPolicy(bytes32 _intentHash, bytes32 _policyId) external {
        PolicyIntent storage selected = policyIntents[_intentHash];
        require(selected.orchestrator != address(0), "ILH: No policy intent");
        require(orchestratorRegistry.isOrchestrator(selected.orchestrator), "ILH: Unregistered origin");
        IOrchestratorV3 origin = IOrchestratorV3(selected.orchestrator);
        IOrchestratorV3.Intent memory intent = origin.getIntent(_intentHash);
        require(msg.sender == intent.owner, "ILH: Only intent owner");
        require(address(origin.getIntentLifecycleHook(_intentHash)) == address(this), "ILH: Wrong intent hook");
        require(_policyId != selected.policyId, "ILH: Policy unchanged");
        PaymentPolicy memory rule = policies[_policyId];
        require(
            rule.paymentMethod == intent.paymentMethod && rule.paymentMethod != bytes32(0),
            "ILH: Policy method mismatch"
        );
        _requireVerifierInstalled(selected.orchestrator, intent.paymentMethod);
        IDisputeProtectionPolicy.DisputeProtectionIntentStatus status =
            disputeProtectionPolicy.getDisputeProtectionIntent(_intentHash).status;
        require(
            status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE
                || status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING,
            "ILH: Terminal collateral"
        );
        if (status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE) {
            require(rule.kind == PolicyKind.DEFAULT || rule.window > 0, "ILH: No zero-to-zero selection");
            disputeProtectionPolicy.onIntentSignaled(
                _intentHash, intent.escrow, intent.depositId, intent.owner, intent.paymentMethod, intent.amount
            );
            require(
                disputeProtectionPolicy.getDisputeProtectionIntent(_intentHash).status
                    == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING,
                "ILH: Stake not admitted"
            );
        }
        selected.policyId = _policyId;
        emit PaymentPolicySelected(_intentHash, _policyId);
    }

    /// @inheritdoc IAttestationVerifier
    function verify(bytes32 _digest, bytes[] calldata _sigs, bytes calldata _data)
        external
        view
        override
        returns (bool)
    {
        (, UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot) =
            abi.decode(_data, (UnifiedPaymentVerifierV3.PaymentDetails, UnifiedPaymentVerifierV3.IntentSnapshot));
        bytes32 selected = policyIntents[snapshot.intentHash].policyId;
        if (selected != bytes32(0)) {
            if (_data.length != 480 || bytes32(_data[448:480]) != selected) return false;
        } else if (
            disputeProtectionPolicy.getDisputeProtectionIntent(snapshot.intentHash).status
                == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING
        ) {
            return false;
        }
        return signatureVerifier.verify(_digest, _sigs, _data);
    }

    /* ============ Modifiers ============ */

    modifier onlyOrchestrator() {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Internal Functions ============ */

    function _requireVerifierInstalled(address _orchestrator, bytes32 _method) internal view {
        require(address(paymentVerifier.attestationVerifier()) == address(this), "ILH: Verifier not installed");
        require(
            OrchestratorV3(_orchestrator).paymentVerifierRegistry().getVerifier(_method) == address(paymentVerifier),
            "ILH: Wrong payment verifier"
        );
    }

    function _personalPolicy(bytes32 _method) internal pure returns (bytes32) {
        if (_method == keccak256("venmo")) return keccak256("venmo_personal");
        if (_method == keccak256("paypal")) return keccak256("paypal_personal");
        revert("ILH: Unsupported protected method");
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidDependency(_dependency);
    }
}
