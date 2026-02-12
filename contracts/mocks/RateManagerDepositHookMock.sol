// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IDepositRateManagerHook } from "../interfaces/IDepositRateManagerHook.sol";

contract RateManagerDepositHookMock is IDepositRateManagerHook {
    event OptInCalled(address depositor, address escrow, uint256 depositId, address registry, bytes32 rateManagerId);

    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function onDepositOptIn(
        address depositor,
        address escrow,
        uint256 depositId,
        address registry,
        bytes32 rateManagerId
    )
        external
        view
        override
    {
        if (shouldRevert) {
            revert("Hook: revert on opt-in");
        }
        // view only; cannot emit here without changing signature. Tests will check revert/non-revert behavior.
        depositor; escrow; depositId; registry; rateManagerId; // silence warnings
    }
}
