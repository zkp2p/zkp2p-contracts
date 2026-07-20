// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { StakeVault } from "../../contracts/StakeVault.sol";
import { IIntentRiskHook } from "../../contracts/interfaces/IIntentRiskHook.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";

contract StakeVaultTest is Test {
    uint64 internal constant DAY = 1 days;
    uint64 internal constant EXIT_DELAY = 30 days;

    address internal owner = makeAddr("owner");
    address internal controller = makeAddr("controller");
    address internal staker = makeAddr("staker");
    address internal maker = makeAddr("maker");
    address internal recipient = makeAddr("recipient");

    USDCMock internal token;
    StakeVault internal vault;

    function setUp() public {
        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        vault = new StakeVault(owner, token, controller, EXIT_DELAY, DAY);

        deal(address(token), staker, 10_000e6);
        vm.prank(staker);
        token.approve(address(vault), type(uint256).max);
    }

    function test_DepositStakeTracksLiabilities() public {
        vm.prank(staker);
        vault.depositStake(1_000e6);

        assertEq(vault.stakeBalance(staker), 1_000e6);
        assertEq(vault.totalLiabilities(), 1_000e6);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    function test_DepositStakeForKeepsStakeOwnedByDepositor() public {
        vm.prank(staker);
        vault.depositStakeFor(maker, 1_000e6);

        assertEq(vault.stakeOwnerOf(maker), staker);
        assertEq(vault.stakeBalance(staker), 1_000e6);
        assertEq(vault.stakeBalance(maker), 0);
    }

    function test_SecondStakeOwnerCannotReplaceTakerAuthorization() public {
        address otherStakeOwner = makeAddr("otherStakeOwner");
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.TakerAlreadyAuthorized.selector, maker, staker)
        );
        vm.prank(otherStakeOwner);
        vault.setTakerAuthorization(maker, true);
    }

    function test_TakerCanClearDelegatedStakeOwner() public {
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);

        vm.prank(maker);
        vault.clearStakeOwner();

        assertEq(vault.stakeOwnerOf(maker), maker);
        assertFalse(vault.stakeDelegationEnabled(maker));
    }

    function test_ForcedReassignmentFailsAfterTakerClearsStakeOwner() public {
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);

        vm.prank(maker);
        vault.clearStakeOwner();

        vm.expectRevert(abi.encodeWithSelector(StakeVault.StakeDelegationDisabled.selector, maker));
        vm.prank(address(0xCAFE));
        vault.setTakerAuthorization(maker, true);
    }

    function test_TakerCanReenableOneSidedDelegation() public {
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);

        vm.startPrank(maker);
        vault.clearStakeOwner();
        vault.setStakeDelegationEnabled(true);
        vm.stopPrank();

        address replacementOwner = address(0xCAFE);
        vm.prank(replacementOwner);
        vault.setTakerAuthorization(maker, true);

        assertEq(vault.stakeOwnerOf(maker), replacementOwner);
    }

    function test_TakerCanDisableDelegationBeforeAssignment() public {
        vm.prank(maker);
        vault.setStakeDelegationEnabled(false);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.StakeDelegationDisabled.selector, maker));
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
    }

    function test_TakerCanPreapproveOneExactStakeOwner() public {
        address squatter = address(0xCAFE);
        vm.prank(maker);
        vault.setAllowedStakeOwner(staker);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.StakeOwnerNotAllowed.selector, maker, squatter, staker)
        );
        vm.prank(squatter);
        vault.setTakerAuthorization(maker, true);

        vm.prank(staker);
        vault.depositStakeFor(maker, 100e6);
        assertEq(vault.stakeOwnerOf(maker), staker);
    }

    function test_TakerAtomicallyReplacesSquatterWithAllowedStakeOwner() public {
        address squatter = address(0xCAFE);
        vm.prank(squatter);
        vault.setTakerAuthorization(maker, true);

        vm.prank(maker);
        vault.setAllowedStakeOwner(staker);

        assertEq(vault.stakeOwnerOf(maker), maker);
        assertEq(vault.allowedStakeOwner(maker), staker);
        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.StakeOwnerNotAllowed.selector, maker, squatter, staker)
        );
        vm.prank(squatter);
        vault.setTakerAuthorization(maker, true);

        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        assertEq(vault.stakeOwnerOf(maker), staker);
    }

    function test_BatchTakerAuthorizationUpdatesEveryTaker() public {
        address secondTaker = makeAddr("secondTaker");
        address[] memory takers = new address[](2);
        takers[0] = maker;
        takers[1] = secondTaker;

        vm.prank(staker);
        vault.setTakerAuthorizations(takers, true);

        assertEq(vault.stakeOwnerOf(maker), staker);
        assertEq(vault.stakeOwnerOf(secondTaker), staker);
    }

    function test_ReserveUpdateAndReleasePreserveStake() public {
        bytes32 intentHash = keccak256("intent");
        vm.prank(staker);
        vault.depositStake(1_000e6);

        vm.prank(controller);
        vault.reserveStake(staker, intentHash, 500e6, uint64(block.timestamp + 30 days));
        vm.prank(controller);
        vault.updateReservation(intentHash, 200e6, uint64(block.timestamp + 31 days));

        assertEq(vault.reservedStake(staker), 200e6);
        assertEq(vault.freeStake(staker), 800e6);

        vm.prank(controller);
        vault.releaseReservation(intentHash);
        assertEq(vault.reservedStake(staker), 0);
        assertEq(vault.stakeBalance(staker), 1_000e6);
    }

    function test_SlashCreditsMakerAndRetainsRemainingReservation() public {
        bytes32 intentHash = keccak256("intent");
        vm.prank(staker);
        vault.depositStake(1_000e6);
        vm.prank(controller);
        vault.reserveStake(staker, intentHash, 500e6, 0);

        vm.prank(controller);
        vault.slashReservation(intentHash, maker, 200e6);

        assertEq(vault.stakeBalance(staker), 800e6);
        assertEq(vault.reservedStake(staker), 300e6);
        assertEq(vault.getReservation(intentHash).amount, 300e6);
        assertEq(vault.claimableCompensation(maker), 200e6);
        assertEq(vault.totalLiabilities(), 1_000e6);
    }

    function test_WithdrawCompensationAggregatesMultipleClaims() public {
        bytes32 firstIntent = keccak256("first-intent");
        bytes32 secondIntent = keccak256("second-intent");
        vm.prank(staker);
        vault.depositStake(200e6);
        vm.prank(controller);
        vault.reserveStake(staker, firstIntent, 50e6, 0);
        vm.prank(controller);
        vault.reserveStake(staker, secondIntent, 50e6, 0);
        vm.prank(controller);
        vault.slashReservation(firstIntent, maker, 10e6);
        vm.prank(controller);
        vault.slashReservation(secondIntent, maker, 20e6);

        vm.prank(maker);
        vault.withdrawCompensation(recipient);

        assertEq(token.balanceOf(recipient), 30e6);
        assertEq(vault.claimableCompensation(maker), 0);
    }

    function test_ExitingStakerCannotReceiveNewReservation() public {
        vm.prank(staker);
        vault.depositStake(100e6);
        vm.prank(staker);
        vault.requestExit();

        vm.expectRevert(abi.encodeWithSelector(StakeVault.AlreadyExiting.selector, staker));
        vm.prank(controller);
        vault.reserveStake(staker, keccak256("intent"), 1e6, 0);
    }

    function test_PartialWithdrawalImmediatelyReducesEligibleAndFreeStake() public {
        vm.prank(staker);
        vault.depositStake(1_000e6);

        vm.prank(staker);
        vault.requestStakeWithdrawal(400e6);

        IStakeVault.StakeWithdrawalRequest memory withdrawalRequest = vault.getStakeWithdrawalRequest(staker);
        assertEq(withdrawalRequest.amount, 400e6);
        assertEq(vault.eligibleStake(staker), 600e6);
        assertEq(vault.freeStake(staker), 600e6);
    }

    function test_PartialWithdrawalCannotConsumeReservedStake() public {
        vm.prank(staker);
        vault.depositStake(1_000e6);
        vm.prank(controller);
        vault.reserveStake(staker, keccak256("intent"), 700e6, 0);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.InsufficientFreeStake.selector, staker, 300e6, 301e6)
        );
        vm.prank(staker);
        vault.requestStakeWithdrawal(301e6);
    }

    function test_MaturePartialWithdrawalExecutesWithActiveReservation() public {
        vm.prank(staker);
        vault.depositStake(1_000e6);
        vm.prank(controller);
        vault.reserveStake(staker, keccak256("intent"), 400e6, 0);
        vm.prank(staker);
        vault.requestStakeWithdrawal(600e6);
        vm.warp(block.timestamp + EXIT_DELAY);

        vm.prank(staker);
        vault.withdrawRequestedStake(recipient);

        assertEq(token.balanceOf(recipient), 600e6);
        assertEq(vault.stakeBalance(staker), 400e6);
        assertEq(vault.reservedStake(staker), 400e6);
    }

    function test_CancellingPartialWithdrawalRestoresEligibleStake() public {
        vm.prank(staker);
        vault.depositStake(1_000e6);
        vm.prank(staker);
        vault.requestStakeWithdrawal(400e6);

        vm.prank(staker);
        vault.cancelStakeWithdrawal();

        assertEq(vault.eligibleStake(staker), 1_000e6);
        assertEq(vault.freeStake(staker), 1_000e6);
    }

    function test_SlashingReservedStakePreservesPendingWithdrawal() public {
        bytes32 intentHash = keccak256("intent");
        vm.prank(staker);
        vault.depositStake(1_000e6);
        vm.prank(controller);
        vault.reserveStake(staker, intentHash, 600e6, 0);
        vm.prank(staker);
        vault.requestStakeWithdrawal(400e6);

        vm.prank(controller);
        vault.slashReservation(intentHash, maker, 200e6);
        vm.warp(block.timestamp + EXIT_DELAY);
        vm.prank(staker);
        vault.withdrawRequestedStake(recipient);

        assertEq(vault.stakeBalance(staker), 400e6);
        assertEq(vault.reservedStake(staker), 400e6);
    }

    function test_WithdrawRequiresMatureExitAndNoReservation() public {
        bytes32 intentHash = keccak256("intent");
        vm.prank(staker);
        vault.depositStake(100e6);
        vm.prank(controller);
        vault.reserveStake(staker, intentHash, 10e6, 0);
        vm.prank(staker);
        vault.requestExit();
        vm.warp(block.timestamp + EXIT_DELAY);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.ActiveReservations.selector, staker, 10e6));
        vm.prank(staker);
        vault.withdrawStake(recipient);

        vm.prank(controller);
        vault.releaseReservation(intentHash);
        vm.prank(staker);
        vault.withdrawStake(recipient);

        assertEq(token.balanceOf(recipient), 100e6);
        assertEq(vault.stakeBalance(staker), 0);
    }

    function test_DeferredGrossBecomesFullyReservedStake() public {
        bytes32 intentHash = keccak256("deferred");
        deal(address(token), address(vault), 100e6);
        IIntentRiskHook.FeeAllocation[] memory fees = new IIntentRiskHook.FeeAllocation[](1);
        fees[0] = IIntentRiskHook.FeeAllocation({
            feeType: IIntentRiskHook.FeeType.PROTOCOL,
            recipient: recipient,
            amount: 2e6
        });

        vm.prank(controller);
        vault.authorizeDeferredStake(intentHash, staker, uint64(block.timestamp + DAY));
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, 100e6, uint64(block.timestamp + DAY), fees);

        IStakeVault.DeferredStake memory deferredStake = vault.getDeferredStake(intentHash);
        assertEq(deferredStake.grossAmount, 100e6);
        assertEq(deferredStake.feeAmount, 2e6);
        assertEq(vault.stakeBalance(staker), 100e6);
        assertEq(vault.reservedStake(staker), 100e6);
        assertEq(vault.freeStake(staker), 0);
        assertEq(vault.totalDeferredFees(), 2e6);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    function test_ReleaseDeferredStakeVestsFeesAndLeavesNetFreeStake() public {
        bytes32 intentHash = keccak256("deferred");
        deal(address(token), address(vault), 100e6);
        uint64 releaseTime = uint64(block.timestamp + DAY);
        IIntentRiskHook.FeeAllocation[] memory fees = new IIntentRiskHook.FeeAllocation[](1);
        fees[0] = IIntentRiskHook.FeeAllocation({
            feeType: IIntentRiskHook.FeeType.PROTOCOL,
            recipient: recipient,
            amount: 2e6
        });
        vm.prank(controller);
        vault.authorizeDeferredStake(intentHash, staker, releaseTime);
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, 100e6, releaseTime, fees);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.DeferredStakeNotMature.selector, releaseTime, uint64(block.timestamp))
        );
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);

        vm.warp(releaseTime);
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);

        assertEq(vault.stakeBalance(staker), 98e6);
        assertEq(vault.reservedStake(staker), 0);
        assertEq(vault.freeStake(staker), 98e6);
        assertEq(vault.claimableFees(recipient), 2e6);
        assertEq(vault.totalDeferredFees(), 0);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());

        vault.withdrawFeeClaimFor(recipient);
        assertEq(token.balanceOf(recipient), 2e6);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    function test_SlashDeferredStakeCreditsFullGrossAndCancelsFees() public {
        bytes32 intentHash = keccak256("deferred");
        deal(address(token), address(vault), 100e6);
        IIntentRiskHook.FeeAllocation[] memory fees = new IIntentRiskHook.FeeAllocation[](1);
        fees[0] = IIntentRiskHook.FeeAllocation({
            feeType: IIntentRiskHook.FeeType.PROTOCOL,
            recipient: recipient,
            amount: 2e6
        });
        vm.startPrank(controller);
        vault.authorizeDeferredStake(intentHash, staker, uint64(block.timestamp + DAY));
        vault.recordDeferredStake(intentHash, staker, 100e6, uint64(block.timestamp + DAY), fees);
        vault.slashDeferredStake(intentHash, maker);
        vm.stopPrank();

        assertEq(vault.stakeBalance(staker), 0);
        assertEq(vault.reservedStake(staker), 0);
        assertEq(vault.claimableCompensation(maker), 100e6);
        assertEq(vault.claimableFees(recipient), 0);
        assertEq(vault.totalDeferredFees(), 0);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    function test_ControllerHandoverIsDelayedAndTwoStep() public {
        address nextController = makeAddr("nextController");
        vm.prank(owner);
        vault.proposeController(nextController);

        vm.expectRevert();
        vm.prank(nextController);
        vault.acceptController();

        vm.warp(block.timestamp + DAY);
        vm.prank(nextController);
        vault.acceptController();
        assertEq(vault.controller(), nextController);
    }

    function test_PreviousControllerSettlesOnlyItsSnapshottedPositionAfterHandover() public {
        address nextController = makeAddr("nextController");
        bytes32 oldIntent = keccak256("oldIntent");
        bytes32 newIntent = keccak256("newIntent");
        vm.prank(staker);
        vault.depositStake(1_000e6);
        vm.prank(controller);
        vault.reserveStake(staker, oldIntent, 400e6, 0);

        vm.prank(owner);
        vault.proposeController(nextController);
        vm.warp(block.timestamp + DAY);
        vm.prank(nextController);
        vault.acceptController();
        vm.prank(nextController);
        vault.reserveStake(staker, newIntent, 200e6, 0);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.UnauthorizedPositionController.selector, nextController, controller)
        );
        vm.prank(nextController);
        vault.releaseReservation(oldIntent);

        vm.prank(controller);
        vault.releaseReservation(oldIntent);
        vm.prank(nextController);
        vault.releaseReservation(newIntent);
        assertEq(vault.reservedStake(staker), 0);
    }

    function test_PreviousControllerFundsDeferredPositionAfterHandoverAndPause() public {
        address nextController = makeAddr("nextController");
        bytes32 intentHash = keccak256("deferred");
        vm.prank(controller);
        vault.authorizeDeferredStake(intentHash, staker, uint64(block.timestamp + DAY));

        vm.prank(owner);
        vault.proposeController(nextController);
        vm.warp(block.timestamp + DAY);
        vm.prank(nextController);
        vault.acceptController();
        vm.prank(owner);
        vault.setStakeOperationsPaused(false, true);
        deal(address(token), address(vault), 100e6);

        vm.prank(controller);
        IIntentRiskHook.FeeAllocation[] memory noFees = new IIntentRiskHook.FeeAllocation[](0);
        vault.recordDeferredStake(intentHash, staker, 100e6, uint64(block.timestamp + 2 * DAY), noFees);
        assertEq(vault.getDeferredStake(intentHash).grossAmount, 100e6);
    }

    function testFuzz_ReservationNeverExceedsStake(uint96 rawStake, uint96 rawReservation) public {
        uint256 stakeAmount = bound(uint256(rawStake), 1, 1_000_000e6);
        uint256 reservationAmount = bound(uint256(rawReservation), 1, stakeAmount);
        deal(address(token), staker, stakeAmount);

        vm.prank(staker);
        vault.depositStake(stakeAmount);
        vm.prank(controller);
        vault.reserveStake(staker, keccak256(abi.encode(stakeAmount, reservationAmount)), reservationAmount, 0);

        assertLe(vault.reservedStake(staker), vault.stakeBalance(staker));
        assertEq(vault.freeStake(staker), stakeAmount - reservationAmount);
    }
}
