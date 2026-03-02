//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";

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
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata /* _fulfillIntentData */
    ) external override {
        // Decode target address from intent.data (same format as PostIntentHookMock)
        address targetAddress = abi.decode(_intent.data, (address));
        require(targetAddress != address(0), "target=0");

        // Pull only half of the approved amount to simulate a faulty hook
        uint256 half = _amountNetFees / 2;
        if (half > 0) {
            token.transferFrom(orchestrator, targetAddress, half);
        }
        // Intentionally do NOT pull the remainder
    }
}
