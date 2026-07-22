// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVaultLegacyFixture} from "../helpers/StakeVaultLegacyFixture.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

contract StakeVaultReservationTest is StakeVaultLegacyFixture {
    event StakeReserved(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed controller,
        uint256 amount,
        uint256 totalReserved,
        uint64 releaseTime
    );
    event StakeReservationUpdated(
        bytes32 indexed intentHash,
        address indexed staker,
        uint256 previousAmount,
        uint256 newAmount,
        uint256 totalReserved,
        uint64 releaseTime
    );
    event StakeSlashed(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed maker,
        uint256 amount,
        uint256 remainingStake,
        uint256 remainingReservation
    );

    function test_ReserveStakeReservesFreeStakeForUniqueIntent() public {
        bytes32 intentHash = keccak256("intent-1");
        _deposit(1_000e6);
        uint64 releaseTime = uint64(block.timestamp + 30 days);
        vm.expectEmit(true, true, true, true, address(vault));
        emit StakeReserved(intentHash, staker, controller, 400e6, 400e6, releaseTime);
        _reserve(intentHash, 400e6, releaseTime);
        assertEq(vault.reservedStake(staker), 400e6);
        assertEq(vault.freeStake(staker), 600e6);
    }

    function test_ReserveStakeRejectsAmountAboveFreeStake() public {
        _deposit(100e6);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InsufficientFreeStake.selector, staker, 100e6, 101e6));
        _reserve(keccak256("intent"), 101e6, 0);
    }

    function test_ReserveStakeRejectsZeroStakerAndAmount() public {
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(controller);
        vault.reserveStake(address(0), keccak256("zero-staker"), 1e6, 0);

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(controller);
        vault.reserveStake(staker, keccak256("zero-amount"), 0, 0);
    }

    function test_ReserveStakeRejectsReusedActiveIntent() public {
        bytes32 intentHash = keccak256("intent");
        _deposit(100e6);
        _reserve(intentHash, 50e6, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.ReservationAlreadyExists.selector, intentHash));
        _reserve(intentHash, 10e6, 0);
    }

    function test_UpdateReservationReducesAfterPartialFulfillment() public {
        bytes32 intentHash = keccak256("intent");
        _deposit(1_000e6);
        _reserve(intentHash, 500e6, 100);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeReservationUpdated(intentHash, staker, 500e6, 200e6, 200e6, 200);
        vm.prank(controller);
        vault.updateReservation(intentHash, 200e6, 200);
        assertEq(vault.freeStake(staker), 800e6);
    }

    function test_UpdateReservationRejectsZeroAmount() public {
        bytes32 intentHash = keccak256("zero-update");
        _deposit(10e6);
        _reserve(intentHash, 5e6, 0);
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(controller);
        vault.updateReservation(intentHash, 0, 0);
    }

    function test_UpdateReservationRejectsIncreaseDespiteAmpleFreeStake() public {
        bytes32 intentHash = keccak256("decrease-only");
        _deposit(1_000e6);
        _reserve(intentHash, 100e6, 100);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidReservationAmount.selector, 200e6, 100e6));
        vm.prank(controller);
        vault.updateReservation(intentHash, 200e6, 200);
    }

    function test_UpdateReservationEqualAmountRefreshesMaturity() public {
        bytes32 intentHash = keccak256("equal-refresh");
        _deposit(100e6);
        _reserve(intentHash, 50e6, 100);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeReservationUpdated(intentHash, staker, 50e6, 50e6, 50e6, 200);
        vm.prank(controller);
        vault.updateReservation(intentHash, 50e6, 200);
        assertEq(_reservation(intentHash).releaseTime, 200);
    }

    function test_UpdateReservationCanDecreaseWhileReservationsPaused() public {
        bytes32 intentHash = keccak256("paused-decrease");
        _deposit(100e6);
        _reserve(intentHash, 50e6, 100);
        vault.setStakeOperationsPaused(false, true);
        vm.prank(controller);
        vault.updateReservation(intentHash, 20e6, 200);
        assertEq(_reservation(intentHash).amount, 20e6);
        assertEq(vault.freeStake(staker), 80e6);
    }

    function test_IncreaseReservationUsesAdmissionGatedPath() public {
        bytes32 positionId = keccak256("extension-top-up");
        _deposit(10e6);
        _reserve(positionId, 1e6, 100);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeReservationUpdated(positionId, staker, 1e6, 3e6, 3e6, 200);
        vm.prank(controller);
        vault.increaseReservation(positionId, 2e6, 200);
        assertEq(vault.reservedStake(staker), 3e6);
        assertEq(vault.freeStake(staker), 7e6);
    }

    function test_IncreaseReservationZeroRefreshesReleaseTimeOnly() public {
        bytes32 positionId = keccak256("extension-zero-increment-refresh");
        _deposit(10e6);
        _reserve(positionId, 1e6, 100);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeReservationUpdated(positionId, staker, 1e6, 1e6, 1e6, 200);
        vm.prank(controller);
        vault.increaseReservation(positionId, 0, 200);
        IStakeVault.Reservation memory reservation = _reservation(positionId);
        assertEq(reservation.amount, 1e6);
        assertEq(reservation.releaseTime, 200);
        assertEq(vault.reservedStake(staker), 1e6);
        assertEq(vault.freeStake(staker), 9e6);
    }

    function test_IncreaseReservationRejectsMissingAndInsufficientStake() public {
        bytes32 positionId = keccak256("invalid-extension-top-up");
        vm.expectRevert(abi.encodeWithSelector(StakeVault.ReservationNotFound.selector, positionId));
        vm.prank(controller);
        vault.increaseReservation(positionId, 1e6, 0);
        _deposit(10e6);
        _reserve(positionId, 9e6, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InsufficientFreeStake.selector, staker, 1e6, 2e6));
        vm.prank(controller);
        vault.increaseReservation(positionId, 2e6, 0);
    }

    function test_IncreaseReservationRejectsPauseAndExit() public {
        bytes32 positionId = keccak256("extension-top-up-gates");
        _deposit(10e6);
        _reserve(positionId, 1e6, 100);
        vault.setStakeOperationsPaused(false, true);
        vm.expectRevert(StakeVault.StakeActionPaused.selector);
        vm.prank(controller);
        vault.increaseReservation(positionId, 1e6, 200);
        vault.setStakeOperationsPaused(false, false);
        vm.prank(staker);
        vault.requestExit();
        vm.expectRevert(abi.encodeWithSelector(StakeVault.AlreadyExiting.selector, staker));
        vm.prank(controller);
        vault.increaseReservation(positionId, 1e6, 200);
    }

    function test_ZeroIncreaseReservationStillRejectsPauseAndExit() public {
        bytes32 positionId = keccak256("extension-zero-increment-gates");
        _deposit(10e6);
        _reserve(positionId, 1e6, 100);
        vault.setStakeOperationsPaused(false, true);
        vm.expectRevert(StakeVault.StakeActionPaused.selector);
        vm.prank(controller);
        vault.increaseReservation(positionId, 0, 200);
        vault.setStakeOperationsPaused(false, false);
        vm.prank(staker);
        vault.requestExit();
        vm.expectRevert(abi.encodeWithSelector(StakeVault.AlreadyExiting.selector, staker));
        vm.prank(controller);
        vault.increaseReservation(positionId, 0, 200);
    }

    function test_ReleaseReservationClearsCancelledIntentReservation() public {
        bytes32 intentHash = keccak256("intent");
        _deposit(500e6);
        _reserve(intentHash, 200e6, 0);
        vm.prank(controller);
        vault.releaseReservation(intentHash);
        assertEq(vault.reservedStake(staker), 0);
        assertFalse(_reservation(intentHash).active);
    }

    function test_ReservationMutationRejectsNonController() public {
        _deposit(500e6);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.UnauthorizedController.selector, staker));
        vm.prank(staker);
        vault.reserveStake(staker, keccak256("intent"), 1e6, 0);
    }

    function test_SlashReservationRetainsRemainderAndCreditsMaker() public {
        bytes32 intentHash = keccak256("intent");
        _deposit(1_000e6);
        _reserve(intentHash, 500e6, 0);
        vm.expectEmit(true, true, true, true, address(vault));
        emit StakeSlashed(intentHash, staker, maker, 200e6, 800e6, 300e6);
        vm.prank(controller);
        vault.slashReservation(intentHash, maker, 200e6);
        assertEq(vault.reservedStake(staker), 300e6);
        assertEq(vault.claimableCompensation(maker), 200e6);
        assertEq(vault.totalLiabilities(), 1_000e6);
    }

    function test_SlashReservationRejectsAboveActiveReservation() public {
        bytes32 intentHash = keccak256("intent");
        _deposit(100e6);
        _reserve(intentHash, 50e6, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidReservationAmount.selector, 51e6, 50e6));
        vm.prank(controller);
        vault.slashReservation(intentHash, maker, 51e6);
    }

    function test_SlashReservationRejectsZeroMakerAndAmount() public {
        bytes32 intentHash = keccak256("invalid-slash-inputs");
        _deposit(10e6);
        _reserve(intentHash, 5e6, 0);

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(controller);
        vault.slashReservation(intentHash, address(0), 1e6);

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(controller);
        vault.slashReservation(intentHash, maker, 0);
    }

    function test_CompensationWithdrawalRejectsZeroRecipientAndEmptyClaim() public {
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(maker);
        vault.withdrawCompensation(address(0));

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(maker);
        vault.withdrawCompensation(recipient);
    }

    function test_MakerWithdrawsCreditedCompensation() public {
        bytes32 intentHash = keccak256("intent");
        _deposit(100e6);
        _reserve(intentHash, 50e6, 0);
        vm.prank(controller);
        vault.slashReservation(intentHash, maker, 20e6);
        vm.prank(maker);
        vault.withdrawCompensation(recipient);
        assertEq(token.balanceOf(recipient), 20e6);
        assertEq(vault.claimableCompensation(maker), 0);
    }

    function test_CompensationAggregatesAcrossIntentClaims() public {
        bytes32 firstIntent = keccak256("first-intent");
        bytes32 secondIntent = keccak256("second-intent");
        _deposit(200e6);
        _reserve(firstIntent, 50e6, 0);
        _reserve(secondIntent, 50e6, 0);
        vm.startPrank(controller);
        vault.slashReservation(firstIntent, maker, 10e6);
        vault.slashReservation(secondIntent, maker, 20e6);
        vm.stopPrank();
        vm.prank(maker);
        vault.withdrawCompensation(recipient);
        assertEq(token.balanceOf(recipient), 30e6);
        assertEq(vault.claimableCompensation(maker), 0);
    }
}
