// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

contract SafeBatchCollectorTest is Test {
    function test_SafeBatchCollectorDeduplicatesCaseInsensitively() public {
        assertEq(_runScenario("duplicate"), 1);
    }

    function test_SafeBatchCollectorRetainsDifferentTargetOrCalldata() public {
        assertEq(_runScenario("distinct"), 3);
    }

    function _runScenario(string memory scenario) internal returns (uint8) {
        string[] memory command = new string[](3);
        command[0] = "node";
        command[1] = "scripts/test-safe-batch-collector.cjs";
        command[2] = scenario;
        bytes memory result = vm.ffi(command);
        assertEq(result.length, 1, "unexpected SafeBatchCollector runner output");
        return uint8(result[0]);
    }
}
