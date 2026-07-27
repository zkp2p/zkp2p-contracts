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

    /**
     * @notice Bundles enabling/disabling the deposit's gate with appending groups and takers in one call.
     * @dev `enabled` REPLACES the deposit's current enforcement switch. `groupIds` and `takers` are APPENDED to
     * the deposit's existing allowed-group list and direct whitelist; this call never removes or clears either
     * list. Passing `enabled = false` disables enforcement on an already-gated deposit even while appending new
     * groups or takers in the same call. Use `setEnabled` alone to toggle the gate without touching the lists.
     * @param escrow Whitelisted Escrow or EscrowV2 holding the deposit.
     * @param depositId Deposit to configure.
     * @param enabled New value for the deposit's enforcement switch; replaces the prior value.
     * @param groupIds Curated group ids to append to the deposit's allowed groups.
     * @param takers Addresses to append to the deposit's direct whitelist.
     */
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
