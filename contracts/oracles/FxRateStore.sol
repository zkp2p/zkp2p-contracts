// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IFxRateStore} from "../interfaces/IFxRateStore.sol";

/// @title FxRateStore
/// @notice Owner-configured FX rounds published by a single updater.
contract FxRateStore is IFxRateStore, Ownable {
    struct Round {
        uint64 answer;
        uint64 updatedAt;
        uint64 roundId;
    }

    struct BandBucket {
        uint32 hourIndex;
        uint64 minAnswer;
        uint64 maxAnswer;
    }

    uint256 internal constant MAX_BAND_BPS = 500;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant BAND_BUCKET_SECONDS = 1 hours;
    uint256 internal constant BAND_BUCKET_COUNT = 25;

    /// @inheritdoc IFxRateStore
    address public override updater;
    mapping(bytes32 => FeedConfig) internal feedConfigs;
    mapping(bytes32 => Round) internal rounds;
    mapping(bytes32 => BandBucket[25]) internal bandBuckets;

    /// @notice Initializes the store with the deployer as owner and a nonzero updater.
    constructor(address initialUpdater) Ownable() {
        if (initialUpdater == address(0)) revert ZeroUpdater();
        updater = initialUpdater;
        emit UpdaterSet(address(0), initialUpdater);
    }

    /// @inheritdoc IFxRateStore
    function decimals() external pure override returns (uint8) {
        return 8;
    }

    /// @inheritdoc IFxRateStore
    function updateRates(bytes32[] calldata feedIds, uint64[] calldata answers, uint64 observedAt) external override {
        if (msg.sender != updater) revert NotUpdater(msg.sender);
        if (feedIds.length == 0) revert EmptyBatch();
        if (feedIds.length != answers.length) revert LengthMismatch(feedIds.length, answers.length);
        if (observedAt > block.timestamp) revert ObservedAtInFuture(observedAt);

        for (uint256 index = 0; index < feedIds.length; ++index) {
            bytes32 feedId = feedIds[index];
            FeedConfig storage config = feedConfigs[feedId];
            if (!config.registered) revert FeedNotRegistered(feedId);
            if (config.locked) revert FeedLocked(feedId);
            uint64 answer = answers[index];
            if (answer < config.minAnswer || answer > config.maxAnswer) revert AnswerOutOfLimits(feedId, answer);
            Round memory round = rounds[feedId];
            (bool available, uint64 lower, uint64 upper) = _band(feedId, config, round);
            if (!available || answer < lower || answer > upper) revert AnswerOutOfBand(feedId, answer, lower, upper);
            if (observedAt <= round.updatedAt) revert ObservationNotNewer(feedId, observedAt, round.updatedAt);

            uint64 nextRoundId = round.roundId + 1;
            rounds[feedId] = Round({answer: answer, updatedAt: observedAt, roundId: nextRoundId});
            uint256 currentHour = block.timestamp / BAND_BUCKET_SECONDS;
            BandBucket storage bucket = bandBuckets[feedId][currentHour % BAND_BUCKET_COUNT];
            uint64 minimum = round.answer < answer ? round.answer : answer;
            uint64 maximum = round.answer > answer ? round.answer : answer;
            if (bucket.hourIndex != currentHour || bucket.maxAnswer == 0) {
                bucket.hourIndex = uint32(currentHour);
                bucket.minAnswer = minimum;
                bucket.maxAnswer = maximum;
            } else {
                if (minimum < bucket.minAnswer) bucket.minAnswer = minimum;
                if (maximum > bucket.maxAnswer) bucket.maxAnswer = maximum;
            }
            config.latestIsSeed = false;
            emit AnswerUpdated(feedId, answer, nextRoundId, observedAt);
        }
    }

    /// @inheritdoc IFxRateStore
    function addFeed(bytes32 feedId, uint64 minAnswer, uint64 maxAnswer) external override onlyOwner {
        if (minAnswer == 0 || minAnswer > maxAnswer) revert InvalidLimits(minAnswer, maxAnswer);
        if (feedConfigs[feedId].registered) revert FeedAlreadyRegistered(feedId);
        feedConfigs[feedId] = FeedConfig({
            minAnswer: minAnswer, maxAnswer: maxAnswer, registered: true, locked: true, latestIsSeed: false
        });
        emit FeedAdded(feedId, minAnswer, maxAnswer);
    }

    /// @inheritdoc IFxRateStore
    function setFeedLimits(bytes32 feedId, uint64 minAnswer, uint64 maxAnswer) external override onlyOwner {
        if (minAnswer == 0 || minAnswer > maxAnswer) revert InvalidLimits(minAnswer, maxAnswer);
        FeedConfig storage config = feedConfigs[feedId];
        if (!config.registered) revert FeedNotRegistered(feedId);
        config.minAnswer = minAnswer;
        config.maxAnswer = maxAnswer;
        emit FeedLimitsSet(feedId, minAnswer, maxAnswer);
    }

    /// @inheritdoc IFxRateStore
    function seedFeed(bytes32 feedId, uint64 answer) external override onlyOwner {
        FeedConfig storage config = feedConfigs[feedId];
        if (!config.registered) revert FeedNotRegistered(feedId);
        if (answer < config.minAnswer || answer > config.maxAnswer) revert AnswerOutOfLimits(feedId, answer);
        uint64 nextRoundId = rounds[feedId].roundId + 1;
        uint64 updatedAt = uint64(block.timestamp);
        rounds[feedId] = Round({answer: answer, updatedAt: updatedAt, roundId: nextRoundId});
        delete bandBuckets[feedId];
        uint256 currentHour = block.timestamp / BAND_BUCKET_SECONDS;
        bandBuckets[feedId][currentHour % BAND_BUCKET_COUNT] =
            BandBucket({hourIndex: uint32(currentHour), minAnswer: answer, maxAnswer: answer});
        config.locked = false;
        config.latestIsSeed = true;
        emit FeedSeeded(feedId, answer, nextRoundId);
        emit AnswerUpdated(feedId, answer, nextRoundId, updatedAt);
    }

    /// @inheritdoc IFxRateStore
    function emergencyStop(bytes32[] calldata feedIds) external override onlyOwner {
        address previousUpdater = updater;
        emit UpdaterSet(previousUpdater, address(0));
        updater = address(0);
        for (uint256 index = 0; index < feedIds.length; ++index) {
            bytes32 feedId = feedIds[index];
            FeedConfig storage config = feedConfigs[feedId];
            if (!config.registered) revert FeedNotRegistered(feedId);
            Round storage round = rounds[feedId];
            round.answer = 0;
            round.updatedAt = 0;
            config.locked = true;
            config.latestIsSeed = false;
        }
        emit EmergencyStopped(previousUpdater, feedIds);
    }

    /// @inheritdoc IFxRateStore
    function setUpdater(address newUpdater) external override onlyOwner {
        if (newUpdater == address(0)) revert ZeroUpdater();
        address previousUpdater = updater;
        updater = newUpdater;
        emit UpdaterSet(previousUpdater, newUpdater);
    }

    /// @notice Always reverts to preserve owner access to seeding and emergency controls.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @inheritdoc IFxRateStore
    function latestRoundData(bytes32 feedId)
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory round = rounds[feedId];
        return
            (
                uint80(round.roundId),
                int256(uint256(round.answer)),
                round.updatedAt,
                round.updatedAt,
                uint80(round.roundId)
            );
    }

    /// @inheritdoc IFxRateStore
    function getFeedConfig(bytes32 feedId) external view override returns (FeedConfig memory) {
        return feedConfigs[feedId];
    }

    /// @inheritdoc IFxRateStore
    function getBand(bytes32 feedId) external view override returns (bool available, uint64 lower, uint64 upper) {
        FeedConfig memory config = feedConfigs[feedId];
        if (!config.registered || config.locked) return (false, 0, 0);
        return _band(feedId, config, rounds[feedId]);
    }

    function _band(bytes32 feedId, FeedConfig memory config, Round memory round)
        internal
        view
        returns (bool available, uint64 lower, uint64 upper)
    {
        uint256 currentHour = block.timestamp / BAND_BUCKET_SECONDS;
        uint256 low = type(uint256).max;
        uint256 high = 0;
        for (uint256 index = 0; index < BAND_BUCKET_COUNT; ++index) {
            BandBucket memory bucket = bandBuckets[feedId][index];
            if (bucket.maxAnswer != 0 && uint256(bucket.hourIndex) + 24 >= currentHour) {
                if (bucket.minAnswer < low) low = bucket.minAnswer;
                if (bucket.maxAnswer > high) high = bucket.maxAnswer;
            }
        }
        // The latest answer anchors even an outage longer than the bucket window.
        if (round.answer != 0) {
            if (round.answer < low) low = round.answer;
            if (round.answer > high) high = round.answer;
        }
        uint256 lowerBound = (high * BPS + (BPS + MAX_BAND_BPS) - 1) / (BPS + MAX_BAND_BPS);
        uint256 upperBound = low * (BPS + MAX_BAND_BPS) / BPS;
        if (lowerBound < config.minAnswer) lowerBound = config.minAnswer;
        if (upperBound > config.maxAnswer) upperBound = config.maxAnswer;
        return (lowerBound <= upperBound, uint64(lowerBound), uint64(upperBound));
    }
}
