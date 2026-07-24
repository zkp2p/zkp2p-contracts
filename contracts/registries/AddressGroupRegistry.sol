// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IAddressGroupRegistry} from "../interfaces/IAddressGroupRegistry.sol";

/**
 * @title AddressGroupRegistry
 * @notice Governance registers stable, publicly discoverable groups and assigns one curator
 * per group. Curators manage membership; governance manages metadata, curator assignment, and
 * whether a group is active for admission.
 * @dev Membership is intentionally mapping-only and non-enumerable. Clients discover groups
 * onchain and index membership events without imposing member enumeration costs on the protocol.
 */
contract AddressGroupRegistry is Ownable, IAddressGroupRegistry {
    /* ============ Constants ============ */

    uint256 public constant MAX_GROUP_NAME_LENGTH = 64;

    /* ============ State Variables ============ */

    bytes32[] internal groupIds;
    mapping(bytes32 => Group) internal groups;
    mapping(bytes32 => mapping(address => bool)) internal members;

    /* ============ Events ============ */

    event GroupRegistered(bytes32 indexed groupId, string name, address indexed curator);
    event GroupNameUpdated(bytes32 indexed groupId, string name);
    event GroupCuratorUpdated(bytes32 indexed groupId, address indexed previousCurator, address indexed newCurator);
    event GroupActiveUpdated(bytes32 indexed groupId, bool active);
    event MemberAdded(bytes32 indexed groupId, address indexed member);
    event MemberRemoved(bytes32 indexed groupId, address indexed member);

    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroGroupId();
    error EmptyArray();
    error EmptyGroupName();
    error GroupNameTooLong(uint256 length, uint256 maximum);
    error GroupAlreadyExists(bytes32 groupId);
    error GroupDoesNotExist(bytes32 groupId);
    error GroupAlreadyInState(bytes32 groupId, bool active);
    error UnauthorizedCurator(address caller, address curator);

    /* ============ Constructor ============ */

    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        transferOwnership(_owner);
    }

    /* ============ Governance Functions ============ */

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function registerGroup(bytes32 _groupId, string calldata _name, address _curator) external override onlyOwner {
        if (_groupId == bytes32(0)) revert ZeroGroupId();
        if (groups[_groupId].exists) revert GroupAlreadyExists(_groupId);
        if (_curator == address(0)) revert ZeroAddress();
        _validateName(_name);

        groups[_groupId] = Group({name: _name, curator: _curator, active: true, exists: true});
        groupIds.push(_groupId);

        emit GroupRegistered(_groupId, _name, _curator);
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function setGroupName(bytes32 _groupId, string calldata _name) external override onlyOwner {
        Group storage group = _getExistingGroup(_groupId);
        _validateName(_name);

        group.name = _name;
        emit GroupNameUpdated(_groupId, _name);
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function setGroupCurator(bytes32 _groupId, address _curator) external override onlyOwner {
        if (_curator == address(0)) revert ZeroAddress();
        Group storage group = _getExistingGroup(_groupId);

        address previousCurator = group.curator;
        group.curator = _curator;
        emit GroupCuratorUpdated(_groupId, previousCurator, _curator);
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function setGroupActive(bytes32 _groupId, bool _active) external override onlyOwner {
        Group storage group = _getExistingGroup(_groupId);
        if (group.active == _active) revert GroupAlreadyInState(_groupId, _active);

        group.active = _active;
        emit GroupActiveUpdated(_groupId, _active);
    }

    /* ============ Curator Functions ============ */

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function addMembers(bytes32 _groupId, address[] calldata _members) external override {
        _requireCurator(_groupId);
        if (_members.length == 0) revert EmptyArray();

        for (uint256 i = 0; i < _members.length; i++) {
            address member = _members[i];
            if (member == address(0)) revert ZeroAddress();
            if (!members[_groupId][member]) {
                members[_groupId][member] = true;
                emit MemberAdded(_groupId, member);
            }
        }
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function removeMembers(bytes32 _groupId, address[] calldata _members) external override {
        _requireCurator(_groupId);
        if (_members.length == 0) revert EmptyArray();

        for (uint256 i = 0; i < _members.length; i++) {
            address member = _members[i];
            if (member == address(0)) revert ZeroAddress();
            if (members[_groupId][member]) {
                delete members[_groupId][member];
                emit MemberRemoved(_groupId, member);
            }
        }
    }

    /* ============ View Functions ============ */

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function isMember(bytes32 _groupId, address _account) external view override returns (bool) {
        return groups[_groupId].active && members[_groupId][_account];
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function groupExists(bytes32 _groupId) external view override returns (bool) {
        return groups[_groupId].exists;
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function isGroupActive(bytes32 _groupId) external view override returns (bool) {
        return groups[_groupId].active;
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function getGroup(bytes32 _groupId) external view override returns (Group memory) {
        return groups[_groupId];
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function groupCount() external view override returns (uint256) {
        return groupIds.length;
    }

    /**
     * @inheritdoc IAddressGroupRegistry
     */
    function groupIdAt(uint256 _index) external view override returns (bytes32) {
        return groupIds[_index];
    }

    /* ============ Internal Functions ============ */

    function _getExistingGroup(bytes32 _groupId) internal view returns (Group storage group) {
        group = groups[_groupId];
        if (!group.exists) revert GroupDoesNotExist(_groupId);
    }

    function _requireCurator(bytes32 _groupId) internal view {
        Group storage group = _getExistingGroup(_groupId);
        if (msg.sender != group.curator) revert UnauthorizedCurator(msg.sender, group.curator);
    }

    function _validateName(string calldata _name) internal pure {
        uint256 nameLength = bytes(_name).length;
        if (nameLength == 0) revert EmptyGroupName();
        if (nameLength > MAX_GROUP_NAME_LENGTH) {
            revert GroupNameTooLong(nameLength, MAX_GROUP_NAME_LENGTH);
        }
    }
}
