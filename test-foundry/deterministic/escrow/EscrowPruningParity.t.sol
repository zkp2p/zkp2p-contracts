// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowPruningParityTest is EscrowLegacyFixture {
    event IntentsPruned(bytes32 intent);

    bytes32 internal constant INTENT_ONE = keccak256("intent");
    bytes32 internal constant INTENT_TWO = keccak256("intent2");

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.08e18});
        _createAsOffRamper(params);

        escrow.setOrchestrator(address(orchestratorMock));
        orchestratorMock.lockFunds(0, INTENT_ONE, 40e6);
    }

    function _prune() internal {
        vm.prank(onRamper);
        escrow.pruneExpiredIntents(0);
    }

    function test_PruneBeforeExpiryDoesNotUpdateDeposit() public {
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        assertEq(beforeDeposit.remainingDeposits, 60e6);
        assertEq(beforeDeposit.outstandingIntentAmount, 40e6);

        _prune();

        IEscrow.Deposit memory afterDeposit = escrow.getDeposit(0);
        assertEq(afterDeposit.remainingDeposits, 60e6);
        assertEq(afterDeposit.outstandingIntentAmount, 40e6);
        assertEq(escrow.getDepositIntentHashes(0).length, 1);
    }

    function test_PruneAfterExpiryRemovesIntent() public {
        vm.warp(block.timestamp + 1 days + 1);
        _prune();
        assertEq(escrow.getDepositIntentHashes(0).length, 0);
        assertEq(escrow.getDepositIntent(0, INTENT_ONE).intentHash, bytes32(0));
    }

    function test_PruneAfterExpiryReclaimsAmounts() public {
        vm.warp(block.timestamp + 1 days + 1);
        _prune();
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.remainingDeposits, 100e6);
        assertEq(deposit.outstandingIntentAmount, 0);
    }

    function test_PruneAfterExpiryCallsOrchestratorAndEmits() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(false, false, false, true, address(orchestratorMock));
        emit IntentsPruned(INTENT_ONE);
        _prune();

        assertEq(orchestratorMock.getPruneCallCount(), 1);
        bytes32[] memory pruned = orchestratorMock.getLastPrunedIntents();
        assertEq(pruned.length, 1);
        assertEq(pruned[0], INTENT_ONE);
    }

    function test_PruneMultipleIntentsRemovesOnlyExpiredIntent() public {
        vm.warp(block.timestamp + 1 days + 1);
        orchestratorMock.lockFunds(0, INTENT_TWO, 50e6);

        _prune();

        bytes32[] memory intents = escrow.getDepositIntentHashes(0);
        assertEq(intents.length, 1);
        assertEq(intents[0], INTENT_TWO);
        assertEq(escrow.getDepositIntent(0, INTENT_ONE).intentHash, bytes32(0));
        assertEq(escrow.getDepositIntent(0, INTENT_TWO).intentHash, INTENT_TWO);
    }
}
