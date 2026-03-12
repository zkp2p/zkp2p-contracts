// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { PythOracleAdapter } from "../../../contracts/oracles/PythOracleAdapter.sol";
import { V2DeploymentTestBase } from "../../helpers/V2DeploymentTestBase.sol";

contract PythOracleDeploymentTest is V2DeploymentTestBase {
    function setUp() public {
        _setUpDeploymentHarness();
    }

    function test_runDeploysPythMockWhenNoExistingPythIsConfigured() public {
        pythResult = _runPythOracleDeployment(address(0), true);
        PythOracleAdapter adapter = PythOracleAdapter(pythResult.pythOracleAdapter);

        assertTrue(pythResult.pyth != address(0));
        assertEq(address(adapter.pyth()), pythResult.pyth);
    }

    function test_runUsesConfiguredPythAddressWhenProvided() public {
        address existingPyth = makeAddr("existingPyth");
        pythResult = _runPythOracleDeployment(existingPyth, false);
        PythOracleAdapter adapter = PythOracleAdapter(pythResult.pythOracleAdapter);

        assertEq(pythResult.pyth, existingPyth);
        assertEq(address(adapter.pyth()), existingPyth);
    }
}
