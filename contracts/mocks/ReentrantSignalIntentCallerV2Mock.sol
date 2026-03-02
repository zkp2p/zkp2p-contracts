// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";

/**
 * @notice V2 variant of ReentrantSignalIntentCallerMock that uses IOrchestratorV2.SignalIntentParams
 *         (which includes preIntentHookData).
 */
contract ReentrantSignalIntentCallerV2Mock {
    IOrchestratorV2 public immutable orchestrator;

    IOrchestratorV2.SignalIntentParams internal reentryParams;
    bool internal hasReentryParams;

    constructor(address _orchestrator) {
        orchestrator = IOrchestratorV2(_orchestrator);
    }

    function setReentryParams(IOrchestratorV2.SignalIntentParams calldata _params) external {
        reentryParams = _params;
        hasReentryParams = true;
    }

    function signalIntent(IOrchestratorV2.SignalIntentParams calldata _params) external {
        orchestrator.signalIntent(_params);
    }

    function attemptReenter() external {
        require(hasReentryParams, "ReentrantCaller: params not set");
        orchestrator.signalIntent(reentryParams);
    }
}
