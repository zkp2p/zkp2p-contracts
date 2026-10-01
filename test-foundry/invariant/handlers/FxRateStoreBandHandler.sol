// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {FxRateStore} from "contracts/oracles/FxRateStore.sol";

contract FxRateStoreBandHandler is Test {
    struct DisplayEntry {
        uint64 start;
        uint64 answer;
        uint32 epoch;
        bool isSeed;
    }

    bytes32 public constant FEED_ID = keccak256("FX_BAND_INVARIANT");
    FxRateStore public immutable store;
    DisplayEntry[] public displayLog;
    uint32 public epoch;

    constructor() {
        store = new FxRateStore(address(this));
        store.addFeed(FEED_ID, 1, type(uint64).max);
        store.seedFeed(FEED_ID, 1_000_000);
        displayLog.push(DisplayEntry(uint64(vm.getBlockTimestamp()), 1_000_000, epoch, true));
    }

    function warp(uint256 rawSeconds) external {
        // Exercise expired buckets as well as short gaps and hour boundaries.
        uint256 elapsed =
            rawSeconds % 4 == 0 ? bound(rawSeconds, 25 hours + 1, 30 hours) : bound(rawSeconds, 1, 30 hours);
        vm.warp(vm.getBlockTimestamp() + elapsed);
    }

    function write(uint256 rawAnswer) external {
        (bool available, uint64 lower, uint64 upper) = store.getBand(FEED_ID);
        if (!available) return;
        uint256 answer = bound(rawAnswer, uint256(lower) - lower / 20, uint256(upper) + upper / 20);
        // Hit accepted extremes often enough to expose cumulative band drift.
        if (rawAnswer % 4 == 0) answer = lower;
        else if (rawAnswer % 4 == 1) answer = upper;

        bytes32[] memory feedIds = new bytes32[](1);
        feedIds[0] = FEED_ID;
        uint64[] memory answers = new uint64[](1);
        answers[0] = uint64(answer);
        try store.updateRates(feedIds, answers, uint64(vm.getBlockTimestamp())) {
            displayLog.push(DisplayEntry(uint64(vm.getBlockTimestamp()), uint64(answer), epoch, false));
        } catch {
            // Out-of-band candidates and writes at the same timestamp are expected.
        }
    }

    function seed(uint256 rawAnswer) external {
        if (rawAnswer % 20 != 0) return;
        uint64 answer = uint64(bound(rawAnswer, 500_000, 2_000_000));
        store.seedFeed(FEED_ID, answer);
        ++epoch;
        displayLog.push(DisplayEntry(uint64(vm.getBlockTimestamp()), answer, epoch, true));
    }

    function logLength() external view returns (uint256) {
        return displayLog.length;
    }

    function checkDisplayedBand() external view returns (bool) {
        for (uint256 writeIndex = 0; writeIndex < displayLog.length; ++writeIndex) {
            DisplayEntry memory written = displayLog[writeIndex];
            if (written.isSeed) continue;
            uint256 cutoff = written.start > 24 hours ? written.start - 24 hours : 0;
            for (uint256 priorIndex = 0; priorIndex < writeIndex; ++priorIndex) {
                DisplayEntry memory prior = displayLog[priorIndex];
                if (prior.epoch != written.epoch || displayLog[priorIndex + 1].start < cutoff) continue;
                uint256 minimum = prior.answer < written.answer ? prior.answer : written.answer;
                uint256 maximum = prior.answer > written.answer ? prior.answer : written.answer;
                if (maximum * 10_000 > minimum * 10_500) return false;
            }
        }
        return true;
    }
}
