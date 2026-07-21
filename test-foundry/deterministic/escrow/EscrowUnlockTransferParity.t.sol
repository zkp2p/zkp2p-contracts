// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {Vm} from "forge-std/Vm.sol";

contract EscrowUnlockTransferParityTest is EscrowLegacyFixture {
    event FundsUnlockedAndTransferred(
        uint256 indexed depositId,
        bytes32 indexed intentHash,
        uint256 unlockedAmount,
        uint256 transferredAmount,
        address to
    );
    event DepositClosed(uint256 depositId, address depositor);
    event DustCollected(uint256 indexed depositId, uint256 amount, address indexed recipient);

    bytes32 internal constant SUBJECT_INTENT = keccak256("subject-intent");

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.intentAmountRange = IEscrow.Range({min: 10e6, max: 50e6});
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        _createAsOffRamper(params);
        escrow.setOrchestrator(address(orchestratorMock));
        orchestratorMock.lockFunds(0, SUBJECT_INTENT, 30e6);
    }

    function _transfer(uint256 depositId, bytes32 intentHash, uint256 amount, address recipient) internal {
        orchestratorMock.unlockAndTransferFunds(depositId, intentHash, amount, recipient);
    }

    function _removeRemainingLiquidity() internal {
        vm.prank(offRamper);
        escrow.removeFunds(0, 70e6);
    }

    function _containsEvent(bytes32 signature) internal returns (bool found) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == signature) return true;
        }
    }

    function test_UnlockAndTransferTransfersFullAmount() public {
        uint256 recipientBefore = token.balanceOf(address(orchestrator));
        uint256 escrowBefore = token.balanceOf(address(escrow));
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
        assertEq(token.balanceOf(address(orchestrator)), recipientBefore + 30e6);
        assertEq(token.balanceOf(address(escrow)), escrowBefore - 30e6);
    }

    function test_UnlockAndTransferUpdatesAccountingForFullTransfer() public {
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 70e6);
        assertEq(deposit.outstandingIntentAmount, 0);
    }

    function test_UnlockAndTransferDeletesIntent() public {
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
        assertEq(escrow.getDepositIntent(0, SUBJECT_INTENT).intentHash, bytes32(0));
    }

    function test_UnlockAndTransferEmitsSettlementAmounts() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsUnlockedAndTransferred(0, SUBJECT_INTENT, 30e6, 30e6, address(orchestrator));
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
    }

    function test_UnlockAndTransferRemovesIntentHash() public {
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
        assertEq(escrow.getDepositIntentHashes(0).length, 0);
    }

    function test_UnlockAndTransferTransfersPartialAmount() public {
        uint256 recipientBefore = token.balanceOf(address(orchestrator));
        _transfer(0, SUBJECT_INTENT, 20e6, address(orchestrator));
        assertEq(token.balanceOf(address(orchestrator)), recipientBefore + 20e6);
    }

    function test_UnlockAndTransferReturnsUnusedAmountToAvailableLiquidity() public {
        _transfer(0, SUBJECT_INTENT, 20e6, address(orchestrator));
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 80e6);
        assertEq(deposit.outstandingIntentAmount, 0);
    }

    function test_UnlockAndTransferRejectsZeroTransfer() public {
        vm.expectRevert(IEscrow.ZeroValue.selector);
        _transfer(0, SUBJECT_INTENT, 0, address(orchestrator));
    }

    function test_UnlockAndTransferClosesEmptyDeposit() public {
        _removeRemainingLiquidity();
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
        assertEq(escrow.getDeposit(0).depositor, address(0));
    }

    function test_UnlockAndTransferEmitsDepositClosed() public {
        _removeRemainingLiquidity();
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(0, offRamper);
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
    }

    function test_UnlockAndTransferRetainOnEmptyPreservesDepositConfiguration() public {
        _removeRemainingLiquidity();
        vm.prank(offRamper);
        escrow.setRetainOnEmpty(0, true);
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));

        assertEq(escrow.getDeposit(0).depositor, offRamper);
        assertTrue(escrow.getDepositPaymentMethodListed(0, VENMO));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.01e18);
    }

    function test_UnlockAndTransferRetainOnEmptyKeepsAcceptingIntentsDisabled() public {
        _removeRemainingLiquidity();
        vm.prank(offRamper);
        escrow.setRetainOnEmpty(0, true);
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_UnlockAndTransferRetainOnEmptyDoesNotEmitDepositClosed() public {
        _removeRemainingLiquidity();
        vm.prank(offRamper);
        escrow.setRetainOnEmpty(0, true);
        vm.recordLogs();
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
        assertFalse(_containsEvent(keccak256("DepositClosed(uint256,address)")));
    }

    function test_UnlockAndTransferSweepsDustAndClosesDeposit() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.amount = 1e6;
        params.intentAmountRange = IEscrow.Range({min: 1e6, max: 1e6});
        params.delegate = address(0);
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1e18});
        _createAsOffRamper(params);
        bytes32 tinyIntent = keccak256("tiny-intent");
        orchestratorMock.lockFunds(1, tinyIntent, 1e6);
        escrow.setDustThreshold(1e6);
        escrow.setDustRecipient(feeRecipient);
        uint256 dustRecipientBefore = token.balanceOf(feeRecipient);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit DustCollected(1, 1, feeRecipient);
        _transfer(1, tinyIntent, 1e6 - 1, address(this));

        assertEq(escrow.getDeposit(1).depositor, address(0));
        assertEq(token.balanceOf(feeRecipient) - dustRecipientBefore, 1);
    }

    function test_UnlockAndTransferRejectsAmountAboveIntent() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountExceedsAvailable.selector, 40e6, 30e6));
        _transfer(0, SUBJECT_INTENT, 40e6, address(orchestrator));
    }

    function test_UnlockAndTransferRejectsCallerThatIsNoLongerOrchestrator() public {
        escrow.setOrchestrator(offRamper);
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, address(orchestratorMock), offRamper)
        );
        _transfer(0, SUBJECT_INTENT, 30e6, address(orchestrator));
    }

    function test_UnlockAndTransferRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, 999));
        _transfer(999, SUBJECT_INTENT, 30e6, address(orchestrator));
    }

    function test_UnlockAndTransferRejectsMissingIntent() public {
        bytes32 missingIntent = keccak256("nonexistent");
        vm.expectRevert(abi.encodeWithSelector(IEscrow.IntentNotFound.selector, missingIntent));
        _transfer(0, missingIntent, 30e6, address(orchestrator));
    }
}
