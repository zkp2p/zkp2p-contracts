// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IAddressGroupRegistry
 * @notice Governance-curated registry of public address groups.
 */
interface IAddressGroupRegistry {
    struct Group {
        string name;
        address curator;
        bool active;
        bool exists;
    }

    /**
     * @notice Registers a stable group identifier and assigns its curator.
     */
    function registerGroup(bytes32 _groupId, string calldata _name, address _curator) external;

    /**
     * @notice Updates the client-facing name for a registered group.
     */
    function setGroupName(bytes32 _groupId, string calldata _name) external;

    /**
     * @notice Reassigns membership authority for a registered group.
     */
    function setGroupCurator(bytes32 _groupId, address _curator) external;

    /**
     * @notice Enables or disables a group for admission decisions.
     */
    function setGroupActive(bytes32 _groupId, bool _active) external;

    /**
     * @notice Adds members to a group. Callable only by the assigned curator.
     */
    function addMembers(bytes32 _groupId, address[] calldata _members) external;

    /**
     * @notice Removes members from a group. Callable only by the assigned curator.
     */
    function removeMembers(bytes32 _groupId, address[] calldata _members) external;

    /**
     * @notice Returns effective membership. Inactive and unknown groups return false.
     */
    function isMember(bytes32 _groupId, address _account) external view returns (bool);

    /**
     * @notice Returns whether a stable group identifier has been registered.
     */
    function groupExists(bytes32 _groupId) external view returns (bool);

    /**
     * @notice Returns whether a registered group is active for admission.
     */
    function isGroupActive(bytes32 _groupId) external view returns (bool);

    /**
     * @notice Returns a group's public metadata and authority state.
     */
    function getGroup(bytes32 _groupId) external view returns (Group memory);

    /**
     * @notice Returns the number of registered groups.
     */
    function groupCount() external view returns (uint256);

    /**
     * @notice Returns the stable group identifier at an enumerable index.
     */
    function groupIdAt(uint256 _index) external view returns (bytes32);
}
