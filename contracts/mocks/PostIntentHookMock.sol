//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";

/**
 * @title PostIntentHookMock
 * @notice Mock implementation of IPostIntentHook that transfers funds to a target address
 */
contract PostIntentHookMock is IPostIntentHook {

    /* ============ State Variables ============ */

    IERC20 public immutable usdc;
    address public immutable orchestrator;

    /* ============ Constructor ============ */

    constructor(address _usdc, address _orchestrator) {
        usdc = IERC20(_usdc);
        orchestrator = _orchestrator;
    }

    /**
     * @notice Executes post-intent action by transferring funds to target address
     * @param _intent The intent data containing the target address in the data field
     * @param _amountNetFees Amount of funds to transfer to the target address after fees are deducted
     */
    function execute(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata /*_fulfillIntentData*/
    ) external override {
        // Decode target address and token from intent data
        address targetAddress = abi.decode(_intent.data, (address));

        // Check if target address and token are not zero (use this to test failure of post-intent hook)
        require(targetAddress != address(0), "Target address cannot be zero");

        // Pull usdc from escrow and transfer to target address
        usdc.transferFrom(orchestrator, targetAddress, _amountNetFees);
    }
}
