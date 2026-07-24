// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IAddressGroupRegistry
 * @notice Permissionless registry of curator-managed address groups with optional resolvers.
 */
interface IAddressGroupRegistry {
    /**
     * @notice Creates a new group curated by the caller; its id is derived from the curator and global counter.
     */
    function createGroup(string calldata _name) external returns (bytes32 groupId);

    /**
     * @notice Starts a two-step curator transfer; replaces any existing pending curator.
     */
    function transferGroupCurator(bytes32 _groupId, address _newCurator) external;

    /**
     * @notice Cancels a pending curator transfer.
     */
    function cancelGroupCuratorTransfer(bytes32 _groupId) external;

    /**
     * @notice Completes a pending curator transfer; callable only by the pending curator.
     */
    function acceptGroupCurator(bytes32 _groupId) external;

    /**
     * @notice Adds members to a group (curator only; idempotent).
     */
    function addMembers(bytes32 _groupId, address[] calldata _members) external;

    /**
     * @notice Removes members from a group (curator only; idempotent).
     */
    function removeMembers(bytes32 _groupId, address[] calldata _members) external;

    /**
     * @notice Sets whether a group permits self-service membership (curator only).
     */
    function setGroupVisibility(bytes32 _groupId, bool _isPublic) external;

    /**
     * @notice Joins a public group as the caller.
     */
    function joinGroup(bytes32 _groupId) external;

    /**
     * @notice Leaves a public group's curated membership as the caller.
     */
    function leaveGroup(bytes32 _groupId) external;

    /**
     * @notice Sets or clears the group's resolver (curator only; nonzero resolver must have code).
     */
    function setResolver(bytes32 _groupId, address _resolver) external;

    /**
     * @notice Returns whether an account is a member (curated OR resolver; fail-closed).
     */
    function isMember(bytes32 _groupId, address _account) external view returns (bool);

    /**
     * @notice Returns whether a group exists (input validation only, not a trust guarantee).
     */
    function groupExists(bytes32 _groupId) external view returns (bool);

    /**
     * @notice Returns a group's governance state for atomic inspection.
     */
    function getGroup(bytes32 _groupId)
        external
        view
        returns (address curator, address pendingCurator, address resolver, bool isPublic, bool exists);

    /**
     * @notice Returns the number of groups created (the counter used to derive group ids).
     */
    function groupCount() external view returns (uint256);
}
