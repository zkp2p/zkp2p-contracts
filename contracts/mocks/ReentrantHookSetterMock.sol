// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPreIntentHook } from "../interfaces/IPreIntentHook.sol";

interface IOrchestratorHookSetter {
    function setDepositPreIntentHook(address escrow, uint256 depositId, IPreIntentHook hook) external;
}

/**
 * @notice Pre-intent hook that attempts to reenter setDepositPreIntentHook during signalIntent.
 *         Used to verify nonReentrant on hook setters blocks mid-call manipulation.
 */
contract ReentrantHookSetterMock is IPreIntentHook {
    address public orchestrator;
    IPreIntentHook public replacementHook;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address _orchestrator) {
        orchestrator = _orchestrator;
    }

    function setReplacementHook(IPreIntentHook _hook) external {
        replacementHook = _hook;
    }

    function validateSignalIntent(PreIntentContext calldata _ctx) external override {
        reentryAttempted = true;

        try IOrchestratorHookSetter(orchestrator).setDepositPreIntentHook(
            _ctx.escrow,
            _ctx.depositId,
            replacementHook
        ) {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }
}
