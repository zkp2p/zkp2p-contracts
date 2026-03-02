//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";

/**
 * @title PushPostIntentHookMock
 * @notice Mock hook that pushes tokens into the Orchestrator during execution to trigger the
 *         balance-increase invariant in the Orchestrator.
 */
contract PushPostIntentHookMock is IPostIntentHook {
    IERC20 public immutable token;
    address public immutable orchestrator;

    constructor(address _token, address _orchestrator) {
        token = IERC20(_token);
        orchestrator = _orchestrator;
    }

    function execute(
        IOrchestrator.Intent memory /* _intent */,
        uint256 /* _amountNetFees */,
        bytes calldata /* _fulfillIntentData */
    ) external override {
        // Push a tiny amount to the orchestrator to simulate an unexpected balance increase
        token.transfer(orchestrator, 1);
    }
}
