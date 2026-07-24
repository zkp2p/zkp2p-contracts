// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IAddressGroupRegistry } from "../interfaces/IAddressGroupRegistry.sol";
import { IWhitelistResolver } from "../interfaces/IWhitelistResolver.sol";

/**
 * @title AddressGroupRegistry
 * @notice Permissionless registry of owner-managed address groups. Groups are identified by a
 * sequential uint256 id (starting at 1) and are never deleted. Only the group owner mutates
 * members and the resolver; shared control is achieved by using a multisig as the owner.
 * @dev The integer id is only unique within one registry deployment on one chain — off-chain
 * consumers must key groups by (chainId, registryAddress, groupId).
 *
 * TRUST MODEL: attaching a group to a maker's admission policy via WhitelistPolicy.addAllowedGroups
 * delegates ongoing admission policy to the group's controller set: the current owner, any future
 * owner after transfer, and the current and any future resolver. Any of these can admit arbitrary
 * accounts at any time.
 */
contract AddressGroupRegistry is IAddressGroupRegistry {

    /* ============ Structs ============ */

    struct Group {
        address owner;
        address pendingOwner;
        address resolver;
        bool isPublic;
    }

    /* ============ Events ============ */

    event GroupCreated(uint256 indexed groupId, address indexed owner, string name);
    event GroupOwnershipTransferStarted(uint256 indexed groupId, address indexed owner, address indexed pendingOwner);
    event GroupOwnershipTransferCancelled(uint256 indexed groupId, address indexed cancelledPendingOwner);
    event GroupOwnershipTransferred(uint256 indexed groupId, address indexed previousOwner, address indexed newOwner);
    event MemberAdded(uint256 indexed groupId, address indexed member);
    event MemberRemoved(uint256 indexed groupId, address indexed member);
    event ResolverSet(uint256 indexed groupId, address indexed oldResolver, address indexed newResolver);
    event GroupVisibilityChanged(uint256 indexed groupId, bool isPublic);

    /* ============ Errors ============ */

    error GroupDoesNotExist(uint256 groupId);
    error UnauthorizedGroupOwner(address caller, address owner);
    error UnauthorizedPendingOwner(address caller, address pendingOwner);
    error NoPendingTransfer(uint256 groupId);
    error ZeroAddress();
    error EmptyArray();
    error ResolverNotContract(address resolver);
    error GroupNotPublic(uint256 groupId);

    /* ============ Constants ============ */

    // Gas forwarded to resolver staticcalls. Sized so mapping- or balanceOf-style checks fit
    // comfortably while bounding the cost a malicious resolver can impose on callers.
    uint256 public constant RESOLVER_GAS_LIMIT = 50_000;

    /* ============ State Variables ============ */

    uint256 public override groupCount;                                 // last assigned id; ids start at 1

    mapping(uint256 => Group) internal groups;
    // groupId => account => curated membership
    mapping(uint256 => mapping(address => bool)) public members;

    /* ============ External Functions ============ */

    /**
     * @notice Creates a new group owned by the caller.
     * @param _name    Human-readable label, emitted in the event only (not stored).
     */
    function createGroup(string calldata _name) external override returns (uint256 groupId) {
        return _createGroup(msg.sender, false, _name);
    }

    /**
     * @notice Starts a two-step ownership transfer. Replaces any existing pending owner.
     * @param _groupId    Group id.
     * @param _newOwner   Proposed new owner (must be nonzero; cancellation is a dedicated function).
     */
    function transferGroupOwnership(uint256 _groupId, address _newOwner) external override {
        Group storage group = _requireGroupOwner(_groupId);
        if (_newOwner == address(0)) revert ZeroAddress();

        group.pendingOwner = _newOwner;
        emit GroupOwnershipTransferStarted(_groupId, msg.sender, _newOwner);
    }

    /**
     * @notice Cancels a pending ownership transfer.
     * @param _groupId    Group id.
     */
    function cancelGroupOwnershipTransfer(uint256 _groupId) external override {
        Group storage group = _requireGroupOwner(_groupId);
        address pendingOwner = group.pendingOwner;
        if (pendingOwner == address(0)) revert NoPendingTransfer(_groupId);

        delete group.pendingOwner;
        emit GroupOwnershipTransferCancelled(_groupId, pendingOwner);
    }

    /**
     * @notice Completes a pending ownership transfer. Callable only by the pending owner.
     * The previous owner retains no access after acceptance.
     * @param _groupId    Group id.
     */
    function acceptGroupOwnership(uint256 _groupId) external override {
        Group storage group = groups[_groupId];
        if (group.owner == address(0)) revert GroupDoesNotExist(_groupId);
        if (msg.sender != group.pendingOwner) revert UnauthorizedPendingOwner(msg.sender, group.pendingOwner);

        address previousOwner = group.owner;
        group.owner = msg.sender;
        delete group.pendingOwner;
        emit GroupOwnershipTransferred(_groupId, previousOwner, msg.sender);
    }

    /**
     * @notice Adds members to a group. Idempotent: already-present members are skipped (no event).
     * @param _groupId    Group id.
     * @param _members    Members to add.
     */
    function addMembers(uint256 _groupId, address[] calldata _members) external override {
        _requireGroupOwner(_groupId);
        if (_members.length == 0) revert EmptyArray();

        for (uint256 i = 0; i < _members.length; i++) {
            _addMember(_groupId, _members[i]);
        }
    }

    /**
     * @notice Removes members from a group. Idempotent: absent members are skipped (no event).
     * @param _groupId    Group id.
     * @param _members    Members to remove.
     */
    function removeMembers(uint256 _groupId, address[] calldata _members) external override {
        _requireGroupOwner(_groupId);
        if (_members.length == 0) revert EmptyArray();

        for (uint256 i = 0; i < _members.length; i++) {
            address member = _members[i];
            if (member == address(0)) revert ZeroAddress();
            if (members[_groupId][member]) {
                members[_groupId][member] = false;
                emit MemberRemoved(_groupId, member);
            }
        }
    }

    /**
     * @notice Sets whether a group permits self-service membership.
     * @param _groupId    Group id.
     * @param _isPublic   Whether the group is public.
     */
    function setGroupVisibility(uint256 _groupId, bool _isPublic) external override {
        Group storage group = _requireGroupOwner(_groupId);
        group.isPublic = _isPublic;
        emit GroupVisibilityChanged(_groupId, _isPublic);
    }

    /**
     * @notice Joins a public group as the caller.
     * @param _groupId    Group id.
     */
    function joinGroup(uint256 _groupId) external override {
        _requirePublicGroup(_groupId);
        _addMember(_groupId, msg.sender);
    }

    /**
     * @notice Leaves a public group's curated membership as the caller.
     * @param _groupId    Group id.
     */
    function leaveGroup(uint256 _groupId) external override {
        _requirePublicGroup(_groupId);
        if (members[_groupId][msg.sender]) {
            members[_groupId][msg.sender] = false;
            emit MemberRemoved(_groupId, msg.sender);
        }
    }

    /**
     * @notice Sets or clears the group's resolver. A nonzero resolver must have code; note this
     * does not make upgradeable or malicious resolvers safe — the resolver is part of the
     * group's trust surface.
     * @param _groupId    Group id.
     * @param _resolver   Resolver contract (address(0) to clear).
     */
    function setResolver(uint256 _groupId, address _resolver) external override {
        Group storage group = _requireGroupOwner(_groupId);
        if (_resolver != address(0) && _resolver.code.length == 0) revert ResolverNotContract(_resolver);

        emit ResolverSet(_groupId, group.resolver, _resolver);
        group.resolver = _resolver;
    }

    /* ============ External View Functions ============ */

    /**
     * @notice Returns whether an account is a member of a group (curated OR resolver).
     * Returns false for nonexistent groups. Resolver failures fail closed for that resolver
     * only — they never revert this call.
     * @param _groupId    Group id.
     * @param _account    Account to check.
     */
    function isMember(uint256 _groupId, address _account) public view override returns (bool) {
        if (members[_groupId][_account]) return true;

        address resolver = groups[_groupId].resolver;
        if (resolver == address(0)) return false;

        return _resolverSaysYes(resolver, _groupId, _account);
    }

    /**
     * @notice Returns whether a group exists (input validation only — not a trust guarantee).
     * @param _groupId    Group id.
     */
    function groupExists(uint256 _groupId) external view override returns (bool) {
        return groups[_groupId].owner != address(0);
    }

    /**
     * @notice Returns a group's governance state for atomic inspection.
     * @param _groupId    Group id.
     */
    function getGroup(uint256 _groupId)
        external
        view
        override
        returns (address owner, address pendingOwner, address resolver, bool isPublic, bool exists)
    {
        Group storage group = groups[_groupId];
        return (group.owner, group.pendingOwner, group.resolver, group.isPublic, group.owner != address(0));
    }

    /* ============ Internal Functions ============ */

    function _createGroup(address _owner, bool _isPublic, string memory _name) internal returns (uint256 groupId) {
        groupId = ++groupCount;
        groups[groupId].owner = _owner;
        groups[groupId].isPublic = _isPublic;
        emit GroupCreated(groupId, _owner, _name);
    }

    function _addMember(uint256 _groupId, address _member) internal {
        if (_member == address(0)) revert ZeroAddress();
        if (!members[_groupId][_member]) {
            members[_groupId][_member] = true;
            emit MemberAdded(_groupId, _member);
        }
    }

    function _requireGroupOwner(uint256 _groupId) internal view returns (Group storage group) {
        group = groups[_groupId];
        if (group.owner == address(0)) revert GroupDoesNotExist(_groupId);
        if (msg.sender != group.owner) revert UnauthorizedGroupOwner(msg.sender, group.owner);
    }

    function _requirePublicGroup(uint256 _groupId) internal view {
        Group storage group = groups[_groupId];
        if (group.owner == address(0)) revert GroupDoesNotExist(_groupId);
        if (!group.isPublic) revert GroupNotPublic(_groupId);
    }

    /**
     * @dev Invokes the resolver with a fixed gas stipend and bounded returndata handling.
     * Uses the 0x00-0x3f scratch space as the 32-byte output buffer; never copies
     * attacker-controlled returndata sizes. Success requires the call to succeed, at least
     * 32 bytes of returndata, and the first word to be exactly 1. Any failure (revert,
     * out-of-gas, short or malformed return, no code at call time) evaluates to false.
     */
    function _resolverSaysYes(address _resolver, uint256 _groupId, address _account) internal view returns (bool result) {
        bytes memory callData = abi.encodeWithSelector(IWhitelistResolver.isMember.selector, _groupId, _account);
        uint256 gasLimit = _resolverGasLimit();
        assembly ("memory-safe") {
            let success := staticcall(gasLimit, _resolver, add(callData, 0x20), mload(callData), 0x00, 0x20)
            if and(success, gt(returndatasize(), 0x1f)) {
                result := eq(mload(0x00), 1)
            }
        }
    }

    /**
     * @dev Virtual so the gas-harness mock can raise the limit for the bounded-copy proof test.
     */
    function _resolverGasLimit() internal view virtual returns (uint256) {
        return RESOLVER_GAS_LIMIT;
    }
}
