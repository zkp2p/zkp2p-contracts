// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowV2LegacyFixture, IEscrowV2Operator} from "../helpers/EscrowV2LegacyFixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2LifecycleParityTest is EscrowV2LegacyFixture {
    event FundsUnlocked(uint256 indexed depositId, bytes32 indexed intentHash, uint256 amount);
    event FundsUnlockedAndTransferred(
        uint256 indexed depositId,
        bytes32 indexed intentHash,
        uint256 unlockedAmount,
        uint256 transferredAmount,
        address to
    );
    event DustCollected(uint256 indexed depositId, uint256 dustAmount, address indexed dustRecipient);
    event IntentExpiryExtended(uint256 indexed depositId, bytes32 indexed intentHash, uint256 newExpiryTime);

    function _assertNoAcceptingUpdate(Vm.Log[] memory logs) internal pure {
        bytes32 signature = keccak256("DepositAcceptingIntentsUpdated(uint256,bool)");
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != signature, "unexpected accepting-intents transition");
        }
    }

    function test_PruneExpiredIntentsUnlocksLiquidityAndEmits() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.warp(block.timestamp + 3601);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsUnlocked(0, intentHash, 20e6);
        vm.prank(other);
        escrow.pruneExpiredIntents(0);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 500e6);
        assertEq(deposit.outstandingIntentAmount, 0);
    }

    function test_PruneExpiredIntentsRevertsWhenOrchestratorPruneReverts() public {
        bytes32 intentHash = _lock(address(revertingPruneOrchestrator), 20e6);
        vm.warp(block.timestamp + 3601);
        vm.expectRevert("prune failed");
        vm.prank(other);
        escrow.pruneExpiredIntents(0);
        assertEq(escrow.getDepositIntent(0, intentHash).intentHash, intentHash);
    }

    function test_PruneExpiredIntentsPreservesOrchestratorMappingOnRevert() public {
        bytes32 intentHash = _lock(address(revertingPruneOrchestrator), 20e6);
        vm.warp(block.timestamp + 3601);
        vm.expectRevert("prune failed");
        vm.prank(other);
        escrow.pruneExpiredIntents(0);
        assertEq(_intentOrchestrator(intentHash), address(revertingPruneOrchestrator));
    }

    function test_PruneExpiredIntentsSkipsClearedOrchestrator() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.warp(block.timestamp + 3601);
        _clearIntentOrchestrator(intentHash);
        vm.prank(other);
        escrow.pruneExpiredIntents(0);
        assertEq(orchestratorMock.getPruneCallCount(), 0);
        assertEq(escrow.getDepositIntent(0, intentHash).intentHash, bytes32(0));
    }

    function test_PruneExpiredIntentsCallsEachOwningOrchestratorPerIntent() public {
        bytes32 first = _lock(address(orchestratorMock), 20e6);
        bytes32 second = _lock(address(orchestratorMock), 20e6);
        bytes32 secondary = _lock(address(secondaryOrchestratorMock), 20e6);
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(0);
        assertEq(orchestratorMock.getPruneCallCount(), 2);
        assertEq(secondaryOrchestratorMock.getPruneCallCount(), 1);
        bytes32[] memory primaryLast = orchestratorMock.getLastPrunedIntents();
        bytes32[] memory secondaryLast = secondaryOrchestratorMock.getLastPrunedIntents();
        assertEq(primaryLast.length, 1);
        assertEq(primaryLast[0], second);
        assertEq(secondaryLast.length, 1);
        assertEq(secondaryLast[0], secondary);
        assertNotEq(first, second);
    }

    function test_PruneExpiredIntentsDoesNotChangeAcceptingState() public {
        _lock(address(orchestratorMock), 60e6);
        vm.prank(depositor);
        escrow.removeFunds(0, 435e6);
        vm.warp(block.timestamp + 3601);
        vm.recordLogs();
        vm.prank(other);
        escrow.pruneExpiredIntents(0);
        _assertNoAcceptingUpdate(vm.getRecordedLogs());
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 65e6);
        assertTrue(deposit.acceptingIntents);
    }

    function test_LockFundsReclaimsExpiredIntentAndPrunesOwner() public {
        bytes32 expired = _lock(address(orchestratorMock), 20e6);
        vm.warp(block.timestamp + 3601);
        _lock(address(orchestratorMock), 20e6);
        _lock(address(orchestratorMock), 20e6);
        bytes32 fourth = keccak256("intent-second");
        orchestratorMock.lockFunds(0, fourth, 20e6);
        bytes32[] memory pruned = orchestratorMock.getLastPrunedIntents();
        assertEq(pruned.length, 1);
        assertEq(pruned[0], expired);
        assertEq(escrow.getDepositIntentHashes(0).length, 3);
    }

    function test_LockFundsRejectsNonOrchestrator() public {
        bytes32 intentHash = keccak256("unauthorized-intent");
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, address(orchestratorRegistry))
        );
        vm.prank(other);
        escrow.lockFunds(0, intentHash, 20e6);
    }

    function test_LockFundsRejectsDuplicateIntentHash() public {
        bytes32 intentHash = keccak256("duplicate-intent");
        orchestratorMock.lockFunds(0, intentHash, 20e6);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.IntentAlreadyExists.selector, 0, intentHash));
        orchestratorMock.lockFunds(0, intentHash, 20e6);
    }

    function test_LockFundsRejectsInsufficientLiquidityAfterReclaim() public {
        vm.prank(depositor);
        escrow.removeFunds(0, 400e6);
        bytes32 intentHash = keccak256("insufficient-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InsufficientDepositLiquidity.selector, 0, 100e6, 150e6));
        orchestratorMock.lockFunds(0, intentHash, 150e6);
    }

    function test_LockFundsRejectsFourthUnexpiredIntent() public {
        _lock(address(orchestratorMock), 20e6);
        _lock(address(orchestratorMock), 20e6);
        _lock(address(orchestratorMock), 20e6);
        bytes32 fourth = keccak256("intent-fourth");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.MaxIntentsExceeded.selector, 0, 4, 3));
        orchestratorMock.lockFunds(0, fourth, 20e6);
    }

    function test_UnlockFundsUnlocksExistingIntentAndEmits() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsUnlocked(0, intentHash, 20e6);
        orchestratorMock.unlockFunds(0, intentHash);
        assertEq(escrow.getDepositIntent(0, intentHash).intentHash, bytes32(0));
    }

    function test_UnlockFundsDoesNotChangeAcceptingState() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 60e6);
        vm.recordLogs();
        orchestratorMock.unlockFunds(0, intentHash);
        _assertNoAcceptingUpdate(vm.getRecordedLogs());
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 500e6);
        assertEq(deposit.outstandingIntentAmount, 0);
        assertTrue(deposit.acceptingIntents);
    }

    function test_UnlockFundsRejectsDifferentAllowlistedOrchestrator() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrowV2.UnauthorizedCaller.selector, address(secondaryOrchestratorMock), address(orchestratorMock)
            )
        );
        secondaryOrchestratorMock.unlockFunds(0, intentHash);
    }

    function test_UnlockAndTransferFundsTransfersFullLockedAmount() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        uint256 recipientBefore = token.balanceOf(other);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsUnlockedAndTransferred(0, intentHash, 20e6, 20e6, other);
        orchestratorMock.unlockAndTransferFunds(0, intentHash, 20e6, other);
        assertEq(token.balanceOf(other) - recipientBefore, 20e6);
    }

    function test_UnlockAndTransferFundsReturnsUnusedAmountToLiquidity() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        uint256 beforeRemaining = escrow.getDeposit(0).remainingDeposits;
        orchestratorMock.unlockAndTransferFunds(0, intentHash, 10e6, other);
        assertEq(escrow.getDeposit(0).remainingDeposits - beforeRemaining, 10e6);
    }

    function test_UnlockAndTransferFundsDoesNotChangeAcceptingState() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 60e6);
        vm.recordLogs();
        orchestratorMock.unlockAndTransferFunds(0, intentHash, 10e6, other);
        _assertNoAcceptingUpdate(vm.getRecordedLogs());
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 490e6);
        assertEq(deposit.outstandingIntentAmount, 0);
        assertTrue(deposit.acceptingIntents);
    }

    function test_UnlockAndTransferFundsCollectsDustWhenClosingNearZero() public {
        escrow.setDustThreshold(1e6);
        vm.startPrank(depositor);
        uint256 secondDepositId =
            _createDeposit(10e6, IEscrowV2.Range({min: 10e6, max: 200e6}), 1e18, delegate, intentGuardian);
        vm.stopPrank();
        bytes32 intentHash = keccak256("dust-intent");
        orchestratorMock.lockFunds(secondDepositId, intentHash, 10e6);
        uint256 dustBefore = token.balanceOf(dustRecipient);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DustCollected(secondDepositId, 1e6, dustRecipient);
        orchestratorMock.unlockAndTransferFunds(secondDepositId, intentHash, 9e6, other);
        assertEq(token.balanceOf(dustRecipient) - dustBefore, 1e6);
        assertEq(escrow.getDeposit(secondDepositId).depositor, address(0));
    }

    function test_UnlockAndTransferFundsRejectsDifferentAllowlistedOrchestrator() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrowV2.UnauthorizedCaller.selector, address(secondaryOrchestratorMock), address(orchestratorMock)
            )
        );
        secondaryOrchestratorMock.unlockAndTransferFunds(0, intentHash, 20e6, other);
    }

    function test_ExtendIntentExpiryAllowsGuardianAndEmits() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        uint256 beforeExpiry = escrow.getDepositIntent(0, intentHash).expiryTime;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IntentExpiryExtended(0, intentHash, beforeExpiry + 120);
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(0, intentHash, 120);
        assertEq(escrow.getDepositIntent(0, intentHash).expiryTime, beforeExpiry + 120);
    }

    function test_ExtendIntentExpiryRejectsExtensionBeyondMaximumHorizon() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountAboveMax.selector, 6 days, 5 days));
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(0, intentHash, 6 days);
    }
}
