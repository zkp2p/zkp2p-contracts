// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IEscrowV2} from "./interfaces/IEscrowV2.sol";

interface IDepositCreationEscrow {
    function depositCounter() external view returns (uint256);

    function getDeposit(uint256 _depositId) external view returns (IEscrowV2.Deposit memory);
}

/**
 * @title DepositCreationGuard
 * @notice Stateless assertions for atomically creating and configuring an EscrowV2 deposit.
 * @dev Intended to be called before and after `EscrowV2.createDeposit` in an atomic EIP-7702 call batch.
 *      The guard never forwards calls, holds funds, or changes the caller seen by EscrowV2 and its policies.
 */
contract DepositCreationGuard {
    error UnexpectedDepositCounter(uint256 expectedCounter, uint256 actualCounter);
    error DepositCounterDidNotIncrement(uint256 expectedDepositId, uint256 actualCounter);
    error UnexpectedDepositor(uint256 depositId, address expectedDepositor, address actualDepositor);

    /**
     * @notice Reverts unless the next EscrowV2 deposit id is the server-observed id.
     * @param _escrow EscrowV2-compatible contract to inspect.
     * @param _expectedDepositId Deposit id expected to be assigned by the subsequent create call.
     */
    function validateBeforeCreate(IDepositCreationEscrow _escrow, uint256 _expectedDepositId) external view {
        uint256 actualCounter = _escrow.depositCounter();
        if (actualCounter != _expectedDepositId) {
            revert UnexpectedDepositCounter(_expectedDepositId, actualCounter);
        }
    }

    /**
     * @notice Reverts unless exactly one deposit was created at the expected id for the expected maker.
     * @param _escrow EscrowV2-compatible contract to inspect.
     * @param _expectedDepositId Deposit id expected to have been created by the preceding call.
     * @param _expectedDepositor Maker EOA that must own the created deposit.
     */
    function validateAfterCreate(IDepositCreationEscrow _escrow, uint256 _expectedDepositId, address _expectedDepositor)
        external
        view
    {
        uint256 actualCounter = _escrow.depositCounter();
        if (actualCounter <= _expectedDepositId || actualCounter - _expectedDepositId != 1) {
            revert DepositCounterDidNotIncrement(_expectedDepositId, actualCounter);
        }

        address actualDepositor = _escrow.getDeposit(_expectedDepositId).depositor;
        if (actualDepositor != _expectedDepositor) {
            revert UnexpectedDepositor(_expectedDepositId, _expectedDepositor, actualDepositor);
        }
    }
}
