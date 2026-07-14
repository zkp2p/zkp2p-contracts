// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { StakeVault } from "../../contracts/StakeVault.sol";
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

    function test_ExitingStakerCannotReceiveNewReservation() public {
        vm.prank(staker);
        vault.depositStake(100e6);
        vm.prank(staker);
        vault.requestExit();

        vm.expectRevert(abi.encodeWithSelector(StakeVault.AlreadyExiting.selector, staker));
        vm.prank(controller);
        vault.reserveStake(staker, keccak256("intent"), 1e6, 0);
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

    function test_DeferredPayoutCanBePartiallySlashed() public {
        bytes32 intentHash = keccak256("deferred");
        deal(address(token), address(vault), 100e6);

        vm.prank(controller);
        vault.authorizeDeferredPayout(intentHash, staker, uint64(block.timestamp + DAY));
        vm.prank(controller);
        vault.recordDeferredPayout(intentHash, staker, 100e6, uint64(block.timestamp + DAY));
        vm.prank(controller);
        vault.slashDeferredPayout(intentHash, maker, 40e6);

        IStakeVault.DeferredPayout memory payout = vault.getDeferredPayout(intentHash);
        assertEq(payout.amount, 60e6);
        assertEq(vault.claimableCompensation(maker), 40e6);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    function test_WithdrawDeferredPayoutOnlyAfterMaturity() public {
        bytes32 intentHash = keccak256("deferred");
        deal(address(token), address(vault), 100e6);
        uint64 releaseTime = uint64(block.timestamp + DAY);
        vm.prank(controller);
        vault.authorizeDeferredPayout(intentHash, staker, releaseTime);
        vm.prank(controller);
        vault.recordDeferredPayout(intentHash, staker, 100e6, releaseTime);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.DeferredPayoutNotMature.selector, releaseTime, uint64(block.timestamp))
        );
        vm.prank(staker);
        vault.withdrawDeferredPayout(intentHash, recipient);

        vm.warp(releaseTime);
        vm.prank(staker);
        vault.withdrawDeferredPayout(intentHash, recipient);
        assertEq(token.balanceOf(recipient), 100e6);
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
        vault.authorizeDeferredPayout(intentHash, staker, uint64(block.timestamp + DAY));

        vm.prank(owner);
        vault.proposeController(nextController);
        vm.warp(block.timestamp + DAY);
        vm.prank(nextController);
        vault.acceptController();
        vm.prank(owner);
        vault.setStakeOperationsPaused(false, true);
        deal(address(token), address(vault), 100e6);

        vm.prank(controller);
        vault.recordDeferredPayout(intentHash, staker, 100e6, uint64(block.timestamp + 2 * DAY));
        assertEq(vault.getDeferredPayout(intentHash).amount, 100e6);
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
