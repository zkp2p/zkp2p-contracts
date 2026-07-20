// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { IAttestationVerifier } from "../../contracts/interfaces/IAttestationVerifier.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";

contract RiskManagerMathFuzzTest is Test {
    RiskManager internal manager;

    function setUp() public {
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(this)),
            IStakeVault(address(this)),
            IAttestationVerifier(address(this))
        );
    }

    function testFuzz_ExtensionFeeIsTheSmallestUpwardRoundedCharge(
        uint96 rawAmount,
        uint16 rawAnnualFeeBps,
        uint48 rawExtensionSeconds
    ) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint16 annualFeeBps = uint16(bound(uint256(rawAnnualFeeBps), 1, 10_000));
        uint256 extensionSeconds = bound(uint256(rawExtensionSeconds), 1, 365 days);

        uint256 fee = manager.calculateIntentExtensionFee(amount, annualFeeBps, extensionSeconds);
        uint256 numerator = amount * uint256(annualFeeBps) * extensionSeconds;
        uint256 denominator = 10_000 * 365 days;

        assertGe(fee * denominator, numerator);
        if (fee > 0) assertLt((fee - 1) * denominator, numerator);
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
}
