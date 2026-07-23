// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IAddressGroupRegistry
 * @notice Permissionless registry of owner-managed address groups with optional resolvers.
 */
interface IAddressGroupRegistry {
    struct GroupSeed {
        string name;
        address owner;
        bool isPublic;
        address[] members;
    }

    /**
     * @notice Creates a new group owned by the caller; the name is emitted, not stored.
     */
    function createGroup(string calldata _name) external returns (uint256 groupId);

    /**
     * @notice Starts a two-step ownership transfer; replaces any existing pending owner.
     */
    function transferGroupOwnership(uint256 _groupId, address _newOwner) external;

    /**
     * @notice Cancels a pending ownership transfer.
     */
    function cancelGroupOwnershipTransfer(uint256 _groupId) external;

    /**
     * @notice Completes a pending ownership transfer; callable only by the pending owner.
     */
    function acceptGroupOwnership(uint256 _groupId) external;

    /**
     * @notice Adds members to a group (owner only; idempotent).
     */
    function addMembers(uint256 _groupId, address[] calldata _members) external;

    /**
     * @notice Removes members from a group (owner only; idempotent).
     */
    function removeMembers(uint256 _groupId, address[] calldata _members) external;

    /**
     * @notice Sets whether a group permits self-service membership (owner only).
     */
    function setGroupVisibility(uint256 _groupId, bool _isPublic) external;

    /**
     * @notice Joins a public group as the caller.
     */
    function joinGroup(uint256 _groupId) external;

    /**
     * @notice Leaves a public group's curated membership as the caller.
     */
    function leaveGroup(uint256 _groupId) external;

    /**
     * @notice Sets or clears the group's resolver (owner only; nonzero resolver must have code).
     */
    function setResolver(uint256 _groupId, address _resolver) external;

    /**
     * @notice Returns whether an account is a member (curated OR resolver; fail-closed).
     */
    function isMember(uint256 _groupId, address _account) external view returns (bool);

    /**
     * @notice Returns whether a group exists (input validation only, not a trust guarantee).
     */
    function groupExists(uint256 _groupId) external view returns (bool);

    /**
     * @notice Returns a group's governance state for atomic inspection.
     */
    function getGroup(uint256 _groupId)
        external
        view
        returns (address owner, address pendingOwner, address resolver, bool isPublic, bool exists);

    /**
     * @notice Returns the last assigned group id (ids start at 1).
     */
    function groupCount() external view returns (uint256);
}
