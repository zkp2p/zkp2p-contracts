// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { ChainlinkOracleAdapter } from "../../contracts/oracles/ChainlinkOracleAdapter.sol";
import { AggregatorV3Mock } from "../../contracts/mocks/AggregatorV3Mock.sol";

contract ChainlinkOracleAdapterTest is Test {
    uint256 internal constant PRECISE_UNIT = 1e18;

    ChainlinkOracleAdapter internal adapter;
    AggregatorV3Mock internal feed;

    function setUp() public {
        adapter = new ChainlinkOracleAdapter();
        feed = new AggregatorV3Mock(8, 110_000_000);
    }

    function test_validateConfigReturnsPackedNormalizedConfig() public view {
        bytes memory config = adapter.validateConfig(_encodeRawConfig(address(feed), true));

        assertEq(config, abi.encodePacked(address(feed), uint8(8), bytes1(uint8(1))));
    }

    function test_validateConfigReturnsPackedZeroFeedConfig() public view {
        bytes memory config = adapter.validateConfig(_encodeRawConfig(address(0), false));

        assertEq(config, abi.encodePacked(address(0), uint8(0), bytes1(uint8(0))));
    }

    function test_validateConfigRevertsWhenFeedDecimalsExceed18() public {
        AggregatorV3Mock invalidFeed = new AggregatorV3Mock(19, 1);

        vm.expectRevert("Unsupported decimals");
        adapter.validateConfig(_encodeRawConfig(address(invalidFeed), false));
    }

    function test_getRateReturnsInvertedRateAndUpdatedAt() public view {
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(
            adapter.validateConfig(_encodeRawConfig(address(feed), true))
        );

        uint256 expected = _ceilDiv(10 ** 26, 110_000_000);

        assertTrue(valid);
        assertEq(rate, expected);
        assertGt(updatedAt, 0);
    }

    function test_getRateReturnsDirectRateWhenInvertFalse() public view {
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(
            adapter.validateConfig(_encodeRawConfig(address(feed), false))
        );

        assertTrue(valid);
        assertEq(rate, 1.1e18);
        assertGt(updatedAt, 0);
    }

    function test_getRateReturnsConstantOneWhenFeedIsZero() public view {
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(
            adapter.validateConfig(_encodeRawConfig(address(0), false))
        );

        assertTrue(valid);
        assertEq(rate, PRECISE_UNIT);
        assertGt(updatedAt, 0);
    }

    function test_getRateReturnsInvalidWhenFeedDecimalsExceed18InNormalizedConfig() public view {
        bytes memory malformedConfig = abi.encodePacked(address(feed), uint8(19), bytes1(uint8(0)));
        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(malformedConfig);

        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_getRateReturnsInvalidWhenAnswerIsZero() public {
        uint256 currentTime = block.timestamp;
        feed.setRoundData(1, 0, currentTime, currentTime, 1);

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(
            adapter.validateConfig(_encodeRawConfig(address(feed), true))
        );

        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_getRateReturnsInvalidWhenUpdatedAtIsZero() public {
        uint256 currentTime = block.timestamp;
        feed.setRoundData(1, 110_000_000, currentTime, 0, 1);

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(
            adapter.validateConfig(_encodeRawConfig(address(feed), true))
        );

        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_getRateReturnsInvalidWhenAnsweredInRoundLagsRoundId() public {
        uint256 currentTime = block.timestamp;
        feed.setRoundData(2, 110_000_000, currentTime, currentTime, 1);

        (bool valid, uint256 rate, uint256 updatedAt) = adapter.getRate(
            adapter.validateConfig(_encodeRawConfig(address(feed), true))
        );

        assertFalse(valid);
        assertEq(rate, 0);
        assertEq(updatedAt, 0);
    }

    function test_getRateRevertsWhenConfigLengthIsInvalid() public {
        vm.expectRevert("Invalid config");
        adapter.getRate(hex"");
    }

    function _encodeRawConfig(address feedAddress, bool invert) internal pure returns (bytes memory rawConfig) {
        rawConfig = abi.encode(feedAddress, invert);
    }

    function _ceilDiv(uint256 left, uint256 right) internal pure returns (uint256 result) {
        result = (left + right - 1) / right;
    }
}
