// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IReputationRegistry
 * @notice Mutable protocol reputation state updated by authorized lifecycle reporters.
 */
interface IReputationRegistry {
    struct Profile {
        int256 score;
        uint256 successfulVolume;
        uint64 successfulInteractions;
        uint64 abandonedIntents;
        uint64 chargebacks;
    }

    function getProfile(address account) external view returns (Profile memory);
    function getScore(address account) external view returns (int256);
    function recordSuccess(address taker, address maker, uint256 amount) external;
    function recordAbandonment(address taker, uint256 amount, bool expired) external;
    function recordChargeback(address taker, uint256 previousAmount, uint256 newCumulativeAmount) external;
}
