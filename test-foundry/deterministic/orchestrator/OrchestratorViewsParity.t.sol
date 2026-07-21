// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";

contract OrchestratorViewsParityTest is OrchestratorLegacyFixture {
    function setUp() public override {
        super.setUp();
        orchestrator.setAllowMultipleIntents(true);
        vm.prank(offRamper);
        escrow.addFunds(0, 900e6);
    }

    function test_GetAccountIntentsReturnsEmptyArrayForAccountWithoutIntents() public view {
        assertEq(orchestrator.getAccountIntents(onRamper).length, 0);
    }

    function test_GetAccountIntentsReturnsAllIntentsForAccount() public {
        IOrchestrator.SignalIntentParams memory firstParams = _baseSignalParams(onRamper);
        firstParams.to = receiver;
        firstParams.amount = 50e6;
        firstParams.gatingServiceSignature = _resign(firstParams);
        bytes32 firstIntent = _signal(onRamper, firstParams);

        IOrchestrator.SignalIntentParams memory secondParams = _baseSignalParams(onRamper);
        secondParams.to = receiver;
        secondParams.amount = 75e6;
        secondParams.gatingServiceSignature = _resign(secondParams);
        bytes32 secondIntent = _signal(onRamper, secondParams);

        bytes32[] memory accountIntents = orchestrator.getAccountIntents(onRamper);
        assertEq(accountIntents.length, 2);
        assertEq(accountIntents[0], firstIntent);
        assertEq(accountIntents[1], secondIntent);
    }
}
