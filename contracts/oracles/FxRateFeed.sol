// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IChainlinkAggregatorV3} from "../interfaces/IChainlinkAggregatorV3.sol";
import {IFxRateStore} from "../interfaces/IFxRateStore.sol";

/// @title FxRateFeed
/// @notice Chainlink-compatible facade for a fiat/USD feed with an owner-controlled source.
contract FxRateFeed is IChainlinkAggregatorV3, Ownable {
    event SourceUpdated(address indexed source, bytes32 indexed sourceFeedId);

    error ZeroSource();
    error ZeroFeedId();
    error UnsupportedDecimals(uint8 sourceDecimals);
    error UnusableSourceRound(uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound);
    error NoDataPresent(uint80 requestedRoundId);

    /// @notice Store or external aggregator supplying the latest round.
    address public source;

    /// @notice Store feed identifier, or zero when the source is an external aggregator.
    bytes32 public sourceFeedId;

    /// @notice Human-readable currency pair description.
    string public description;

    /// @notice Initialize a store-backed feed without requiring a live source round.
    /// @param store Initial rate store.
    /// @param feedId Nonzero identifier of the store feed.
    /// @param feedDescription Human-readable currency pair description.
    constructor(address store, bytes32 feedId, string memory feedDescription) {
        if (store == address(0)) revert ZeroSource();
        if (feedId == bytes32(0)) revert ZeroFeedId();
        source = store;
        sourceFeedId = feedId;
        description = feedDescription;
    }

    /// @notice Return the facade version.
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice Return the fixed precision of the fiat/USD answer.
    function decimals() external pure override returns (uint8) {
        return 8;
    }

    /// @notice Return the source's latest tuple unchanged, including invalid or stale rounds.
    function latestRoundData()
        public
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (sourceFeedId != bytes32(0)) {
            return IFxRateStore(source).latestRoundData(sourceFeedId);
        }
        return IChainlinkAggregatorV3(source).latestRoundData();
    }

    /// @notice Return the latest tuple only; historical rounds are not served.
    /// @param requestedRoundId Round identifier that must match the current source's latest round.
    function getRoundData(uint80 requestedRoundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (roundId, answer, startedAt, updatedAt, answeredInRound) = latestRoundData();
        if (requestedRoundId != roundId) revert NoDataPresent(requestedRoundId);
    }

    /// @notice Switch to an eight-decimal source with a usable round no older than one day.
    /// @param newSource Replacement rate store or external aggregator.
    /// @param newSourceFeedId Store feed identifier, or zero for an external aggregator.
    function setSource(address newSource, bytes32 newSourceFeedId) external onlyOwner {
        if (newSource == address(0)) revert ZeroSource();
        uint8 sourceDecimals = IChainlinkAggregatorV3(newSource).decimals();
        if (sourceDecimals != 8) revert UnsupportedDecimals(sourceDecimals);

        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = newSourceFeedId != bytes32(0)
            ? IFxRateStore(newSource).latestRoundData(newSourceFeedId)
            : IChainlinkAggregatorV3(newSource).latestRoundData();
        if (
            answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > 1 days
                || answeredInRound < roundId
        ) {
            revert UnusableSourceRound(roundId, answer, updatedAt, answeredInRound);
        }

        source = newSource;
        sourceFeedId = newSourceFeedId;
        emit SourceUpdated(newSource, newSourceFeedId);
    }
}
