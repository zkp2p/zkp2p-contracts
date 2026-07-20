// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { BoundedCall } from "../../contracts/lib/BoundedCall.sol";
import { IIntentRiskHook } from "../../contracts/interfaces/IIntentRiskHook.sol";
import { IntentRiskHookMock } from "../../contracts/mocks/IntentRiskHookMock.sol";

contract BoundedCallHarness {
    function execute(
        address _target,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize,
        bytes calldata _callData
    ) external returns (bool success, bytes memory returnData) {
        return BoundedCall.callWithBoundedReturnData(
            _target,
            _gasLimit,
            _maxReturnDataSize,
            _callData
        );
    }

    function executeCancellation(
        IIntentRiskHook _hook,
        uint256 _gasLimit
    ) external returns (bool success) {
        return BoundedCall.executeRiskCancellation(_hook, bytes32(uint256(1)), _gasLimit, 2_048);
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
    IntentRiskHookMock internal riskHook;

    function setUp() public {
        harness = new BoundedCallHarness();
        target = new BoundedCallTarget();
        riskHook = new IntentRiskHookMock();
    }

    function test_ReturnsSuccessfulBoundedCallData() public {
        (bool success, bytes memory returnData) = harness.execute(
            address(target),
            100_000,
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
            64,
            abi.encodeCall(BoundedCallTarget.consumeAllGas, ())
        );

        assertFalse(success);
        assertEq(revertData.length, 0);
    }

    function test_CancellationRevertsInsteadOfFailingOpenWhenOuterGasCannotFundAllowance() public {
        (bool success, bytes memory revertData) = address(harness).call{ gas: 100_000 }(
            abi.encodeCall(BoundedCallHarness.executeCancellation, (riskHook, 200_000))
        );

        assertFalse(success);
        assertEq(bytes4(revertData), BoundedCall.InsufficientGasForRiskCallback.selector);
    }

    function test_CancellationForwardsConfiguredGasWhenSufficient() public {
        assertTrue(harness.executeCancellation(riskHook, 200_000));
        assertEq(riskHook.cancelledCalls(), 1);
    }
}
