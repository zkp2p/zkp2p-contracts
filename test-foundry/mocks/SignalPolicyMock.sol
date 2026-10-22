// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentSignalPolicy} from "contracts/interfaces/IIntentSignalPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";

/// @notice Accepts every signal unless configured to reject, and records what OrchestratorV4 forwarded.
contract SignalPolicyMock is IIntentSignalPolicy {
    bool public revertOnSignal;
    address public lastTaker;
    bytes public lastParams;
    uint256 public signalCalls;

    /// @notice Configures signal rejection.
    function setRevertOnSignal(bool _shouldRevert) external {
        revertOnSignal = _shouldRevert;
    }

    /// @inheritdoc IIntentSignalPolicy
    function validateSignalIntent(address _taker, IOrchestratorV4.SignalIntentParams calldata _params)
        external
        override
    {
        if (revertOnSignal) revert("signal rejected");
        lastTaker = _taker;
        lastParams = abi.encode(_params);
        signalCalls++;
    }
}
