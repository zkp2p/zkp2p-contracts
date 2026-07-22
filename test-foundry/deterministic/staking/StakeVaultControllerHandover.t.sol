// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVaultLegacyFixture} from "../helpers/StakeVaultLegacyFixture.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";

contract StakeVaultControllerHandoverTest is StakeVaultLegacyFixture {
    function _handover() internal {
        vault.proposeController(nextController);
        vm.warp(block.timestamp + DAY);
        vm.prank(nextController);
        vault.acceptController();
    }

    function test_ControllerHandoverRequiresDelayedTwoStepAcceptance() public {
        vault.proposeController(nextController);
        uint64 validAt = vault.pendingControllerValidAt();
        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.ControllerProposalNotReady.selector, validAt, uint64(block.timestamp))
        );
        vm.prank(nextController);
        vault.acceptController();
        vm.warp(validAt);
        vm.prank(nextController);
        vault.acceptController();
        assertEq(vault.controller(), nextController);
    }

    function test_ControllerInitializationAndProposalRejectInvalidState() public {
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vault.initializeController(address(0));

        vm.expectRevert(abi.encodeWithSelector(StakeVault.ControllerAlreadyInitialized.selector, controller));
        vault.initializeController(nextController);

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vault.proposeController(address(0));
    }

    function test_ControllerAcceptanceRejectsMissingAndWrongProposer() public {
        vm.expectRevert(StakeVault.NoPendingController.selector);
        vault.acceptController();

        vault.proposeController(nextController);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.UnauthorizedController.selector, maker));
        vm.prank(maker);
        vault.acceptController();
    }

    function test_PreviousControllerSettlesOnlySnapshottedReservations() public {
        bytes32 oldIntent = keccak256("old-intent");
        bytes32 newIntent = keccak256("new-intent");
        _deposit(1_000e6);
        _reserve(oldIntent, 400e6, 0);
        _handover();
        vm.prank(nextController);
        vault.reserveStake(staker, newIntent, 200e6, 0);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.UnauthorizedPositionController.selector, nextController, controller)
        );
        vm.prank(nextController);
        vault.releaseReservation(oldIntent);
        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.UnauthorizedPositionController.selector, controller, nextController)
        );
        vm.prank(controller);
        vault.releaseReservation(newIntent);
        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.UnauthorizedPositionController.selector, nextController, controller)
        );
        vm.prank(nextController);
        vault.increaseReservation(oldIntent, 1e6, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.UnauthorizedController.selector, controller));
        vm.prank(controller);
        vault.increaseReservation(oldIntent, 1e6, 0);

        vm.prank(controller);
        vault.releaseReservation(oldIntent);
        vm.prank(nextController);
        vault.releaseReservation(newIntent);
        assertEq(vault.reservedStake(staker), 0);
    }

    function test_PreviousControllerFundsSnapshottedDeferredAuthorization() public {
        bytes32 intentHash = keccak256("old-deferred-intent");
        vm.prank(controller);
        vault.authorizeDeferredStake(intentHash, staker, DAY);
        _handover();
        token.transfer(address(vault), 100e6);
        IIntentRiskHook.FeeAllocation[] memory noFees = new IIntentRiskHook.FeeAllocation[](0);
        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.UnauthorizedPositionController.selector, nextController, controller)
        );
        vm.prank(nextController);
        vault.recordDeferredStake(intentHash, staker, 100e6, 2 * DAY, noFees);
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, 100e6, 2 * DAY, noFees);
        assertEq(vault.getDeferredStake(intentHash).grossAmount, 100e6);
    }
}
