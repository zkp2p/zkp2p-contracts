// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentLifecycleHook } from "../interfaces/IIntentLifecycleHook.sol";

/**
 * @title IntentLifecycleHookV1Mock
 * @notice Configurable lifecycle hook used to exercise OrchestratorV3 callback behavior.
 */
contract IntentLifecycleHookV1Mock is IIntentLifecycleHook {
    bool public revertOnCreate;
    bool public revertOnCallback;
    bytes32 public lastIntentHash;
    SettlementContext public lastSettlementContext;
    uint256 public createdCalls;
    uint256 public cancelledCalls;
    uint256 public settlementCalls;

    function setRevertOnCreate(bool _shouldRevert) external {
        revertOnCreate = _shouldRevert;
    }

    function setRevertOnCallback(bool _shouldRevert) external {
        revertOnCallback = _shouldRevert;
    }

    function onIntentCreated(bytes32 _intentHash) external override {
        if (revertOnCreate) revert("risk admission failed");
        lastIntentHash = _intentHash;
        createdCalls++;
    }

    function onIntentCancelled(bytes32 _intentHash) external override {
        if (revertOnCallback) revert("risk cancellation failed");
        lastIntentHash = _intentHash;
        cancelledCalls++;
    }

    function settleIntent(SettlementContext calldata _context) external override {
        if (revertOnCallback) revert("risk settlement failed");
        lastIntentHash = _context.intentHash;
        lastSettlementContext = _context;
        settlementCalls++;
    }
}
