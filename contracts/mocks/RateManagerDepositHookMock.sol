// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IRateManagerDepositHook } from "../interfaces/IRateManagerDepositHook.sol";

contract RateManagerDepositHookMock is IRateManagerDepositHook {
    event OptInCalled(address depositor, address escrow, uint256 depositId);

    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function onDepositOptIn(address depositor, address escrow, uint256 depositId) external view override {
        if (shouldRevert) {
            revert("Hook: revert on opt-in");
        }
        // view only; cannot emit here without changing signature. Tests will check revert/non-revert behavior.
        depositor; escrow; depositId; // silence warnings
    }
}

