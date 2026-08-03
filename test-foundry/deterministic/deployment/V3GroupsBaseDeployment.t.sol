// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

contract V3GroupsBaseDeploymentTest is Test {
    function test_PreparesAndResumesExactSingleSafeRegistration() public {
        assertEq(_ffiCheck("prepare-resume"), 1);
    }

    function test_RejectsMismatchedResumedOrchestratorBeforeSafeMutation() public {
        assertEq(_ffiCheck("reject-mismatch"), 1);
    }

    function _ffiCheck(string memory scenario) internal returns (uint8) {
        string[] memory command = new string[](3);
        command[0] = "node";
        command[1] = "scripts/test-v3-groups-base-deployment.cjs";
        command[2] = scenario;
        bytes memory result = vm.ffi(command);
        assertEq(result.length, 1);
        return uint8(result[0]);
    }
}
