// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "./IAddressGroupRegistry.sol";

/// @notice Per-deposit taker whitelist read by OrchestratorV4 at signal.
interface IWhitelistPolicyV2 {
    event EnabledUpdated(address indexed escrow, uint256 indexed depositId, bool enabled);
    event GroupUpdated(address indexed escrow, uint256 indexed depositId, bytes32 indexed groupId, bool allowed);
    event TakerUpdated(address indexed escrow, uint256 indexed depositId, address indexed taker, bool allowed);

    error NotDepositor(address escrow, uint256 depositId, address caller);

    /// @notice Registry holding the groups a deposit can allow and their arbitrators.
    function groupRegistry() external view returns (IAddressGroupRegistry);

    /// @notice Whether only whitelisted takers may signal on the deposit.
    function enabled(address escrow, uint256 depositId) external view returns (bool);

    /// @notice All groups allowed by the deposit, independent of the enabled switch. Ordering is not guaranteed.
    function getAllowedGroups(address escrow, uint256 depositId) external view returns (bytes32[] memory);

    /// @notice Whether the deposit allows the group, independent of its members and the enabled switch.
    function isGroupAllowed(address escrow, uint256 depositId, bytes32 groupId) external view returns (bool);

    /// @notice Alias for isGroupAllowed, preserving the original public mapping getter.
    function allowedGroups(address escrow, uint256 depositId, bytes32 groupId) external view returns (bool);

    /// @notice Whether the taker is directly whitelisted, independent of groups and the enabled switch.
    function allowedTakers(address escrow, uint256 depositId, address taker) external view returns (bool);

    /// @notice Whether the taker passes the whitelist gate using the same named-group rules as OrchestratorV4.
    /// @dev Returns true when disabled. Otherwise checks isWhitelisted with the supplied groupId; it does not
    /// search other groups or validate any other signal-intent requirements.
    function isTakerAllowed(address escrow, uint256 depositId, address taker, bytes32 groupId)
        external
        view
        returns (bool);

    /// @notice Whether the taker is on the deposit's whitelist: directly when groupId is zero, otherwise as a member
    /// of groupId, which the deposit must allow.
    function isWhitelisted(address escrow, uint256 depositId, address taker, bytes32 groupId)
        external
        view
        returns (bool);
}
