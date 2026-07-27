// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "./IAddressGroupRegistry.sol";
import {IEscrowRegistry} from "./IEscrowRegistry.sol";

interface IWhitelistPolicy {
    function groupRegistry() external view returns (IAddressGroupRegistry);
    function escrowRegistry() external view returns (IEscrowRegistry);
    function enabled(address escrow, uint256 depositId) external view returns (bool);
    function isWhitelisted(address escrow, uint256 depositId, address taker) external view returns (bool);
    function getAllowedGroups(address escrow, uint256 depositId) external view returns (bytes32[] memory);
    function isGroupAllowed(address escrow, uint256 depositId, bytes32 groupId) external view returns (bool);
    function isTakerAllowed(address escrow, uint256 depositId, address taker) external view returns (bool);

    function configureDeposit(
        address escrow,
        uint256 depositId,
        bool enabled,
        bytes32[] calldata groupIds,
        address[] calldata takers
    ) external;
    function setEnabled(address escrow, uint256 depositId, bool enabled) external;
    function addWhitelistedAddresses(address escrow, uint256 depositId, address[] calldata takers) external;
    function removeWhitelistedAddresses(address escrow, uint256 depositId, address[] calldata takers) external;
    function addAllowedGroups(address escrow, uint256 depositId, bytes32[] calldata groupIds) external;
    function removeAllowedGroups(address escrow, uint256 depositId, bytes32[] calldata groupIds) external;
}
