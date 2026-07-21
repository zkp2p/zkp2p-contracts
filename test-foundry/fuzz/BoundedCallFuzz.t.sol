// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {BoundedCall} from "contracts/lib/BoundedCall.sol";

contract RawReturnTarget {
    fallback(bytes calldata input) external returns (bytes memory output) {
        (uint256 length, bool shouldRevert) = abi.decode(input, (uint256, bool));
        output = new bytes(length);
        if (shouldRevert) {
            assembly ("memory-safe") {
                revert(add(output, 0x20), mload(output))
            }
        }
    }
}

contract BoundedCallHarness {
    function callBounded(address target, uint256 maximumReturnDataSize, bytes calldata callData)
        external
        returns (bool success, bytes memory returnData)
    {
        return BoundedCall.callWithBoundedReturnData(target, 1_000_000, maximumReturnDataSize, callData);
    }
}

/// @dev Added assurance: the production assembly helper must cap both successful and
/// reverting payloads without changing their prefix or call-success classification.
contract BoundedCallFuzzTest is Test {
    RawReturnTarget internal target;
    BoundedCallHarness internal harness;

    function setUp() public {
        target = new RawReturnTarget();
        harness = new BoundedCallHarness();
    }

    function testFuzz_BoundedReturnDataPreservesPrefixAndCapsBothOutcomes(
        uint16 rawLength,
        uint16 rawMaximum,
        bool shouldRevert
    ) public {
        _assertBoundedCall(257, 64, false);

        uint256 length = bound(uint256(rawLength), 0, 4_096);
        uint256 maximum = bound(uint256(rawMaximum), 0, 512);
        _assertBoundedCall(length, maximum, shouldRevert);
    }

    function _assertBoundedCall(uint256 length, uint256 maximum, bool shouldRevert) internal {
        (bool success, bytes memory returnData) =
            harness.callBounded(address(target), maximum, abi.encode(length, shouldRevert));

        assertEq(success, !shouldRevert, "call success classification changed");
        assertEq(returnData.length, _min(length, maximum), "return data was not bounded exactly");
        assertEq(returnData, new bytes(_min(length, maximum)), "bounded payload prefix changed");
    }

    function _min(uint256 left, uint256 right) internal pure returns (uint256) {
        return left < right ? left : right;
    }
}
