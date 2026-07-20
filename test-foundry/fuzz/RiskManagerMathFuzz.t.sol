// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { IAttestationVerifier } from "../../contracts/interfaces/IAttestationVerifier.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { INullifierRegistryV2 } from "../../contracts/interfaces/INullifierRegistryV2.sol";
import { IRiskManager } from "../../contracts/interfaces/IRiskManager.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";

contract RiskManagerMathFuzzTest is Test {
    RiskManager internal manager;

    function setUp() public {
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(this)),
            IStakeVault(address(this)),
            IAttestationVerifier(address(this)),
            INullifierRegistryV2(address(this))
        );
    }

    function testFuzz_GriefingPenaltyNeverExceedsMaximumBond(
        uint96 rawAmount,
        uint96 rawBaseUnbondedAmount,
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
        uint256 baseUnbondedAmount = uint256(rawBaseUnbondedAmount);
        uint256 bondedAmount = manager.calculateBondedAmount(amount, baseUnbondedAmount);

        uint256 maximumBond = manager.calculateMaxGriefingBond(
            amount,
            maxPeriod,
            IRiskManager.GriefingConfig({
                griefingCliff: cliff,
                griefingPenaltyBpsPerHour: slope,
                baseUnbondedAmount: baseUnbondedAmount
            })
        );
        (uint256 penalty,) = manager.calculateGriefingPenalty(
            bondedAmount,
            createdAt,
            cancelledAt,
            maxPeriod,
            cliff,
            slope
        );

        assertEq(bondedAmount, amount > baseUnbondedAmount ? amount - baseUnbondedAmount : 0);
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
        uint96 rawBaseUnbondedAmount,
        uint16 rawReserveBps,
        uint16 rawSlope
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint16 reserveBps = uint16(bound(uint256(rawReserveBps), 0, 10_000));
        uint32 slope = uint32(bound(uint256(rawSlope), 0, 1_000));
        uint256 baseUnbondedAmount = reserveBps == 0 ? uint256(rawBaseUnbondedAmount) : 0;
        uint256 bondedAmount = manager.calculateBondedAmount(amount, baseUnbondedAmount);
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
                baseUnbondedAmount: baseUnbondedAmount
            })
        });

        (uint256 griefing, uint256 chargeback, uint256 required) =
            manager.calculateRequiredReservation(amount, 6 hours, config);

        assertEq(required, griefing > chargeback ? griefing : chargeback);
        assertLe(griefing, bondedAmount);
        assertLe(chargeback, amount);
    }

    function testFuzz_AggregateFeeFloorUpperBoundsEveryPartialRelease(
        uint96 rawIntentAmount,
        uint96 rawReleaseAmount,
        uint64 rawProtocolFee,
        uint64 rawManagerFee,
        uint64 rawReferralFee
    ) public pure {
        uint256 preciseUnit = 1e18;
        uint256 intentAmount = bound(uint256(rawIntentAmount), 1, type(uint96).max);
        uint256 releaseAmount = bound(uint256(rawReleaseAmount), 1, intentAmount);
        uint256 protocolFee = bound(uint256(rawProtocolFee), 0, 0.05e18);
        uint256 managerFee = bound(uint256(rawManagerFee), 0, 0.40e18);
        uint256 referralFee = bound(uint256(rawReferralFee), 0, 0.15e18);
        uint256 aggregateRate = protocolFee + managerFee + referralFee;

        uint256 actualFees = (releaseAmount * protocolFee) / preciseUnit
            + (releaseAmount * managerFee) / preciseUnit
            + (releaseAmount * referralFee) / preciseUnit;
        uint256 releaseUpperBound = (releaseAmount * aggregateRate) / preciseUnit;
        uint256 admissionUpperBound = (intentAmount * aggregateRate) / preciseUnit;

        assertLe(actualFees, releaseUpperBound);
        assertLe(releaseUpperBound, admissionUpperBound);
    }

    function testFuzz_HybridCoverageEqualsGrossReleaseAndNeverNeedsMoreStake(
        uint96 rawIntentAmount,
        uint96 rawReleaseAmount,
        uint64 rawProtocolFee,
        uint64 rawManagerFee,
        uint64 rawReferralFee
    ) public pure {
        uint256 preciseUnit = 1e18;
        uint256 intentAmount = bound(uint256(rawIntentAmount), 1, type(uint96).max);
        uint256 releaseAmount = bound(uint256(rawReleaseAmount), 1, intentAmount);
        uint256 protocolFee = bound(uint256(rawProtocolFee), 0, 0.05e18);
        uint256 managerFee = bound(uint256(rawManagerFee), 0, 0.40e18);
        uint256 referralFee = bound(uint256(rawReferralFee), 0, 0.15e18);
        uint256 aggregateRate = protocolFee + managerFee + referralFee;

        uint256 exactFeeGap = (releaseAmount * protocolFee) / preciseUnit
            + (releaseAmount * managerFee) / preciseUnit
            + (releaseAmount * referralFee) / preciseUnit;
        uint256 deferredCoverage = releaseAmount - exactFeeGap;
        uint256 admissionStakeCoverage = (intentAmount * aggregateRate) / preciseUnit;

        assertEq(deferredCoverage + exactFeeGap, releaseAmount);
        assertLe(exactFeeGap, admissionStakeCoverage);
    }
}
