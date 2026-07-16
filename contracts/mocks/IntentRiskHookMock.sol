// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";

/**
 * @title IntentRiskHookMock
 * @notice Configurable lifecycle hook used to exercise OrchestratorV3 callback behavior.
 */
contract IntentRiskHookMock is IIntentRiskHook {
    bool public requiresSettlementHook;
    bool public revertOnCreate;
    bool public revertOnTerminal;
    uint256 public terminalRevertDataSize;
    bytes32 public lastIntentHash;
    bytes32 public lastPaymentId;
    uint256 public lastReleasedAmount;
    uint256 public createdCalls;
    uint256 public cancelledCalls;
    uint256 public fulfilledCalls;
    uint256 public releasedCalls;

    function setRequiresSettlementHook(bool _required) external {
        requiresSettlementHook = _required;
    }

    function setRevertOnCreate(bool _shouldRevert) external {
        revertOnCreate = _shouldRevert;
    }

    function setRevertOnTerminal(bool _shouldRevert) external {
        revertOnTerminal = _shouldRevert;
    }

    function setTerminalRevertDataSize(uint256 _size) external {
        terminalRevertDataSize = _size;
    }

    function onIntentCreated(bytes32 _intentHash) external override returns (bool) {
        if (revertOnCreate) revert("risk admission failed");
        lastIntentHash = _intentHash;
        createdCalls++;
        return requiresSettlementHook;
    }

    function onIntentCancelled(bytes32 _intentHash) external override {
        _revertWithConfiguredData();
        if (revertOnTerminal) revert("risk cancellation failed");
        lastIntentHash = _intentHash;
        cancelledCalls++;
    }

    function onIntentFulfilled(
        bytes32 _intentHash,
        uint256 _releasedAmount,
        bytes32 _paymentId
    ) external override {
        _revertWithConfiguredData();
        if (revertOnTerminal) revert("risk fulfillment failed");
        lastIntentHash = _intentHash;
        lastReleasedAmount = _releasedAmount;
        lastPaymentId = _paymentId;
        fulfilledCalls++;
    }

    function onIntentReleased(bytes32 _intentHash, uint256 _releasedAmount) external override {
        _revertWithConfiguredData();
        if (revertOnTerminal) revert("risk release failed");
        lastIntentHash = _intentHash;
        lastReleasedAmount = _releasedAmount;
        releasedCalls++;
    }

    function _revertWithConfiguredData() internal view {
        uint256 revertDataSize = terminalRevertDataSize;
        if (revertDataSize == 0) return;

        assembly ("memory-safe") {
            revert(mload(0x40), revertDataSize)
        }
    }
}
