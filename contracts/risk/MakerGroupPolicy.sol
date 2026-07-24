// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "../interfaces/IAddressGroupRegistry.sol";
import {IMakerGroupPolicy} from "../interfaces/IMakerGroupPolicy.sol";

/**
 * @title MakerGroupPolicy
 * @notice Persistent maker-owned group admission settings, independent from any risk-hook
 * deployment. Each maker explicitly toggles enforcement and maintains a bounded group list
 * for each payment method.
 * @dev Enabling an empty policy is allowed and intentionally fails closed when evaluated by
 * MakerGroupRiskHook. This makes the master switch safe during partial configuration.
 */
contract MakerGroupPolicy is IMakerGroupPolicy {
    /* ============ Constants ============ */

    uint256 public constant MAX_GROUPS_PER_PAYMENT_METHOD = 10;

    /* ============ State Variables ============ */

    IAddressGroupRegistry public immutable override groupRegistry;

    mapping(address => mapping(bytes32 => bool)) public override groupsEnabled;
    mapping(address => mapping(bytes32 => bytes32[])) internal allowedGroups;
    mapping(address => mapping(bytes32 => mapping(bytes32 => uint256))) internal allowedGroupIndexPlusOne;

    /* ============ Events ============ */

    event GroupsEnabledUpdated(address indexed maker, bytes32 indexed paymentMethod, bool enabled);
    event AllowedGroupAdded(address indexed maker, bytes32 indexed paymentMethod, bytes32 indexed groupId);
    event AllowedGroupRemoved(address indexed maker, bytes32 indexed paymentMethod, bytes32 indexed groupId);

    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroPaymentMethod();
    error EmptyArray();
    error InvalidGroupRegistry(address registry);
    error GroupDoesNotExist(bytes32 groupId);
    error GroupNotActive(bytes32 groupId);
    error TooManyGroups(uint256 attempted, uint256 maximum);

    /* ============ Constructor ============ */

    constructor(IAddressGroupRegistry _groupRegistry) {
        address registryAddress = address(_groupRegistry);
        if (registryAddress == address(0)) revert ZeroAddress();
        if (registryAddress.code.length == 0) revert InvalidGroupRegistry(registryAddress);

        groupRegistry = _groupRegistry;
    }

    /* ============ Maker Functions ============ */

    /**
     * @inheritdoc IMakerGroupPolicy
     */
    function setGroupsEnabled(bytes32 _paymentMethod, bool _enabled) external override {
        _validatePaymentMethod(_paymentMethod);
        groupsEnabled[msg.sender][_paymentMethod] = _enabled;
        emit GroupsEnabledUpdated(msg.sender, _paymentMethod, _enabled);
    }

    /**
     * @inheritdoc IMakerGroupPolicy
     */
    function addAllowedGroups(bytes32 _paymentMethod, bytes32[] calldata _groupIds) external override {
        _validatePaymentMethod(_paymentMethod);
        _validateGroupBatch(_groupIds);

        bytes32[] storage makerGroups = allowedGroups[msg.sender][_paymentMethod];
        for (uint256 i = 0; i < _groupIds.length; i++) {
            bytes32 groupId = _groupIds[i];
            if (!groupRegistry.groupExists(groupId)) revert GroupDoesNotExist(groupId);
            if (!groupRegistry.isGroupActive(groupId)) revert GroupNotActive(groupId);
            if (allowedGroupIndexPlusOne[msg.sender][_paymentMethod][groupId] != 0) continue;
            if (makerGroups.length == MAX_GROUPS_PER_PAYMENT_METHOD) {
                revert TooManyGroups(makerGroups.length + 1, MAX_GROUPS_PER_PAYMENT_METHOD);
            }

            makerGroups.push(groupId);
            allowedGroupIndexPlusOne[msg.sender][_paymentMethod][groupId] = makerGroups.length;
            emit AllowedGroupAdded(msg.sender, _paymentMethod, groupId);
        }
    }

    /**
     * @inheritdoc IMakerGroupPolicy
     */
    function removeAllowedGroups(bytes32 _paymentMethod, bytes32[] calldata _groupIds) external override {
        _validatePaymentMethod(_paymentMethod);
        _validateGroupBatch(_groupIds);

        bytes32[] storage makerGroups = allowedGroups[msg.sender][_paymentMethod];
        for (uint256 i = 0; i < _groupIds.length; i++) {
            bytes32 groupId = _groupIds[i];
            uint256 indexPlusOne = allowedGroupIndexPlusOne[msg.sender][_paymentMethod][groupId];
            if (indexPlusOne == 0) continue;

            bytes32 lastGroupId = makerGroups[makerGroups.length - 1];
            makerGroups[indexPlusOne - 1] = lastGroupId;
            allowedGroupIndexPlusOne[msg.sender][_paymentMethod][lastGroupId] = indexPlusOne;
            makerGroups.pop();
            delete allowedGroupIndexPlusOne[msg.sender][_paymentMethod][groupId];

            emit AllowedGroupRemoved(msg.sender, _paymentMethod, groupId);
        }
    }

    /* ============ View Functions ============ */

    /**
     * @inheritdoc IMakerGroupPolicy
     */
    function getAllowedGroups(address _maker, bytes32 _paymentMethod)
        external
        view
        override
        returns (bytes32[] memory)
    {
        return allowedGroups[_maker][_paymentMethod];
    }

    /**
     * @inheritdoc IMakerGroupPolicy
     */
    function isGroupAllowed(address _maker, bytes32 _paymentMethod, bytes32 _groupId)
        external
        view
        override
        returns (bool)
    {
        return allowedGroupIndexPlusOne[_maker][_paymentMethod][_groupId] != 0;
    }

    /* ============ Internal Functions ============ */

    function _validatePaymentMethod(bytes32 _paymentMethod) internal pure {
        if (_paymentMethod == bytes32(0)) revert ZeroPaymentMethod();
    }

    function _validateGroupBatch(bytes32[] calldata _groupIds) internal pure {
        if (_groupIds.length == 0) revert EmptyArray();
        if (_groupIds.length > MAX_GROUPS_PER_PAYMENT_METHOD) {
            revert TooManyGroups(_groupIds.length, MAX_GROUPS_PER_PAYMENT_METHOD);
        }
    }
}
