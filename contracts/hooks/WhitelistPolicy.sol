// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "../interfaces/IAddressGroupRegistry.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title WhitelistPolicy
 * @notice Persistent maker-owned taker admission settings, independent from any lifecycle-hook deployment.
 * Each maker can trust direct addresses globally and configure a bounded list of curated groups per payment method.
 * @dev Enabling an empty payment-method policy is allowed and intentionally fails closed when evaluated.
 */
contract WhitelistPolicy is IWhitelistPolicy {
    /* ============ Constants ============ */

    uint256 public constant MAX_GROUPS_PER_PAYMENT_METHOD = 10;

    /* ============ State Variables ============ */

    IAddressGroupRegistry public immutable override groupRegistry;

    mapping(address => mapping(bytes32 => bool)) public override enabled;
    mapping(address => mapping(address => bool)) public override isWhitelisted;
    mapping(address => mapping(bytes32 => bytes32[])) internal allowedGroups;

    /* ============ Events ============ */

    event EnabledUpdated(address indexed maker, bytes32 indexed paymentMethod, bool enabled);
    event AddressWhitelisted(address indexed maker, address indexed taker);
    event AddressRemovedFromWhitelist(address indexed maker, address indexed taker);
    event AllowedGroupAdded(address indexed maker, bytes32 indexed paymentMethod, bytes32 indexed groupId);
    event AllowedGroupRemoved(address indexed maker, bytes32 indexed paymentMethod, bytes32 indexed groupId);

    /* ============ Errors ============ */

    error ZeroAddress();
    error EmptyArray();
    error InvalidGroupRegistry(address registry);
    error GroupDoesNotExist(bytes32 groupId);
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
     * @inheritdoc IWhitelistPolicy
     */
    function setEnabled(bytes32 _paymentMethod, bool _enabled) external override {
        enabled[msg.sender][_paymentMethod] = _enabled;
        emit EnabledUpdated(msg.sender, _paymentMethod, _enabled);
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function addWhitelistedAddresses(address[] calldata _takers) external override {
        if (_takers.length == 0) revert EmptyArray();

        for (uint256 i = 0; i < _takers.length; ++i) {
            address taker = _takers[i];
            if (taker == address(0)) revert ZeroAddress();
            if (isWhitelisted[msg.sender][taker]) continue;

            isWhitelisted[msg.sender][taker] = true;
            emit AddressWhitelisted(msg.sender, taker);
        }
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function removeWhitelistedAddresses(address[] calldata _takers) external override {
        if (_takers.length == 0) revert EmptyArray();

        for (uint256 i = 0; i < _takers.length; ++i) {
            address taker = _takers[i];
            if (!isWhitelisted[msg.sender][taker]) continue;

            isWhitelisted[msg.sender][taker] = false;
            emit AddressRemovedFromWhitelist(msg.sender, taker);
        }
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function addAllowedGroups(bytes32 _paymentMethod, bytes32[] calldata _groupIds) external override {
        if (_groupIds.length == 0) revert EmptyArray();

        bytes32[] storage paymentMethodGroups = allowedGroups[msg.sender][_paymentMethod];
        for (uint256 i = 0; i < _groupIds.length; ++i) {
            bytes32 groupId = _groupIds[i];
            if (!groupRegistry.groupExists(groupId)) revert GroupDoesNotExist(groupId);
            if (_containsGroup(paymentMethodGroups, groupId)) continue;
            if (paymentMethodGroups.length == MAX_GROUPS_PER_PAYMENT_METHOD) {
                revert TooManyGroups(paymentMethodGroups.length + 1, MAX_GROUPS_PER_PAYMENT_METHOD);
            }

            paymentMethodGroups.push(groupId);
            emit AllowedGroupAdded(msg.sender, _paymentMethod, groupId);
        }
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function removeAllowedGroups(bytes32 _paymentMethod, bytes32[] calldata _groupIds) external override {
        if (_groupIds.length == 0) revert EmptyArray();

        bytes32[] storage paymentMethodGroups = allowedGroups[msg.sender][_paymentMethod];
        for (uint256 i = 0; i < _groupIds.length; ++i) {
            bytes32 groupId = _groupIds[i];
            uint256 groupIndex = _findGroupIndex(paymentMethodGroups, groupId);
            if (groupIndex == paymentMethodGroups.length) continue;

            paymentMethodGroups[groupIndex] = paymentMethodGroups[paymentMethodGroups.length - 1];
            paymentMethodGroups.pop();
            emit AllowedGroupRemoved(msg.sender, _paymentMethod, groupId);
        }
    }

    /* ============ View Functions ============ */

    /**
     * @inheritdoc IWhitelistPolicy
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
     * @inheritdoc IWhitelistPolicy
     */
    function isGroupAllowed(address _maker, bytes32 _paymentMethod, bytes32 _groupId)
        external
        view
        override
        returns (bool)
    {
        return _containsGroup(allowedGroups[_maker][_paymentMethod], _groupId);
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function isTakerAllowed(address _maker, bytes32 _paymentMethod, address _taker)
        external
        view
        override
        returns (bool)
    {
        if (!enabled[_maker][_paymentMethod]) return true;
        if (isWhitelisted[_maker][_taker]) return true;

        bytes32[] storage paymentMethodGroups = allowedGroups[_maker][_paymentMethod];
        for (uint256 i = 0; i < paymentMethodGroups.length; ++i) {
            if (groupRegistry.isMember(paymentMethodGroups[i], _taker)) return true;
        }
        return false;
    }

    /* ============ Internal Functions ============ */

    function _containsGroup(bytes32[] storage _groups, bytes32 _groupId) internal view returns (bool) {
        return _findGroupIndex(_groups, _groupId) != _groups.length;
    }

    function _findGroupIndex(bytes32[] storage _groups, bytes32 _groupId) internal view returns (uint256) {
        for (uint256 i = 0; i < _groups.length; ++i) {
            if (_groups[i] == _groupId) return i;
        }
        return _groups.length;
    }
}
