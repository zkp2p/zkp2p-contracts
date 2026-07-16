// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { IRiskManager } from "../../contracts/interfaces/IRiskManager.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";
import { AttestationVerifierMock } from "../../contracts/mocks/AttestationVerifierMock.sol";

contract RiskManagerMathFuzzTest is Test {
    RiskManager internal manager;

    function setUp() public {
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(this)),
            IStakeVault(address(this)),
            new AttestationVerifierMock()
        );
    }

    function testFuzz_GriefingPenaltyNeverExceedsMaximumBond(
        uint96 rawAmount,
        uint32 rawMaxPeriod,
        uint32 rawCliff,
        uint16 rawSlope,
        uint48 rawElapsed
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000_000e6);
        uint64 maxPeriod = uint64(bound(uint256(rawMaxPeriod), 2, 365 days));
        uint64 cliff = uint64(bound(uint256(rawCliff), 0, maxPeriod - 1));
        uint32 maxSlope = uint32((manager.GRIEFING_DENOMINATOR()) / (maxPeriod - cliff));
        uint32 slope = uint32(bound(uint256(rawSlope), 0, maxSlope));
        uint64 elapsed = uint64(bound(uint256(rawElapsed), 0, 2 * uint256(maxPeriod)));
        uint64 createdAt = 1_000_000;
        uint64 cancelledAt = createdAt + elapsed;

        uint256 maximumBond = manager.calculateMaxGriefingBond(
            amount,
            maxPeriod,
            IRiskManager.GriefingConfig({
                griefingCliff: cliff,
                griefingPenaltyBpsPerHour: slope,
                freeTakeCount: 0,
                freeTakeAmount: 0
            })
        );
        (uint256 penalty,) = manager.calculateGriefingPenalty(
            amount,
            createdAt,
            cancelledAt,
            maxPeriod,
            cliff,
            slope
        );

        assertLe(penalty, maximumBond);
    }

    function testFuzz_AtOrBeforeCliffPenaltyIsZero(
        uint96 rawAmount,
        uint32 rawCliff,
        uint16 rawSlope,
        uint32 rawElapsed
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 cliff = uint64(bound(uint256(rawCliff), 1, 30 days));
        uint64 elapsed = uint64(bound(uint256(rawElapsed), 0, cliff));
        uint32 slope = uint32(bound(uint256(rawSlope), 0, 10_000));
        (uint256 penalty,) = manager.calculateGriefingPenalty(
            amount,
            1_000_000,
            uint64(1_000_000 + elapsed),
            cliff + 1 days,
            cliff,
            slope
        );
        assertEq(penalty, 0);
    }

    function testFuzz_ChargebackReserveIsTheSmallestUpwardRoundedCoverage(
        uint96 rawAmount,
        uint16 rawReserveBps
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint16 reserveBps = uint16(bound(uint256(rawReserveBps), 1, 10_000));

        uint256 reserve = manager.calculateChargebackReserve(amount, reserveBps);

        assertGe(reserve * 10_000, amount * reserveBps);
        if (reserve > 0) assertLt((reserve - 1) * 10_000, amount * reserveBps);
    }

    function testFuzz_RequiredReservationEqualsMaximumCurve(
        uint96 rawAmount,
        uint16 rawReserveBps,
        uint16 rawSlope
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint16 reserveBps = uint16(bound(uint256(rawReserveBps), 0, 10_000));
        uint32 slope = uint32(bound(uint256(rawSlope), 0, 1_000));
        IRiskManager.PlatformRiskConfig memory config = IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: reserveBps != 0,
                deferredPayoutEnabled: false,
                reserveBps: reserveBps,
                riskWindow: 1 days
            }),
            griefing: IRiskManager.GriefingConfig({
                griefingCliff: 15 minutes,
                griefingPenaltyBpsPerHour: slope,
                freeTakeCount: 0,
                freeTakeAmount: 0
            })
        });

        (uint256 griefing, uint256 chargeback, uint256 required) =
            manager.calculateRequiredReservation(amount, 6 hours, config);

        assertEq(required, griefing > chargeback ? griefing : chargeback);
        assertLe(griefing, amount);
        assertLe(chargeback, amount);
    }
}
