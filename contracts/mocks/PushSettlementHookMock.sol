//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISettlementHook } from "../interfaces/ISettlementHook.sol";

/**
 * @title PushSettlementHookMock
 * @notice V2 mock hook that pushes tokens into the Orchestrator during execution to trigger the
 *         balance-increase invariant in the Orchestrator.
 */
contract PushSettlementHookMock is ISettlementHook {
    IERC20 public immutable token;
    address public immutable orchestrator;

    constructor(address _token, address _orchestrator) {
        token = IERC20(_token);
        orchestrator = _orchestrator;
    }

    function execute(
        HookExecutionContext calldata /* _ctx */,
        bytes calldata /* _fulfillHookData */
    ) external override {
        // Push a tiny amount to the orchestrator to simulate an unexpected balance increase
        token.transfer(orchestrator, 1);
    }
}
