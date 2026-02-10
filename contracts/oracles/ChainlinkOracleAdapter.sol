// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IChainlinkAggregatorV3 } from "../interfaces/IChainlinkAggregatorV3.sol";
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
     * @dev Reverts if feed decimals exceed 18.
     *
     * Special-case: `feed == address(0)` is allowed and implies a constant 1.0 base rate (in preciseUnits).
     * This is useful for USD when the deposit token is assumed to be USDC.
     */
    function validateConfig(bytes calldata rawConfig) external view returns (bytes memory normalizedConfig) {
        (address feed, bool invert) = abi.decode(rawConfig, (address, bool));
        if (feed == address(0)) {
            normalizedConfig = abi.encodePacked(feed, uint8(0), invert ? bytes1(uint8(1)) : bytes1(uint8(0)));
            return normalizedConfig;
        }

        uint8 feedDecimals = IChainlinkAggregatorV3(feed).decimals();
        require(feedDecimals <= 18, "Unsupported decimals");

        normalizedConfig = abi.encodePacked(feed, feedDecimals, invert ? bytes1(uint8(1)) : bytes1(uint8(0)));
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
        (address feed, uint8 feedDecimals, bool invert) = _decodeNormalizedConfig(normalizedConfig);
        if (feed == address(0)) {
            // Constant 1.0 base rate. Use `block.timestamp` so staleness checks can succeed.
            return (true, PRECISE_UNIT, block.timestamp);
        }
        if (feedDecimals > 18) {
            return (false, 0, 0);
        }

        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt_,
            uint80 answeredInRound
        ) = IChainlinkAggregatorV3(feed).latestRoundData();

        if (answer <= 0) {
            return (false, 0, 0);
        }
        if (updatedAt_ == 0) {
            return (false, 0, 0);
        }
        if (answeredInRound < roundId) {
            return (false, 0, 0);
        }

        uint256 answerUint = uint256(answer);
        uint256 decimalsScale = 10 ** uint256(feedDecimals);

        if (invert) {
            // rate = (1e18 * 10^decimals) / answer
            uint256 invertedRate = Math.mulDiv(PRECISE_UNIT, decimalsScale, answerUint, Math.Rounding.Up);
            return (true, invertedRate, updatedAt_);
        }

        // rate = (answer * 1e18) / 10^decimals
        uint256 directRate = Math.mulDiv(answerUint, PRECISE_UNIT, decimalsScale, Math.Rounding.Up);
        return (true, directRate, updatedAt_);
    }

    /* ============ Internal Functions ============ */

    function _decodeNormalizedConfig(bytes calldata normalizedConfig)
        internal
        pure
        returns (address feed, uint8 feedDecimals, bool invert)
    {
        require(normalizedConfig.length == 22, "Invalid config");

        uint8 invertByte;
        assembly {
            feed := shr(96, calldataload(normalizedConfig.offset))
            feedDecimals := byte(0, calldataload(add(normalizedConfig.offset, 20)))
            invertByte := byte(0, calldataload(add(normalizedConfig.offset, 21)))
        }

        invert = invertByte != 0;
    }
}
