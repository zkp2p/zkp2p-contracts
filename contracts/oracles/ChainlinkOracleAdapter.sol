// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAggregatorV3 } from "../interfaces/IAggregatorV3.sol";
import { IOracleAdapter } from "../interfaces/IOracleAdapter.sol";

/**
 * @title ChainlinkOracleAdapter
 * @notice Oracle adapter for Chainlink AggregatorV3-style feeds.
 * @dev Normalizes answers to 1e18 preciseUnits ("fiat per deposit token") with rounding-up.
 *
 * Raw config format:
 * - abi.encode(address feed, bool invert)
 *
 * Normalized config format (packed bytes, length = 22):
 * - [0..19]  feed (address, 20 bytes)
 * - [20]     decimals (uint8)
 * - [21]     invert flag (uint8; 0 = false, 1 = true)
 */
contract ChainlinkOracleAdapter is IOracleAdapter {
    using Math for uint256;

    /* ============ Constants ============ */

    uint256 internal constant PRECISE_UNIT = 1e18;

    /* ============ External View Functions ============ */

    /**
     * @notice Validates raw config and returns packed normalized config.
     * @dev Reverts if feed is zero or feed decimals exceed 18.
     */
    function validateConfig(bytes calldata rawConfig) external view returns (bytes memory normalizedConfig) {
        (address feed, bool invert) = abi.decode(rawConfig, (address, bool));
        require(feed != address(0), "Invalid feed");

        uint8 decimals_ = IAggregatorV3(feed).decimals();
        require(decimals_ <= 18, "Unsupported decimals");

        normalizedConfig = abi.encodePacked(feed, decimals_, invert ? bytes1(uint8(1)) : bytes1(uint8(0)));
    }

    /**
     * @notice Returns the market rate in preciseUnits and the oracle `updatedAt`.
     * @dev Returns (false, 0, 0) on invalid oracle responses. Does not perform staleness checks.
     */
    function getRate(bytes calldata normalizedConfig)
        external
        view
        returns (bool valid, uint256 rate, uint256 updatedAt)
    {
        (address feed, uint8 decimals_, bool invert) = _decodeNormalizedConfig(normalizedConfig);
        if (decimals_ > 18) {
            return (false, 0, 0);
        }

        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt_,
            uint80 answeredInRound
        ) = IAggregatorV3(feed).latestRoundData();

        if (answer <= 0) {
            return (false, 0, 0);
        }
        if (updatedAt_ == 0) {
            return (false, 0, 0);
        }
        if (answeredInRound < roundId) {
            return (false, 0, 0);
        }

        uint256 ans = uint256(answer);
        uint256 scale = 10 ** uint256(decimals_);

        if (invert) {
            // rate = (1e18 * 10^decimals) / answer
            uint256 invertedRate = Math.mulDiv(PRECISE_UNIT, scale, ans, Math.Rounding.Up);
            return (true, invertedRate, updatedAt_);
        }

        // rate = (answer * 1e18) / 10^decimals
        uint256 directRate = Math.mulDiv(ans, PRECISE_UNIT, scale, Math.Rounding.Up);
        return (true, directRate, updatedAt_);
    }

    /* ============ Internal Functions ============ */

    function _decodeNormalizedConfig(bytes calldata normalizedConfig)
        internal
        pure
        returns (address feed, uint8 decimals_, bool invert)
    {
        require(normalizedConfig.length == 22, "Invalid config");

        uint8 invertFlag;
        assembly {
            feed := shr(96, calldataload(normalizedConfig.offset))
            decimals_ := byte(0, calldataload(add(normalizedConfig.offset, 20)))
            invertFlag := byte(0, calldataload(add(normalizedConfig.offset, 21)))
        }

        invert = invertFlag != 0;
    }
}

