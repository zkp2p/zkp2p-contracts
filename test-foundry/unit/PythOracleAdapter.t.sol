// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { PythOracleAdapter } from "../../contracts/oracles/PythOracleAdapter.sol";
import { PythMock } from "../../contracts/mocks/PythMock.sol";

contract PythOracleAdapterTest is Test {
    uint256 constant PRECISE_UNIT = 1e18;

    PythOracleAdapter public adapter;
    PythMock public pythMock;

    bytes32 constant FEED_ID = keccak256("USD/INR");

    function setUp() public {
        pythMock = new PythMock();
        adapter = new PythOracleAdapter(address(pythMock));

        // Default: USD/INR = 83.475 (price=8347500, expo=-5)
        pythMock.setPrice(FEED_ID, 8347500, 100, -5, block.timestamp);
    }

    /* ===== validateConfig ===== */

    function test_validateConfig_returnsPacked34ByteConfig() public view {
        bytes memory raw = abi.encode(FEED_ID, false);
        bytes memory norm = adapter.validateConfig(raw);

        assertEq(norm.length, 34);

        bytes32 packedFeedId;
        uint8 absExpo;
        uint8 invertFlag;
        assembly {
            packedFeedId := mload(add(norm, 32))
            absExpo := byte(0, mload(add(norm, 64)))
            invertFlag := byte(1, mload(add(norm, 64)))
        }
        assertEq(packedFeedId, FEED_ID);
        assertEq(absExpo, 5); // abs(-5) = 5
        assertEq(invertFlag, 0);
    }

    function test_validateConfig_invertTrue() public view {
        bytes memory raw = abi.encode(FEED_ID, true);
        bytes memory norm = adapter.validateConfig(raw);

        uint8 invertFlag;
        assembly {
            invertFlag := byte(1, mload(add(norm, 64)))
        }
        assertEq(invertFlag, 1);
    }

    function test_validateConfig_absExpoForExpo8() public {
        pythMock.setPrice(FEED_ID, 110000000, 100, -8, block.timestamp);
        bytes memory raw = abi.encode(FEED_ID, false);
        bytes memory norm = adapter.validateConfig(raw);

        uint8 absExpo;
        assembly {
            absExpo := byte(0, mload(add(norm, 64)))
        }
        assertEq(absExpo, 8);
    }

    function test_validateConfig_revertsOnZeroFeedId() public {
        bytes memory raw = abi.encode(bytes32(0), false);
        vm.expectRevert("Zero feedId");
        adapter.validateConfig(raw);
    }

    function test_validateConfig_revertsOnNonExistentFeed() public {
        bytes32 unknownFeed = keccak256("UNKNOWN");
        bytes memory raw = abi.encode(unknownFeed, false);
        vm.expectRevert("feed not found");
        adapter.validateConfig(raw);
    }

    function test_validateConfig_revertsOnPositiveExponent() public {
        pythMock.setPrice(FEED_ID, 100, 0, 1, block.timestamp);
        bytes memory raw = abi.encode(FEED_ID, false);
        vm.expectRevert("Unsupported exponent");
        adapter.validateConfig(raw);
    }

    function test_validateConfig_revertsOnExponentBelowNeg18() public {
        pythMock.setPrice(FEED_ID, 100, 0, -19, block.timestamp);
        bytes memory raw = abi.encode(FEED_ID, false);
        vm.expectRevert("Unsupported exponent");
        adapter.validateConfig(raw);
    }

    /* ===== getRate ===== */

    function test_getRate_directRate() public view {
        bytes memory raw = abi.encode(FEED_ID, false);
        bytes memory norm = adapter.validateConfig(raw);

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(norm);

        assertTrue(valid);
        // 8347500 * 1e18 / 1e5 = 83475e15
        uint256 expected = uint256(8347500) * PRECISE_UNIT / 1e5;
        assertEq(rate, expected);
        assertGt(updatedAt, 0);
    }

    function test_getRate_invertedRate() public view {
        bytes memory raw = abi.encode(FEED_ID, true);
        bytes memory norm = adapter.validateConfig(raw);

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(norm);

        assertTrue(valid);
        // inverted = ceil(1e18 * 1e5 / 8347500)
        uint256 expected = _ceilDiv(PRECISE_UNIT * 1e5, 8347500);
        assertEq(rate, expected);
        assertGt(updatedAt, 0);
    }

    function test_getRate_expo8() public {
        // EUR/USD = 1.10 with expo=-8
        pythMock.setPrice(FEED_ID, 110000000, 100, -8, block.timestamp);
        bytes memory norm = adapter.validateConfig(abi.encode(FEED_ID, false));

        (bool valid, uint256 rate,) = adapter.getRate(norm);

        assertTrue(valid);
        assertEq(rate, 1.1e18);
    }

    function test_getRate_invalidWhenPriceZero() public {
        pythMock.setPrice(FEED_ID, 0, 0, -5, block.timestamp);
        bytes memory norm = adapter.validateConfig(abi.encode(FEED_ID, false));

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(norm);

        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_getRate_invalidWhenPriceNegative() public {
        pythMock.setPrice(FEED_ID, -100, 0, -5, block.timestamp);
        bytes memory norm = adapter.validateConfig(abi.encode(FEED_ID, false));

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(norm);

        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_getRate_invalidWhenPublishTimeZero() public {
        pythMock.setPrice(FEED_ID, 8347500, 100, -5, 0);
        bytes memory norm = adapter.validateConfig(abi.encode(FEED_ID, false));

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(norm);

        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_getRate_invalidWhenFeedRemoved() public {
        bytes memory norm = adapter.validateConfig(abi.encode(FEED_ID, false));

        pythMock.removePrice(FEED_ID);

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(norm);

        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_getRate_revertsOnInvalidConfigLength() public {
        vm.expectRevert("Invalid config");
        adapter.getRate(hex"");
    }

    /* ===== helpers ===== */

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }
}
