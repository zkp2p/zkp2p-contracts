// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "../interfaces/IAddressGroupRegistry.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";
import {IWhitelistResolver} from "../interfaces/IWhitelistResolver.sol";

/**
 * @title StakeMembershipResolver
 * @notice Computes AddressGroupRegistry membership live from StakeVault balances: an account is a
 * member of a group while its stake owner's total stake meets the group's configured threshold.
 * @dev Membership keys on TOTAL stake (free plus locked) so members do not flap out of groups while
 * chargeback locks are open; taking capacity remains enforced separately by ChargebackPolicy's
 * per-intent locks against free stake. Thresholds are configured per group by that group's current
 * registry curator, so registry curator rotation carries over here with no state migration. The
 * contract is immutable and ownerless. The registry invokes `isMember` through a gas-capped,
 * fail-closed staticcall, and an unconfigured group (zero threshold) evaluates to non-membership.
 */
contract StakeMembershipResolver is IWhitelistResolver {

    /* ============ Events ============ */

    event GroupMinStakeSet(bytes32 indexed groupId, uint256 minStake);

    /* ============ Errors ============ */

    error ZeroAddress();
    error GroupNotFound(bytes32 groupId);
    error UnauthorizedGroupCurator(bytes32 groupId, address caller);

    /* ============ State Variables ============ */

    IStakeVault public immutable stakeVault;
    IAddressGroupRegistry public immutable groupRegistry;

    /// @dev groupId => minimum total stake required for membership (0 = unconfigured, fail closed).
    mapping(bytes32 => uint256) public groupMinStake;

    /* ============ Constructor ============ */

    constructor(IStakeVault _stakeVault, IAddressGroupRegistry _groupRegistry) {
        if (address(_stakeVault) == address(0) || address(_groupRegistry) == address(0)) revert ZeroAddress();

        stakeVault = _stakeVault;
        groupRegistry = _groupRegistry;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Sets the minimum total stake for a group; zero disables stake-derived membership.
     * @dev Callable only by the group's current curator in the registry.
     * @param _groupId Group in the registry whose threshold is configured.
     * @param _minStake Minimum total stake for membership, in stake-token units.
     */
    function setGroupMinStake(bytes32 _groupId, uint256 _minStake) external {
        (address curator,,,, bool exists) = groupRegistry.getGroup(_groupId);
        if (!exists) revert GroupNotFound(_groupId);
        if (msg.sender != curator) revert UnauthorizedGroupCurator(_groupId, msg.sender);

        groupMinStake[_groupId] = _minStake;
        emit GroupMinStakeSet(_groupId, _minStake);
    }

    /* ============ External View Functions ============ */

    /**
     * @inheritdoc IWhitelistResolver
     * @dev Resolves the account through StakeVault taker delegation, so authorized hot wallets
     * inherit their backing stake owner's membership and self-stakers resolve to themselves.
     */
    function isMember(bytes32 _groupId, address _account) external view override returns (bool) {
        uint256 minStake = groupMinStake[_groupId];
        if (minStake == 0) return false;

        (, uint256 totalStake,,) = stakeVault.getTakerState(_account);
        return totalStake >= minStake;
    }
}
