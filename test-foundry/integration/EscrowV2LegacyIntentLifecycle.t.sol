// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Vm } from "forge-std/Vm.sol";

import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { EscrowV2LegacyCoverageBase } from "./EscrowV2LegacyCoverageBase.sol";

contract EscrowV2LegacyIntentLifecycleTest is EscrowV2LegacyCoverageBase {
    function setUp() public {
        _setUpLegacyFixture();
    }

    function test_pruneExpiredIntentsPrunesExpiredIntentsAndUnlocksLiquidity() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);
        _advanceTime(3601);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsUnlocked(depositId, intentHash, 20e6);

        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);
    }

    function test_pruneExpiredIntentsRevertsWhenOrchestratorPruneReverts() public {
        bytes32 intentHash = _createIntentWith(address(revertingPruneOrchestrator), 20e6);
        _advanceTime(3601);

        vm.expectRevert(bytes("prune failed"));
        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);

        IEscrowV2.Intent memory persistedIntent = escrow.getDepositIntent(depositId, intentHash);
        assertEq(persistedIntent.intentHash, intentHash);
    }

    function test_pruneExpiredIntentsKeepsIntentOrchestratorMappingWhenOrchestratorPruneReverts() public {
        bytes32 intentHash = _createIntentWith(address(revertingPruneOrchestrator), 20e6);
        _advanceTime(3601);

        vm.expectRevert(bytes("prune failed"));
        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);

        assertEq(_getIntentOrchestrator(intentHash), address(revertingPruneOrchestrator));
    }

    function test_pruneExpiredIntentsSkipsOrchestratorCallWhenIntentMappingIsCleared() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);
        _advanceTime(3601);
        _clearIntentOrchestrator(intentHash);

        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);

        IEscrowV2.Intent memory prunedIntent = escrow.getDepositIntent(depositId, intentHash);
        assertEq(prunedIntent.intentHash, bytes32(0));
    }

    function test_pruneExpiredIntentsPrunesEachExpiredIntentWithPerIntentOrchestratorCall() public {
        bytes32 orchestratorIntentA = _createIntentWith(address(orchestratorMock), 20e6);
        bytes32 orchestratorIntentB = _createIntentWith(address(orchestratorMock), 20e6);
        bytes32 secondaryIntent = _createIntentWith(address(secondaryOrchestratorMock), 20e6);
        _advanceTime(3601);

        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);

        bytes32[] memory lastPrimaryPruned = orchestratorMock.getLastPrunedIntents();
        bytes32[] memory lastSecondaryPruned = secondaryOrchestratorMock.getLastPrunedIntents();

        assertEq(orchestratorMock.getPruneCallCount(), 2);
        assertEq(secondaryOrchestratorMock.getPruneCallCount(), 1);
        _assertSingleBytes32ArrayValue(lastPrimaryPruned, orchestratorIntentB);
        _assertSingleBytes32ArrayValue(lastSecondaryPruned, secondaryIntent);
        assertTrue(orchestratorIntentA != orchestratorIntentB);
    }

    function test_pruneExpiredIntentsDoesNotChangeAcceptingIntentsAfterRestoringLiquidity() public {
        _createIntentWith(address(orchestratorMock), 60e6);

        vm.prank(depositor);
        escrow.removeFunds(depositId, 435e6);
        _advanceTime(3601);

        vm.recordLogs();
        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);

        assertEq(_countLogs(entries, DEPOSIT_ACCEPTING_INTENTS_UPDATED_TOPIC), 0);
        assertEq(deposit.remainingDeposits, 65e6);
        assertTrue(deposit.acceptingIntents);
    }

    function test_lockFundsReclaimsExpiredIntentsAndPrunesDuringNewLock() public {
        bytes32 firstIntentHash = _createIntentWith(address(orchestratorMock), 20e6);
        _advanceTime(3601);
        _createIntentWith(address(orchestratorMock), 20e6);
        _createIntentWith(address(orchestratorMock), 20e6);

        bytes32 secondIntentHash = keccak256("intent-second");
        vm.prank(owner);
        orchestratorMock.lockFunds(depositId, secondIntentHash, 20e6);

        bytes32[] memory pruned = orchestratorMock.getLastPrunedIntents();
        _assertSingleBytes32ArrayValue(pruned, firstIntentHash);
    }

    function test_lockFundsRevertsWhenCallerIsNotWhitelistedOrchestrator() public {
        bytes32 intentHash = keccak256("unauthorized-intent");

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, address(orchestratorRegistry))
        );
        vm.prank(other);
        escrow.lockFunds(depositId, intentHash, 20e6);
    }

    function test_lockFundsRevertsOnDuplicateIntentHash() public {
        bytes32 intentHash = keccak256("duplicate-intent");
        vm.prank(owner);
        orchestratorMock.lockFunds(depositId, intentHash, 20e6);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.IntentAlreadyExists.selector, depositId, intentHash));
        vm.prank(owner);
        orchestratorMock.lockFunds(depositId, intentHash, 20e6);
    }

    function test_lockFundsRevertsWhenLiquidityIsInsufficientAfterReclaim() public {
        vm.prank(depositor);
        escrow.removeFunds(depositId, 400e6);

        bytes32 intentHash = keccak256("insufficient-intent");
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.InsufficientDepositLiquidity.selector, depositId, 100e6, 150e6)
        );
        vm.prank(owner);
        orchestratorMock.lockFunds(depositId, intentHash, 150e6);
    }

    function test_lockFundsRevertsWhenMaxIntentsIsExceededWithNoPrunableIntent() public {
        _createIntentWith(address(orchestratorMock), 20e6);
        _createIntentWith(address(orchestratorMock), 20e6);
        _createIntentWith(address(orchestratorMock), 20e6);

        bytes32 fourthIntentHash = keccak256("intent-fourth");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.MaxIntentsExceeded.selector, depositId, 4, 3));
        vm.prank(owner);
        orchestratorMock.lockFunds(depositId, fourthIntentHash, 20e6);
    }

    function test_unlockFundsUnlocksExistingIntent() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsUnlocked(depositId, intentHash, 20e6);

        vm.prank(owner);
        orchestratorMock.unlockFunds(depositId, intentHash);
    }

    function test_unlockFundsDoesNotChangeAcceptingIntents() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 60e6);

        vm.recordLogs();
        vm.prank(owner);
        orchestratorMock.unlockFunds(depositId, intentHash);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);

        assertEq(_countLogs(entries, DEPOSIT_ACCEPTING_INTENTS_UPDATED_TOPIC), 0);
        assertEq(deposit.remainingDeposits, 500e6);
        assertEq(deposit.outstandingIntentAmount, 0);
        assertTrue(deposit.acceptingIntents);
    }

    function test_unlockFundsRevertsWhenDifferentAllowlistedOrchestratorAttemptsUnlock() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrowV2.UnauthorizedCaller.selector,
                address(secondaryOrchestratorMock),
                address(orchestratorMock)
            )
        );
        vm.prank(owner);
        secondaryOrchestratorMock.unlockFunds(depositId, intentHash);
    }

    function test_unlockAndTransferFundsUnlocksAndTransfersFullAmount() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsUnlockedAndTransferred(depositId, intentHash, 20e6, 20e6, other);

        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(depositId, intentHash, 20e6, other);
    }

    function test_unlockAndTransferFundsReturnsUnusedAmountToLiquidityOnPartialTransfer() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);
        IEscrowV2.Deposit memory beforeDeposit = escrow.getDeposit(depositId);

        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(depositId, intentHash, 10e6, other);

        IEscrowV2.Deposit memory afterDeposit = escrow.getDeposit(depositId);
        assertEq(afterDeposit.remainingDeposits - beforeDeposit.remainingDeposits, 10e6);
    }

    function test_unlockAndTransferFundsDoesNotChangeAcceptingIntentsOnPartialRelease() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 60e6);

        vm.recordLogs();
        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(depositId, intentHash, 10e6, other);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);

        assertEq(_countLogs(entries, DEPOSIT_ACCEPTING_INTENTS_UPDATED_TOPIC), 0);
        assertEq(deposit.remainingDeposits, 490e6);
        assertEq(deposit.outstandingIntentAmount, 0);
        assertTrue(deposit.acceptingIntents);
    }

    function test_unlockAndTransferFundsCollectsDustWhenPartialTransferClosesDepositNearZero() public {
        vm.prank(owner);
        escrow.setDustThreshold(1e6);

        uint256 secondDepositId = _createSmallDeposit(10e6);
        bytes32 intentHash = keccak256("dust-intent-1");

        vm.prank(owner);
        orchestratorMock.lockFunds(secondDepositId, intentHash, 10e6);

        vm.expectEmit(true, false, true, true, address(escrow));
        emit DustCollected(secondDepositId, 1e6, dustRecipient);

        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(secondDepositId, intentHash, 9e6, other);
    }

    function test_unlockAndTransferFundsRevertsWhenDifferentAllowlistedOrchestratorAttemptsTransfer() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrowV2.UnauthorizedCaller.selector,
                address(secondaryOrchestratorMock),
                address(orchestratorMock)
            )
        );
        vm.prank(owner);
        secondaryOrchestratorMock.unlockAndTransferFunds(depositId, intentHash, 20e6, other);
    }

    function test_extendIntentExpiryExtendsExpiryWhenCalledByIntentGuardian() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);
        IEscrowV2.Intent memory beforeIntent = escrow.getDepositIntent(depositId, intentHash);

        vm.expectEmit(false, false, false, false, address(escrow));
        emit IntentExpiryExtended(depositId, intentHash, beforeIntent.expiryTime + 120);

        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(depositId, intentHash, 120);

        IEscrowV2.Intent memory afterIntent = escrow.getDepositIntent(depositId, intentHash);
        assertEq(afterIntent.expiryTime - beforeIntent.expiryTime, 120);
    }

    function test_extendIntentExpiryRevertsWhenExtensionExceedsMaximumHorizon() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.AmountAboveMax.selector, uint256(6 days), uint256(5 days))
        );
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(depositId, intentHash, 6 days);
    }

    function test_viewGettersReturnStoredValuesFromHelperViews() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        bytes32[] memory intentHashes = escrow.getDepositIntentHashes(depositId);
        IEscrowV2.Intent memory intent = escrow.getDepositIntent(depositId, intentHash);
        bytes32[] memory paymentMethods = escrow.getDepositPaymentMethods(depositId);
        bytes32[] memory currencies = escrow.getDepositCurrencies(depositId, VENMO);
        IEscrowV2.DepositPaymentMethodData memory paymentMethodData = escrow.getDepositPaymentMethodData(
            depositId,
            VENMO
        );

        _assertSingleBytes32ArrayValue(intentHashes, intentHash);
        assertEq(intent.intentHash, intentHash);
        _assertSingleBytes32ArrayValue(paymentMethods, VENMO);
        _assertSingleBytes32ArrayValue(currencies, USD);
        assertTrue(escrow.getDepositCurrencyListed(depositId, VENMO, USD));
        assertTrue(escrow.getDepositPaymentMethodListed(depositId, VENMO));
        assertEq(paymentMethodData.payeeDetails, PAYEE_DETAILS);
        assertTrue(escrow.getDepositPaymentMethodActive(depositId, VENMO));
        assertEq(escrow.getDepositGatingService(depositId, VENMO), address(0));

        _advanceTime(3601);
        (bytes32[] memory expiredIntents, uint256 reclaimableAmount) = escrow.getExpiredIntents(depositId);
        _assertSingleBytes32ArrayValue(expiredIntents, intentHash);
        assertEq(reclaimableAmount, 20e6);
    }

    function _createSmallDeposit(uint256 amount) internal returns (uint256 createdDepositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrowV2.Range({ min: 10e6, max: 200e6 }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: delegate,
            intentGuardian: intentGuardian,
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        createdDepositId = escrow.depositCounter() - 1;
    }
}
