// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IEscrow} from "../interfaces/IEscrow.sol";

/**
 * @title EscrowDepositorMock
 * @notice Minimal escrow stand-in exposing only the `getDeposit` call that WhitelistPolicy depends on.
 * @dev Intentionally does not declare `is IEscrow`. WhitelistPolicy only ever reads `Deposit.depositor`,
 * so implementing the full escrow surface would be dead weight. Every unset field is returned zeroed.
 */
contract EscrowDepositorMock {
    mapping(uint256 => address) public depositors;

    function setDepositor(uint256 _depositId, address _depositor) external {
        depositors[_depositId] = _depositor;
    }

    function getDeposit(uint256 _depositId) external view returns (IEscrow.Deposit memory deposit) {
        deposit.depositor = depositors[_depositId];
    }
}
