// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "./IAddressGroupRegistry.sol";

/// @notice Per-deposit taker whitelist read by the OrchestratorV4 signal policy at signal.
interface IWhitelistPolicyV2 {
    event EnabledUpdated(address indexed escrow, uint256 indexed depositId, bool enabled);
    event GroupUpdated(address indexed escrow, uint256 indexed depositId, bytes32 indexed groupId, bool allowed);
    event TakerUpdated(address indexed escrow, uint256 indexed depositId, address indexed taker, bool allowed);

    error NotDepositor(address escrow, uint256 depositId, address caller);

    /// @notice Registry holding the groups a deposit can allow and their arbitrators.
    function groupRegistry() external view returns (IAddressGroupRegistry);

    /// @notice Whether only whitelisted takers may signal on the deposit.
    function enabled(address escrow, uint256 depositId) external view returns (bool);

    /// @notice Whether the taker is on the deposit's whitelist: directly when groupId is zero, otherwise as a member
    /// of groupId, which the deposit must allow.
    function isWhitelisted(address escrow, uint256 depositId, address taker, bytes32 groupId)
        external
        view
        returns (bool);
}
