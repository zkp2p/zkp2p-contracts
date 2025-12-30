// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IRelayDepository
 * @notice Interface for the Relay Depository contract
 * @dev See https://docs.relay.link/references/protocol/depository/contracts/Evm-Relay-Depository for more details
 */
interface IRelayDepository {
    function depositErc20(
        address depositor,   // Credit this address (use zero to credit sender)
        address token,       // Token to deposit
        uint256 amount,      // Amount to deposit
        bytes32 id           // orderId from Relay API quote
    ) external;

    function depositNative(
        address depositor,
        bytes32 id
    ) external payable;
}