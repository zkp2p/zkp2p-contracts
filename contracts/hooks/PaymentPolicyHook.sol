// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IntentLifecycleHookV1} from "./IntentLifecycleHookV1.sol";
import {OrchestratorV3} from "../OrchestratorV3.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IDisputeProtectionPolicy} from "../interfaces/IDisputeProtectionPolicy.sol";
import {IEscrow} from "../interfaces/IEscrow.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";
import {UnifiedPaymentVerifierV3} from "../unifiedVerifier/UnifiedPaymentVerifierV3.sol";

/**
 * @title PaymentPolicyHook
 * @notice Maker-approved payment policies admit direct-payout intents without dispute staking and require signed policy evidence.
 * @dev Install as both the existing UPV3's attestation verifier and O3's lifecycle hook. Each policy is permanently
 * bound to one payment method. Policy proofs append the required policy ID to the existing 448-byte signed payload;
 * the original witness verifier authenticates the complete digest. Ordinary intents retain V1 admission and proofs.
 */
contract PaymentPolicyHook is IntentLifecycleHookV1, IAttestationVerifier {
    bytes32 public constant POLICY_MARKER = keccak256("payment_policy");

    struct PaymentPolicy {
        bytes32 paymentMethod;
        bool admissionEnabled;
    }

    struct PolicyIntent {
        bytes32 policyId;
        address orchestrator;
    }

    UnifiedPaymentVerifierV3 public immutable paymentVerifier;
    IAttestationVerifier public immutable signatureVerifier;

    mapping(bytes32 => PaymentPolicy) public policies;
    mapping(address => mapping(uint256 => mapping(bytes32 => bool))) public depositPolicyEnabled;
    mapping(bytes32 => PolicyIntent) public policyIntents;

    event PolicyUpdated(bytes32 indexed policyId, bytes32 indexed paymentMethod, bool admissionEnabled);
    event DepositPolicyEnabled(
        address indexed escrow, uint256 indexed depositId, bytes32 indexed policyId, bool enabled
    );
    event PolicyIntentSignaled(bytes32 indexed intentHash, bytes32 indexed policyId, address indexed orchestrator);

    constructor(
        UnifiedPaymentVerifierV3 _paymentVerifier,
        IWhitelistPolicy _whitelistPolicy,
        IDisputeProtectionPolicy _disputeProtectionPolicy
    ) IntentLifecycleHookV1(_paymentVerifier.orchestratorRegistry(), _whitelistPolicy, _disputeProtectionPolicy) {
        paymentVerifier = _paymentVerifier;
        signatureVerifier = _paymentVerifier.attestationVerifier();
    }

    /**
     * @notice UPV3 GOVERNANCE ONLY: Registers a zero-stake policy or enables/disables its future admissions.
     * @dev A registered policy's payment method can never change, including while admissions are disabled.
     */
    function setPolicy(bytes32 _policyId, bytes32 _paymentMethod, bool _admissionEnabled) external {
        require(msg.sender == paymentVerifier.owner(), "PPH: Only governance");
        require(_policyId != bytes32(0) && _paymentMethod != bytes32(0), "PPH: Zero policy or method");
        PaymentPolicy storage policy = policies[_policyId];
        require(
            policy.paymentMethod == bytes32(0) || policy.paymentMethod == _paymentMethod, "PPH: Policy method immutable"
        );
        policy.paymentMethod = _paymentMethod;
        policy.admissionEnabled = _admissionEnabled;
        emit PolicyUpdated(_policyId, _paymentMethod, _admissionEnabled);
    }

    /**
     * @notice DEPOSITOR ONLY: Offers a registered policy on an existing deposit, reusing its payment method and rates.
     * @dev Disabled by default. Both maker and governance changes affect future admissions only.
     */
    function setDepositPolicyEnabled(address _escrow, uint256 _depositId, bytes32 _policyId, bool _enabled) external {
        require(policies[_policyId].paymentMethod != bytes32(0), "PPH: Unknown policy");
        require(whitelistPolicy.escrowRegistry().isWhitelistedEscrow(_escrow), "PPH: Invalid escrow");
        require(IEscrow(_escrow).getDeposit(_depositId).depositor == msg.sender, "PPH: Only depositor");
        depositPolicyEnabled[_escrow][_depositId][_policyId] = _enabled;
        emit DepositPolicyEnabled(_escrow, _depositId, _policyId, _enabled);
    }

    /// @inheritdoc IntentLifecycleHookV1
    function onIntentSignaled(bytes32 _intentHash) public override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.data.length < 32 || abi.decode(intent.data, (bytes32)) != POLICY_MARKER) {
            super.onIntentSignaled(_intentHash);
            return;
        }

        require(intent.data.length == 64, "PPH: Invalid policy envelope");
        (, bytes32 policyId) = abi.decode(intent.data, (bytes32, bytes32));
        PaymentPolicy memory policy = policies[policyId];
        require(policy.paymentMethod != bytes32(0), "PPH: Unknown policy");
        require(policy.admissionEnabled, "PPH: Admissions disabled");
        require(intent.paymentMethod == policy.paymentMethod, "PPH: Policy method mismatch");
        require(address(intent.postIntentHook) == address(0), "PPH: Only direct payout");
        require(depositPolicyEnabled[intent.escrow][intent.depositId][policyId], "PPH: Deposit policy disabled");
        _requireVerifierInstalled(msg.sender, policy.paymentMethod);
        if (
            whitelistPolicy.enabled(intent.escrow, intent.depositId, policy.paymentMethod)
                && !whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, policy.paymentMethod, intent.owner)
        ) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, policy.paymentMethod, intent.owner);
        }

        policyIntents[_intentHash] = PolicyIntent(policyId, msg.sender);
        emit PolicyIntentSignaled(_intentHash, policyId, msg.sender);
    }

    /// @inheritdoc IntentLifecycleHookV1
    function onIntentCancelled(bytes32 _intentHash) public override onlyOrchestrator {
        PolicyIntent memory intent = policyIntents[_intentHash];
        if (intent.orchestrator == address(0)) {
            super.onIntentCancelled(_intentHash);
        } else {
            require(intent.orchestrator == msg.sender, "PPH: Foreign intent");
            delete policyIntents[_intentHash];
        }
    }

    /// @inheritdoc IntentLifecycleHookV1
    function settleIntent(SettlementContext calldata _context) public override onlyOrchestrator {
        PolicyIntent memory intent = policyIntents[_context.intentHash];
        if (intent.orchestrator == address(0)) {
            super.settleIntent(_context);
        } else {
            require(intent.orchestrator == msg.sender, "PPH: Foreign intent");
            // Replacing the checker or method route cannot bypass pending policy evidence requirements.
            // The depositor retains the existing explicit manual-release escape hatch.
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

    function _requireVerifierInstalled(address _orchestrator, bytes32 _paymentMethod) internal view {
        require(address(paymentVerifier.attestationVerifier()) == address(this), "PPH: Verifier not installed");
        require(
            OrchestratorV3(_orchestrator).paymentVerifierRegistry().getVerifier(_paymentMethod)
                == address(paymentVerifier),
            "PPH: Wrong payment verifier"
        );
    }
}
