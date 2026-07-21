// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {ReentrantOrchestratorMock} from "contracts/mocks/ReentrantOrchestratorMock.sol";

contract EscrowLockFundsParityTest is EscrowLegacyFixture {
    event FundsLocked(uint256 indexed depositId, bytes32 indexed intentHash, uint256 amount, uint256 expiryTime);
    event ReentryAttempted(uint8 indexed fn, bool success, string reason);

    bytes32 internal constant SUBJECT_INTENT = keccak256("subject-intent");
    bytes32 internal constant FIRST_INTENT = keccak256("intent1");
    bytes32 internal constant SECOND_INTENT = keccak256("intent2");

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.intentAmountRange = IEscrow.Range({min: 10e6, max: 60e6});
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        _createAsOffRamper(params);
        escrow.setOrchestrator(address(orchestratorMock));
    }

    function _lock(bytes32 intentHash, uint256 amount) internal {
        orchestratorMock.lockFunds(0, intentHash, amount);
    }

    function _setupRealOrchestratorMaxIntents() internal {
        escrow.setOrchestrator(address(orchestrator));
        escrow.setMaxIntentsPerDeposit(3);
        orchestrator.setAllowMultipleIntents(true);
    }

    function _signalTen() internal returns (bytes32 intentHash) {
        intentHash = _signalIntent(0, 10e6, 1.01e18);
    }

    function test_LockFundsUpdatesDepositAccounting() public {
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        assertEq(beforeDeposit.remainingDeposits, 100e6);
        assertEq(beforeDeposit.outstandingIntentAmount, 0);

        _lock(SUBJECT_INTENT, 30e6);

        IEscrow.Deposit memory afterDeposit = escrow.getDeposit(0);
        assertEq(afterDeposit.remainingDeposits, 70e6);
        assertEq(afterDeposit.outstandingIntentAmount, 30e6);
    }

    function test_LockFundsCreatesIntentWithTimestampAndExpiry() public {
        uint256 timestamp = block.timestamp;
        _lock(SUBJECT_INTENT, 30e6);

        IEscrow.Intent memory intent = escrow.getDepositIntent(0, SUBJECT_INTENT);
        assertEq(intent.intentHash, SUBJECT_INTENT);
        assertEq(intent.amount, 30e6);
        assertEq(intent.timestamp, timestamp);
        assertEq(intent.expiryTime, timestamp + 1 days);
    }

    function test_LockFundsAddsIntentHash() public {
        _lock(SUBJECT_INTENT, 30e6);
        bytes32[] memory intents = escrow.getDepositIntentHashes(0);
        assertEq(intents.length, 1);
        assertEq(intents[0], SUBJECT_INTENT);
    }

    function test_LockFundsEmitsAmountAndExpiry() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsLocked(0, SUBJECT_INTENT, 30e6, block.timestamp + 1 days);
        _lock(SUBJECT_INTENT, 30e6);
    }

    function test_LockFundsRejectsCallerThatIsNoLongerOrchestrator() public {
        escrow.setOrchestrator(offRamper);
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, address(orchestratorMock), offRamper)
        );
        _lock(SUBJECT_INTENT, 30e6);
    }

    function test_LockFundsRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, 999));
        orchestratorMock.lockFunds(999, SUBJECT_INTENT, 30e6);
    }

    function test_LockFundsDoesNotDisableWhenRemainingFallsBelowMinimum() public {
        vm.prank(offRamper);
        escrow.setIntentRange(0, IEscrow.Range({min: 10e6, max: 100e6}));
        _lock(SUBJECT_INTENT, 95e6);

        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 5e6);
        assertTrue(deposit.acceptingIntents);
    }

    function test_LockFundsRejectsDepositThatStoppedAcceptingIntents() public {
        _lock(SUBJECT_INTENT, 30e6);
        vm.prank(offRamper);
        escrow.withdrawDeposit(0);

        assertFalse(escrow.getDeposit(0).acceptingIntents);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotAcceptingIntents.selector, 0));
        _lock(SUBJECT_INTENT, 30e6);
    }

    function test_LockFundsRejectsAmountBelowMinimum() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountBelowMin.selector, 5e6, 10e6));
        _lock(SUBJECT_INTENT, 5e6);
    }

    function test_LockFundsRejectsAmountAboveMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountAboveMax.selector, 70e6, 60e6));
        _lock(SUBJECT_INTENT, 70e6);
    }

    function test_LockFundsReclaimsExpiredIntentWhenLiquidityIsInsufficient() public {
        _lock(FIRST_INTENT, 50e6);
        vm.warp(block.timestamp + 1 days + 1);
        _lock(SUBJECT_INTENT, 60e6);

        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 40e6);
        assertEq(deposit.outstandingIntentAmount, 60e6);
        assertEq(escrow.getDepositIntent(0, FIRST_INTENT).intentHash, bytes32(0));
        bytes32[] memory pruned = orchestratorMock.getLastPrunedIntents();
        assertEq(pruned.length, 1);
        assertEq(pruned[0], FIRST_INTENT);
    }

    function test_LockFundsContainsReentryDuringExpiredIntentCallback() public {
        _lock(FIRST_INTENT, 50e6);
        vm.warp(block.timestamp + 1 days + 1);
        escrow.setOrchestrator(address(reentrantOrchestratorMock));
        reentrantOrchestratorMock.setFunctionToReenter(ReentrantOrchestratorMock.ReenterFunction.LockFunds);

        vm.expectEmit(true, false, false, true, address(reentrantOrchestratorMock));
        emit ReentryAttempted(1, false, "ReentrancyGuard: reentrant call");
        reentrantOrchestratorMock.lockFunds(0, SUBJECT_INTENT, 60e6);
        assertEq(reentrantOrchestratorMock.lockReentries(), 1);
    }

    function test_LockFundsRejectsDuplicateIntentHash() public {
        _lock(SUBJECT_INTENT, 30e6);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.IntentAlreadyExists.selector, 0, SUBJECT_INTENT));
        _lock(SUBJECT_INTENT, 30e6);
    }

    function test_LockFundsRejectsInsufficientLiquidityAfterExpiredReclaim() public {
        _lock(FIRST_INTENT, 50e6);
        vm.warp(block.timestamp + 1 days + 1);
        _lock(SECOND_INTENT, 45e6);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.InsufficientDepositLiquidity.selector, 0, 55e6, 56e6));
        _lock(SUBJECT_INTENT, 56e6);
    }

    function test_LockFundsAllowsConfiguredMaximumIntentCount() public {
        _setupRealOrchestratorMaxIntents();
        _signalTen();
        _signalTen();
        _signalTen();
        assertEq(escrow.getDepositIntentHashes(0).length, 3);
    }

    function test_LockFundsRejectsIntentAboveConfiguredMaximumCount() public {
        _setupRealOrchestratorMaxIntents();
        _signalTen();
        _signalTen();
        _signalTen();

        vm.expectRevert(abi.encodeWithSelector(IEscrow.MaxIntentsExceeded.selector, 0, 4, 3));
        _signalIntentCall(0, 10e6, 1.01e18);
    }

    function test_LockFundsAllowsNewIntentAfterCancellation() public {
        _setupRealOrchestratorMaxIntents();
        bytes32 firstIntent = _signalTen();
        _signalTen();
        _signalTen();

        vm.expectRevert(abi.encodeWithSelector(IEscrow.MaxIntentsExceeded.selector, 0, 4, 3));
        _signalIntentCall(0, 10e6, 1.01e18);

        vm.prank(onRamper);
        orchestrator.cancelIntent(firstIntent);
        _signalTen();
        assertEq(escrow.getDepositIntentHashes(0).length, 3);
    }

    function test_LockFundsAllowsNewIntentAfterAutomaticExpiryPruning() public {
        _setupRealOrchestratorMaxIntents();
        _signalTen();
        _signalTen();
        _signalTen();

        vm.expectRevert(abi.encodeWithSelector(IEscrow.MaxIntentsExceeded.selector, 0, 4, 3));
        _signalIntentCall(0, 10e6, 1.01e18);

        vm.warp(block.timestamp + 1 days + 1);
        _signalTen();
        assertEq(escrow.getDepositIntentHashes(0).length, 1);
    }
}
