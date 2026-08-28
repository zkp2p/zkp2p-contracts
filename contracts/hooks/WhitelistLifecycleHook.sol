// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title WhitelistLifecycleHook
 * @notice Lifecycle hook enforcing deposit-and-payment-method-scoped whitelist admission without dispute coverage.
 * Open deposits remain unrestricted, while enabled whitelist policies reject every taker not currently allowed.
 * @dev Reads canonical intent data from the calling orchestrator. Whitelist admission is evaluated only when an
 * intent is signaled; authorized cancellation and settlement callbacks are no-ops. All callbacks remain fail-closed.
 * Deregistering an orchestrator with unresolved intents snapshotted to this hook permanently blocks their terminal
 * callbacks, so governance must drain its intents before removing it from OrchestratorRegistry.
 */
contract WhitelistLifecycleHook is IIntentLifecycleHook {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;

    /* ============ Errors ============ */

    error ZeroAddress();
    error InvalidDependency(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error TakerNotWhitelisted(address escrow, uint256 depositId, bytes32 paymentMethod, address taker);

    /* ============ Constructor ============ */

    /**
     * @notice Creates a whitelist-only lifecycle hook over immutable policy and authorization dependencies.
     * @param _orchestratorRegistry Registry authorizing lifecycle callback callers.
     * @param _whitelistPolicy Deposit-scoped whitelist policy used for intent admission.
     */
    constructor(IOrchestratorRegistry _orchestratorRegistry, IWhitelistPolicy _whitelistPolicy) {
        _validateDependency(address(_orchestratorRegistry));
        _validateDependency(address(_whitelistPolicy));

        orchestratorRegistry = _orchestratorRegistry;
        whitelistPolicy = _whitelistPolicy;
    }

    /* ============ Lifecycle Callbacks ============ */

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentSignaled(bytes32 _intentHash) external view override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        if (
            whitelistPolicy.enabled(intent.escrow, intent.depositId, intent.paymentMethod)
                && !whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner)
        ) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32) external view override onlyOrchestrator {}

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function settleIntent(SettlementContext calldata) external view override onlyOrchestrator {}

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
