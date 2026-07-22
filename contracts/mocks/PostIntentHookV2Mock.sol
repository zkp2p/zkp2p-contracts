//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPostIntentHookV2 } from "../interfaces/IPostIntentHookV2.sol";

/**
 * @title PostIntentHookV2Mock
 * @notice Mock implementation of IPostIntentHookV2 that transfers funds to a target address
 */
contract PostIntentHookV2Mock is IPostIntentHookV2 {

    /* ============ State Variables ============ */

    IERC20 public immutable usdc;
    address public immutable orchestrator;
    bytes public lastPostIntentHookData;

    /* ============ Constructor ============ */

    constructor(address _usdc, address _orchestrator) {
        usdc = IERC20(_usdc);
        orchestrator = _orchestrator;
    }

    /**
     * @notice Executes post-intent action by transferring funds to target address
     * @param _ctx Hook execution context containing target details in signalHookData
     */
    function execute(
        HookExecutionContext calldata _ctx,
        bytes calldata _postIntentHookData
    ) external override {
        lastPostIntentHookData = _postIntentHookData;

        // Decode target address from intent data
        address targetAddress = abi.decode(_ctx.intent.signalHookData, (address));

        // Check if target address is not zero (use this to test failure of post-intent hook)
        require(targetAddress != address(0), "Target address cannot be zero");

        // Pull usdc from orchestrator and transfer to target address
        usdc.transferFrom(orchestrator, targetAddress, _ctx.executableAmount);
    }
}
