// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IEscrow} from "../interfaces/IEscrow.sol";
import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title IntentLifecycleHookV1
 * @notice Stateless lifecycle hook admitting any orchestrator registered in OrchestratorRegistry and enforcing
 * maker-owned whitelist policies. A taker is admitted when enforcement is disabled or when the policy allows the
 * taker directly or through an allowed group. Settlement and cancellation are no-ops in this version.
 * @dev Reads intent context from the calling orchestrator and delegates admission to WhitelistPolicy.
 */
contract IntentLifecycleHookV1 is IIntentLifecycleHook {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;

    /* ============ Errors ============ */

    error ZeroAddress();
    error InvalidDependency(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error TakerNotWhitelisted(address maker, address taker);

    /* ============ Constructor ============ */

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
    function onIntentCreated(bytes32 _intentHash) external view override onlyOrchestrator {
        IOrchestratorV3.IntentContext memory intent = IOrchestratorV3(msg.sender).getIntentContext(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        address maker = IEscrow(intent.escrow).getDeposit(intent.depositId).depositor;
        if (!whitelistPolicy.isTakerAllowed(maker, intent.owner)) {
            revert TakerNotWhitelisted(maker, intent.owner);
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
