// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IRelayDepository } from "../external/Interfaces/IRelayDepository.sol";

/**
 * @title RelayDepositoryMock
 * @notice Minimal mock for Relay Depository used in tests
 */
contract RelayDepositoryMock is IRelayDepository {
    event DepositErc20Mock(
        address indexed depositor,
        address indexed token,
        uint256 amount,
        bytes32 indexed id,
        address sender
    );

    event DepositNativeMock(
        address indexed depositor,
        uint256 amount,
        bytes32 indexed id,
        address sender
    );

    address public lastDepositor;
    address public lastToken;
    uint256 public lastAmount;
    bytes32 public lastId;
    address public lastSender;

    function depositErc20(
        address depositor,
        address token,
        uint256 amount,
        bytes32 id
    ) external override {
        IERC20(token).transferFrom(msg.sender, address(this), amount);

        lastDepositor = depositor;
        lastToken = token;
        lastAmount = amount;
        lastId = id;
        lastSender = msg.sender;

        emit DepositErc20Mock(depositor, token, amount, id, msg.sender);
    }

    function depositNative(address depositor, bytes32 id) external payable override {
        lastDepositor = depositor;
        lastToken = address(0);
        lastAmount = msg.value;
        lastId = id;
        lastSender = msg.sender;

        emit DepositNativeMock(depositor, msg.value, id, msg.sender);
    }
}
