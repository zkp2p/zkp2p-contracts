// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IntentLifecycleHookV1} from "./IntentLifecycleHookV1.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {IDisputeProtectionPolicy} from "../interfaces/IDisputeProtectionPolicy.sol";
import {IEscrow} from "../interfaces/IEscrow.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";
import {UnifiedPaymentVerifierV3} from "../unifiedVerifier/UnifiedPaymentVerifierV3.sol";

/**
 * @title VenmoBalancePolicy
 * @notice Opt-in, direct-payout Venmo balance intents skip dispute staking and require signed funding evidence.
 * @dev Install as both the existing UPV3's attestation verifier and O3's lifecycle hook. The payment method,
 * verifier address, signing domain and nullifier namespace remain unchanged. Ordinary intents retain V1 admission.
 * Balance proofs append keccak256("venmo_balance") to the existing 448-byte signed payload. The original witness
 * verifier authenticates the complete digest; caller-supplied intent data alone never authorizes settlement.
 */
contract VenmoBalancePolicy is IntentLifecycleHookV1, IAttestationVerifier {
    bytes32 public constant VENMO = keccak256("venmo");
    bytes32 public constant BALANCE_POLICY = keccak256("venmo_balance");

    UnifiedPaymentVerifierV3 public immutable paymentVerifier;
    IAttestationVerifier public immutable signatureVerifier;

    mapping(address => mapping(uint256 => bool)) public balanceEnabled;
    mapping(bytes32 => address) public balanceIntentOrchestrator;

    event BalanceEnabled(address indexed escrow, uint256 indexed depositId, bool enabled);
    event BalanceIntentSignaled(bytes32 indexed intentHash, address indexed orchestrator);

    constructor(
        UnifiedPaymentVerifierV3 _paymentVerifier,
        IWhitelistPolicy _whitelistPolicy,
        IDisputeProtectionPolicy _disputeProtectionPolicy
    ) IntentLifecycleHookV1(_paymentVerifier.orchestratorRegistry(), _whitelistPolicy, _disputeProtectionPolicy) {
        paymentVerifier = _paymentVerifier;
        signatureVerifier = _paymentVerifier.attestationVerifier();
    }

    /**
     * @notice Allows the depositor to offer balance-only intents using the existing Venmo deposit and rates.
     * @dev Disabled by default. Changes affect future intents only; an existing intent's mode is frozen.
     */
    function setBalanceEnabled(address _escrow, uint256 _depositId, bool _enabled) external {
        require(whitelistPolicy.escrowRegistry().isWhitelistedEscrow(_escrow), "VBP: Invalid escrow");
        require(IEscrow(_escrow).getDeposit(_depositId).depositor == msg.sender, "VBP: Only depositor");
        balanceEnabled[_escrow][_depositId] = _enabled;
        emit BalanceEnabled(_escrow, _depositId, _enabled);
    }

    /// @inheritdoc IntentLifecycleHookV1
    function onIntentSignaled(bytes32 _intentHash) public override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.data.length != 32 || abi.decode(intent.data, (bytes32)) != BALANCE_POLICY) {
            super.onIntentSignaled(_intentHash);
            return;
        }

        require(intent.paymentMethod == VENMO, "VBP: Only Venmo");
        require(address(intent.postIntentHook) == address(0), "VBP: Only direct payout");
        require(balanceEnabled[intent.escrow][intent.depositId], "VBP: Balance disabled");
        _requireVerifierInstalled();
        if (
            whitelistPolicy.enabled(intent.escrow, intent.depositId, VENMO)
                && !whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, VENMO, intent.owner)
        ) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, VENMO, intent.owner);
        }

        balanceIntentOrchestrator[_intentHash] = msg.sender;
        emit BalanceIntentSignaled(_intentHash, msg.sender);
    }

    /// @inheritdoc IntentLifecycleHookV1
    function onIntentCancelled(bytes32 _intentHash) public override onlyOrchestrator {
        if (balanceIntentOrchestrator[_intentHash] == address(0)) {
            super.onIntentCancelled(_intentHash);
        } else {
            require(balanceIntentOrchestrator[_intentHash] == msg.sender, "VBP: Foreign intent");
            delete balanceIntentOrchestrator[_intentHash];
        }
    }

    /// @inheritdoc IntentLifecycleHookV1
    function settleIntent(SettlementContext calldata _context) public override onlyOrchestrator {
        if (balanceIntentOrchestrator[_context.intentHash] == address(0)) {
            super.settleIntent(_context);
        } else {
            require(balanceIntentOrchestrator[_context.intentHash] == msg.sender, "VBP: Foreign intent");
            // A verifier rollback cannot turn a pending balance intent into an unprotected ordinary settlement.
            // The depositor retains the existing explicit manual-release escape hatch.
            if (!_context.isManualRelease) _requireVerifierInstalled();
            delete balanceIntentOrchestrator[_context.intentHash];
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
        if (balanceIntentOrchestrator[snapshot.intentHash] != address(0)) {
            if (_data.length != 480 || bytes32(_data[448:480]) != BALANCE_POLICY) return false;
        }
        return signatureVerifier.verify(_digest, _sigs, _data);
    }

    function _requireVerifierInstalled() internal view {
        require(address(paymentVerifier.attestationVerifier()) == address(this), "VBP: Verifier not installed");
    }
}
