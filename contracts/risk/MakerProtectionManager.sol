// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "../interfaces/IAddressGroupRegistry.sol";
import {IRiskManager} from "../interfaces/IRiskManager.sol";

/**
 * @title MakerProtectionManager
 * @notice Maker-scoped whitelist and chargeback protection preferences composed into RiskManager admission.
 *
 * @dev COMPOSITION
 *      The concrete RiskManager evaluates these preferences against platform chargeback policy and owns the
 *      authenticated Orchestrator admission path. Makers manage only their own configuration through this module.
 */
abstract contract MakerProtectionManager is IRiskManager {
    /* ============ Constants ============ */

    uint256 public constant MAX_ATTACHED_GROUPS = 10;

    /* ============ Maker Protection State ============ */

    IAddressGroupRegistry public immutable override groupRegistry;

    mapping(address => MakerProtectionConfig) internal makerProtectionConfigs;
    mapping(address => mapping(bytes32 => bool)) public override chargebackProtectionEnabled;
    mapping(address => mapping(address => bool)) public override whitelist;
    mapping(address => uint256[]) internal attachedGroups;

    bool public override makerConfigsInitialized;

    /* ============ Constructor ============ */

    /**
     * @notice Initializes the address-group dependency used by maker whitelist policy.
     * @param _groupRegistry Registry resolving attached group membership.
     */
    constructor(IAddressGroupRegistry _groupRegistry) {
        groupRegistry = _groupRegistry;
    }

    /* ============ External Maker Configuration ============ */

    /**
     * @notice Enables or disables whitelist protection for the caller's deposits.
     * @param _enabled Whether whitelist protection is enabled.
     */
    function setWhitelistProtection(bool _enabled) external override {
        _setWhitelistProtection(msg.sender, _enabled);
    }

    /**
     * @notice Enables or disables chargeback protection for one payment method on the caller's deposits.
     * @param _paymentMethod Payment method whose protection preference is updated.
     * @param _enabled Whether chargeback protection is enabled.
     */
    function setChargebackProtection(bytes32 _paymentMethod, bool _enabled) external override {
        _setChargebackProtection(msg.sender, _paymentMethod, _enabled);
    }

    /**
     * @notice Selects AND or OR behavior when both protections are enabled.
     * @param _requireBothProtections True for AND mode; false for OR mode.
     */
    function setProtectionMode(bool _requireBothProtections) external override {
        _setProtectionMode(msg.sender, _requireBothProtections);
    }

    /**
     * @notice Adds takers to the caller's direct whitelist.
     * @param _takers Taker addresses to add.
     */
    function addToWhitelist(address[] calldata _takers) external override {
        if (_takers.length == 0) revert EmptyArray();

        for (uint256 takerIndex = 0; takerIndex < _takers.length; takerIndex++) {
            address taker = _takers[takerIndex];
            if (taker == address(0)) revert ZeroAddress();
            if (whitelist[msg.sender][taker]) continue;

            whitelist[msg.sender][taker] = true;
            emit TakerWhitelisted(msg.sender, taker);
        }
    }

    /**
     * @notice Removes takers from the caller's direct whitelist.
     * @param _takers Taker addresses to remove.
     */
    function removeFromWhitelist(address[] calldata _takers) external override {
        if (_takers.length == 0) revert EmptyArray();

        for (uint256 takerIndex = 0; takerIndex < _takers.length; takerIndex++) {
            address taker = _takers[takerIndex];
            if (taker == address(0)) revert ZeroAddress();
            if (!whitelist[msg.sender][taker]) continue;

            whitelist[msg.sender][taker] = false;
            emit TakerRemovedFromWhitelist(msg.sender, taker);
        }
    }

    /**
     * @notice Attaches existing address groups to the caller's whitelist.
     * @param _groupIds Group identifiers to attach.
     */
    function attachGroups(uint256[] calldata _groupIds) external override {
        if (_groupIds.length == 0) revert EmptyArray();

        uint256[] storage attached = attachedGroups[msg.sender];
        for (uint256 groupIndex = 0; groupIndex < _groupIds.length; groupIndex++) {
            uint256 groupId = _groupIds[groupIndex];
            if (!groupRegistry.groupExists(groupId)) revert GroupDoesNotExist(groupId);

            (bool alreadyAttached,) = _attachedGroupIndex(attached, groupId);
            if (alreadyAttached) continue;
            if (attached.length >= MAX_ATTACHED_GROUPS) {
                revert MaxGroupsExceeded(attached.length + 1, MAX_ATTACHED_GROUPS);
            }

            attached.push(groupId);
            emit GroupAttached(msg.sender, groupId);
        }
    }

    /**
     * @notice Detaches address groups from the caller's whitelist.
     * @param _groupIds Group identifiers to detach.
     */
    function detachGroups(uint256[] calldata _groupIds) external override {
        if (_groupIds.length == 0) revert EmptyArray();

        uint256[] storage attached = attachedGroups[msg.sender];
        for (uint256 groupIndex = 0; groupIndex < _groupIds.length; groupIndex++) {
            uint256 groupId = _groupIds[groupIndex];
            (bool isAttached, uint256 attachedIndex) = _attachedGroupIndex(attached, groupId);
            if (!isAttached) continue;

            attached[attachedIndex] = attached[attached.length - 1];
            attached.pop();
            emit GroupDetached(msg.sender, groupId);
        }
    }

    /* ============ External Views ============ */

    /**
     * @notice Returns a maker's aggregate protection configuration.
     * @param _maker Maker address to query.
     * @return config Current whitelist toggle and protection mode.
     */
    function getMakerProtectionConfig(address _maker)
        external
        view
        override
        returns (MakerProtectionConfig memory config)
    {
        return makerProtectionConfigs[_maker];
    }

    /**
     * @notice Returns all address groups attached by a maker.
     * @param _maker Maker address to query.
     * @return groupIds Attached group identifiers.
     */
    function getAttachedGroups(address _maker) external view override returns (uint256[] memory groupIds) {
        return attachedGroups[_maker];
    }

    /* ============ Internal Configuration ============ */

    function _initializeMakerConfigs(MakerInit[] calldata _makers) internal {
        if (makerConfigsInitialized) revert MakerConfigsAlreadyInitialized();
        makerConfigsInitialized = true;

        for (uint256 makerIndex = 0; makerIndex < _makers.length; makerIndex++) {
            MakerInit calldata makerInit = _makers[makerIndex];
            _setWhitelistProtection(makerInit.maker, makerInit.whitelistEnabled);
            _setProtectionMode(makerInit.maker, makerInit.requireBothProtections);

            for (uint256 platformIndex = 0; platformIndex < makerInit.chargebackPlatforms.length; platformIndex++) {
                _setChargebackProtection(makerInit.maker, makerInit.chargebackPlatforms[platformIndex], true);
            }
        }

        emit MakerConfigsInitialized(_makers.length);
    }

    function _setWhitelistProtection(address _maker, bool _enabled) internal {
        MakerProtectionConfig storage config = makerProtectionConfigs[_maker];
        if (config.whitelistEnabled == _enabled) return;

        config.whitelistEnabled = _enabled;
        emit MakerWhitelistProtectionUpdated(_maker, _enabled);
    }

    function _setChargebackProtection(address _maker, bytes32 _paymentMethod, bool _enabled) internal {
        if (chargebackProtectionEnabled[_maker][_paymentMethod] == _enabled) return;

        chargebackProtectionEnabled[_maker][_paymentMethod] = _enabled;
        emit MakerChargebackProtectionUpdated(_maker, _paymentMethod, _enabled);
    }

    function _setProtectionMode(address _maker, bool _requireBothProtections) internal {
        MakerProtectionConfig storage config = makerProtectionConfigs[_maker];
        if (config.requireBothProtections == _requireBothProtections) return;

        config.requireBothProtections = _requireBothProtections;
        emit MakerProtectionModeUpdated(_maker, _requireBothProtections);
    }

    /* ============ Internal Admission ============ */

    function _isTakerAllowed(address _maker, address _taker) internal view returns (bool) {
        if (whitelist[_maker][_taker]) return true;

        (bool isMember,) = _isMemberOfAttachedGroups(_maker, _taker);
        return isMember;
    }

    function _attachedGroupIndex(uint256[] storage _attached, uint256 _groupId)
        private
        view
        returns (bool found, uint256 index)
    {
        for (uint256 attachedIndex = 0; attachedIndex < _attached.length && !found; attachedIndex++) {
            if (_attached[attachedIndex] == _groupId) {
                found = true;
                index = attachedIndex;
            }
        }
        return (found, index);
    }

    function _isMemberOfAttachedGroups(address _maker, address _taker)
        private
        view
        returns (bool isMember, uint256 checkedGroups)
    {
        uint256[] storage groupIds = attachedGroups[_maker];
        while (checkedGroups < groupIds.length && !isMember) {
            isMember = groupRegistry.isMember(groupIds[checkedGroups], _taker);
            checkedGroups++;
        }
        return (isMember, checkedGroups);
    }
}
