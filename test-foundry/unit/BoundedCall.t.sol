// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { BoundedCall } from "../../contracts/lib/BoundedCall.sol";

contract BoundedCallHarness {
    function execute(
        address _target,
        uint256 _gasLimit,
        uint256 _postCallGasReserve,
        uint256 _maxReturnDataSize,
        bytes calldata _callData
    ) external returns (bool success, bytes memory returnData) {
        return BoundedCall.callWithBoundedReturnData(
            _target,
            _gasLimit,
            _postCallGasReserve,
            _maxReturnDataSize,
            _callData
        );
    }

    function calculateCallGas(
        uint256 _availableGas,
        uint256 _gasLimit,
        uint256 _postCallGasReserve
    ) external pure returns (uint256) {
        return BoundedCall._calculateCallGas(_availableGas, _gasLimit, _postCallGasReserve);
    }
}

contract BoundedCallTarget {
    function returnTrue() external pure returns (bool) {
        return true;
    }

    function revertWithData(uint256 _size) external pure {
        assembly ("memory-safe") {
            revert(mload(0x40), _size)
        }
    }

    function consumeAllGas() external pure {
        assembly ("memory-safe") {
            for { } 1 { } { }
        }
    }
}

contract BoundedCallTest is Test {
    BoundedCallHarness internal harness;
    BoundedCallTarget internal target;

    function setUp() public {
        harness = new BoundedCallHarness();
        target = new BoundedCallTarget();
    }

    function test_ReturnsSuccessfulBoundedCallData() public {
        (bool success, bytes memory returnData) = harness.execute(
            address(target),
            100_000,
            10_000,
            2_048,
            abi.encodeCall(BoundedCallTarget.returnTrue, ())
        );

        assertTrue(success);
        assertEq(returnData.length, 32);
        assertTrue(abi.decode(returnData, (bool)));
    }

    function test_CapsLargeRevertData() public {
        (bool success, bytes memory revertData) = harness.execute(
            address(target),
            100_000,
            10_000,
            64,
            abi.encodeCall(BoundedCallTarget.revertWithData, (32_768))
        );

        assertFalse(success);
        assertEq(revertData.length, 64);
    }

    function test_GasLimitedFailureDoesNotRevertCaller() public {
        (bool success, bytes memory revertData) = harness.execute(
            address(target),
            20_000,
            10_000,
            64,
            abi.encodeCall(BoundedCallTarget.consumeAllGas, ())
        );

        assertFalse(success);
        assertEq(revertData.length, 0);
    }

    function test_ReturnsZeroWhenReconciliationReserveCannotBeRetained() public view {
        assertEq(harness.calculateCallGas(260_000, 100_000, 250_000), 0);
    }

    function test_UsesConfiguredGasLimitWhenItIsTheLowestCap() public view {
        assertEq(harness.calculateCallGas(1_000_000, 100_000, 250_000), 100_000);
    }

    function test_CapsCallGasByEip150() public view {
        uint256 afterOverhead = 90_000;
        uint256 expected = afterOverhead - (afterOverhead / 64);

        assertEq(harness.calculateCallGas(100_000, type(uint256).max, 0), expected);
    }

    function test_CapsCallGasByReconciliationReserve() public view {
        assertEq(harness.calculateCallGas(100_000, type(uint256).max, 25_000), 65_000);
    }
}
