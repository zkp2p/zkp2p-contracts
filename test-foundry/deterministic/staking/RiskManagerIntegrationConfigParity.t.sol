// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerIntegrationFixture} from "../helpers/RiskManagerIntegrationFixture.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";

contract RiskManagerIntegrationConfigParityTest is RiskManagerIntegrationFixture {
    function test_RiskManagerBindsSettlementCustodyToVaultToken() public view {
        assertEq(address(vault.stakeToken()), address(token));
        assertEq(address(manager.stakeVault()), address(vault));
    }

    function test_RiskManagerRejectsChargebackReserveAboveOneHundredPercent() public {
        IRiskManager.PlatformRiskConfig memory config = _platformConfig(true, false, 10_001, DAY, 1);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, PAYPAL));
        manager.setPlatformRiskConfig(PAYPAL, config);
    }

    function test_RiskManagerAcceptsDeferredPayoutForChargebackablePlatform() public {
        manager.setPlatformRiskConfig(PAYPAL, _platformConfig(true, true, 10_000, DAY, 1));
        assertTrue(manager.getPlatformRiskConfig(PAYPAL).chargeback.deferredPayoutEnabled);
    }

    function test_RiskManagerRejectsZeroExtensionSlopeForEnabledPlatform() public {
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, ZELLE));
        manager.setPlatformRiskConfig(ZELLE, _platformConfig(false, false, 0, 0, 0));
    }

    function test_RiskManagerCalculatesCumulativePaidExtensionCollateral() public view {
        assertEq(manager.calculateIntentExtensionCost(1_000e6, 23 * HOUR, EXTENSION_SLOPE), 23e6);
    }

    function test_RiskManagerPricesExtensionOnFullLockedAmount() public view {
        assertEq(manager.calculateIntentExtensionCost(500e6, HOUR, EXTENSION_SLOPE), 500_000);
    }

    function test_RiskManagerCapsTerminalChargeToPurchasedTime() public view {
        (uint256 penalty, uint64 chargeableTime) =
            manager.calculateIntentExtensionPenalty(1_000e6, 10_000, 10_000 + 3 * HOUR, 2 * HOUR, EXTENSION_SLOPE);
        assertEq(penalty, 2e6);
        assertEq(chargeableTime, 2 * HOUR);
    }

    function test_RiskManagerRoundsChargebackReserveUpward() public view {
        assertEq(manager.calculateChargebackReserve(101, 5_000), 51);
    }

    function test_RiskManagerReservesChargebackCoverageOnlyAtAdmission() public view {
        assertEq(manager.calculateChargebackReserve(1_000e6, 10_000), 1_000e6);
    }

    function test_RiskManagerRejectsCurveThatCanExceedIntentAmount() public {
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.ExtensionPenaltyExceedsIntentAmount.selector, ZELLE));
        manager.setPlatformRiskConfig(ZELLE, _platformConfig(false, false, 0, 0, 84));
    }
}
