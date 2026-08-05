// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IDisputePolicy} from "../interfaces/IDisputePolicy.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title IntentLifecycleHookV1
 * @notice Lifecycle hook combining deposit-scoped whitelist admission with optional stake-backed chargeback coverage.
 * Whitelisted takers bypass staking; non-whitelisted takers may be admitted through a chargeback-enabled deposit.
 * Non-chargebackable payment methods give every taker direct access without a chargeback intent or stake lock, regardless of
 * whitelist state. Open deposits remain unrestricted when neither policy is enabled.
 * @dev Reads canonical intent data from the calling orchestrator and forwards cancellation and settlement accounting
 * to DisputePolicy. All callbacks remain fail-closed. This hook serves every registered orchestrator and forwards
 * lifecycle callbacks without provenance checks; the trust argument lives in DisputePolicy's header.
 * Deregistering an orchestrator with unresolved intents snapshotted to this hook permanently blocks their terminal
 * callbacks, so governance must drain its intents before removing it from OrchestratorRegistry.
 */
contract IntentLifecycleHookV1 is IIntentLifecycleHook {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    IDisputePolicy public immutable disputePolicy;

    /* ============ Errors ============ */

    error ZeroAddress();
    error InvalidDependency(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error TakerNotWhitelisted(address escrow, uint256 depositId, address taker);

    /* ============ Constructor ============ */

    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        IWhitelistPolicy _whitelistPolicy,
        IDisputePolicy _disputePolicy
    ) {
        _validateDependency(address(_orchestratorRegistry));
        _validateDependency(address(_whitelistPolicy));
        _validateDependency(address(_disputePolicy));

        orchestratorRegistry = _orchestratorRegistry;
        whitelistPolicy = _whitelistPolicy;
        disputePolicy = _disputePolicy;
    }

    /* ============ Lifecycle Callbacks ============ */

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentSignaled(bytes32 _intentHash) external override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        bool isWhitelistEnabled = whitelistPolicy.enabled(intent.escrow, intent.depositId);
        if (isWhitelistEnabled && whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.owner)) {
            return;
        }
        // Chargeback admission is stateful, so the configuration query only selects the route.
        // onIntentSignaled remains authoritative for token compatibility, collateral, and pause checks.
        if (disputePolicy.isChargebackEnabled(intent.escrow, intent.depositId)) {
            disputePolicy.onIntentSignaled(
                _intentHash, intent.escrow, intent.depositId, intent.owner, intent.paymentMethod, intent.amount
            );
        } else if (isWhitelistEnabled) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.owner);
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        disputePolicy.onIntentCancelled(_intentHash);
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function settleIntent(SettlementContext calldata _context) external override onlyOrchestrator {
        disputePolicy.onIntentSettled(_context.intentHash, _context.releaseAmount, _context.isManualRelease);
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
