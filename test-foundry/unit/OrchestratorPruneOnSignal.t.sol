// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IOrchestrator } from "../../contracts/interfaces/IOrchestrator.sol";
import { ProtocolV1TestBase } from "../helpers/ProtocolV1TestBase.sol";

contract OrchestratorPruneOnSignalTest is ProtocolV1TestBase {
    event IntentPruned(bytes32 indexed intentHash);

    function setUp() public {
        _setUpV1Core();
    }

    function test_PruneExpiredIntentOnSecondSignal() public {
        uint256 depositId = _createDeposit(100_000_000e6, 10_000_000e6, 80_000_000e6);
        bytes32 firstHash = _signal(takerA, depositId, 50_000_000e6);

        vm.warp(block.timestamp + INTENT_EXPIRATION_PERIOD + 1);

        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit IntentPruned(firstHash);

        _signal(takerB, depositId, 60_000_000e6);

        IOrchestrator.Intent memory deletedIntent = orchestrator.getIntent(firstHash);
        assertEq(deletedIntent.owner, address(0), "expired intent should be pruned from Orchestrator storage");
    }
}
