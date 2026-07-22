// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVaultLegacyFixture} from "../helpers/StakeVaultLegacyFixture.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract StakeVaultDepositDelegationTest is StakeVaultLegacyFixture {
    event StakeDeposited(address indexed staker, uint256 amount, uint256 newStakeBalance);
    event TakerAuthorizationUpdated(address indexed stakeOwner, address indexed taker, bool authorized);
    event StakeDelegationEnabledUpdated(address indexed taker, bool enabled);
    event AllowedStakeOwnerUpdated(address indexed taker, address indexed allowedStakeOwner);

    function test_ConstructorRejectsZeroDependenciesAndUnsafeControllerDelay() public {
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        new StakeVault(address(0), token, controller, EXIT_DELAY, DAY);

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        new StakeVault(address(this), IERC20(address(0)), controller, EXIT_DELAY, DAY);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidControllerChangeDelay.selector, DAY - 1));
        new StakeVault(address(this), token, controller, EXIT_DELAY, DAY - 1);
    }

    function test_DepositStakeRecordsStakeAndEmitsResultingBalance() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakeDeposited(staker, 1_000e6, 1_000e6);
        _deposit(1_000e6);
        assertEq(vault.stakeBalance(staker), 1_000e6);
        assertEq(vault.totalLiabilities(), 1_000e6);
    }

    function test_DepositStakeRejectsZeroValue() public {
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        _deposit(0);
    }

    function test_DepositStakeRejectsWhileDepositsPaused() public {
        vault.setStakeOperationsPaused(true, false);
        vm.expectRevert(StakeVault.StakeActionPaused.selector);
        _deposit(1e6);
    }

    function test_DepositStakeForPreservesStakeOwnership() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit TakerAuthorizationUpdated(staker, maker, true);
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakeDeposited(staker, 1_000e6, 1_000e6);
        vm.prank(staker);
        vault.depositStakeFor(maker, 1_000e6);
        assertEq(vault.stakeOwnerOf(maker), staker);
        assertEq(vault.stakeBalance(staker), 1_000e6);
        assertEq(vault.stakeBalance(maker), 0);
    }

    function test_DelegationRejectsReplacementByAnotherStakeOwner() public {
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.TakerAlreadyAuthorized.selector, maker, staker));
        vm.prank(nextController);
        vault.setTakerAuthorization(maker, true);
    }

    function test_StakeOwnerCanRevokeTaker() public {
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        vm.expectEmit(true, true, false, true, address(vault));
        emit TakerAuthorizationUpdated(staker, maker, false);
        vm.prank(staker);
        vault.setTakerAuthorization(maker, false);
        assertEq(vault.stakeOwnerOf(maker), maker);
    }

    function test_DelegationRejectsEmptyBatchAndMissingRevocation() public {
        vm.expectRevert(StakeVault.EmptyBatch.selector);
        vault.setTakerAuthorizations(new address[](0), true);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.TakerAuthorizationNotFound.selector, maker, staker));
        vm.prank(staker);
        vault.setTakerAuthorization(maker, false);
    }

    function test_DelegationRejectsInvalidTakersAndIdempotentlyKeepsOwner() public {
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidTaker.selector, address(0)));
        vm.prank(staker);
        vault.setTakerAuthorization(address(0), true);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidTaker.selector, staker));
        vm.prank(staker);
        vault.setTakerAuthorization(staker, true);

        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        assertEq(vault.stakeOwnerOf(maker), staker);
    }

    function test_ClearStakeOwnerRejectsWithoutDelegation() public {
        vm.expectRevert(abi.encodeWithSelector(StakeVault.NoDelegatedStakeOwner.selector, maker));
        vm.prank(maker);
        vault.clearStakeOwner();
    }

    function test_TakerClearsStakeOwnerAndDisablesReassignment() public {
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        vm.expectEmit(true, true, false, true, address(vault));
        emit TakerAuthorizationUpdated(staker, maker, false);
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakeDelegationEnabledUpdated(maker, false);
        vm.prank(maker);
        vault.clearStakeOwner();
        assertEq(vault.stakeOwnerOf(maker), maker);
        assertFalse(vault.stakeDelegationEnabled(maker));
    }

    function test_DelegationRejectsForcedReassignmentAfterClear() public {
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        vm.prank(maker);
        vault.clearStakeOwner();
        vm.expectRevert(abi.encodeWithSelector(StakeVault.StakeDelegationDisabled.selector, maker));
        vm.prank(nextController);
        vault.setTakerAuthorization(maker, true);
    }

    function test_TakerCanReenableStakeDelegation() public {
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        vm.prank(maker);
        vault.clearStakeOwner();
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakeDelegationEnabledUpdated(maker, true);
        vm.prank(maker);
        vault.setStakeDelegationEnabled(true);
        vm.prank(nextController);
        vault.setTakerAuthorization(maker, true);
        assertEq(vault.stakeOwnerOf(maker), nextController);
    }

    function test_ReenablingDelegationClearsAnExactAllowedOwner() public {
        vm.prank(maker);
        vault.setAllowedStakeOwner(staker);
        assertEq(vault.allowedStakeOwner(maker), staker);

        vm.prank(maker);
        vault.setStakeDelegationEnabled(true);
        assertEq(vault.allowedStakeOwner(maker), address(0));
    }

    function test_TakerCanDisableDelegationBeforeAssignment() public {
        vm.prank(maker);
        vault.setStakeDelegationEnabled(false);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.StakeDelegationDisabled.selector, maker));
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
    }

    function test_TakerCanPreapproveExactStakeOwner() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit AllowedStakeOwnerUpdated(maker, staker);
        vm.prank(maker);
        vault.setAllowedStakeOwner(staker);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.StakeOwnerNotAllowed.selector, maker, nextController, staker));
        vm.prank(nextController);
        vault.setTakerAuthorization(maker, true);
        vm.prank(staker);
        vault.depositStakeFor(maker, 100e6);
        assertEq(vault.stakeOwnerOf(maker), staker);
    }

    function test_AllowedStakeOwnerRejectsZeroAndSelf() public {
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidTaker.selector, address(0)));
        vm.prank(maker);
        vault.setAllowedStakeOwner(address(0));

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidTaker.selector, maker));
        vm.prank(maker);
        vault.setAllowedStakeOwner(maker);
    }

    function test_AllowedStakeOwnerAtomicallyReplacesSquatter() public {
        vm.prank(nextController);
        vault.setTakerAuthorization(maker, true);
        vm.expectEmit(true, true, false, true, address(vault));
        emit TakerAuthorizationUpdated(nextController, maker, false);
        vm.expectEmit(true, true, false, true, address(vault));
        emit AllowedStakeOwnerUpdated(maker, staker);
        vm.prank(maker);
        vault.setAllowedStakeOwner(staker);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.StakeOwnerNotAllowed.selector, maker, nextController, staker));
        vm.prank(nextController);
        vault.setTakerAuthorization(maker, true);
        vm.prank(staker);
        vault.setTakerAuthorization(maker, true);
        assertEq(vault.stakeOwnerOf(maker), staker);
    }

    function test_DelegatedTakerHasNoStakeWithdrawalRights() public {
        vm.prank(staker);
        vault.depositStakeFor(maker, 100e6);
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(maker);
        vault.requestExit();
    }

    function test_BatchAuthorizationUpdatesEveryTakerAtomically() public {
        address[] memory takers = new address[](2);
        takers[0] = maker;
        takers[1] = recipient;
        vm.prank(staker);
        vault.setTakerAuthorizations(takers, true);
        assertEq(vault.stakeOwnerOf(maker), staker);
        assertEq(vault.stakeOwnerOf(recipient), staker);
    }

    function test_InvalidBatchAuthorizationRollsBackEveryTaker() public {
        vm.prank(nextController);
        vault.setTakerAuthorization(maker, true);
        address[] memory takers = new address[](2);
        takers[0] = recipient;
        takers[1] = maker;
        vm.expectRevert(abi.encodeWithSelector(StakeVault.TakerAlreadyAuthorized.selector, maker, nextController));
        vm.prank(staker);
        vault.setTakerAuthorizations(takers, true);
        assertEq(vault.stakeOwnerOf(recipient), recipient);
    }
}
