// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {FxRateFeed} from "contracts/oracles/FxRateFeed.sol";
import {FxRateStore} from "contracts/oracles/FxRateStore.sol";
import {AggregatorV3Mock} from "contracts/mocks/AggregatorV3Mock.sol";

contract FxRateFeedTest is Test {
    bytes32 internal constant INR = keccak256("INR/USD");
    bytes32 internal constant CNY = keccak256("CNY/USD");
    FxRateStore internal store;
    FxRateStore internal store2;
    FxRateFeed internal feed;
    AggregatorV3Mock internal ext;

    event SourceUpdated(address indexed source, bytes32 indexed sourceFeedId);

    function setUp() public {
        vm.warp(1_000_000);
        address updater = makeAddr("updater");
        store = new FxRateStore(updater);
        store.addFeed(INR, 800_000, 1_400_000);
        store.seedFeed(INR, 1_041_667);
        store2 = new FxRateStore(updater);
        store2.addFeed(INR, 800_000, 1_400_000);
        store2.seedFeed(INR, 1_040_000);
        feed = new FxRateFeed(address(store), INR, "INR / USD");
        ext = new AggregatorV3Mock(8, 1_043_000);
    }

    function test_MetadataMatchesChainlinkShape() public view {
        assertEq(feed.decimals(), 8);
        assertEq(feed.version(), 1);
        assertEq(feed.description(), "INR / USD");
        assertEq(feed.source(), address(store));
        assertEq(feed.sourceFeedId(), INR);
        assertEq(feed.owner(), address(this));
    }

    function test_ConstructorRejectsZeroStoreAndZeroFeedId() public {
        vm.expectRevert(FxRateFeed.ZeroSource.selector);
        new FxRateFeed(address(0), INR, "INR / USD");
        vm.expectRevert(FxRateFeed.ZeroFeedId.selector);
        new FxRateFeed(address(store), bytes32(0), "INR / USD");
    }

    function test_LatestRoundDataPassesStoreTuple() public view {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            store.latestRoundData(INR);
        _assertLatest(feed, roundId, answer, startedAt, updatedAt, answeredInRound);
        assertEq(answeredInRound, roundId);
    }

    function test_ZeroTupleBeforeSeedAndAfterStop() public {
        store.addFeed(CNY, 10_000_000, 20_000_000);
        FxRateFeed unseeded = new FxRateFeed(address(store), CNY, "CNY / USD");
        _assertLatest(unseeded, 0, 0, 0, 0, 0);
        bytes32[] memory feedIds = new bytes32[](1);
        feedIds[0] = INR;
        store.emergencyStop(feedIds);
        _assertLatest(feed, 1, 0, 0, 0, 1);
    }

    function test_SetSourceToExternalAggregatorPassesTupleUnchanged() public {
        vm.expectEmit(true, true, false, true, address(feed));
        emit SourceUpdated(address(ext), bytes32(0));
        feed.setSource(address(ext), bytes32(0));
        assertEq(feed.source(), address(ext));
        assertEq(feed.sourceFeedId(), bytes32(0));
        uint256 timestamp = vm.getBlockTimestamp();
        ext.setRoundData(5, 1_050_000, timestamp, timestamp, 4);
        _assertLatest(feed, 5, 1_050_000, timestamp, timestamp, 4);
        // Distinct timestamps ensure the facade never substitutes updatedAt for startedAt.
        ext.setRoundData(6, 1_049_000, timestamp - 60, timestamp, 7);
        _assertLatest(feed, 6, 1_049_000, timestamp - 60, timestamp, 7);
    }

    function test_SetSourceToReplacementStore() public {
        vm.expectEmit(true, true, false, true, address(feed));
        emit SourceUpdated(address(store2), INR);
        feed.setSource(address(store2), INR);
        assertEq(feed.source(), address(store2));
        assertEq(feed.sourceFeedId(), INR);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            store2.latestRoundData(INR);
        _assertLatest(feed, roundId, answer, startedAt, updatedAt, answeredInRound);
    }

    function test_SetSourceRejects() public {
        vm.expectRevert(FxRateFeed.ZeroSource.selector);
        feed.setSource(address(0), INR);
        AggregatorV3Mock wrongDecimals = new AggregatorV3Mock(18, 1_043_000);
        vm.expectRevert(abi.encodeWithSelector(FxRateFeed.UnsupportedDecimals.selector, uint8(18)));
        feed.setSource(address(wrongDecimals), bytes32(0));
        _rejectExternalRound(5, 0, vm.getBlockTimestamp(), 5);
        _rejectExternalRound(5, -1, vm.getBlockTimestamp(), 5);
        _rejectExternalRound(5, 1_043_000, 0, 5);
        _rejectExternalRound(5, 1_043_000, vm.getBlockTimestamp() + 1, 5);
        _rejectExternalRound(5, 1_043_000, vm.getBlockTimestamp() - 1 days - 1, 5);
        _rejectExternalRound(5, 1_043_000, vm.getBlockTimestamp(), 4);
        store2.addFeed(CNY, 10_000_000, 20_000_000);
        vm.expectRevert(
            abi.encodeWithSelector(FxRateFeed.UnusableSourceRound.selector, uint80(0), int256(0), uint256(0), uint80(0))
        );
        feed.setSource(address(store2), CNY);
        assertEq(feed.source(), address(store));
        assertEq(feed.sourceFeedId(), INR);
        _assertLatest(feed, 1, 1_041_667, 1_000_000, 1_000_000, 1);
        // The inclusive one-day boundary is usable.
        ext.setRoundData(5, 1_043_000, vm.getBlockTimestamp() - 1 days, vm.getBlockTimestamp() - 1 days, 5);
        feed.setSource(address(ext), bytes32(0));
        _assertLatest(feed, 5, 1_043_000, vm.getBlockTimestamp() - 1 days, vm.getBlockTimestamp() - 1 days, 5);
    }

    function test_SetSourceIsOwnerOnly() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("Ownable: caller is not the owner");
        feed.setSource(address(ext), bytes32(0));
        assertEq(feed.source(), address(store));
        assertEq(feed.sourceFeedId(), INR);
    }

    function test_GetRoundDataServesLatestOnly() public {
        _assertGetRound(1, 1_041_667, 1_000_000, 1_000_000, 1);
        feed.setSource(address(ext), bytes32(0));
        ext.setRoundData(5, 1_050_000, vm.getBlockTimestamp() - 60, vm.getBlockTimestamp(), 4);
        _assertGetRound(5, 1_050_000, vm.getBlockTimestamp() - 60, vm.getBlockTimestamp(), 4);
    }

    function _assertLatest(
        FxRateFeed target,
        uint80 expectedId,
        int256 expectedAnswer,
        uint256 expectedStart,
        uint256 expectedUpdate,
        uint80 expectedAnsweredInRound
    ) internal view {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            target.latestRoundData();
        assertEq(roundId, expectedId);
        assertEq(answer, expectedAnswer);
        assertEq(startedAt, expectedStart);
        assertEq(updatedAt, expectedUpdate);
        assertEq(answeredInRound, expectedAnsweredInRound);
    }

    function _rejectExternalRound(uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound) internal {
        ext.setRoundData(roundId, answer, vm.getBlockTimestamp(), updatedAt, answeredInRound);
        vm.expectRevert(
            abi.encodeWithSelector(FxRateFeed.UnusableSourceRound.selector, roundId, answer, updatedAt, answeredInRound)
        );
        feed.setSource(address(ext), bytes32(0));
        assertEq(feed.source(), address(store));
        assertEq(feed.sourceFeedId(), INR);
    }

    function _assertGetRound(
        uint80 expectedId,
        int256 expectedAnswer,
        uint256 expectedStart,
        uint256 expectedUpdate,
        uint80 expectedAnsweredInRound
    ) internal {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.getRoundData(expectedId);
        assertEq(roundId, expectedId);
        assertEq(answer, expectedAnswer);
        assertEq(startedAt, expectedStart);
        assertEq(updatedAt, expectedUpdate);
        assertEq(answeredInRound, expectedAnsweredInRound);
        vm.expectRevert(abi.encodeWithSelector(FxRateFeed.NoDataPresent.selector, expectedId - 1));
        feed.getRoundData(expectedId - 1);
        vm.expectRevert(abi.encodeWithSelector(FxRateFeed.NoDataPresent.selector, expectedId + 1));
        feed.getRoundData(expectedId + 1);
    }
}
