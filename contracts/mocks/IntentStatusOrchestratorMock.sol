// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IProtocolRiskManager } from "../interfaces/IProtocolRiskManager.sol";

/** @notice Minimal orchestrator lifecycle surface for risk recovery tests. */
contract IntentStatusOrchestratorMock {
    mapping(bytes32 => bool) public activeIntents;

    function signal(IProtocolRiskManager manager, IProtocolRiskManager.SignalContext calldata context)
        external
        returns (uint16 feeDiscountBps)
    {
        activeIntents[context.intentHash] = true;
        return manager.onIntentSignaled(context);
    }

    function dropIntent(bytes32 intentHash) external {
        activeIntents[intentHash] = false;
    }

    function hasActiveIntent(bytes32 intentHash) external view returns (bool) {
        return activeIntents[intentHash];
    }
}
