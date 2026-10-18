// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../deterministic/helpers/OrchestratorV4Fixture.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

contract OrchestratorV4GatingReplayFuzzTest is OrchestratorV4Fixture {
    function testFuzz_ConsumedAuthorizationCannotReopenAfterCancellation(
        uint256 amount,
        uint256 fee,
        uint256 expirationDelay,
        address recipient
    ) public {
        amount = bound(amount, 10e6, 200e6);
        fee = bound(fee, 1, 5e16);
        expirationDelay = bound(expirationDelay, 1, 1 days);
        vm.assume(recipient != address(0));
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();

        IReferralFee.ReferralFee[] memory fees = new IReferralFee.ReferralFee[](1);
        fees[0] = IReferralFee.ReferralFee({recipient: referrer, fee: fee});
        IOrchestratorV4.SignalIntentParams memory params =
            _params(depositId, recipient, amount, CONVERSION_RATE, fees, "");
        params.signatureExpiration = block.timestamp + expirationDelay;
        params.gatingServiceSignature = _gatingSignature(gatingServiceKey, taker, params, params.signatureExpiration);
        bytes32 intentHash = _signal(taker, params);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);

        // The expiry boundary still accepts a fresh signature, so replay must fail on consumption.
        vm.warp(params.signatureExpiration);
        vm.expectPartialRevert(IOrchestratorV4.GatingDigestAlreadyUsed.selector);
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), 1);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
    }
}
