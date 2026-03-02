// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOrchestrator } from "../interfaces/IOrchestrator.sol";

/**
 * @notice Contract taker used to attempt reentrant signalIntent calls.
 */
contract ReentrantSignalIntentCallerMock {
    IOrchestrator public immutable orchestrator;

    IOrchestrator.SignalIntentParams internal reentryParams;
    bool internal hasReentryParams;

    constructor(address _orchestrator) {
        orchestrator = IOrchestrator(_orchestrator);
    }

    function setReentryParams(IOrchestrator.SignalIntentParams calldata _params) external {
        reentryParams = _params;
        hasReentryParams = true;
    }

    function signalIntent(IOrchestrator.SignalIntentParams calldata _params) external {
        orchestrator.signalIntent(_params);
    }

    function attemptReenter() external {
        require(hasReentryParams, "ReentrantCaller: params not set");
        orchestrator.signalIntent(reentryParams);
    }
}
