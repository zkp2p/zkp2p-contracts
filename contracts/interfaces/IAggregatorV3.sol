// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IAggregatorV3
 * @notice Minimal interface for Chainlink AggregatorV3-style feeds.
 */
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

