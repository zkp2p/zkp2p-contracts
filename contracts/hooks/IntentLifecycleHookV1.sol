// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IDisputeProtectionPolicy} from "../interfaces/IDisputeProtectionPolicy.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title IntentLifecycleHookV1
 * @notice Lifecycle hook combining tuple-scoped whitelist admission with default-on, opt-out payment policies.
 * Whitelisted takers bypass policy admission. Enrolled methods route other takers to their selected policy unless
 * the depositor opted out. The policy owns selection availability and collateral requirements, including zero-window
 * admission. Outside that route an enabled whitelist rejects nonmembers, while a whitelist-disabled deposit stays open.
 * @dev Reads canonical intent data from the calling orchestrator and forwards cancellation and settlement accounting
 * to DisputeProtectionPolicy. All callbacks remain fail-closed. This hook serves every registered orchestrator and
 * forwards the authenticated caller so the policy can enforce each intent's original hook and orchestrator.
 * Deregistering an orchestrator with unresolved intents snapshotted to this hook permanently blocks their terminal
 * callbacks, so governance must drain its intents before removing it from OrchestratorRegistry.
 */
contract IntentLifecycleHookV1 is IIntentLifecycleHook {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    IDisputeProtectionPolicy public immutable disputeProtectionPolicy;

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
    function onIntentSignaled(bytes32 _intentHash, bytes calldata _data) external override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        require(_data.length == 0 || _data.length == 32, "Hook: Invalid policy data");
        bytes32 policyId = _data.length == 0 ? bytes32(0) : abi.decode(_data, (bytes32));
        bool isWhitelistEnabled = whitelistPolicy.enabled(intent.escrow, intent.depositId, intent.paymentMethod);
        if (
            isWhitelistEnabled
                && whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner)
        ) {
            require(policyId == bytes32(0), "Hook: Unmanaged policy");
            return;
        }
        // Dispute protection admission is stateful, so the configuration query only selects the route.
        // onIntentSignaled remains authoritative for token compatibility, collateral, and pause checks.
        if (disputeProtectionPolicy.isPolicyAdmissionEnabled(intent.escrow, intent.depositId, intent.paymentMethod)) {
            disputeProtectionPolicy.onIntentSignaled(IDisputeProtectionPolicy.AdmissionContext({
                intentHash: _intentHash,
                orchestrator: msg.sender,
                escrow: intent.escrow,
                depositId: intent.depositId,
                taker: intent.owner,
                paymentMethod: intent.paymentMethod,
                amount: intent.amount,
                policyId: policyId,
                whitelistEnabled: isWhitelistEnabled
            }));
        } else {
            require(policyId == bytes32(0), "Hook: Unmanaged policy");
            if (isWhitelistEnabled) {
                revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
            }
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        disputeProtectionPolicy.onIntentCancelled(msg.sender, _intentHash);
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function settleIntent(SettlementContext calldata _context) external override onlyOrchestrator {
        disputeProtectionPolicy.onIntentSettled(msg.sender, _context.intentHash, _context.releaseAmount, _context.isManualRelease);
    }

    /* ============ Modifiers ============ */

    modifier onlyOrchestrator() {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Internal Functions ============ */

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidDependency(_dependency);
    }
}
