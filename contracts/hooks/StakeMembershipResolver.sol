// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IStakeVault} from "../interfaces/IStakeVault.sol";
import {IWhitelistResolver} from "../interfaces/IWhitelistResolver.sol";

/**
 * @title StakeMembershipResolver
 * @notice Names StakeVault stakers as an AddressGroupRegistry group: an account is a member while
 * its stake owner holds any stake in the vault. Staking is joining; full withdrawal (or a slash to
 * zero) is leaving. There are no thresholds, no configuration, and no owner.
 * @dev Membership reads TOTAL stake so members with collateral locked in open chargeback intents
 * remain members; taking capacity is enforced independently by ChargebackPolicy, which locks the
 * full intent amount against free stake at signal. Any group may point at this resolver via
 * `AddressGroupRegistry.setResolver`; the group id is ignored because the answer is the same for
 * every group: "is this account backed by vault stake". The registry invokes `isMember` through a
 * gas-capped, fail-closed staticcall, and this implementation stays comfortably inside that budget.
 */
contract StakeMembershipResolver is IWhitelistResolver {

    /* ============ Errors ============ */

    error ZeroAddress();

    /* ============ State Variables ============ */

    IStakeVault public immutable stakeVault;

    /* ============ Constructor ============ */

    constructor(IStakeVault _stakeVault) {
        if (address(_stakeVault) == address(0)) revert ZeroAddress();

        stakeVault = _stakeVault;
    }

    /* ============ External View Functions ============ */

    /**
     * @inheritdoc IWhitelistResolver
     * @dev Resolves the account through StakeVault taker delegation, so authorized hot wallets
     * inherit their backing stake owner's membership and self-stakers resolve to themselves.
     */
    function isMember(bytes32, address _account) external view override returns (bool) {
        (, uint256 totalStake,,) = stakeVault.getTakerState(_account);
        return totalStake > 0;
    }
}
