// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {PythMock} from "contracts/mocks/PythMock.sol";
import {PythOracleAdapter} from "contracts/oracles/PythOracleAdapter.sol";

contract PythOracleDeploymentTest is Test {
    PythMock internal pyth;
    PythOracleAdapter internal adapter;

    function setUp() public {
        pyth = new PythMock();
        adapter = new PythOracleAdapter(address(pyth));
    }

    function test_PythMockIsDeployedLocally() public view {
        assertGt(address(pyth).code.length, 0);
    }

    function test_PythOracleAdapterIsDeployed() public view {
        assertGt(address(adapter).code.length, 0);
    }

    function test_PythOracleAdapterWiresPyth() public view {
        assertEq(address(adapter.pyth()), address(pyth));
    }
}
