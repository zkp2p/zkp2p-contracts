// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {FxRateStore} from "contracts/oracles/FxRateStore.sol";
import {IFxRateStore} from "contracts/interfaces/IFxRateStore.sol";

contract FxRateStoreTest is Test {
    bytes32 internal constant INR = keccak256("INR/USD");
    bytes32 internal constant CNY = keccak256("CNY/USD");
    bytes32 internal constant UNKNOWN = keccak256("UNKNOWN/USD");
    FxRateStore internal store;
    address internal owner;
    address internal updater;

    event UpdaterSet(address indexed previousUpdater, address indexed newUpdater);
    event FeedAdded(bytes32 indexed feedId, uint64 minAnswer, uint64 maxAnswer);
    event FeedLimitsSet(bytes32 indexed feedId, uint64 minAnswer, uint64 maxAnswer);
    event FeedSeeded(bytes32 indexed feedId, uint64 answer, uint64 roundId);
    event AnswerUpdated(bytes32 indexed feedId, uint64 answer, uint64 indexed roundId, uint64 updatedAt);
    event EmergencyStopped(address indexed previousUpdater, bytes32[] feedIds);

    function setUp() public {
        vm.warp(1_000_000);
        owner = address(this);
        updater = makeAddr("updater");
        store = new FxRateStore(updater);
        store.addFeed(INR, 800_000, 1_400_000);
        store.addFeed(CNY, 10_000_000, 20_000_000);
    }

    function _ids(bytes32 feedId) internal pure returns (bytes32[] memory feedIds) {
        feedIds = new bytes32[](1);
        feedIds[0] = feedId;
    }

    function _answers(uint64 answer) internal pure returns (uint64[] memory answers) {
        answers = new uint64[](1);
        answers[0] = answer;
    }

    function _pair() internal pure returns (bytes32[] memory feedIds, uint64[] memory answers) {
        feedIds = new bytes32[](2);
        feedIds[0] = INR;
        feedIds[1] = CNY;
        answers = new uint64[](2);
        answers[0] = 1_040_000;
        answers[1] = 14_880_000;
    }

    function _seedBoth() internal {
        store.seedFeed(INR, 1_041_667);
        store.seedFeed(CNY, 14_880_952);
    }

    function _assertRound(bytes32 feedId, uint80 expectedId, uint64 expectedAnswer, uint64 expectedTime) internal view {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            store.latestRoundData(feedId);
        assertEq(roundId, expectedId);
        assertEq(answer, int256(uint256(expectedAnswer)));
        assertEq(startedAt, expectedTime);
        assertEq(updatedAt, expectedTime);
        assertEq(answeredInRound, expectedId);
    }

    function _assertConfig(bytes32 feedId, uint64 minimum, uint64 maximum, bool locked, bool isSeed) internal view {
        IFxRateStore.FeedConfig memory config = store.getFeedConfig(feedId);
        assertEq(config.minAnswer, minimum);
        assertEq(config.maxAnswer, maximum);
        assertTrue(config.registered);
        assertEq(config.locked, locked);
        assertEq(config.latestIsSeed, isSeed);
    }

    function test_ConstructorSetsUpdaterAndDecimals() public {
        vm.expectEmit(true, true, false, true);
        emit UpdaterSet(address(0), updater);
        FxRateStore fresh = new FxRateStore(updater);
        assertEq(fresh.updater(), updater);
        assertEq(fresh.decimals(), 8);
        assertEq(fresh.owner(), owner);
    }

    function test_ConstructorRejectsZeroUpdater() public {
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.ZeroUpdater.selector));
        new FxRateStore(address(0));
    }

    function test_AddFeedStartsLockedAndUnseeded() public {
        _assertConfig(INR, 800_000, 1_400_000, true, false);
        _assertRound(INR, 0, 0, 0);
        _assertRound(UNKNOWN, 0, 0, 0);
        vm.expectEmit(true, false, false, true, address(store));
        emit FeedAdded(UNKNOWN, 1, 2);
        store.addFeed(UNKNOWN, 1, 2);
        _assertConfig(UNKNOWN, 1, 2, true, false);
    }

    function test_AddFeedRejectsInvalidLimits() public {
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.InvalidLimits.selector, uint64(0), uint64(1)));
        store.addFeed(UNKNOWN, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.InvalidLimits.selector, uint64(2), uint64(1)));
        store.addFeed(UNKNOWN, 2, 1);
    }

    function test_AddFeedRejectsDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.FeedAlreadyRegistered.selector, INR));
        store.addFeed(INR, 800_000, 1_400_000);
    }

    function test_AdminFunctionsAreOwnerOnly() public {
        vm.startPrank(makeAddr("stranger"));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        store.addFeed(UNKNOWN, 1, 2);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        store.setFeedLimits(INR, 1, 2);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        store.seedFeed(INR, 1_041_667);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        store.emergencyStop(_ids(INR));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        store.setUpdater(updater);
        vm.stopPrank();
    }

    function test_RenounceOwnershipReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.RenounceDisabled.selector));
        store.renounceOwnership();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.RenounceDisabled.selector));
        store.renounceOwnership();
        assertEq(store.owner(), owner);
    }

    function test_SeedFeedUnlocksAndWritesRound() public {
        vm.expectEmit(true, false, false, true, address(store));
        emit FeedSeeded(INR, 1_041_667, 1);
        vm.expectEmit(true, true, false, true, address(store));
        emit AnswerUpdated(INR, 1_041_667, 1, 1_000_000);
        store.seedFeed(INR, 1_041_667);
        _assertRound(INR, 1, 1_041_667, 1_000_000);
        _assertConfig(INR, 800_000, 1_400_000, false, true);
    }

    function test_SeedFeedRejectsUnregisteredAndOutOfLimits() public {
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.FeedNotRegistered.selector, UNKNOWN));
        store.seedFeed(UNKNOWN, 1);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.AnswerOutOfLimits.selector, INR, uint64(799_999)));
        store.seedFeed(INR, 799_999);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.AnswerOutOfLimits.selector, INR, uint64(1_400_001)));
        store.seedFeed(INR, 1_400_001);
    }

    function test_UpdateRatesWritesBatchAndClearsSeedFlag() public {
        _seedBoth();
        vm.warp(block.timestamp + 1 hours);
        uint64 observedAt = uint64(block.timestamp - 60);
        (bytes32[] memory feedIds, uint64[] memory answers) = _pair();
        vm.expectEmit(true, true, false, true, address(store));
        emit AnswerUpdated(INR, answers[0], 2, observedAt);
        vm.expectEmit(true, true, false, true, address(store));
        emit AnswerUpdated(CNY, answers[1], 2, observedAt);
        vm.prank(updater);
        store.updateRates(feedIds, answers, observedAt);
        _assertRound(INR, 2, answers[0], observedAt);
        _assertRound(CNY, 2, answers[1], observedAt);
        _assertConfig(INR, 800_000, 1_400_000, false, false);
        _assertConfig(CNY, 10_000_000, 20_000_000, false, false);
    }

    function test_UpdateRatesRejectsNonUpdater() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.NotUpdater.selector, stranger));
        store.updateRates(_ids(INR), _answers(1_040_000), 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.NotUpdater.selector, owner));
        store.updateRates(_ids(INR), _answers(1_040_000), 1_000_000);
    }

    function test_UpdateRatesRejectsEmptyAndMismatched() public {
        vm.startPrank(updater);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.EmptyBatch.selector));
        store.updateRates(new bytes32[](0), new uint64[](0), 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.LengthMismatch.selector, uint256(2), uint256(1)));
        store.updateRates(new bytes32[](2), _answers(1), 1_000_000);
        vm.stopPrank();
    }

    function test_UpdateRatesRejectsUnregisteredAndLocked() public {
        vm.startPrank(updater);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.FeedLocked.selector, INR));
        store.updateRates(_ids(INR), _answers(1_040_000), 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.FeedNotRegistered.selector, UNKNOWN));
        store.updateRates(_ids(UNKNOWN), _answers(1_040_000), 1_000_000);
        vm.stopPrank();
    }

    function test_UpdateRatesRejectsOutOfLimits() public {
        store.seedFeed(INR, 1_041_667);
        vm.warp(block.timestamp + 1);
        vm.startPrank(updater);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.AnswerOutOfLimits.selector, INR, uint64(799_999)));
        store.updateRates(_ids(INR), _answers(799_999), uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.AnswerOutOfLimits.selector, INR, uint64(1_400_001)));
        store.updateRates(_ids(INR), _answers(1_400_001), uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_UpdateRatesRejectsFutureAndNonNewerObservation() public {
        store.seedFeed(INR, 1_041_667);
        vm.startPrank(updater);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.ObservedAtInFuture.selector, uint64(1_000_001)));
        store.updateRates(_ids(INR), _answers(1_040_000), 1_000_001);
        vm.expectRevert(
            abi.encodeWithSelector(IFxRateStore.ObservationNotNewer.selector, INR, uint64(1_000_000), uint64(1_000_000))
        );
        store.updateRates(_ids(INR), _answers(1_040_000), 1_000_000);
        vm.expectRevert(
            abi.encodeWithSelector(IFxRateStore.ObservationNotNewer.selector, INR, uint64(999_999), uint64(1_000_000))
        );
        store.updateRates(_ids(INR), _answers(1_040_000), 999_999);
        vm.stopPrank();
    }

    function test_UpdateRatesIsAtomic() public {
        _seedBoth();
        vm.warp(block.timestamp + 1);
        (bytes32[] memory feedIds, uint64[] memory answers) = _pair();
        answers[1] = 20_000_001;
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.AnswerOutOfLimits.selector, CNY, answers[1]));
        store.updateRates(feedIds, answers, uint64(block.timestamp));
        _assertRound(INR, 1, 1_041_667, 1_000_000);
        _assertRound(CNY, 1, 14_880_952, 1_000_000);
        assertTrue(store.getFeedConfig(INR).latestIsSeed);
    }

    function test_UpdateRatesRejectsDuplicateFeedInBatch() public {
        store.seedFeed(INR, 1_041_667);
        vm.warp(block.timestamp + 1);
        (bytes32[] memory feedIds, uint64[] memory answers) = _pair();
        feedIds[1] = INR;
        answers[1] = answers[0];
        uint64 observedAt = uint64(block.timestamp);
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.ObservationNotNewer.selector, INR, observedAt, observedAt));
        store.updateRates(feedIds, answers, observedAt);
        _assertRound(INR, 1, 1_041_667, 1_000_000);
        assertTrue(store.getFeedConfig(INR).latestIsSeed);
    }

    function test_EmergencyStopDisablesUpdaterAndLocksFeeds() public {
        _seedBoth();
        vm.warp(block.timestamp + 1);
        (bytes32[] memory feedIds, uint64[] memory answers) = _pair();
        vm.prank(updater);
        store.updateRates(feedIds, answers, 1_000_001);
        vm.expectEmit(true, true, false, true, address(store));
        emit UpdaterSet(updater, address(0));
        vm.expectEmit(true, false, false, true, address(store));
        emit EmergencyStopped(updater, _ids(INR));
        store.emergencyStop(_ids(INR));
        assertEq(store.updater(), address(0));
        _assertRound(INR, 2, 0, 0);
        _assertConfig(INR, 800_000, 1_400_000, true, false);
        _assertRound(CNY, 2, 14_880_000, 1_000_001);
        _assertConfig(CNY, 10_000_000, 20_000_000, false, false);
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.NotUpdater.selector, updater));
        store.updateRates(feedIds, answers, 1_000_001);
    }

    function test_EmergencyStopEmptyListOnlyDisablesUpdater() public {
        _seedBoth();
        bytes32[] memory feedIds = new bytes32[](0);
        vm.expectEmit(true, true, false, true, address(store));
        emit UpdaterSet(updater, address(0));
        vm.expectEmit(true, false, false, true, address(store));
        emit EmergencyStopped(updater, feedIds);
        store.emergencyStop(feedIds);
        assertEq(store.updater(), address(0));
        _assertRound(INR, 1, 1_041_667, 1_000_000);
        _assertRound(CNY, 1, 14_880_952, 1_000_000);
        _assertConfig(INR, 800_000, 1_400_000, false, true);
        _assertConfig(CNY, 10_000_000, 20_000_000, false, true);
    }

    function test_EmergencyStopRejectsUnregisteredAtomically() public {
        _seedBoth();
        (bytes32[] memory feedIds,) = _pair();
        feedIds[1] = UNKNOWN;
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.FeedNotRegistered.selector, UNKNOWN));
        store.emergencyStop(feedIds);
        assertEq(store.updater(), updater);
        _assertRound(INR, 1, 1_041_667, 1_000_000);
        _assertConfig(INR, 800_000, 1_400_000, false, true);
    }

    function test_RecoveryAfterStopViaSetUpdaterAndSeed() public {
        store.seedFeed(INR, 1_041_667);
        store.emergencyStop(_ids(INR));
        address newUpdater = makeAddr("newUpdater");
        vm.expectEmit(true, true, false, true, address(store));
        emit UpdaterSet(address(0), newUpdater);
        store.setUpdater(newUpdater);
        store.seedFeed(INR, 1_040_000);
        _assertRound(INR, 2, 1_040_000, 1_000_000);
        vm.warp(block.timestamp + 1);
        vm.prank(newUpdater);
        store.updateRates(_ids(INR), _answers(1_040_001), 1_000_001);
        _assertRound(INR, 3, 1_040_001, 1_000_001);
        _assertConfig(INR, 800_000, 1_400_000, false, false);
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.NotUpdater.selector, updater));
        store.updateRates(_ids(INR), _answers(1_040_001), 1_000_001);
    }

    function test_SetUpdaterRejectsZero() public {
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.ZeroUpdater.selector));
        store.setUpdater(address(0));
        assertEq(store.updater(), updater);
        address newUpdater = makeAddr("newUpdater");
        vm.expectEmit(true, true, false, true, address(store));
        emit UpdaterSet(updater, newUpdater);
        store.setUpdater(newUpdater);
        assertEq(store.updater(), newUpdater);
    }

    function test_SetFeedLimitsValidates() public {
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.FeedNotRegistered.selector, UNKNOWN));
        store.setFeedLimits(UNKNOWN, 1, 2);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.InvalidLimits.selector, uint64(0), uint64(1)));
        store.setFeedLimits(INR, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IFxRateStore.InvalidLimits.selector, uint64(2), uint64(1)));
        store.setFeedLimits(INR, 2, 1);
        store.seedFeed(INR, 1_041_667);
        vm.expectEmit(true, false, false, true, address(store));
        emit FeedLimitsSet(INR, 900_000, 1_300_000);
        store.setFeedLimits(INR, 900_000, 1_300_000);
        _assertConfig(INR, 900_000, 1_300_000, false, true);
        _assertRound(INR, 1, 1_041_667, 1_000_000);
    }
}
