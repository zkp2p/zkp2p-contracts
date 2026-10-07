// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OrchestratorV3} from "../OrchestratorV3.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IDisputeProtectionPolicy} from "../interfaces/IDisputeProtectionPolicy.sol";
import {DisputeProtectionPolicyV2} from "./DisputeProtectionPolicyV2.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";
import {UnifiedPaymentVerifierV3} from "../unifiedVerifier/UnifiedPaymentVerifierV3.sol";

/**
 * @title IntentLifecycleHookV2
 * @notice Whitelist/open admission and proof-settled collateral policies. Only the live intent owner selects a
 * policy; permissionless fulfillment must prove that exact selection. DPP owns collateral state and saved defaults.
 * @dev Bind UPV3's witness verifier before installing this checker. Keep registered orchestrators authorized until
 * all snapshotted callbacks drain. Settlement uses stored provenance because O3 removes its intent before callbacks.
 */
contract IntentLifecycleHookV2 is IIntentLifecycleHook, IAttestationVerifier {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    DisputeProtectionPolicyV2 public immutable disputeProtectionPolicy;

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

    UnifiedPaymentVerifierV3 public paymentVerifier;
    IAttestationVerifier public signatureVerifier;

    mapping(bytes32 => PaymentPolicy) public policies;
    mapping(bytes32 => PolicyIntent) public policyIntents;

    /* ============ Events ============ */

    event PaymentVerifierInitialized(address indexed paymentVerifier, address indexed signatureVerifier);
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
        DisputeProtectionPolicyV2 _disputeProtectionPolicy
    ) {
        _validateDependency(address(_orchestratorRegistry));
        _validateDependency(address(_whitelistPolicy));
        _validateDependency(address(_disputeProtectionPolicy));

        orchestratorRegistry = _orchestratorRegistry;
        whitelistPolicy = _whitelistPolicy;
        disputeProtectionPolicy = _disputeProtectionPolicy;
    }

    /* ============ Payment Policies ============ */

    /**
     * @notice DISPUTE POLICY GOVERNANCE ONLY: Permanently binds the existing UPV3 and its current witness verifier.
     * @dev Call before installing this hook as UPV3's attestation verifier. The constructor and ordinary admission
     * dependencies are unchanged; binding enables governance to register payment policies on this hook.
     */
    function initializePaymentVerifier(UnifiedPaymentVerifierV3 _paymentVerifier) external {
        require(msg.sender == Ownable(address(disputeProtectionPolicy)).owner(), "ILH: Only dispute governance");
        require(address(paymentVerifier) == address(0), "ILH: Verifier already bound");
        _validateDependency(address(_paymentVerifier));
        require(
            address(_paymentVerifier.orchestratorRegistry()) == address(orchestratorRegistry), "ILH: Registry mismatch"
        );
        IAttestationVerifier verifier = _paymentVerifier.attestationVerifier();
        require(address(verifier) != address(this), "ILH: Cannot verify own signatures");
        paymentVerifier = _paymentVerifier;
        signatureVerifier = verifier;
        emit PaymentVerifierInitialized(address(_paymentVerifier), address(verifier));
    }

    /**
     * @notice UPV3 GOVERNANCE ONLY: Registers immutable policy terms or toggles fresh zero-stake admission.
     * @dev Only the canonical personal ID is a DEFAULT on each supported rail. DEFAULT resolves the saved DPP
     * admission window. Policy switches on existing intents are unaffected by the no-stake admission toggle.
     */
    function setPolicy(
        bytes32 _policyId,
        bytes32 _paymentMethod,
        PolicyKind _kind,
        uint64 _window,
        bool _noStakeAdmissionEnabled
    ) external {
        require(msg.sender == paymentVerifier.owner(), "ILH: Only governance");
        require(_policyId != bytes32(0) && _paymentMethod != bytes32(0), "ILH: Zero policy or method");
        require(_window <= disputeProtectionPolicy.MAX_RISK_WINDOW(), "ILH: Invalid window");
        if (_kind == PolicyKind.DEFAULT) {
            require(_policyId == _personalPolicy(_paymentMethod) && _window == 0, "ILH: Invalid default policy");
        }
        require(
            !_noStakeAdmissionEnabled || (_kind == PolicyKind.OVERRIDE && _window == 0), "ILH: Invalid no-stake policy"
        );
        PaymentPolicy storage policy = policies[_policyId];
        require(
            policy.paymentMethod == bytes32(0)
                || (policy.paymentMethod == _paymentMethod && policy.kind == _kind && policy.window == _window),
            "ILH: Policy terms immutable"
        );
        policies[_policyId] = PaymentPolicy(_paymentMethod, _kind, _window, _noStakeAdmissionEnabled);
        emit PolicyUpdated(_policyId, _paymentMethod, _kind, _window, _noStakeAdmissionEnabled);
    }

    /**
     * @notice LIVE INTENT OWNER ONLY: Selects the policy that the eventual signed proof must establish.
     * @dev First admission locks the full live intent amount with current permissions/default. Subsequent selections
     * retain that lock and its stake owner/default, including selection of zero. No proof is accepted here.
     */
    function selectPaymentPolicy(bytes32 _intentHash, bytes32 _policyId) external {
        PolicyIntent storage selected = policyIntents[_intentHash];
        require(selected.orchestrator != address(0), "ILH: No policy intent");
        require(orchestratorRegistry.isOrchestrator(selected.orchestrator), "ILH: Unregistered origin");
        IOrchestratorV3 origin = IOrchestratorV3(selected.orchestrator);
        IOrchestratorV3.Intent memory intent = origin.getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);
        require(msg.sender == intent.owner, "ILH: Only intent owner");
        require(address(origin.getIntentLifecycleHook(_intentHash)) == address(this), "ILH: Wrong intent hook");
        PaymentPolicy memory rule = policies[_policyId];
        require(rule.paymentMethod != bytes32(0), "ILH: Unknown policy");
        require(rule.paymentMethod == intent.paymentMethod, "ILH: Policy method mismatch");
        _requireVerifierInstalled(selected.orchestrator, intent.paymentMethod);
        IDisputeProtectionPolicy.DisputeProtectionIntentStatus status =
            disputeProtectionPolicy.getDisputeProtectionIntent(_intentHash).status;
        require(
            status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE
                || status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING,
            "ILH: Terminal collateral"
        );
        require(_policyId != selected.policyId, "ILH: Policy unchanged");
        if (status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE) {
            require(rule.kind == PolicyKind.DEFAULT || rule.window > 0, "ILH: No zero-to-zero selection");
            require(
                disputeProtectionPolicy.isDisputeProtectionEnabled(
                    intent.escrow, intent.depositId, intent.paymentMethod
                ),
                "ILH: Dispute protection disabled"
            );
            _admitStake(_intentHash, intent);
        }
        selected.policyId = _policyId;
        emit PaymentPolicySelected(_intentHash, _policyId);
    }

    /* ============ Lifecycle Callbacks ============ */

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentSignaled(bytes32 _intentHash) external override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        if (intent.data.length >= 32 && abi.decode(intent.data, (bytes32)) == POLICY_MARKER) {
            require(intent.data.length == 64, "ILH: Invalid policy envelope");
            (, bytes32 policyId) = abi.decode(intent.data, (bytes32, bytes32));
            PaymentPolicy memory policy = policies[policyId];
            require(policy.paymentMethod != bytes32(0), "ILH: Unknown policy");
            require(policy.kind == PolicyKind.OVERRIDE && policy.window == 0, "ILH: Not a zero policy");
            require(policy.noStakeAdmissionEnabled, "ILH: Admissions disabled");
            require(intent.paymentMethod == policy.paymentMethod, "ILH: Policy method mismatch");
            require(address(intent.postIntentHook) == address(0), "ILH: Only direct payout");
            require(
                disputeProtectionPolicy.isDisputeProtectionEnabled(
                    intent.escrow, intent.depositId, policy.paymentMethod
                ),
                "ILH: Dispute protection disabled"
            );
            _requireVerifierInstalled(msg.sender, policy.paymentMethod);
            if (
                whitelistPolicy.enabled(intent.escrow, intent.depositId, policy.paymentMethod)
                    && !whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, policy.paymentMethod, intent.owner)
            ) {
                revert TakerNotWhitelisted(intent.escrow, intent.depositId, policy.paymentMethod, intent.owner);
            }

            policyIntents[_intentHash] = PolicyIntent(policyId, msg.sender);
            emit PolicyIntentSignaled(_intentHash, policyId, msg.sender);
            return;
        }

        bool isWhitelistEnabled = whitelistPolicy.enabled(intent.escrow, intent.depositId, intent.paymentMethod);
        if (
            isWhitelistEnabled
                && whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner)
        ) {
            return;
        }
        // Dispute protection admission is stateful, so the configuration query only selects the route.
        // onIntentSignaled remains authoritative for token compatibility, collateral, and pause checks.
        if (disputeProtectionPolicy.isDisputeProtectionEnabled(intent.escrow, intent.depositId, intent.paymentMethod)) {
            bytes32 personalPolicy = _personalPolicy(intent.paymentMethod);
            PaymentPolicy memory rule = policies[personalPolicy];
            require(
                rule.paymentMethod == intent.paymentMethod && rule.kind == PolicyKind.DEFAULT,
                "ILH: Missing personal policy"
            );
            _requireVerifierInstalled(msg.sender, intent.paymentMethod);
            _admitStake(_intentHash, intent);
            policyIntents[_intentHash] = PolicyIntent(personalPolicy, msg.sender);
            emit PolicyIntentSignaled(_intentHash, personalPolicy, msg.sender);
        } else if (isWhitelistEnabled) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        PolicyIntent memory selected = policyIntents[_intentHash];
        if (selected.orchestrator != address(0)) require(selected.orchestrator == msg.sender, "ILH: Foreign intent");
        disputeProtectionPolicy.onIntentCancelled(_intentHash);
        delete policyIntents[_intentHash];
    }

    /// @inheritdoc IIntentLifecycleHook
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
        require(selected.orchestrator == msg.sender, "ILH: Foreign intent");
        if (_context.isManualRelease) {
            disputeProtectionPolicy.onIntentSettled(_context.intentHash, _context.releaseAmount, true);
        } else {
            PaymentPolicy memory rule = policies[selected.policyId];
            _requireVerifierInstalled(msg.sender, rule.paymentMethod);
            if (stake.status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE) {
                require(rule.kind == PolicyKind.OVERRIDE && rule.window == 0, "ILH: Missing stake");
            } else {
                require(
                    stake.status == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING,
                    "ILH: Terminal collateral"
                );
                uint64 window = rule.kind == PolicyKind.DEFAULT ? stake.riskWindow : rule.window;
                disputeProtectionPolicy.onIntentSettledWithWindow(_context.intentHash, _context.releaseAmount, window);
            }
        }
        delete policyIntents[_context.intentHash];
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
        bytes32 requiredPolicy = policyIntents[snapshot.intentHash].policyId;
        if (requiredPolicy != bytes32(0)) {
            if (_data.length != 480 || bytes32(_data[448:480]) != requiredPolicy) return false;
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

    function _requireVerifierInstalled(address _orchestrator, bytes32 _paymentMethod) internal view {
        require(address(paymentVerifier.attestationVerifier()) == address(this), "ILH: Verifier not installed");
        require(
            OrchestratorV3(_orchestrator).paymentVerifierRegistry().getVerifier(_paymentMethod)
                == address(paymentVerifier),
            "ILH: Wrong payment verifier"
        );
    }

    function _admitStake(bytes32 _intentHash, IOrchestratorV3.Intent memory _intent) internal {
        disputeProtectionPolicy.onIntentSignaled(
            _intentHash, _intent.escrow, _intent.depositId, _intent.owner, _intent.paymentMethod, _intent.amount
        );
        require(
            disputeProtectionPolicy.getDisputeProtectionIntent(_intentHash).status
                == IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING,
            "ILH: Stake not admitted"
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
