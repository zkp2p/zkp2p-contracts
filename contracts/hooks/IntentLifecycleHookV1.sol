// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OrchestratorV3} from "../OrchestratorV3.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IDisputeProtectionPolicy} from "../interfaces/IDisputeProtectionPolicy.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";
import {UnifiedPaymentVerifierV3} from "../unifiedVerifier/UnifiedPaymentVerifierV3.sol";

/**
 * @title IntentLifecycleHookV1
 * @notice Lifecycle hook combining tuple-scoped whitelist admission with default-on, opt-out stake-backed dispute
 * protection. Whitelisted takers bypass staking. Non-whitelisted takers use stake-backed admission on payment methods
 * with a nonzero risk window unless the depositor opted the deposit payment method out; otherwise an enabled whitelist
 * rejects them while a whitelist-disabled deposit stays open. A payment method with a zero risk window is never routed
 * through dispute protection, so its whitelist remains the only gate. Governance-enabled payment policies on protected
 * deposits admit direct payouts without staking and require a matching signed policy word at settlement.
 * @dev Reads canonical intent data from the calling orchestrator and forwards cancellation and settlement accounting
 * to DisputeProtectionPolicy for ordinary intents. Policy intents snapshot their originating orchestrator and policy.
 * Bind the current UPV3 once before installing this hook as its attestation verifier; the captured witness verifier
 * authenticates the complete signed payload. Ordinary callbacks retain DisputeProtectionPolicy's trust boundary.
 * Deregistering an orchestrator with unresolved intents snapshotted to this hook permanently blocks their terminal
 * callbacks, so governance must drain its intents before removing it from OrchestratorRegistry.
 */
contract IntentLifecycleHookV1 is IIntentLifecycleHook, IAttestationVerifier {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    IDisputeProtectionPolicy public immutable disputeProtectionPolicy;

    bytes32 public constant POLICY_MARKER = keccak256("payment_policy");

    struct PaymentPolicy {
        bytes32 paymentMethod;
        bool admissionEnabled;
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
    event PolicyUpdated(bytes32 indexed policyId, bytes32 indexed paymentMethod, bool admissionEnabled);
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
     * @notice UPV3 GOVERNANCE ONLY: Registers a zero-stake policy or enables/disables its future admissions.
     * @dev A registered policy's payment method can never change, including while admissions are disabled.
     */
    function setPolicy(bytes32 _policyId, bytes32 _paymentMethod, bool _admissionEnabled) external {
        require(msg.sender == paymentVerifier.owner(), "ILH: Only governance");
        require(_policyId != bytes32(0) && _paymentMethod != bytes32(0), "ILH: Zero policy or method");
        PaymentPolicy storage policy = policies[_policyId];
        require(
            policy.paymentMethod == bytes32(0) || policy.paymentMethod == _paymentMethod, "ILH: Policy method immutable"
        );
        policy.paymentMethod = _paymentMethod;
        policy.admissionEnabled = _admissionEnabled;
        emit PolicyUpdated(_policyId, _paymentMethod, _admissionEnabled);
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
            require(policy.admissionEnabled, "ILH: Admissions disabled");
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
            disputeProtectionPolicy.onIntentSignaled(
                _intentHash, intent.escrow, intent.depositId, intent.owner, intent.paymentMethod, intent.amount
            );
        } else if (isWhitelistEnabled) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        PolicyIntent memory intent = policyIntents[_intentHash];
        if (intent.orchestrator == address(0)) {
            disputeProtectionPolicy.onIntentCancelled(_intentHash);
        } else {
            require(intent.orchestrator == msg.sender, "ILH: Foreign intent");
            delete policyIntents[_intentHash];
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function settleIntent(SettlementContext calldata _context) external override onlyOrchestrator {
        PolicyIntent memory intent = policyIntents[_context.intentHash];
        if (intent.orchestrator == address(0)) {
            disputeProtectionPolicy.onIntentSettled(
                _context.intentHash, _context.releaseAmount, _context.isManualRelease
            );
        } else {
            require(intent.orchestrator == msg.sender, "ILH: Foreign intent");
            // Changing the checker or method route cannot bypass a pending policy's signed evidence.
            // Maker-authorized manual release retains its existing trusted behavior.
            if (!_context.isManualRelease) {
                _requireVerifierInstalled(msg.sender, policies[intent.policyId].paymentMethod);
            }
            delete policyIntents[_context.intentHash];
        }
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

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidDependency(_dependency);
    }
}
