// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentLifecycleHookV2} from "../interfaces/IIntentLifecycleHookV2.sol";
import {ICascadeDisputeProtectionPolicy} from "../interfaces/ICascadeDisputeProtectionPolicy.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

interface IDeferredSettlementOrchestrator {
    /// @notice Returns the supported lifecycle settlement interface.
    function lifecycleHookInterfaceId() external view returns (bytes4);
    /// @notice Returns canonical intent data.
    function getIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.Intent memory);
}

/// @notice Routes whitelist admission and cascade settlement for compatible registered orchestrators.
/// @dev Governance must drain outstanding intents before deregistering an orchestrator.
contract IntentLifecycleHookV2 is IIntentLifecycleHookV2 {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    ICascadeDisputeProtectionPolicy public immutable disputeProtectionPolicy;

    /* ============ Errors ============ */

    error ZeroAddress();
    error InvalidDependency(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error UnsupportedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error TakerNotWhitelisted(address escrow, uint256 depositId, bytes32 paymentMethod, address taker);

    /* ============ Constructor ============ */

    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        IWhitelistPolicy _whitelistPolicy,
        ICascadeDisputeProtectionPolicy _disputeProtectionPolicy
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
     * @inheritdoc IIntentLifecycleHookV2
     */
    function onIntentSignaled(bytes32 _intentHash) external override onlyOrchestrator {
        (bool success, bytes memory result) = msg.sender.staticcall(
            abi.encodeWithSelector(IDeferredSettlementOrchestrator.lifecycleHookInterfaceId.selector)
        );
        if (!success || result.length != 32) revert UnsupportedOrchestrator(msg.sender);
        if (bytes32(result) != bytes32(type(IIntentLifecycleHookV2).interfaceId)) {
            revert UnsupportedOrchestrator(msg.sender);
        }
        IOrchestratorV3.Intent memory intent = IDeferredSettlementOrchestrator(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        bool isWhitelistEnabled = whitelistPolicy.enabled(intent.escrow, intent.depositId, intent.paymentMethod);
        if (
            isWhitelistEnabled
                && whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner)
        ) {
            return;
        }
        if (disputeProtectionPolicy.isDisputeProtectionEnabled(intent.escrow, intent.depositId, intent.paymentMethod)) {
            disputeProtectionPolicy.onIntentSignaled(
                _intentHash, intent.escrow, intent.depositId, intent.owner, intent.to, intent.paymentMethod
            );
        } else if (isWhitelistEnabled) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHookV2
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        disputeProtectionPolicy.onIntentCancelled(_intentHash);
    }

    /**
     * @inheritdoc IIntentLifecycleHookV2
     */
    function settleIntent(SettlementContext calldata _context)
        external override onlyOrchestrator returns (address deferralVault)
    {
        bool deferred = disputeProtectionPolicy.onIntentSettled(
            _context.intentHash, _context.releaseAmount, _context.netAmount,
            _context.balanceFunded, _context.isManualRelease
        );
        return deferred ? address(disputeProtectionPolicy.stakeVault()) : address(0);
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function onDeferredPayoutFunded(bytes32 _intentHash) external override onlyOrchestrator {
        disputeProtectionPolicy.onDeferredPayoutFunded(_intentHash);
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function lifecycleHookInterfaceId() external pure override returns (bytes4) {
        return type(IIntentLifecycleHookV2).interfaceId;
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
