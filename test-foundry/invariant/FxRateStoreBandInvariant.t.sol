// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {FxRateStoreBandHandler} from "./handlers/FxRateStoreBandHandler.sol";

contract FxRateStoreBandInvariantTest is StdInvariant, Test {
    FxRateStoreBandHandler internal handler;

    function setUp() public {
        vm.warp(1);
        handler = new FxRateStoreBandHandler();
        targetContract(address(handler));
    }

    function invariant_WriteWithinFivePercentOfEveryPriceDisplayedInPreceding24h() public view {
        assertTrue(handler.checkDisplayedBand(), "Displayed price differs by more than five percent");
    }

    function test_InvariantModelHandlesDayOneWrites() public {
        // setUp constructs and seeds the handler at t = 1.
        vm.warp(2);
        handler.write(1_000_002);
        vm.warp(3600);
        handler.write(1_000_002);

        assertEq(handler.logLength(), 3, "Both day-one writes must succeed");
        (uint64 seedStart,,, bool isSeed) = handler.displayLog(0);
        (uint64 firstWriteStart,,,) = handler.displayLog(1);
        (uint64 secondWriteStart,,,) = handler.displayLog(2);
        assertTrue(isSeed);
        assertEq(seedStart, 1);
        assertEq(firstWriteStart, 2);
        assertEq(secondWriteStart, 3600);
        assertTrue(handler.checkDisplayedBand());
    }
}
