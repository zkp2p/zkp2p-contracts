// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "./IAddressGroupRegistry.sol";

/**
 * @title IMakerGroupPolicy
 * @notice Maker-owned group admission policy keyed by payment method.
 */
interface IMakerGroupPolicy {
    /**
     * @notice Enables or disables group enforcement for the caller and payment method.
     */
    function setGroupsEnabled(bytes32 _paymentMethod, bool _enabled) external;

    /**
     * @notice Adds curated groups to the caller's payment-method policy.
     */
    function addAllowedGroups(bytes32 _paymentMethod, bytes32[] calldata _groupIds) external;

    /**
     * @notice Removes groups from the caller's payment-method policy.
     */
    function removeAllowedGroups(bytes32 _paymentMethod, bytes32[] calldata _groupIds) external;

    /**
     * @notice Returns whether group enforcement is enabled for a maker and payment method.
     */
    function groupsEnabled(address _maker, bytes32 _paymentMethod) external view returns (bool);

    /**
     * @notice Returns the bounded group list configured by a maker for one payment method.
     */
    function getAllowedGroups(address _maker, bytes32 _paymentMethod) external view returns (bytes32[] memory);

    /**
     * @notice Returns whether a group is configured for a maker and payment method.
     */
    function isGroupAllowed(address _maker, bytes32 _paymentMethod, bytes32 _groupId) external view returns (bool);

    /**
     * @notice Returns the curated registry used to validate groups.
     */
    function groupRegistry() external view returns (IAddressGroupRegistry);
}
