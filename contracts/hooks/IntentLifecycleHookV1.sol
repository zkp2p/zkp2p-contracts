// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IEscrow} from "../interfaces/IEscrow.sol";
import {IAddressGroupRegistry} from "../interfaces/IAddressGroupRegistry.sol";
import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IMakerGroupPolicy} from "../interfaces/IMakerGroupPolicy.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";

/**
 * @title IntentLifecycleHookV1
 * @notice Stateless OrchestratorV3 lifecycle hook enforcing maker-owned, payment-method-specific
 * curated group policies during admission. Settlement and cancellation are no-ops in this version.
 * @dev Group iteration is bounded by MakerGroupPolicy.MAX_GROUPS_PER_PAYMENT_METHOD.
 */
contract IntentLifecycleHookV1 is IIntentLifecycleHook {
    /* ============ State Variables ============ */

    IOrchestratorV3 public immutable orchestrator;
    IMakerGroupPolicy public immutable makerGroupPolicy;
    IAddressGroupRegistry public immutable groupRegistry;

    /* ============ Errors ============ */

    error ZeroAddress();
    error InvalidDependency(address dependency);
    error GroupRegistryMismatch(address policyRegistry, address hookRegistry);
    error UnauthorizedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error NoAllowedGroupsConfigured(address maker, bytes32 paymentMethod);
    error TakerNotInAllowedGroup(address maker, bytes32 paymentMethod, address taker);

    /* ============ Constructor ============ */

    constructor(
        IOrchestratorV3 _orchestrator,
        IMakerGroupPolicy _makerGroupPolicy,
        IAddressGroupRegistry _groupRegistry
    ) {
        _validateDependency(address(_orchestrator));
        _validateDependency(address(_makerGroupPolicy));
        _validateDependency(address(_groupRegistry));

        address policyRegistry = address(_makerGroupPolicy.groupRegistry());
        if (policyRegistry != address(_groupRegistry)) {
            revert GroupRegistryMismatch(policyRegistry, address(_groupRegistry));
        }

        orchestrator = _orchestrator;
        makerGroupPolicy = _makerGroupPolicy;
        groupRegistry = _groupRegistry;
    }

    /* ============ Lifecycle Callbacks ============ */

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCreated(bytes32 _intentHash) external view override onlyOrchestrator {
        IOrchestratorV3.RiskIntentData memory intent = orchestrator.getRiskIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        IEscrow.Deposit memory deposit = IEscrow(intent.escrow).getDeposit(intent.depositId);
        address maker = deposit.depositor;
        if (!makerGroupPolicy.groupsEnabled(maker, intent.paymentMethod)) return;

        bytes32[] memory groupIds = makerGroupPolicy.getAllowedGroups(maker, intent.paymentMethod);
        if (groupIds.length == 0) {
            revert NoAllowedGroupsConfigured(maker, intent.paymentMethod);
        }

        for (uint256 i = 0; i < groupIds.length; i++) {
            if (groupRegistry.isMember(groupIds[i], intent.owner)) return;
        }

        revert TakerNotInAllowedGroup(maker, intent.paymentMethod, intent.owner);
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32) external view override onlyOrchestrator {}

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function settleIntent(RiskSettlementContext calldata) external view override onlyOrchestrator {}

    /* ============ Modifiers ============ */

    modifier onlyOrchestrator() {
        if (msg.sender != address(orchestrator)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Internal Functions ============ */

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidDependency(_dependency);
    }
}
