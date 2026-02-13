// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPreIntentHook } from "../interfaces/IPreIntentHook.sol";

interface IReentrantSignalIntentCaller {
    function attemptReenter() external;
}

/**
 * @notice Pre-intent hook that attempts to reenter signalIntent via a contract taker callback.
 *         It catches reverts so the outer signalIntent can continue.
 */
contract ReentrantPreIntentHookMock is IPreIntentHook {
    address public immutable reentrantCaller;

    uint256 public reentryAttemptCount;
    bool public lastReentrySucceeded;

    constructor(address _reentrantCaller) {
        reentrantCaller = _reentrantCaller;
    }

    function validateSignalIntent(PreIntentContext calldata /*_ctx*/) external override {
        reentryAttemptCount += 1;

        try IReentrantSignalIntentCaller(reentrantCaller).attemptReenter() {
            lastReentrySucceeded = true;
        } catch {
            lastReentrySucceeded = false;
        }
    }
}
