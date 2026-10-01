// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @title IFxRateStore
/// @notice Shared store for eight-decimal USD prices per unit of fiat.
interface IFxRateStore {
    /// @notice Limits, registration, admission status and provenance of the latest round.
    struct FeedConfig {
        uint64 minAnswer;
        uint64 maxAnswer;
        bool registered;
        bool locked;
        bool latestIsSeed;
    }

    /// @notice Emitted when the updater changes; zero disables updates.
    event UpdaterSet(address indexed previousUpdater, address indexed newUpdater);
    /// @notice Emitted when a feed is registered in a locked state.
    event FeedAdded(bytes32 indexed feedId, uint64 minAnswer, uint64 maxAnswer);
    /// @notice Emitted when the owner changes a feed's inclusive limits.
    event FeedLimitsSet(bytes32 indexed feedId, uint64 minAnswer, uint64 maxAnswer);
    /// @notice Emitted when the owner seeds and unlocks a feed.
    event FeedSeeded(bytes32 indexed feedId, uint64 answer, uint64 roundId);
    /// @notice Emitted for each seed or updater round.
    event AnswerUpdated(bytes32 indexed feedId, uint64 answer, uint64 indexed roundId, uint64 updatedAt);
    /// @notice Emitted when updates are disabled and the listed feeds are locked.
    event EmergencyStopped(address indexed previousUpdater, bytes32[] feedIds);

    /// @notice The caller is not the configured updater.
    error NotUpdater(address caller);
    /// @notice An updater assignment cannot use the zero address.
    error ZeroUpdater();
    /// @notice An update batch must contain at least one feed.
    error EmptyBatch();
    /// @notice Feed and answer array lengths differ.
    error LengthMismatch(uint256 feedIds, uint256 answers);
    /// @notice The requested feed has not been registered.
    error FeedNotRegistered(bytes32 feedId);
    /// @notice The requested feed is already registered.
    error FeedAlreadyRegistered(bytes32 feedId);
    /// @notice The feed must be seeded before accepting updater writes.
    error FeedLocked(bytes32 feedId);
    /// @notice Limits must satisfy zero < minimum <= maximum.
    error InvalidLimits(uint64 minAnswer, uint64 maxAnswer);
    /// @notice The answer is outside the feed's inclusive limits.
    error AnswerOutOfLimits(bytes32 feedId, uint64 answer);
    /// @notice The answer is outside the available rolling band.
    error AnswerOutOfBand(bytes32 feedId, uint64 answer, uint64 lower, uint64 upper);
    /// @notice The provider observation is later than the current block.
    error ObservedAtInFuture(uint64 observedAt);
    /// @notice The provider observation must be strictly newer than the latest round.
    error ObservationNotNewer(bytes32 feedId, uint64 observedAt, uint64 updatedAt);
    /// @notice Ownership cannot be renounced.
    error RenounceDisabled();

    /// @notice Returns the fixed answer precision of eight decimals.
    function decimals() external pure returns (uint8);
    /// @notice Returns the authorized updater, or zero when updates are disabled.
    function updater() external view returns (address);
    /// @notice Atomically publishes answers for registered, unlocked feeds as the updater.
    /// @param feedIds Feed identifiers, conventionally keccak256 of the pair (e.g. "INR/USD").
    /// @param answers Eight-decimal answers corresponding to feedIds.
    /// @param observedAt Provider observation time, strictly newer per feed and not in the future.
    function updateRates(bytes32[] calldata feedIds, uint64[] calldata answers, uint64 observedAt) external;
    /// @notice Registers a locked feed with positive inclusive limits; owner only.
    function addFeed(bytes32 feedId, uint64 minAnswer, uint64 maxAnswer) external;
    /// @notice Changes inclusive limits without changing the latest round; owner only.
    function setFeedLimits(bytes32 feedId, uint64 minAnswer, uint64 maxAnswer) external;
    /// @notice Publishes an in-limit seed at block time and unlocks the feed; owner only.
    function seedFeed(bytes32 feedId, uint64 answer) external;
    /// @notice Disables the updater and clears prices/timestamps of listed feeds, retaining round ids; owner only.
    /// @dev An empty list only disables updates. An unregistered id reverts the whole call.
    function emergencyStop(bytes32[] calldata feedIds) external;
    /// @notice Assigns a nonzero updater; owner only.
    function setUpdater(address newUpdater) external;
    /// @notice Returns the latest Chainlink-shaped tuple, with both timestamps equal and answeredInRound = roundId.
    /// @dev Unknown feeds return all zeros; stopped feeds retain round ids but have zero answer and timestamps.
    function latestRoundData(bytes32 feedId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    /// @notice Returns stored configuration; unknown feeds return the zero-valued struct.
    function getFeedConfig(bytes32 feedId) external view returns (FeedConfig memory);
    /// @notice Returns band availability and inclusive bounds, excluding observation-time eligibility.
    function getBand(bytes32 feedId) external view returns (bool available, uint64 lower, uint64 upper);
}
