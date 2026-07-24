// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "./IAddressGroupRegistry.sol";

interface IWhitelistPolicy {
    function groupRegistry() external view returns (IAddressGroupRegistry);
    function enabled(address maker, bytes32 paymentMethod) external view returns (bool);
    function isWhitelisted(address maker, address taker) external view returns (bool);
    function getAllowedGroups(address maker, bytes32 paymentMethod) external view returns (bytes32[] memory);
    function isGroupAllowed(address maker, bytes32 paymentMethod, bytes32 groupId) external view returns (bool);
    function isTakerAllowed(address maker, bytes32 paymentMethod, address taker) external view returns (bool);

    function setEnabled(bytes32 paymentMethod, bool enabled) external;
    function addWhitelistedAddresses(address[] calldata takers) external;
    function removeWhitelistedAddresses(address[] calldata takers) external;
    function addAllowedGroups(bytes32 paymentMethod, bytes32[] calldata groupIds) external;
    function removeAllowedGroups(bytes32 paymentMethod, bytes32[] calldata groupIds) external;
}
