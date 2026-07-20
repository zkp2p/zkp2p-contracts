// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { IAttestationVerifier } from "../../contracts/interfaces/IAttestationVerifier.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { INullifierRegistryV2 } from "../../contracts/interfaces/INullifierRegistryV2.sol";
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

    function testFuzz_ExtensionPenaltyNeverExceedsPurchasedReservation(
        uint96 rawAmount,
        uint32 rawPurchasedTime,
        uint16 rawSlope,
        uint48 rawElapsedAfterBase
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000_000e6);
        uint64 purchasedTime = uint64(bound(uint256(rawPurchasedTime), 0, manager.MAX_TOTAL_INTENT_LIFETIME()));
        uint32 maxSlope = uint32(manager.EXTENSION_DENOMINATOR() / manager.MAX_TOTAL_INTENT_LIFETIME());
        uint32 slope = uint32(bound(uint256(rawSlope), 0, maxSlope));
        uint64 elapsedAfterBase = uint64(bound(
            uint256(rawElapsedAfterBase),
            0,
            2 * uint256(manager.MAX_TOTAL_INTENT_LIFETIME())
        ));
        uint64 baseExpiry = 1_000_000;
        uint64 terminalAt = baseExpiry + elapsedAfterBase;

        uint256 reservation = manager.calculateIntentExtensionCost(amount, purchasedTime, slope);
        (uint256 penalty, uint64 chargeableTime) = manager.calculateIntentExtensionPenalty(
            amount,
            baseExpiry,
            terminalAt,
            purchasedTime,
            slope
        );

        assertLe(chargeableTime, purchasedTime);
        assertLe(penalty, reservation);
    }

    function testFuzz_AtOrBeforeBaseExpiryExtensionPenaltyIsZero(
        uint96 rawAmount,
        uint32 rawPurchasedTime,
        uint16 rawSlope,
        uint32 rawSecondsBeforeExpiry
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 purchasedTime = uint64(bound(uint256(rawPurchasedTime), 1, 5 days));
        uint32 slope = uint32(bound(uint256(rawSlope), 0, 83));
        uint64 baseExpiry = 1_000_000;
        uint64 secondsBeforeExpiry = uint64(bound(uint256(rawSecondsBeforeExpiry), 0, baseExpiry));
        uint64 terminalAt = baseExpiry - secondsBeforeExpiry;

        (uint256 penalty, uint64 chargeableTime) = manager.calculateIntentExtensionPenalty(
            amount,
            baseExpiry,
            terminalAt,
            purchasedTime,
            slope
        );

        assertEq(penalty, 0);
        assertEq(chargeableTime, 0);
    }

    function testFuzz_PenaltyCapsAtTheCostOfPurchasedTime(
        uint96 rawAmount,
        uint32 rawPurchasedTime,
        uint16 rawSlope,
        uint32 rawExcessElapsed
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 purchasedTime = uint64(bound(uint256(rawPurchasedTime), 1, 5 days));
        uint32 slope = uint32(bound(uint256(rawSlope), 0, 83));
        uint64 excessElapsed = uint64(bound(uint256(rawExcessElapsed), 0, 5 days));
        uint64 baseExpiry = 1_000_000;
        uint64 terminalAt = baseExpiry + purchasedTime + excessElapsed;

        uint256 reservation = manager.calculateIntentExtensionCost(amount, purchasedTime, slope);
        (uint256 penalty, uint64 chargeableTime) = manager.calculateIntentExtensionPenalty(
            amount,
            baseExpiry,
            terminalAt,
            purchasedTime,
            slope
        );

        assertEq(chargeableTime, purchasedTime);
        assertEq(penalty, reservation);
    }

    function testFuzz_ExtensionCostIsTheSmallestUpwardRoundedCharge(
        uint96 rawAmount,
        uint32 rawExtensionTime,
        uint16 rawSlope
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 extensionTime = uint64(bound(uint256(rawExtensionTime), 1, 5 days));
        uint32 slope = uint32(bound(uint256(rawSlope), 1, 83));
        uint256 numerator = uint256(slope) * extensionTime;

        uint256 cost = manager.calculateIntentExtensionCost(amount, extensionTime, slope);

        assertGe(cost * manager.EXTENSION_DENOMINATOR(), amount * numerator);
        if (cost > 0) {
            assertLt((cost - 1) * manager.EXTENSION_DENOMINATOR(), amount * numerator);
        }
    }

    function testFuzz_CumulativeExtensionCostIsMonotonic(
        uint96 rawAmount,
        uint32 rawFirstTime,
        uint32 rawSecondTime,
        uint16 rawSlope
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 firstTime = uint64(bound(uint256(rawFirstTime), 0, 5 days));
        uint64 secondTime = uint64(bound(uint256(rawSecondTime), 0, 5 days - firstTime));
        uint32 slope = uint32(bound(uint256(rawSlope), 0, 83));

        uint256 firstCost = manager.calculateIntentExtensionCost(amount, firstTime, slope);
        uint256 cumulativeCost = manager.calculateIntentExtensionCost(amount, firstTime + secondTime, slope);
        uint256 standaloneSecondCost = manager.calculateIntentExtensionCost(amount, secondTime, slope);

        assertGe(cumulativeCost, firstCost);
        assertLe(cumulativeCost - firstCost, standaloneSecondCost);
        if (secondTime == 0) assertEq(cumulativeCost, firstCost);
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

    function testFuzz_ExtensionReservationIdIsDomainSeparated(bytes32 intentHash) public view {
        bytes32 extensionId = manager.extensionReservationId(intentHash);

        assertEq(extensionId, keccak256(abi.encode(manager.EXTENSION_RESERVATION_NAMESPACE(), intentHash)));
        assertEq(extensionId, manager.extensionReservationId(intentHash));
    }
}
