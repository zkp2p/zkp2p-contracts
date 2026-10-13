// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {DisputeWindowBypassFixture} from "../deterministic/helpers/DisputeWindowBypassFixture.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";

/// @dev Mode switches must never separate the public owner sentinel from collateral custody.
contract DisputeStakeModeFuzzTest is DisputeWindowBypassFixture {
    function testFuzz_ModeAndLocksAgreeThroughSwitchesAndTerminalStates(
        bool initiallyNoStake,
        uint32 switches,
        uint8 rawSteps,
        bool cancel,
        uint96 rawRelease
    ) public {
        _stake();
        bytes32 intentHash = initiallyNoStake ? _signalUnstaked() : _signalDefault();
        bool noStake = initiallyNoStake;
        _assertModeAndLock(intentHash, noStake, noStake ? 0 : INTENT_AMOUNT);
        uint256 steps = bound(rawSteps, 1, 32);
        for (uint256 step; step < steps; step++) {
            bool nextNoStake = (switches & (uint32(1) << step)) != 0;
            if (nextNoStake != noStake) _setNoStake(intentHash, nextNoStake);
            noStake = nextNoStake;
            _assertModeAndLock(intentHash, noStake, noStake ? 0 : INTENT_AMOUNT);
        }
        if (cancel) {
            vm.prank(taker);
            orchestrator.cancelIntent(intentHash);
            _assertModeAndLock(intentHash, noStake, 0);
        } else {
            uint256 releaseAmount = bound(rawRelease, 1, INTENT_AMOUNT);
            bytes memory proof = _signedProof(
                intentHash,
                _data(intentHash, PAYMENT_ID, abi.encode(noStake)),
                releaseAmount,
                WITNESS_KEY,
                upv.DOMAIN_SEPARATOR()
            );
            _settle(intentHash, proof);
            _assertModeAndLock(intentHash, noStake, noStake ? 0 : releaseAmount);
            IDisputeProtectionPolicy.DisputeProtectionIntent memory intent =
                protection.getDisputeProtectionIntent(intentHash);
            assertEq(intent.releaseEligibleAt, block.timestamp + (noStake ? 0 : RISK_WINDOW));
            assertEq(intent.riskWindow, RISK_WINDOW);
            assertEq(
                uint256(intent.status),
                uint256(
                    noStake
                        ? IDisputeProtectionPolicy.DisputeProtectionIntentStatus.RELEASED
                        : IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED
                )
            );
            if (!noStake) {
                vm.warp(intent.releaseEligibleAt);
                protection.releaseMaturedDisputeProtectionIntent(intentHash);
                _assertModeAndLock(intentHash, false, 0);
            }
        }
    }

    function _assertModeAndLock(bytes32 intentHash, bool noStake, uint256 expectedAmount) internal view {
        IDisputeProtectionPolicy.DisputeProtectionIntent memory intent =
            protection.getDisputeProtectionIntent(intentHash);
        assertTrue(intent.status != IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE);
        assertEq(protection.isIntentNoStake(intentHash), noStake);
        assertEq(intent.stakeOwner == address(0), noStake);
        assertEq(intent.stakeOwner, noStake ? address(0) : taker);
        (address owner, uint256 amount, uint64 maturity) = vault.locks(intentHash);
        assertEq(amount, expectedAmount);
        assertEq(owner, expectedAmount == 0 ? address(0) : intent.stakeOwner);
        if (expectedAmount == 0) assertEq(maturity, 0);
    }
}
