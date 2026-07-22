// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVaultLegacyFixture} from "../helpers/StakeVaultLegacyFixture.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

contract StakeVaultExitParityTest is StakeVaultLegacyFixture {
    function test_PartialWithdrawalRejectsZeroAmountAndRecipient() public {
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(staker);
        vault.requestStakeWithdrawal(0);

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(staker);
        vault.withdrawRequestedStake(address(0));
    }

    event StakeWithdrawalRequested(address indexed stakeOwner, uint256 amount, uint64 requestedAt, uint64 availableAt);
    event StakeWithdrawalCancelled(address indexed stakeOwner, uint256 amount);
    event StakeWithdrawn(address indexed staker, address indexed recipient, uint256 amount);

    function test_PartialWithdrawalImmediatelyReducesEligibleAndFreeStake() public {
        _deposit(1_000e6);
        vm.prank(staker);
        vault.requestStakeWithdrawal(400e6);
        IStakeVault.StakeWithdrawalRequest memory request = vault.getStakeWithdrawalRequest(staker);
        assertEq(request.amount, 400e6);
        assertEq(request.availableAt - request.requestedAt, EXIT_DELAY);
        assertEq(vault.eligibleStake(staker), 600e6);
        assertEq(vault.freeStake(staker), 600e6);
    }

    function test_PartialWithdrawalRejectsSecondPendingRequest() public {
        _deposit(100e6);
        vm.startPrank(staker);
        vault.requestStakeWithdrawal(40e6);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.StakeWithdrawalAlreadyRequested.selector, staker, 40e6));
        vault.requestStakeWithdrawal(1e6);
        vm.stopPrank();
    }

    function test_PartialWithdrawalRejectsAmountAboveFreeStake() public {
        _deposit(1_000e6);
        _reserve(keccak256("intent"), 700e6, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InsufficientFreeStake.selector, staker, 300e6, 301e6));
        vm.prank(staker);
        vault.requestStakeWithdrawal(301e6);
    }

    function test_PartialWithdrawalRejectsExecutionBeforeDelay() public {
        _deposit(100e6);
        vm.prank(staker);
        vault.requestStakeWithdrawal(40e6);
        IStakeVault.StakeWithdrawalRequest memory request = vault.getStakeWithdrawalRequest(staker);
        vm.expectRevert(
            abi.encodeWithSelector(
                StakeVault.StakeWithdrawalNotReady.selector, request.availableAt, uint64(block.timestamp)
            )
        );
        vm.prank(staker);
        vault.withdrawRequestedStake(recipient);
    }

    function test_PartialWithdrawalExecutesWhileReservationRemains() public {
        _deposit(1_000e6);
        _reserve(keccak256("intent"), 400e6, 0);
        vm.prank(staker);
        vault.requestStakeWithdrawal(600e6);
        vm.warp(block.timestamp + EXIT_DELAY);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeWithdrawn(staker, recipient, 600e6);
        vm.prank(staker);
        vault.withdrawRequestedStake(recipient);
        assertEq(token.balanceOf(recipient), 600e6);
        assertEq(vault.stakeBalance(staker), 400e6);
        assertEq(vault.reservedStake(staker), 400e6);
    }

    function test_CancelPartialWithdrawalRestoresEligibility() public {
        _deposit(100e6);
        vm.prank(staker);
        vault.requestStakeWithdrawal(40e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakeWithdrawalCancelled(staker, 40e6);
        vm.prank(staker);
        vault.cancelStakeWithdrawal();
        assertEq(vault.eligibleStake(staker), 100e6);
        assertEq(vault.freeStake(staker), 100e6);
    }

    function test_FullExitRejectsPendingPartialWithdrawal() public {
        _deposit(100e6);
        vm.prank(staker);
        vault.requestStakeWithdrawal(40e6);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.PendingStakeWithdrawal.selector, staker, 40e6));
        vm.prank(staker);
        vault.requestExit();
    }

    function test_PartialWithdrawalRejectsPendingFullExit() public {
        _deposit(100e6);
        vm.prank(staker);
        vault.requestExit();
        vm.expectRevert(abi.encodeWithSelector(StakeVault.AlreadyExiting.selector, staker));
        vm.prank(staker);
        vault.requestStakeWithdrawal(40e6);
    }

    function test_SlashPreservesPendingPartialWithdrawal() public {
        bytes32 intentHash = keccak256("intent");
        _deposit(1_000e6);
        _reserve(intentHash, 600e6, 0);
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

    function test_RequestExitMarksStakerExitingImmediately() public {
        _deposit(100e6);
        vm.prank(staker);
        vault.requestExit();
        assertTrue(vault.isExiting(staker));
        IStakeVault.ExitRequest memory request = vault.getExitRequest(staker);
        assertTrue(request.exiting);
        assertEq(request.availableAt - request.requestedAt, EXIT_DELAY);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.AlreadyExiting.selector, staker));
        vm.prank(staker);
        vault.requestExit();
    }

    function test_ExitActionsRejectMissingExitAndZeroRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(StakeVault.NotExiting.selector, staker));
        vm.prank(staker);
        vault.cancelExit();

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(staker);
        vault.withdrawStake(address(0));
    }

    function test_FullExitBlocksNewReservations() public {
        _deposit(100e6);
        vm.prank(staker);
        vault.requestExit();
        vm.expectRevert(abi.encodeWithSelector(StakeVault.AlreadyExiting.selector, staker));
        _reserve(keccak256("intent"), 1e6, 0);
    }

    function test_FullExitRequiresDelayAndResolvedReservations() public {
        bytes32 intentHash = keccak256("intent");
        _deposit(100e6);
        _reserve(intentHash, 20e6, 0);
        vm.prank(staker);
        vault.requestExit();
        vm.warp(block.timestamp + EXIT_DELAY);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.ActiveReservations.selector, staker, 20e6));
        vm.prank(staker);
        vault.withdrawStake(recipient);
    }

    function test_FullExitRejectsWithdrawalBeforeDelay() public {
        _deposit(100e6);
        vm.prank(staker);
        vault.requestExit();
        IStakeVault.ExitRequest memory request = vault.getExitRequest(staker);
        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.ExitNotReady.selector, request.availableAt, uint64(block.timestamp))
        );
        vm.prank(staker);
        vault.withdrawStake(recipient);
    }

    function test_MatureFullExitWithdrawsEntireRemainingBalance() public {
        _deposit(100e6);
        vm.prank(staker);
        vault.requestExit();
        vm.warp(block.timestamp + EXIT_DELAY);
        vm.prank(staker);
        vault.withdrawStake(recipient);
        assertEq(token.balanceOf(recipient), 100e6);
        assertEq(vault.stakeBalance(staker), 0);
    }

    function test_CancelExitPreservesStakeBalance() public {
        _deposit(100e6);
        vm.startPrank(staker);
        vault.requestExit();
        vault.cancelExit();
        vm.stopPrank();
        assertFalse(vault.isExiting(staker));
        assertEq(vault.stakeBalance(staker), 100e6);
    }
}
