// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {FxRateStore} from "contracts/oracles/FxRateStore.sol";
import {IFxRateStore} from "contracts/interfaces/IFxRateStore.sol";

contract FxRateStoreBandTest is Test {
    bytes32 internal constant INR = keccak256("INR/USD");
    bytes32 internal constant CNY = keccak256("CNY/USD");
    bytes32 internal constant WIDE = keccak256("WIDE/USD");
    uint256 internal constant START = 10_000 * 1 hours;
    FxRateStore internal store;
    address internal updater;

    function setUp() public {
        vm.warp(10_000 * 1 hours);
        updater = makeAddr("updater");
        store = new FxRateStore(updater);
        store.addFeed(INR, 800_000, 1_400_000);
        store.addFeed(CNY, 10_000_000, 20_000_000);
        store.addFeed(WIDE, 1, type(uint64).max);
        store.seedFeed(INR, 1_000_000);
        store.seedFeed(WIDE, 1_000_000);
    }

    function _update(bytes32 feedId, uint64 answer) internal {
        bytes32[] memory feedIds = new bytes32[](1);
        uint64[] memory answers = new uint64[](1);
        feedIds[0] = feedId;
        answers[0] = answer;
        vm.prank(updater);
        store.updateRates(feedIds, answers, uint64(block.timestamp));
    }

    function _write(bytes32 feedId, uint64 answer) internal {
        vm.warp(block.timestamp + 1);
        _update(feedId, answer);
    }

    function _assertBand(bytes32 feedId, bool expectedAvailable, uint64 expectedLower, uint64 expectedUpper)
        internal
        view
    {
        (bool available, uint64 lower, uint64 upper) = store.getBand(feedId);
        assertEq(available, expectedAvailable);
        assertEq(lower, expectedLower);
        assertEq(upper, expectedUpper);
    }

    function _rejectBand(uint64 answer, uint64 lower, uint64 upper) internal {
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.AnswerOutOfBand.selector, WIDE, answer, lower, upper));
        _update(WIDE, answer);
    }

    function test_BandEndpointsFromSeed() public view {
        _assertBand(WIDE, true, 952_381, 1_050_000);
    }

    function test_AcceptsExactUpperAndLowerEndpoints() public {
        _write(WIDE, 1_050_000);
        store = new FxRateStore(updater);
        store.addFeed(WIDE, 1, type(uint64).max);
        store.seedFeed(WIDE, 1_000_000);
        _write(WIDE, 952_381);
    }

    function test_RejectsOneUnitBeyondEitherEndpoint() public {
        _rejectBand(1_050_001, 952_381, 1_050_000);
        _rejectBand(952_380, 952_381, 1_050_000);
    }

    function test_BandUsesMinAndMaxAcrossWindow() public {
        _write(WIDE, 1_050_000);
        _assertBand(WIDE, true, 1_000_000, 1_050_000);
        _write(WIDE, 1_000_000);
        _write(WIDE, 1_000_001);
        _write(WIDE, 1_025_000);
        _write(WIDE, 1_050_000);
        _rejectBand(999_999, 1_000_000, 1_050_000);
    }

    function test_BucketRetentionStartOfHourWrite() public {
        vm.warp(START + 1);
        _update(WIDE, 1_050_000);
        vm.warp(START + 2);
        _update(WIDE, 1_000_000);
        _assertRetention();
    }

    function test_BucketRetentionEndOfHourWrite() public {
        vm.warp(START + 3597);
        _update(WIDE, 1_050_000);
        vm.warp(START + 3598);
        _update(WIDE, 1_000_000);
        _assertRetention();
    }

    function _assertRetention() internal {
        vm.warp(START + 1 hours);
        _update(WIDE, 1_000_000);
        vm.warp(START + 25 hours - 1);
        _assertBand(WIDE, true, 1_000_000, 1_050_000);
        vm.warp(START + 25 hours);
        _assertBand(WIDE, true, 952_381, 1_050_000);
    }

    function test_LatestAnswerAnchorsAfterLongGap() public {
        vm.warp(START + 30 hours);
        _assertBand(WIDE, true, 952_381, 1_050_000);
    }

    function test_FoldingBlocksDoubleStepAfterGap() public {
        vm.warp(START + 30 hours);
        _write(WIDE, 1_050_000);
        _rejectBand(1_102_500, 1_000_000, 1_050_000);
    }

    function test_SlotReuseResetsStaleBucket() public {
        _write(WIDE, 1_050_000);
        _write(WIDE, 1_000_000);
        vm.warp(START + 25 hours);
        _update(WIDE, 952_381);
        _assertBand(WIDE, true, 952_381, 1_000_000);
    }

    function test_SameHourWritesWidenOneBucket() public {
        _write(WIDE, 1_020_000);
        _write(WIDE, 980_000);
        _assertBand(WIDE, true, 971_429, 1_029_000);
    }

    function test_EarlyTimestampsDoNotUnderflow() public {
        vm.warp(3600 * 5);
        store = new FxRateStore(updater);
        store.addFeed(WIDE, 1, type(uint64).max);
        store.seedFeed(WIDE, 1_000_000);
        _assertBand(WIDE, true, 952_381, 1_050_000);
        _write(WIDE, 1_050_000);
        _assertBand(WIDE, true, 1_000_000, 1_050_000);
    }

    function test_GetBandUnavailableForLockedUnregisteredAndNonOverlappingLimits() public {
        _assertBand(keccak256("UNKNOWN/USD"), false, 0, 0);
        _assertBand(CNY, false, 0, 0);
        store.setFeedLimits(WIDE, 2_000_000, 3_000_000);
        _assertBand(WIDE, false, 2_000_000, 1_050_000);
        _rejectBand(2_000_000, 2_000_000, 1_050_000);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.AnswerOutOfLimits.selector, WIDE, uint64(1_000_000)));
        _update(WIDE, 1_000_000);
    }

    function test_SeedFeedResetsBandOnLiveFeed() public {
        _write(WIDE, 1_050_000);
        // Populate another slot so reseeding must clear history beyond the current bucket.
        vm.warp(START + 1 hours);
        _update(WIDE, 1_050_000);
        store.seedFeed(WIDE, 1_200_000);
        _assertBand(WIDE, true, 1_142_858, 1_260_000);
        _write(WIDE, 1_260_000);
    }

    function test_SeedEpochResetIsIntentional() public {
        _write(WIDE, 1_000_000);
        store.seedFeed(WIDE, 1_050_000);
        _write(WIDE, 1_102_500);
        _assertBand(WIDE, true, 1_050_000, 1_102_500);
    }

    function test_LimitsNearUint64MaxDoNotOverflow() public {
        bytes32 huge = keccak256("HUGE/USD");
        uint64 seed = type(uint64).max - 1;
        store.addFeed(huge, 1, type(uint64).max);
        store.seedFeed(huge, seed);
        uint64 expectedLower = uint64((uint256(seed) * 10_000 + 10_499) / 10_500);
        _assertBand(huge, true, expectedLower, type(uint64).max);
        _write(huge, type(uint64).max);
    }

    function testFuzz_GetBandMatchesUpdateRates(uint64 answer, uint16 warpMinutes) public {
        warpMinutes = uint16(bound(warpMinutes, 1, 3000));
        answer = uint64(bound(answer, 1, 3_000_000));
        vm.warp(START + uint256(warpMinutes) * 1 minutes);
        (bool available, uint64 lower, uint64 upper) = store.getBand(WIDE);
        if (available && lower <= answer && answer <= upper) {
            _write(WIDE, answer);
            (, int256 actual,,,) = store.latestRoundData(WIDE);
            assertEq(actual, int256(uint256(answer)));
        } else {
            _rejectBand(answer, lower, upper);
        }
    }
}
