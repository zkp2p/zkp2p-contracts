// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowExpiredIntentsViewTest is EscrowLegacyFixture {
    bytes32 internal constant SUBJECT_INTENT = keccak256("intent");

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.08e18});
        _createAsOffRamper(params);
        escrow.setOrchestrator(address(orchestratorMock));
        orchestratorMock.lockFunds(0, SUBJECT_INTENT, 50e6);
    }

    function test_GetExpiredIntentsBeforeExpiryReturnsEmpty() public view {
        (bytes32[] memory intents, uint256 reclaimableAmount) = escrow.getExpiredIntents(0);
        assertEq(intents.length, 0);
        assertEq(reclaimableAmount, 0);
    }

    function test_GetExpiredIntentsAfterExpiryReturnsHashAndAmount() public {
        vm.warp(block.timestamp + 1 days + 1);
        (bytes32[] memory intents, uint256 reclaimableAmount) = escrow.getExpiredIntents(0);
        assertEq(intents.length, 1);
        assertEq(intents[0], SUBJECT_INTENT);
        assertEq(reclaimableAmount, 50e6);
    }

    function test_GetExpiredIntentsWithoutIntentsReturnsEmpty() public {
        orchestratorMock.unlockFunds(0, SUBJECT_INTENT);
        (bytes32[] memory intents, uint256 reclaimableAmount) = escrow.getExpiredIntents(0);
        assertEq(intents.length, 0);
        assertEq(reclaimableAmount, 0);
    }
}
