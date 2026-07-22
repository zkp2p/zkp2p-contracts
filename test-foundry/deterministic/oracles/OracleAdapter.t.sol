// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {ChainlinkOracleAdapter} from "contracts/oracles/ChainlinkOracleAdapter.sol";
import {PythOracleAdapter} from "contracts/oracles/PythOracleAdapter.sol";
import {AggregatorV3Mock} from "contracts/mocks/AggregatorV3Mock.sol";
import {PythMock} from "contracts/mocks/PythMock.sol";

contract ChainlinkOracleAdapterTest is Test {
    ChainlinkOracleAdapter internal adapter;
    AggregatorV3Mock internal feed;

    function setUp() public {
        vm.warp(1_000_000);
        adapter = new ChainlinkOracleAdapter();
        feed = new AggregatorV3Mock(8, 110_000_000);
    }

    function _raw(address feedAddress, bool invert) internal pure returns (bytes memory) {
        return abi.encode(feedAddress, invert);
    }

    function _assertInvalid(bytes memory config) internal view {
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(config);
        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_ValidateConfigPacksFeedDecimalsAndInvertFlag() public view {
        bytes memory config = adapter.validateConfig(_raw(address(feed), true));
        assertEq(config.length, 22);
        assertEq(config, abi.encodePacked(address(feed), uint8(8), bytes1(uint8(1))));
    }

    function test_ValidateConfigAllowsZeroFeedAsConstantRate() public view {
        bytes memory config = adapter.validateConfig(_raw(address(0), false));
        assertEq(config.length, 22);
        assertEq(config, abi.encodePacked(address(0), uint8(0), bytes1(uint8(0))));
    }

    function test_ValidateConfigRejectsDecimalsAboveEighteen() public {
        AggregatorV3Mock unsupportedFeed = new AggregatorV3Mock(19, 1);
        vm.expectRevert(bytes("Unsupported decimals"));
        adapter.validateConfig(_raw(address(unsupportedFeed), false));
    }

    function test_GetRateReturnsRoundedUpInvertedRateAndTimestamp() public view {
        bytes memory config = adapter.validateConfig(_raw(address(feed), true));
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(config);
        assertTrue(valid);
        uint256 expected = (uint256(1e26) + 110_000_000 - 1) / 110_000_000;
        assertEq(rate, expected);
        assertEq(updatedAt, block.timestamp);
    }

    function test_GetRateReturnsDirectRateScaledToPreciseUnits() public view {
        bytes memory config = adapter.validateConfig(_raw(address(feed), false));
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(config);
        assertTrue(valid);
        assertEq(rate, 1_100_000_000_000_000_000);
        assertEq(updatedAt, block.timestamp);
    }

    function test_GetRateReturnsOneForConstantZeroFeed() public view {
        bytes memory config = adapter.validateConfig(_raw(address(0), false));
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(config);
        assertTrue(valid);
        assertEq(rate, 1e18);
        assertEq(updatedAt, block.timestamp);
    }

    function test_GetRateDefensivelyRejectsNormalizedDecimalsAboveEighteen() public view {
        _assertInvalid(abi.encodePacked(address(feed), uint8(19), bytes1(uint8(0))));
    }

    function test_GetRateRejectsZeroAndNegativeAnswers() public {
        bytes memory config = adapter.validateConfig(_raw(address(feed), true));
        feed.setRoundData(1, 0, block.timestamp, block.timestamp, 1);
        _assertInvalid(config);
        feed.setRoundData(1, -1, block.timestamp, block.timestamp, 1);
        _assertInvalid(config);
    }

    function test_GetRateRejectsZeroUpdatedAt() public {
        bytes memory config = adapter.validateConfig(_raw(address(feed), true));
        feed.setRoundData(1, 110_000_000, block.timestamp, 0, 1);
        _assertInvalid(config);
    }

    function test_GetRateRejectsStaleAnsweredRound() public {
        bytes memory config = adapter.validateConfig(_raw(address(feed), true));
        feed.setRoundData(2, 110_000_000, block.timestamp, block.timestamp, 1);
        _assertInvalid(config);
    }

    function test_GetRateRejectsInvalidConfigLength() public {
        vm.expectRevert(bytes("Invalid config"));
        adapter.getRate("");
    }
}

contract PythOracleAdapterTest is Test {
    bytes32 internal constant FEED_ID = keccak256("USD/INR");

    PythMock internal pyth;
    PythOracleAdapter internal adapter;

    function setUp() public {
        vm.warp(1_000_000);
        pyth = new PythMock();
        adapter = new PythOracleAdapter(address(pyth));
        pyth.setPrice(FEED_ID, 8_347_500, 100, -5, block.timestamp);
    }

    function _raw(bytes32 feedId, bool invert) internal pure returns (bytes memory) {
        return abi.encode(feedId, invert);
    }

    function _config(bool invert) internal view returns (bytes memory) {
        return adapter.validateConfig(_raw(FEED_ID, invert));
    }

    function _assertInvalid(bytes memory config) internal view {
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(config);
        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_ConstructorStoresPyth() public view {
        assertEq(address(adapter.pyth()), address(pyth));
    }

    function test_ValidateConfigPacksFeedAbsExponentAndFalseInvert() public view {
        bytes memory config = _config(false);
        assertEq(config.length, 34);
        assertEq(config, abi.encodePacked(FEED_ID, uint8(5), bytes1(uint8(0))));
    }

    function test_ValidateConfigPacksTrueInvertFlag() public view {
        assertEq(_config(true), abi.encodePacked(FEED_ID, uint8(5), bytes1(uint8(1))));
    }

    function test_ValidateConfigUsesAbsoluteExponent() public {
        pyth.setPrice(FEED_ID, 110_000_000, 100, -8, block.timestamp);
        assertEq(_config(false), abi.encodePacked(FEED_ID, uint8(8), bytes1(uint8(0))));
    }

    function test_ValidateConfigRejectsZeroOrUnknownFeed() public {
        vm.expectRevert(bytes("Zero feedId"));
        adapter.validateConfig(_raw(bytes32(0), false));
        vm.expectRevert(bytes("feed not found"));
        adapter.validateConfig(_raw(keccak256("UNKNOWN/FEED"), false));
    }

    function test_ValidateConfigRejectsPositiveOrTooNegativeExponent() public {
        pyth.setPrice(FEED_ID, 100, 0, 1, block.timestamp);
        vm.expectRevert(bytes("Unsupported exponent"));
        adapter.validateConfig(_raw(FEED_ID, false));
        pyth.setPrice(FEED_ID, 100, 0, -19, block.timestamp);
        vm.expectRevert(bytes("Unsupported exponent"));
        adapter.validateConfig(_raw(FEED_ID, false));
    }

    function test_GetRateReturnsDirectRateAndPublishTime() public view {
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(_config(false));
        assertTrue(valid);
        assertEq(rate, 83_475_000_000_000_000_000);
        assertEq(updatedAt, block.timestamp);
    }

    function test_GetRateReturnsRoundedUpInvertedRate() public view {
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(_config(true));
        assertTrue(valid);
        uint256 expected = (uint256(1e23) + 8_347_500 - 1) / 8_347_500;
        assertEq(rate, expected);
        assertEq(updatedAt, block.timestamp);
    }

    function test_GetRateScalesEightDecimalExponent() public {
        pyth.setPrice(FEED_ID, 110_000_000, 100, -8, block.timestamp);
        (bool valid, uint256 rate,) = adapter.getRate(_config(false));
        assertTrue(valid);
        assertEq(rate, 1_100_000_000_000_000_000);
    }

    function test_GetRateScalesEighteenDecimalExponent() public {
        pyth.setPrice(FEED_ID, 1e18, 0, -18, block.timestamp);
        (bool valid, uint256 rate,) = adapter.getRate(_config(false));
        assertTrue(valid);
        assertEq(rate, 1e18);
    }

    function test_GetRateRejectsZeroAndNegativePrices() public {
        bytes memory config = _config(false);
        pyth.setPrice(FEED_ID, 0, 0, -5, block.timestamp);
        _assertInvalid(config);
        pyth.setPrice(FEED_ID, -100, 0, -5, block.timestamp);
        _assertInvalid(config);
    }

    function test_GetRateRejectsZeroPublishTime() public {
        bytes memory config = _config(false);
        pyth.setPrice(FEED_ID, 8_347_500, 100, -5, 0);
        _assertInvalid(config);
    }

    function test_GetRateReturnsInvalidWhenPythReverts() public {
        bytes memory config = _config(false);
        pyth.removePrice(FEED_ID);
        _assertInvalid(config);
    }

    function test_GetRateRejectsInvalidConfigLength() public {
        vm.expectRevert(bytes("Invalid config"));
        adapter.getRate("");
    }
}
