// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IWhitelistResolver
 * @notice Optional programmatic membership source for an AddressGroupRegistry group.
 * @dev Called by the registry via a gas-capped staticcall with bounded returndata handling.
 * Implementations MUST be view and return true only for members.
 */
interface IWhitelistResolver {
    /**
     * @notice Returns whether an account is a member of a group.
     * @param _groupId    Group id in the calling registry.
     * @param _account    Account to check.
     */
    function isMember(bytes32 _groupId, address _account) external view returns (bool);
}
