//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";

/**
 * @title PartialPullPostIntentHookMock
 * @notice Mock hook that deliberately pulls only a portion of the approved amount to simulate buggy hooks.
 */
contract PartialPullPostIntentHookMock is IPostIntentHook {
    IERC20 public immutable token;
    address public immutable orchestrator;

    constructor(address _token, address _orchestrator) {
        token = IERC20(_token);
        orchestrator = _orchestrator;
    }

    function execute(
        HookExecutionContext calldata _ctx,
        bytes calldata /* _fulfillHookData */
    ) external override {
        // Decode target address from signalHookData (same format as PostIntentHookMock)
        address targetAddress = abi.decode(_ctx.intent.signalHookData, (address));
        require(targetAddress != address(0), "target=0");

        // Pull only half of the approved amount to simulate a faulty hook
        uint256 half = _ctx.executableAmount / 2;
        if (half > 0) {
            token.transferFrom(orchestrator, targetAddress, half);
        }
        // Intentionally do NOT pull the remainder
    }
}
