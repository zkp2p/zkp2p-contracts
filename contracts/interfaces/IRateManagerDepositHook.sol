// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

interface IRateManagerDepositHook {
    /**
     * @notice Called by Escrow on depositor opt-in to a rate manager id.
     * Should revert to reject the opt-in.
     */
    function onDepositOptIn(address depositor, address escrow, uint256 depositId) external view;
}

