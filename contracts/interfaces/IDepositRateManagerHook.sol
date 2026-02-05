// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/**
 * @title IDepositRateManagerHook
 * @notice Optional manager-controlled validation hook invoked by Escrow when a depositor opts into a rate manager.
 * @dev Implementations MUST be view-only and revert to reject the opt-in. Escrow may STATICCALL this hook.
 */
interface IDepositRateManagerHook {
    /**
     * @notice Called by Escrow before linking a deposit to a rateManagerId.
     * @param depositor      The depositor opting in.
     * @param escrow         The Escrow contract address.
     * @param depositId      The deposit id on the escrow.
     * @param rateManagerId  The rate manager id the depositor intends to opt into.
     */
    function onDepositOptIn(address depositor, address escrow, uint256 depositId, bytes32 rateManagerId) external view;
}

