// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowFundingParityTest is EscrowLegacyFixture {
    event DepositFundsAdded(uint256 indexed depositId, address indexed funder, uint256 amount);
    event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount);
    event DepositAcceptingIntentsUpdated(uint256 indexed depositId, bool accepting);

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.retainOnEmpty = false;
        _createAsOffRamper(params);
    }

    function _add(address funder, uint256 amount) internal {
        vm.prank(funder);
        escrow.addFunds(0, amount);
    }

    function _remove(address caller, uint256 amount) internal {
        vm.prank(caller);
        escrow.removeFunds(0, amount);
    }

    function test_AddFundsTransfersTokensIntoEscrow() public {
        uint256 escrowBefore = token.balanceOf(address(escrow));
        uint256 depositorBefore = token.balanceOf(offRamper);
        _add(offRamper, 50e6);
        assertEq(token.balanceOf(address(escrow)) - escrowBefore, 50e6);
        assertEq(depositorBefore - token.balanceOf(offRamper), 50e6);
    }

    function test_AddFundsUpdatesRemainingDepositAmount() public {
        uint256 beforeRemaining = escrow.getDeposit(0).remainingDeposits;
        _add(offRamper, 50e6);
        assertEq(escrow.getDeposit(0).remainingDeposits, beforeRemaining + 50e6);
    }

    function test_AddFundsEmitsFunderAndAmount() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositFundsAdded(0, offRamper, 50e6);
        _add(offRamper, 50e6);
    }

    function test_AddFundsSucceedsWithoutReenablingDisabledDeposit() public {
        vm.prank(offRamper);
        escrow.setAcceptingIntents(0, false);
        _add(offRamper, 50e6);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 150e6);
        assertFalse(deposit.acceptingIntents);
    }

    function test_AddFundsAllowsThirdPartyFunder() public {
        vm.prank(offRamper);
        token.transfer(maliciousOnRamper, 100e6);
        vm.prank(maliciousOnRamper);
        token.approve(address(escrow), 100e6);
        _add(maliciousOnRamper, 50e6);
        assertEq(escrow.getDeposit(0).remainingDeposits, 150e6);
    }

    function test_AddFundsRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, 999));
        vm.prank(offRamper);
        escrow.addFunds(999, 50e6);
    }

    function test_AddFundsRejectsZeroAmount() public {
        vm.expectRevert(IEscrow.ZeroValue.selector);
        _add(offRamper, 0);
    }

    function test_AddFundsRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _add(offRamper, 50e6);
    }

    function test_RemoveFundsTransfersTokensToDepositor() public {
        uint256 escrowBefore = token.balanceOf(address(escrow));
        uint256 depositorBefore = token.balanceOf(offRamper);
        _remove(offRamper, 30e6);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), 30e6);
        assertEq(token.balanceOf(offRamper) - depositorBefore, 30e6);
    }

    function test_RemoveFundsUpdatesRemainingDepositAmount() public {
        uint256 beforeRemaining = escrow.getDeposit(0).remainingDeposits;
        _remove(offRamper, 30e6);
        assertEq(escrow.getDeposit(0).remainingDeposits, beforeRemaining - 30e6);
    }

    function test_RemoveFundsEmitsWithdrawal() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositWithdrawn(0, offRamper, 30e6);
        _remove(offRamper, 30e6);
    }

    function test_RemoveFundsPreservesAcceptingStateAboveMinimum() public {
        assertTrue(escrow.getDeposit(0).acceptingIntents);
        _remove(offRamper, 30e6);
        assertTrue(escrow.getDeposit(0).acceptingIntents);
    }

    function test_RemoveFundsSucceedsWhileDepositIsDisabled() public {
        vm.prank(offRamper);
        escrow.setAcceptingIntents(0, false);
        _remove(offRamper, 20e6);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 80e6);
        assertFalse(deposit.acceptingIntents);
    }

    function test_RemoveFundsBelowMinimumAutomaticallyDisablesDeposit() public {
        _remove(offRamper, 95e6);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 5e6);
        assertFalse(deposit.acceptingIntents);
    }

    function test_RemoveFundsBelowMinimumEmitsAcceptingStateUpdate() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositAcceptingIntentsUpdated(0, false);
        _remove(offRamper, 95e6);
    }

    function test_RemoveFundsBelowMinimumEmitsWithdrawal() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositWithdrawn(0, offRamper, 95e6);
        _remove(offRamper, 95e6);
    }

    function test_RemoveAllFundsDoesNotCloseDeposit() public {
        _remove(offRamper, 100e6);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.depositor, offRamper);
        assertEq(deposit.remainingDeposits, 0);
        assertFalse(deposit.acceptingIntents);
    }

    function test_RemoveFundsPrunesExpiredIntentAndReclaimsLiquidity() public {
        _signalIntent(0, 50e6, 1.1e18);
        vm.warp(block.timestamp + 1 days + 1);
        assertEq(escrow.getDeposit(0).remainingDeposits, 50e6);
        _remove(offRamper, 70e6);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 30e6);
        assertEq(deposit.outstandingIntentAmount, 0);
    }

    function test_RemoveFundsAfterExpiredIntentEmitsWithdrawal() public {
        _signalIntent(0, 50e6, 1.1e18);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositWithdrawn(0, offRamper, 70e6);
        _remove(offRamper, 70e6);
    }

    function test_RemoveFundsAfterExpiredIntentRemainsAccepting() public {
        _signalIntent(0, 50e6, 1.1e18);
        vm.warp(block.timestamp + 1 days + 1);
        _remove(offRamper, 70e6);
        assertTrue(escrow.getDeposit(0).acceptingIntents);
    }

    function test_RemoveFundsRejectsAmountAboveAvailableLiquidity() public {
        _signalIntent(0, 60e6, 1.1e18);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InsufficientDepositLiquidity.selector, 0, 40e6, 50e6));
        _remove(offRamper, 50e6);
    }

    function test_RemoveFundsRejectsNonDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, maliciousOnRamper, offRamper));
        _remove(maliciousOnRamper, 30e6);
    }

    function test_RemoveFundsRejectsMissingDepositWithUnauthorizedError() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, offRamper, address(0)));
        vm.prank(offRamper);
        escrow.removeFunds(999, 30e6);
    }

    function test_RemoveFundsRejectsZeroAmount() public {
        vm.expectRevert(IEscrow.ZeroValue.selector);
        _remove(offRamper, 0);
    }

    function test_RemoveFundsRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _remove(offRamper, 30e6);
    }

    function test_RemoveFundsRejectsWhenReentrancyGuardIsEntered() public {
        _enterReentrancyGuard();
        vm.expectRevert("ReentrancyGuard: reentrant call");
        vm.prank(offRamper);
        escrow.removeFunds(0, 1e6);
    }

    function test_WithdrawDepositRejectsWhenReentrancyGuardIsEntered() public {
        _enterReentrancyGuard();
        vm.expectRevert("ReentrancyGuard: reentrant call");
        vm.prank(offRamper);
        escrow.withdrawDeposit(0);
    }

    function test_PruneExpiredIntentsRejectsWhenReentrancyGuardIsEntered() public {
        _enterReentrancyGuard();
        vm.expectRevert("ReentrancyGuard: reentrant call");
        vm.prank(onRamperOtherAddress);
        escrow.pruneExpiredIntents(0);
    }

    function test_UnlockFundsRejectsWhenReentrancyGuardIsEntered() public {
        _enterReentrancyGuard();
        vm.expectRevert("ReentrancyGuard: reentrant call");
        orchestratorMock.unlockFunds(0, keccak256("legacy-guarded-unlock"));
    }

    function test_UnlockAndTransferRejectsWhenReentrancyGuardIsEntered() public {
        _enterReentrancyGuard();
        vm.expectRevert("ReentrancyGuard: reentrant call");
        orchestratorMock.unlockAndTransferFunds(0, keccak256("legacy-guarded-transfer"), 1e6, onRamper);
    }

    function _enterReentrancyGuard() internal {
        vm.store(address(escrow), bytes32(uint256(1)), bytes32(uint256(2)));
    }
}
